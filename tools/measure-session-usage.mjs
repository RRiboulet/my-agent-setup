// Read-only measurement harness behind the /session-breakdown CHANGELOG entry.
//
//   node tools/measure-session-usage.mjs
//
// Three questions, one pass:
//   1. What does a scanner that only reads `sessions/` see?
//   2. What does one that also sweeps the subagent extension's child-session
//      trees see? (The gap is why LOCAL PATCH 1 exists.)
//   3. How much of a forked child's transcript is a verbatim copy of its parent's
//      tail, i.e. what LOCAL PATCH 2 stops counting twice?
//
// It writes nothing and honours no arguments on purpose: every number it prints
// is about the machine it runs on, which is why the CHANGELOG dates its figures
// rather than presenting them as constants.
//
// Deliberately independent of the extension: it reimplements the aggregation from
// the upstream parser's semantics, so a bug in the extension cannot hide itself by
// being used on both sides of the comparison.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const AGENT = path.join(os.homedir(), ".pi", "agent");
const SESSIONS = path.join(AGENT, "sessions");
const RUNS = path.join(AGENT, "tmux-subagents");

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
  }
}

const isFaux = (o) => {
  const s = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  const m = (o?.message) || {};
  const api = s(o?.api ?? m.api), prov = s(o?.provider ?? m.provider);
  const model = s(o?.model ?? m.model ?? o?.modelId ?? m.modelId);
  return api === "faux" || api.startsWith("faux:") || prov === "faux" ||
    model === "faux" || model.startsWith("faux-");
};
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : 0);
function costOf(usage) {
  if (!usage) return 0;
  const c = usage.cost;
  if (typeof c === "number") return num(c);
  if (typeof c === "string") return num(c);
  return num(c?.total);
}
function tokensOf(u) {
  if (!u) return 0;
  return num(u.totalTokens) || num(u.total_tokens) || num(u.promptTokens) + num(u.completionTokens) ||
    num(u.prompt_tokens) + num(u.completion_tokens) || num(u.inputTokens ?? u.input) + num(u.outputTokens ?? u.output) ||
    num(u.tokens);
}

function parse(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const agg = { file, messages: 0, tokens: 0, cost: 0, models: new Set(), ids: [], startedAt: null };
  const name = path.basename(file);
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T/);
  agg.startedAt = m ? m[1] : null;
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o?.type === "session") { if (!agg.startedAt && typeof o.timestamp === "string") agg.startedAt = o.timestamp.slice(0, 10); agg.header = o; continue; }
    agg.ids.push(o?.id ?? null);
    if (isFaux(o)) continue;
    if (o?.type !== "message") continue;
    const msg = o.message || o;
    const mk = o.provider ?? msg.provider, mm = o.model ?? msg.model ?? o.modelId ?? msg.modelId;
    if (mk || mm) agg.models.add(`${mk}/${mm}`);
    else if (msg.role === "assistant") agg.models.add("inherited-current-model");
    const u = o.usage ?? msg.usage;
    agg.messages += 1;
    agg.tokens += tokensOf(u);
    agg.cost += costOf(u);
  }
  return agg;
}

function totals(files) {
  const t = { sessions: 0, messages: 0, tokens: 0, cost: 0 };
  for (const f of files) { const a = parse(f); if (a.models.size === 0) continue; t.sessions++; t.messages += a.messages; t.tokens += a.tokens; t.cost += a.cost; }
  return t;
}

const sessFiles = [...walk(SESSIONS)];
const runFiles = [...walk(RUNS)];
console.log(`sessions/-only : ${sessFiles.length} files`, totals(sessFiles));
console.log(`agent-dir-wide : ${sessFiles.length + runFiles.length} files`, totals([...sessFiles, ...runFiles]));
console.log(`child files    : ${runFiles.length}, raw`, totals(runFiles));

// runs.json baselines
const baselines = new Map();
for (const f of fs.existsSync(RUNS) ? fs.readdirSync(RUNS).map((d) => path.join(RUNS, d, "runs.json")).filter(fs.existsSync) : []) {
  let d; try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
  const rs = Array.isArray(d) ? d : (d.runs ?? []);
  for (const r of rs) if (r.sessionFile) baselines.set(path.resolve(r.sessionFile), { mode: r.launchMode ?? r.mode, from: r.usageFromLine ?? 0, usage: r.usage, id: r.id });
}
console.log(`\nrun records with sessionFile: ${baselines.size}`);

const aggLines = (lines) => {
  let messages = 0, tokens = 0, cost = 0;
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o?.type !== "message" || isFaux(o)) continue;
    const u = o.usage ?? (o.message || {}).usage;
    messages += 1; tokens += tokensOf(u); cost += costOf(u);
  }
  return { messages, tokens, cost };
};

let wholeT = 0, fromT = 0, dupLines = 0, prefixIdsTotal = 0;
const sessIds = new Set();
for (const f of sessFiles) for (const id of parse(f).ids) if (id) sessIds.add(id);
console.log(`distinct entry ids across sessions/: ${sessIds.size}`);

for (const f of runFiles) {
  const b = baselines.get(path.resolve(f));
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  const aggAll = aggLines(lines), aggFrom = aggLines(lines.slice(b?.from ?? 0));
  const prefix = lines.slice(1, b?.from ?? 0).map((l) => { try { return JSON.parse(l).id; } catch { return null; } }).filter(Boolean);
  prefixIdsTotal += prefix.length;
  dupLines += prefix.filter((i) => sessIds.has(i)).length;
  wholeT += aggAll.cost; fromT += aggFrom.cost;
  if (prefix.length) console.log(`\n${b?.mode ?? "?"} run ${b?.id?.slice(0, 8)}  fromLine=${b?.from}  lines=${lines.length}`);
  if (prefix.length) console.log(`  whole file : msg=${aggAll.messages} tok=${aggAll.tokens} cost=$${aggAll.cost.toFixed(6)}`);
  if (prefix.length) console.log(`  from line  : msg=${aggFrom.messages} tok=${aggFrom.tokens} cost=$${aggFrom.cost.toFixed(6)}`);
  if (prefix.length) console.log(`  INHERITED  : ${prefix.length} entries, ${prefix.filter((i) => sessIds.has(i)).length} also present in sessions/ (ids collide)`);
  if (b?.usage) console.log(`  recorded usage: tok=${b.usage.totalTokens} cost=$${b.usage.cost}`);
}
console.log(`\nTOTALS over child files: whole=$${wholeT.toFixed(6)} vs from-baseline=$${fromT.toFixed(6)}`);
console.log(`inherited prefix entries: ${prefixIdsTotal}, of which duplicated into sessions/: ${dupLines}`);


