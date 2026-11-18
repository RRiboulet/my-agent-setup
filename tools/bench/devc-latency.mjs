#!/usr/bin/env node
// Deterministic `devc` latency benchmark: no model, no tokens, just subprocess
// wall time. Run it before and after a `devc` change and compare p50/p90.
//
//   node tools/bench/devc-latency.mjs --runs 5            # smoke
//   node tools/bench/devc-latency.mjs --allow-mutating    # includes rebuild/up
//
// Mutating scenarios (rebuild, up) are skipped unless --allow-mutating: they
// replace containers, and a benchmark that quietly rebuilds four times is not a
// measurement, it is an outage.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const BENCH_DIR = import.meta.dirname;

function usage() {
  return `usage: node tools/bench/devc-latency.mjs [options]

  --scenarios <file>   default tools/bench/scenarios/devc.json
  --runs <n>           override every scenario's run count
  --out <file>         default tools/bench/results/devc-latency-<date>.json
  --allow-mutating     include rebuild/up scenarios
  --dry-run            list what would run
`;
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
    switch (arg) {
      case "--scenarios": args.scenarios = next(); break;
      case "--runs": args.runs = Number(next()); break;
      case "--out": args.out = path.resolve(next()); break;
      case "--allow-mutating": args.allowMutating = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "-h":
      case "--help": args.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function runOnce(argv, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn("devc", argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ wallMs: Number(process.hrtime.bigint() - started) / 1e6, code: null, timedOut, error: error.message, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ wallMs: Number(process.hrtime.bigint() - started) / 1e6, code, timedOut, error: null, stdout, stderr });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const scenariosPath = args.scenarios ? path.resolve(args.scenarios) : path.join(BENCH_DIR, "scenarios", "devc.json");
  const scenarios = JSON.parse(fs.readFileSync(scenariosPath, "utf8"));
  if (!Array.isArray(scenarios) || scenarios.length === 0) throw new Error(`${scenariosPath}: expected a non-empty array`);

  const selected = scenarios.filter((scenario) => args.allowMutating || !scenario.mutating);
  if (args.dryRun) {
    for (const scenario of selected) {
      console.log(`${scenario.id}\tdevc ${scenario.args.join(" ")}\truns=${args.runs ?? scenario.runs}\tcwd=${scenario.cwd ?? "/home/ubuntu"}`);
    }
    const skipped = scenarios.length - selected.length;
    if (skipped > 0) console.log(`skipped ${skipped} mutating scenario(s); pass --allow-mutating to include them`);
    return;
  }

  const results = [];
  for (const scenario of selected) {
    const runs = args.runs ?? scenario.runs ?? 1;
    const cwd = scenario.cwd ?? "/home/ubuntu";
    const timeoutMs = scenario.timeoutMs ?? 180000;
    const samples = [];
    const exitCodes = new Set();
    for (let i = 0; i < runs; i++) {
      const result = await runOnce(scenario.args, cwd, timeoutMs);
      samples.push(result.wallMs);
      exitCodes.add(result.code);
      if (i === 0 && result.error) throw new Error(`${scenario.id}: ${result.error}`);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    results.push({
      id: scenario.id,
      argv: ["devc", ...scenario.args],
      cwd,
      mutating: Boolean(scenario.mutating),
      runs,
      exitCodes: [...exitCodes],
      p50Ms: percentile(sorted, 50),
      p90Ms: percentile(sorted, 90),
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      samplesMs: samples,
    });
    const result = results[results.length - 1];
    console.log(`${scenario.id.padEnd(24)} n=${String(runs).padEnd(4)} p50=${Math.round(result.p50Ms)} ms  p90=${Math.round(result.p90Ms)} ms  exits=${[...exitCodes].join(",")}`);
  }

  const outFile = args.out ?? path.join(BENCH_DIR, "results", `devc-latency-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        host: { platform: os.platform(), cpus: os.cpus().length, loadavg: os.loadavg() },
        scenarios: results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${outFile}`);
}

main().catch((err) => {
  console.error(`devc-latency: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
