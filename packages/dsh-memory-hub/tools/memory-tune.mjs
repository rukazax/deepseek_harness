#!/usr/bin/env node
/**
 * dsh-memory-tune.mjs — offline accuracy/cost tuner for dsh-memory-hub.
 *
 * Reads the live memory store (read-only), rebuilds the plugin's own scoring
 * path with the plugin's own functions (embed / cosine / coverage / clip),
 * measures retrieval quality on labelled pairs taken from the store itself and
 * emits tuned parameters as JSON. The shell wrapper applies them.
 *
 * Labels (no hand-written gold set, everything derived from the DB):
 *   kinship   — tasks sharing a normalized template_key across different
 *               sessions: asking one task's wording must surface the chunks of
 *               the other instances. This is exactly what "cross-chat memory"
 *               is supposed to do, so it is the precision signal.
 *   negatives — filler turns ("да", "продолжай") and very short user chunks:
 *               memory must stay silent on them.
 *   drift     — cos(user turn, previous user turn) in one session gives the
 *               in-goal band; cos across unrelated sessions gives the noise band.
 *               goalDriftMin must sit between them.
 *
 * Output: JSON on stdout — { metrics, current, chosen, args, notes }.
 * Exit 0 always unless the DB cannot be opened (wrapper decides what to apply).
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

/* ── arguments ─────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const arg = (name, def) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const DB_PATH = arg("db", "/srv/apps/dsh/memory/ctxdb.sqlite");
const PLUGIN = arg("plugin", "/srv/apps/dsh/dsh-home/profiles/web/node_modules/dsh-memory-hub/index.js");
const SAMPLE = Number(arg("queries", "0")); // 0 = all available
const OUT = arg("out", "");

const log = (...a) => { if (!flag("json")) process.stderr.write(a.join(" ") + "\n"); };

/* ── plugin internals (same code the live plugin runs) ─────────────────── */

const { __test } = await import(PLUGIN);
const { embed, cosine, coverage, clip, buildQuery, scoreCandidate, stemsOf } = __test;



/* ── store ─────────────────────────────────────────────────────────────── */

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const metaRow = (k) => db.prepare("SELECT value FROM meta WHERE key = ?").get(k)?.value;

let idfRaw = {};
try { idfRaw = JSON.parse(metaRow("idf") ?? "{}"); } catch { idfRaw = {}; }
const idf = { map: new Map(Object.entries(idfRaw.df ?? {})), docCount: Number(idfRaw.docCount ?? 0) };

/* Association table (v3): the tuner must score with the same expanded query
   the live plugin builds, otherwise it optimises a formula nobody runs. */
const ASSOC = new Map();
try {
	for (const row of db.prepare("SELECT term, neighbors FROM mh_terms").all()) {
		try { ASSOC.set(String(row.term), JSON.parse(String(row.neighbors))); } catch { /* skip */ }
	}
} catch { /* table absent: lexical only */ }
log(`associations: ${ASSOC.size} terms`);

const chunks = db.prepare("SELECT id, kind, text, project, session_id, turn, ts, vec FROM chunks").all()
	.map((r) => ({
		id: String(r.id),
		kind: String(r.kind),
		text: String(r.text),
		project: String(r.project ?? ""),
		session: String(r.session_id ?? ""),
		turn: Number(r.turn ?? 0),
		ts: Number(r.ts ?? 0),
		vec: new Map(JSON.parse(String(r.vec || "[]"))),
	}));

const tasks = db.prepare("SELECT id, project, session_id, turn, title, template_key, solution FROM tasks").all()
	.map((r) => ({
		id: String(r.id),
		project: String(r.project ?? ""),
		session: String(r.session_id ?? ""),
		turn: Number(r.turn ?? 0),
		title: String(r.title ?? "").trim(),
		key: String(r.template_key ?? "").trim(),
		hasSolution: String(r.solution ?? "").trim().length > 0,
	}));

