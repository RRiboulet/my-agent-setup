#!/usr/bin/env node
// Aggregate one state's cells into a table and a single JSON file.
//
//   node tools/bench/summarize.mjs --state baseline
//   node tools/bench/summarize.mjs --state baseline --out tools/bench/results/baseline/summary.json
//
// The per-cell files stay authoritative; this is the view a human reads.

import fs from "node:fs";
import path from "node:path";

const BENCH_DIR = import.meta.dirname;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--state") args.state = argv[++i];
    else if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.out && !args.out.endsWith(".json")) throw new Error("--out must end with .json");
  if (args.help || !args.state) {
    console.log("usage: node tools/bench/summarize.mjs --state <baseline|changed> [--out <file>]");
    process.exit(args.help ? 0 : 1);
  }

  const root = path.join(BENCH_DIR, "results", args.state);
  if (!fs.existsSync(root)) throw new Error(`no results for state ${args.state} at ${root}`);

  const cells = [];
  for (const modelDir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!modelDir.isDirectory() || modelDir.name === "sessions") continue;
    const dir = path.join(root, modelDir.name);
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      try {
        const cell = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        cells.push(cell);
      } catch (err) {
        console.error(`summarize: skipping ${path.join(dir, file)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  cells.sort((a, b) => a.cell.task.localeCompare(b.cell.task) || a.cell.model.localeCompare(b.cell.model));

  const rows = cells.map((cell) => ({
    task: cell.cell.task,
    model: cell.cell.model,
    wallS: Number((cell.wallMs / 1000).toFixed(1)),
    calls: cell.metrics.toolCallCount,
    longestMs: Math.round(cell.metrics.longestToolMs),
    tokens: cell.metrics.tokens,
    errors: cell.metrics.errors,
    passed: cell.check.passed,
    suite: cell.suite ?? null,
    timedOut: cell.timedOut,
    head: cell.repoState?.head?.slice(0, 7) ?? "",
  }));

  const byTask = new Map();
  for (const row of rows) {
    if (!byTask.has(row.task)) byTask.set(row.task, []);
    byTask.get(row.task).push(row);
  }

  const lines = [];
  lines.push(`# Benchmark state: ${args.state}`);
  lines.push("");
  lines.push(`Cells: ${rows.length}. Generated ${new Date().toISOString()}.`);
  const heads = [...new Set(cells.map((cell) => cell.repoState?.head || "(non-git task)"))];
  const starts = cells.map((cell) => cell.startedAt).filter(Boolean).sort();
  lines.push(`Recorded: ${starts[0] ?? "?"} .. ${starts[starts.length - 1] ?? "?"}; harness head: ${heads.join(", ")}.`);
  lines.push("");
  lines.push("| task | model | wall s | calls | longest ms | tokens | errors | check | suite |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    const suite = row.suite ? `${row.suite.passed}/${row.suite.failed}${row.suite.green ? "" : " red"}` : "-";
    lines.push(
      `| ${row.task} | ${row.model.replace("opencode-go/", "")} | ${row.wallS} | ${row.calls} | ${row.longestMs} | ${row.tokens} | ${row.errors} | ${row.passed ? "pass" : `FAIL${row.timedOut ? " (timeout)" : ""}`} | ${suite} |`,
    );
  }
  lines.push("");
  lines.push("`check` means the task was completed; `suite` is the runner's own pass/fail count when the task reports one. A red suite with a passing check is a completed task that measured a red suite, not a green one.");
  lines.push("");
  lines.push("Each model contributes **one** run per task, so a median across models is not a distribution. Treat wall-time differences below ~2x as noise until there is a second run.");
  lines.push("");
  lines.push("## Per-task median across models");
  lines.push("");
  lines.push("| task | median wall s | median calls | median tokens |");
  lines.push("|---|---|---|---|");
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  };
  for (const [task, taskRows] of byTask) {
    lines.push(
      `| ${task} | ${median(taskRows.map((row) => row.wallS)).toFixed(1)} | ${median(taskRows.map((row) => row.calls))} | ${Math.round(median(taskRows.map((row) => row.tokens)))} |`,
    );
  }

  const summary = { schemaVersion: 1, state: args.state, generatedAt: new Date().toISOString(), cells: rows };
  const out = args.out ?? path.join(root, "summary.json");
  fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  const md = out.replace(/\.json$/, ".md");
  fs.writeFileSync(md, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  console.log(`\nwrote ${out}\nwrote ${md}`);
}

try {
  main();
} catch (err) {
  console.error(`summarize: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
