#!/usr/bin/env node
/**
 * memory-eval.mjs — offline retrieval evaluation for dsh-memory-hub, zero tokens.
 *
 * The point of a separate harness (the nightly tuner already mines labels) is a
 * TIME-SPLIT evaluation: a query is scored only against chunks that existed
 * BEFORE it, so the measurement cannot peek at its own future. Everything is
 * derived from the store itself, no LLM and no hand-written gold set required
 * (an optional gold file can be layered on top).
 *
 *   node tools/memory-eval.mjs                      # measure the live config
 *   node tools/memory-eval.mjs --native             # same, but expand via mh_terms
 *   node tools/memory-eval.mjs --gold my.jsonl      # add hand labels
 *   PLUGIN=/tmp/other.mjs node tools/memory-eval.mjs
 *
 * Output: a human summary on stderr and one JSON document on stdout.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d = "") => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const DB_PATH = arg("db", process.env.MEMORY_HUB_DB ?? path.join("/srv/apps/dsh/memory", "ctxdb.sqlite"));
const PLUGIN = arg("plugin", process.env.PLUGIN ?? new URL("../index.js", import.meta.url).pathname);
const OUT = arg("out", "");
const SAMPLE = Number(arg("sample", "120"));
const MIN_JACCARD = Number(arg("min-jaccard", "0.34"));
const MAX_UNRELATED = Number(arg("max-unrelated", "0.10"));
const MODE = flag("legacy") ? "legacy" : "native";

const log = (...a) => process.stderr.write(`${a.join(" ")}\n`);

/* ── label tokens: independent of the plugin version, so labels stay fixed
      across scoring changes (a label must not move when the tokenizer moves). */

const STOP = new Set(("и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне " +
	"было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь " +
	"опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб " +
	"без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один " +
	"почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над " +
	"больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда " +
	"лучше чуть том нельзя такой им более всегда конечно всю между это the a an and or of to in for on with at by " +
	"from is are was were be been it this that these those as but not no if then so we you they i he she do does " +
	"did have has had can could would should will just about into over after before than more most some any all").split(/\s+/));

function labelTokens(text) {
	const out = new Set();
	for (const raw of String(text).toLowerCase().match(/[0-9]*[a-zа-яё][0-9a-zа-яё_\-]*/g) ?? []) {
		if (raw.length < 4 || STOP.has(raw)) continue;
		out.add(raw.length > 6 ? raw.slice(0, 6) : raw);
	}
	return out;
}

function jaccard(a, b) {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter += 1;
	return inter / (a.size + b.size - inter);
}

/* ── store (read-only) ─────────────────────────────────────────────────── */

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const metaRow = (k) => db.prepare("SELECT value FROM meta WHERE key = ?").get(k)?.value;

let idfRaw = {};
try { idfRaw = JSON.parse(metaRow("idf") ?? "{}"); } catch { idfRaw = {}; }
const idf = { map: new Map(Object.entries(idfRaw.df ?? {})), docCount: Number(idfRaw.docCount ?? 0) };

const rows = db.prepare("SELECT id, kind, text, project, session_id, turn, ts, vec FROM chunks ORDER BY ts ASC").all();
const chunks = rows.map((r) => ({
	id: String(r.id),
	kind: String(r.kind),
	text: String(r.text),
	project: String(r.project ?? ""),
	session: String(r.session_id ?? ""),
	turn: Number(r.turn ?? 0),
	ts: Number(r.ts ?? 0),
	vec: new Map(JSON.parse(String(r.vec || "[]"))),
	tokens: labelTokens(r.text)
}));
log(`store: ${chunks.length} chunks, ${idf.map.size} idf terms, docCount ${idf.docCount}`);

/* ── optional association table (native mode) ──────────────────────────── */

let assoc = new Map();
try {
	for (const r of db.prepare("SELECT term, neighbors FROM mh_terms").all()) {
		try { assoc.set(String(r.term), JSON.parse(String(r.neighbors))); } catch { /* skip bad row */ }
	}
} catch { /* table absent: native == lexical */ }
if (MODE === "native" && assoc.size > 0) log(`associations: ${assoc.size} terms`);

/* ── plugin primitives ─────────────────────────────────────────────────── */