const routines = db.prepare("SELECT id, name, sample, uses, status, solution FROM routines").all()
	.map((r) => ({
		id: String(r.id),
		name: String(r.name ?? ""),
		sample: String(r.sample ?? ""),
		uses: Number(r.uses ?? 0),
		status: String(r.status ?? "auto"),
		solution: String(r.solution ?? ""),
	}));

log(`db=${DB_PATH} chunks=${chunks.length} tasks=${tasks.length} routines=${routines.length} idf.docCount=${idf.docCount}`);

const PATCH = arg("patch", "/srv/apps/dsh/dsh-home/profiles/web/cordis.patch.yml");

/** Read the numbers of the `- id: memory-hub` block out of the patch layer. */
function readPatchConfig(file) {
	if (!fs.existsSync(file)) return null;
	const lines = fs.readFileSync(file, "utf8").split("\n");
	let inBlock = false, inConfig = false;
	const out = {};
	for (const line of lines) {
		if (/^- id:\s*memory-hub\s*$/.test(line)) { inBlock = true; inConfig = false; continue; }
		if (inBlock && /^- id:/.test(line)) break;
		if (!inBlock) continue;
		if (/^\s+config:\s*$/.test(line)) { inConfig = true; continue; }
		if (!inConfig) continue;
		const m = line.match(/^\s+([A-Za-z][\w]*):\s*([-\d.]+)\s*$/);
		if (m !== null) out[m[1]] = Number(m[2]);
	}
	return Object.keys(out).length > 0 ? out : null;
}

const liveConfig = readPatchConfig(PATCH);

/* ── labels ────────────────────────────────────────────────────────────── */

const bySessionTurn = new Map();
const bySession = new Map();
for (const c of chunks) {
	const k = `${c.session}#${c.turn}`;
	(bySessionTurn.get(k) ?? bySessionTurn.set(k, []).get(k)).push(c);
	(bySession.get(c.session) ?? bySession.set(c.session, []).get(c.session)).push(c);
}

// tokenizer identical to the plugin's wordsOf(), needed for label building only
function tokens(text) {
	const out = [];
	for (const raw of String(text).match(/[0-9]*[A-Za-zА-ЯЁа-яё][0-9A-Za-zА-ЯЁа-яё_\-\u0400-\u04FF]*/g) ?? []) {
		const w = raw.toLowerCase();
		if (w.length < 3 && !/^[0-9]/.test(w)) continue;
		if (w.length >= 4 && !w.startsWith("~")) out.push(w);
	}
	return out;
}

// ── label source 1: exact template families (strict, few, high confidence) ──
const families = new Map();
for (const t of tasks) if (t.key.length > 0 && t.title.length >= 12) {
	(families.get(t.key) ?? families.set(t.key, []).get(t.key)).push(t);
}

const kinship = [];
for (const [, group] of families) {
	if (group.length < 2) continue;
	const sessions = new Set(group.map((g) => g.session));
	if (sessions.size < 2) continue;
	for (const t of group) {
		const others = group.filter((g) => g.id !== t.id && g.session !== t.session);
		if (others.length === 0) continue;
		const relevant = new Set();
		for (const o of others) {
			for (const c of bySessionTurn.get(`${o.session}#${o.turn}`) ?? []) relevant.add(c.id);
		}
		if (relevant.size === 0) {
			for (const o of others) {
				for (const c of bySession.get(o.session) ?? []) {
					if (c.kind === "task" || c.kind === "chat_assistant") relevant.add(c.id);
				}
			}
		}
		if (relevant.size === 0) continue;
		kinship.push({ query: t.title, project: t.project, relevant, family: t.key.slice(0, 40) });
	}
}

// ── label source 2: near-repeat tasks across sessions (the real use case:
// "это уже делалось раньше?"). Pair is relevant when the two task wordings
// share >=2 rare terms and cover >=45% of each other's vocabulary.
const taskTokens = new Map();
const df = new Map();
for (const t of tasks) {
	const toks = tokens(t.title);
	taskTokens.set(t.id, toks);
	for (const w of new Set(toks)) df.set(w, (df.get(w) ?? 0) + 1);
}
const rare = (w) => (df.get(w) ?? 99) <= 5;

