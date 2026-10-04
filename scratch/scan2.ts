import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import { __test__ } from "/workspace/.pi/extensions/session-breakdown.ts";
const { readSessionHeader, resolveInheritedIds, defaultSessionRoots } = __test__;
const roots = defaultSessionRoots();
async function walk(root: string): Promise<string[]> {
  const out: string[] = []; const stack=[root];
  while (stack.length) { const d = stack.pop()!; let es:any[]=[];
    try { es = await fs.readdir(d, {withFileTypes:true}); } catch { continue; }
    for (const e of es) { const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p); else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p); } }
  return out;
}
const hc = new Map(); const ic = new Map();
for (const r of roots) {
  for (const f of await walk(r)) {
    const h = await readSessionHeader(f);
    const lin = await resolveInheritedIds(f, hc, ic);
    if (lin.broken) {
      console.log("BROKEN", f);
      console.log("  header:", JSON.stringify(h));
      if (h?.parentSession) console.log("  parent exists?", fs.existsSync(h.parentSession).catch(()=>false));
    }
  }
}
