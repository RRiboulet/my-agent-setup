#!/usr/bin/env node
// Harness A/B runner.
//
//   node tools/bench/run.mjs --state baseline --tasks all --models deepseek-v4.1-flash
//   node tools/bench/run.mjs --state changed  --tasks head-hash,full-suite --models all
//
// One cell is (task, model, state). Each cell runs `pi --mode json` in the
// task's repo with its own session directory, then runs the task's check. The
// result is one JSON file per cell under tools/bench/results/<state>/<model>/.
//
// Deliberate choices:
//   - The runner refuses a dirty repo unless --allow-dirty, because a harness
//     state has to be identifiable. A task may set "allowDirty": true for a
//     workspace another session legitimately has open; the field is recorded.
//   - A task is expected to be read-only. The runner does not create a worktree
//     per cell; if a task mutates its repo, the next cell starts from dirty
//     state and the run is not comparable. The README says this plainly.
//   - Check failures are data, not harness errors: the runner exits 0 when
//     every cell executed, and the result file says whether the check passed.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { summarizeEvents, parseJsonl } from "./lib/events.mjs";
import { loadTasks, selectTasks, renderPrompt } from "./lib/tasks.mjs";

const BENCH_DIR = import.meta.dirname;
const DEFAULT_OUT = path.join(BENCH_DIR, "results");
const DEFAULT_MODELS = [
  "opencode-go/deepseek-v4.1-flash",
  "opencode-go/glm-5.3-flash",
  "opencode-go/hy4-flash-free",
];
const STDOUT_CAP = 40 * 1024 * 1024;

function usage() {
  return `usage: node tools/bench/run.mjs --state <baseline|changed> [options]

  --tasks <all|id,id>     task ids, default all
  --models <ids>          comma-separated; a bare id gets the opencode-go provider
  --state <label>         baseline or changed; required, it names the harness state
  --out <dir>             result root, default tools/bench/results
  --timeout <ms>          override every task's timeout
  --force                 overwrite an existing cell
  --allow-dirty           allow a dirty task repo (recorded in the result)
  --dry-run               print the cells without running them
  --list                  list the tasks and models and exit
`;
}

function parseArgs(argv) {
  const args = { tasks: "all", models: DEFAULT_MODELS.join(","), state: "", out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--tasks": args.tasks = next(); break;
      case "--models": args.models = next(); break;
      case "--state": args.state = next(); break;
      case "--out": args.out = path.resolve(next()); break;
      case "--timeout": args.timeout = Number(next()); break;
      case "--force": args.force = true; break;
      case "--allow-dirty": args.allowDirty = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--list": args.list = true; break;
      case "-h":
      case "--help": args.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function modelSlug(model) {
  return model.replaceAll("/", "_").replaceAll(":", "_");
}

function normalizeModels(spec) {
  return String(spec)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => (id.includes("/") ? id : `opencode-go/${id}`));
}

function repoState(repo) {
  const isGit = (() => {
    try {
      return spawnSync("git", ["-C", repo, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).stdout.trim() === "true";
    } catch {
      return false;
    }
  })();
  if (!isGit) return { isGit: false, head: "", dirty: false, changes: [] };
  const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const changes = spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { isGit: true, head, dirty: changes.length > 0, changes };
}

function taskVars(task) {
  const vars = { repo: task.repo, date: new Date().toISOString().slice(0, 10) };
  const state = repoState(task.repo);
  vars.gitHead = state.head;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(task.repo, "package.json"), "utf8"));
    vars.extensionsCount = Array.isArray(pkg?.pi?.extensions) ? pkg.pi.extensions.length : "";
  } catch {
    vars.extensionsCount = "";
  }
  try {
    vars.docsCount = String(
      spawnSync("git", ["-C", task.repo, "ls-files", "docs"], { encoding: "utf8" })
        .stdout.split("\n").filter(Boolean).length,
    );
  } catch {
    vars.docsCount = "";
  }
  return vars;
}

