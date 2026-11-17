#!/usr/bin/env node
// Per-skill load counts from recorded sessions. Ticket 05's prune needs to know
// which SKILL.md files were actually read, not just how many loads happened.
//
//   node tools/bench/skills.mjs
//   node tools/bench/skills.mjs --agent-dir ~/.pi/agent --since 2026-10-31
//   node tools/bench/skills.mjs --json
//
// A load is a `read`/`edit`/`write` tool call whose path names
// `/skills/<name>/`, or a bash command that mentions `skills/<name>/SKILL.md`
// (cat/sed/head). The scan is read-only and follows the session JSONL format.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function usage() {
  console.log(`usage: node tools/bench/skills.mjs [options]

  --agent-dir <dir>   default $PI_CODING_AGENT_DIR or ~/.pi/agent
  --all               scan ~/.pi/agent and every ~/.pi/agent-* directory
  --since <date>      only sessions whose first line is on/after YYYY-MM-DD
  --json              machine-readable output
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--agent-dir") args.agentDir = next();
    else if (arg === "--all") args.all = true;
    else if (arg === "--since") args.since = next();
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
  }
}

const SKILL_PATH = /\/skills\/([a-zA-Z0-9._-]+)\//;
const SKILL_IN_COMMAND = /skills\/([a-zA-Z0-9._-]+)\/SKILL\.md/g;

/** Skill directories named by one tool call, deduplicated. */
export function skillsInToolCall(call) {
  const names = new Set();
  const args = call?.arguments ?? {};
  const filePath = typeof args.path === "string" ? args.path : "";
  const match = filePath.match(SKILL_PATH);
  if (match) names.add(match[1]);
  const command = typeof args.command === "string" ? args.command : "";
  for (const commandMatch of command.matchAll(SKILL_IN_COMMAND)) names.add(commandMatch[1]);
  return [...names];
}

export function scanAgentDir(agentDir, { since } = {}) {
  const sessionsRoot = path.join(agentDir, "sessions");
  const perSkill = new Map();
  const perSession = new Map();
  let sessions = 0;
  let loads = 0;

  for (const file of walk(sessionsRoot)) {
    let first;
    try {
      first = JSON.parse(fs.readFileSync(file, "utf8").split("\n", 1)[0]);
    } catch {
      continue;
    }
    if (since && String(first.timestamp ?? "").slice(0, 10) < since) continue;
    sessions++;
    const names = new Set();
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type !== "message" || record.message?.role !== "assistant") continue;
      for (const block of record.message.content ?? []) {
        if (block?.type !== "toolCall") continue;
        for (const name of skillsInToolCall(block)) {
          names.add(name);
          perSkill.set(name, (perSkill.get(name) ?? 0) + 1);
          loads++;
        }
      }
    }
    for (const name of names) perSession.set(name, (perSession.get(name) ?? 0) + 1);
  }

  const rows = [...perSkill.entries()]
    .map(([skill, count]) => ({ skill, loads: count, sessions: perSession.get(skill) ?? 0 }))
    .sort((a, b) => b.loads - a.loads || a.skill.localeCompare(b.skill));
  return { sessions, loads, skills: rows };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  let dirs;
  if (args.all) {
    const piRoot = path.join(os.homedir(), ".pi");
    dirs = fs
      .readdirSync(piRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === "agent" || entry.name.startsWith("agent-")))
      .map((entry) => path.join(piRoot, entry.name));
  } else {
    dirs = [args.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent")];
  }

  const merged = new Map();
  let sessions = 0;
  let loads = 0;
  const perDir = [];
  for (const agentDir of dirs) {
    const result = scanAgentDir(agentDir, { since: args.since });
    perDir.push({ agentDir, sessions: result.sessions, loads: result.loads });
    sessions += result.sessions;
    loads += result.loads;
    for (const row of result.skills) {
      const current = merged.get(row.skill) ?? { skill: row.skill, loads: 0, sessions: 0 };
      current.loads += row.loads;
      current.sessions += row.sessions;
      merged.set(row.skill, current);
    }
  }
  const rows = [...merged.values()].sort((a, b) => b.loads - a.loads || a.skill.localeCompare(b.skill));
  const result = { sessions, loads, skills: rows, dirs: perDir };

  if (args.json) {
    console.log(JSON.stringify({ ...result }, null, 2));
    return;
  }
  console.log(`agent dirs: ${perDir.map((d) => d.agentDir).join(", ")}`);
  console.log(`sessions: ${result.sessions}   skill loads: ${result.loads}`);
  console.log("");
  console.log("skill                 loads  sessions");
  console.log("--------------------  -----  --------");
  for (const row of result.skills) {
    console.log(`${row.skill.padEnd(20)}  ${String(row.loads).padStart(5)}  ${String(row.sessions).padStart(8)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(`skills: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
