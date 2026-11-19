// Мост «тема Telegram → сессия DSH» — обе половины.
//
// Приём: приёмник внутри MCP-сервера telegram (server.py) слушает группу
// DSHarnes сессией владельца, кладёт задания из тем в inbox.jsonl и ставит
// реакцию 👀. Очередь забирается здесь и отдаётся в сессию рабочего
// пространства обычным пользовательским промптом — ровно то же, что делает
// поле ввода в Web (sessionController.prompt, source.kind = 'user').
//
// Ответ: финальное assistant-сообщение сессии уходит в outbox.jsonl, а
// MCP-сервер отправляет его в ту же тему ответом на исходное сообщение —
// отправителем бот рабочего пространства (MTProto-клиент на токене бота
// из tokens.env; Bot API api.telegram.org с этого хоста недоступен).
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export const name = 'topic-bridge';
export const inject = ['sessionController', 'workspaceRegistry'];

const HOME = '/home/ka/.config/dsh-tg';
const CFG = `${HOME}/dsharnes.json`;
const OUTBOX = `${HOME}/outbox.jsonl`;
const LOG = `${HOME}/topic-bridge.log`;
const TICK_MS = 2000;
const ANSWER_POLL_MS = 60_000;
const ANSWER_DEADLINE_MS = 30 * 60_000;