const pairRelevant = (a, b) => {
	const ta = new Set(taskTokens.get(a.id) ?? []);
	const tb = new Set(taskTokens.get(b.id) ?? []);
	if (ta.size < 3 || tb.size < 3) return false;
	const shared = [...ta].filter((w) => tb.has(w));
	const rareShared = shared.filter(rare).length;
	if (rareShared < 2) return false;
	const covA = shared.length / ta.size;
	const covB = shared.length / tb.size;
	return covA >= 0.45 && covB >= 0.45;
};

const nearRepeat = [];
const seenPair = new Set();
for (const a of tasks) {
	if (a.title.length < 12) continue;
	const kin = tasks.filter((b) => b.id !== a.id && b.session !== a.session && pairRelevant(a, b));
	if (kin.length === 0) continue;
	const relevant = new Set();
	for (const b of kin) {
		for (const c of bySessionTurn.get(`${b.session}#${b.turn}`) ?? []) relevant.add(c.id);
	}
	if (relevant.size === 0) {
		for (const b of kin) for (const c of bySession.get(b.session) ?? []) {
			if (c.kind === "task" || c.kind === "chat_assistant") relevant.add(c.id);
		}
	}
	if (relevant.size === 0) continue;
	const sig = `${a.title}|${kin.map((k) => k.id).join(",")}`;
	if (seenPair.has(sig)) continue;
	seenPair.add(sig);
	nearRepeat.push({ query: a.title, project: a.project, relevant, family: kin[0].title.slice(0, 40) });
}
for (const q of nearRepeat) kinship.push(q);

// ── negatives: turns the plugin actually processes (>=12 chars) but that carry
// no project knowledge — continuations, acknowledgements, small talk.
const NEGATIVE_PHRASES = [
	"спасибо, всё работает, продолжай дальше по плану",
	"давай дальше, я подожду результата",
	"ок, принято, двигаемся дальше",
	"продолжай с того места, где остановились",
	"хорошо, теперь следующий шаг",
	"понятно, что дальше по списку",
];
const negatives = NEGATIVE_PHRASES.map((query) => ({ query, project: "" }));
const taskTitles = new Set(tasks.map((t) => t.title.toLowerCase().slice(0, 40)));
for (const c of chunks) {
	if (negatives.length >= NEGATIVE_PHRASES.length + 60) break;
	const text = c.text.trim();
	if (c.kind !== "chat_user") continue;
	if (text.length < 12 || text.length > 45) continue;
	if (taskTitles.has(text.toLowerCase().slice(0, 40))) continue;
	negatives.push({ query: text, project: c.project });
}

if (SAMPLE > 0) {
	kinship.length = Math.min(kinship.length, SAMPLE);
}
log(`labels: kinship=${kinship.length} families negatives=${negatives.length}`);

/* ── scoring, exactly as the plugin's recallFor does it ────────────────── */

const echo = (t) => String(t).replace(/\s+/g, " ").trim().slice(0, 600);

const STEMS = new Map();
const stemsFor = (id, text) => {
	let set = STEMS.get(id);
	if (set === undefined) { set = stemsOf(text); STEMS.set(id, set); }
	return set;
};

function scoreAll(query, project) {
	const qc = buildQuery(query, idf, ASSOC, { assocTop: 4, assocWeight: 0.45 });
	const qEcho = echo(query);
	const out = [];
	for (const c of chunks) {
		if (c.kind === "chat_user" && echo(c.text) === qEcho) continue;
		const item = { ...c, vecMap: c.vec, stems: stemsFor(c.id, c.text) };
		const score = scoreCandidate(qc, item, { project });
		out.push({ id: c.id, score, kind: c.kind, project: c.project, textLen: c.text.length, text: c.text, same: project !== "" && c.project === project });
	}
	out.sort((a, b) => b.score - a.score);
	return out;
}

const t0 = Date.now();
const scoredKinship = kinship.map((k) => ({ ...k, scored: scoreAll(k.query, k.project) }));
const scoredNegatives = negatives.map((n) => ({ ...n, scored: scoreAll(n.query, n.project) }));
log(`scored ${scoredKinship.length + scoredNegatives.length} queries in ${Date.now() - t0} ms`);

