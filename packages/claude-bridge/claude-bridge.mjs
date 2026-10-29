#!/usr/bin/env node
'use strict';

/**
 * claude-bridge — a tiny Anthropic-Messages-compatible endpoint backed by the
 * local Claude Code CLI (Claude Pro/Max subscription).
 *
 * Why: DSH (and other harnesses) can talk to an Anthropic-compatible API, but a
 * subscription is not an API key. This bridge accepts /v1/messages, runs
 * `claude -p --output-format json`, and answers in the Anthropic wire shape.
 *
 * No dependencies. Loopback only. No token is read or stored: the CLI keeps its
 * own OAuth credentials in ~/.claude.
 *
 *   node claude-bridge.mjs [--port 8790] [--model sonnet] [--timeout 300000]
 *
 * Endpoints:
 *   GET  /health          -> {ok, cli, loggedIn}
 *   GET  /v1/models       -> Anthropic-shaped model list
 *   POST /v1/messages     -> Anthropic Messages (stream=true supported)
 */

import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const PORT = Number(flag('--port', '8790'));
const MODEL = flag('--model', 'sonnet');
const TIMEOUT = Number(flag('--timeout', '300000'));
const HOST = '127.0.0.1';

const CLAUDE = process.platform === 'win32'
  ? join(process.env.APPDATA || '', 'npm', 'claude.cmd')
  : 'claude';

const MODELS = [
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5 (subscription)', created_at: '2026-10-01T00:00:00Z' },
  { id: 'claude-opus-5', display_name: 'Claude Opus 5 (subscription)', created_at: '2026-10-01T00:00:00Z' },
  { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5 (subscription)', created_at: '2026-10-01T00:00:00Z' },
];

function log(...parts) {
  process.stdout.write(`[claude-bridge ${new Date().toISOString()}] ${parts.join(' ')}\n`);
}

function flatten(body) {
  const chunks = [];
  const system = typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system)
      ? body.system.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n')
      : '';
  if (system.trim()) chunks.push(`SYSTEM:\n${system.trim()}`);
  for (const message of body.messages || []) {
    const text = Array.isArray(message.content)
      ? message.content.map((part) => (typeof part === 'string' ? part : part.text || '')).join('\n')
      : String(message.content || '');
    if (!text.trim()) continue;
    chunks.push(`${message.role === 'assistant' ? 'ASSISTANT' : 'USER'}:\n${text.trim()}`);
  }
  return chunks.join('\n\n');
}

function runCli(cliArgs, timeoutMs = TIMEOUT) {
  // Node >=20 refuses to spawn .cmd files directly (EINVAL); route through cmd.exe.
  const isWin = process.platform === 'win32';
  const file = isWin ? (process.env.ComSpec || 'cmd.exe') : CLAUDE;
  const args2 = isWin ? ['/d', '/s', '/c', CLAUDE, ...cliArgs] : cliArgs;
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        file,
        args2,
        { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => resolve({ error, stdout: stdout || '', stderr: stderr || '' }),
      );
    } catch (error) {
      resolve({ error, stdout: '', stderr: '' });
      return;
    }
    child.stdin.end();
  });
}

function runClaude(prompt, modelHint) {
  const modelName = /opus/i.test(modelHint) ? 'opus' : /haiku/i.test(modelHint) ? 'haiku' : MODEL;
  const cliArgs = ['-p', '--output-format', 'json', '--model', modelName, '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,Task,WebFetch,WebSearch,NotebookEdit'];
  const isWin = process.platform === 'win32';
  const file = isWin ? (process.env.ComSpec || 'cmd.exe') : CLAUDE;
  const args2 = isWin ? ['/d', '/s', '/c', CLAUDE, ...cliArgs] : cliArgs;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = execFile(
        file,
        args2,
        { timeout: TIMEOUT, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`${error.message}${stderr ? ` | ${stderr.slice(0, 400)}` : ''}`));
            return;
          }
          try {
            const parsed = JSON.parse(stdout);
            resolve({ text: parsed.result ?? parsed.text ?? '', usage: parsed.usage || null, model: modelName });
          } catch {
            resolve({ text: String(stdout).trim(), usage: null, model: modelName });
          }
        },
      );
    } catch (error) {
      reject(new Error(`spawn failed: ${error.message}`));
      return;
    }
    child.stdin.end(prompt);
  });
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function messagePayload(model, text) {
  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: Math.ceil(text.length / 4) },
  };
}

function streamPayload(res, model, text) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  emit('ping', { type: 'ping' });
  emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  emit('content_block_stop', { type: 'content_block_stop', index: 0 });
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.ceil(text.length / 4) } });
  emit('message_stop', { type: 'message_stop' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    runCli(['auth', 'status'], 20000).then(({ error, stdout }) => {
      let status = null;
      try { status = JSON.parse(stdout); } catch { /* ignore */ }
      sendJson(res, 200, {
        ok: !error,
        cli: CLAUDE,
        cliExists: existsSync(CLAUDE) || process.platform !== 'win32',
        loggedIn: Boolean(status && status.loggedIn),
        authMethod: status ? status.authMethod : null,
        model: MODEL,
      });
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    sendJson(res, 200, {
      data: MODELS.map((m) => ({ ...m, type: 'model', owned_by: 'anthropic-cli' })),
      has_more: false,
      first_id: MODELS[0].id,
      last_id: MODELS[MODELS.length - 1].id,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }); return; }
      const prompt = flatten(body);
      if (!prompt.trim()) {
        sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'empty prompt' } });
        return;
      }
      const started = Date.now();
      try {
        const result = await runClaude(prompt, String(body.model || ''));
        log(`POST /v1/messages model=${result.model} chars=${result.text.length} ${Date.now() - started}ms`);
        if (body.stream) streamPayload(res, result.model, result.text);
        else sendJson(res, 200, messagePayload(result.model, result.text));
      } catch (error) {
        log(`ERROR /v1/messages: ${error.message}`);
        sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: error.message } });
      }
    });
    return;
  }

  sendJson(res, 404, { type: 'error', error: { type: 'not_found', message: `no route ${req.method} ${url.pathname}` } });
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`cli: ${CLAUDE}`);
  log(`model alias: ${MODEL}`);
});
