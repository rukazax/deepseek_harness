#!/usr/bin/env node
/**
 * memory-backfill.mjs — rebuild dsh-memory-hub from every session log on disk.
 *
 * The plugin only ingests live `session/event`s, so anything written before the
 * plugin was installed (or while it was off) never reached the store. This tool
 * replays the on-disk session logs through the plugin's own rules and then
 * recomputes every derived table, which makes the result bit-for-bit consistent
 * no matter how many times it runs.
 *
 * What it does:
 *   1. finds every session.v4.jsonl.zstd under all workspaces;
 *   2. deletes the derived rows of THOSE sessions only (chunks of
 *      chat_user/chat_assistant/task, tasks, mh_steps, mh_sessions, mh_goals,
 *      mh_skills) — knowledge from sessions whose log is gone is never touched;
 *   3. replays the logs with the plugin's own rules and thresholds:
 *        user/message      (role user, text >= 12)   -> chunk + template
 *        assistant/message (role assistant, >= 40)   -> chunk + style counters
 *        turn/end                                    -> task row + task chunk +
 *                                                       session summary + goal
 *                                                       progress + skill
 *        tool/call | tool/result                     -> mh_steps row
 *   4. rebuilds templates from the whole corpus (all chat_user chunks + task
 *      solutions), so counts are exact instead of incremented twice;
 *   5. rebuilds the style profile from all assistant chunks;
 *   6. rebuilds the IDF table over the whole corpus and re-embeds EVERY chunk
 *      with it — a mixed-scale index silently destroys recall quality;
 *   7. re-mines routines from the rebuilt templates.
 *
 * Chunk ids are sha256(kind|text), exactly like the plugin, so duplicates are
 * impossible by construction: the same text re-imports onto itself.
 *
 * Usage:
 *   node memory-backfill.mjs            # dry run on a throwaway copy of the DB
 *   node memory-backfill.mjs --apply    # write to the live store
 *   node memory-backfill.mjs --apply --verbose
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const flag = (name) => argv.includes(`--${name}`);

const APPLY = flag("apply");
const VERBOSE = flag("verbose");
const SESSIONS = arg("sessions", "/srv/apps/dsh/dsh-home/sessions");
const PLUGIN = arg("plugin", "/srv/apps/dsh/dsh-home/profiles/web/node_modules/dsh-memory-hub/index.js");
let DB = arg("db", "/srv/apps/dsh/memory/ctxdb.sqlite");

const { __test } = await import(PLUGIN);
const { MemoryStore, embed, templateKey, clip } = __test;

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const log = (...a) => process.stderr.write(a.join(" ") + "\n");

/* wordsOf() is the plugin's tokenizer; it is not exported, so mirror it here.
   Vectors and the IDF table have to agree with the plugin exactly. */
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

const emptyStyle = () => ({ samples: 0, sentences: 0, chars: 0, bullets: 0, headings: 0, emoji: 0, codeBlocks: 0, links: 0, exclam: 0, ruChars: 0, enChars: 0, frequent: {} });

function accumulateStyle(state, text) {
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
}

/* ── dry run works on a copy: nothing may touch the live store ─────────── */

let DRY_COPY = "";
if (!APPLY) {
	DRY_COPY = path.join(os.tmpdir(), `mh-dry-${process.pid}.sqlite`);
	const src = new DatabaseSync(DB, { readOnly: true });
	src.exec(`VACUUM INTO '${DRY_COPY}'`);
	sync_close(src);
	DB = DRY_COPY;
	log(`dry run on a copy: ${DRY_COPY}`);
}

function sync_close(handle) { try { handle.close(); } catch { /* already closed */ } }

const store = new MemoryStore(DB, (msg) => log(`store warn: ${msg}`));

/* ── session logs ──────────────────────────────────────────────────────── */

function* sessionFiles(root) {
	for (const ws of fs.readdirSync(root)) {
		const wsDir = path.join(root, ws);
		if (!fs.existsSync(wsDir) || !fs.statSync(wsDir).isDirectory()) continue;
		for (const entry of fs.readdirSync(wsDir)) {
			const dir = path.join(wsDir, entry);
			if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
			const file = path.join(dir, "session.v4.jsonl.zstd");
			if (fs.existsSync(file)) yield file;
		}
	}
}

function readSession(file) {
	const res = spawnSync("zstd", ["-dc", file], { maxBuffer: 1024 * 1024 * 512 });
	if (res.status !== 0) return null;
	const out = [];
	for (const line of res.stdout.toString("utf8").split("\n")) {
		if (line.trim() === "") continue;
		try { out.push(JSON.parse(line)); } catch { /* torn last line */ }
	}
	return out;
}

