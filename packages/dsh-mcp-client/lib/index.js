/**
 * dsh-mcp-client — MCP client plugin for DeepSeek Harness.
 *
 * Spawns MCP servers (stdio JSON-RPC 2.0), lists their tools and registers
 * each MCP tool as a native DSH tool (prefix "<server>__").
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export const name = "dsh-mcp-client";
export const inject = [];

const DEFAULT_SERVERS = [
  {
    id: "sarex",
    command: "C:\\Users\\AMNovez\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe",
    args: ["C:\\Users\\AMNovez\\Documents\\deepseek-harness\\АМН\\_mcp\\sarex\\server.py"],
    timeoutMs: 120000,
  },
  {
    id: "mail",
    command: "C:\\Users\\AMNovez\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe",
    args: ["C:\\Users\\AMNovez\\Documents\\deepseek-harness\\АМН\\_mcp\\yandex-mail\\server.py"],
    timeoutMs: 180000,
  },
];

class McpConnection {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.proc = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.serverInfo = null;
    this.disposed = false;
  }

  async start() {
    this.proc = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) this.logger.info?.(`[mcp:${this.config.id}] ${line.trim()}`);
      }
    });
    this.proc.on("error", (err) => this.logger.error?.(`[mcp:${this.config.id}] spawn error: ${err.message}`));
    this.proc.on("exit", (code) => {
      if (this.disposed) return;
      this.logger.error?.(`[mcp:${this.config.id}] exited with code ${code}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP server ${this.config.id} exited`));
      }
      this.pending.clear();
    });
    const init = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "dsh-mcp-client", version: "1.0.0" },
    });
    this.serverInfo = init?.serverInfo ?? null;
    this.notify("notifications/initialized", {});
    const listed = await this.request("tools/list", {});
    this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
    this.logger.info?.(`[mcp:${this.config.id}] ${this.tools.length} tool(s) from ${this.serverInfo?.name ?? "server"}`);
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.logger.info?.(`[mcp:${this.config.id}] non-JSON: ${line.slice(0, 200)}`);
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
      }
    }
  }

  request(method, params) {
    if (!this.proc || this.disposed) return Promise.reject(new Error("MCP server not running"));
    const id = this.nextId++;
    const timeoutMs = this.config.timeoutMs ?? 120000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    if (!this.proc || this.disposed) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(toolName, args) {
    const result = await this.request("tools/call", { name: toolName, arguments: args ?? {} });
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .map((item) => (item?.type === "text" ? item.text : JSON.stringify(item)))
      .filter((v) => typeof v === "string")
      .join("\n");
    return { text, isError: Boolean(result?.isError), raw: result };
  }

  dispose() {
    this.disposed = true;
    try {
      this.proc?.stdin?.end();
      this.proc?.kill();
    } catch {}
  }
}

function toolParamsFromMcp(inputSchema) {
  if (inputSchema && typeof inputSchema === "object" && inputSchema.type === "object") {
    return inputSchema;
  }
  return { type: "object", properties: {}, additionalProperties: false };
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;
  const serverConfigs = Array.isArray(config.servers) && config.servers.length > 0
    ? config.servers
    : DEFAULT_SERVERS;
  const connections = [];
  const disposers = [];

  const registerTool = (conn, mcpTool) => {
    const toolName = `${conn.config.id}__${String(mcpTool.name).replace(/[^A-Za-z0-9_]/g, "_")}`;
    const description = `[MCP ${conn.config.id}] ${mcpTool.description ?? mcpTool.name}`;
    try {
      const remove = ctx.inject(["tools"], (toolCtx) =>
        toolCtx.tools.register({
          name: toolName,
          description,
          parameters: toolParamsFromMcp(mcpTool.inputSchema),
          output: {
            schema: { type: "object" },
            render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
          },
          isConcurrencySafe: () => true,
          execute: async (args) => {
            const result = await conn.callTool(mcpTool.name, args);
            if (result.isError) throw new Error(result.text || `MCP tool ${mcpTool.name} failed`);
            return result;
          },
        }),
      );
      disposers.push(remove);
    } catch (err) {
      logger.error?.(`[mcp:${conn.config.id}] failed to register ${toolName}: ${err?.message ?? err}`);
    }
  };

  for (const serverConfig of serverConfigs) {
    const conn = new McpConnection(serverConfig, logger);
    connections.push(conn);
    conn.start()
      .then(() => {
        for (const mcpTool of conn.tools) registerTool(conn, mcpTool);
      })
      .catch((err) => {
        logger.error?.(`[mcp:${serverConfig.id}] initialization failed: ${err?.message ?? err}`);
      });
  }

  // DSH-native tool: restore Kimi chats as live sessions in the current workspace.
  ctx.inject(["sessions", "tools"], (sessionCtx) => {
    const remove = sessionCtx.tools.register({
      name: "dsh_restore_kimi_chats",
      description:
        "Create native DSH sessions from restored Kimi chats (data file: _kimi/chats/restore-data.json). " +
        "Sessions are created in the data file's cwd (workspace) and persisted by DSH itself.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          data_path: { type: "string", description: "Optional path to restore-data.json" },
          cwd: { type: "string", description: "Optional workspace cwd override" },
        },
      },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const path = args?.data_path ||
          "C:\\Users\\AMNovez\\Documents\\deepseek-harness\\АМН\\_kimi\\chats\\restore-data.json";
        const data = JSON.parse(await readFile(path, "utf8"));
        const cwd = args?.cwd || data.cwd;
        const created = [];
        for (const chat of data.chats ?? []) {
          const sessionId = "session-" + randomUUID();
          const session = sessionCtx.sessions.create(sessionId, { meta: { cwd } });
          session.append(
            "user/message",
            { role: "user", content: [{ type: "text", text: chat.text }], source: { kind: "user" } },
            { surfaceOp: "append" },
          );
          try {
            session.append("session/title", {
              title: chat.title,
              messageSeqs: [],
              source: { kind: "user" },
            });
          } catch (err) {
            // title is best-effort; DSH may auto-generate it later
          }
          if (sessionCtx.sessions.flush) await sessionCtx.sessions.flush(session);
          created.push({ title: chat.title, session_id: sessionId, chars: (chat.text ?? "").length });
        }
        return { text: JSON.stringify({ cwd, created }, null, 2), created };
      },
    });
    disposers.push(remove);
  });

  // DSH-native tool: attach cloned sessions to the AMN workspace (validates persistence) and detach stale ids.
  ctx.inject(["workspaceRegistry", "tools"], (wsCtx) => {
    const remove = wsCtx.tools.register({
      name: "dsh_attach_sessions",
      description:
        "Attach existing session ids to the AMN workspace via the live workspace registry; optionally detach stale ids.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { data_path: { type: "string" } },
      },
      output: { schema: { type: "object" }, render: (_a, v) => [{ type: "text", text: String(v?.text ?? "") }] },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const path = args?.data_path ||
          "C:\\Users\\AMNovez\\Documents\\deepseek-harness\\АМН\\_kimi\\chats\\attach-ids.json";
        const data = JSON.parse(await readFile(path, "utf8"));
        const workspaces = wsCtx.workspaceRegistry.list();
        const ws = workspaces.find((w) => String(w.path).toLowerCase() === String(data.cwd).toLowerCase())
          || workspaces.find((w) => /АМН$/.test(String(w.path)));
        if (!ws) throw new Error("workspace not found for cwd: " + data.cwd);
        const results = [];
        for (const id of data.cleanup ?? []) {
          try { await ws.detachSession(id); results.push({ id, action: "detach", ok: true }); }
          catch (e) { results.push({ id, action: "detach", ok: false, error: String(e?.message ?? e) }); }
        }
        for (const s of data.sessions ?? []) {
          try { await ws.attachSession(s.id); results.push({ id: s.id, title: s.title, action: "attach", ok: true }); }
          catch (e) { results.push({ id: s.id, title: s.title, action: "attach", ok: false, error: String(e?.message ?? e) }); }
        }
        return { text: JSON.stringify(results, null, 2), results };
      },
    });
    disposers.push(remove);
  });

  ctx.effect(() => () => {
    for (const remove of disposers.splice(0)) {
      try { remove(); } catch {}
    }
    for (const conn of connections) conn.dispose();
  }, "dsh-mcp-client: dispose connections");
}