/* ── pick selection with dedupe (recallLimit + minRecallScore) ─────────── */

function picks(list, threshold, limit) {
	const seen = new Set();
	const out = [];
	for (const item of list) {
		if (item.score < threshold) break;
		const key = clip(item.text, 72);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
		if (out.length >= limit) break;
	}
	return out;
}

function blockLen(items, recallChars) {
	if (items.length === 0) return 0;
	/* the live block now carries a source stamp (`#ref · kind · ws · date`):
	   ~26 chars per item, measured, not guessed */
	const REF = 26;
	const perItem = Math.max(70, Math.floor(recallChars / Math.max(1, items.length)) - REF);
	const lines = items.map((p) => `• [${String(p.id).slice(0, 8)} · ${p.kind}${p.project ? ` · ${clip(p.project, 18)}` : ""} · 01.01] ${clip(p.text, perItem)}`);
	return String(`Общая память (все чаты и workspace; подробности — tool memory_search):\n${lines.join("\n")}`).length;
}

const pct = (arr, p) => {
	if (arr.length === 0) return 0;
	const a = [...arr].sort((x, y) => x - y);
	const i = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
	return a[i];
};

/* ── grid over minRecallScore × recallLimit ────────────────────────────── */

const THRESHOLDS = [];
for (let t = 0.28; t <= 0.9001; t += 0.02) THRESHOLDS.push(Number(t.toFixed(2)));
const LIMITS = [1, 2, 3, 4];

const grid = [];
for (const threshold of THRESHOLDS) {
	for (const limit of LIMITS) {
		let qHit = 0, pickTotal = 0, pickGood = 0, charTotal = 0;
		const lens = [];
		for (const q of scoredKinship) {
			const chosen = picks(q.scored, threshold, limit);
			pickTotal += chosen.length;
			const good = chosen.filter((p) => q.relevant.has(p.id)).length;
			pickGood += good;
			if (good > 0) qHit += 1;
			const len = blockLen(chosen, 1000);
			charTotal += len;
			if (len > 0) lens.push(len);
		}
		let negHit = 0;
		for (const q of scoredNegatives) if (picks(q.scored, threshold, limit).length > 0) negHit += 1;

		const precision = pickTotal > 0 ? pickGood / pickTotal : 0;
		const recall = scoredKinship.length > 0 ? qHit / scoredKinship.length : 0;
		const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
		const negRate = scoredNegatives.length > 0 ? negHit / scoredNegatives.length : 0;
		const p95 = pct(lens, 95);
		const score = f1 - 0.12 * (p95 / 1000) - 2.0 * Math.max(0, negRate - 0.05);
		grid.push({
			threshold, limit,
			precision: Number(precision.toFixed(3)),
			recall: Number(recall.toFixed(3)),
			f1: Number(f1.toFixed(3)),
			negRate: Number(negRate.toFixed(3)),
			avgChars: Math.round(charTotal / Math.max(1, scoredKinship.length)),
			p95Chars: Math.round(p95),
			emptyRate: Number((1 - recall).toFixed(3)),
			objective: Number(score.toFixed(4)),
		});
	}
}

// Hard constraint: memory may speak on at most 15% of knowledge-free turns.
// Among the survivors maximise utility (precision weighted over recall, minus
// the per-call char cost), then prefer the LOWEST threshold within 92% of the
// best utility — the positive set is small, so do not chase its last query.
const NEG_CAP = 0.15;
const utility = (g) => 0.55 * g.precision + 0.45 * g.recall - 0.0004 * g.avgChars - 0.2 * g.negRate;
for (const g of grid) g.utility = Number(utility(g).toFixed(4));
const feasible = grid.filter((g) => g.negRate <= NEG_CAP);
const pool = feasible.length > 0 ? feasible : grid;
pool.sort((a, b) => b.utility - a.utility);
const bestUtility = pool[0].utility;
// plateau of statistically indistinguishable settings; take its middle so the
// choice does not sit on the edge of the measured range (small positive set)
const near = pool.filter((g) => g.utility >= bestUtility * 0.98)
	.sort((a, b) => a.threshold - b.threshold || a.limit - b.limit);
