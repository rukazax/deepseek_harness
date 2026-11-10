/**
 * dsh-memory-hub — shared cross-chat / cross-workspace memory for DeepSeek Harness.
 *
 * Bundled capabilities (no external npm dependencies):
 *  - vector store over node:sqlite: 4096-d hashed TF-IDF vectors + FTS5 lexical channel;
 *    hybrid recall = 0.68·cos + 0.32·coverage + workspace bonus + recency decay;
 *  - ingestion from the `session/event` feed of every session (all chats, workspaces):
 *    user asks, assistant answers, task pairs, noise filtering, self-injection excluded;
 *  - recall injection: a systemPrompt runtime context, bounded to `recallChars`,
 *    rendered only when the current request matches past knowledge (otherwise empty → no tokens);
 *  - routine miner: normalized request templates clustered across sessions; templates
 *    seen 2+ times become routines carrying the last known solution; a fuzzy
 *    word-coverage matcher (exact / prefix≥5 / common root≥4) serves the request;
 *  - style profile: counters over assistant texts (sentences, vocabulary, emoji,
 *    markdown patterns, RU/EN mix) exposed to the model via `memory_style`;
 *  - weekly causal analysis: dependencies, bridges, decisions vs results, current
 *    and unfinished goals, recommendations — into the Vault, the dashboard and
 *    the `memory_analyze` tool; restart-safe via `lastAnalysisAt`, 7-day cadence;
 *  - Obsidian vault sync: Facts/Tasks/Routines notes written automatically, vault
 *    watched for user-authored notes (frontmatter `memory-hub: fact`) and indexed;
 *  - `/api/memory-hub/stats|analysis|run-analysis|run-mining` for the dashboard.
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Loader identity. */
const name = "memory-hub";

/** Optional services: the plugin stays inactive when they are absent. */
const inject = ["systemPrompt", "webServer", "tools"];

/* ── logging + config ──────────────────────────────────────────────────── */

const warned = new Set();
function warn(ctx, message) {
	if (warned.has(message)) return;
	warned.add(message);
	try { ctx.logger?.warn(`memory-hub: ${message}`); } catch { /* silent */ }
}

function homeDir() {
	try {
		if (process.env.DSH_HOME && fs.existsSync(process.env.DSH_HOME)) return process.env.DSH_HOME;
	} catch { /* fall through */ }
	return path.join(os.homedir(), ".dsh");
}

function normalizeConfig(raw) {
	const c = raw && typeof raw === "object" ? raw : {};
	const num = (key, def, min, max) => {
		const v = c[key];
		return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : def;
	};
	return {
		enabled: c.enabled !== false,
		recallChars: Math.round(num("recallChars", 900, 200, 4000)),
		recallLimit: Math.round(num("recallLimit", 3, 1, 8)),
		minRecallScore: num("minRecallScore", 0.32, 0.05, 0.95),
		routineMinScore: num("routineMinScore", 0.45, 0.1, 0.95),
		autoMine: c.autoMine !== false,
		weeklyAnalysis: c.weeklyAnalysis !== false,
		vaultSync: c.vaultSync !== false,
		vaultPath: typeof c.vaultPath === "string" && c.vaultPath.trim().length > 3
			? path.resolve(c.vaultPath)
			: path.join(homeDir(), "obsidian", "vault"),
		dbPath: typeof c.dbPath === "string" && c.dbPath.trim().length > 3
			? path.resolve(c.dbPath)
			: path.join(homeDir(), "memory", "ctxdb.sqlite")
	};
}

/* ── text math ─────────────────────────────────────────────────────────── */

const VECTOR_DIM = 4096;

function fnv1a(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i += 1) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h % VECTOR_DIM;
}

/** Lowercase words (keep numbers, drop 1-2 char words) plus 4-char root aliases. */
function wordsOf(text) {
	const out = [];
	for (const raw of String(text).match(/[0-9]*[A-Za-zА-ЯЁа-яё][0-9A-Za-zА-ЯЁа-яё_\-\u0400-\u04FF]*/g) ?? []) {
		const w = raw.toLowerCase();
		if (w.length < 3 && !/^[0-9]/.test(w)) continue;
		out.push(w);
		if (w.length >= 6) out.push(`~${w.slice(0, 4)}`);
	}
	return out;
}

