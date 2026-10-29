// MCP (stdio) bridge: DeepSeek Harness chats -> Kot (OpenClaw agent "main").
//
// Every chat in every DSH workspace of the `desktop` profile gets these tools, so
// any DSH conversation can hand work to Kot, read his session list, or check his
// gateway/channel health. Kot itself runs in the OpenClaw Gateway (127.0.0.1:18789);
// this server is only a thin, dependency-free CLI bridge to `openclaw`.
//
// Usage:  node server.mjs [--verbose]
// Env:    OPENCLAW_NODE       node executable that runs openclaw.mjs (default: process.execPath)
//         OPENCLAW_MJS        path to openclaw.mjs
//         OPENCLAW_AGENT      default agent id (default: main = Kot)
//         KOT_ASK_TIMEOUT_MS  hard timeout for one agent turn (default: 900000)
//
// The MCP stdio channel is stdout: everything diagnostic goes to stderr.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const VERBOSE = process.argv.slice(2).includes('--verbose');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_NODE = process.env.OPENCLAW_NODE || process.execPath;
const OPENCLAW_MJS =
  process.env.OPENCLAW_MJS || join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');
const DEFAULT_AGENT = process.env.OPENCLAW_AGENT || 'main';
const ASK_TIMEOUT_MS = Number(process.env.KOT_ASK_TIMEOUT_MS || 840000);
const WORKSPACE_FILE = join(HOME, '.dsh', 'storages', 'workspace.json');
const MAX_TEXT = 24000;

function log(...parts) {
  if (VERBOSE) process.stderr.write(`[kot-mcp] ${parts.join(' ')}\n`);
}

/** Run the OpenClaw CLI and return { code, stdout, stderr }. stdout only: the CLI
 *  prints recovery notices on stderr and they would break JSON parsing. */
