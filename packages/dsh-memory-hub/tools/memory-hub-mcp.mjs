#!/usr/bin/env node
/**
 * memory-hub-mcp.mjs — stdio MCP server over the same SQLite store.
 *
 * Purpose: the memory stops being a DSH-only thing. Any MCP client (opencode,
 * Claude Code, an editor plugin) can read the same base without a second copy,
 * a daemon or a token budget. Zero dependencies, JSON-RPC 2.0 over stdin/stdout.
 *
 *   {"command":"node","args":["/srv/apps/dsh/dsh-home/lib/memory-hub-mcp.mjs"]}
 *
 * Env: MEMORY_HUB_DB (default: ~/.dsh/memory/ctxdb.sqlite, then /srv/apps/dsh/memory/ctxdb.sqlite)
 * Tools: memory_search, memory_source, memory_save, memory_goal, memory_stats
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN = process.env.MEMORY_HUB_PLUGIN ?? new URL("../index.js", import.meta.url).pathname;
const { __test } = await import(PLUGIN);
const { MemoryStore, searchMemory, normalizeConfig, stemWord, stemsOf, clip, chunkRef, redact } = __test;

function resolveDb() {
	const explicit = process.env.MEMORY_HUB_DB;
	if (explicit && explicit.trim() !== "") return explicit;
	const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
	const candidates = [
		path.join(home, "memory", "ctxdb.sqlite"),
		"/srv/apps/dsh/memory/ctxdb.sqlite"
	];
	for (const file of candidates) if (fs.existsSync(file)) return file;
	return candidates[0];
}

const DB_PATH = resolveDb();
let store;
let config;
let idf;
let assoc = new Map();

function open() {
	if (store !== undefined) return store;
	store = new MemoryStore(DB_PATH, (message) => process.stderr.write(`memory-hub-mcp: ${message}\n`));
	config = normalizeConfig({});
	idf = store.readIdf();
	assoc = store.assocLoad();
	return store;
}

/** Refresh the in-memory vocabulary when another process appended to the store. */
function refreshVocab() {
	const loaded = store.readIdf();
	idf = loaded;
}

function text(value) { return { content: [{ type: "text", text: String(value) }] }; }

const TOOLS = [
	{
		name: "memory_search",
		description: "Search the shared cross-chat and cross-workspace memory (hybrid lexical + association expansion). Returns memory references you can expand with memory_source.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to find" },
				project: { type: "string", description: "Workspace label to boost (optional)" },
				limit: { type: "integer", description: "Max hits, default 5" },
				min_score: { type: "number", description: "Score floor, default 0.28" }
			},
			required: ["query"]
		}
	},
	{
		name: "memory_source",
		description: "Expand a short memory reference (#ab12cd34) into its workspace, session, turn, timestamp and full text.",
		inputSchema: {
			type: "object",
			properties: { ref: { type: "string" }, chars: { type: "integer" } },
			required: ["ref"]
		}
	},
	{
		name: "memory_save",
		description: "Save a durable fact or a note into the shared memory (visible to every chat and workspace). Secrets are redacted automatically.",
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string" },
				kind: { type: "string", enum: ["fact", "note"] }
			},
			required: ["text"]
		}
	},
	{
		name: "memory_goal",
		description: "Project goal: set/confirm, list, close. A stored goal is checked against later steps by the DSH plugin.",
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["set", "list", "done", "drop"] },
				text: { type: "string" },
				id: { type: "string" },
				project: { type: "string" }
			},
			required: ["action"]
		}
	},
	{
		name: "memory_stats",
		description: "Store inventory: chunks by kind, routines, skills, goals, vocabulary generation and association count.",
		inputSchema: { type: "object", properties: {} }
	}
];

function hitLine(row, index) {
	const stamp = `${chunkRef(row.id)} · ${row.kind}${row.project ? ` · ${row.project}` : ""}`;
	return `${index + 1}. [${stamp}] ${row.score.toFixed(2)} — ${clip(row.text, 300)}`;
}

