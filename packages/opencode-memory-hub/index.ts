// memory-hub bridge for OpenCode v2.2.7 (DSH shared memory)
// Auto-recall (hybrid: hashed TF-IDF cosine + FTS/coverage + recency) + routine matching.
// Reads DSH SQLite read-only for search/recall; writes mining artifacts (tasks/templates/routines)
// with WAL+busy_timeout; saves/ingest turns via Obsidian vault so DSH indexes chunks back.
// Shared across all OpenCode chats/projects/workspaces and with DeepSeek Harness.

import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs"
import { join, basename } from "node:path"
import { randomBytes, createHash } from "node:crypto"

const DB_PATH = "/srv/apps/dsh/memory/ctxdb.sqlite"
const VAULT_PATH = "/srv/apps/dsh/obsidian/vault"
const RECALL_CHARS = 900
const RECALL_LIMIT = 3
const MIN_RECALL_SCORE = 0.32
const ROUTINE_MIN_SCORE = 0.45
const VECTOR_DIM = 4096

type Idf = { map: Map<string, number>; docCount: number }

function openDbRO(): Database | null {
  try { return new Database(DB_PATH, { readonly: true }) } catch { return null }
}
function openDbRW(): Database | null {
  try {
    const db = new Database(DB_PATH)
    try { db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;") } catch {}
    return db
  } catch { return null }
}

function readIdf(db: Database): Idf {
  try {
    const row = db.query(`SELECT value FROM meta WHERE key = 'idf'`).get() as any
    if (!row?.value) return { map: new Map(), docCount: 1 }
    const raw = JSON.parse(String(row.value))
    const df = raw.df ?? raw.map ?? {}
    return { map: new Map(Object.entries(df)), docCount: Number(raw.docCount) || 1 }
  } catch { return { map: new Map(), docCount: 1 } }
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h % VECTOR_DIM
}
function wordsOf(text: string): string[] {
  const out: string[] = []
  const re = /[0-9]*[A-Za-zА-ЯЁа-яё][0-9A-Za-zА-ЯЁа-яё_\-\u0400-\u04FF]*/g
  for (const raw of String(text).match(re) || []) {
    const w = raw.toLowerCase()
    if (w.length < 3 && !/^[0-9]/.test(w)) continue
    out.push(w)
    if (w.length >= 6) out.push(`~${w.slice(0, 4)}`)
  }
  return out
}
function embed(text: string, idf: Idf): Map<number, number> {
  const tf = new Map<string, number>()
  for (const w of wordsOf(text)) if (w.length >= 3) tf.set(w, (tf.get(w) || 0) + 1)
  const vec = new Map<number, number>()
  for (const [w, count] of tf) {
    const df = idf.map.get(w)
    const idfWeight = df === undefined ? 1.8 : Math.log(1 + idf.docCount / (1 + (df as number)))
    const weight = (1 + Math.log(count)) * idfWeight
    const idx = fnv1a(w)
    vec.set(idx, (vec.get(idx) || 0) + weight)
  }
  let norm = 0
  for (const weight of vec.values()) norm += weight * weight
  norm = Math.sqrt(norm) || 1
  for (const [idx, weight] of vec) vec.set(idx, weight / norm)
  return vec
}
function cosine(a: Map<number, number>, b: Map<number, number>): number {
  if (a.size > b.size) [a, b] = [b, a]
  let acc = 0
  for (const [idx, weight] of a) { const other = b.get(idx); if (other !== undefined) acc += weight * other }
  return acc
}
function coverage(query: string, candidate: string): number {
  const qw = wordsOf(query).filter((w) => w.length >= 4 && !w.startsWith("~"))
  if (qw.length === 0 || !candidate) return 0
  const cw = wordsOf(candidate)
  const index = new Set<string>()
  for (const w of cw) {
    index.add(w)
    if (w.length >= 5) index.add(`p:${w.slice(0, 5)}`)
    if (w.length >= 4) index.add(`r:${w.slice(0, 4)}`)
  }
  let hits = 0
  for (const w of qw) if (index.has(w) || index.has(`p:${w}`) || index.has(`r:${w.slice(0, 4)}`)) hits++
  return hits / Math.max(1, Math.min(qw.length, 24))
}
function vecFromJson(raw: string): Map<number, number> {
  try {
    const parsed = JSON.parse(raw || "[]")
    if (Array.isArray(parsed)) {
      if (parsed.length && Array.isArray(parsed[0])) return new Map(parsed as [number, number][])
      const m = new Map<number, number>(); parsed.forEach((v: number, i: number) => { if (v) m.set(i, v) }); return m
    }
    if (parsed && typeof parsed === "object") return new Map(Object.entries(parsed).map(([k, v]) => [Number(k), Number(v)]))
  } catch {}
  return new Map()
}
function ftsQuery(q: string): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).slice(0, 12)
  if (!words.length) return null
  return words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" OR ")
}
function sha256(text: string): string { return createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 32) }
function clip(text: string, max: number): string {
  const t = String(text).replace(/\s+/g, " ").trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`
}

function hybridRecall(db: Database, query: string, limit = RECALL_LIMIT): any[] {
  if (!query || query.trim().length < 12) return []
  const mq = ftsQuery(query)
  if (!mq) return []
  try {
    const idf = readIdf(db)
    const qvec = embed(query, idf)
    const qEcho = String(query).replace(/\s+/g, " ").trim().slice(0, 600)
    const rows = db.query(
      `SELECT c.id,c.kind,c.text,c.project,c.ts,c.vec,bm25(chunks_fts) AS rank
       FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
       WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 200`).all(mq) as any[]
    const recent = db.query(`SELECT id,kind,text,project,ts,vec FROM chunks ORDER BY ts DESC LIMIT 400`).all() as any[]
    const byId = new Map<string, any>()
    for (const r of [...rows, ...recent]) if (r?.id && !byId.has(r.id)) byId.set(r.id, r)
    const now = Date.now()
    const scored: any[] = []
    for (const cand of byId.values()) {
      if (cand.kind === "chat_user" && String(cand.text).replace(/\s+/g, " ").trim().slice(0, 600) === qEcho) continue
      const candVec = vecFromJson(String(cand.vec || "[]"))
      const cos = cosine(qvec, candVec)
      const cov = coverage(query, String(cand.text || ""))
      const ageDays = Math.max(0, (now - (Number(cand.ts) || now)) / 86400000)
      const recency = Math.exp(-ageDays / 45)
      const score = 0.68 * cos + 0.32 * cov + 0.04 * recency
      if (score >= MIN_RECALL_SCORE) scored.push({ ...cand, score, cos, cov })
    }
    scored.sort((a, b) => b.score - a.score)
    const seen = new Set<string>(), picks: any[] = []
    for (const item of scored) {
      if (picks.length >= limit) break
      const key = String(item.text).replace(/\s+/g, " ").trim().slice(0, 72)
      if (seen.has(key)) continue
      seen.add(key); picks.push(item)
    }
    return picks
  } catch { return [] }
}
function formatRecall(picks: any[]): string {
  if (!picks.length) return ""
  const lines: string[] = ["Общая память (все чаты и workspace; подробности — tool memory_search):"]
  let total = lines[0].length
  for (const r of picks) {
    const ws = r.project ? `ws ${r.project}` : "общая"
    const snippet = String(r.text || "").replace(/\s+/g, " ").trim().slice(0, 420)
    const line = `• [${r.kind}, ${ws}] score ${r.score.toFixed(2)} — ${snippet}`
    if (total + line.length + 1 > RECALL_CHARS) break
    lines.push(line); total += line.length + 1
  }
  return lines.length > 1 ? lines.join("\n") : ""
}

/* ── routine fuzzy match (read) ─────────────────────────────────────────── */
function normTokens(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).map((w) => w.replace(/\d+/g, "n").replace(/https?:\S+/g, "url"))
}
function root4(w: string): string { return w.length >= 4 ? w.slice(0, 4) : w }
function routineScore(query: string, sample: string): number {
  const q = normTokens(query), s = normTokens(sample)
  if (!q.length || !s.length) return 0
  const sset = new Set(s)
  let exact = 0, pref = 0, root = 0
  for (const w of q) {
    if (sset.has(w)) { exact++; continue }
    for (const t of s) {
      if (w.length >= 5 && t.length >= 5 && (w.startsWith(t.slice(0, 5)) || t.startsWith(w.slice(0, 5)))) { pref++; break }
      if (root4(w) === root4(t) && root4(w).length >= 4) { root++; break }
    }
  }
  return (exact + 0.7 * pref + 0.5 * root) / q.length
}
function matchRoutine(db: Database, query: string): any | null {
  try {
    const rows = db.query(`SELECT id,name,sample,uses,status,solution FROM routines`).all() as any[]
    let best: any = null
    for (const r of rows) {
      const sc = routineScore(query, r.sample || "")
      if (sc >= ROUTINE_MIN_SCORE && (!best || sc > best._sc)) best = { ...r, _sc: sc }
    }
    return best
  } catch { return null }
}
function routineBlock(r: any): string {
  const sol = String(r.solution || "").replace(/\s+/g, " ").trim().slice(0, Math.floor(RECALL_CHARS * 0.4))
  const kind = r.status === "approved" ? "approved" : "auto"
  return [
    `<routine name="${r.name || r.id}" status="${kind}" score="${r._sc.toFixed(2)}">`,
    "Типовое задание — не разбирай с нуля. Используй известное решение; при расхождении уточни у пользователя.",
    sol ? `Последнее решение: ${sol}` : "Последнее решение: (нет сохранённого решения)",
    "</routine>",
  ].join("\n")
}

/* ── DSH-compatible template/mining (for request→answer pairs) ──────────── */
function templateKey(text: string): string {
  const t = String(text)
    .replace(/<\w+\b[^>]*>[\w\W]*?<\/\w+>/g, " ")
    .replace(/</g, " ")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/[A-Za-z]:[\\/][^\s"'`]+/g, " path ")
    .replace(/\d+(?:\.\d+)*/g, " n ")
    .replace(/["'`«»()\[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return wordsOf(t).join(" ")
}

function writeTaskTemplateRoutine(project: string, sessionId: string, turn: number, userText: string, solution: string) {
  const db = openDbRW()
  if (!db) return
  try {
    const title = clip(userText, 160)
    const key = templateKey(title || userText)
    if (!key) return
    const now = Date.now()
    const tokenId = sha256(`${sessionId}|${turn}|${key}`)
    // task
    db.query(`INSERT INTO tasks (id, project, session_id, turn, title, template_key, solution, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET solution = COALESCE(excluded.solution, tasks.solution), finished_at = COALESCE(tasks.finished_at, excluded.finished_at)`)
      .run(tokenId, project, sessionId, turn, title || clip(userText, 120), key, solution || null, now, now)
    // template
    db.query(`INSERT INTO templates (key, count, last_sample, last_solution, updated_at)
      VALUES (?, 1, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET count = count + 1,
        last_sample = excluded.last_sample,
        last_solution = COALESCE(excluded.last_solution, templates.last_solution),
        updated_at = excluded.updated_at`)
      .run(key, clip(userText, 200), solution ? clip(solution, 900) : null, now)
    // mining: promote templates with count>=2 to routines
    const eligible = db.query(`SELECT key, count, last_sample, last_solution FROM templates WHERE count >= 2 ORDER BY count DESC, updated_at DESC LIMIT 200`).all() as any[]
    for (const row of eligible) {
      const rid = sha256(row.key).slice(0, 12)
      const existing = db.query(`SELECT status, solution FROM routines WHERE id = ?`).get(rid) as any
      const safeName = clip(String(row.last_sample || row.key).replace(/<\w+\b[^>]*>/g, " "), 60).replace(/[\\/:*?"<>|#\[\]{}]/g, "").trim() || rid
      db.query(`INSERT INTO routines (id, name, sample, uses, status, solution, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, sample = excluded.sample,
          uses = max(routines.uses, excluded.uses),
          solution = COALESCE(excluded.solution, routines.solution),
          updated_at = excluded.updated_at`)
        .run(rid, safeName, clip(String(row.last_sample || ""), 200), row.count, existing?.status ?? "auto",
          row.last_solution ?? existing?.solution ?? null, now, now)
      // mirror routine note to vault (DSH ingests it)
      try {
        const dir = join(VAULT_PATH, "Routines"); mkdirSync(dir, { recursive: true })
        const body = [
          "---", "memory-hub: routine", `id: ${rid}`, `uses: ${row.count}`, `status: ${existing?.status ?? "auto"}`, `date: ${new Date(now).toISOString()}`, "---",
          "", "## Суть", clip(String(row.last_sample || ""), 160), "",
          "## Как обычно делалось", row.last_solution ? clip(String(row.last_solution), 900) : "_(решение ещё не зафиксировано)_", "",
        ].join("\n")
        writeFileSync(join(dir, `${safeName.replace(/[^\p{L}\p{N}_ -]/gu, "").trim() || rid}.md`), body, "utf8")
      } catch {}
    }
    db.query(`INSERT INTO meta (key, value) VALUES ('lastMiningAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(now))
  } catch {
    // best-effort: never break the session on mining errors
  } finally {
    try { db.close() } catch {}
  }
}

/* ── helpers: extract text from diverse event shapes ────────────────────── */
function extractUserQuery(event: any): string {
  if (!event) return ""
  const parts: string[] = []
  const push = (v: any) => { if (typeof v === "string" && v.trim()) parts.push(v) }
  push(event.prompt); push(event.text); push(event.input); push(event.message)
  if (Array.isArray(event.messages)) {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i]; if (!m) continue
      const role = m.role || m.type
      if (role && role !== "user") continue
      if (typeof m.content === "string") { push(m.content); break }
      if (Array.isArray(m.content)) { for (const c of m.content) if (c && (c.type === "text" || c.type === "input_text")) push(c.text || c.value); if (parts.length) break }
    }
  }
  if (Array.isArray(event.parts)) for (const p of event.parts) if (p && (p.type === "text" || p.type === "input_text")) push(p.text || p.value)
  // also nested common shapes
  if (event.body?.messages) return extractUserQuery({ messages: event.body.messages })
  return parts.join("\n").trim().slice(-2000)
}

function collectStrings(v: any, out: string[], depth = 0) {
  if (depth > 4 || v == null) return
  if (typeof v === "string") { if (v.trim().length >= 20) out.push(v); return }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, out, depth + 1); return }
  if (typeof v === "object") {
    // prefer text/content fields
    for (const k of ["text", "content", "output", "message", "delta", "value", "result"]) if (k in v) collectStrings(v[k], out, depth + 1)
  }
}
function extractAssistantText(ev: any): string {
  if (!ev) return ""
  // direct
  for (const k of ["text", "content", "output", "message"]) if (typeof ev[k] === "string" && ev[k].length > 40) return ev[k]
  for (const k of ["text", "content", "output"]) if (typeof ev?.data?.[k] === "string" && ev.data[k].length > 40) return ev.data[k]
  // role-tagged
  const role = ev.role || ev?.data?.role || ev?.message?.role
  if (role === "assistant") {
    const c = ev.content ?? ev.message?.content ?? ev.data?.content
    if (typeof c === "string") return c
    if (Array.isArray(c)) return c.filter((x: any) => x?.type === "text" || typeof x === "string").map((x: any) => typeof x === "string" ? x : x.text || "").join("\n")
  }
  // parts/delta
  if (Array.isArray(ev.parts)) {
    const t = ev.parts.filter((p: any) => p?.type === "text").map((p: any) => p.text || "").join("\n")
    if (t.length > 40) return t
  }
  if (Array.isArray(ev?.data?.parts)) {
    const t = ev.data.parts.filter((p: any) => p?.type === "text").map((p: any) => p.text || "").join("\n")
    if (t.length > 40) return t
  }
  return ""
}

function vaultDir(folder: string) { const d = join(VAULT_PATH, folder); mkdirSync(d, { recursive: true }); return d }
function saveNote(folder: string, prefix: string, front: Record<string, string>, text: string): string {
  const dir = vaultDir(folder)
  const ts = new Date().toISOString()
  const id = randomBytes(3).toString("hex")
  const file = join(dir, `${prefix}-${ts.slice(0, 10)}-${id}.md`)
  const body = ["---", ...Object.entries(front).map(([k, v]) => `${k}: ${v}`), "---", "", String(text).trim(), ""].join("\n")
  writeFileSync(file, body, "utf8")
  return file
}

const seenIngest = new Set<string>()
function ingestNote(text: string, extra: Record<string, string> = {}) {
  try {
    const t = String(text || "").replace(/\s+/g, " ").trim()
    if (t.length < 40 || t.length > 6000) return
    const key = sha256(t.slice(0, 2000)).slice(0, 24)
    if (seenIngest.has(key)) return
    seenIngest.add(key)
    if (seenIngest.size > 800) { const first = seenIngest.values().next().value; if (first) seenIngest.delete(first) }
    saveNote("Facts", "oc", { "memory-hub": "note", "source": "opencode-ingest", date: new Date().toISOString(), ...extra }, t)
  } catch {}
}
function ingestPair(userText: string, assistantText: string, sessionId: string, turn: number) {
  try {
    const u = clip(userText, 1200), a = clip(assistantText, 2000)
    if (u.length < 12 || a.length < 40) return
    const key = sha256(`${sessionId}|${turn}|${u.slice(0, 200)}`)
    if (seenIngest.has("pair:" + key)) return
    seenIngest.add("pair:" + key)
    const body = `## Запрос\n${u}\n\n## Ответ/решение\n${a}`
    saveNote("Tasks", "oc-task", { "memory-hub": "note", "source": "opencode-pair", date: new Date().toISOString(), session: sessionId || "opencode" }, body)
    writeTaskTemplateRoutine("opencode", sessionId || "opencode", turn, u, a)
  } catch {}
}

function toolResult(content: string): any { return { content } }

// ── project memory (schema v2, общая с DSH) ───────────────────────────────────
const GOAL_DRIFT_MIN = 0.34
const SKILL_MIN_SCORE = 0.5
const GOAL_GUARD_CHARS = 420
const guardTurn = new Map<string, { turn: number }>()
let stepBufOC: any[] = []

function projectOf(event: any): string {
  const dir = String(event?.directory || event?.cwd || event?.path?.root || event?.project || process.cwd() || "")
  try { return dir ? basename(dir) : "" } catch { return "" }
}

/** Таблицы v2 создаёт DSH-плагин; здесь мягкая проверка — без падений. */
function hasProjectSchema(db: Database): boolean {
  try { db.query("SELECT 1 FROM mh_goals LIMIT 1").get(); return true } catch { return false }
}

function activeGoal(db: Database, sid: string, project: string): any | null {
  try {
    const bySession = db.query("SELECT * FROM mh_goals WHERE session_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1").get(sid)
    if (bySession) return bySession
    if (project) return db.query("SELECT * FROM mh_goals WHERE project = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1").get(project)
  } catch {}
  return null
}

function skillBlock(hit: { row: any; score: number }): string {
  const r = hit.row
  return [
    `<skill name="${clip(String(r.name), 40)}" uses="${r.ok_count}" score="${hit.score.toFixed(2)}">`,
    r.steps ? `Порядок действий из прошлого успеха: ${clip(String(r.steps), 220)}` : "",
    r.artifact ? `Результат: ${clip(String(r.artifact), 120)}` : "",
    "</skill>",
  ].filter(Boolean).join("\n")
}

function skillMatch(db: Database, q: string): { row: any; score: number } | null {
  try {
    const rows = db.query("SELECT name, trigger, steps, artifact, ok_count FROM mh_skills WHERE status = 'active' ORDER BY ok_count DESC LIMIT 20").all() as any[]
    let best: any = null
    let bestScore = 0
    for (const r of rows) {
      const score = coverage(q, `${r.name} ${r.trigger}`)
      if (score > bestScore) { best = r; bestScore = score }
    }
    return bestScore >= SKILL_MIN_SCORE ? { row: best, score: bestScore } : null
  } catch { return null }
}

/** Сверка шага с вектором цели; подсказка навыка. Возвращает блок или null. */
function goalGuardBlock(db: Database, q: string, sid: string, project: string, turn: number): string | null {
  if (!hasProjectSchema(db)) return null
  const goal = activeGoal(db, sid, project)
  const skill = skillMatch(db, q)
  if (!goal) return skill ? skillBlock(skill) : null
  const idf = readIdf(db)
  const sim = cosine(embed(q, idf), new Map(JSON.parse(String(goal.vec || "[]"))))
  const inVector = sim >= GOAL_DRIFT_MIN
  if (inVector && !skill) return null
  const state = guardTurn.get(sid) ?? { turn: -99 }
  if (!skill && turn - state.turn < 2) return null
  guardTurn.set(sid, { turn })
  const parts: string[] = []
  if (!inVector) {
    let steps: any[] = []
    try { steps = db.query("SELECT text FROM mh_steps WHERE session_id = ? ORDER BY ts DESC LIMIT 3").all(sid) as any[] } catch {}
    parts.push(`Вектор цели проекта «${clip(project || "?", 24)}»: ${clip(String(goal.text), 180)}.`)
    if (steps.length) parts.push(`Последние действия: ${steps.map((s: any) => clip(String(s.text), 80)).join(" | ")}.`)
    parts.push(`Текущий запрос слабо связан с целью (cos ${sim.toFixed(2)}) — сверься, не потерян ли основной контекст.`)
  }
  if (skill) parts.push(skillBlock(skill))
  return parts.length ? `Память проекта (сверка с целью):\n${parts.join("\n")}`.slice(0, GOAL_GUARD_CHARS) : null
}

function goalCreate(sid: string, project: string, text: string) {
  const db = openDbRW(); if (!db) return
  try {
    if (!hasProjectSchema(db)) return
    const idf = readIdf(db)
    const id = sha256(`${sid}|${project}|${text}`).slice(0, 16)
    const now = Date.now()
    db.query(`INSERT INTO mh_goals (id, session_id, project, text, vec, status, progress, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`).run(id, sid, project, text, JSON.stringify([...embed(text, idf)]), now, now)
  } catch {} finally { db.close() }
}

function touchSession(sid: string, project: string, title: string) {
  const db = openDbRW(); if (!db) return
  try {
    if (!hasProjectSchema(db)) return
    const now = Date.now()
    db.query(`INSERT INTO mh_sessions (session_id, project, title, started_at, updated_at, turns) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at, turns = mh_sessions.turns + 1,
      title = CASE WHEN mh_sessions.title = '' THEN excluded.title ELSE mh_sessions.title END`).run(sid, project, clip(title, 120), now, now)
  } catch {} finally { db.close() }
}

function pushStep(sid: string, project: string, turn: number, kind: string, name: string, text: string, ok = 1) {
  stepBufOC.push({ id: sha256(`${sid}|${Date.now()}|${stepBufOC.length}`).slice(0, 24), sid, project, turn, ts: Date.now(), kind, name: clip(name, 40), text: clip(text, 500), ok })
  if (stepBufOC.length >= 24) flushStepsOC()
}

function flushStepsOC() {
  if (!stepBufOC.length) return
  const batch = stepBufOC.splice(0, stepBufOC.length)
  const db = openDbRW(); if (!db) return
  try {
    if (!hasProjectSchema(db)) return
    const stmt = db.query("INSERT OR REPLACE INTO mh_steps (id, session_id, project, turn, ts, kind, name, text, ok, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')")
    db.exec("BEGIN")
    try {
      for (const s of batch) stmt.run(s.id, s.sid, s.project, s.turn, s.ts, s.kind, s.name, s.text, s.ok)
      db.exec("COMMIT")
    } catch (e) { try { db.exec("ROLLBACK") } catch {} }
  } catch {} finally { db.close() }
}

/** Конспект сессии + навык (Hermes: опыт → переиспользуемый навык). */
function finalizeSession(sid: string, project: string, userText: string, solution: string) {
  flushStepsOC()
  const db = openDbRW(); if (!db) return
  try {
    if (!hasProjectSchema(db)) return
    const idf = readIdf(db)
    const now = Date.now()
    const summary = clip([clip(userText, 200), clip(solution, 420)].filter(Boolean).join(" → "), 620)
    if (summary.length >= 40) {
      db.query("UPDATE mh_sessions SET summary = ?, vec = ?, updated_at = ? WHERE session_id = ?")
        .run(summary, JSON.stringify([...embed(summary, idf)]), now, sid)
    }
    const tkey = templateKey(userText)
    if (solution.length >= 80 && tkey.length >= 8) {
      const id = sha256(`skill|${tkey}`).slice(0, 16)
      db.query(`INSERT INTO mh_skills (id, tkey, project, name, trigger, vec, steps, artifact, ok_count, fail_count, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'proposed', ?, ?)
        ON CONFLICT(id) DO UPDATE SET ok_count = ok_count + 1,
          project = excluded.project, name = excluded.name, trigger = excluded.trigger,
          steps = excluded.steps, artifact = excluded.artifact,
          status = CASE WHEN mh_skills.ok_count + 1 >= 2 THEN 'active' ELSE mh_skills.status END,
          updated_at = excluded.updated_at`)
        .run(id, tkey, project, clip(userText, 60), clip(userText, 200), JSON.stringify([...embed(tkey, idf)]), clip(solution, 420), clip(solution, 300), now, now)
    }
  } catch {} finally { db.close() }
}

export default {
  id: "memory-hub",
  async setup(ctx: any) {
    const turns = new Map<string, { turn: number; user: string; startedAt: number; sessionId: string }>()
    let globalTurn = 0

    // --- auto recall + user-turn ingest + pair tracking ---
    try {
      ctx.session?.hook?.("prompt", async (event: any) => {
        const q = extractUserQuery(event)
        if (!q || q.length < 12) return
        const sid = String(event?.sessionID || event?.sessionId || event?.session?.id || "opencode")
        const project = projectOf(event)
        globalTurn++
        turns.set(sid, { turn: globalTurn, user: q, startedAt: Date.now(), sessionId: sid })
        ingestNote(q, { role: "user" })
        touchSession(sid, project, q)
        const db = openDbRO()
        if (!db) return
        try {
          try { if (hasProjectSchema(db) && !activeGoal(db, sid, project) && q.length >= 12) goalCreate(sid, project, clip(q, 400)) } catch {}
          const blocks: string[] = []
          const guard = goalGuardBlock(db, q, sid, project, globalTurn); if (guard) blocks.push(guard)
          const r = matchRoutine(db, q); if (r) blocks.push(routineBlock(r))
          const rec = formatRecall(hybridRecall(db, q, RECALL_LIMIT)); if (rec) blocks.push(rec)
          if (!blocks.length) return
          return { system: [blocks.join("\n\n")] }
        } finally { db.close() }
      })
    } catch {}

    // --- event ingest: capture assistant text and close pairs ---
    try {
      const ac = new AbortController()
      const sub = ctx.event?.subscribe?.({ signal: ac.signal })
      if (sub && typeof (sub as any)[Symbol.asyncIterator] === "function") {
        ;(async () => {
          try {
            for await (const ev of sub as any) {
              const t = String(ev?.type || ev?.event || ev?.name || "")
              const sid = String(ev?.sessionID || ev?.sessionId || ev?.data?.sessionID || ev?.data?.sessionId || "opencode")
              // шаги проекта: вызовы инструментов и команды внутри workspace
              if (/tool|command|bash|shell|exec/i.test(t)) {
                try {
                  const blobs: string[] = []
                  collectStrings(ev, blobs)
                  const body = blobs.sort((a, b) => b.length - a.length)[0] || ""
                  if (body.trim().length >= 4) {
                    const openTurn = turns.get(sid)
                    pushStep(sid, projectOf(ev), openTurn?.turn ?? 0, /bash|shell|command|exec/i.test(t) ? "command" : "tool", t, body)
                  }
                } catch {}
              }
              // capture assistant text
              let atext = extractAssistantText(ev)
              if (!atext) {
                // heuristic: assistant-ish events with substantial text blobs
                if (/assistant|message|response|output|part|delta|complete|finish/i.test(t)) {
                  const blobs: string[] = []; collectStrings(ev, blobs)
                  atext = blobs.sort((a, b) => b.length - a.length)[0] || ""
                }
              }
              if (atext && atext.trim().length >= 40) {
                ingestNote(clip(atext, 3000), { role: "assistant" })
                const open = turns.get(sid)
                if (open && Date.now() - open.startedAt < 30 * 60 * 1000) {
                  ingestPair(open.user, atext, sid, open.turn)
                  finalizeSession(sid, projectOf(ev), open.user, atext)
                  turns.delete(sid)
                }
              }
              // turn/idle end without captured text: still record the user task
              if (/idle|turn\.end|session\.idle|finish/i.test(t)) {
                const open = turns.get(sid)
                if (open && Date.now() - open.startedAt < 30 * 60 * 1000) {
                  writeTaskTemplateRoutine("opencode", sid, open.turn, open.user, "")
                  finalizeSession(sid, projectOf(ev), open.user, "")
                  turns.delete(sid)
                }
              }
            }
          } catch {}
        })()
      }
    } catch {}

    // --- tools ---
    try {
      ctx.tool?.transform?.((editor: any) => {
        editor.add({
          name: "memory_goal",
          description: "Цель проекта: зафиксировать, показать или закрыть. Цели лежат в общей базе DSH, сверяются со следующими шагами и подтягивают конспект проекта.",
          input: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["set", "list", "done", "drop"] },
              text: { type: "string" },
              id: { type: "string" },
              project: { type: "string" },
            },
            required: ["action"],
          },
          async execute(input: any) {
            const action = String(input?.action || "list")
            let project = String(input?.project || "")
            if (!project) { try { project = basename(process.cwd()) } catch {} }
            if (action === "set") {
              const text = clip(String(input?.text || "").trim(), 400)
              if (text.length < 8) return toolResult("Нужен текст цели (минимум 8 символов).")
              goalCreate("opencode", project, text)
              return toolResult(`Цель зафиксирована для проекта «${project || "—"}»: ${text}`)
            }
            if (action === "done" || action === "drop") {
              const id = String(input?.id || "")
              if (!id) return toolResult("Укажите id цели (action=list).")
              const db = openDbRW(); if (!db) return toolResult("База недоступна.")
              try {
                if (!hasProjectSchema(db)) return toolResult("Схема проектной памяти ещё не создана: нужен запуск DSH-плагина.")
                db.query("UPDATE mh_goals SET status = ?, updated_at = ? WHERE id = ?").run(action === "done" ? "done" : "dropped", Date.now(), id)
              } catch (e: any) { return toolResult("Ошибка: " + (e?.message || e)) } finally { db.close() }
              return toolResult(`Цель ${id} закрыта как ${action === "done" ? "выполненная" : "снятая"}.`)
            }
            const db = openDbRO(); if (!db) return toolResult("База недоступна: " + DB_PATH)
            try {
              const rows = project
                ? (db.query("SELECT id, text, project, progress FROM mh_goals WHERE project = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 10").all(project) as any[])
                : (db.query("SELECT id, text, project, progress FROM mh_goals WHERE status = 'active' ORDER BY updated_at DESC LIMIT 10").all() as any[])
              if (!rows.length) return toolResult("Активных целей нет.")
              return toolResult(rows.map((g: any) => `- ${g.id} · ${clip(String(g.text), 160)} · проект ${g.project || "—"} · шагов ${g.progress}`).join("\n"))
            } catch { return toolResult("Схема проектной памяти ещё не создана.") } finally { db.close() }
          },
        })
        editor.add({
          name: "memory_search",
          description: "Гибридный поиск по общей памяти DSH (вектор cosine + покрытие + свежесть, все чаты/workspace). Вызывай перед повтором известной работы.",
          input: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", default: 5 } }, required: ["query"] },
          async execute(input: any) {
            const db = openDbRO(); if (!db) return toolResult("База памяти недоступна: " + DB_PATH)
            try {
              const rows = hybridRecall(db, String(input?.query || ""), Math.max(1, Math.min(20, Number(input?.limit) || 5)))
              if (!rows.length) return toolResult("Ничего релевантного не найдено в общей памяти.")
              return toolResult(rows.map((r: any, i: number) => `${i + 1}. [${r.kind}, ${r.project ? "ws " + r.project : "общая"}] score ${r.score.toFixed(2)} — ${String(r.text || "").replace(/\s+/g, " ").trim().slice(0, 600)}`).join("\n"))
            } finally { db.close() }
          },
        })
        editor.add({
          name: "memory_save",
          description: "Сохранить факт/заметку в общую память (через Obsidian vault; DSH проиндексирует автоматически).",
          input: { type: "object", properties: { kind: { type: "string", enum: ["fact", "note"] }, text: { type: "string" } }, required: ["kind", "text"] },
          async execute(input: any) {
            const text = String(input?.text || "").trim()
            if (text.length < 8) return toolResult("Текст слишком короткий для сохранения.")
            try { return toolResult(`✅ Сохранено в общую память (vault). DSH проиндексирует: ${saveNote("Facts", input?.kind === "note" ? "note" : "fact", { "memory-hub": input?.kind === "note" ? "note" : "fact", source: "opencode", date: new Date().toISOString() }, text)}`) }
            catch (e: any) { return toolResult(`Ошибка сохранения: ${e?.message || e}`) }
          },
        })
        editor.add({
          name: "memory_routines",
          description: "Список выученных рутин/шаблонов из общей памяти DSH (чтение).",
          input: { type: "object", properties: { limit: { type: "number", default: 20 } } },
          async execute(input: any) {
            const db = openDbRO(); if (!db) return toolResult("База памяти недоступна: " + DB_PATH)
            try {
              const rows = db.query(`SELECT id,name,sample,uses,status,solution FROM routines ORDER BY uses DESC, updated_at DESC LIMIT ?`).all(Math.max(1, Math.min(100, Number(input?.limit) || 20))) as any[]
              if (!rows.length) return toolResult("Рутин пока нет.")
              return toolResult(rows.map((r: any, i: number) => `${i + 1}. [${r.status}] ${r.name} (uses=${r.uses}) — ${String(r.sample || "").slice(0, 120)}${r.solution ? " | решение: " + String(r.solution).replace(/\s+/g, " ").slice(0, 140) : ""}`).join("\n"))
            } finally { db.close() }
          },
        })
        editor.add({
          name: "memory_style",
          description: "Профиль стиля автора по общей памяти DSH (эвристика). Вызывай перед длинными текстами.",
          input: { type: "object", properties: {} },
          async execute() {
            const db = openDbRO(); if (!db) return toolResult("База памяти недоступна: " + DB_PATH)
            try {
              const rows = db.query(`SELECT text FROM chunks WHERE kind IN ('chat_user','fact','note','doc') ORDER BY ts DESC LIMIT 200`).all() as any[]
              const texts = rows.map((r) => String(r.text || "").trim()).filter((t) => t.length > 20)
              if (!texts.length) return toolResult("Недостаточно данных для профиля стиля.")
              let ru = 0, en = 0, md = 0, emoji = 0, totalLen = 0, sents = 0
              for (const t of texts) { totalLen += t.length; ru += (t.match(/[а-яё]/gi) || []).length; en += (t.match(/[a-z]/gi) || []).length; md += (t.match(/(^#{1,6}\s|```|[*_`>-])/gm) || []).length; emoji += (t.match(/\p{Extended_Pictographic}/gu) || []).length; sents += (t.match(/[.!?]+(\s|$)/g) || [1]).length }
              const lang = ru > en * 1.2 ? "преимущественно русский" : en > ru * 1.2 ? "преимущественно английский" : "смешанный RU/EN"
              return toolResult([`Профиль стиля (эвристика, ${texts.length} записей):`, `- Язык: ${lang} (RU≈${ru}, EN≈${en})`, `- Средняя длина: ~${Math.round(totalLen / texts.length)} симв., ~${sents ? Math.round(totalLen / sents) : 0} симв./предложение`, `- Markdown: ${md > texts.length ? "активно" : md > texts.length / 4 ? "умеренно" : "редко"}, эмодзи: ${emoji > texts.length / 2 ? "встречаются" : "редки/нет"}`].join("\n"))
            } finally { db.close() }
          },
        })
        editor.add({
          name: "memory_analyze",
          description: "Сводка/анализ по общей памяти DSH (статистика, незавершённые задачи, последний отчёт из vault/Аналитика).",
          input: { type: "object", properties: {} },
          async execute() {
            const db = openDbRO(); if (!db) return toolResult("База памяти недоступна: " + DB_PATH)
            try {
              const stat = (q: string) => { try { return (db.query(q).get() as any)?.n ?? 0 } catch { return 0 } }
              const lines = [`Анализ общей памяти DSH:`, `- Чанки: ${stat("SELECT COUNT(*) n FROM chunks")}, задачи: ${stat("SELECT COUNT(*) n FROM tasks")}, рутины: ${stat("SELECT COUNT(*) n FROM routines")}, шаблоны: ${stat("SELECT COUNT(*) n FROM templates")}`]
              const openTasks = db.query(`SELECT title,project FROM tasks WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 8`).all() as any[]
              if (openTasks.length) { lines.push("- Незавершённые задачи:"); for (const t of openTasks) lines.push(`  • ${String(t.title || "(без названия)").slice(0, 120)}${t.project ? ` [ws ${t.project}]` : ""}`) }
              else lines.push("- Незавершённых задач не найдено.")
              try {
                const dir = join(VAULT_PATH, "Аналитика")
                const files = readdirSync(dir).filter((f: string) => f.endsWith(".md")).sort().reverse()
                if (files.length) { lines.push("", "Последний отчёт (фрагмент):", readFileSync(join(dir, files[0]), "utf8").slice(0, 1200).trim()) }
              } catch {}
              return toolResult(lines.join("\n"))
            } finally { db.close() }
          },
        })
      })
    } catch {}

    return () => {}
  },
}

export const id = "memory-hub"