function runCli(args, { timeoutMs = 120000, input } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS; // the bridge talks to the local gateway; no DNS pin needed
    env.OPENCLAW_NO_UPDATE_NOTICE = '1';
    let child;
    try {
      child = spawn(OPENCLAW_NODE, [OPENCLAW_MJS, ...args], {
        env,
        cwd: HOME,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: `spawn failed: ${error.message}` });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve({ code: -2, stdout: Buffer.concat(out).toString('utf8'), stderr: `timeout after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: `spawn error: ${error.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function parseJson(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // tolerate leading chatter: take the outermost JSON object/array
    const start = trimmed.search(/[[{]/);
    if (start < 0) return undefined;
    const slice = trimmed.slice(start);
    try {
      return JSON.parse(slice);
    } catch {
      return undefined;
    }
  }
}

function clip(text, limit = MAX_TEXT) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated ${value.length - limit} chars]` : value;
}

function readWorkspaces() {
  if (!existsSync(WORKSPACE_FILE)) return undefined;
  try {
    const data = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'));
    const global = data.global || {};
    const table = (data.tables && data.tables.workspaces) || {};
    return Object.entries(table).map(([id, item]) => ({
      id,
      title: item.title || '',
      path: item.path || '',
      sessions: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
      default: global.defaultWorkspaceId === id,
      updatedAt: item.updatedAt || null,
    }));
  } catch (error) {
    log('workspace.json parse failed', error.message);
    return undefined;
  }
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Stable short session key per DSH workspace (its folder name), so every DSH
 *  workspace keeps its own continuous Kot conversation. */
function workspaceSlug(path) {
  if (!path) return 'chat';
  const base = String(path).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || 'chat';
  return slug(base) || 'chat';
}

/** One Kot turn through the running Gateway. */
async function askKot(args = {}) {
  // Accept both snake_case (tool schema) and camelCase callers.
  const prompt = args.prompt ?? args.message;
  const sessionKey = args.session_key ?? args.sessionKey;
  const agent = args.agent;
  const thinking = args.thinking;
  const workspace = args.workspace ?? args.workspace_path;
  const timeoutSeconds = args.timeout_seconds ?? args.timeoutSeconds;
  const agentId = agent || DEFAULT_AGENT;
  const key = sessionKey || `dsh-${workspaceSlug(workspace)}`;
  const timeoutMs = Math.min(Math.max(Number(timeoutSeconds || 0) * 1000 || ASK_TIMEOUT_MS, 10000), ASK_TIMEOUT_MS);

  let message = String(prompt || '').trim();
  if (!message) throw new Error('prompt is required');
  if (workspace) message = `[DSH workspace: ${workspace}]\n${message}`;

  const cliArgs = ['agent', '--agent', agentId, '--session-key', key, '--json'];
  if (thinking) cliArgs.push('--thinking', String(thinking));
  // The gateway has its own agent-command timeout (default ~600 s). Pass ours through so a
  // long turn is not cut short by the gateway while we are still waiting for it.
  cliArgs.push('--timeout', String(Math.max(60, Math.round(timeoutMs / 1000))));

  let tempDir;
  try {
    if (Buffer.byteLength(message, 'utf8') > 4000) {
      tempDir = mkdtempSync(join(tmpdir(), 'kot-ask-'));
      const file = join(tempDir, 'message.txt');
      writeFileSync(file, message, 'utf8');
      cliArgs.push('--message-file', file);
    } else {
      cliArgs.push('--message', message);
    }
    // Transient provider/network failures (VPN flap, busy gateway, one slow model)
    // used to surface as a hard error after a single attempt. Retry once after a
    // short pause so the caller gets a result instead of "fetch failed (timeout)".
    const isRetryable = (text) =>
      /All models failed|fetch failed|timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR|socket hang up|429|502|503/i.test(
        String(text || ''),
      );
    const retryAttempts = Math.max(1, Number(process.env.KOT_ASK_RETRY_ATTEMPTS || 2));
    const retryDelayMs = Number(process.env.KOT_ASK_RETRY_DELAY_MS || 5000);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    let payload = null;
    let lastError = null;
    for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
      const result = await runCli(cliArgs, { timeoutMs });
      payload = parseJson(result.stdout);
      if (!payload) {
        lastError = new Error(
          `openclaw agent produced no JSON (exit ${result.code}). ${clip(result.stderr || result.stdout, 1200)}`,
        );
        if (attempt < retryAttempts && isRetryable(result.stderr || result.stdout)) {
          await sleep(retryDelayMs);
          continue;
        }
        throw lastError;
      }
      if (payload.ok === false || payload.error) {
        const detail = payload.error && (payload.error.message || payload.error.type || JSON.stringify(payload.error));
        lastError = new Error(`Kot turn failed: ${detail || 'unknown error'}`);
        if (attempt < retryAttempts && isRetryable(detail)) {
          payload = null;
          await sleep(retryDelayMs);
          continue;
        }
        throw lastError;
      }
      break;
    }
    if (!payload) throw lastError || new Error('Kot turn failed: empty response');
    const data = payload.result || payload;
    const meta = data.meta || (data.result && data.result.meta) || {};
    const agentMeta = meta.agentMeta || {};
    const trace = meta.executionTrace || {};
    const usage = agentMeta.usage || meta.usage || {};
    const payloads = data.payloads || (data.result && data.result.payloads) || [];
    const text =
      (payloads[0] && payloads[0].text) ||
      meta.finalAssistantVisibleText ||
      data.finalAssistantVisibleText ||
      '';
    const attempts = (agentMeta.fallbackAttempts || meta.fallbackAttempts || []).map((a) => ({
      provider: a.provider,
      model: a.model,
      reason: a.reason,
      status: a.status ?? null,
    }));
    return {
      text: clip(text || '(empty reply)'),
      sessionKey: key,
      agent: agentId,
      provider: agentMeta.provider || trace.winnerProvider || null,
      model: agentMeta.model || trace.winnerModel || null,
      fallbackUsed: Boolean(trace.fallbackUsed || attempts.length),
      fallbackAttempts: attempts,
      durationMs: meta.durationMs ?? agentMeta.durationMs ?? null,
      costUsd: agentMeta.costUsd ?? (usage.cost && usage.cost.total) ?? null,
      stopReason: data.stopReason || meta.stopReason || null,
    };
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

async function kotStatus() {
  const [status, channels] = await Promise.all([
    runCli(['status', '--json'], { timeoutMs: 120000 }),
    runCli(['channels', 'status', '--json'], { timeoutMs: 120000 }),
  ]);
  const statusJson = parseJson(status.stdout);
  const channelsJson = parseJson(channels.stdout);
  if (!statusJson && !channelsJson) {
    throw new Error(
      `Gateway not reachable — is the "OpenClaw Gateway" task running? ${clip(channels.stderr || status.stderr, 800)}`,
    );
  }
  const accounts = (channelsJson && channelsJson.channelAccounts) || {};
  const channelRows = [];
  for (const [channel, list] of Object.entries(accounts)) {
    for (const account of Array.isArray(list) ? list : []) {
      channelRows.push({
        channel,
        account: account.accountId ?? account.id ?? null,
        label: account.label ?? account.name ?? null,
        state: account.lifecycle ?? account.state ?? account.status ?? null,
        running: account.running ?? null,
        connected: account.connected ?? null,
        mode: account.mode ?? null,
        tokenStatus: account.tokenStatus ?? null,
        lastError: account.lastError ?? null,
      });
    }
  }
  const byAgent = (statusJson && statusJson.sessions && statusJson.sessions.byAgent) || [];
  return {
    gateway: statusJson ? { pid: statusJson.pid ?? null, reachable: true } : { reachable: false },
    version: (statusJson && statusJson.runtimeVersion) || null,
    sessions: statusJson && statusJson.sessions ? statusJson.sessions.count : null,
    agents: Array.isArray(byAgent)
      ? byAgent.map((a) => ({ id: a.agentId ?? a.id ?? null, sessions: a.count ?? a.sessions ?? null }))
      : byAgent,
    degradedPlugins: (statusJson && statusJson.degradedPlugins) || [],
    channels: channelRows,
    issues: (channelsJson && channelsJson.statusIssues) || [],
    warnings: (channelsJson && channelsJson.warnings) || [],
  };
}

async function kotAgents() {
  const result = await runCli(['agents', 'list', '--json'], { timeoutMs: 90000 });
  const json = parseJson(result.stdout);
  if (!json) throw new Error(`agents list produced no JSON. ${clip(result.stderr, 800)}`);
  const list = json.agents || json;
  if (!Array.isArray(list)) return list;
  return list.map((a) => ({
    id: a.id || a.agentId,
    name: a.name || (a.identity && a.identity.name) || null,
    workspace: a.workspace || null,
    model: (a.model && (a.model.primary || a.model)) || a.modelId || null,
  }));
}

async function kotSessions({ limit = 20, agent } = {}) {
  const args = ['sessions', 'list', '--json', '--limit', String(Math.min(Math.max(Number(limit) || 20, 1), 200))];
  if (agent) args.push('--agent', String(agent));
  else args.push('--all-agents');
  const result = await runCli(args, { timeoutMs: 120000 });
  const json = parseJson(result.stdout);
  if (!json) throw new Error(`sessions list produced no JSON. ${clip(result.stderr, 800)}`);
  return (json.sessions || []).map((s) => ({
    key: s.key,
    status: s.status || null,
    updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
    ageMinutes: s.ageMs ? Math.round(s.ageMs / 60000) : null,
    sessionId: s.sessionId || null,
  }));
}

const TOOLS = [
  {
    name: 'kot_ask',
    description:
      'Передать запрос агенту Kot (OpenClaw, агент main) и получить его ответ. Kot видит файлы этой машины, ' +
      'своё рабочее пространство и память, у него свои чаты в Telegram. Возвращает текст ответа, модель и стоимость хода. ' +
      'Один вызов = один ход агента; история сохраняется в сессии Kot по session_key. ' +
      'ВАЖНО: long-running задача (разработка, прогоны, субагенты) не влезает в один вызов — вместо одного большого ' +
      'запроса давайте короткие поручения и потом короткие опросы статуса («что уже сделано»); задачу Kot не теряет, ' +
      'она остаётся в его сессии.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Запрос Kot целиком, с контекстом задачи.' },
        workspace: {
          type: 'string',
          description: 'Путь рабочего пространства DSH, из которого пришёл запрос (передаётся Kot как контекст).',
        },
        session_key: {
          type: 'string',
          description: 'Ключ сессии Kot; по умолчанию dsh-<workspace>. Один ключ = одна непрерывная беседа.',
        },
        agent: { type: 'string', description: 'Другой агент OpenClaw вместо main (assistant-1, zhopa, deepseek, ...).' },
        thinking: { type: 'string', enum: ['off', 'low', 'medium', 'high', 'max', 'ultra'], description: 'Уровень размышлений на один ход.' },
        timeout_seconds: {
          type: 'number',
          description: 'Ждать ответ не дольше N секунд (по умолчанию 840, максимум 840). Значение передаётся и в Gateway.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'kot_status',
    description: 'Состояние Gateway Kot: версия, служба, агенты, сессии и подключение каналов (Telegram и др.).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kot_channels',
    description: 'Только состояние каналов Kot (Telegram-аккаунты: running/connected, режим, предупреждения).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kot_agents',
    description: 'Список агентов OpenClaw с рабочими каталогами и моделями.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kot_sessions',
    description: 'Последние сессии/чаты Kot (агент, ключ, статус, время).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Сколько сессий вернуть (1..200, по умолчанию 20).' },
        agent: { type: 'string', description: 'Ограничить одним агентом (по умолчанию все агенты).' },
      },
    },
  },
  {
    name: 'kot_workspaces',
    description:
      'Рабочие пространства DeepSeek Harness на этой машине (путь, название, число чатов). Помогает понять, ' +
      'откуда пришёл запрос и какие каталоги есть у Kot на диске.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'kot_ask':
      return askKot(args || {});
    case 'kot_status':
      return kotStatus();
    case 'kot_channels': {
      const status = await kotStatus();
      return { channels: status.channels, warnings: status.warnings };
    }
    case 'kot_agents':
      return { agents: await kotAgents() };
    case 'kot_sessions':
      return { sessions: await kotSessions(args || {}) };
    case 'kot_workspaces': {
      const workspaces = readWorkspaces();
      if (!workspaces) throw new Error(`cannot read ${WORKSPACE_FILE}`);
      return { count: workspaces.length, workspaces };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === 'initialize') {
    const requested = params && params.protocolVersion;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'kot', version: '1.0.0' },
        instructions:
          'Kot (OpenClaw) bridge. Use kot_ask to delegate a task to Kot and read his answer; ' +
          'kot_status/kot_channels for gateway and Telegram health; kot_workspaces for the DSH workspace map.',
      },
    };
  }
  if (method && method.startsWith('notifications/')) return undefined;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const data = await callTool(name, args);
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `Ошибка ${name}: ${error.message}` }], isError: true },
      };
    }
  }
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (id === undefined) return undefined;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (error) {
    process.stderr.write(`[kot-mcp] bad JSON: ${error.message}\n`);
    return;
  }
  if (VERBOSE) log('<-', request.method || request.id);
  try {
    const response = await handle(request);
    if (response) send(response);
  } catch (error) {
    process.stderr.write(`[kot-mcp] handler error: ${error.stack || error.message}\n`);
    if (request.id !== undefined) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: String(error.message || error) } });
    }
  }
});
rl.on('close', () => process.exit(0));
process.stderr.write('[kot-mcp] ready (tools: kot_ask, kot_status, kot_channels, kot_agents, kot_sessions, kot_workspaces)\n');
