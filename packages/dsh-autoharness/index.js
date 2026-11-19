/**
 * dsh-autoharness — a self-maintaining skill layer for DeepSeek Harness.
 *
 * Port of the architecture of tigerless-labs/autoharness (MIT) onto DSH mechanisms:
 *
 *   CAP   capture    session/event → redacted, byte-bounded JSONL window per session
 *   REF   reflect    every N tool calls a spawn-subagent reads the window and PROPOSES intents
 *   promoter         the only writer: validates in memory, then atomic-renames SKILL.md into place
 *   IDX   surface    a systemPrompt context lists the skills this plugin wrote
 *   MNG   lifecycle  adherence-based: probation → graduation review → capacity contention → archive
 *   curator          periodic whole-library merge pass (near-duplicate folding)
 *   LED   ledger     per-skill append-only JSONL with the reason and an evidence slice
 *
 * Design invariants borrowed from the original:
 *  - the reflector proposes, it never writes; a guard denies write tools to child sessions;
 *  - only self-authored skills (sidecar marker) are ever touched/archived;
 *  - survival is measured by use per request opportunity, not by wall-clock, and absence of
 *    evidence is not treated as evidence of absence (view counts spare a skill);
 *  - retirement is a move to .archive/, never a delete.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

/** Loader identity. */
export const name = "autoharness";
/** Prompt surface and the tool registry are mandatory; `subagents` is reached through ctx.get(). */
export const inject = ["systemPrompt", "tools"];
/** Config is a plain object from cordis.patch.yml (no schema dependency). */
export const Config = undefined;

const STATE_VERSION = 1;
const CAPTURE_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "fs_write", "notebook_edit"]);
const SHELL_TOOLS = new Set(["bash", "pwsh"]);
const VIEW_TOOLS = new Set(["read", "grep", "glob", "ls"]);
const SELF_SIDECAR = ".autoharness.json";
const SELF_LEDGER = ".ledger.jsonl";
const SELF_EVIDENCE = "references";
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_DESC = 1024;

/* ────────────────────────────── config ─────────────────────────────── */

function normalizeConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const int = (key, def, min, max) => {
    const v = c[key];
    return Number.isInteger(v) && v >= min && (max === undefined || v <= max) ? v : def;
  };
  const bool = (key, def) => (c[key] === undefined ? def : Boolean(c[key]));
  const str = (key, def) => (typeof c[key] === "string" && c[key].trim() !== "" ? c[key].trim() : def);
  return {
    enabled: c.enabled !== false,
    reflectEveryN: int("reflectEveryN", 50, 1, 10_000),
    consolidateEveryN: int("consolidateEveryN", 250, 0, 100_000),
    maturityGlobal: int("maturityGlobal", 300, 0, 1_000_000),
    maturityProject: int("maturityProject", 100, 0, 1_000_000),
    capacityGlobal: int("capacityGlobal", 20, 0, 10_000),
    capacityProject: int("capacityProject", 50, 0, 10_000),
    skillPrefix: str("skillPrefix", "ah-"),
    layer: str("layer", "global") === "project" ? "project" : "global",
    provider: str("provider", "spawn"),
    indexSuspended: bool("indexSuspended", false),
    indexMaxBytes: int("indexMaxBytes", 1800, 200, 20_000),
    captureMaxRecordBytes: int("captureMaxRecordBytes", 4000, 256, 200_000),
    captureMaxWindowBytes: int("captureMaxWindowBytes", 200_000, 4096, 5_000_000),
    maxBodyLines: int("maxBodyLines", 60, 3, 400),
    stateDir: str("stateDir", null),
    graderOnly: bool("graderOnly", false),
  };
}

/* ────────────────────────────── paths ──────────────────────────────── */

function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim() !== "" && fs.existsSync(env)) return env;
  return path.join(os.homedir(), ".dsh");
}