/** Routine template: collapse digits/paths/URLs/quotes, lowercase, keep order. */
function templateKey(text) {
	const t = String(text)
		.replace(/<\w+\b[^>]*>[\w\W]*?<\/\w+>/g, " ")
		.replace(/</g, " ")
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " url ")
		.replace(/[A-Za-z]:[\\/][^\s"'`]+/g, " path ")
		.replace(/\d+(?:\.\d+)*/g, " n ")
		.replace(/["'`«»()\[\]{}]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return wordsOf(t).join(" ");
}

/** Sparse hashed TF-IDF vector (L2-normalized) as a Map(index → weight). */
function embed(text, idf) {
	const tf = new Map();
	for (const w of wordsOf(text)) if (w.length >= 3) tf.set(w, (tf.get(w) ?? 0) + 1);
	const vec = new Map();
	for (const [w, count] of tf) {
		const df = idf.map.get(w);
		const idfWeight = df === undefined ? 1.8 : Math.log(1 + idf.docCount / (1 + df));
		const weight = (1 + Math.log(count)) * idfWeight;
		const idx = fnv1a(w);
		vec.set(idx, (vec.get(idx) ?? 0) + weight);
	}
	let norm = 0;
	for (const weight of vec.values()) norm += weight * weight;
	norm = Math.sqrt(norm) || 1;
	for (const [idx, weight] of vec) vec.set(idx, weight / norm);
	return vec;
}

function cosine(a, b) {
	if (a.size > b.size) [a, b] = [b, a];
	let acc = 0;
	for (const [idx, weight] of a) {
		const other = b.get(idx);
		if (other !== undefined) acc += weight * other;
	}
	return acc;
}

/** Fuzzy word coverage: exact match, 5-char prefix, or 4-char common root. */
function coverage(query, candidate) {
	const qw = wordsOf(query).filter((w) => w.length >= 4 && !w.startsWith("~"));
	if (qw.length === 0 || candidate === undefined) return 0;
	const cw = wordsOf(candidate);
	const index = new Set();
	for (const w of cw) {
		index.add(w);
		if (w.length >= 5) index.add(`p:${w.slice(0, 5)}`);
		if (w.length >= 4) index.add(`r:${w.slice(0, 4)}`);
	}
	let hits = 0;
	for (const w of qw) {
		if (index.has(w) || index.has(`p:${w}`) || index.has(`r:${w.slice(0, 4)}`)) hits += 1;
	}
	return hits / Math.max(1, Math.min(qw.length, 24));
}

function sha256(text) {
	return createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 32);
}

function clip(text, max) {
	const t = String(text).replace(/\s+/g, " ").trim();
	return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`;
}

/* ── store over node:sqlite ────────────────────────────────────────────── */

class MemoryStore {
	constructor(file, warnFn) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		this.db = new DatabaseSync(file);
		this.warn = warnFn;
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS chunks (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				text TEXT NOT NULL,
				project TEXT NOT NULL DEFAULT '',
				session_id TEXT NOT NULL DEFAULT '',
				turn INTEGER NOT NULL DEFAULT 0,
				ts INTEGER NOT NULL,
				vec TEXT NOT NULL DEFAULT '[]',
				hits INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS chunks_ts ON chunks(ts);
			CREATE INDEX IF NOT EXISTS chunks_project_ts ON chunks(project, ts);
			CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
			CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
				INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
			END;
			CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
				INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
			END;
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				project TEXT NOT NULL DEFAULT '',
				session_id TEXT NOT NULL DEFAULT '',
				turn INTEGER NOT NULL DEFAULT 0,
				title TEXT NOT NULL DEFAULT '',
				template_key TEXT NOT NULL DEFAULT '',
				solution TEXT,
				started_at INTEGER NOT NULL,
				finished_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS templates (
				key TEXT PRIMARY KEY,
				count INTEGER NOT NULL DEFAULT 1,
				last_sample TEXT NOT NULL DEFAULT '',
				last_solution TEXT,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS routines (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				sample TEXT NOT NULL,
				uses INTEGER NOT NULL DEFAULT 2,
				status TEXT NOT NULL DEFAULT 'auto',
				solution TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
	}

	prepare(sql) { return this.db.prepare(sql); }

	upsertChunk(id, kind, text, project, sessionId, turn, ts, vec) {
		this.db.prepare(`INSERT INTO chunks (id, kind, text, project, session_id, turn, ts, vec)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, vec = excluded.vec`).run(
			id, kind, text, project, sessionId, turn, ts, JSON.stringify(vec)
		);
	}

	deleteChunk(id) { this.db.prepare(`DELETE FROM chunks WHERE id = ?`).run(id); }

	punchHit(id) { this.db.prepare(`UPDATE chunks SET hits = hits + 1 WHERE id = ?`).run(id); }

	metaGet(key) { return this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key)?.value; }

	metaPut(key, value) {
		this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
	}

	readIdf() {
		const raw = this.metaGet("idf");
		return raw === undefined || raw === "" ? { map: new Map(), docCount: 1 } : { map: new Map(Object.entries(JSON.parse(raw))), docCount: raw ? JSON.parse(raw).docCount ?? 1 : 1 };
	}

	writeIdf(idfDoc) {
		this.metaPut("idf", JSON.stringify({ docCount: idfDoc.docCount, df: idfDoc.df }));
	}

	candidates(kinds, recentLimit, project) {
		const rows = kinds.length === 0
			? this.db.prepare(`SELECT id, kind, text, project, session_id, vec, ts FROM chunks ORDER BY ts DESC LIMIT ?`).all(recentLimit)
			: this.db.prepare(`SELECT id, kind, text, project, session_id, vec, ts FROM chunks WHERE kind IN (${kinds.map(() => "?").join(",")}) ORDER BY ts DESC LIMIT ?`).all(...kinds, recentLimit);
		if (project !== "") {
			const own = kinds.length === 0
				? this.db.prepare(`SELECT id, kind, text, project, session_id, vec, ts FROM chunks WHERE project = ? ORDER BY ts DESC LIMIT ?`).all(project, recentLimit)
				: this.db.prepare(`SELECT id, kind, text, project, session_id, vec, ts FROM chunks WHERE project = ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY ts DESC LIMIT ?`).all(project, ...kinds, recentLimit);
			rows.push(...own);
		}
		return rows;
	}

	countsByKind() { return this.db.prepare(`SELECT kind, COUNT(*) AS n FROM chunks GROUP BY kind ORDER BY n DESC`).all(); }
	totalChunks() { return this.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get()?.n ?? 0; }
	distinctSessions() { return this.db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM chunks WHERE session_id <> ''`).get()?.n ?? 0; }
	hotTerms(limit) {
		const raw = this.idfFromMeta();
		return Object.entries(raw.df ?? {}).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([term, n]) => ({ term, n }));
	}

	idfFromMeta() {
		const raw = this.metaGet("idf");
		if (!raw) return {};
		try { return JSON.parse(raw); } catch { return {}; }
	}

	/* tasks */
	taskUpsert(id, project, sessionId, turn, title, templateKey2, solution, startedAt, finishedAt) {
		this.db.prepare(`INSERT INTO tasks (id, project, session_id, turn, title, template_key, solution, started_at, finished_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				title = excluded.title,
				solution = COALESCE(tasks.solution, excluded.solution),
				finished_at = COALESCE(tasks.finished_at, excluded.finished_at)`).run(
			id, project, sessionId, turn, title, templateKey2, solution, startedAt, finishedAt
		);
	}

	unfinishedTasks(limit) {
		return this.db.prepare(`SELECT project, session_id, turn, title, started_at FROM tasks WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT ?`).all(limit);
	}

	recentTasks(limit) {
		return this.db.prepare(`SELECT project, title, solution, finished_at, started_at FROM tasks ORDER BY COALESCE(finished_at, started_at) DESC LIMIT ?`).all(limit);
	}

	/* templates + routines */
	templateUpsert(key, sample, solution, ts) {
		this.db.prepare(`INSERT INTO templates (key, count, last_sample, last_solution, updated_at)
			VALUES (?, 1, ?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET
				count = count + 1,
				last_sample = excluded.last_sample,
				last_solution = COALESCE(excluded.last_solution, templates.last_solution),
				updated_at = excluded.updated_at`).run(key, sample, solution, ts);
	}

	templatesEligible(minCount) {
		return this.db.prepare(`SELECT key, count, last_sample, last_solution FROM templates WHERE count >= ? ORDER BY count DESC, updated_at DESC LIMIT 200`).all(minCount);
	}

	routineUpsert(id, nameV, sample, uses, status, solution, ts) {
		this.db.prepare(`INSERT INTO routines (id, name, sample, uses, status, solution, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				name = excluded.name,
				sample = excluded.sample,
				uses = max(routines.uses, excluded.uses),
				solution = COALESCE(excluded.solution, routines.solution),
				updated_at = excluded.updated_at`).run(id, nameV, sample, uses, status, solution, ts, ts);
	}

	routineById(id) { return this.db.prepare(`SELECT * FROM routines WHERE id = ?`).get(id); }
	routineList(limit) { return this.db.prepare(`SELECT * FROM routines ORDER BY uses DESC, updated_at DESC LIMIT ?`).all(limit); }
	routineCount() { return this.db.prepare(`SELECT COUNT(*) AS n FROM routines`).get()?.n ?? 0; }
	routineApprove(id) { this.db.prepare(`UPDATE routines SET status = 'approved', updated_at = ? WHERE id = ?`).run(Date.now(), id); }
	routineForget(id) {
		this.db.prepare(`DELETE FROM routines WHERE id = ?`).run(id);
		this.db.prepare(`DELETE FROM templates WHERE key = ?`).run(id);
	}

	close() { try { this.db.close(); } catch { /* already closed */ } }
}