const { __test } = await import(PLUGIN);
const { embed, cosine, coverage, clip } = __test;
const buildQuery = __test.buildQuery ?? ((q, idfView) => ({ query: q, vec: embed(q, idfView), terms: [], expanded: q }));
const asMap = (v) => (v instanceof Map ? v : new Map(JSON.parse(String(v || "[]"))));
const scoreCandidate = __test.scoreCandidate ?? ((qc, cand, opts) => {
	const cos = cosine(qc.vec, asMap(cand.vec));
	const cov = coverage(qc.query, cand.text);
	const bonus = opts.project !== "" && cand.project === opts.project ? 0.06 : 0;
	const recency = Math.exp(-Math.max(0, Date.now() - cand.ts) / 86400000 / 45);
	return 0.68 * cos + 0.32 * cov + bonus + 0.04 * recency;
});

/* ── labels ────────────────────────────────────────────────────────────── */

const usable = chunks.filter((c) => c.text.length >= 40 && ["chat_user", "task", "doc", "chat_assistant"].includes(c.kind));
const stride = Math.max(1, Math.floor(usable.length / Math.max(1, SAMPLE)));
const queries = [];
for (let i = 0; i < usable.length && queries.length < SAMPLE; i += stride) queries.push(usable[i]);

const positives = new Map(); // query id -> [chunk ids]
const unrelated = [];
for (const q of queries) {
	const past = [];
	for (const c of chunks) {
		if (c.ts >= q.ts || c.id === q.id) continue;
		const j = jaccard(q.tokens, c.tokens);
		if (j >= MIN_JACCARD) past.push({ id: c.id, j });
	}
	past.sort((a, b) => b.j - a.j);
	if (past.length > 0) positives.set(q.id, past.slice(0, 3).map((p) => p.id));
	else {
		// nothing relevant exists in the past: the memory must stay silent here
		let best = 0;
		for (const c of chunks) if (c.ts < q.ts) best = Math.max(best, jaccard(q.tokens, c.tokens));
		if (best <= MAX_UNRELATED) unrelated.push(q.id);
	}
}

/* ── optional gold labels: {"query": "...", "expect": ["<substring of chunk text>"]} */

const gold = [];
const goldFile = arg("gold", "");
if (goldFile !== "") {
	for (const line of fs.readFileSync(goldFile, "utf8").split("\n")) {
		const t = line.trim();
		if (t === "" || t.startsWith("#")) continue;
		try {
			const rec = JSON.parse(t);
			if (typeof rec.query === "string" && Array.isArray(rec.expect)) gold.push(rec);
		} catch { /* skip malformed line */ }
	}
	log(`gold: ${gold.length} hand-labelled queries`);
}

/* ── time-split scoring ────────────────────────────────────────────────── */

const LIVE = (() => {
	try {
		const p = "/srv/apps/dsh/dsh-home/profiles/web/cordis.patch.yml";
		const text = fs.readFileSync(p, "utf8");
		const block = /- id: memory-hub[\s\S]*?(?=\n- id:|\n*$)/.exec(text)?.[0] ?? "";
		const num = (k, d) => {
			const m = new RegExp(`${k}:\\s*([0-9.]+)`).exec(block);
			return m ? Number(m[1]) : d;
		};
		return { minRecallScore: num("minRecallScore", 0.32), recallLimit: Math.round(num("recallLimit", 3)), recallChars: Math.round(num("recallChars", 900)) };
	} catch { return { minRecallScore: 0.32, recallLimit: 3, recallChars: 900 }; }
})();

const t0 = Date.now();
const perQuery = [];
for (const q of queries) {
	const qc = buildQuery(q.text, idf, assoc);
	const opts = { project: q.project, minRecallScore: LIVE.minRecallScore, recallLimit: LIVE.recallLimit };
	const scored = [];
	for (const c of chunks) {
		if (c.ts >= q.ts || c.id === q.id) continue;
		scored.push({ id: c.id, score: scoreCandidate(qc, c, opts) });
	}
	scored.sort((a, b) => b.score - a.score);
	const pos = new Set(positives.get(q.id) ?? []);
	const rank = (() => {
		for (let i = 0; i < scored.length; i += 1) if (pos.has(scored[i].id)) return i + 1;
		return 0;
	})();
	perQuery.push({
		id: q.id,
		rank,
		top1: scored[0]?.score ?? 0,
		positiveCount: pos.size,
		injected: (scored[0]?.score ?? 0) >= LIVE.minRecallScore,
		labelled: pos.size > 0,
		top1IsPositive: rank === 1,
		unrelated: unrelated.includes(q.id)
	});
}
const elapsed = Date.now() - t0;

/* ── metrics ───────────────────────────────────────────────────────────── */