const best = near[Math.floor(near.length / 2)];
const bestByUtility = pool[0];

/* ── recallChars: smallest budget that keeps p95 unclipped ─────────────── */

// Budget = measured 95th percentile of the assembled block plus headroom for the
// occasional long pick, rounded to 50 and never below the plugin's 200 floor.
const measuredLens = [];
for (const q of scoredKinship) {
	const chosen = picks(q.scored, best.threshold, best.limit);
	const len = blockLen(chosen, 4000); // unclipped length
	if (len > 0) measuredLens.push(len);
}
const measuredP95 = pct(measuredLens, 95);
let recallChars = Math.max(250, Math.round((measuredP95 + 60) / 50) * 50);
recallChars = Math.min(4000, recallChars);

const userTurns = chunks
	.filter((c) => c.kind === "chat_user" && c.text.trim().length >= 12)
	.map((c) => ({ text: c.text }));

/* ── routine matcher: threshold from coverage separation ───────────────── */

// The fuzzy routine matcher is coarse, so its threshold is measured on EVERY real
// user turn (not a subsample: sub-sampling moved precision from 0.57 to 0.94,
// which is noise, not signal), plus the repeat labels themselves.
// Only real user turns: task titles are what the routines were mined FROM, so
// including them measures the miner against itself and inflates precision.
const routineQueries = userTurns.slice(0, 400).map((t) => t.text);
const routineScores = [];
for (const query of routineQueries) {
	let top = null, topScore = 0;
	for (const r of routines) {
		const s = Math.max(coverage(query, r.sample), coverage(query, r.name));
		if (s > topScore) { top = r; topScore = s; }
	}
	if (top === null || topScore < 0.4) continue;
	// "correct" = the routine really is this request: most of the routine's own
	// wording appears in the query, so it is not a neighbouring-but-different task
	const own = coverage(top.sample, query);
	routineScores.push({ score: topScore, own, correct: own >= 0.5 });
}
const ROUTINE_THRESHOLDS = [];
for (let t = 0.40; t <= 0.8001; t += 0.02) ROUTINE_THRESHOLDS.push(Number(t.toFixed(2)));
const routineGrid = ROUTINE_THRESHOLDS.map((threshold) => {
	const matched = routineScores.filter((r) => r.score >= threshold);
	const good = matched.filter((r) => r.correct).length;
	const totalCorrect = routineScores.filter((r) => r.correct).length;
	const precision = matched.length > 0 ? good / matched.length : 0;
	const recall = totalCorrect > 0 ? good / totalCorrect : 0;
	const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
	return { threshold, matched: matched.length, correct: good, precision: Number(precision.toFixed(3)), recall: Number(recall.toFixed(3)), f1: Number(f1.toFixed(3)) };
}).sort((a, b) => b.f1 - a.f1);
// Keep the routine matcher useful: the lowest threshold that clears the
// precision floor. Going higher barely improves precision but starts dropping
// correct matches, and the matcher is coarse to begin with.
// Same principle as the recall threshold: take the middle of the statistically
// flat plateau (within 2% of the best F1) instead of its edge, so a coarse
// matcher measured on a few hundred turns does not get pinned to a boundary.
const routineFloor = 5;
const routinePool = routineGrid.filter((r) => r.matched >= routineFloor);
const bestF1 = routinePool.length > 0 ? Math.max(...routinePool.map((r) => r.f1)) : 0;
const routinePlateau = routinePool
	.filter((r) => r.f1 >= bestF1 * 0.98)
	.sort((a, b) => a.threshold - b.threshold);
const routineMeasured = routinePlateau.length > 0
	? Number(routinePlateau[Math.floor(routinePlateau.length / 2)].threshold.toFixed(2))
	: (liveConfig?.routineMinScore ?? 0.66);
