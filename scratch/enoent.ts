import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __test__ } from "/workspace/.pi/extensions/session-breakdown.ts";
const dir = await mkdtemp(path.join(tmpdir(), "sb-enoent-"));
const sessions = path.join(dir, "sessions");
await mkdir(sessions, { recursive: true });
const stamp = new Date().toISOString().replace(/:/g, "-").replace(/\.(\d{3})Z$/, "-$1Z");
const header = { type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: "/tmp/x" };
const mc = { type: "model_change", id: "mc1", parentId: null, provider: "openrouter", modelId: "m" };
const msg = (n: number) => ({ type: "message", id: `e${n}`, parentId: "mc1", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "openrouter", model: "m", usage: { totalTokens: 10, cost: { total: 0.01 } } } });
const victim = path.join(sessions, `${stamp}_victim.jsonl`);
await writeFile(victim, [header, mc, msg(1), msg(2), msg(3)].map(o=>JSON.stringify(o)).join("\n")+"\n");
await writeFile(path.join(sessions, `${stamp}_keeper.jsonl`), [header, mc, msg(9)].map(o=>JSON.stringify(o)).join("\n")+"\n");

try {
  const data = await __test__.computeBreakdown(undefined, (u) => {
    if (u.phase === "parse" && u.currentFile?.includes("victim")) {
      rm(victim, { force: true });   // simulate subagent_clean --delete-files mid-scan
    }
  }, { roots: [sessions] });
  console.log("OK, no throw. sessions=", data.ranges.get(30)!.sessions, "inherited=", JSON.stringify(data.inherited));
} catch (e: any) {
  console.log("THREW:", e?.code, e?.message);
}
await rm(dir, { recursive: true, force: true });
