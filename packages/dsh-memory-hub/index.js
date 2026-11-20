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
		/* near-miss rescue: 0 disables it (default — no surprise tokens) */
		recallFallbackScore: num("recallFallbackScore", 0, 0, 0.95),
		fallbackChars: Math.round(num("fallbackChars", 160, 80, 600)),
		/* association expansion of the query (locally mined, zero tokens) */
		assocTop: Math.round(num("assocTop", 4, 0, 8)),
		assocMinWeight: num("assocMinWeight", 0.22, 0.05, 1),
		assocWeight: num("assocWeight", 0.45, 0, 1),
		candidateLimit: Math.round(num("candidateLimit", 600, 100, 4000)),
		routineMinScore: num("routineMinScore", 0.45, 0.1, 0.95),
		goalDriftMin: num("goalDriftMin", 0.34, 0.05, 0.95),
		goalGuardChars: Math.round(num("goalGuardChars", 420, 160, 1600)),
		skillMinScore: num("skillMinScore", 0.5, 0.1, 0.95),
		autoMine: c.autoMine !== false,
		weeklyAnalysis: c.weeklyAnalysis !== false,
		vaultSync: c.vaultSync !== false,
		redact: c.redact !== false,
		excludeProjects: Array.isArray(c.excludeProjects) ? c.excludeProjects.map(String).filter((p) => p.trim() !== "") : [],
		privateProjects: Array.isArray(c.privateProjects) ? c.privateProjects.map(String).filter((p) => p.trim() !== "") : [],
		stepRetentionDays: Math.round(num("stepRetentionDays", 365, 0, 3650)),
		/* LightRAG graph: associative recall only when the local index misses */
		lightragEnabled: c.lightragEnabled !== false,
		lightragUrl: typeof c.lightragUrl === "string" && c.lightragUrl.trim().length > 8 ? c.lightragUrl.trim() : "http://127.0.0.1:9621",
		lightragMode: ["local", "global", "hybrid", "mix", "naive"].includes(c.lightragMode) ? c.lightragMode : "mix",
		lightragTopK: Math.round(num("lightragTopK", 24, 5, 100)),
		lightragTimeoutMs: Math.round(num("lightragTimeoutMs", 6000, 500, 60000)),
		lightragChars: Math.round(num("lightragChars", 600, 120, 2400)),
		lightragWeakBelow: num("lightragWeakBelow", 0.55, 0.05, 0.99),
		lightragAlways: c.lightragAlways === true,
		lightragCrossWorkspace: c.lightragCrossWorkspace !== false,
		lightragCacheTtlMs: Math.round(num("lightragCacheTtlMs", 600000, 10000, 3600000)),
		vaultPath: typeof c.vaultPath === "string" && c.vaultPath.trim().length > 3
			? path.resolve(c.vaultPath)
			: path.join(homeDir(), "obsidian", "vault"),
		dbPath: typeof c.dbPath === "string" && c.dbPath.trim().length > 3
			? path.resolve(c.dbPath)
			: path.join(homeDir(), "memory", "ctxdb.sqlite")
	};
}

/* ── text math ─────────────────────────────────────────────────────────── */

/**
 * Signed feature hashing (v3). Two independent hashes per feature: the bucket
 * and the sign. The old unsigned scheme *added* weight on a collision, so two
 * unrelated words could look similar; with a sign a collision mostly cancels.
 */
const VECTOR_DIM = 8192;
const VEC_VERSION = 3;
const MAX_FEATURES = 160;

function hashA(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i += 1) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

function hashB(str) {
	let h = 0x9e3779b1;
	for (let i = str.length - 1; i >= 0; i -= 1) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x85ebca6b) >>> 0;
		h ^= h >>> 13;
	}
	return h >>> 0;
}

function bucketOf(feature) { return hashA(feature) % VECTOR_DIM; }
function signOf(feature) { return (hashB(feature) & 1) === 0 ? 1 : -1; }

/* Russian inflection strip: longest endings first, never below a 4-char stem. */
const RU_ENDINGS = [
	"иями", "ями", "ами", "ией", "еей", "иях", "иям", "ием", "ого", "его", "ому", "ему", "ыми", "ими",
	"ость", "есть", "ений", "аний", "ация", "ации", "ацию", "ировать", "изация", "изовать", "ывать", "овать",
	"ать", "ять", "ить", "еть", "уть", "ться", "тся", "лся", "лась", "лись", "ший", "шая", "шее", "шие",
	"ого", "его", "ому", "ему", "ыми", "ими", "ых", "их", "ый", "ий", "ой", "ей", "ая", "яя", "ое", "ее",
	"ие", "ым", "им", "ом", "ем", "ах", "ях", "ов", "ев", "ью", "ия", "ию", "ии", "ся", "сь", "ть",
	"ла", "ло", "ли", "ны", "на", "но", "ет", "ут", "ют", "ат", "ят", "у", "ю", "а", "я", "о", "е", "ы", "и", "ь"
];

const EN_ENDINGS = [
	"ational", "ization", "iveness", "fulness", "ousness", "ations", "ements", "ingly", "ities",
	"ation", "ement", "ments", "ness", "less", "able", "ible", "ance", "ence", "ally", "ment",
	"ings", "ing", "ies", "ied", "ers", "est", "ed", "es", "ly", "s"
];

function stripEnding(word, endings, minStem) {
	for (const end of endings) {
		if (word.length - end.length >= minStem && word.endsWith(end)) return word.slice(0, -end.length);
	}
	return word;
}

/** Language-aware light stemmer: enough to fold inflection, far from aggressive. */
function stemWord(word) {
	if (word.length < 4 || /^[0-9]/.test(word)) return word;
	if (/[\u0400-\u04FF]/.test(word)) return stripEnding(word, RU_ENDINGS, 4);
	return stripEnding(word, EN_ENDINGS, 3);
}

/** Raw lowercase tokens (numbers kept, 1-2 char words dropped). */
function rawWords(text) {
	const out = [];
	for (const raw of String(text).match(/[0-9]*[A-Za-zА-ЯЁа-яё][0-9A-Za-zА-ЯЁа-яё_\-\u0400-\u04FF]*/g) ?? []) {
		const w = raw.toLowerCase();
		if (w.length < 3 && !/^[0-9]/.test(w)) continue;
		out.push(w);
	}
	return out;
}

/** Stem set of a text: the unit of lexical matching. */
function stemsOf(text) {
	const set = new Set();
	for (const w of rawWords(text)) {
		const s = stemWord(w);
		if (s.length >= 3) set.add(s);
	}
	return set;
}