const textOf = (message) => (message?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");

/* ── idf, primed from the store so the first embeds are not naive ──────── */

const idf = {};
let docCount = 1;
{
	const raw = (() => { try { return JSON.parse(store.metaGet("idf") ?? "{}"); } catch { return {}; } })();
	for (const [w, n] of Object.entries(raw.df ?? {})) idf[w] = n;
	docCount = Number(raw.docCount ?? 1);
}
const idfView = () => ({ map: new Map(Object.entries(idf)), docCount });

const counters = { sessions: 0, user: 0, assistant: 0, tasks: 0, steps: 0, summaries: 0, goals: 0, skills: 0, skipped: 0 };
const perWorkspace = new Map();
const wsRow = (project) => {
	const row = perWorkspace.get(project) ?? { sessions: 0, chunks: 0, tasks: 0, steps: 0 };
	perWorkspace.set(project, row);
	return row;
};
const bump = (project, key, n = 1) => { const row = wsRow(project); row[key] = (row[key] ?? 0) + n; };

function addChunk(kind, text, project, sessionId, turn, ts) {
	const t = String(text).replace(/\s+/g, " ").trim();
	if (t.length < (kind === "chat_user" ? 12 : 24)) return null;
	const id = sha256(`${kind}|${t.slice(0, 3000)}`);
	store.upsertChunk(id, kind, t, project ?? "", sessionId ?? "", turn ?? 0, ts, [...embed(t, idfView())]);
	bump(project, "chunks");
	return id;
}

const stepBuf = [];
function flushSteps() {
	if (stepBuf.length === 0) return;
	try { store.stepsAdd(stepBuf.splice(0, stepBuf.length)); } catch (error) { log(`steps flush failed: ${error}`); }
}

/* ── replay one session log ────────────────────────────────────────────── */

function replay(file) {
	const events = readSession(file);
	if (events === null || events.length === 0) return { skipped: true };
	const head = events.find((e) => e.type === "session");
	const project = head?.cwd ? path.basename(head.cwd) : "";
	const sessionId = String(head?.id ?? path.basename(path.dirname(file)));
	let open = null;
	let bootstrapped = false;
	let userCount = 0, assistantCount = 0;

	for (const event of events) {
		const data = event?.data ?? {};
		if (data?.source?.kind === "memory-hub") continue;
		const ts = Number(event.time ?? head?.createdAt ?? Date.now());
		const type = String(event?.type ?? "");

		if (type === "user/message") {
			const msg = data.message ?? data;
			const src = msg?.source?.kind;
			if (msg?.role !== "user") continue;
			if (!(src === undefined || src === "user" || src === "goal" || src === "user-rpc")) continue;
			const text = textOf(msg);
			if (text.trim().length < 12) continue;
			addChunk("chat_user", text, project, sessionId, data.turn ?? 0, ts);
			userCount += 1;
			counters.user += 1;
			store.templateUpsert(templateKey(text), clip(text, 200), null, ts);
			open = { turn: data.turn ?? open?.turn ?? 0, title: clip(text, 160), userText: clip(text, 1200), solution: "", startedAt: open?.startedAt ?? ts };
			// turn/start arrives BEFORE user/message, so the session row and the goal
			// are bootstrapped from the first substantive request instead
			if (!bootstrapped) {
				bootstrapped = true;
				store.sessionTouch(sessionId, project, clip(text, 120), ts);
				if (store.goalActiveSession(sessionId) === undefined) {
					store.goalCreate(sessionId, project, clip(text, 400), [...embed(text, idfView())], ts);
					counters.goals += 1;
				}
			}
		} else if (type === "assistant/message") {
			const msg = data.message ?? data;
			if (msg?.role !== "assistant") continue;
			const text = textOf(msg);
			if (text.trim().length < 40) continue;
			addChunk("chat_assistant", text, project, sessionId, data.turn ?? open?.turn ?? 0, ts);
			assistantCount += 1;
			counters.assistant += 1;
			if (open !== null) open.solution = text;
		} else if (type === "turn/end") {
			if (open === null) continue;
			const key = templateKey(open.title || open.userText || "");
			const tokenId = sha256(`${sessionId}|${open.turn}|${key}`);
			store.taskUpsert(tokenId, project, sessionId, open.turn, open.title || clip(open.userText, 120), key, open.solution || null, open.startedAt, ts);
			addChunk("task", `${open.title || clip(open.userText, 120)} ${open.solution ? clip(open.solution, 600) : ""}`, project, sessionId, open.turn, ts);
			counters.tasks += 1;
			bump(project, "tasks");
			const goal = store.goalActiveSession(sessionId);
			if (goal !== undefined) store.goalBump(goal.id, ts);
			const summary = clip([clip(open.userText, 200), clip(open.solution ?? "", 420)].filter(Boolean).join(" → "), 620);
			if (summary.length >= 40) {
				store.sessionFinalize(sessionId, summary, [...embed(summary, idfView())], ts);
				counters.summaries += 1;
			}
			open = null;
		} else if (type === "tool/call" || type === "tool/result") {
			const toolName = String(data.name ?? data.tool ?? data.call?.name ?? data.toolName ?? "");
			if (type === "tool/result" && toolName === "") continue;
			const rawArgs = data.arguments ?? data.args ?? data.input ?? data.call?.arguments ?? {};
			const cmd = typeof rawArgs?.command === "string" ? rawArgs.command
				: typeof rawArgs?.cmd === "string" ? rawArgs.cmd
					: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
			const body = clip(`${toolName} ${clip(String(cmd ?? ""), 260)}`, 500);
			if (body.trim().length < 4) continue;
			const callId = String(data.callId ?? data.toolCallId ?? data.call?.id ?? "");
			stepBuf.push({
				id: sha256(`${sessionId}|${callId || ts}|${type}|${toolName}`).slice(0, 24),
				sessionId, project,
				turn: open?.turn ?? 0,
				ts,
				kind: /(bash|shell|exec|terminal|run_command|sh)\b/i.test(toolName) ? "command" : "tool",
				name: clip(toolName, 40),
				text: body,
				ok: type === "tool/call" ? 1 : (data.isError === true || data.error !== undefined ? 0 : 1),
				vec: []
			});
			bump(project, "steps");
			counters.steps += 1;
			if (stepBuf.length >= 400) flushSteps();
		}
	}
	flushSteps();
	wsRow(project).sessions += 1;
	counters.sessions += 1;
	return { userCount, assistantCount };
}

/* ── 1. know which sessions the logs cover ─────────────────────────────── */

const files = [...sessionFiles(SESSIONS)];
const sessions = [];
for (const file of files) {
	const head = (() => {
		const res = spawnSync("zstd", ["-dc", file], { maxBuffer: 1024 * 1024 * 8 });
		if (res.status !== 0) return null;
		const line = res.stdout.toString("utf8").split("\n").find((l) => l.trim() !== "");
		try { return JSON.parse(line ?? "{}"); } catch { return null; }
	})();
	sessions.push({ file, id: String(head?.id ?? path.basename(path.dirname(file))), cwd: String(head?.cwd ?? "") });
}
log(`db=${DB}\nsession logs=${sessions.length} apply=${APPLY}`);

/* ── 2. drop the derived rows of exactly those sessions ────────────────── */

const removed = {};
const marks = sessions.map(() => "?").join(",");
const ids = sessions.map((s) => s.id);
if (ids.length > 0) {
	const wipe = (label, sql) => { removed[label] = Number(store.db.prepare(sql).run(...ids).changes ?? 0); };
	// chunks and tasks carry knowledge that may exist ONLY in the store (their
	// session log is gone), so they are never deleted — inserts are idempotent.
	// Steps, session rows and goals are pure projections of the log: rebuilt.
	wipe("steps", `DELETE FROM mh_steps WHERE session_id IN (${marks})`);
	wipe("sessions", `DELETE FROM mh_sessions WHERE session_id IN (${marks})`);
	wipe("goals", `DELETE FROM mh_goals WHERE session_id IN (${marks})`);

}

/* ── 3. replay ─────────────────────────────────────────────────────────── */

for (const { file } of sessions) {
	const res = replay(file);
	if (res?.skipped) { counters.skipped += 1; continue; }
	if (VERBOSE) log(`  ${path.basename(path.dirname(file))}: user=${res.userCount} assistant=${res.assistantCount}`);
}

/* ── 4. templates rebuilt from the whole corpus ────────────────────────── */

function rebuildTemplates() {
	store.db.prepare("DELETE FROM templates").run();
	const insert = store.templateUpsert.bind(store);
	let users = 0;
	for (const row of store.db.prepare("SELECT text, ts FROM chunks WHERE kind = 'chat_user' ORDER BY ts ASC").all()) {
		insert(templateKey(String(row.text)), clip(String(row.text), 200), null, Number(row.ts));
		users += 1;
	}
	let solved = 0;
	for (const row of store.db.prepare("SELECT template_key, title, solution, finished_at FROM tasks WHERE solution IS NOT NULL AND template_key <> '' ORDER BY COALESCE(finished_at, 0) ASC").all()) {
		insert(String(row.template_key), clip(String(row.title ?? ""), 200), String(row.solution), Number(row.finished_at ?? Date.now()));
		solved += 1;
	}
	return { users, solved, templates: store.db.prepare("SELECT COUNT(*) AS n FROM templates").get().n };
}

/* ── 5. style profile from every assistant chunk ───────────────────────── */

function rebuildStyle() {
	const state = emptyStyle();
	for (const row of store.db.prepare("SELECT text FROM chunks WHERE kind = 'chat_assistant'").all()) accumulateStyle(state, String(row.text));
	store.metaPut("style_stats", JSON.stringify(state));
	return { samples: state.samples, chars: state.chars };
}

/* ── 6. one IDF scale for the whole corpus, every vector re-embedded ───── */

function rebuildIndex() {
	const rows = store.db.prepare("SELECT id, text FROM chunks").all();
	const df = new Map();
	for (const row of rows) for (const w of new Set(wordsOf(String(row.text)))) if (w.length >= 3) df.set(w, (df.get(w) ?? 0) + 1);
	const view = { map: df, docCount: rows.length };
	const update = store.db.prepare("UPDATE chunks SET vec = ? WHERE id = ?");
	store.db.exec("BEGIN");
	try {
		for (const row of rows) update.run(JSON.stringify([...embed(String(row.text), view)]), row.id);
		store.db.exec("COMMIT");
	} catch (error) {
		try { store.db.exec("ROLLBACK"); } catch { /* ignore */ }
		throw error;
	}
	store.writeIdf({ docCount: rows.length, df: Object.fromEntries(df) });
	return { terms: df.size, docCount: rows.length };
}

/* ── 7. routines re-mined from the rebuilt templates ───────────────────── */

function mineRoutines() {
	store.db.prepare("DELETE FROM routines").run();
	let made = 0;
	const now = Date.now();
	for (const row of store.templatesEligible(2)) {
		const id = sha256(row.key).slice(0, 12);
		const safeName = clip(String(row.last_sample || row.key).replace(/<\w+\b[^>]*>/g, " "), 60).replace(/[\\/:*?"<>|#\[\]{}]/g, "").trim() || id;
		store.routineUpsert(id, safeName, clip(row.last_sample, 200), row.count, "auto", row.last_solution ?? null, now);
		made += 1;
	}
	store.metaPut("lastMiningAt", String(now));
	return made;
}

function rebuildSkills() {
	store.db.prepare("DELETE FROM mh_skills").run();
	const cmdsOf = store.db.prepare("SELECT text FROM mh_steps WHERE session_id = ? AND kind = 'command' AND ok = 1 ORDER BY ts DESC LIMIT 10");
	let made = 0;
	for (const row of store.db.prepare(`SELECT template_key, project, session_id, title, solution, finished_at
		FROM tasks WHERE solution IS NOT NULL AND length(solution) >= 80
		ORDER BY COALESCE(finished_at, 0) ASC`).all()) {
		const tkey = String(row.template_key ?? "");
		const title = String(row.title ?? "");
		const solution = String(row.solution ?? "");
		if (tkey.length < 8 || title.length < 8) continue;
		const cmds = cmdsOf.all(String(row.session_id ?? "")).map((s) => clip(String(s.text), 160));
		const steps = clip(cmds.length > 0 ? cmds.join("\n") : clip(solution, 420), 700);
		store.skillUpsert(tkey, String(row.project ?? ""), clip(title, 60), clip(title, 200), [...embed(tkey, idfView())], steps, clip(solution, 300), Number(row.finished_at ?? Date.now()));
		made += 1;
	}
	return made;
}

const templates = rebuildTemplates();
const style = rebuildStyle();
const skills = rebuildSkills();
const index = rebuildIndex();
const routinesMined = mineRoutines();

/* ── report ────────────────────────────────────────────────────────────── */

const count = (sql) => Number(store.db.prepare(sql).get().n ?? 0);
const report = {
	applied: APPLY,
	db: DB,
	rebuiltFromLogs: removed,
	replay: counters,
	templates,
	skills,
	style,
	index,
	routinesMined,
	workspaces: [...perWorkspace.entries()].map(([project, row]) => ({ project, ...row })).sort((a, b) => b.chunks - a.chunks),
	store: {
		chunks: count("SELECT COUNT(*) AS n FROM chunks"),
		byKind: store.countsByKind(),
		distinctSessions: store.distinctSessions(),
		tasks: count("SELECT COUNT(*) AS n FROM tasks"),
		templates: count("SELECT COUNT(*) AS n FROM templates"),
		routines: store.routineCount(),
		sessionsMemory: store.sessionCount(),
		goals: count("SELECT COUNT(*) AS n FROM mh_goals"),
		steps: store.stepTotal(),
		skills: store.skillCount(),
		styleSamples: Number(JSON.parse(store.metaGet("style_stats") ?? "{}").samples ?? 0)
	}
};
console.log(JSON.stringify(report, null, 2));
store.close();
if (DRY_COPY !== "") { try { fs.rmSync(DRY_COPY, { force: true }); } catch { /* best effort */ } }