/* ── style profile ─────────────────────────────────────────────────────── */

function emptyStyle() {
	return { samples: 0, sentences: 0, chars: 0, bullets: 0, headings: 0, emoji: 0, codeBlocks: 0, links: 0, exclam: 0, ruChars: 0, enChars: 0, frequent: {} };
}

function accumulateStyle(state, text) {
	try {
		const t = String(text);
		if (t.length < 40) return;
		state.samples += 1;
		state.chars += t.length;
		state.sentences += t.split(/(?<=[.!?…])\s+/).filter((s) => s.trim().length > 0).length;
		state.bullets += (t.match(/(^|\n)\s*(?:[-*•]|\d+\.)\s/g) ?? []).length;
		state.headings += (t.match(/(^|\n)#{1,4}\s/g) ?? []).length;
		state.emoji += (t.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? []).length;
		state.codeBlocks += Math.floor((t.match(/```/g) ?? []).length / 2);
		state.links += (t.match(/\[[^\]]+\]\(/g) ?? []).length;
		state.exclam += (t.match(/[!?]{2,}|✅|⚠️|→/g) ?? []).length;
		state.ruChars += (t.match(/[А-Яа-яЁё]/g) ?? []).length;
		state.enChars += (t.match(/[A-Za-z]/g) ?? []).length;
		for (const w of wordsOf(t)) {
			if (w.startsWith("~") || w.length < 5) continue;
			state.frequent[w] = (state.frequent[w] ?? 0) + 1;
		}
		if (Object.keys(state.frequent).length > 400) {
			state.frequent = Object.fromEntries(Object.entries(state.frequent).sort((a, b) => b[1] - a[1]).slice(0, 300));
		}
	} catch { /* style folding must never break ingestion */ }
}

function styleProfileText(s) {
	if (!s || s.samples === 0) return "Профиль стиля пока пуст: ещё нет длинных ответов автора в базе.";
	const avgSentence = s.sentences > 0 ? Math.round(s.chars / s.sentences) : 120;
	const ru = s.ruChars + s.enChars > 0 ? Math.round((100 * s.ruChars) / (s.ruChars + s.enChars)) : 100;
	const emojiRate = (s.emoji / Math.max(1, s.samples)).toFixed(2);
	const top = Object.entries(s.frequent).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w);
	return [
		`Профиль стиля (по ${s.samples} ответам автора из всех чатов):`,
		`— средняя длина предложения ≈ ${avgSentence} символов;`,
		`— русский ${ru}% / английский ${100 - ru}%;`,
		`— эмодзи ≈ ${emojiRate} на один ответ (умеренно);`,
		`— маркдаун-патерны: пункты ${s.bullets}, заголовки ${s.headings}, блоки кода ${s.codeBlocks}, ссылки ${s.links};`,
		`— характерные слова: ${top.join(", ") || "—"}.`,
		"Правило: статьи, посты и развёрнутые ответы оформлять в этом же стиле — деловой тон,",
		"структура (заголовки/таблицы/пункты), двуязычные заголовки RU/EN, эмодзи только в навигации."
	].join("\n");
}

/* ── obsidian vault ────────────────────────────────────────────────────── */

function vaultEnsure(dir, warnFn) {
	try {
		for (const sub of ["Facts", "Tasks", "Routines", "Аналитика", "Стиль"]) {
			fs.mkdirSync(path.join(dir, sub), { recursive: true });
		}
		const hub = path.join(dir, "Memory Hub.md");
		if (!fs.existsSync(hub)) fs.writeFileSync(hub, [
			"---",
			"type: hub",
			"---",
			"# Memory Hub · общая память DSH",
			"",
			"Обновляется плагином **dsh-memory-hub** автоматически:",
			"- `Facts/` — выученные факты и решения;",
			"- `Tasks/` — кэш выполненных задач (одна заметка — один ход);",
			"- `Routines/` — авто-рутины из повторяющихся запросов;",
			"- `Аналитика/` — недельные причинно-следственные отчёты;",
			"- `Стиль/` — профиль вашего стиля изложения.",
			"",
			"Свои заметки индексируются автоматически, если в первых строках стоит front-matter `memory-hub: fact`.",
			""
		].join("\n"), "utf8");
		return true;
	} catch (error) {
		warnFn?.(`vault unavailable: ${String(error)}`);
		return false;
	}
}

function vaultWrite(dir, sub, base, body) {
	try {
		fs.mkdirSync(path.join(dir, sub), { recursive: true });
		fs.writeFileSync(path.join(dir, sub, `${base}.md`), body, "utf8");
		return true;
	} catch { return false; }
}

function vaultScan(dir) {
	const found = [];
	try {
		const entries = [];
		for (const sub of ["Facts", "Routines", "."]) {
			const base = sub === "." ? dir : path.join(dir, sub);
			if (!fs.existsSync(base)) continue;
			for (const e of fs.readdirSync(base, { withFileTypes: true })) {
				if (e.isFile() && e.name.endsWith(".md")) entries.push(path.join(base, e.name));
			}
		}
		for (const file of entries) {
			try {
				const text = fs.readFileSync(file, "utf8");
				if (text.length < 24) continue;
				const head = text.slice(0, 400);
				const kind = /memory-hub:\s*(fact|routine|note)/.exec(head)?.[1];
				if (kind === undefined) continue;
				found.push({ file, kind, text: text.replace(/^---[\s\S]*?---\s*/, "").trim() });
			} catch { /* unreadable: skip */ }
		}
	} catch { /* vault missing: fine */ }
	return found;
}

/* ── plugin entry ──────────────────────────────────────────────────────── */

function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	if (!config.enabled) return;

	/* store */
	let store;
	try {
		store = new MemoryStore(config.dbPath, (msg) => warn(ctx, msg));
	} catch (error) {
		warn(ctx, `cannot open ${config.dbPath}: ${String(error)}`);
		return;
	}

	let idf;
	try {
		const raw = store.metaGet("idf");
		idf = raw ? JSON.parse(raw).df ?? JSON.parse(raw) : {};
	} catch { idf = {}; }
	let docCount = (() => {
		try {
			const raw = JSON.parse(store.metaGet("idf") ?? "{}");
			return raw.docCount ?? 1;
		} catch { return 1; }
	})();
	const idfView = () => ({ map: new Map(Object.entries(idf)), docCount });
	let idfDirty = 0;

	/* per-session live state (process-local cache; the session log stays the truth) */
	const openTurns = new WeakMap();
	const style = (() => {
		try {
			const raw = store.metaGet("style_stats");
			return raw ? { ...emptyStyle(), ...JSON.parse(raw) } : emptyStyle();
		} catch { return emptyStyle(); }
	})();
	const stats = {
		startedAt: Date.now(),
		lastEventAt: Date.now(),
		injections: Number(store.metaGet("injections") ?? 0),
		injectedChars: Number(store.metaGet("injectedChars") ?? 0),
		routineHits: Number(store.metaGet("routineHits") ?? 0),
		recallHits: Number(store.metaGet("recallHits") ?? 0)
	};

	const disposers = [];

	function trackTerms(text) {
		for (const w of new Set(wordsOf(text))) {
			if (w.length < 3) continue;
			idf[w] = (idf[w] ?? 0) + 1;
		}
		docCount += 1;
		idfDirty += 1;
	}

	let termCache = new Map(Object.entries(idf).map(([k, v]) => [k, v]));
	function idfCurrent() {
		if (termCache.size !== Object.keys(idf).length) termCache = new Map(Object.entries(idf));
		return { map: termCache, docCount };
	}

	function addChunk(kind, text, project, sessionId, turn) {
		try {
			const t = String(text).replace(/\s+/g, " ").trim();
			if (t.length < (kind === "chat_user" ? 12 : 24)) return null;
			const id = sha256(`${kind}|${t.slice(0, 3000)}`);
			store.upsertChunk(id, kind, t, project ?? "", sessionId ?? "", turn ?? 0, Date.now(), [...embed(t, idfCurrent())]);
			trackTerms(t);
			return id;
		} catch (error) {
			warn(ctx, `addChunk failed: ${String(error)}`);
			return null;
		}
	}

	function sessionMeta(session) {
		const cwd = session?.header?.cwd ?? "";
		return { project: cwd ? path.basename(cwd) : "", sessionId: String(session?.id ?? session?.header?.id ?? "") };
	}

	/* ── ingestion ── */
	try {
		ctx.on("session/event", (session, event) => {
			try {
				const data = event?.data ?? {};
				const debug = Number(store.metaGet("mh_events") ?? 0) + 1;
				store.metaPut("mh_events", String(debug));
				try {
					const types = JSON.parse(store.metaGet("mh_types") ?? "{}");
					types[event?.type ?? "?"] = (types[event?.type ?? "?"] ?? 0) + 1;
					types[`src:${data?.source?.kind ?? "?"}`] = (types[`src:${data?.source?.kind ?? "?"}`] ?? 0) + 1;
					store.metaPut("mh_types", JSON.stringify(types));
				} catch { /* debug only */ }
				if (data.source?.kind === "memory-hub") return;
				stats.lastEventAt = Date.now();
				const meta = sessionMeta(session);
				const ts = Number(event.time ?? Date.now());
				const msg = data.message ?? data;
				const msgRole = msg?.role ?? "";
				const srcKind = msg?.source?.kind;
				if (event.type === "user/message" && msgRole === "user" && (srcKind === undefined || srcKind === "user" || srcKind === "goal" || srcKind === "user-rpc")) {
					const text = (msg.content ?? []).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
					if (text.trim().length < 12) return;
					addChunk("chat_user", text, meta.project, meta.sessionId, data.turn ?? 0);
					trackTerms(text);
					const open = openTurns.get(session) ?? { turn: data.turn ?? 0, project: meta.project, sessionId: meta.sessionId, title: "", userText: "", solution: "", startedAt: ts };
					open.turn = data.turn ?? open.turn;
					open.title = open.title ?? clip(text, 160);
					open.userText = clip(text, 1200);
					openTurns.set(session, open);
					if (config.autoMine) store.templateUpsert(templateKey(text), clip(text, 200), null, ts);
					if (idfDirty >= 16) {
						store.writeIdf({ docCount, df: idf });
						idfDirty = 0;
					}
				} else if (event.type === "assistant/message" && msgRole === "assistant") {
					const text = (msg.content ?? []).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
					if (text.trim().length < 40) return;
					accumulateStyle(style, text);
					store.metaPut("style_stats", JSON.stringify(style));
					addChunk("chat_assistant", text, meta.project, meta.sessionId, data.turn ?? 0);
					const open = openTurns.get(session);
					if (open !== undefined) open.solution = text;
				}
			} catch (error) {
				try { store.metaPut("mh_fail", `${new Date().toISOString()} ${String(error?.message ?? error)}`); } catch { /* ignore */ }
				warn(ctx, `ingest failed: ${String(error)}`);
			}
		});

		ctx.on("session/event", (session, event) => {
			if (event?.type !== "turn/end") return;
			try {
				if (idfDirty > 0) { store.writeIdf({ docCount, df: idf }); idfDirty = 0; }
				const open = openTurns.get(session);
				if (open === undefined) return;
				const key = templateKey(open.title || open.userText || "");
				const tokenId = sha256(`${open.sessionId}|${open.turn}|${key}`);
				store.taskUpsert(tokenId, open.project, open.sessionId, open.turn, open.title || clip(open.userText, 120), key, open.solution || null, open.startedAt, Date.now());
				addChunk("task", `${open.title || clip(open.userText, 120)} ${open.solution ? clip(open.solution, 600) : ""}`, open.project, open.sessionId, open.turn);
				openTurns.delete(session);
				if (config.autoMine) runMining(false);
			} catch (error) {
				warn(ctx, `turn folder failed: ${String(error)}`);
			}
		});
	} catch (error) {
		warn(ctx, `session/event registration failed: ${String(error)}`);
	}

	/* ── obsidian vault sync ── */
	if (config.vaultSync) {
		if (vaultEnsure(config.vaultPath, (msg) => warn(ctx, msg))) {
			for (const found of vaultScan(config.vaultPath)) {
				addChunk("doc", found.text, "obsidian", "", 0);
			}
			try {
				let vaultTimer = 0;
				const watcher = fs.watch(config.vaultPath, { recursive: true }, () => {
					clearTimeout(vaultTimer);
					vaultTimer = setTimeout(() => {
						try {
							for (const found of vaultScan(config.vaultPath)) addChunk("doc", found.text, "obsidian", "", 0);
						} catch { /* tick is best-effort */ }
					}, 2500);
				});
				disposers.push(() => { try { watcher.close(); } catch { /* closed */ } clearTimeout(vaultTimer); });
			} catch { /* recursive watch unsupported */ }
		}
	}

	/* ── routine mining ── */
	let lastMiningAt = 0;
	async function runMining(force = false) {
		const now = Date.now();
		if (!force && now - lastMiningAt < 30 * 60 * 1000) return;
		lastMiningAt = now;
		try {
			for (const row of store.templatesEligible(2)) {
				const id = sha256(row.key).slice(0, 12);
				const existing = store.routineById(id);
				const safeName = clip(String(row.last_sample || row.key).replace(/<\w+\b[^>]*>/g, " "), 60).replace(/[\\/:*?"<>|#\[\]{}]/g, "").trim() || id;
				store.routineUpsert(id, safeName, clip(row.last_sample, 200), row.count, existing?.status ?? "auto", row.last_solution ?? existing?.solution ?? null, now);
				if (config.vaultSync) {
					vaultWrite(config.vaultPath, "Routines", safeName, [
						"---", "memory-hub: routine", `id: ${id}`, `uses: ${row.count}`, "---",
						"## Суть", clip(row.last_sample, 160),
						"## Как обычно делалось",
						row.last_solution ? clip(row.last_solution, 900) : "_(решение ещё не зафиксировано)_", ""
					].join("\n"));
				}
			}
			store.metaPut("lastMiningAt", String(now));
		} catch (error) {
			warn(ctx, `mining failed: ${String(error)}`);
		}
	}

	/* ── weekly causal analysis ── */
	function buildAnalysis() {
		const unfinished = store.unfinishedTasks(20);
		const done = store.recentTasks(20).filter((t) => t.finished_at);
		const routines = store.routineList(20);
		const lines = [];
		lines.push(`# Причинно-следственный анализ памяти — ${new Date().toISOString().slice(0, 10)}`);
		lines.push("");
		lines.push(`Объём базы: ${store.totalChunks()} чанков, ${store.distinctSessions()} сессий, ${store.routineCount()} рутин (полная картина — на дашборде).`);
		lines.push("");
		lines.push("## Текущие и незавершённые задачи");
		if (unfinished.length === 0) lines.push("- Незавершённых ходов нет: начатое закрыто ответом.");
		for (const t of unfinished) lines.push(`- [ ] ${clip(t.title, 140)} — workspace \`${t.project}\`, сессия \`${t.session_id.slice(0, 8)}\``);
		lines.push("");
		lines.push("## Недавние результаты (решено)");
		for (const t of done) lines.push(`- ✅ ${clip(t.title, 110)} — ${clip(t.solution ?? "", 130)}`);
		lines.push("");
		lines.push("## Зависимости и связи");
		const hot = store.hotTerms(14).map((r) => r.term);
		lines.push(`Частотный контекст тем: ${hot.join(", ")}.`);
		lines.push("- Мосты «неочевидных связей»: факты из разных workspace, у которых совпадают 2+ корневых слова,");
		lines.push("  — кандидаты на перенос опыта. Ищутся через `memory_search` по меткам workspace.");
		lines.push("- По застрявшим незакрытым ходам различить «выросло в цель» и «остыло»: остывшее — закрыть решением или вычеркнуть.");
		lines.push("");
		lines.push("## Авто-рутины к утверждению");
		const auto = routines.filter((r) => r.status === "auto");
		if (auto.length === 0) lines.push("- Повторов формулировок ≥2 пока нет.");
		for (const r of auto) lines.push(`- ${r.name} (uses ${r.uses}) — ${clip(r.sample, 110)}`);
		lines.push("");
		lines.push("## Рекомендации");
		lines.push(`- ${unfinished.length > 0
			? `Приоритет: закрыть ${Math.min(unfinished.length, 3)} незавершённые задачи — каждый открытый ход тормозит продвижение к целям.`
			: "Блокеров нет — следующий шаг: выбрать очередную цель из частотных тем или создать новую задачу."}`);
		if (auto.some((r) => r.uses >= 3)) lines.push("- Утвердить рутины с uses≥3 (`memory_routines` → approve): они экономят повторный контекст.");
		if ((style.samples ?? 0) === 0) lines.push("- Профиль стиля пуст: после пары развёрнутых ответов включится оформление «как вы пишете».");
		lines.push("- Сверить цели с воркспейсом: незакрытые задачи другого workspace переносить в текущий только явно.");
		return lines.join("\n");
	}

	function runWeeklyAnalysis(now = Date.now()) {
		try {
			const md = buildAnalysis();
			store.metaPut("lastAnalysisAt", String(now));
			store.metaPut("lastAnalysis", md);
			if (config.vaultSync) vaultWrite(config.vaultPath, "Аналитика", `analysis-${new Date(now).toISOString().slice(0, 10)}`, md);
			return md;
		} catch (error) {
			warn(ctx, `weekly analysis failed: ${String(error)}`);
			return `Анализ недоступен: ${String(error)}`;
		}
	}

	const weeklyTimer = setInterval(() => {
		try {
			if (!config.weeklyAnalysis) return;
			const last = Number(store.metaGet("lastAnalysisAt") ?? 0);
			if (Date.now() - last >= 7 * 24 * 60 * 60 * 1000) runWeeklyAnalysis();
		} catch { /* never throw from the host timer */ }
	}, 60 * 60 * 1000);
	disposers.push(() => clearInterval(weeklyTimer));

	/* ── recall/matching ── */
	function recallFor(session, query, kinds = []) {
		const project = sessionMeta(session).project;
		const qvec = embed(query, idfCurrent());
		const scored = [];
		const qEcho = String(query).replace(/\s+/g, " ").trim().slice(0, 600);
		for (const cand of store.candidates(kinds, 1600, project)) {
			if (cand.kind === "chat_user" && String(cand.text).replace(/\s+/g, " ").trim().slice(0, 600) === qEcho) continue;
			const candVec = new Map(JSON.parse(cand.vec));
			const cos = cosine(qvec, candVec);
			const cov = coverage(query, cand.text);
			const bonus = project !== "" && cand.project === project ? 0.06 : 0;
			const recency = Math.exp(-Math.max(0, Date.now() - cand.ts) / 86400000 / 45);
			const score = 0.68 * cos + 0.32 * cov + bonus + 0.04 * recency;
			if (score >= config.minRecallScore) scored.push({ ...cand, score, sameProject: cand.project === project });
		}
		scored.sort((a, b) => b.score - a.score);
		const seen = new Set();
		const picks = [];
		for (const item of scored) {
			if (picks.length >= config.recallLimit) break;
			const key = clip(item.text, 72);
			if (seen.has(key)) continue;
			seen.add(key);
			picks.push(item);
		}
		return picks;
	}

	function matchRoutine(query) {
		let best = null;
		let bestScore = 0;
		for (const row of store.routineList(50)) {
			const score = Math.max(coverage(query, row.sample), coverage(query, row.name));
			if (score > bestScore) { best = row; bestScore = score; }
		}
		return bestScore >= config.routineMinScore ? { routine: best, score: bestScore } : null;
	}

	/* ── context injection ── */
	try {
		const disposer = ctx.systemPrompt.context({
			name: "memory-hub:recall",
			order: ctx.systemPrompt.getContextOrder("SUBAGENT_DELEGATION") + 10,
			required: false,
			interpolate: false,
			text: (assemblyContext) => {
				try {
					store.metaPut("mh_recallCalls", String(Number(store.metaGet("mh_recallCalls") ?? 0) + 1));
					const agent = assemblyContext?.agent;
					if (agent === undefined) return "";
					const session = agent.session;
					if (session === undefined) return "";
					const open = openTurns.get(session);
					const query = open?.userText ?? "";
					if (query.trim().length < 12) return "";
					const parts = [];
					const routine = matchRoutine(query);
					if (routine !== null) {
						const r = routine.routine;
						stats.routineHits += 1;
						store.metaPut("routineHits", String(stats.routineHits));
						parts.push([
							`<routine name="${r.name}" uses="${r.uses}" status="${r.status}" score="${routine.score.toFixed(2)}">`,
							`Типовое задание — не разбирай с нуля. Суть: ${clip(r.sample, 160)}.`,
							r.solution ? `Как делалось в прошлый раз: ${clip(r.solution, Math.max(120, Math.floor(config.recallChars * 0.4)))}.` : "Прошлых решений нет — выполни заново.",
							r.status === "auto" ? "Рутина собрана автоматически; при расхождении с реальностью уточни у пользователя." : "Рутина утверждена пользователем.",
							"</routine>"
						].join("\n"));
					}
					const picks = recallFor(session, query);
					if (picks.length > 0) {
						stats.recallHits += 1;
						store.metaPut("recallHits", String(stats.recallHits));
						const perItem = Math.max(90, Math.floor((config.recallChars / Math.max(1, picks.length)) - 30));
						parts.push(picks.map((p) =>
							`• [${p.kind}${p.sameProject ? ", текущий ws" : `, ws ${clip(p.project, 20)}`}] ${clip(p.text, perItem)}`
						).join("\n"));
						for (const p of picks) store.punchHit(p.id);
					}
					if (parts.length === 0) return "";
					stats.injections += 1;
					const block = `Общая память (все чаты и workspace; подробности — tool memory_search):\n${parts.join("\n\n")}`;
					stats.injectedChars += block.length;
					store.metaPut("injections", String(stats.injections));
					store.metaPut("injectedChars", String(stats.injectedChars));
					return clip(block, config.recallChars);
				} catch (error) {
					warn(ctx, `recall failed: ${String(error)}`);
					return "";
				}
			}
		});
		disposers.push(disposer);
	} catch (error) {
		warn(ctx, `context registration failed: ${String(error)}`);
	}

	/* ── small style-hint section ── */
	try {
		disposers.push(ctx.systemPrompt.section({
			name: "memory-hub:style-hint",
			order: ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT") + 50,
			text: "Перед статьями, постами и длинными ответами вызывай memory_style — там выученный профиль стиля автора; оформляй текст в этом стиле."
		}));
	} catch (error) {
		warn(ctx, `style section failed: ${String(error)}`);
	}

	/* ── model tools ── */
	if (ctx.tools?.register !== undefined) {
		const jsonLine = (v) => JSON.stringify(v).replaceAll("<", "\\u003c");

		try {
			disposers.push(ctx.tools.register({
				name: "memory_search",
				description: "Search the shared cross-chat and cross-workspace memory (vector + lexical hybrid): related tasks, facts, chat fragments and routines. Call before redoing known work.",
				parameters: {
					type: "object",
					additionalProperties: false,
					required: ["query"],
					properties: {
						query: { type: "string", description: "What to find" },
						kinds: { type: "array", items: { type: "string", enum: ["chat_user", "chat_assistant", "task", "doc"] }, description: "Limit memory kinds" },
						limit: { type: "integer", description: "Max hits (default 5)" }
					}
				},
				output: {
					schema: { type: "object", additionalProperties: false, required: ["hits", "count"], properties: { hits: { type: "array", items: { type: "string" } }, count: { type: "integer" } } },
					render: (_args, value) => [{ type: "text", text: value.count === 0 ? "Похожего в памяти нет." : value.hits.join("\n") }]
				},
				async execute(args, exec) {
					const session = exec?.agent?.session;
					const all = recallFor(session, args.query, args.kinds ?? []);
					const rows = (all.slice(0, Math.max(1, Math.min(10, args.limit ?? 5))));
					for (const row of rows) store.punchHit(row.id);
					return {
						hits: rows.map((r, i) => `${i + 1}. [${r.kind}${r.sameProject ? ", текущий ws" : `, ws ${clip(r.project, 24)}`}] score ${r.score.toFixed(2)} — ${clip(r.text, 260)}`),
						count: rows.length
					};
				}
			}));

			disposers.push(ctx.tools.register({
				name: "memory_save",
				description: "Save a learned fact, decision or solution into the shared memory (all chats/workspaces) and mirror it into the Obsidian vault.",
				parameters: {
					type: "object",
					additionalProperties: false,
					required: ["kind", "text"],
					properties: {
						kind: { type: "string", enum: ["fact", "note"], description: "fact = durable knowledge; note = free note" },
						text: { type: "string", description: "Self-contained wording of what to remember" },
						tags: { type: "array", items: { type: "string" }, description: "Optional tags" }
					}
				},
				output: {
					schema: { type: "object", additionalProperties: false, required: ["id", "saved"], properties: { id: { type: "string" }, saved: { type: "boolean" } } },
					render: (_args, value) => [{ type: "text", text: value.saved ? `✅ Сохранено в общую память (${value.id})` : "❌ Не сохранено" }]
				},
				async execute(args) {
					const id = addChunk(args.kind === "fact" ? "fact" : "doc", args.text, "agent", "", 0);
					const ok = id !== null;
					if (ok && config.vaultSync) {
						vaultWrite(config.vaultPath, "Facts", `fact-${new Date().toISOString().slice(0, 10)}-${id.slice(0, 6)}`, [
							"---", "memory-hub: fact", `id: ${id}`,
							...(Array.isArray(args.tags) && args.tags.length > 0 ? [`tags: ${args.tags.join(", ")}`] : []),
							"---", args.text
						].join("\n"));
					}
					return { id: id ?? "", saved: ok };
				}
			}));

			disposers.push(ctx.tools.register({
				name: "memory_routines",
				description: "Inspect mined routines (repeated request templates across all chats). approve/forget act on the user-confirmed instruction only.",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						limit: { type: "integer", description: "How many to list (default 10)" },
						approve: { type: "string", description: "Routine id to approve (status → approved)" },
						forget: { type: "string", description: "Routine id to forget" }
					}
				},
				output: {
					schema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
					render: (_args, value) => [{ type: "text", text: value.text }]
				},
				async execute(args) {
					if (args.approve !== undefined) store.routineApprove(args.approve);
					if (args.forget !== undefined) store.routineForget(args.forget);
					await runMining(true);
					const rows = store.routineList(Math.max(1, Math.min(50, args.limit ?? 10)));
					return {
						text: rows.length === 0
							? "Рутин нет: нужны формулировки, повторившиеся 2+ раза."
							: rows.map((r) => `${r.id} · uses ${r.uses} · ${r.status} — ${clip(r.sample, 90)}${r.solution ? ` | last: ${clip(r.solution, 90)}` : ""}`).join("\n")
					};
				}
			}));

			disposers.push(ctx.tools.register({
				name: "memory_analyze",
				description: "Causal analysis over shared memory: dependencies, obvious and non-obvious links, decisions vs results, current and unfinished goals, recommendations. Returns markdown.",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: { deep: { type: "boolean", description: "true = full text for deeper reasoning (default false = short)" } }
				},
				output: {
					schema: { type: "object", additionalProperties: false, required: ["analysis"], properties: { analysis: { type: "string" } } },
					render: (_args, value) => [{ type: "text", text: value.analysis }]
				},
				async execute(args) {
					const md = runWeeklyAnalysis(Date.now());
					return { analysis: args.deep === true ? md : clip(md, 3200) };
				}
			}));

			disposers.push(ctx.tools.register({
				name: "memory_style",
				description: "Return the user's learned writing-style profile (sentence length, vocabulary, emoji rate, markdown patterns, RU/EN mix) accumulated from all chats. Consult before writing articles, posts and long answers.",
				parameters: { type: "object", additionalProperties: false, properties: {} },
				output: {
					schema: { type: "object", additionalProperties: false, required: ["profile"], properties: { profile: { type: "string" } } },
					render: (_args, value) => [{ type: "text", text: value.profile }]
				},
				async execute() {
					return { profile: styleProfileText(style) };
				}
			}));
		} catch (error) {
			warn(ctx, `tools registration failed: ${String(error)}`);
		}
	}

	/* ── dashboard API ── */
	try {
		if (ctx.webServer?.register !== undefined) {
			const json = (res, body) => { res.setHeader("content-type", "application/json; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.end(JSON.stringify(body)); };
			const handler = (make) => (req, res) => { try { json(res, make()); } catch (e) { warn(ctx, String(e)); res.end(JSON.stringify({ error: String(e) })); } };
			disposers.push(ctx.webServer.register({
				kind: "exact",
				path: "/api/memory-hub/stats",
				handler: handler(() => statsPayload())
			}));
			disposers.push(ctx.webServer.register({
				kind: "exact",
				path: "/api/memory-hub/analysis",
				handler: handler(() => ({
					at: Number(store.metaGet("lastAnalysisAt") ?? 0),
					analysis: store.metaGet("lastAnalysis") ?? ""
				})),
			}));
			disposers.push(ctx.webServer.register({
				kind: "exact",
				path: "/api/memory-hub/run-analysis",
				handler: (req, res) => { try { const analysis = runWeeklyAnalysis(); json(res, { ok: true, analysis }); } catch (e) { warn(ctx, String(e)); json(res, { error: String(e) }); } }
			}));
			disposers.push(ctx.webServer.register({
				kind: "exact",
				path: "/api/memory-hub/run-mining",
				handler: async (req, res) => { try { await runMining(true); json(res, { ok: true }); } catch (e) { warn(ctx, String(e)); json(res, { error: String(e) }); } }
			}));
		}
	} catch (error) {
		warn(ctx, `dashboard api failed: ${String(error)}`);
	}

	function statsPayload() {
		const kinds = {};
		for (const row of store.countsByKind()) kinds[row.kind] = row.n;
		return {
			name,
			startedAt: stats.startedAt,
			chunks: store.totalChunks(),
			kinds,
			sessions: store.distinctSessions(),
			routines: store.routineCount(),
			injections: stats.injections,
			injectedChars: stats.injectedChars,
			estimatedTokensSaved: Math.round(stats.injectedChars * 0.26),
			routineHits: stats.routineHits,
			recallHits: stats.recallHits,
			lastEventAt: stats.lastEventAt,
			lastAnalysisAt: Number(store.metaGet("lastAnalysisAt") ?? 0),
			lastMiningAt: Number(store.metaGet("lastMiningAt") ?? 0),
			vault: { path: config.vaultPath, ok: config.vaultSync ? fs.existsSync(config.vaultPath) : false },
			styleSamples: style.samples ?? 0,
			hotTerms: store.hotTerms(10)
		};
	}

	/* ── warm-up + lifecycle ── */
	const warmTimer = setTimeout(() => {
		runMining(true).finally(() => {
			const last = Number(store.metaGet("lastAnalysisAt") ?? 0);
			if (config.weeklyAnalysis && Date.now() - last >= 7 * 24 * 60 * 60 * 1000) runWeeklyAnalysis();
		});
	}, 4000);
	disposers.push(() => clearTimeout(warmTimer));

	ctx.effect?.(() => () => {
		for (const disposer of disposers) {
			try { disposer(); } catch { /* teardown continues */ }
		}
		store.close();
	});
}

/* ── helpers kept top-level ────────────────────────────────────────────── */

const Config = undefined;
export { name, Config, inject, apply };