async function callTool(name, args = {}) {
	open();
	refreshVocab();
	if (name === "memory_search") {
		const query = String(args.query ?? "");
		if (query.trim().length < 2) return text("Пустой запрос.");
		assoc = store.assocLoad();
		const result = searchMemory(store, query, {
			config: { ...config, recallFallbackScore: 0 },
			project: String(args.project ?? ""),
			limit: Math.max(1, Math.min(20, Number(args.limit ?? 5))),
			minScore: Number(args.min_score ?? 0.28),
			idf,
			assoc
		});
		if (result.picks.length === 0) {
			return text(`Похожего в памяти нет (просмотрено ${result.candidates} кандидатов, лучшее совпадение ${result.best.toFixed(2)}).`);
		}
		for (const row of result.picks) store.punchHit(row.id);
		return text(result.picks.map(hitLine).join("\n"));
	}
	if (name === "memory_source") {
		const row = store.chunkByRef(String(args.ref ?? ""));
		if (row === undefined || row === null) return text(`Источник «${args.ref}» не найден.`);
		const when = new Date(Number(row.ts ?? 0));
		return text([
			`Источник ${chunkRef(row.id)} · ${row.kind} · ${row.project || "—"}`,
			`сессия ${row.session_id || "—"}${row.turn ? `, ход ${row.turn}` : ""}`,
			`время ${Number.isNaN(when.getTime()) ? "—" : when.toISOString().slice(0, 16)}`,
			"",
			clip(row.text, Math.max(200, Math.min(4000, Number(args.chars ?? 1200))))
		].join("\n"));
	}
	if (name === "memory_save") {
		const body = redact(String(args.text ?? "")).replace(/\s+/g, " ").trim();
		if (body.length < 12) return text("Текст слишком короткий для запоминания.");
		const kind = args.kind === "fact" ? "fact" : "doc";
		const id = createHash("sha256").update(`${kind}|${body.slice(0, 3000)}`, "utf8").digest("hex").slice(0, 32);
		store.upsertChunk(id, kind, body, "mcp", "", 0, Date.now(), [...__test.embed(body, idf)], __test.VEC_VERSION);
		return text(`Сохранено: ${chunkRef(id)}`);
	}
	if (name === "memory_goal") {
		const action = String(args.action ?? "list");
		const project = String(args.project ?? "");
		if (action === "set") {
			const body = clip(String(args.text ?? ""), 400);
			if (body.length < 8) return text("Нужен текст цели.");
			const id = store.goalCreate("", project, body, [...__test.embed(body, idf)], Date.now());
			return text(`Цель зафиксирована: «${body}» (${id}).`);
		}
		if (action === "done" || action === "drop") {
			const id = String(args.id ?? "");
			if (id === "") return text("Укажите id цели.");
			store.goalSetStatus(id, action === "done" ? "done" : "dropped", Date.now());
			return text(`Цель ${id} закрыта как ${action}.`);
		}
		const rows = project !== "" ? store.goalActiveProject(project, 10) : store.goalList(10).filter((g) => g.status === "active");
		if (rows.length === 0) return text("Активных целей нет.");
		return text(rows.map((g) => `- ${g.id} · ${clip(g.text, 160)} · ${g.project || "—"} · шагов ${g.progress}`).join("\n"));
	}
	if (name === "memory_stats") {
		return text(JSON.stringify({
			db: DB_PATH,
			chunks: store.totalChunks(),
			kinds: Object.fromEntries(store.countsByKind().map((r) => [r.kind, r.n])),
			sessions: store.distinctSessions(),
			goals: store.goalCount(),
			routines: store.routineCount(),
			skills: store.skillCount(),
			stems: idf.map.size,
			associatedTerms: store.assocCount(),
			vectorVersion: Number(store.metaGet("vecver") ?? 0)
		}, null, 2));
	}
	throw new Error(`unknown tool: ${name}`);
}

/* ── JSON-RPC over stdio ───────────────────────────────────────────────── */

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line !== "") handle(line);
	}
});

async function handle(line) {
	let request;
	try { request = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
	const { id, method, params } = request;
	if (id === undefined) return; // notification (initialized, cancelled) — nothing to answer
	try {
		if (method === "initialize") {
			return send({
				jsonrpc: "2.0", id,
				result: {
					protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "dsh-memory-hub", version: "0.3.0" }
				}
			});
		}
		if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
		if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
		if (method === "tools/call") {
			const result = await callTool(String(params?.name ?? ""), params?.arguments ?? {});
			return send({ jsonrpc: "2.0", id, result });
		}
		return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
	} catch (error) {
		return send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(error?.message ?? error) } });
	}
}

process.on("SIGTERM", () => { try { store?.close(); } catch { /* ignore */ } process.exit(0); });
process.on("SIGINT", () => { try { store?.close(); } catch { /* ignore */ } process.exit(0); });
