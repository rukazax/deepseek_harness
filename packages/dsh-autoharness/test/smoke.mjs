import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ah-"));
process.env.DSH_HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { apply, name } = await import("../index.js");
console.log("plugin name:", name);

const listeners = {};
const tools = {};
const ctx = {
  logger: { info: (m) => console.log("INFO ", m), warn: (m) => console.warn("WARN ", m) },
  systemPrompt: { context: (d) => { ctx._prompt = d; return () => {}; }, getContextOrder: () => 1 },
  on: (event, fn) => { (listeners[event] ??= []).push(fn); return () => {}; },
  tools: { register: (tool) => { tools[tool.name] = tool; return () => {}; }, guard: (fn) => { ctx._guard = fn; return () => {}; } },
  get: () => undefined,
  effect: (fn) => { fn(); return () => {}; },
};

apply(ctx, { stateDir: path.join(tmp, "state"), skillPrefix: "ah-", reflectEveryN: 3 });

const state = path.join(tmp, "state");
const idir = path.join(state, "intents", "interactive");
const stage = (intent) => {
  fs.mkdirSync(idir, { recursive: true });
  fs.writeFileSync(path.join(idir, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`), JSON.stringify(intent));
};
const fire = (type, data = {}) => {
  for (const fn of listeners["session/event"] ?? []) fn(session, { type, seq: 1, data });
};
const session = { id: "session-test-1" };

// 1. happy path
stage({ action: "create", name: "ah-demo", description: "Use when testing the promoter path end to end", body: "1. Stage an intent.\n2. Emit turn/end.\n3. Read SKILL.md.", reason: "smoke test of the promoter", evidence: "asked to test" });
fire("turn/end", { turn: 1 });
const dir = path.join(tmp, "home", "skills", "ah-demo");
console.log("\n1) create landed:", fs.existsSync(path.join(dir, "SKILL.md")));

// 2. validation rejects: missing prefix, transcript body, empty reason
stage({ action: "create", name: "no-prefix", description: "Bad name", body: "x".repeat(50), reason: "validation must reject a name without prefix" });
stage({ action: "create", name: "ah-big", description: "Too long body", body: Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"), reason: "validation must reject a transcript instead of a rule" });
stage({ action: "create", name: "ah-noreason", description: "No reason here", body: "Some body text that is long enough.", reason: "" });
fire("turn/end", { turn: 2 });
console.log("2) rejected run:", JSON.stringify(JSON.parse(fs.readFileSync(path.join(state, "last_run.json"), "utf8")).rejected, null, 1));
console.log("   no-prefix dir absent:", !fs.existsSync(path.join(tmp, "home", "skills", "no-prefix")));

// 3. patch the live skill
stage({ action: "patch", name: "ah-demo", old_string: "3. Read SKILL.md.", new_string: "3. Read SKILL.md, then call /learn.", reason: "user corrected the third step of the demo skill" });
fire("turn/end", { turn: 3 });
const patched = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
console.log("3) patched:", patched.includes("call /learn"), "| ledger lines:", fs.readFileSync(path.join(dir, ".ledger.jsonl"), "utf8").trim().split("\n").length);

// 4. use counter via a skill tool observation
fire("tool/result", { name: "skill", args: { name: "ah-demo" } });
console.log("4) use counter:", JSON.parse(fs.readFileSync(path.join(dir, ".autoharness.json"), "utf8")).use);

// 5. lifecycle: force maturity + zero use in a copy, then session start
const reqFile = fs.readdirSync(path.join(state, "requests")).find((f) => f.startsWith("global-"));
fs.writeFileSync(path.join(state, "requests", reqFile), JSON.stringify({ n: 5000 }));
const sideFile = path.join(dir, ".autoharness.json");
const side = JSON.parse(fs.readFileSync(sideFile, "utf8"));
fs.writeFileSync(sideFile, JSON.stringify({ ...side, use: 0, view: 0, anchor_request: 0 }));
for (const fn of listeners["agent/created"] ?? []) fn({ agent: { session } });
console.log("5) archived after probation with no use:", fs.existsSync(path.join(tmp, "home", "skills", ".archive", "ah-demo")));

// 6. guard denies shell/write for a registered child session
fs.writeFileSync(path.join(state, "children.json"), JSON.stringify(["session-child-1"]));
apply(ctx, { stateDir: state, skillPrefix: "ah-" }); // remount so the child list is reloaded
console.log("6) guard (child, bash):", ctx._guard({ agent: { session: { id: "session-child-1" } }, name: "bash" }));
console.log("   guard (child, read):", ctx._guard({ agent: { session: { id: "session-child-1" } }, name: "read" }));
console.log("   guard (parent, bash):", ctx._guard({ agent: { session: { id: "session-test-1" } }, name: "bash" }));

// 7. stage_skill rejects an unknown run id
try {
  await tools["autoharness_stage_skill"].execute({ run_id: "nope", action: "create", name: "ah-x", reason: "should be refused" }, {});
  console.log("7) UNEXPECTED: unknown run accepted");
} catch (error) {
  console.log("7) unknown run rejected:", String(error.message).slice(0, 60));
}
// 8. a queued intent outlives a remount (window on disk is what proves the run), the
//    returned value declares every key it returns, and the sweep lands the orphan queue
const remountRun = "remount-run";
fs.writeFileSync(path.join(state, "runs", `${remountRun}.window.jsonl`), "{\"type\":\"tool/result\"}\n");
const stageTool = tools["autoharness_stage_skill"];
const staged = await stageTool.execute({ run_id: remountRun, action: "create", name: "ah-after-remount", description: "Use when verifying that a queued intent survives a plugin remount", body: "1. Emit turn/end.\n2. Read SKILL.md.", reason: "smoke test of remount survival" }, {});
const declared = Object.keys(stageTool.output.schema.properties);
console.log("8) staged without a live run:", staged.staged, "| keys declared:", Object.keys(staged).every((k) => declared.includes(k)));
fire("turn/end", { turn: 8 });
console.log("   orphan queue drained:", fs.existsSync(path.join(tmp, "home", "skills", "ah-after-remount", "SKILL.md")));

console.log("\nstatus:", JSON.stringify(await tools["autoharness_status"].execute({}, {}), null, 0).slice(0, 400));