function findProjectRoot(start) {
  let dir = start;
  for (let i = 0; i < 40; i += 1) {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
    } catch { /* keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Project skills root follows the session cwd reported by DSH events, not the host process cwd. */
function projectSkillsRoot(cwd) {
  const proj = findProjectRoot(cwd);
  return proj === null ? path.join(cwd, ".dsh", "skills") : path.join(proj, ".dsh", "skills");
}

/* ──────────────────────────── file utils ───────────────────────────── */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function atomicWrite(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendLine(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function sha(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function clip(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 14))}…[truncated]`;
}

/** Conservative secret redaction applied at capture egress and again before landing evidence. */
function redact(text) {
  let s = String(text ?? "");
  const rules = [
    /\b(sk-[A-Za-z0-9_-]{10,})\b/g,
    /\b(gh[pousr]_[A-Za-z0-9]{10,})\b/g,
    /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g,
    /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*("[^"\n]{3,}"|'[^'\n]{3,}'|[^\s"',}]{4,})/gi,
    /\b([A-Za-z0-9+/]{40,}={0,2})\b/g,
  ];
  for (const re of rules) {
    s = s.replace(re, (match, prefix) => {
      if (match.startsWith("Bearer ")) return `${prefix}[redacted]`;
      if (typeof prefix === "string" && /^(password|passwd|secret|token|api)/i.test(prefix)) return `${prefix}: [redacted]`;
      return "[redacted]";
    });
  }
  return s;
}

/** Bound an arbitrary JSON value: strings clipped, arrays sliced, depth limited. */
function trimValue(value, budget, depth = 0) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return clip(value, budget);
    return value;
  }
  if (depth >= 6) return "…[depth]";
  if (Array.isArray(value)) {
    return value.slice(0, 24).map((v) => trimValue(v, Math.max(64, Math.floor(budget / 4)), depth + 1));
  }
  const out = {};
  const keys = Object.keys(value).slice(0, 32);
  for (const key of keys) {
    if (/^(signal|abort|controller)$/i.test(key)) continue;
    out[key] = trimValue(value[key], Math.max(64, Math.floor(budget / 4)), depth + 1);
  }
  return out;
}

/* ──────────────────────── skill file manipulation ──────────────────── */

function parseFrontmatter(text) {
  const s = String(text ?? "");
  if (!s.startsWith("---")) return { data: {}, body: s };
  const end = s.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: s };
  const head = s.slice(3, end);
  const body = s.slice(end + 4).replace(/^\r?\n/, "");
  const data = {};
  for (const line of head.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (m === null) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[m[1]] = value;
  }
  return { data, body };
}

function renderSkill({ name: skillName, description, whenToUse, body }) {
  const lines = ["---", `name: ${skillName}`, `description: ${JSON.stringify(description)}`];
  if (typeof whenToUse === "string" && whenToUse.trim() !== "") lines.push(`whenToUse: ${JSON.stringify(whenToUse)}`);
  lines.push("---", "", body.replace(/\s+$/, ""), "");
  return lines.join("\n");
}

function skillDirOf(root, skillName) {
  return path.join(root, skillName);
}

function readSelfSkill(root, skillName) {
  const dir = skillDirOf(root, skillName);
  const side = readJson(path.join(dir, SELF_SIDECAR), null);
  if (side === null || side.created_by !== "autoharness") return null;
  let text = null;
  try {
    text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const parsed = parseFrontmatter(text);
  return { dir, sidecar: side, text, body: parsed.body, description: parsed.data.description ?? "" };
}

function listSelfSkills(root) {
  const rows = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return rows;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const found = readSelfSkill(root, entry.name);
    if (found !== null) rows.push({ name: entry.name, ...found });
  }
  return rows;
}

/* ────────────────────────────── plugin ─────────────────────────────── */

/**
 * Mount the self-learning layer.
 * @param ctx - plugin context with `systemPrompt`; `tools` and `subagents` are used when present.
 * @param rawConfig - plain config object from the profile patch.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) {
    ctx.logger?.info?.("autoharness: disabled by config");
    return;
  }

  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`autoharness: ${message}`);
    } catch { /* logging must never break a session */ }
  };

  const stateRoot = ensureDir(config.stateDir ?? path.join(dshHome(), "autoharness"));
  const dirs = {
    root: stateRoot,
    capture: ensureDir(path.join(stateRoot, "capture")),
    runs: ensureDir(path.join(stateRoot, "runs")),
    intents: ensureDir(path.join(stateRoot, "intents")),
    sessions: ensureDir(path.join(stateRoot, "sessions")),
    requests: ensureDir(path.join(stateRoot, "requests")),
  };

  let currentCwd = process.cwd();
  const rootsFor = () => ({ global: path.join(dshHome(), "skills"), project: projectSkillsRoot(currentCwd) });
  ensureDir(rootsFor().global);

  /** Sessions spawned by this plugin: never counted, never re-triggered, never allowed to write. */
  const children = new Set(readJson(path.join(stateRoot, "children.json"), []));
  const persistChildren = () => writeJson(path.join(stateRoot, "children.json"), [...children].slice(-200));

  /** sessionId → live Agent, captured at agent/created. */
  const agents = new Map();
  /** sessionId → tool calls counted toward the next reflection. */
  const calls = new Map();
  // The numerator must survive a remount (plugin upgrade, profile reload), otherwise
  // every restart silently resets the "N tool calls" trigger back to zero.
  try {
    const persisted = JSON.parse(fs.readFileSync(path.join(dirs.sessions, "counters.json"), "utf8"));
    for (const [sessionId, count] of Object.entries(persisted)) {
      const value = Number(count);
      if (Number.isFinite(value) && value > 0) calls.set(sessionId, value);
    }
  } catch { /* first run */ }
  /** runId → { sessionId, startedAt, intents } registered before a reflector is spawned. */
  const pendingRuns = new Map();
  let lastIndex = { at: 0, text: "" };

  /* ── counters ── */

  const requestsFile = (level) =>
    path.join(dirs.requests, `${level}-${sha(level === "project" ? rootsFor().project : rootsFor().global).slice(0, 12)}.json`);

  function bumpRequests(level) {
    const file = requestsFile(level);
    const value = Number(readJson(file, { n: 0 }).n ?? 0) + 1;
    writeJson(file, { n: value });
    return value;
  }

  function requestCount(level) {
    return Number(readJson(requestsFile(level), { n: 0 }).n ?? 0);
  }

  /* ── CAP: capture a redacted, bounded window per session ── */

  function captureFile(sessionId) {
    return path.join(dirs.capture, `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`);
  }

  function capture(session, event) {
    const sessionId = String(session?.id ?? "");
    if (sessionId === "" || !CAPTURE_TYPES.has(event?.type)) return;
    if (children.has(sessionId)) return;
    const data = event?.data ?? {};
    if (data?.source?.kind === "autoharness") return;
    const record = {
      seq: event.seq ?? 0,
      type: event.type,
      at: new Date().toISOString(),
      data: trimValue(data, config.captureMaxRecordBytes),
    };
    const line = `${redact(JSON.stringify(record))}\n`;
    const file = captureFile(sessionId);
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, line, "utf8");
    rotateCapture(sessionId);
  }

  function rotateCapture(sessionId) {
    const file = captureFile(sessionId);
    try {
      const size = fs.statSync(file).size;
      if (size <= config.captureMaxWindowBytes) return;
      const buf = fs.readFileSync(file, "utf8");
      const tail = buf.slice(Math.max(0, buf.length - config.captureMaxWindowBytes));
      const cut = tail.indexOf("\n");
      atomicWrite(file, cut === -1 ? tail : tail.slice(cut + 1));
    } catch { /* rotation is best effort */ }
  }

  /** Snapshot the capture file into a run-scoped window and truncate the live file. */
  function snapshotWindow(sessionId, runId) {
    const file = captureFile(sessionId);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      text = "";
    }
    const bounded = text.length > config.captureMaxWindowBytes ? text.slice(-config.captureMaxWindowBytes) : text;
    const target = path.join(dirs.runs, `${runId}.window.jsonl`);
    atomicWrite(target, bounded);
    atomicWrite(file, "");
    const lines = bounded.split("\n").filter((l) => l.trim() !== "").length;
    if (lines === 0) return null;
    const toolCalls = bounded.split("\n").filter((l) => l.includes('"type":"tool/result"')).length;
    return { path: target, bytes: Buffer.byteLength(bounded, "utf8"), lines, toolCalls };
  }

  /* ── IDX: the index injected at session start ── */

  function buildIndex() {
    if (config.indexSuspended) return "";
    const now = Date.now();
    if (now - lastIndex.at < 3000) return lastIndex.text;
    const groups = [];
    const allRoots = rootsFor();
    for (const level of ["global", "project"]) {
      const rows = listSelfSkills(allRoots[level]).sort((a, b) => a.name.localeCompare(b.name));
      if (rows.length === 0) continue;
      const items = rows.map((row) => {
        const desc = clip(String(row.sidecar.description ?? row.description ?? "").replace(/\s+/g, " "), 70);
        const flags = [];
        if (Number(row.sidecar.use ?? 0) > 0) flags.push(`use ${row.sidecar.use}`);
        if (Number(row.sidecar.view ?? 0) > 0) flags.push(`view ${row.sidecar.view}`);
        return `• ${row.name}${desc === "" ? "" : ` — ${desc}`}${flags.length === 0 ? "" : ` (${flags.join(", ")})`}`;
      });
      groups.push([`## ${level === "global" ? "global" : "project"} skills (written by autoharness)`, ...items].join("\n"));
    }
    if (groups.length === 0) {
      lastIndex = { at: now, text: "" };
      return "";
    }
    const lastRun = readJson(path.join(dirs.root, "last_run.json"), null);
    const summary = lastRun === null
      ? ""
      : `\n\nlast learning run: ${lastRun.landed?.length ?? 0} landed, ${lastRun.rejected?.length ?? 0} rejected${lastRun.at ? ` at ${String(lastRun.at).slice(0, 16)}` : ""}`;
    let text = [
      "Skills you learned yourself in earlier sessions (load with the `skill` tool when a task matches):",
      groups.join("\n\n"),
      summary,
    ].join("\n");
    if (Buffer.byteLength(text, "utf8") > config.indexMaxBytes) {
      while (Buffer.byteLength(text, "utf8") > config.indexMaxBytes && text.includes("\n• ")) {
        text = text.slice(0, text.lastIndexOf("\n• "));
      }
      if (Buffer.byteLength(text, "utf8") > config.indexMaxBytes) text = clip(text, config.indexMaxBytes);
    }
    lastIndex = { at: now, text };
    return text;
  }

  try {
    const order = typeof ctx.systemPrompt.getContextOrder === "function"
      ? (() => {
        try {
          return ctx.systemPrompt.getContextOrder("SUBAGENT_DELEGATION") + 40;
        } catch {
          return 4000;
        }
      })()
      : 4000;
    ctx.systemPrompt.context({
      name: "autoharness:index",
      order,
      required: false,
      interpolate: false,
      text: () => {
        try {
          return buildIndex();
        } catch (error) {
          log("warn", `index failed: ${String(error)}`);
          return "";
        }
      },
    });
  } catch (error) {
    log("warn", `systemPrompt registration failed: ${String(error)}`);
  }

  /* ── promoter: the only writer ── */

  function validateIntent(intent) {
    const findings = [];
    const action = String(intent?.action ?? "");
    if (!["create", "update", "patch", "delete", "remove_file"].includes(action)) findings.push(`unknown action ${action}`);
    const skillName = String(intent?.name ?? "");
    if (!NAME_RE.test(skillName)) findings.push(`invalid skill name ${JSON.stringify(skillName)}`);
    if (action === "create" && config.skillPrefix !== "" && !skillName.startsWith(config.skillPrefix)) {
      findings.push(`new skill names must start with ${JSON.stringify(config.skillPrefix)}`);
    }
    if (String(intent?.reason ?? "").trim().length < 8) findings.push("reason is required (>= 8 chars)");
    if (action === "create" || action === "update") {
      const description = String(intent?.description ?? "").replace(/\s+/g, " ").trim();
      if (action === "create" && description.length < 8) findings.push("description is required (>= 8 chars)");
      if (description.length > MAX_DESC) findings.push(`description exceeds ${MAX_DESC} chars`);
      const body = String(intent?.body ?? "");
      if (body.trim().length < 20) findings.push("body is required (>= 20 chars)");
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > 100_000) findings.push("body exceeds 100 KB");
      const nonEmpty = body.split("\n").filter((l) => l.trim() !== "").length;
      if (nonEmpty > config.maxBodyLines) findings.push(`body has ${nonEmpty} non-empty lines (max ${config.maxBodyLines}) — write a rule, not a transcript`);
    }
    if (action === "patch") {
      const oldString = String(intent?.old_string ?? "");
      if (oldString.trim() === "") findings.push("patch requires old_string");
      if (String(intent?.new_string ?? "") === "") findings.push("patch requires new_string");
    }
    return findings;
  }

  function resolveLayer(skillName, wanted) {
    const allRoots = rootsFor();
    const hits = [];
    for (const level of ["global", "project"]) {
      if (readSelfSkill(allRoots[level], skillName) !== null) hits.push(level);
    }
    if (hits.length > 1) return { error: `skill ${skillName} exists in both layers` };
    if (wanted === "project" || wanted === "global") {
      if (hits.length === 1 && hits[0] !== wanted) return { error: `skill ${skillName} lives in the ${hits[0]} layer` };
      return { level: wanted };
    }
    if (hits.length === 0) return { error: `skill ${skillName} not found` };
    return { level: hits[0] };
  }

  function promoteIntent(intent) {
    const findings = validateIntent(intent);
    if (findings.length > 0) return { ok: false, name: intent?.name, action: intent?.action, findings };
    const action = intent.action;
    const wanted = intent.level === "project" || intent.level === "global" ? intent.level : undefined;
    const resolved = action === "create" ? { level: wanted ?? config.layer } : resolveLayer(intent.name, wanted);
    if (resolved.error !== undefined) return { ok: false, name: intent.name, action, findings: [resolved.error] };
    const level = resolved.level;
    const root = rootsFor()[level];
    ensureDir(root);
    const dir = skillDirOf(root, intent.name);

    if (action === "create" && fs.existsSync(dir)) return { ok: false, name: intent.name, action, findings: ["target already exists"] };
    if (action !== "create") {
      const live = readSelfSkill(root, intent.name);
      if (live === null) return { ok: false, name: intent.name, action, findings: ["not a self-authored skill in this layer"] };
      if (action === "patch") {
        const occurrences = live.body.split(intent.old_string).length - 1;
        if (occurrences !== 1) return { ok: false, name: intent.name, action, findings: [`old_string occurs ${occurrences} times (must be exactly 1)`] };
      }
    }

    const evidenceText = redact(String(intent.evidence ?? "").slice(0, 20_000));
    const evidenceHash = evidenceText === "" ? null : sha(evidenceText).slice(0, 16);

    if (action === "delete") {
      const archive = path.join(root, ".archive");
      ensureDir(archive);
      let target = path.join(archive, intent.name);
      if (fs.existsSync(target)) target = path.join(archive, `${intent.name}-${Date.now()}`);
      fs.renameSync(dir, target);
      appendLine(path.join(dirs.root, "ledger.jsonl"), { at: new Date().toISOString(), action, name: intent.name, level, reason: intent.reason });
      return { ok: true, name: intent.name, action, level, archived: target };
    }

    let body;
    if (action === "patch") {
      const live = readSelfSkill(root, intent.name);
      body = live.body.replace(intent.old_string, intent.new_string);
    } else {
      body = String(intent.body);
    }
    const description = String(intent.description ?? readSelfSkill(root, intent.name)?.description ?? "").replace(/\s+/g, " ").trim();
    const text = renderSkill({ name: intent.name, description, whenToUse: intent.whenToUse, body });

    ensureDir(dir);
    if (evidenceHash !== null) {
      const evidenceFile = path.join(dir, SELF_EVIDENCE, `evidence-${evidenceHash}.md`);
      if (!fs.existsSync(evidenceFile)) atomicWrite(evidenceFile, `${evidenceText}\n`);
    }
    // SKILL.md is the commit point: recall reads only this file.
    atomicWrite(path.join(dir, "SKILL.md"), text);

    const sidecarPath = path.join(dir, SELF_SIDECAR);
    const previous = readJson(sidecarPath, null);
    const anchor = String(level === "project" ? `project:${sha(root).slice(0, 12)}` : "global");
    const sidecar = previous !== null && previous.created_by === "autoharness"
      ? { ...previous, description, updated_at: new Date().toISOString(), patch: Number(previous.patch ?? 0) + (action === "patch" ? 1 : 0) }
      : {
        schema: STATE_VERSION,
        name: intent.name,
        level,
        created_by: "autoharness",
        created_at: new Date().toISOString(),
        anchor_request: requestCount(level),
        anchor,
        use: 0,
        view: 0,
        patch: 0,
        description,
      };
    writeJson(sidecarPath, sidecar);
    appendLine(path.join(dir, SELF_LEDGER), {
      at: new Date().toISOString(),
      action,
      reason: intent.reason,
      evidence: evidenceHash === null ? null : `${SELF_EVIDENCE}/evidence-${evidenceHash}.md`,
      ...(typeof intent.absorbed_into === "string" ? { absorbed_into: intent.absorbed_into } : {}),
    });
    return { ok: true, name: intent.name, action, level };
  }

  function drainRun(runId) {
    const dir = path.join(dirs.intents, runId);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    } catch {
      files = [];
    }
    const landed = [];
    const rejected = [];
    for (const file of files) {
      const intent = readJson(path.join(dir, file), null);
      if (intent === null) continue;
      try {
        const outcome = promoteIntent(intent);
        if (outcome.ok) landed.push(`${outcome.action} ${outcome.name} (${outcome.level})`);
        else rejected.push(`${outcome.action} ${outcome.name}: ${outcome.findings.join("; ")}`);
      } catch (error) {
        rejected.push(`${intent?.action} ${intent?.name}: ${String(error)}`);
      }
    }
    const summary = { runId, at: new Date().toISOString(), landed, rejected };
    writeJson(path.join(dirs.runs, `${runId}.json`), summary);
    writeJson(path.join(dirs.root, "last_run.json"), summary);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* a stuck queue retries next time */ }
    pendingRuns.delete(runId);
    lastIndex = { at: 0, text: "" };
    if (landed.length > 0 || rejected.length > 0) {
      log("info", `run ${runId}: ${landed.length} landed, ${rejected.length} rejected`);
    }
    return summary;
  }

  /** Drain the queue of an interactive run (intents staged from the main session). */
  function drainInteractive() {
    let runIds = [];
    try {
      runIds = fs.readdirSync(dirs.intents);
    } catch {
      return null;
    }
    let drained = null;
    for (const runId of runIds) {
      const dir = path.join(dirs.intents, runId);
      try {
        if (fs.readdirSync(dir).length === 0) {
          fs.rmSync(dir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      drained = drainRun(runId) ?? drained;
    }
    return drained;
  }

  /* ── REF: spawn the reflector ── */

  function buildReflectorPrompt({ runId, window, sessionId, level, mode }) {
    const allRoots = rootsFor();
    const index = ["global", "project"].map((lvl) => {
      const rows = listSelfSkills(allRoots[lvl]);
      if (rows.length === 0) return "";
      return `${lvl} layer:\n${rows.map((r) => `- ${r.name}: ${clip(r.description, 100)}`).join("\n")}`;
    }).filter(Boolean).join("\n\n");
    const common = [
      "You are the reflector of the DSH autoharness plugin. You are a maintenance worker, not an assistant.",
      "You may ONLY call the tool `autoharness_stage_skill`. Do not write files, do not run shell commands, do not answer the user.",
      "Shell/terminal tools (bash, pwsh) are DENIED in this session — calling them just returns an error. To inspect anything, use the read-only file tools (`read`, `grep`, `glob`) with an absolute path.",
      "",
      `Run id: ${runId}. Pass it as run_id in every stage_skill call.`,
      `Target layer for new skills: ${level === "project" ? "project" : "global"}.`,
      `New skill names must start with ${JSON.stringify(config.skillPrefix)} and be kebab-case.`,
      "",
      "Decide per episode: create a skill, update an existing one, patch it, or do nothing.",
      "A skill is a RULE for a recurring situation — not a transcript. Body: at most " + config.maxBodyLines + " non-empty lines, imperative, concrete commands/paths.",
      "The description is the trigger: say when to load the skill, in the words a user would use.",
      "If a new lesson contradicts an existing skill, patch that skill in the same run instead of adding a second one.",
      "If nothing reusable happened, call nothing — silence is a valid outcome.",
      "",
      index === "" ? "Current autoharness library: empty." : `Current autoharness library:\n${index}`,
    ];
    if (mode === "curator") {
      return [
        ...common,
        "",
        "CURATOR PASS. The window below is NOT a session — it is a dump of the library. Your job is consolidation only:",
        "fold near-duplicate skills under one umbrella (create the umbrella with the body you want, then delete the absorbed ones with absorbed_into set),",
        "and leave distinct skills alone. Never invent skills that are not already represented in the dump.",
        "",
        `Library dump: ${window.path}`,
      ].join("\n");
    }
    return [
      ...common,
      "",
      `Episode window (raw JSONL of the session ${sessionId}, redacted, ${window.lines} records): ${window.path}`,
      "",
      "Open that exact path with the `read` tool (offset/limit to page through it; it can be large).",
      "Find what the user actually worked out (commands that finally worked, conventions, pitfalls, tool idioms), and stage intents.",
      "Skip anything that is one-off, secret, or already covered by an existing skill.",
    ].join("\n");
  }

  async function spawnMaintenance({ parent, prompt, runId }) {
    const subagents = typeof ctx.get === "function" ? ctx.get("subagents") : undefined;
    if (subagents === undefined || typeof subagents.startActivation !== "function") {
      log("warn", "subagents service is unavailable — reflection skipped (mount dsh-subagent + spawn provider)");
      return null;
    }
    let controller;
    try {
      controller = AbortSignal.timeout(15 * 60 * 1000);
    } catch {
      controller = undefined;
    }
    const activation = await subagents.startActivation({
      provider: config.provider,
      label: `autoharness ${runId}`,
      prompt: [{ type: "text", text: prompt }],
      parent,
      ...(controller === undefined ? {} : { signal: controller }),
      delivery: "caller",
    });
    const childId = String(activation?.childId ?? "");
    if (childId !== "") {
      children.add(childId);
      persistChildren();
    }
    return activation;
  }

  async function reflect(sessionId, mode = "reflect") {
    // `agent/created` only fires for agents born after mount, so a session that was
    // already live when the bundle was (re)mounted has no entry. Ask the registry.
    let agent = agents.get(sessionId);
    if (agent === undefined) {
      const registry = typeof ctx.get === "function" ? ctx.get("agents") : undefined;
      if (typeof registry?.get === "function") agent = registry.get(sessionId);
      if (agent !== undefined) agents.set(sessionId, agent);
    }
    if (agent === undefined) {
      log("warn", `no live agent for ${sessionId} — reflection skipped`);
      return;
    }
    const level = config.layer;
    const runId = `${sha(sessionId).slice(0, 8)}-${randomUUID().slice(0, 6)}`;
    let window = null;
    if (mode === "curator") {
      const allRoots = rootsFor();
      const dump = ["global", "project"].flatMap((lvl) => listSelfSkills(allRoots[lvl]).map((row) => ({
        layer: lvl,
        name: row.name,
        description: row.description,
        body: row.body,
      })));
      if (dump.length < 4) return;
      const target = path.join(dirs.runs, `${runId}.window.jsonl`);
      atomicWrite(target, `${JSON.stringify({ kind: "library", skills: dump }, null, 2)}\n`);
      window = { path: target, lines: dump.length };
    } else {
      window = snapshotWindow(sessionId, runId);
      if (window === null) return;
    }
    pendingRuns.set(runId, { sessionId, startedAt: Date.now(), mode });
    const prompt = buildReflectorPrompt({ runId, window, sessionId, level, mode });
    try {
      const activation = await spawnMaintenance({ parent: agent, prompt, runId });
      if (activation === null) {
        pendingRuns.delete(runId);
        return;
      }
      const settle = () => {
        try {
          drainRun(runId);
        } catch (error) {
          log("warn", `drain failed: ${String(error)}`);
        }
      };
      if (activation.result !== undefined && typeof activation.result.then === "function") {
        activation.result.then(settle, settle);
      } else {
        setTimeout(settle, 20_000);
      }
    } catch (error) {
      pendingRuns.delete(runId);
      log("warn", `reflector spawn failed: ${String(error)}`);
    }
  }

  /* ── MNG: lifecycle, evaluated once per session start ── */

  function lifecycle(level) {
    const root = rootsFor()[level];
    const rows = listSelfSkills(root);
    if (rows.length === 0) return [];
    const requests = requestCount(level);
    const maturity = level === "project" ? config.maturityProject : config.maturityGlobal;
    const capacity = level === "project" ? config.capacityProject : config.capacityGlobal;
    const archive = [];
    const survivors = [];
    for (const row of rows) {
      const anchor = Number(row.sidecar.anchor_request ?? 0);
      const denom = Math.max(0, requests - anchor);
      if (denom < maturity) continue; // probation: live, not evictable, not counted against the cap
      const use = Number(row.sidecar.use ?? 0);
      if (use === 0) {
        if (Number(row.sidecar.view ?? 0) === 0) archive.push(row.name);
        continue;
      }
      survivors.push({ name: row.name, rate: use / denom });
    }
    if (survivors.length > capacity) {
      survivors.sort((a, b) => (a.rate - b.rate) || a.name.localeCompare(b.name));
      for (const item of survivors.slice(0, survivors.length - capacity)) archive.push(item.name);
    }
    for (const skillName of archive) {
      try {
        const dir = skillDirOf(root, skillName);
        const target = path.join(root, ".archive");
        ensureDir(target);
        let dest = path.join(target, skillName);
        if (fs.existsSync(dest)) dest = path.join(target, `${skillName}-${Date.now()}`);
        fs.renameSync(dir, dest);
        appendLine(path.join(dirs.root, "ledger.jsonl"), {
          at: new Date().toISOString(), action: "archive", name: skillName, level, reason: "lifecycle: no use and no view after probation, or capacity contention",
        });
      } catch (error) {
        log("warn", `archive ${skillName} failed: ${String(error)}`);
      }
    }
    return archive;
  }

  /* ── counters for use / view ── */

  function markUsage(level, skillName, kind) {
    const root = rootsFor()[level];
    const found = readSelfSkill(root, skillName);
    if (found === null) return;
    const sidecar = { ...found.sidecar };
    if (kind === "use") sidecar.use = Number(sidecar.use ?? 0) + 1;
    if (kind === "view") sidecar.view = Number(sidecar.view ?? 0) + 1;
    sidecar.last_used_at = new Date().toISOString();
    writeJson(path.join(found.dir, SELF_SIDECAR), sidecar);
    lastIndex = { at: 0, text: "" };
  }

  function findLevelOf(skillName) {
    const allRoots = rootsFor();
    for (const level of ["global", "project"]) if (readSelfSkill(allRoots[level], skillName) !== null) return level;
    return null;
  }

  /* ── event wiring ── */

  try {
    ctx.on("agent/created", ({ agent }) => {
      try {
        const sessionId = String(agent?.session?.id ?? "");
        if (sessionId === "") return;
        if (children.has(sessionId)) return;
        agents.set(sessionId, agent);
        for (const level of ["global", "project"]) {
          try {
            lifecycle(level);
          } catch (error) {
            log("warn", `lifecycle ${level} failed: ${String(error)}`);
          }
        }
        lastIndex = { at: 0, text: "" };
      } catch (error) {
        log("warn", `agent/created failed: ${String(error)}`);
      }
    });

    ctx.on("session/event", (session, event) => {
      try {
        const sessionId = String(session?.id ?? "");
        if (sessionId === "" || children.has(sessionId)) return;
        const reportedCwd = event?.data?.meta?.cwd ?? event?.data?.cwd;
        if (typeof reportedCwd === "string" && reportedCwd.startsWith("/")) currentCwd = reportedCwd;
        capture(session, event);
        if (event?.type === "tool/result") {
          const next = (calls.get(sessionId) ?? 0) + 1;
          calls.set(sessionId, next);
          const call = event?.data ?? {};
          const toolName = String(call?.name ?? call?.toolName ?? call?.call?.name ?? "");
          const args = call?.args ?? call?.input ?? call?.arguments ?? {};
          if (toolName === "skill" && typeof args?.name === "string") {
            const level = findLevelOf(args.name);
            if (level !== null) markUsage(level, args.name, "use");
          } else if (VIEW_TOOLS.has(toolName)) {
            const target = String(args?.path ?? args?.file_path ?? args?.pattern ?? "");
            const allRoots = rootsFor();
            for (const level of ["global", "project"]) {
              if (target === "" || !target.includes(allRoots[level])) continue;
              const hit = listSelfSkills(allRoots[level]).find((row) => target.includes(row.dir));
              if (hit !== undefined && !String(event?.data?.source?.kind ?? "").startsWith("autoharness")) markUsage(level, hit.name, "view");
            }
          }
          return;
        }
        if (event?.type !== "turn/end") return;
        const total = bumpRequests(config.layer);
        if (!config.graderOnly) {
          try {
            drainInteractive();
          } catch (error) {
            log("warn", `interactive drain failed: ${String(error)}`);
          }
        }
        const done = calls.get(sessionId) ?? 0;
        if (done >= config.reflectEveryN && !config.graderOnly) {
          calls.set(sessionId, 0);
          void reflect(sessionId, "reflect");
        }
        if (config.consolidateEveryN > 0 && total % config.consolidateEveryN === 0 && !config.graderOnly) {
          void reflect(sessionId, "curator");
        }
      } catch (error) {
        log("warn", `session/event failed: ${String(error)}`);
      }
    });
  } catch (error) {
    log("warn", `event wiring failed: ${String(error)}`);
  }

  // Persist per-session counters so a restart does not lose the numerator.
  try {
    ctx.effect?.(() => () => {
      try {
        writeJson(path.join(dirs.sessions, "counters.json"), Object.fromEntries(calls));
      } catch { /* best effort */ }
    });
  } catch { /* optional */ }

  /* ── backstop: a reflector may propose, never write ── */

  try {
    if (typeof ctx.tools?.guard === "function") {
      ctx.tools.guard((exec) => {
        const sessionId = String(exec?.agent?.session?.id ?? "");
        if (!children.has(sessionId)) return undefined;
        const tool = String(exec?.name ?? "");
        if (WRITE_TOOLS.has(tool) || SHELL_TOOLS.has(tool)) {
          return "autoharness reflector may only stage skill intents (autoharness_stage_skill)";
        }
        return undefined;
      });
    }
  } catch (error) {
    log("warn", `tools.guard registration failed: ${String(error)}`);
  }

  /* ── model-facing tools ── */

  if (typeof ctx.tools?.register === "function") {
    try {
      ctx.tools.register({
        name: "autoharness_stage_skill",
        description: "Stage one skill intent for the autoharness promoter. Reflector-only: it does not write files, it queues a proposal that the deterministic promoter validates and lands.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["run_id", "action", "name", "reason"],
          properties: {
            run_id: { type: "string", description: "Run id from the reflector prompt" },
            action: { type: "string", enum: ["create", "update", "patch", "delete"], description: "What to do with the skill" },
            name: { type: "string", description: "Kebab-case skill name; new skills must carry the configured prefix" },
            level: { type: "string", enum: ["global", "project"], description: "Layer for a new skill (defaults to the plugin setting)" },
            description: { type: "string", description: "When to load the skill — this text is the recall trigger" },
            whenToUse: { type: "string", description: "Optional short 'use when' line" },
            body: { type: "string", description: "Markdown rule body (create/update): short, imperative, concrete" },
            old_string: { type: "string", description: "patch: exact text to replace (must occur once)" },
            new_string: { type: "string", description: "patch: replacement text" },
            reason: { type: "string", description: "Why this lesson exists — recorded in the ledger" },
            evidence: { type: "string", description: "Short quote from the session that justifies the lesson" },
            absorbed_into: { type: "string", description: "delete: umbrella skill that absorbed this one" },
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["staged", "run_id", "pending"],
            properties: { staged: { type: "boolean" }, file: { type: "string" }, run_id: { type: "string" }, pending: { type: "integer" } },
          },
          render: (_args, value) => [{ type: "text", text: `staged into run ${value.run_id} (queue: ${value.pending})` }],
        },
        async execute(args) {
          const runId = String(args.run_id ?? "");
          const known = pendingRuns.has(runId)
            || (runId === "interactive" && fs.existsSync(path.join(dirs.intents, "interactive")))
            || fs.existsSync(path.join(dirs.runs, `${runId}.window.jsonl`));
          if (!known) throw new Error(`unknown or expired run_id ${JSON.stringify(runId)}`);
          const dir = ensureDir(path.join(dirs.intents, runId));
          const file = path.join(dir, `${String(Date.now())}-${randomUUID().slice(0, 8)}.json`);
          const { run_id: _ignored, ...intent } = args;
          writeJson(file, { ...intent, staged_at: new Date().toISOString() });
          return { staged: true, file, run_id: runId, pending: fs.readdirSync(dir).length };
        },
      });

      ctx.tools.register({
        name: "autoharness_learn",
        description: "Distill the current session into a skill right now instead of waiting for the background cadence: snapshots the capture window and starts a reflector immediately.",
        parameters: { type: "object", additionalProperties: false, properties: {} },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["started", "session"],
            properties: { started: { type: "boolean" }, session: { type: "string" } },
          },
          render: (_args, value) => [{ type: "text", text: `reflection started for ${value.session}` }],
        },
        async execute(_args, exec) {
          const sessionId = String(exec?.agent?.session?.id ?? "");
          if (sessionId === "") throw new Error("no session for this call");
          if (!agents.has(sessionId)) agents.set(sessionId, exec.agent);
          await reflect(sessionId, "reflect");
          return { started: true, session: sessionId };
        },
      });

      ctx.tools.register({
        name: "autoharness_status",
        description: "Report the autoharness state: requests counted per layer, self-authored skills with use/view counters, pending intents and the last run.",
        parameters: { type: "object", additionalProperties: false, properties: {} },
        output: {
          schema: { type: "object" },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
        },
        async execute() {
          const allRoots = rootsFor();
          const layers = {};
          for (const level of ["global", "project"]) {
            layers[level] = {
              root: allRoots[level],
              requests: requestCount(level),
              skills: listSelfSkills(allRoots[level]).map((row) => ({
                name: row.name,
                use: Number(row.sidecar.use ?? 0),
                view: Number(row.sidecar.view ?? 0),
                patch: Number(row.sidecar.patch ?? 0),
                anchor: Number(row.sidecar.anchor_request ?? 0),
              })),
            };
          }
          const pending = fs.existsSync(path.join(dirs.intents, "interactive"))
            ? fs.readdirSync(path.join(dirs.intents, "interactive")).length
            : 0;
          return {
            stateDir: dirs.root,
            reflectEveryN: config.reflectEveryN,
            prefix: config.skillPrefix,
            layers,
            pendingInteractiveIntents: pending,
            children: children.size,
            lastRun: readJson(path.join(dirs.root, "last_run.json"), null),
          };
        },
      });
    } catch (error) {
      log("warn", `tool registration failed: ${String(error)}`);
    }
  }

  const subagentsProbe = typeof ctx.get === "function" ? ctx.get("subagents") : undefined;
  log("info", `mounted: state=${stateRoot} reflectEveryN=${config.reflectEveryN} prefix=${config.skillPrefix} subagents=${subagentsProbe?.startActivation === undefined ? "MISSING" : "ok"}`);
}
