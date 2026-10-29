// Standalone verification harness: stub DSH context, load plugin, list/call MCP tools.
import { apply } from "./lib/index.js";

const tools = [];
const ctx = {
  logger: {
    info: (...a) => console.log("[info]", ...a),
    error: (...a) => console.log("[error]", ...a),
  },
  inject: (_deps, fn) => fn({
    tools: {
      register: (tool) => {
        tools.push(tool);
        return () => {};
      },
    },
  }),
  effect: (fn) => {
    const dispose = fn();
    return dispose;
  },
};

apply(ctx, {});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(8000);

console.log("\nREGISTERED TOOLS:", tools.map((t) => t.name).join(", ") || "(none)");

for (const name of ["sarex__sarex_status", "mail__mail_status", "mail__mail_search"]) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    console.log(`\n${name}: NOT REGISTERED`);
    continue;
  }
  try {
    const args = name === "mail__mail_search" ? { query: { subject: "Символ" }, limit: 2 } : {};
    const value = await tool.execute(args, { signal: { throwIfAborted() {} } });
    console.log(`\n${name}:`, String(value?.text ?? "").slice(0, 400));
  } catch (err) {
    console.log(`\n${name} ERROR:`, err?.message ?? err);
  }
}

for (const t of tools) {
  try {
    // no direct dispose path; plugin effect disposer handles it on unload
  } catch {}
}
process.exit(0);
