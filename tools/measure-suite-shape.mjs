// Where a test run's wall clock actually goes, per file, and what a better
// schedule could do about it.
//
//   node tools/measure-suite-shape.mjs [--lanes 8] [--dir .pi/extensions/subagent/test]
//
// It measures by RUNNING the files, one at a time, and timing each child
// process. That is not a stylistic choice: node 24's TAP reporter emits one
// subtest per *test*, with no file-level grouping, so a TAP file cannot be
// attributed to the files that produced it. Timing each file's own process is
// also what a lane actually pays, node startup included.
//
// Read-only with respect to the repository: it writes no files, and its only
// side effects are the test processes themselves (which write their temp dirs
// exactly as a normal run does). Do not run it while something else is being
// timed — the numbers are about this machine at this moment.
//
// Why this exists. Raising `--test-concurrency` took a serial run from 184 s to
// ~120 s on a 2-core host, and the run still spends only ~55% of the CPU it is
// given, so what remains is waiting. Node schedules files without regard to how
// long they take, so a single slow file that starts late decides when the run
// ends. From one serial pass this script answers:
//
//   1. What does each file cost on its own?
//   2. What is the best a work-conserving scheduler could do at N lanes?
//      Longest-processing-time-first makespan, the standard practical bound.
//   3. Which files are the long poles, and how much of the floor is queueing
//      behind them rather than work.
//
// Deliberately not measured: CPU time (use `/usr/bin/time -v` on the real run),
// per-test cost inside a file (a file's tests run sequentially, so this is the
// right grain), and anything about a file that fails — failures are listed, and
// their duration is still reported, so a shape is never described from a red run
// without saying so.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args[index + 1];
};
const LANES = Number(flag("lanes", 8));
const DIR = flag("dir", ".pi/extensions/subagent/test");
if (!Number.isInteger(LANES) || LANES < 1) {
	console.error("--lanes must be a positive integer");
	process.exit(2);
}

const files = fs
	.readdirSync(DIR)
	.filter((name) => name.endsWith(".test.ts"))
	.sort();
if (files.length === 0) {
	console.error(`no *.test.ts under ${DIR}`);
	process.exit(1);
}

const measured = [];
const failed = [];
process.stderr.write(`measuring ${files.length} files serially under ${DIR} …\n`);
for (const name of files) {
	const started = Date.now();
	const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(DIR, name)], {
		stdio: "ignore",
	});
	const ms = Date.now() - started;
	measured.push({ name, ms });
	if (result.status !== 0) failed.push({ name, status: result.status, signal: result.signal });
	process.stderr.write(`  ${name} ${(ms / 1000).toFixed(1)}s${result.status === 0 ? "" : " (FAILED)"}\n`);
}

measured.sort((a, b) => b.ms - a.ms);
const total = measured.reduce((sum, file) => sum + file.ms, 0);

/** Longest-processing-time-first: greedy bin packing, close to optimal here. */
function schedule(lanes) {
	const bins = Array.from({ length: lanes }, () => ({ ms: 0, files: [] }));
	for (const file of measured) {
		const emptiest = bins.reduce((a, b) => (a.ms <= b.ms ? a : b));
		emptiest.ms += file.ms;
		emptiest.files.push(file.name);
	}
	return bins.sort((a, b) => b.ms - a.ms);
}

const bins = schedule(LANES);
const makespan = bins[0].ms;
const slowest = measured[0].ms;

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const share = (ms) => `${((100 * ms) / total).toFixed(1)}%`;

console.log(`\nfiles             ${measured.length}`);
console.log(`serial total      ${seconds(total)}`);
console.log(`slowest file      ${seconds(slowest)}  (${measured[0].name})`);
console.log(`at ${LANES} lanes      ${seconds(makespan)}  (LPT; ${((100 * makespan) / total).toFixed(1)}% of serial)`);
console.log(`speedup ceiling   ${(total / makespan).toFixed(2)}x`);

const poles = measured.filter((file) => file.ms >= 0.1 * makespan);
console.log(`\nlong poles — at least 10% of the ${LANES}-lane makespan (${poles.length}):`);
for (const file of poles) {
	console.log(`  ${seconds(file.ms).padStart(7)}  ${share(file.ms).padStart(6)} of serial  ${file.name}`);
}

console.log(`\n${LANES} lanes, busiest first:`);
for (const [index, bin] of bins.entries()) {
	console.log(`  lane ${index + 1}: ${seconds(bin.ms).padStart(7)}  ${bin.files.length} files`);
}

console.log(
	`\nbest case at ${LANES} lanes is ${seconds(makespan)}; ${seconds(makespan - slowest)} of that is queueing ` +
		`behind the slowest file, so splitting the poles is what moves the number.`,
);
if (failed.length > 0) {
	console.log(`\nWARNING: ${failed.length} file(s) did NOT pass in this measurement — this shape is from a red run:`);
	for (const entry of failed) console.log(`  ${entry.name} (exit ${entry.status}${entry.signal ? `, ${entry.signal}` : ""})`);
}
