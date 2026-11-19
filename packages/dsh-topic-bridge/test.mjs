// Один прогон: маппинг тема→пространство, выбор сессии и чтение очереди.
// node --test test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { answerText, deliveryMode, drain, pickSession, replyAllowed, targetFor, topicMap } from './plugin.js';

const cfg = {
  group: 3770383287,
  workspaces: {
    pc_admin: { topic: 12, bot: 'dsh_pcadmin_bot', path: '/w/pc_admin' },
    ZVNO: { topic: 34, bot: 'dsh_zvno_bot', path: '/w/ZVNO' },
    broken: { topic: null, path: '/w/broken' },
  },
};

test('тема → пространство, темы без id не попадают', () => {
  const map = topicMap(cfg);
  assert.deepEqual(map.get(12), { ws: 'pc_admin', path: '/w/pc_admin' });
  assert.equal(map.get(34).ws, 'ZVNO');
  assert.equal(map.has(0), false);
  assert.equal(map.size, 2);
});

test('сессия берётся из своего пространства и не архивная/не сабагент', () => {
  const rows = [
    { sessionId: 'archived', cwd: '/w/pc_admin', origin: 'agent' },
    { sessionId: 'sub', cwd: '/w/pc_admin', origin: 'subagent' },
    { sessionId: 'other', cwd: '/w/ZVNO', origin: 'agent' },
    { sessionId: 'good', cwd: '/w/pc_admin', origin: 'agent' },
  ];
  const archived = new Set(['archived']);
  const target = topicMap(cfg).get(12);
  assert.equal(pickSession(rows, target, archived).sessionId, 'good');
  assert.equal(pickSession([], target, archived), undefined);
});

test('очередь: только целые строки, смещение не теряет и не дублирует', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-bridge-'));
  const inbox = path.join(dir, 'inbox.jsonl');
  try {
    fs.writeFileSync(inbox, '{"thread":12,"msg":1,"text":"a"}\n{"thread":12,"msg":2,');
    assert.equal(drain(dir).length, 1, 'незакрытая строка ждёт');
    fs.appendFileSync(inbox, '"text":"b"}\n');
    const rest = drain(dir);
    assert.deepEqual(rest.map(e => e.msg), [2], 'вторая доставлена ровно один раз');
    assert.deepEqual(drain(dir), [], 'повторный тик пуст');
    fs.writeFileSync(inbox, '{"thread":12,"msg":3,"text":"c"}\n');
    assert.deepEqual(drain(dir).map(e => e.msg), [3], 'пересозданный файл читается с начала');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('в тему уходит только текст ответа, без размышлений и вызовов', () => {
  const event = { data: { message: { content: [
    { type: 'reasoning', text: 'думаю' },
    { type: 'text', text: 'готово' },
    { type: 'tool-call', name: 'bash', arguments: '{}' },
  ] } } };
  assert.equal(answerText(event), 'готово');
  assert.equal(answerText({}), '', 'событие без content не падает');
});

test('режим доставки: общий steer, у пространства свой, по умолчанию очередь', () => {
  assert.equal(deliveryMode({ delivery: 'steer' }, 'pc_admin'), 'steer');
  assert.equal(deliveryMode({ delivery: 'steer', workspaces: { ZVNO: { delivery: 'queue' } } }, 'ZVNO'), 'queue');
  assert.equal(deliveryMode({}, 'pc_admin'), 'queue');
  assert.equal(deliveryMode({ delivery: 'что-то' }, 'x'), 'queue');
});

test('задание находит пространство по ws из очереди, тема — запасной путь', () => {
  assert.deepEqual(targetFor(cfg, { ws: 'ZVNO' }), { ws: 'ZVNO', path: '/w/ZVNO' });
  assert.deepEqual(targetFor(cfg, { thread: 12 }), { ws: 'pc_admin', path: '/w/pc_admin' });
  assert.equal(targetFor(cfg, { ws: 'нет', thread: 999 }), null);
});

test('ответ в ТГ — только на задание из ТГ и один раз', () => {
  const now = 1_800_000_000_000;
  assert.equal(replyAllowed({ thread: 3, msg: 7, ws: 'pc_admin', at: now - 1000 }, now), true);
  assert.equal(replyAllowed(null, now), false, 'ручной ввод в Web — не в группу');
  assert.equal(replyAllowed({}, now), false, 'отметка без времени не считается');
  assert.equal(replyAllowed({ at: now }, now), true, 'at только что — граница');
  assert.equal(replyAllowed({ at: now - 31 * 60_000 }, now), false, 'протухшая отметка не приписывает ответ');
});
