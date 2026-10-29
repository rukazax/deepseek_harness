// MCP (stdio) server exposing Cua Driver computer-use tools to DeepSeek Harness.
//
// Runs as a separate process so that a native crash in the driver cannot take the
// harness down; dsh-mcp-client reconnects automatically.
//
// Usage:  node server.mjs [--all] [--verbose]
//   --all      expose every tool the driver lists (56), not the curated subset
//   --verbose  log protocol activity to stderr
//
// Environment: CUA_MCP_TOOLS=<comma separated names> to override the curated subset.

import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const EXPOSE_ALL = argv.includes('--all');
const VERBOSE = argv.includes('--verbose');

/** Tools that cover "read the screen" and "press the buttons" without flooding the prompt. */
const CURATED = [
  'list_apps',
  'list_windows',
  'get_window_state',
  'get_accessibility_tree',
  'get_desktop_state',
  'get_screen_size',
  'zoom',
  'launch_app',
  'bring_to_front',
  'click',
  'double_click',
  'right_click',
  'drag',
  'type_text',
  'press_key',
  'hotkey',
  'set_value',
  'scroll',
  'invoke_menu',
  'verify_state',
  'clipboard_read',
  'clipboard_write',
  'set_window_frame',
  'kill_app',
  'check_permissions',
  'health_report',
];

const envTools = process.env.CUA_MCP_TOOLS?.split(',').map((s) => s.trim()).filter(Boolean);
const allowed = EXPOSE_ALL || !envTools?.length ? new Set(envTools?.length ? envTools : CURATED) : new Set(envTools);

const INSTRUCTIONS =
  'Computer-use tools operate the Windows desktop of this machine. ' +
  'Start with list_apps / list_windows, then get_window_state (structured UIA elements plus a screenshot) ' +
  'before acting. Prefer element_index over pixel coordinates, prefer background delivery, and verify the ' +
  'outcome from fresh state after every action. Screenshots come back as PNG images.';

const log = (...a) => {
  if (VERBOSE) process.stderr.write(`[cua-mcp] ${a.join(' ')}\n`);
};

let driverPromise;
/** Lazily create the native driver; the harness probes the server before serving. */
function driver() {
  driverPromise ??= import('@trycua/cua-driver').then(({ CuaDriver }) => {
    const d = CuaDriver.create(undefined);
    log('driver created');
    return d;
  });
  return driverPromise;
}

const signal = new AbortController().signal;

async function listTools() {
  const d = await driver();
  const parsed = JSON.parse(await d.listToolsJson({ signal }));
  const tools = parsed.tools
    .filter((t) => !t.name.startsWith('browser_') && !['page', 'start_recording', 'stop_recording', 'get_browser_state', 'browser_prepare'].includes(t.name))
    .filter((t) => EXPOSE_ALL || allowed.has(t.name));
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
}

async function callTool(name, args) {
  const d = await driver();
  const res = await d.callTool(name, JSON.stringify(args ?? {}), { signal });
  // The binding answers with an object carrying `rawJson`; older builds answer with the JSON string itself.
  const raw = typeof res === 'string' ? JSON.parse(res) : JSON.parse(res.rawJson ?? JSON.stringify(res));
  // Cua Driver already answers in MCP result shape; make sure `content` exists.
  if (!Array.isArray(raw.content)) {
    return {
      content: [{ type: 'text', text: JSON.stringify(raw.structuredContent ?? raw) }],
      structuredContent: raw.structuredContent,
    };
  }
  return raw;
}

/**
 * The MCP text channel drops `structuredContent`, which carries the snapshot id and the opaque
 * element tokens that element-indexed actions require. Append them as a compact text trailer so
 * a text-only consumer can still address elements.
 */
function annotate(name, result) {
  const sc = result?.structuredContent;
  if (!sc || typeof sc !== 'object') return result;
  const lines = [];
  if (typeof sc.snapshot_id === 'string') lines.push(`snapshot_id: ${sc.snapshot_id}`);
  if (Array.isArray(sc.elements) && sc.elements.length) {
    const withTokens = sc.elements.filter((e) => typeof e?.element_token === 'string');
    if (withTokens.length) {
      lines.push('element_tokens:');
      for (const e of withTokens) {
        const label = String(e.label ?? e.name ?? '').replace(/\s+/g, ' ').slice(0, 60);
        lines.push(`  [${e.element_index}] ${e.role ?? ''} "${label}" -> ${e.element_token}`);
      }
    }
  }
  if (typeof sc.screenshot_file_path === 'string') lines.push(`screenshot_file: ${sc.screenshot_file_path}`);
  if (!lines.length) return result;
  return { ...result, content: [...result.content, { type: 'text', text: '\n' + lines.join('\n') }] };
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === undefined) return; // response or notification we do not consume
  if (id === undefined) {
    log('notification', method);
    return; // notification
  }
  try {
    switch (method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'cua-driver', version: '0.1.0' },
            instructions: INSTRUCTIONS,
          },
        });
        break;
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        break;
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: await listTools() } });
        break;
      case 'tools/call': {
        const result = annotate(params.name, await callTool(params.name, params.arguments));
        send({ jsonrpc: '2.0', id, result });
        break;
      }
      case 'resources/list':
        send({ jsonrpc: '2.0', id, result: { resources: [] } });
        break;
      case 'prompts/list':
        send({ jsonrpc: '2.0', id, result: { prompts: [] } });
        break;
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (error) {
    log('error', method, error?.message);
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `cua-driver error: ${error?.message ?? error}` }], isError: true },
    });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    log('unparsed line', text.slice(0, 120));
    return;
  }
  void handle(msg);
});

const shutdown = async () => {
  try {
    const d = await Promise.race([driverPromise, Promise.resolve(undefined)]);
    if (d) {
      await d.shutdown();
      d.uniffiDestroy?.();
    }
  } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('stdin', () => {});
rl.on('close', () => { void shutdown(); });