const labelled = perQuery.filter((r) => r.labelled);
const rr = labelled.length > 0 ? labelled.reduce((a, r) => a + (r.rank > 0 ? 1 / r.rank : 0), 0) / labelled.length : 0;
const at = (k) => (labelled.length > 0 ? labelled.filter((r) => r.rank > 0 && r.rank <= k).length / labelled.length : 0);
const neg = perQuery.filter((r) => r.unrelated);
const falseInjection = neg.length > 0 ? neg.filter((r) => r.injected).length / neg.length : 0;
const all = perQuery;
const injectionRate = all.length > 0 ? all.filter((r) => r.injected).length / all.length : 0;

/* ── gold probes: a human-chosen query → a substring the hit must contain,
      scored over the WHOLE store (no time split, this is a usability probe) */

const goldResults = [];
if (gold.length > 0) {
	const searchMemory = __test.searchMemory;
	const cfg = __test.normalizeConfig({ minRecallScore: 0, recallLimit: 5, candidateLimit: 800 });
	const store = new __test.MemoryStore(DB_PATH, (message) => log(message));
	for (const record of gold) {
		const result = searchMemory(store, String(record.query), {
			config: cfg,
			limit: 5,
			minScore: 0,
			idf,
			assoc
		});
		const wanted = record.expect.map(String);
		const rank = (() => {
			for (let i = 0; i < result.picks.length; i += 1) {
				const body = String(result.picks[i].text).toLowerCase();
				if (wanted.some((needle) => body.includes(needle.toLowerCase()))) return i + 1;
			}
			return 0;
		})();
		goldResults.push({ query: record.query, rank, expected: wanted.slice(0, 2) });
	}
	store.close();
}

/* ── threshold grid: what firing the memory at level t would cost and buy ── */

const grid = [];
if (flag("grid")) {
	for (let t = 0.40; t <= 0.8601; t += 0.02) {
		const level = Number(t.toFixed(2));
		const fired = perQuery.filter((r) => r.top1 >= level);
		const firedPos = fired.filter((r) => r.top1IsPositive).length;
		const unrelFired = fired.filter((r) => r.unrelated).length;
		grid.push({
			threshold: level,
			fireRate: Number((fired.length / Math.max(1, perQuery.length)).toFixed(3)),
			precisionWhenFired: Number((firedPos / Math.max(1, fired.length)).toFixed(3)),
			recallWhenFired: Number((firedPos / Math.max(1, labelled.length)).toFixed(3)),
			falseFireRate: Number((unrelFired / Math.max(1, neg.length)).toFixed(3))
		});
	}
}

const report = {
	at: new Date().toISOString(),
	mode: MODE,
	db: DB_PATH,
	plugin: PLUGIN,
	store: { chunks: chunks.length, idfTerms: idf.map.size, docCount: idf.docCount, associations: assoc.size },
	labels: { queries: queries.length, labelled: labelled.length, unrelated: neg.length, gold: gold.length },
	config: LIVE,
	gold: goldResults.length > 0 ? {
		queries: goldResults.length,
		hitAt5: Number((goldResults.filter((r) => r.rank > 0).length / goldResults.length).toFixed(3)),
		details: goldResults
	} : undefined,
	metrics: {
		recallAt1: Number(at(1).toFixed(3)),
		recallAt3: Number(at(3).toFixed(3)),
		recallAt5: Number(at(5).toFixed(3)),
		mrr: Number(rr.toFixed(3)),
		falseInjection: Number(falseInjection.toFixed(3)),
		injectionRate: Number(injectionRate.toFixed(3)),
		avgTop1: Number((all.reduce((a, r) => a + r.top1, 0) / Math.max(1, all.length)).toFixed(3)),
		msPerQuery: Number((elapsed / Math.max(1, all.length)).toFixed(1))
	},
	grid: grid.length > 0 ? grid : undefined,
	worst: labelled.filter((r) => r.rank === 0).slice(0, 8)
};

log(`mode=${MODE} recall@1=${report.metrics.recallAt1} recall@3=${report.metrics.recallAt3} ` +
	`recall@5=${report.metrics.recallAt5} mrr=${report.metrics.mrr} ` +
	`false-injection=${report.metrics.falseInjection} injection=${report.metrics.injectionRate} ` +
	`ms/query=${report.metrics.msPerQuery}`);

if (OUT !== "") {
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.appendFileSync(OUT, `${JSON.stringify(report)}\n`);
	log(`appended to ${OUT}`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