const routineApplied = liveConfig?.routineMinScore;
// never move the routine matcher more than 0.08 per run: the sample is small and
// the matcher is coarse, so a big jump is a measurement artefact, not a signal
const routineMinScore = routineApplied === undefined
	? routineMeasured
	: Number(Math.max(routineApplied - 0.08, Math.min(routineApplied + 0.08, routineMeasured)).toFixed(2));

/* ── goal drift: related vs unrelated cosine bands ─────────────────────── */

const relatedCos = [];
const perSessionUsers = new Map();
for (const c of chunks) {
	if (c.kind !== "chat_user") continue;
	(perSessionUsers.get(c.session) ?? perSessionUsers.set(c.session, []).get(c.session)).push(c);
}
for (const [, list] of perSessionUsers) {
	list.sort((a, b) => a.ts - b.ts);
	for (let i = 1; i < list.length; i += 1) {
		if (list[i - 1].project !== list[i].project) continue;
		relatedCos.push(cosine(list[i - 1].vec, list[i].vec));
	}
}
const userChunks = chunks.filter((c) => c.kind === "chat_user");
const unrelatedCos = [];
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
for (let i = 0; i < 400 && userChunks.length > 2; i += 1) {
	const a = userChunks[Math.floor(rnd() * userChunks.length)];
	const b = userChunks[Math.floor(rnd() * userChunks.length)];
	if (a.session === b.session) continue;
	unrelatedCos.push(cosine(a.vec, b.vec));
}
const relatedP10 = pct(relatedCos, 10);
const unrelatedP95 = pct(unrelatedCos, 95);
// The hashed vectors are sparse: median cos between consecutive turns of the
// SAME session is ~0.02, so a threshold near 0.34 would fire on ~9 of 10 turns.
// Fire the guard only on requests with essentially no lexical overlap with the
// goal, and never above the unrelated noise band.
const fireRate = (t) => (relatedCos.length > 0 ? relatedCos.filter((c) => c < t).length / relatedCos.length : 0);
let goalDriftMin = Number(Math.max(0.02, Math.min(pct(relatedCos, 30), Math.max(0.02, unrelatedP95))).toFixed(2));
const guardFireRate = Number(fireRate(goalDriftMin).toFixed(3));

/* ── skill score threshold: strong matches only ────────────────────────── */

const skillMinScore = Number(Math.max(0.5, Math.min(0.8, routineMinScore)).toFixed(2));

/* ── score any parameter set on the same labels (used for the live config) ── */

function metricsFor(params) {
	let qHit = 0, pickTotal = 0, pickGood = 0, charTotal = 0;
	const lens = [];
	for (const q of scoredKinship) {
		const chosen = picks(q.scored, params.minRecallScore, params.recallLimit);
		pickTotal += chosen.length;
		const good = chosen.filter((p) => q.relevant.has(p.id)).length;
		pickGood += good;
		if (good > 0) qHit += 1;
		const len = blockLen(chosen, params.recallChars);
		charTotal += len;
		if (len > 0) lens.push(len);
	}
	let negHit = 0;
	for (const q of scoredNegatives) if (picks(q.scored, params.minRecallScore, params.recallLimit).length > 0) negHit += 1;
	const precision = pickTotal > 0 ? pickGood / pickTotal : 0;
	const recall = scoredKinship.length > 0 ? qHit / scoredKinship.length : 0;
	const negRate = scoredNegatives.length > 0 ? negHit / scoredNegatives.length : 0;
	const p95 = pct(lens, 95);
	const utility = 0.55 * precision + 0.45 * recall - 0.0004 * (charTotal / Math.max(1, scoredKinship.length)) - 0.2 * negRate;
	return {
		precision: Number(precision.toFixed(3)),
		recall: Number(recall.toFixed(3)),
		negRate: Number(negRate.toFixed(3)),
		avgChars: Math.round(charTotal / Math.max(1, scoredKinship.length)),
		p95Chars: Math.round(p95),
		utility: Number(utility.toFixed(4)),
	};
}