function runProcess(command, argv, { cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(command, argv, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const cap = (target, chunk) => (target.length >= STDOUT_CAP ? target : target + chunk);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = cap(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = cap(stderr, chunk); });

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKill);
      resolve({
        stdout,
        stderr,
        timedOut,
        wallMs: Number(process.hrtime.bigint() - started) / 1e6,
        ...extra,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    const hardKill = setTimeout(() => finish({ code: null, signal: "SIGKILL" }), timeoutMs + 5000);

    child.on("error", (error) => finish({ code: null, signal: null, error: error.message }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

async function runCheck(check, { repo, timeoutMs }) {
  if (!check) return { passed: true, failures: [], command: null };
  const failures = [];

  if (Array.isArray(check.expectAnswerContains)) {
    for (const needle of check.expectAnswerContains) {
      if (!String(check.answer ?? "").includes(needle)) failures.push(`answer does not contain ${JSON.stringify(needle)}`);
    }
  }

  if (!check.command) {
    return { passed: failures.length === 0, failures, command: null };
  }

  const result = await runProcess("bash", ["-lc", check.command], {
    cwd: repo,
    timeoutMs: Math.min(timeoutMs, 180000),
    env: process.env,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  for (const needle of check.expectContains ?? []) {
    if (!output.includes(needle)) failures.push(`check output does not contain ${JSON.stringify(needle)}`);
  }
  if (typeof check.expectExit === "number" && result.code !== check.expectExit) {
    failures.push(`check exited ${result.code}, expected ${check.expectExit}`);
  }
  if (result.timedOut) failures.push("check timed out");
  return {
    passed: failures.length === 0,
    failures,
    command: check.command,
    exitCode: result.code,
    outputTail: output.slice(-2000),
  };
}

async function runCell({ task, model, state, outRoot, force, allowDirty, timeoutOverride }) {
  const stateDir = path.join(outRoot, state, modelSlug(model));
  const outFile = path.join(stateDir, `${task.id}.json`);
  if (fs.existsSync(outFile) && !force) {
    return { skipped: true, outFile };
  }

  const repo = repoState(task.repo);
  if (repo.dirty && !allowDirty && !task.allowDirty) {
    throw new Error(
      `${task.id}: ${task.repo} is dirty; commit/stash it, pass --allow-dirty, or set allowDirty in the task\n${repo.changes.join("\n")}`,
    );
  }

  const vars = taskVars(task);
  const prompt = renderPrompt(task.prompt, vars);
  const resolvedCheck = task.check
    ? {
        ...task.check,
        expectAnswerContains: (task.check.expectAnswerContains ?? []).map((needle) => renderPrompt(needle, vars)),
        command: task.check.command ? renderPrompt(task.check.command, vars) : undefined,
        expectContains: (task.check.expectContains ?? []).map((needle) => renderPrompt(needle, vars)),
      }
    : undefined;
  const timeoutMs = timeoutOverride ?? task.timeoutMs;
  const sessionDir = path.join(stateDir, "sessions", task.id);
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const run = await runProcess(
    "pi",
    ["--mode", "json", "--model", model, "--session-dir", sessionDir, prompt],
    { cwd: task.repo, timeoutMs, env: { ...process.env, PI_BENCH_CELL: `${state}/${model}/${task.id}` } },
  );

  let summary;
  let parseError = null;
  try {
    summary = summarizeEvents(parseJsonl(run.stdout));
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
    summary = summarizeEvents([]);
  }

  const check = await runCheck({ ...(resolvedCheck ?? {}), answer: summary.finalAnswer }, { repo: task.repo, timeoutMs });
  const record = {
    schemaVersion: 1,
    cell: { task: task.id, model, state },
    repo: task.repo,
    repoState: { isGit: repo.isGit, head: repo.head, dirty: repo.dirty },
    startedAt,
    wallMs: run.wallMs,
    exitCode: run.code,
    signal: run.signal,
    timedOut: run.timedOut,
    spawnError: run.error ?? null,
    prompt,
    metrics: {
      toolCallCount: summary.toolCallCount,
      toolCallsByName: summary.toolCallsByName,
      toolResultCount: summary.toolResultCount,
      toolTimeMs: summary.toolTimeMs,
      longestToolMs: summary.longestToolMs,
      toolDurations: summary.toolDurations,
      tokens: summary.tokens,
      cost: summary.cost,
      assistantMessages: summary.assistantMessages,
      turns: summary.turns,
      errors: summary.errors,
      aborted: summary.aborted,
    },
    answer: summary.finalAnswer,
    check,
    parseError,
    sessionDir,
    stderrTail: run.stderr.slice(-2000),
  };

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
  return { skipped: false, outFile, record };
}

function printTable(rows) {
  if (rows.length === 0) return;
  const columns = ["task", "model", "wall s", "calls", "longest ms", "tokens", "errors", "check"];
  const data = rows.map((row) => [
    row.task,
    row.model.replace("opencode-go/", ""),
    (row.wallMs / 1000).toFixed(1),
    String(row.metrics.toolCallCount),
    String(Math.round(row.metrics.longestToolMs)),
    String(row.metrics.tokens),
    String(row.metrics.errors),
    row.check.passed ? "pass" : "FAIL",
  ]);
  const widths = columns.map((col, i) => Math.max(col.length, ...data.map((line) => line[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  console.log(line(columns));
  console.log(line(widths.map((width) => "-".repeat(width))));
  for (const row of data) console.log(line(row));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.list) {
    for (const task of loadTasks(path.join(BENCH_DIR, "tasks"))) {
      console.log(`${task.id}\t${task.repo}\t${task.timeoutMs} ms`);
    }
    console.log(`models\t${normalizeModels(args.models).join(", ")}`);
    return;
  }
  if (!args.state) throw new Error("--state is required (baseline or changed)");
  if (!["baseline", "changed"].includes(args.state)) throw new Error(`--state must be baseline or changed, got ${args.state}`);

  const tasks = selectTasks(loadTasks(path.join(BENCH_DIR, "tasks")), args.tasks);
  const models = normalizeModels(args.models);
  const cells = tasks.flatMap((task) => models.map((model) => ({ task, model })));

  if (args.dryRun) {
    for (const { task, model } of cells) {
      console.log(`${args.state}\t${modelSlug(model)}\t${task.id}\t${task.repo}`);
    }
    console.log(`${cells.length} cell(s)`);
    return;
  }

  const rows = [];
  for (const { task, model } of cells) {
    process.stdout.write(`${args.state} ${modelSlug(model)} ${task.id} ... `);
    try {
      const result = await runCell({
        task,
        model,
        state: args.state,
        outRoot: args.out,
        force: Boolean(args.force),
        allowDirty: Boolean(args.allowDirty),
        timeoutOverride: args.timeout,
      });
      if (result.skipped) {
        console.log(`skip (exists; --force to rerun)`);
        continue;
      }
      const { record } = result;
      rows.push({ task: task.id, model, ...record });
      console.log(
        `${(record.wallMs / 1000).toFixed(1)} s, ${record.metrics.toolCallCount} calls, ${record.metrics.tokens} tok, ${record.check.passed ? "pass" : "CHECK FAILED"}`,
      );
    } catch (err) {
      console.log("ERROR");
      throw err;
    }
  }
  console.log("");
  printTable(rows);
}

main().catch((err) => {
  console.error(`bench: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