/** Lowercase words plus 4-char root aliases (legacy helper: templates, style). */
function wordsOf(text) {
	const out = [];
	for (const w of rawWords(text)) {
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

/** Sparse hashed TF-IDF vector (L2-normalized) as a Map(index → signed weight). */
function embed(text, idf) {
	const features = new Map();
	for (const w of rawWords(text)) {
		const s = stemWord(w);
		if (s.length < 3) continue;
		features.set(`s:${s}`, 1);
		if (s.length >= 6) features.set(`r:${s.slice(0, 4)}`, 0.45);
		if (s.length >= 5) {
			features.set(`^:${s.slice(0, 3)}`, 0.26);
			features.set(`$:${s.slice(-3)}`, 0.26);
		}
	}
	const vec = new Map();
	const docCount = Math.max(1, Number(idf?.docCount) || 1);
	for (const [key, base] of features) {
		const isStem = key.startsWith("s:");
		let weight = base;
		if (isStem) {
			const df = idf?.map?.get(key.slice(2));
			weight *= df === undefined ? 1.6 : Math.log(1 + docCount / (1 + df));
		}
		const idx = bucketOf(key);
		vec.set(idx, (vec.get(idx) ?? 0) + signOf(key) * weight);
	}
	/* cap the feature count so a long document cannot bloat the stored vector */
	let entries = [...vec.entries()].filter(([, w]) => w !== 0);
	if (entries.length > MAX_FEATURES) {
		entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
		entries = entries.slice(0, MAX_FEATURES);
	}
	let norm = 0;
	for (const [, w] of entries) norm += w * w;
	norm = Math.sqrt(norm) || 1;
	const out = new Map();
	for (const [idx, w] of entries) out.set(idx, w / norm);
	return out;
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

/**
 * Fuzzy stem coverage: exact stem, 5-char prefix, or a shared 4-char root.
 * `extra` (association neighbours) scores at half weight — enough to rank a
 * synonym hit above noise, never enough to outrank a literal match.
 */
function coverage(query, candidate, extra = undefined) {
	const q = query instanceof Set ? query : stemsOf(query);
	const cand = typeof candidate === "string" ? stemsOf(candidate) : (candidate ?? new Set());
	if (q.size === 0) return 0;
	const index = new Set();
	for (const w of cand) {
		index.add(w);
		if (w.length >= 5) index.add(`p:${w.slice(0, 5)}`);
		if (w.length >= 4) index.add(`r:${w.slice(0, 4)}`);
	}
	const hit = (w) => index.has(w) || index.has(`p:${w.slice(0, 5)}`) || index.has(`r:${w.slice(0, 4)}`);
	let hits = 0;
	for (const w of q) {
		if (w.length >= 4 && hit(w)) hits += 1;
	}
	let extraHits = 0;
	if (extra instanceof Set) {
		for (const w of extra) if (w.length >= 4 && !q.has(w) && hit(w)) extraHits += 1;
	}
	const denom = Math.max(1, Math.min(q.size, 24));
	return Math.min(1, (hits + 0.5 * extraHits) / denom);
}

/* ── privacy: secrets never reach the store ───────────────────────────── */

const SECRET_PATTERNS = [
	/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
	/(\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey)\b\s*[:=]\s*)["']?[^\s"',;]{6,}/gi
];

function redactSecret(match, prefix) {
	if (typeof prefix === "string" && prefix.length > 0) return `${prefix}[redacted]`;
	return "[redacted]";
}

/** Mask API keys, JWTs and `password: …` fragments before anything is stored. */
function redact(text) {
	let out = String(text);
	for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, redactSecret);
	return out;
}

/** Canonical source reference shown in the prompt: 8 hex chars of the chunk id. */
function chunkRef(id) { return String(id).slice(0, 8); }

/* ── query side: association expansion + one scoring formula ───────────── */

/**
 * Build the query context once per request: the hashed vector plus the
 * association neighbours of every query stem (mined locally from the corpus,
 * so `каскад` ↔ `cascade` and `compaction` ↔ `сжатие` are learned from the
 * author's own bilingual wording instead of an embedding API).
 */
function buildQuery(query, idf, assoc, options = {}) {
	const terms = stemsOf(query);
	const extra = new Map();
	if (assoc !== undefined && assoc.size > 0 && terms.size > 0) {
		const top = Math.max(0, Math.min(8, options.assocTop ?? 4));
		const minWeight = options.assocMinWeight ?? 0.22;
		for (const stem of terms) {
			const list = assoc.get(stem);
			if (!Array.isArray(list)) continue;
			/* A same-script neighbour mostly repeats the query; a foreign-script
			   one is where a synonym or a translation lives, so the two are
			   selected separately instead of competing for the same top-N. */
			const cyrillic = /[\u0400-\u04FF]/.test(stem);
			const sameList = [];
			const foreignList = [];
			for (const pair of list) {
				if (!Array.isArray(pair) || pair.length < 2) continue;
				const [neighbour, weight] = pair;
				if (typeof neighbour !== "string" || typeof weight !== "number") continue;
				/* identifiers (`update-ed25519`, `xioawg0`, `9ec6678e`) are rare but
				   useless for expansion: they never appear in a new request */
				if (!/^[a-zа-яё][a-zа-яё-]{3,}$/.test(neighbour)) continue;
				/* a token that mixes scripts is a parsing artefact, not a word */
				if (/[а-яё]/.test(neighbour) && /[a-z]/.test(neighbour)) continue;
				if (weight < minWeight || terms.has(neighbour)) continue;
				const item = { term: neighbour, weight, df: idf?.map?.get(neighbour) ?? 0 };
				if (/[\u0400-\u04FF]/.test(neighbour) !== cyrillic) foreignList.push(item);
				else sameList.push(item);
			}
			sameList.sort((a, b) => b.weight - a.weight);
			/* A cross-script neighbour is a candidate translation, and a *common*
			   word is a far better bet than a one-off stem: rank by document
			   frequency first, weight second. */
			foreignList.sort((a, b) => (b.df - a.df) || (b.weight - a.weight));
			for (const item of sameList.slice(0, Math.max(1, Math.floor(top / 2)))) extra.set(item.term, Math.max(extra.get(item.term) ?? 0, item.weight));
			for (const item of foreignList.slice(0, Math.max(2, Math.ceil(top / 2) + 1))) extra.set(item.term, Math.max(extra.get(item.term) ?? 0, item.weight));
		}
	}
	let vec = embed(query, idf);
	if (extra.size > 0) {
		const boost = options.assocWeight ?? 0.45;
		const text = [...extra.entries()].map(([term, weight]) => `${term} `.repeat(Math.max(1, Math.round(1 + weight * 2)))).join(" ");
		const extraVec = embed(text, idf);
		vec = new Map(vec);
		for (const [idx, weight] of extraVec) vec.set(idx, (vec.get(idx) ?? 0) + weight * boost);
		let norm = 0;
		for (const weight of vec.values()) norm += weight * weight;
		norm = Math.sqrt(norm) || 1;
		for (const [idx, weight] of vec) vec.set(idx, weight / norm);
	}
	return { query: String(query), vec, terms, extra };
}

/** One formula for live recall, the tuner and the eval harness alike. */
function scoreCandidate(qc, cand, options = {}) {
	const now = options.now ?? Date.now();
	const vec = cand.vecMap ?? (cand.vec instanceof Map ? cand.vec : new Map(JSON.parse(String(cand.vec ?? "[]"))));
	const stems = cand.stems instanceof Set ? cand.stems : stemsOf(cand.text);
	const cos = cosine(qc.vec, vec);
	const exact = coverage(qc.terms, stems);
	const associative = qc.extra instanceof Map && qc.extra.size > 0 ? coverage(qc.terms, stems, new Set(qc.extra.keys())) : 0;
	const sameProject = options.project !== undefined && options.project !== "" && String(cand.project ?? "") === options.project;
	const recency = Math.exp(-Math.max(0, now - Number(cand.ts ?? 0)) / 86400000 / 45);
	return 0.6 * cos + 0.24 * exact + 0.12 * associative + (sameProject ? 0.06 : 0) + 0.04 * recency;
}

/** Human-readable source stamp for a chunk (also served by `memory_source`). */
function sourceStamp(chunk) {
	const date = new Date(Number(chunk.ts ?? 0));
	const when = Number.isNaN(date.getTime()) ? "—" : `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}`;
	return `${chunkRef(chunk.id)} · ${chunk.kind}${chunk.project ? ` · ${clip(chunk.project, 18)}` : ""} · ${when}`;
}

/* ── vocabulary rebuild (module level: shared by the plugin, the eval
      harness and the offline tools; pure CPU, no tokens) ───────────────── */

/** Recount document frequency over the whole corpus with the v3 tokenizer. */
function vocabularyRebuild(store) {
	const df = {};
	let docCount = 0;
	let after = 0;
	for (;;) {
		const rows = store.chunkPage(after, 500);
		if (rows.length === 0) break;
		for (const row of rows) {
			after = row.rowid;
			for (const stem of stemsOf(row.text)) if (stem.length >= 3) df[stem] = (df[stem] ?? 0) + 1;
			docCount += 1;
		}
	}
	store.writeIdf({ docCount, df });
	return { df, docCount, terms: Object.keys(df).length };
}

/** Re-embed every chunk plus the derived vectors (goals, summaries, skills). */
function vectorsRebuild(store, idfView) {
	let after = 0;
	let count = 0;
	for (;;) {
		const rows = store.chunkPage(after, 300);
		if (rows.length === 0) break;
		for (const row of rows) {
			after = row.rowid;
			store.setChunkVec(row.id, [...embed(row.text, idfView())], VEC_VERSION);
			count += 1;
		}
	}
	for (const row of store.db.prepare(`SELECT id, text FROM mh_goals`).all()) {
		store.db.prepare(`UPDATE mh_goals SET vec = ? WHERE id = ?`).run(JSON.stringify([...embed(String(row.text), idfView())]), row.id);
	}
	for (const row of store.db.prepare(`SELECT session_id, summary FROM mh_sessions WHERE summary <> ''`).all()) {
		store.db.prepare(`UPDATE mh_sessions SET vec = ? WHERE session_id = ?`).run(JSON.stringify([...embed(String(row.summary), idfView())]), row.session_id);
	}
	for (const row of store.db.prepare(`SELECT id, name, trigger FROM mh_skills`).all()) {
		store.db.prepare(`UPDATE mh_skills SET vec = ? WHERE id = ?`).run(JSON.stringify([...embed(`${row.name} ${row.trigger}`, idfView())]), row.id);
	}
	return count;
}

/**
 * Co-occurrence associations (PPMI over the corpus) → the corpus's own
 * thesaurus. Because the author mixes RU and EN inside one paragraph, a term
 * and its translation share context and become neighbours: that is where
 * `каскад` ↔ `cascade` comes from, with no external model involved.
 * Returns rows ready for `store.assocReplace`.
 */
function associationsBuild(store, df, docCount, minWeight = 0.22) {
	const docs = Math.max(1, docCount);
	const pairs = new Map();
	const PAIR_CAP = 1_200_000;
	const WINDOW = 8;
	const PER_CHUNK = 300;
	let after = 0;
	while (pairs.size < PAIR_CAP) {
		const rows = store.chunkPage(after, 200);
		if (rows.length === 0) break;
		for (const row of rows) {
			after = row.rowid;
			/* Sliding window, not "any two terms in the chunk": a chunk is a long
			   multi-topic text, so whole-chunk pairs diluted exactly the pairs that
			   matter (a term next to its translation). Nearest neighbours first,
			   capped per chunk so one huge log cannot own the thesaurus. */
			const stems = rawWords(row.text)
				.map(stemWord)
				.filter((stem) => stem.length >= 3 && (df[stem] ?? 0) >= 2 && (df[stem] ?? 0) <= 1500)
				/* hex ids and bare numbers are noise in a thesaurus */
				.filter((stem) => !/^[0-9a-f]{6,}$/.test(stem) && !/^[0-9]+$/.test(stem));
			const seen = new Set();
			let added = 0;
			for (let distance = 1; distance <= WINDOW && added < PER_CHUNK; distance += 1) {
				for (let i = 0; i + distance < stems.length && added < PER_CHUNK; i += 1) {
					const a = stems[i];
					const b = stems[i + distance];
					if (a === b) continue;
					const key = a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`;
					if (seen.has(key)) continue;
					seen.add(key);
					pairs.set(key, (pairs.get(key) ?? 0) + 1);
					added += 1;
				}
			}
		}
	}
	const neighbours = new Map();
	const push = (term, other, weight) => {
		let list = neighbours.get(term);
		if (list === undefined) { list = []; neighbours.set(term, list); }
		list.push([other, weight]);
	};
	for (const [key, count] of pairs) {
		if (count < 2) continue;
		const [a, b] = key.split("\u0001");
		const pmi = Math.log((count * docs) / (Math.max(1, df[a] ?? 1) * Math.max(1, df[b] ?? 1)));
		if (!(pmi > 0)) continue;
		/* Continuous strength: the old saturation at 1.0 flattened every strong
		   pair into a tie and then truncated the list arbitrarily, which is how
		   a real translation pair (`каскад`↔`cascade`) used to fall out. */
		let weight = (pmi / 6) * Math.sqrt(count / (count + 2));
		/* RU↔EN co-occurrence in one paragraph is itself evidence of a pair */
		if (/[\u0400-\u04FF]/.test(a) !== /[\u0400-\u04FF]/.test(b)) weight *= 1.35;
		weight = Math.min(1, weight);
		if (weight < minWeight) continue;
		push(a, b, weight);
		push(b, a, weight);
	}
	const keep = new Map();
	for (const [term, list] of neighbours) {
		list.sort((x, y) => y[1] - x[1]);
		keep.set(term, list.slice(0, 32));
	}
	/* truncation must not break symmetry: if `a` kept `b`, `b` keeps `a` too,
	   otherwise a query in one direction finds the translation and the reverse
	   one does not */
	for (const [term, list] of [...keep]) {
		for (const [other, weight] of list) {
			const back = keep.get(other);
			if (back === undefined) continue;
			if (back.some(([name]) => name === term)) continue;
			if (back.length < 32) { back.push([term, weight]); continue; }
			/* full list: the reverse edge displaces the weakest entry, so a real
			   translation is never crowded out by weak noise; a cross-script edge
			   is always worth a slot (it is the only bridge between languages) */
			/* displace the weakest neighbour that shares the host's script: a
			   cross-script bridge already in the list must not be evicted by
			   another cross-script arrival (both are scarce) */
			const hostCyr = /[\u0400-\u04FF]/.test(other);
			let weakest = -1;
			for (let i = 0; i < back.length; i += 1) {
				if (/[\u0400-\u04FF]/.test(back[i][0]) !== hostCyr) continue;
				if (weakest < 0 || back[i][1] < back[weakest][1]) weakest = i;
			}
			if (weakest < 0) continue;
			const crossScript = /[\u0400-\u04FF]/.test(term) !== /[\u0400-\u04FF]/.test(other);
			if (crossScript || weight > back[weakest][1]) back[weakest] = [term, weight];
		}
	}
	const entries = [];
	for (const [term, list] of keep) {
		const top = list.map(([other, weight]) => [other, Number(weight.toFixed(3))]);
		if (top.length > 0) entries.push([term, df[term] ?? 1, top]);
	}
	return { entries, pairs: pairs.size };
}


function sha256(text) {
	return createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 32);
}

function clip(text, max) {
	const t = String(text).replace(/\s+/g, " ").trim();
	return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`;
}

/* ── retrieval (module level: shared by the plugin, MCP, HTTP and eval) ── */

/**
 * Hybrid retrieval over one store. Candidates come from the FTS5 index (all of
 * history, prefix-matched stems) plus a recent/project window; only those rows
 * are scored, so the cost no longer grows with the whole store.
 */
function searchMemory(store, query, options = {}) {
	const config = options.config ?? normalizeConfig({});
	const idf = options.idf ?? store.readIdf();
	const assoc = options.assoc ?? new Map();
	const stemsFor = options.stems ?? ((id, text) => stemsOf(text));
	const project = options.project ?? "";
	const kinds = Array.isArray(options.kinds) ? options.kinds : [];
	const qc = buildQuery(query, idf, assoc, config);
	const qEcho = String(query).replace(/\s+/g, " ").trim().slice(0, 600);
	const pool = new Map();
	for (const row of store.ftsCandidates(qc.terms, config.candidateLimit)) pool.set(row.id, row);
	for (const row of store.recentCandidates(kinds, Math.min(config.candidateLimit, 600), project)) {
		if (!pool.has(row.id)) pool.set(row.id, row);
	}
	const scored = [];
	for (const cand of pool.values()) {
		if (kinds.length > 0 && !kinds.includes(cand.kind)) continue;
		if (cand.kind === "chat_user" && String(cand.text).replace(/\s+/g, " ").trim().slice(0, 600) === qEcho) continue;
		if (config.privateProjects.includes(cand.project) && cand.project !== project) continue;
		if (Number(cand.vver ?? 0) !== VEC_VERSION) continue;
		const item = { ...cand, vecMap: new Map(JSON.parse(String(cand.vec ?? "[]"))), stems: stemsFor(cand.id, cand.text) };
		item.score = scoreCandidate(qc, item, { project });
		item.sameProject = project !== "" && cand.project === project;
		scored.push(item);
	}
	scored.sort((a, b) => b.score - a.score);
	const limit = Math.max(1, Math.min(50, options.limit ?? config.recallLimit));
	const threshold = options.minScore ?? config.minRecallScore;
	const seen = new Set();
	const picks = [];
	for (const item of scored) {
		if (picks.length >= limit) break;
		if (item.score < threshold) break;
		const key = clip(item.text, 72);
		if (seen.has(key)) continue;
		seen.add(key);
		picks.push(item);
	}
	let fallback = null;
	if (picks.length === 0 && config.recallFallbackScore > 0 && scored.length > 0) {
		const best = scored[0];
		if (best.score >= config.recallFallbackScore) fallback = best;
	}
	return { picks, fallback, best: scored[0]?.score ?? 0, candidates: pool.size, expanded: qc.extra.size, query: qc };
}

/* ── store over node:sqlite ────────────────────────────────────────────── */

/** Open the shared DB; a damaged file is moved aside and a fresh one is created (self-healing). */
function openDatabase(file, warnFn) {
	const attempt = () => {
		const db = new DatabaseSync(file);
		db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
		try {
			const row = db.prepare("PRAGMA quick_check").get();
			const verdict = String(Object.values(row ?? {})[0] ?? "");
			if (verdict !== "ok") throw new Error(`quick_check: ${verdict}`);
		} catch (error) {
			try { db.close(); } catch { /* ignore */ }
			throw error;
		}
		return db;
	};
	try {
		return attempt();
	} catch (error) {
		warnFn(`db self-heal: ${String(error)}`);
		try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
		for (const suffix of ["-wal", "-shm"]) {
			try { fs.rmSync(`${file}${suffix}`, { force: true }); } catch { /* ignore */ }
		}
		return attempt();
	}
}

class MemoryStore {
	constructor(file, warnFn) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		this.db = openDatabase(file, warnFn);
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
			CREATE TABLE IF NOT EXISTS mh_terms (
				term TEXT PRIMARY KEY,
				df INTEGER NOT NULL DEFAULT 0,
				neighbors TEXT NOT NULL DEFAULT '[]',
				updated_at INTEGER NOT NULL DEFAULT 0
			);
		`);
		/* schema v3 — vector generation marker + learned associations */
		try { this.db.exec(`ALTER TABLE chunks ADD COLUMN vver INTEGER NOT NULL DEFAULT 0`); } catch { /* column exists */ }
		try { this.db.exec(`CREATE INDEX IF NOT EXISTS chunks_vver ON chunks(vver)`); } catch { /* ignore */ }
		/* schema v2 — project memory: sessions, goals, steps, learned skills */
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS mh_sessions (
				session_id TEXT PRIMARY KEY,
				project TEXT NOT NULL DEFAULT '',
				title TEXT NOT NULL DEFAULT '',
				summary TEXT NOT NULL DEFAULT '',
				vec TEXT NOT NULL DEFAULT '[]',
				started_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				turns INTEGER NOT NULL DEFAULT 0,
				done INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS mh_sessions_project ON mh_sessions(project, updated_at);
			CREATE TABLE IF NOT EXISTS mh_goals (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL DEFAULT '',
				project TEXT NOT NULL DEFAULT '',
				text TEXT NOT NULL,
				vec TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active',
				progress INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS mh_goals_status ON mh_goals(status, updated_at);
			CREATE INDEX IF NOT EXISTS mh_goals_project ON mh_goals(project, status);
			CREATE TABLE IF NOT EXISTS mh_steps (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL DEFAULT '',
				project TEXT NOT NULL DEFAULT '',
				turn INTEGER NOT NULL DEFAULT 0,
				ts INTEGER NOT NULL,
				kind TEXT NOT NULL DEFAULT 'tool',
				name TEXT NOT NULL DEFAULT '',
				text TEXT NOT NULL DEFAULT '',
				ok INTEGER NOT NULL DEFAULT 1,
				vec TEXT NOT NULL DEFAULT '[]'
			);
			CREATE INDEX IF NOT EXISTS mh_steps_session ON mh_steps(session_id, ts);
			CREATE INDEX IF NOT EXISTS mh_steps_project ON mh_steps(project, ts);
			CREATE TABLE IF NOT EXISTS mh_skills (
				id TEXT PRIMARY KEY,
				tkey TEXT NOT NULL DEFAULT '',
				project TEXT NOT NULL DEFAULT '',
				name TEXT NOT NULL DEFAULT '',
				trigger TEXT NOT NULL DEFAULT '',
				vec TEXT NOT NULL DEFAULT '[]',
				steps TEXT NOT NULL DEFAULT '',
				artifact TEXT NOT NULL DEFAULT '',
				ok_count INTEGER NOT NULL DEFAULT 1,
				fail_count INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'proposed',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS mh_skills_tkey ON mh_skills(tkey);
			PRAGMA user_version = 2;
		`);
	}

	prepare(sql) { return this.db.prepare(sql); }

	upsertChunk(id, kind, text, project, sessionId, turn, ts, vec, vver = VEC_VERSION) {
		this.db.prepare(`INSERT INTO chunks (id, kind, text, project, session_id, turn, ts, vec, vver)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, vec = excluded.vec, vver = excluded.vver`).run(
			id, kind, text, project, sessionId, turn, ts, JSON.stringify(vec), vver
		);
	}

	deleteChunk(id) { this.db.prepare(`DELETE FROM chunks WHERE id = ?`).run(id); }

	punchHit(id) { this.db.prepare(`UPDATE chunks SET hits = hits + 1 WHERE id = ?`).run(id); }

	metaGet(key) { return this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key)?.value; }

	metaPut(key, value) {
		this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
	}

	metaDel(key) { this.db.prepare(`DELETE FROM meta WHERE key = ?`).run(key); }

	readIdf() {
		const raw = this.metaGet("idf");
		if (raw === undefined || raw === "") return { map: new Map(), docCount: 0 };
		try {
			const parsed = JSON.parse(raw);
			return { map: new Map(Object.entries(parsed.df ?? {})), docCount: Number(parsed.docCount ?? 0) };
		} catch { return { map: new Map(), docCount: 0 }; }
	}

	writeIdf(idfDoc) {
		this.metaPut("idf", JSON.stringify({ docCount: idfDoc.docCount, df: idfDoc.df }));
	}

	/**
	 * Index-driven candidate generation: FTS5 prefix match over the query stems
	 * instead of "the newest 1600 rows", so old chats stay reachable and the
	 * per-query cost stops growing with the whole store.
	 */
	ftsCandidates(stems, limit) {
		const terms = [...stems].filter((s) => /^[0-9a-zа-яё]{3,}$/.test(s)).slice(0, 24);
		if (terms.length === 0) return [];
		const match = terms.map((t) => `"${t}"*`).join(" OR ");
		try {
			return this.db.prepare(`SELECT c.id, c.kind, c.text, c.project, c.session_id, c.ts, c.vec, c.vver
				FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid
				WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`).all(match, limit);
		} catch { return []; }
	}

	/** Recent + same-project rows: freshness and local context next to the FTS hits. */
	recentCandidates(kinds, limit, project) {
		const where = kinds.length > 0 ? `kind IN (${kinds.map(() => "?").join(",")})` : "1 = 1";
		const rows = this.db.prepare(`SELECT id, kind, text, project, session_id, ts, vec, vver
			FROM chunks WHERE ${where} ORDER BY ts DESC LIMIT ?`).all(...kinds, limit);
		if (project !== "") {
			rows.push(...this.db.prepare(`SELECT id, kind, text, project, session_id, ts, vec, vver
				FROM chunks WHERE project = ? AND ${where} ORDER BY ts DESC LIMIT ?`).all(project, ...kinds, Math.max(50, Math.floor(limit / 2))));
		}
		return rows;
	}

	chunkById(id) {
		return this.db.prepare(`SELECT id, kind, text, project, session_id, turn, ts, hits FROM chunks WHERE id = ?`).get(id);
	}

	/** Resolve the short ref shown in the prompt back to the full row. */
	chunkByRef(ref) {
		const clean = String(ref).replace(/[^0-9a-f]/gi, "").slice(0, 8);
		if (clean.length < 4) return undefined;
		return this.db.prepare(`SELECT id, kind, text, project, session_id, turn, ts, hits
			FROM chunks WHERE id LIKE ? ORDER BY ts DESC LIMIT 1`).get(`${clean}%`);
	}

	chunkPage(afterRowid, limit) {
		return this.db.prepare(`SELECT rowid, id, text FROM chunks WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(afterRowid, limit);
	}

	setChunkVec(id, vec, vver) {
		this.db.prepare(`UPDATE chunks SET vec = ?, vver = ? WHERE id = ?`).run(JSON.stringify(vec), vver, id);
	}

	/** Term → neighbours map, read once per process. */
	assocLoad() {
		const map = new Map();
		try {
			for (const row of this.db.prepare(`SELECT term, neighbors FROM mh_terms`).all()) {
				try {
					const list = JSON.parse(String(row.neighbors ?? "[]"));
					if (Array.isArray(list) && list.length > 0) map.set(String(row.term), list);
				} catch { /* one bad row must not poison the map */ }
			}
		} catch { /* table absent on an old store */ }
		return map;
	}

	assocReplace(entries) {
		this.db.prepare(`DELETE FROM mh_terms`).run();
		const stmt = this.db.prepare(`INSERT OR REPLACE INTO mh_terms (term, df, neighbors, updated_at) VALUES (?, ?, ?, ?)`);
		const now = Date.now();
		this.db.exec("BEGIN");
		try {
			for (const [term, df, neighbors] of entries) stmt.run(term, df, JSON.stringify(neighbors), now);
			this.db.exec("COMMIT");
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
			throw error;
		}
	}

	assocCount() {
		try { return this.db.prepare(`SELECT COUNT(*) AS n FROM mh_terms`).get()?.n ?? 0; } catch { return 0; }
	}

	/** Reclaim write amplification: FTS merge, planner stats, WAL truncate. */
	maintenance() {
		const done = [];
		for (const sql of ["PRAGMA optimize", "INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')", "PRAGMA wal_checkpoint(TRUNCATE)"]) {
			try { this.db.exec(sql); done.push(sql); } catch { /* best-effort */ }
		}
		return done;
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

	/* ── project memory (schema v2) ── */
	sessionTouch(sessionId, project, title, ts) {
		this.db.prepare(`INSERT INTO mh_sessions (session_id, project, title, started_at, updated_at, turns)
			VALUES (?, ?, ?, ?, ?, 1)
			ON CONFLICT(session_id) DO UPDATE SET
				updated_at = excluded.updated_at,
				turns = mh_sessions.turns + 1,
				title = CASE WHEN mh_sessions.title = '' THEN excluded.title ELSE mh_sessions.title END,
				project = CASE WHEN mh_sessions.project = '' THEN excluded.project ELSE mh_sessions.project END`).run(sessionId, project, title, ts, ts);
	}

	sessionFinalize(sessionId, summary, vec, ts) {
		this.db.prepare(`UPDATE mh_sessions SET summary = ?, vec = ?, updated_at = ? WHERE session_id = ?`).run(summary, JSON.stringify(vec), ts, sessionId);
	}

	sessionGet(sessionId) { return this.db.prepare(`SELECT * FROM mh_sessions WHERE session_id = ?`).get(sessionId); }
	sessionRecent(project, limit) {
		return project === ""
			? this.db.prepare(`SELECT * FROM mh_sessions ORDER BY updated_at DESC LIMIT ?`).all(limit)
			: this.db.prepare(`SELECT * FROM mh_sessions WHERE project = ? ORDER BY updated_at DESC LIMIT ?`).all(project, limit);
	}
	sessionCount() { return this.db.prepare(`SELECT COUNT(*) AS n FROM mh_sessions`).get()?.n ?? 0; }

	goalCreate(sessionId, project, text, vec, ts) {
		const id = sha256(`${sessionId}|${project}|${text}`).slice(0, 16);
		this.db.prepare(`INSERT INTO mh_goals (id, session_id, project, text, vec, status, progress, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)
			ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`).run(id, sessionId, project, text, JSON.stringify(vec), ts, ts);
		return id;
	}

	goalActiveSession(sessionId) {
		return this.db.prepare(`SELECT * FROM mh_goals WHERE session_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`).get(sessionId);
	}
	goalActiveProject(project, limit) {
		return this.db.prepare(`SELECT * FROM mh_goals WHERE project = ? AND status = 'active' ORDER BY updated_at DESC LIMIT ?`).all(project, limit);
	}
	goalBump(id, ts) { this.db.prepare(`UPDATE mh_goals SET progress = progress + 1, updated_at = ? WHERE id = ?`).run(ts, id); }
	goalSetStatus(id, status, ts) { this.db.prepare(`UPDATE mh_goals SET status = ?, updated_at = ? WHERE id = ?`).run(status, ts, id); }
	goalList(limit) { return this.db.prepare(`SELECT * FROM mh_goals ORDER BY (status = 'active') DESC, updated_at DESC LIMIT ?`).all(limit); }
	goalCount() { return this.db.prepare(`SELECT COUNT(*) AS n FROM mh_goals WHERE status = 'active'`).get()?.n ?? 0; }

	stepsAdd(rows) {
		if (rows.length === 0) return;
		const stmt = this.db.prepare(`INSERT OR REPLACE INTO mh_steps
			(id, session_id, project, turn, ts, kind, name, text, ok, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		this.db.exec("BEGIN");
		try {
			for (const r of rows) stmt.run(r.id, r.sessionId, r.project, r.turn, r.ts, r.kind, r.name, r.text, r.ok, JSON.stringify(r.vec ?? []));
			this.db.exec("COMMIT");
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
			throw error;
		}
	}

	stepsSince(sessionId, limit) {
		return this.db.prepare(`SELECT kind, name, text, ok, ts FROM mh_steps WHERE session_id = ? ORDER BY ts DESC LIMIT ?`).all(sessionId, limit);
	}
	stepCount(sessionId) { return this.db.prepare(`SELECT COUNT(*) AS n FROM mh_steps WHERE session_id = ?`).get(sessionId)?.n ?? 0; }
	stepTotal() { return this.db.prepare(`SELECT COUNT(*) AS n FROM mh_steps`).get()?.n ?? 0; }

	skillUpsert(tkey, project, nameV, trigger, vec, steps, artifact, ts) {
		const id = sha256(`skill|${tkey}`).slice(0, 16);
		this.db.prepare(`INSERT INTO mh_skills (id, tkey, project, name, trigger, vec, steps, artifact, ok_count, fail_count, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'proposed', ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				ok_count = ok_count + 1,
				project = excluded.project,
				name = excluded.name,
				trigger = excluded.trigger,
				steps = excluded.steps,
				artifact = excluded.artifact,
				status = CASE WHEN mh_skills.ok_count + 1 >= 2 THEN 'active' ELSE mh_skills.status END,
				updated_at = excluded.updated_at`).run(id, tkey, project, nameV, trigger, JSON.stringify(vec), steps, artifact, ts, ts);
		return id;
	}

	skillByKey(tkey) { return this.db.prepare(`SELECT * FROM mh_skills WHERE tkey = ?`).get(tkey); }
	skillList(limit) { return this.db.prepare(`SELECT * FROM mh_skills WHERE status = 'active' ORDER BY ok_count DESC, updated_at DESC LIMIT ?`).all(limit); }
	skillCount() { return this.db.prepare(`SELECT COUNT(*) AS n FROM mh_skills`).get()?.n ?? 0; }
	skillFail(id, ts) { this.db.prepare(`UPDATE mh_skills SET fail_count = fail_count + 1, updated_at = ? WHERE id = ?`).run(ts, id); }

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

	/* term statistics: rebuilt by the v3 migration, kept current afterwards */
	let idf = {};
	let docCount = 0;
	try {
		const loaded = store.readIdf();
		idf = Object.fromEntries(loaded.map);
		docCount = loaded.docCount;
	} catch { idf = {}; docCount = 0; }
	const idfView = () => ({ map: termCache, docCount });
	let idfDirty = 0;

	/* association graph of stems (mined from the corpus, refreshed weekly) */
	let assoc = store.assocLoad();
	let assocAt = Number(store.metaGet("assocAt") ?? 0);

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
		for (const w of stemsOf(text)) {
			if (w.length < 3) continue;
			idf[w] = (idf[w] ?? 0) + 1;
			// держим кэш словаря в актуальном состоянии по одному термину —
			// полная пересборка Map на каждый чанк съедала десятки секунд CPU
			if (termCache) termCache.set(w, idf[w]);
		}
		docCount += 1;
		idfDirty += 1;
	}

	let termCache = new Map(Object.entries(idf).map(([k, v]) => [k, v]));
	/* Раньше idfCurrent() на КАЖДЫЙ вызов делал Object.keys(idf) (O(n) по словарю в
	   сотни тысяч стемов) — при массовой индексации это десятки секунд CPU.
	   Теперь кэш поддерживается инкрементально в trackTerms, а чтение — O(1). */
	function idfCurrent() {
		return { map: termCache, docCount };
	}

	/** Stems of a candidate text, cached: re-tokenizing every chunk per query was
	 *  the dominant cost of recall before (velocity, not size, was the problem). */
	const stemCache = new Map();
	function stemsCached(id, text) {
		let stems = stemCache.get(id);
		if (stems === undefined) {
			stems = stemsOf(text);
			if (stemCache.size > 20000) stemCache.clear();
			stemCache.set(id, stems);
		}
		return stems;
	}

	function isExcluded(project) {
		return project !== "" && config.excludeProjects.includes(project);
	}

	/** Секреты не индексируются: память не должна хранить ключи и токены. */
	function prepareText(text) {
		const raw = String(text).replace(/\s+/g, " ").trim();
		return config.redact ? redact(raw) : raw;
	}

	function addChunk(kind, text, project, sessionId, turn) {
		try {
			const t = prepareText(text);
			if (t.length < (kind === "chat_user" ? 12 : 24)) return null;
			if (isExcluded(project ?? "")) return null;
			const id = sha256(`${kind}|${t.slice(0, 3000)}`);
			store.upsertChunk(id, kind, t, project ?? "", sessionId ?? "", turn ?? 0, Date.now(), [...embed(t, idfCurrent())], VEC_VERSION);
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
					const open = openTurns.get(session) ?? { turn: data.turn ?? 0, project: meta.project, sessionId: meta.sessionId, title: "", userText: "", solution: "", startedAt: ts };
					open.turn = data.turn ?? open.turn;
					open.title = open.title ?? clip(text, 160);
					open.userText = clip(text, 1200);
					openTurns.set(session, open);
					if (config.lightragEnabled) {
						try {
							const quick = rankMemory(open.userText, { project: meta.project, limit: 1 });
							if (config.lightragAlways || quick.picks.length === 0 || Number(quick.best ?? 0) < config.lightragWeakBelow) {
								graphPrefetch(open.userText, meta.project);
							}
						} catch { /* the graph is an optional layer */ }
					}
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

	/* ── project memory: шаги, конспекты сессий, цели, навыки (schema v2) ── */
	const stepBuf = [];
	let stepFlushAt = 0;

	function flushSteps() {
		if (stepBuf.length === 0) return;
		try {
			store.stepsAdd(stepBuf.splice(0, stepBuf.length));
		} catch (error) {
			warn(ctx, `steps flush failed: ${String(error)}`);
		}
	}

	/** Hermes-принцип: решение с командами превращается в переиспользуемый навык. */
	function registerSkill(meta, open, ts) {
		try {
			const solution = String(open.solution ?? "");
			const title = String(open.title || open.userText || "");
			if (solution.length < 80 || title.length < 8) return;
			const tkey = templateKey(title);
			if (tkey.length < 8) return;
			const cmds = store.stepsSince(meta.sessionId, 10)
				.filter((s) => s.kind === "command" && s.ok === 1)
				.map((s) => clip(s.text, 160));
			const steps = clip(cmds.length > 0 ? cmds.join("\n") : clip(solution, 420), 700);
			store.skillUpsert(tkey, meta.project, clip(title, 60), clip(open.userText, 200), [...embed(tkey, idfCurrent())], steps, clip(solution, 300), ts);
		} catch (error) {
			warn(ctx, `skill upsert failed: ${String(error)}`);
		}
	}

	try {
		ctx.on("session/event", (session, event) => {
			try {
				const type = String(event?.type ?? "");
				if (!type.startsWith("tool/") && type !== "turn/start" && type !== "turn/end") return;
				const data = event?.data ?? {};
				if (data?.source?.kind === "memory-hub") return;
				const meta = sessionMeta(session);
				const ts = Number(event.time ?? Date.now());
				const open = openTurns.get(session);

				if (type === "turn/start") {
					if (open === undefined) return;
					store.sessionTouch(meta.sessionId, meta.project, clip(open.userText, 120), ts);
					if (open.userText.trim().length >= 12 && store.goalActiveSession(meta.sessionId) === undefined) {
						store.goalCreate(meta.sessionId, meta.project, clip(open.userText, 400), [...embed(open.userText, idfCurrent())], ts);
					}
					return;
				}

				if (type === "turn/end") {
					flushSteps();
					if (open === undefined) return;
					const goal = store.goalActiveSession(meta.sessionId);
					if (goal !== undefined) store.goalBump(goal.id, ts);
					const summary = clip([clip(open.userText, 200), clip(open.solution ?? "", 420)].filter(Boolean).join(" → "), 620);
					if (summary.length >= 40) store.sessionFinalize(meta.sessionId, summary, [...embed(summary, idfCurrent())], ts);
					registerSkill(meta, open, ts);
					return;
				}

				// tool/call | tool/result → шаг проекта (команда или вызов инструмента)
				const toolName = String(data.name ?? data.tool ?? data.call?.name ?? data.toolName ?? "");
				const rawArgs = data.arguments ?? data.args ?? data.input ?? data.call?.arguments ?? {};
				const cmd = typeof rawArgs?.command === "string" ? rawArgs.command
					: typeof rawArgs?.cmd === "string" ? rawArgs.cmd
						: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
				if (type === "tool/result" && toolName === "") return; // результат без имени не нужен
				const body = clip(`${toolName} ${clip(String(cmd ?? ""), 260)}`, 500);
				if (body.trim().length < 4) return;
				const ok = type === "tool/call" ? 1 : (data.isError === true || data.error !== undefined ? 0 : 1);
				stepBuf.push({
					id: sha256(`${meta.sessionId}|${ts}|${stepBuf.length}|${toolName}`).slice(0, 24),
					sessionId: meta.sessionId,
					project: meta.project,
					turn: open?.turn ?? 0,
					ts,
					kind: /(bash|shell|exec|terminal|run_command|sh)\b/i.test(toolName) ? "command" : "tool",
					name: clip(toolName, 40),
					text: body,
					ok,
					vec: []
				});
				const now = Date.now();
				if (stepBuf.length >= 24 || now - stepFlushAt > 20000) {
					stepFlushAt = now;
					flushSteps();
				}
			} catch (error) {
				warn(ctx, `project ingest failed: ${String(error)}`);
			}
		});
	} catch (error) {
		warn(ctx, `project ingest registration failed: ${String(error)}`);
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

	/* ── vocabulary migration (v3) + learned associations ──────────────────
	   Both are local computations over the corpus: no LLM, no embedding API,
	   so a full rebuild of 4k+ chunks costs a few seconds of CPU and zero
	   tokens. The vocabulary pass also fixes the old df counters, which had
	   been inflated by double counting and never decayed. */

	function rebuildVocabulary() {
		const result = vocabularyRebuild(store);
		idf = result.df;
		docCount = result.docCount;
		termCache = new Map(Object.entries(idf));
		return { terms: result.terms, docs: result.docCount };
	}

	function rebuildVectors() {
		return vectorsRebuild(store, idfCurrent);
	}

	/**
	 * Co-occurrence associations (PPMI over the corpus) → the vocabulary's own
	 * thesaurus. Because the author mixes RU and EN in one paragraph, a term and
	 * its translation end up in the same context and become neighbours: that is
	 * where `каскад` ↔ `cascade` comes from, with no external model involved.
	 */
	function buildAssociations() {
		const built = associationsBuild(store, idf, docCount, config.assocMinWeight);
		store.assocReplace(built.entries);
		assoc = store.assocLoad();
		assocAt = Date.now();
		store.metaPut("assocAt", String(assocAt));
		return { pairs: built.pairs, terms: built.entries.length };
	}

	function runVecMigration() {
		if (Number(store.metaGet("vecver") ?? 0) >= VEC_VERSION) return false;
		try {
			store.metaDel("idf");
			const vocab = rebuildVocabulary();
			const count = rebuildVectors();
			const graph = buildAssociations();
			store.metaPut("vecver", String(VEC_VERSION));
			store.metaPut("vecverAt", String(Date.now()));
			store.metaPut("vecverStats", JSON.stringify({ ...vocab, vectors: count, ...graph }));
			warn(ctx, `vocab v${VEC_VERSION}: ${vocab.docs} chunks, ${vocab.terms} stems, ${count} vectors, ${graph.terms} associated terms`);
			return true;
		} catch (error) {
			warn(ctx, `vocab migration failed: ${String(error)}`);
			store.metaPut("vecverError", `${new Date().toISOString()} ${String(error?.message ?? error)}`);
			return false;
		}
	}

	function runMaintenance() {
		try {
			store.maintenance();
			if (assoc.size === 0 || Date.now() - assocAt > 7 * 24 * 60 * 60 * 1000) buildAssociations();
			if (config.stepRetentionDays > 0) {
				const cutoff = Date.now() - config.stepRetentionDays * 24 * 60 * 60 * 1000;
				store.db.prepare(`DELETE FROM mh_steps WHERE ts < ?`).run(cutoff);
			}
			store.metaPut("maintenanceAt", String(Date.now()));
		} catch (error) {
			warn(ctx, `maintenance failed: ${String(error)}`);
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

	/* ── recall: index-driven candidates + association-expanded query ── */
	function rankMemory(query, options = {}) {
		return searchMemory(store, query, {
			project: options.project ?? "",
			kinds: options.kinds ?? [],
			limit: options.limit,
			minScore: options.minScore,
			config,
			idf: idfCurrent(),
			assoc,
			stems: stemsCached
		});
	}

	/* ── LightRAG graph client (associative layer, no cost when unused) ──
	   The graph answers what a vector index structurally cannot: multi-hop links
	   between chats and workspaces ("this failure was fixed the same way in another
	   project"). It is queried ONLY when the local hybrid recall comes up weak, so
	   a normal step never pays for it. Results are cached per query, and any
	   failure (server down, timeout) degrades to silence, never to an error. */

	const CYR_SLUG = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };

	/** Workspace id used in LightRAG file_source; mirrors scripts/build_docs.py::slug. */
	function lightragSlug(project) {
		const out = [];
		for (const ch of String(project || "shared")) {
			const low = ch.toLowerCase();
			if (CYR_SLUG[low] !== undefined) out.push(CYR_SLUG[low]);
			else if (/[A-Za-z0-9_]/.test(ch)) out.push(ch);
			else if (/[\s\-/.]/.test(ch)) out.push("_");
		}
		return out.join("").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "shared";
	}

	const graphCache = new Map();
	const graphInflight = new Map();
	const graphKey = (query, project) => `${lightragSlug(project)}|${String(query).replace(/\s+/g, " ").trim().slice(0, 240)}`;

	function graphCached(query, project) {
		const hit = graphCache.get(graphKey(query, project));
		if (hit === undefined) return null;
		if (Date.now() - hit.at > config.lightragCacheTtlMs) { graphCache.delete(graphKey(query, project)); return null; }
		return hit.text;
	}

	/** One LightRAG query; `only_need_context` skips answer generation (fewer tokens). */
	async function graphFetch(query, project) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), config.lightragTimeoutMs);
		try {
			const res = await fetch(`${String(config.lightragUrl).replace(/\/+$/, "")}/query`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					query: String(query).slice(0, 2000),
					mode: config.lightragMode,
					only_need_context: true,
					top_k: config.lightragTopK,
					hl_keywords: [],
					ll_keywords: []
				}),
				signal: controller.signal
			});
			if (!res.ok) { store.metaPut("graphError", `${res.status} at ${new Date().toISOString()}`); return ""; }
			const doc = await res.json();
			const text = String(doc?.response ?? "").trim();
			if (text.length === 0) return "";
			store.metaPut("graphLastOk", new Date().toISOString());
			return text;
		} catch (error) {
			store.metaPut("graphError", `${String(error?.name ?? error)} at ${new Date().toISOString()}`);
			return "";
		} finally {
			clearTimeout(timer);
		}
	}

	/** Fire-and-forget prefetch, deduplicated per query and bounded by the HTTP timeout. */
	function graphPrefetch(query, project) {
		if (!config.lightragEnabled) return;
		const text = String(query ?? "").trim();
		if (text.length < 12) return;
		const key = graphKey(text, project);
		if (graphCache.has(key) || graphInflight.has(key)) return;
		const task = graphFetch(text, project)
			.then((context) => {
				if (context.length > 0) {
					graphCache.set(key, { text: context, at: Date.now() });
					if (graphCache.size > 200) graphCache.delete(graphCache.keys().next().value);
					stats.graphHits = (stats.graphHits ?? 0) + 1;
					store.metaPut("graphHits", String(stats.graphHits));
				}
				return context;
			})
			.catch(() => "")
			.finally(() => graphInflight.delete(key));
		graphInflight.set(key, task);
	}

	function recallFor(session, query, kinds = []) {
		return rankMemory(query, { project: sessionMeta(session).project, kinds }).picks;
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
					const ranked = rankMemory(query, { project: sessionMeta(session).project });
					const picks = ranked.picks;
					if (picks.length > 0) {
						stats.recallHits += 1;
						store.metaPut("recallHits", String(stats.recallHits));
						const refCost = 26; // «[#ab12cd34 · kind · ws · дата]»
						const perItem = Math.max(70, Math.floor((config.recallChars / Math.max(1, picks.length)) - refCost));
						parts.push(picks.map((p) => `• [${sourceStamp(p)}] ${clip(p.text, perItem)}`).join("\n"));
						for (const p of picks) store.punchHit(p.id);
					} else if (ranked.fallback !== null) {
						/* near miss: one short line instead of silence, only when enabled */
						const best = ranked.fallback;
						stats.fallbackHits = (stats.fallbackHits ?? 0) + 1;
						store.metaPut("fallbackHits", String(stats.fallbackHits));
						parts.push(`• (слабое совпадение) [${sourceStamp(best)}] ${clip(best.text, config.fallbackChars)}`);
						store.punchHit(best.id);
					}
					let graphUsed = 0;
					if (config.lightragEnabled && (config.lightragAlways || picks.length === 0 || Number(ranked.best ?? 0) < config.lightragWeakBelow)) {
						const project = sessionMeta(session).project;
						const raw = graphCached(query, project);
						if (raw !== null) {
							const trimmed = clip(raw.replace(/\s+/g, " "), config.lightragChars);
							if (trimmed.length > 40) {
								graphUsed = trimmed.length;
								stats.graphInjections = (stats.graphInjections ?? 0) + 1;
								store.metaPut("graphInjections", String(stats.graphInjections));
								parts.push(`Граф знаний (связи между чатами и workspace; подробности — tool memory_graph):\n${trimmed}`);
							}
						}
					}
					if (parts.length === 0) return "";
					stats.injections += 1;
					const block = `Общая память (все чаты и workspace; подробности — tool memory_search):\n${parts.join("\n\n")}`;
					stats.injectedChars += block.length;
					store.metaPut("injections", String(stats.injections));
					store.metaPut("injectedChars", String(stats.injectedChars));
					return clip(block, config.recallChars + graphUsed);
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

	/* ── goal guard: сверка шага с вектором цели + подсказка навыка ── */
	const goalGuardAt = new Map();
	try {
		const disposerGuard = ctx.systemPrompt.context({
			name: "memory-hub:goal-guard",
			order: ctx.systemPrompt.getContextOrder("SUBAGENT_DELEGATION") + 5,
			required: false,
			interpolate: false,
			text: (assemblyContext) => {
				try {
					const session = assemblyContext?.agent?.session;
					if (session === undefined) return "";
					const open = openTurns.get(session);
					const query = String(open?.userText ?? "");
					if (query.trim().length < 20) return "";
					const meta = sessionMeta(session);
					const goal = store.goalActiveSession(meta.sessionId);
					if (goal === undefined) return "";

					const qvec = embed(query, idfCurrent());
					const gvec = new Map(JSON.parse(goal.vec ?? "[]"));
					const similarity = cosine(qvec, gvec);

					// навык: тот же запрос уже решался (Hermes: опыт → переиспользуемый навык)
					let skill = null;
					let skillScore = 0;
					for (const row of store.skillList(20)) {
						const score = coverage(query, `${row.name} ${row.trigger}`);
						if (score > skillScore) { skill = row; skillScore = score; }
					}
					const inVector = similarity >= config.goalDriftMin;
					const skillHit = skill !== null && skillScore >= config.skillMinScore;
					if (inVector && !skillHit) return "";

					// не чаще, чем раз в два хода на сессию — экономим токены
					const turn = Number(open?.turn ?? 0);
					if (!skillHit && Number(goalGuardAt.get(session) ?? -99) > turn - 2) return "";
					goalGuardAt.set(session, turn);

					const parts = [];
					if (!inVector) {
						const steps = store.stepsSince(meta.sessionId, 3).filter((s) => s.text).map((s) => clip(s.text, 80));
						parts.push(`Вектор цели проекта «${clip(goal.project || meta.project || "?", 24)}»: ${clip(goal.text, 180)}.`);
						parts.push(`Пройдено шагов: ${store.stepCount(meta.sessionId)}${steps.length ? `; последние: ${steps.join(" | ")}` : ""}.`);
						parts.push(`Текущий запрос слабо связан с целью (cos ${similarity.toFixed(2)}) — сверься, не потерян ли основной контекст.`);
						stats.goalGuardHits = (stats.goalGuardHits ?? 0) + 1;
						store.metaPut("goalGuardHits", String(stats.goalGuardHits));
					}
					if (skillHit) {
						parts.push(`<skill name="${clip(skill.name, 40)}" uses="${skill.ok_count}" score="${skillScore.toFixed(2)}">`);
						if (skill.steps) parts.push(`Порядок действий из прошлого успеха: ${clip(skill.steps, 220)}`);
						if (skill.artifact) parts.push(`Результат: ${clip(skill.artifact, 120)}`);
						parts.push("</skill>");
					}
					if (parts.length === 0) return "";
					const block = `Память проекта (сверка с целью):\n${parts.join("\n")}`;
					stats.goalGuardChars = (stats.goalGuardChars ?? 0) + block.length;
					store.metaPut("goalGuardChars", String(stats.goalGuardChars));
					return clip(block, config.goalGuardChars);
				} catch (error) {
					warn(ctx, `goal guard failed: ${String(error)}`);
					return "";
				}
			}
		});
		disposers.push(disposerGuard);
	} catch (error) {
		warn(ctx, `goal guard registration failed: ${String(error)}`);
	}

	/* ── текущий вектор цели (без токенов, когда инъекция не нужна) ── */

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
					const limit = Math.max(1, Math.min(10, args.limit ?? 5));
					const ranked = rankMemory(args.query, {
						project: session !== undefined ? sessionMeta(session).project : "",
						kinds: args.kinds ?? [],
						limit,
						minScore: 0.28
					});
					const rows = ranked.picks;
					for (const row of rows) store.punchHit(row.id);
					return {
						hits: rows.map((r, i) => `${i + 1}. [${sourceStamp(r)}] score ${r.score.toFixed(2)} — ${clip(r.text, 300)}`),
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
				name: "memory_source",
				description: "Resolve a memory reference (#ab12cd34) shown in the injected memory block or returned by memory_search into its full source: workspace, session, turn, timestamp and the complete text. Use it before relying on an old note.",
				parameters: {
					type: "object",
					additionalProperties: false,
					required: ["ref"],
					properties: {
						ref: { type: "string", description: "Short reference from the memory block, e.g. #ab12cd34" },
						chars: { type: "integer", description: "How much of the source text to return (default 1200)" }
					}
				},
				output: {
					schema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
					render: (_args, value) => [{ type: "text", text: value.text }]
				},
				async execute(args) {
					const row = store.chunkByRef(args.ref);
					if (row === undefined || row === null) return { text: `Источник «${args.ref}» в памяти не найден — возможно, запись вычищена или ссылка устарела.` };
					const when = new Date(Number(row.ts ?? 0));
					const stamp = Number.isNaN(when.getTime()) ? "—" : when.toISOString().replace("T", " ").slice(0, 16);
					const lines = [
						`Источник ${chunkRef(row.id)}`,
						`— тип: ${row.kind}`,
						`— workspace: ${row.project || "—"}`,
						`— сессия: ${row.session_id || "—"}${row.turn ? `, ход ${row.turn}` : ""}`,
						`— время: ${stamp} (UTC)`,
						`— показов из памяти: ${row.hits ?? 0}`,
						"",
						clip(row.text, Math.max(200, Math.min(4000, args.chars ?? 1200)))
					];
					return { text: lines.join("\n") };
				}
			}));

			disposers.push(ctx.tools.register({
				name: "memory_graph",
				description: "Query the LightRAG knowledge graph: entities and relations extracted from every chat and workspace. Use for cross-project or multi-hop questions ('where did we solve X before', 'what connects A and B') that plain memory_search cannot answer.",
				parameters: {
					type: "object",
					additionalProperties: false,
					required: ["query"],
					properties: {
						query: { type: "string", description: "What to explore in the graph" },
						mode: { type: "string", enum: ["mix", "local", "global", "hybrid", "naive"], description: "Retrieval mode (default: mix)" }
					}
				},
				output: {
					schema: { type: "object", additionalProperties: false, required: ["context", "found"], properties: { context: { type: "string" }, found: { type: "boolean" } } },
					render: (_args, value) => [{ type: "text", text: value.found ? value.context : "Граф ничего не нашёл (или сервис недоступен)." }]
				},
				async execute(args, exec) {
					const session = exec?.agent?.session;
					const project = session !== undefined ? sessionMeta(session).project : "";
					const cached = graphCached(args.query, project);
					const text = cached !== null ? cached : await graphFetch(args.query, project);
					/* ponytail: hard 4k cap — the raw graph dump is tens of KB and would
					   swamp the model; the full text stays available via /api/memory-hub/graph. */
					return { context: clip(text, 4000), found: text.length > 0 };
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

			disposers.push(ctx.tools.register({
				name: "memory_goal",
				description: "Project goal vector: set/confirm the goal of this session or workspace, list active goals, mark one done or dropped. Goals are checked against every later step so the original intent is never lost.",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						action: { type: "string", enum: ["set", "list", "done", "drop"], description: "set = remember/replace the active goal; list = active goals; done/drop = close by id" },
						text: { type: "string", description: "Goal wording for action=set (imperative, 1-2 sentences)" },
						id: { type: "string", description: "Goal id for action=done|drop" },
						project: { type: "string", description: "Limit list to this workspace (default: current)" }
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						required: ["result"],
						properties: { result: { type: "string" } }
					},
					render: (_args, value) => [{ type: "text", text: value.result }]
				},
				async execute(args, execution) {
					const session = execution?.agent?.session ?? execution?.session;
					const meta = session !== undefined ? sessionMeta(session) : { project: "", sessionId: "" };
					const project = String(args?.project ?? meta.project ?? "");
					const action = String(args?.action ?? "list");
					const now = Date.now();
					if (action === "set") {
						const text = clip(String(args?.text ?? ""), 400);
						if (text.length < 8) return { result: "Нужен текст цели (минимум 8 символов)." };
						const id = store.goalCreate(meta.sessionId, project, text, [...embed(text, idfCurrent())], now);
						return { result: `Цель зафиксирована: «${text}» (id ${id}, проект ${project || "—"}). Шаги будут сверяться с ней.` };
					}
					if (action === "done" || action === "drop") {
						const id = String(args?.id ?? "");
						if (id === "") return { result: "Укажите id цели (см. action=list)." };
						store.goalSetStatus(id, action === "done" ? "done" : "dropped", now);
						return { result: `Цель ${id} закрыта как ${action === "done" ? "выполненная" : "снятая"}.` };
					}
					const rows = project !== "" ? store.goalActiveProject(project, 10) : store.goalList(10).filter((g) => g.status === "active");
					if (rows.length === 0) return { result: "Активных целей нет." };
					return {
						result: rows.map((g) => `- ${g.id} · ${clip(g.text, 160)} · проект ${g.project || "—"} · шагов ${g.progress}`).join("\n")
					};
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
			/* read-only search for other clients (dashboard, scripts) — no tokens */
			disposers.push(ctx.webServer.register({
				kind: "exact",
				path: "/api/memory-hub/search",
				handler: (req, res) => {
					try {
						const url = new URL(req.url, "http://localhost");
						const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
						if (q.trim().length < 2) return json(res, { hits: [], count: 0, error: "empty query" });
						const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit") ?? 5)));
						const project = url.searchParams.get("project") ?? "";
						const ranked = rankMemory(q, { project, limit, minScore: Number(url.searchParams.get("min") ?? 0.28) });
						return json(res, {
							count: ranked.picks.length,
							candidates: ranked.candidates,
							expanded: ranked.expanded,
							hits: ranked.picks.map((p) => ({
								ref: chunkRef(p.id),
								kind: p.kind,
								project: p.project,
								score: Number(p.score.toFixed(3)),
								ts: p.ts,
								text: clip(p.text, 600)
							}))
						});
					} catch (e) { warn(ctx, String(e)); return json(res, { hits: [], count: 0, error: String(e) }); }
				}
			}));
			disposers.push(ctx.webServer.register({
				kind: "exact",
				path: "/api/memory-hub/source",
				handler: (req, res) => {
					try {
						const url = new URL(req.url, "http://localhost");
						const ref = url.searchParams.get("ref") ?? "";
						const row = store.chunkByRef(ref);
						return json(res, row === undefined ? { found: false } : {
							found: true,
							ref: chunkRef(row.id),
							id: row.id,
							kind: row.kind,
							project: row.project,
							session: row.session_id,
							turn: row.turn,
							ts: row.ts,
							hits: row.hits,
							text: row.text
						});
					} catch (e) { return json(res, { found: false, error: String(e) }); }
				}
			}));
			/* graph layer: query passthrough + liveness, so the dashboard and other
			   clients can use the same knowledge without touching LightRAG directly */
			disposers.push(ctx.webServer.register({
				kind: "exact",
				path: "/api/memory-hub/graph",
				handler: async (req, res) => {
					try {
						const url = new URL(req.url, "http://localhost");
						const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
						if (q.trim().length < 3) return json(res, { found: false, context: "", error: "empty query" });
						const text = await graphFetch(q, url.searchParams.get("project") ?? "");
						return json(res, { found: text.length > 0, chars: text.length, context: clip(text, 4000), enabled: config.lightragEnabled, url: config.lightragUrl });
					} catch (e) { return json(res, { found: false, error: String(e) }); }
				}
			}));
			disposers.push(ctx.webServer.register({
				kind: "exact",
				path: "/api/memory-hub/lightrag",
				handler: async (req, res) => {
					const out = { enabled: config.lightragEnabled, url: config.lightragUrl, mode: config.lightragMode, topK: config.lightragTopK, ok: false };
					try {
						const ctl = new AbortController();
						const timer = setTimeout(() => ctl.abort(), 3000);
						const health = await fetch(`${String(config.lightragUrl).replace(/\/+$/, "")}/health`, { signal: ctl.signal });
						clearTimeout(timer);
						out.ok = health.ok;
						if (health.ok) {
							const doc = await health.json();
							out.server = { status: doc?.status ?? "", workspace: doc?.workspace ?? "", docs: doc?.pipeline?.documents ?? doc?.documents ?? null };
						}
					} catch (e) { out.error = String(e); }
					out.cache = { entries: graphCache.size, inflight: graphInflight.size, hits: Number(store.metaGet("graphHits") ?? 0), injections: Number(store.metaGet("graphInjections") ?? 0), lastOk: store.metaGet("graphLastOk") ?? "", lastError: store.metaGet("graphError") ?? "" };
					return json(res, out);
				}
			}));
			disposers.push(ctx.webServer.register({
				kind: "exact",
				path: "/api/memory-hub/rebuild",
				handler: (req, res) => {
					try {
						store.metaDel("vecver");
						const ok = runVecMigration();
						return json(res, { ok, vecver: Number(store.metaGet("vecver") ?? 0), stats: store.metaGet("vecverStats") ?? "" });
					} catch (e) { return json(res, { ok: false, error: String(e) }); }
				}
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
			projectSessions: store.sessionCount(),
			goals: store.goalCount(),
			steps: store.stepTotal(),
			skills: store.skillCount(),
			goalGuardHits: Number(store.metaGet("goalGuardHits") ?? 0),
			goalGuardChars: Number(store.metaGet("goalGuardChars") ?? 0),
			routines: store.routineCount(),
			injections: stats.injections,
			injectedChars: stats.injectedChars,
			estimatedTokensSaved: Math.round(stats.injectedChars * 0.26),
			routineHits: stats.routineHits,
			recallHits: stats.recallHits,
			fallbackHits: Number(store.metaGet("fallbackHits") ?? 0),
			graph: {
				enabled: config.lightragEnabled,
				url: config.lightragUrl,
				mode: config.lightragMode,
				hits: Number(store.metaGet("graphHits") ?? 0),
				injections: Number(store.metaGet("graphInjections") ?? 0),
				cacheEntries: graphCache.size,
				lastOk: store.metaGet("graphLastOk") ?? "",
				lastError: store.metaGet("graphError") ?? ""
			},
			/* retrieval internals, so the dashboard shows which index generation runs */
			vocabulary: {
				version: Number(store.metaGet("vecver") ?? 0),
				stems: Number(JSON.parse(store.metaGet("idf") ?? "{}").docCount ?? 0) > 0 ? idfView().map.size : 0,
				associatedTerms: store.assocCount(),
				assocAt: Number(store.metaGet("assocAt") ?? 0),
				lastRebuildAt: Number(store.metaGet("vecverAt") ?? 0),
				lastMaintenanceAt: Number(store.metaGet("maintenanceAt") ?? 0)
			},
			lastEventAt: stats.lastEventAt,
			lastAnalysisAt: Number(store.metaGet("lastAnalysisAt") ?? 0),
			lastMiningAt: Number(store.metaGet("lastMiningAt") ?? 0),
			vault: { path: config.vaultPath, ok: config.vaultSync ? fs.existsSync(config.vaultPath) : false },
			styleSamples: style.samples ?? 0,
			hotTerms: store.hotTerms(10),
			// Effective tuning, so the dashboard and the offline tuner can confirm
			// which numbers the RUNNING plugin actually uses.
			config: {
				recallChars: config.recallChars,
				recallLimit: config.recallLimit,
				minRecallScore: config.minRecallScore,
				recallFallbackScore: config.recallFallbackScore,
				fallbackChars: config.fallbackChars,
				assocTop: config.assocTop,
				assocWeight: config.assocWeight,
				candidateLimit: config.candidateLimit,
				routineMinScore: config.routineMinScore,
				goalDriftMin: config.goalDriftMin,
				goalGuardChars: config.goalGuardChars,
				skillMinScore: config.skillMinScore,
				autoMine: config.autoMine,
				weeklyAnalysis: config.weeklyAnalysis,
				vaultSync: config.vaultSync,
				redact: config.redact,
				excludeProjects: config.excludeProjects,
				privateProjects: config.privateProjects,
				stepRetentionDays: config.stepRetentionDays,
				lightragEnabled: config.lightragEnabled,
				lightragUrl: config.lightragUrl,
				lightragMode: config.lightragMode,
				lightragTopK: config.lightragTopK,
				lightragChars: config.lightragChars,
				lightragWeakBelow: config.lightragWeakBelow,
				lightragAlways: config.lightragAlways,
				lightragCrossWorkspace: config.lightragCrossWorkspace
			}
		};
	}

	/* ── warm-up + lifecycle ── */
	// Прогрев запускаем не в момент старта (boot длится десятки секунд и прогрев
	// конкурировал с ним за главный поток), а через 90 с после старта; сама работа
	// выполняется в idle-колбэке.
	const warmTimer = setTimeout(() => setImmediate(() => {
		runVecMigration();
		runMaintenance();
		runMining(true).finally(() => {
			const last = Number(store.metaGet("lastAnalysisAt") ?? 0);
			if (config.weeklyAnalysis && Date.now() - last >= 7 * 24 * 60 * 60 * 1000) runWeeklyAnalysis();
		});
	}), 90000);
	disposers.push(() => clearTimeout(warmTimer));

	const maintenanceTimer = setInterval(runMaintenance, 6 * 60 * 60 * 1000);
	disposers.push(() => clearInterval(maintenanceTimer));

	ctx.effect?.(() => () => {
		for (const disposer of disposers) {
			try { disposer(); } catch { /* teardown continues */ }
		}
		store.close();
	});
}

/* ── helpers kept top-level ────────────────────────────────────────────── */

const Config = undefined;
/** Internals exposed for offline tests only (not a public API). */
const __test = {
	MemoryStore,
	openDatabase,
	embed,
	cosine,
	coverage,
	stemsOf,
	stemWord,
	rawWords,
	templateKey,
	clip,
	redact,
	chunkRef,
	sourceStamp,
	buildQuery,
	scoreCandidate,
	searchMemory,
	vocabularyRebuild,
	vectorsRebuild,
	associationsBuild,
	normalizeConfig,
	VECTOR_DIM,
	VEC_VERSION
};
export { name, Config, inject, apply, __test };