/** Журнал моста: ctx.logger в хосте не виден в journald, а без него не отладить. */
const trace = message => {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`); } catch { /* журнал не критичен */ }
};

const readJson = (path, fallback) => {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
};

/** Тема → рабочее пространство (чистая часть, её проверяет test.mjs). */
export function topicMap(cfg) {
  const map = new Map();
  for (const [ws, entry] of Object.entries(cfg?.workspaces ?? {})) {
    if (entry?.topic) map.set(Number(entry.topic), { ws, path: entry.path });
  }
  return map;
}

/** Пространство задания: сначала ws из строки очереди, потом старая карта тем. */
export function targetFor(cfg, event) {
  const entry = event?.ws ? cfg?.workspaces?.[event.ws] : null;
  if (entry) return { ws: event.ws, path: entry.path };
  return topicMap(cfg).get(Number(event?.thread)) ?? null;
}

/**
 * Как подавать задание из Telegram: 'queue' (в очередь, ждёт конца хода)
 * или 'steer' (параллельный канал: попадает в идущий ход, как в openclaw).
 * Настройка: dsharnes.json → workspaces.<ws>.delivery, иначе общий delivery.
 */
export function deliveryMode(cfg, ws) {
  const value = cfg?.workspaces?.[ws]?.delivery ?? cfg?.delivery ?? 'queue';
  return value === 'steer' ? 'steer' : 'queue';
}

/** Самая свежая живая сессия пространства: sessionController.list уже идёт по активности. */
export function pickSession(rows, target, archived) {
  return rows.find(row => row.cwd === target.path
    && row.origin !== 'subagent' && !archived.has(row.sessionId));
}

/** Текст ответа: только блоки text — размышления и вызовы инструментов не уходят. */
export function answerText(event) {
  const blocks = event?.data?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').trim();
}

/**
 * Ответ уходит в ТГ только на задание, пришедшее из ТГ, и только один раз.
 * asked — отметка {thread, msg, ws, at}, оставленная deliver(); ручной ввод
 * в Web, расписание и чужие ходы в группу не попадают.
 */
export function replyAllowed(asked, now = Date.now()) {
  if (!asked) return false;
  const at = Number(asked.at ?? 0);
  return now - at >= 0 && now - at < ANSWER_DEADLINE_MS;
}

/** Ответ в очередь: MCP-сервер отправит его ботом пространства (ws) в свою группу. */
function outbox(thread, msg, text, ws = null) {
  try {
    fs.appendFileSync(OUTBOX, `${JSON.stringify({ thread, msg, text, ws })}\n`);
  } catch { /* очередь не критична: ответ просто не уйдёт в тему */ }
}

/** Одна порция очереди: только целые строки, смещение сохраняется до доставки. */
export function drain(dir = HOME) {
  const inbox = `${dir}/inbox.jsonl`;
  const offsetFile = `${dir}/inbox.offset`;
  if (!fs.existsSync(inbox)) return [];
  const size = fs.statSync(inbox).size;
  let offset = readJson(offsetFile, { bytes: 0 }).bytes ?? 0;
  if (size < offset) offset = 0;            // файл пересоздан
  if (size === offset) return [];
  const chunk = fs.readFileSync(inbox).subarray(offset);
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) return [];           // строка ещё пишется
  fs.writeFileSync(offsetFile, JSON.stringify({ bytes: offset + lastNewline + 1 }));
  return chunk.subarray(0, lastNewline).toString('utf8').split('\n')
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

export async function apply(ctx) {
  const signal = new AbortController().signal;
  trace(`старт моста: ответ в ТГ только на задание из ТГ, один раз на запрос`);
  let busy = false;

  /**
   * Ответ сессии → в группу её пространства, но ТОЛЬКО на задание из Telegram
   * и ровно один раз на запрос (владелец, 19.11). Ручной ввод в Web, расписание
   * и ходы без отметки в группу не уходят. Курсор по каждой сессии — echo.json.
   */
  const CURSORS = `${HOME}/echo.json`;
  let cursors = readJson(CURSORS, {}) || {};
  let dirty = false;

  const saveCursors = () => {
    if (!dirty) return;
    dirty = false;
    try { fs.writeFileSync(CURSORS, JSON.stringify(cursors)); } catch { /* не критично */ }
  };

  const watchAnswers = async () => {
    const cfg = readJson(CFG, null);
    if (!cfg?.workspaces) return;
    const rows = (await ctx.sessionController.list({}, signal)).items;
    const archived = new Set(ctx.workspaceRegistry.archivedSessionIds);
    const byPath = new Map(Object.entries(cfg.workspaces)
      .filter(([, entry]) => entry?.path).map(([ws, entry]) => [entry.path, ws]));
    for (const row of rows) {
      const ws = byPath.get(row.cwd);
      if (!ws || row.origin === 'subagent' || archived.has(row.sessionId)) continue;
      if (!cursors[row.sessionId]) cursors[row.sessionId] = { seq: null, pending: '', replyTo: null };
      const seen = cursors[row.sessionId];
      if (seen.seq == null) {
        // первая встреча: историю в Telegram не выгружаем, начинаем с текущего края
        const st = await ctx.sessionController.state({ sessionId: row.sessionId }, signal);
        seen.seq = st.cursor;
        dirty = true;
        continue;
      }
      // wait — блокирующее ожидание: «нет событий за 300 мс» это ошибка, а не сбой
      let value = null;
      try {
        value = await ctx.sessionController.wait(
          { sessionId: row.sessionId, afterSeq: seen.seq, timeoutMs: 300 }, signal);
      } catch { /* тишина — тоже ответ */ }
      for (const record of value?.output?.records ?? []) {
        if (record.seq <= seen.seq) continue;
        seen.seq = record.seq;
        dirty = true;
        if (record.event?.type !== 'assistant/message') continue;
        const text = answerText(record.event);
        if (text) seen.pending = text;      // шлём последнюю реплику закончившегося хода
      }
      const cursor = value?.state?.cursor;
      if (typeof cursor === 'number' && cursor > seen.seq) { seen.seq = cursor; dirty = true; }
      if (!row.running && seen.pending) {
        const text = seen.pending;
        const asked = seen.replyTo;
        seen.pending = '';
        seen.replyTo = null;
        if (replyAllowed(asked)) {
          outbox(asked.thread ?? null, asked.msg ?? null, text, asked.ws ?? ws);
          trace(`ответ ${ws} на задание из ТГ (msg ${asked.msg}) → группа (${row.sessionId}): ${text.slice(0, 40)}`);
        } else {
          trace(`ответ ${ws} без задания из ТГ — в группу не шлём (${row.sessionId})`);
        }
      }
    }
    saveCursors();
  };

  const deliver = async event => {
    const cfg = readJson(CFG, null);
    const target = targetFor(cfg, event);
    const text = String(event.text ?? '').trim();
    if (!target || !text) {
      trace(`пропуск ${event.thread ?? event.ws} (нет в конфиге или пусто)`);
      return;
    }
    const rows = (await ctx.sessionController.list({}, signal)).items;
    const archived = new Set(ctx.workspaceRegistry.archivedSessionIds);
    const row = pickSession(rows, target, archived);
    if (!row) {
      trace(`нет сессии для ${target.ws}; сессий всего ${rows.length}`);
      outbox(event.thread, event.msg, `⚠️ Нет живой сессии в пространстве «${target.ws}» — задание не доставлено.`, target.ws);
      return;
    }
    const mode = deliveryMode(cfg, target.ws);
    await ctx.sessionController.prompt({
      requestId: randomUUID(), sessionId: row.sessionId, mode,
      content: [{ type: 'text', text }], clientTimeZone: 'Europe/Moscow',
    }, signal);
    // Отметка «на это задание ждём ровно один ответ в ТГ».
    const rec = cursors[row.sessionId] ??= { seq: null, pending: '', replyTo: null };
    rec.replyTo = { thread: event.thread ?? null, msg: event.msg ?? null, ws: target.ws, at: Date.now() };
    dirty = true;
    trace(`доставлено (${mode}): ${target.ws} → ${row.sessionId} (msg ${event.msg})`);
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const event of drain()) {
        trace(`событие ${event.ws ?? 'тема ' + event.thread} (${(event.text ?? '').slice(0, 40)})`);
        try {
          await deliver(event);
        } catch (error) {
          outbox(event.thread, event.msg, `⚠️ Задание не доставлено в сессию: ${error?.message ?? error}`, event.ws ?? null);
          trace(`ошибка: ${error?.stack ?? error}`);
        }
      }
      try {
        await watchAnswers();
      } catch (error) {
        trace(`наблюдатель ответов: ${error?.message ?? error}`);
      }
    } finally {
      busy = false;
    }
  };

  ctx.effect(() => {
    const timer = setInterval(() => { void tick(); }, TICK_MS);
    void tick();
    return () => clearInterval(timer);
  }, 'topic-bridge.poll');
}