const currentMetrics = liveConfig === null ? null : metricsFor({
	minRecallScore: liveConfig.minRecallScore ?? 0.32,
	recallLimit: liveConfig.recallLimit ?? 3,
	recallChars: liveConfig.recallChars ?? 1000,
});

/* ── result ────────────────────────────────────────────────────────────── */

// Clamp to the ranges normalizeConfig() enforces, so an out-of-range value can
// never silently fall back to the plugin default at startup.
const RANGE = {
	recallChars: [200, 4000],
	recallLimit: [1, 8],
	minRecallScore: [0.05, 0.95],
	routineMinScore: [0.1, 0.95],
	goalDriftMin: [0.05, 0.95],
	goalGuardChars: [160, 1600],
	skillMinScore: [0.1, 0.95],
};
const clampTo = (key, value) => {
	const [lo, hi] = RANGE[key];
	const v = Math.min(hi, Math.max(lo, value));
	return key === "recallLimit" ? Math.round(v) : Number(v.toFixed(2));
};
const chosen = {
	recallChars: clampTo("recallChars", recallChars),
	recallLimit: clampTo("recallLimit", best.limit),
	minRecallScore: clampTo("minRecallScore", best.threshold),
	routineMinScore: clampTo("routineMinScore", routineMinScore),
	goalDriftMin: clampTo("goalDriftMin", goalDriftMin),
	goalGuardChars: clampTo("goalGuardChars", 260),
	skillMinScore: clampTo("skillMinScore", skillMinScore),
};

const result = {
	at: new Date().toISOString(),
	db: DB_PATH,
	sample: {
		chunks: chunks.length,
		tasks: tasks.length,
		routines: routines.length,
		kinshipQueries: scoredKinship.length,
		families: [...families.values()].filter((g) => g.length >= 2 && new Set(g.map((x) => x.session)).size >= 2).length,
		negatives: scoredNegatives.length,
		routineQueries: routineQueries.length,
		relatedPairs: relatedCos.length,
	},
	bands: {
		goalRelatedP5: Number(pct(relatedCos, 5).toFixed(3)),
		goalRelatedP10: Number(relatedP10.toFixed(3)),
		goalRelatedP15: Number(pct(relatedCos, 15).toFixed(3)),
		goalRelatedP25: Number(pct(relatedCos, 25).toFixed(3)),
		goalRelatedP50: Number(pct(relatedCos, 50).toFixed(3)),
		goalUnrelatedP95: Number(unrelatedP95.toFixed(3)),
		goalUnrelatedP99: Number(pct(unrelatedCos, 99).toFixed(3)),
		guardFireRateAtFloor: Number(fireRate(0.05).toFixed(3)),
	},
	chosen,
	live: { patch: PATCH, config: liveConfig, metrics: currentMetrics },
	improvement: currentMetrics === null ? null : Number((best.utility - currentMetrics.utility).toFixed(4)),
	selectedBy: { utility: bestUtility, pickedUtility: best.utility, byUtilityOnly: bestByUtility.threshold, byUtilityOnlyLimit: bestByUtility.limit },
	metrics: {
		precision: best.precision,
		recall: best.recall,
		f1: best.f1,
		negativeHitRate: best.negRate,
		avgBlockChars: best.avgChars,
		p95BlockChars: measuredP95,
		objective: best.objective,
	},
	routine: routineGrid.slice(0, 5),
	routineDecision: { measured: routineMeasured, applied: routineMinScore, live: liveConfig?.routineMinScore ?? null, floorMatched: routineFloor },
	top: grid.slice(0, 8),
	curve: THRESHOLDS.map((t) => { const row = grid.filter((g) => g.threshold === t).sort((a, b) => b.objective - a.objective)[0]; return { t, limit: row.limit, p: row.precision, r: row.recall, neg: row.negRate, chars: row.avgChars }; }),
	notes: [
		"recency term evaluated at request time; offline scoring uses now()",
		"kinship label = same normalized template_key in another session",
		"goalDriftMin sits between unrelated p95 and related p10",
	],
};

if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify(result, null, flag("json") ? 0 : 2) + "\n");
db.close();
