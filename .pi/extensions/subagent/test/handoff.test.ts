// Unit tests for context handoff: child launch argv per mode, session seeding,
// the live-branch fork, and the usage baseline that keeps inherited parent
// turns out of a child's bill.
//
// Risk covered: `pi` rejects `--session` together with `--session-id` with a
// hard `process.exit(1)` (dist/main.js:243-256), and `pi --session <missing>`
// silently starts an empty session instead of failing. These argv shapes are
// therefore asserted directly rather than only by a live smoke test.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	buildChildPiArgs,
	buildSessionHeader,
	countSessionLines,
	forkLiveBranch,
	requireExistingSession,
	seedLineageSession,
	SESSION_VERSION,
	usesSessionFile,
	type ChildLaunchSpec,
} from "../handoff.ts";
import { readSessionUsage } from "../usage.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const BASE: ChildLaunchSpec = {
	mode: "standalone",
	invocation: ["node", "/usr/lib/pi.js"],
	provider: "openrouter",
	model: "some/model",
	thinking: "medium",
	sessionDir: "/run/session",
	sessionFile: "/run/session/standalone.jsonl",
	sessionId: "run-123",
	tmuxSession: "pi-agent-abc",
	trusted: false,
	extensionPath: "/ext/index.ts",
	promptPath: "/run/task.md",
};

function specFor(overrides: Partial<ChildLaunchSpec>): ChildLaunchSpec {
	return { ...BASE, ...overrides };
}

/** The value that follows `flag`, or undefined. */
function flagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

test("standalone addresses the child with --session-dir and --session-id", () => {
	const args = buildChildPiArgs(specFor({ mode: "standalone" }));
	assert.equal(flagValue(args, "--session-dir"), "/run/session");
	assert.equal(flagValue(args, "--session-id"), "run-123");
	assert.equal(args.includes("--session"), false);
});

test("lineage, fork and resume address the child with --session", () => {
	for (const mode of ["lineage", "fork", "resume"] as const) {
		const args = buildChildPiArgs(specFor({ mode, sessionFile: "/run/session/x.jsonl" }));
		assert.equal(flagValue(args, "--session"), "/run/session/x.jsonl", mode);
		// pi hard-exits if --session meets --session-id.
		assert.equal(args.includes("--session-id"), false, `${mode} must not pass --session-id`);
		assert.equal(args.includes("--session-dir"), false, `${mode} must not pass --session-dir`);
	}
});

test("every mode keeps the provider, model, trust flag and prompt argument", () => {
	for (const mode of ["standalone", "lineage", "fork", "resume"] as const) {
		const args = buildChildPiArgs(specFor({ mode }));
		assert.equal(flagValue(args, "--provider"), "openrouter");
		assert.equal(flagValue(args, "--model"), "some/model");
		assert.equal(flagValue(args, "--thinking"), "medium");
		assert.equal(flagValue(args, "--name"), "pi-agent-abc");
		assert.equal(args.includes("--no-approve"), true, mode);
		assert.equal(args.includes("--approve"), false, mode);
		assert.equal(args.at(-1), "@/run/task.md");
		assert.equal(flagValue(args, "--extension"), "/ext/index.ts");
	}
});

test("a trusted run switches to --approve", () => {
	const args = buildChildPiArgs(specFor({ trusted: true }));
	assert.equal(args.includes("--approve"), true);
	assert.equal(args.includes("--no-approve"), false);
});

test("session-file modes refuse to launch without a file", () => {
	for (const mode of ["lineage", "fork", "resume"] as const) {
		assert.throws(() => buildChildPiArgs(specFor({ mode, sessionFile: undefined })), /requires a sessionFile/);
	}
});

test("standalone refuses to launch without a dir or id", () => {
	assert.throws(() => buildChildPiArgs(specFor({ sessionDir: undefined })), /requires a sessionDir/);
	assert.throws(() => buildChildPiArgs(specFor({ sessionId: undefined })), /requires a sessionId/);
});

test("usesSessionFile distinguishes addressed modes", () => {
	assert.equal(usesSessionFile("standalone"), false);
	assert.equal(usesSessionFile("lineage"), true);
	assert.equal(usesSessionFile("fork"), true);
	assert.equal(usesSessionFile("resume"), true);
});

test("the session header is v3 and records the parent session", () => {
	const header = buildSessionHeader({ id: "abc", cwd: "/w", parentSession: "/p.jsonl" });
	assert.equal(header.type, "session");
	assert.equal(header.version, SESSION_VERSION);
	assert.equal(SESSION_VERSION, 3);
	assert.equal(header.id, "abc");
	assert.equal(header.cwd, "/w");
	assert.equal(header.parentSession, "/p.jsonl");
	assert.equal(typeof header.timestamp, "string");
	// No parent => no key, matching pi's own header construction.
	assert.equal("parentSession" in buildSessionHeader({ id: "abc", cwd: "/w" }), false);
});

test("seedLineageSession writes a header-only file that pi can open", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		const file = path.join(dir, "lineage.jsonl");
		await seedLineageSession({ sessionFile: file, id: "run-1", cwd: "/w", parentSession: "/parent.jsonl" });

		// The file must exist before launch: pi --session <missing> would
		// silently create a fresh session and drop the lineage link.
		const header = JSON.parse((await readFile(file, "utf8")).trim());
		assert.equal(header.type, "session");
		assert.equal(header.id, "run-1");
		assert.equal(header.parentSession, "/parent.jsonl");
		assert.equal(await countSessionLines(file), 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("seedLineageSession refuses to clobber an existing file", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		const file = path.join(dir, "lineage.jsonl");
		await seedLineageSession({ sessionFile: file, id: "a", cwd: "/w", parentSession: "/p.jsonl" });
		await assert.rejects(() => seedLineageSession({ sessionFile: file, id: "b", cwd: "/w", parentSession: "/p.jsonl" }));
		assert.equal(JSON.parse((await readFile(file, "utf8")).trim()).id, "a");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("forkLiveBranch puts the live leaf last so pi adopts it as active", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		const file = path.join(dir, "fork.jsonl");
		// Ancestors first, live leaf last: pi's _loadEntries assigns leafId to
		// every non-header entry in order, so the LAST line is the branch.
		const branch = [
			{ type: "message", id: "e1", parentId: null, message: { role: "user" } },
			{ type: "message", id: "e2", parentId: "e1", message: { role: "assistant" } },
		];
		const forked = await forkLiveBranch({ sessionFile: file, branch, id: "run-2", cwd: "/w", parentSession: "/p.jsonl" });
		assert.equal(forked.inheritedEntries, 2);

		const lines = (await readFile(file, "utf8")).trim().split("\n");
		assert.equal(lines.length, 3);
		assert.equal(JSON.parse(lines[0]).type, "session");
		assert.equal(JSON.parse(lines[1]).id, "e1");
		assert.equal(JSON.parse(lines.at(-1) as string).id, "e2");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("forkLiveBranch of an empty branch still yields an openable header", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		const file = path.join(dir, "fork.jsonl");
		const forked = await forkLiveBranch({ sessionFile: file, branch: [], id: "run-3", cwd: "/w", parentSession: "/p.jsonl" });
		assert.equal(forked.inheritedEntries, 0);
		assert.equal(await countSessionLines(file), 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a forked file opens on the parent's LIVE branch, not its last written entry", async () => {
	// The regression this guards: pi derives a session's active branch from the
	// last non-header line, and `SessionManager.forkFrom` copies every entry,
	// so a parent whose tail is NOT its live branch would hand the child the
	// wrong conversation. forkLiveBranch writes only the live branch instead.
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		const parentFile = path.join(dir, "parent.jsonl");
		const header = buildSessionHeader({ id: "parent", cwd: "/w" });
		await writeFile(
			parentFile,
			[
				JSON.stringify(header),
				JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "root" } }),
				JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: "live" } }),
				// A sibling branch that happens to be written last.
				JSON.stringify({ type: "message", id: "e3", parentId: "e1", message: { role: "assistant", content: "abandoned" } }),
				"",
			].join("\n"),
			"utf8",
		);

		const parent = SessionManager.open(parentFile);
		// Pin the live leaf to the real branch, as prepareHandoffSession does.
		const liveLeaf = "e2";
		assert.equal(parent.getBranch(liveLeaf).at(-1)?.id, "e2");

		const forkFile = path.join(dir, "fork.jsonl");
		await forkLiveBranch({
			sessionFile: forkFile,
			branch: parent.getBranch(liveLeaf),
			id: "child",
			cwd: "/w",
			parentSession: parentFile,
		});

		// The child, opened the way pi opens it, must be on the live branch.
		const child = SessionManager.open(forkFile);
		assert.equal(child.getLeafId(), "e2");
		assert.notEqual(child.getLeafId(), "e3");

		// The header keeps the lineage link back to the parent file.
		assert.equal((child.getHeader() as { parentSession?: string } | undefined)?.parentSession, parentFile);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a lineage session opens with no entries but a parent link", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		const parentFile = path.join(dir, "parent.jsonl");
		await writeFile(`${parentFile}`, `${JSON.stringify(buildSessionHeader({ id: "p", cwd: "/w" }))}\n`, "utf8");
		const file = path.join(dir, "lineage.jsonl");
		await seedLineageSession({ sessionFile: file, id: "child", cwd: "/w", parentSession: parentFile });

		const child = SessionManager.open(file);
		assert.equal(child.getEntries().length, 0);
		assert.equal((child.getHeader() as { parentSession?: string } | undefined)?.parentSession, parentFile);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("requireExistingSession fails loudly instead of letting pi start empty", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		assert.throws(() => requireExistingSession(undefined, "run-1"), /never reported one/);
		assert.throws(() => requireExistingSession(path.join(dir, "gone.jsonl"), "run-1"), /is missing/);

		const file = path.join(dir, "there.jsonl");
		await writeFile(file, "{}\n", "utf8");
		assert.equal(requireExistingSession(file, "run-1"), file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("countSessionLines ignores the trailing newline", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		const file = path.join(dir, "s.jsonl");
		await writeFile(file, '{"a":1}\n{"a":2}\n', "utf8");
		assert.equal(await countSessionLines(file), 2);
		await writeFile(file, "", "utf8");
		assert.equal(await countSessionLines(file), 0);
		await writeFile(file, '{"a":1}', "utf8");
		assert.equal(await countSessionLines(file), 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

function usageLine(id: string, role: "assistant" | "toolResult", totalTokens: number, cost: number): string {
	return `${JSON.stringify({
		type: "message",
		id,
		parentId: null,
		message: { role, usage: { input: totalTokens, output: 0, totalTokens, cost: { total: cost } } },
	})}\n`;
}

test("readSessionUsage sums the whole transcript by default", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		const file = path.join(dir, "s.jsonl");
		await writeFile(file, usageLine("a", "assistant", 100, 0.5) + usageLine("b", "toolResult", 10, 0.05), "utf8");
		const usage = await readSessionUsage(file);
		assert.equal(usage?.totalTokens, 110);
		assert.equal(usage?.turns, 1);
		assert.ok(Math.abs((usage?.cost ?? 0) - 0.55) < 1e-9);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a fork is not charged for the parent turns it inherited", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		const file = path.join(dir, "fork.jsonl");
		// Header + two inherited parent entries, then the child's own turn.
		const content =
			`${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: "/w" })}\n` +
			usageLine("p1", "assistant", 5000, 2) +
			usageLine("p2", "assistant", 5000, 2) +
			usageLine("c1", "assistant", 100, 0.1);
		await writeFile(file, content, "utf8");

		// usageFromLine = 1 header + 2 inherited entries.
		const usage = await readSessionUsage(file, { fromLine: 3 });
		assert.equal(usage?.totalTokens, 100);
		assert.equal(usage?.turns, 1);
		assert.ok(Math.abs((usage?.cost ?? 0) - 0.1) < 1e-9);

		// Without the baseline the parent turns are double-counted.
		assert.equal((await readSessionUsage(file))?.totalTokens, 10100);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a resume reports only its own new turns", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		const file = path.join(dir, "resume.jsonl");
		await writeFile(file, usageLine("a", "assistant", 800, 1) + usageLine("b", "assistant", 800, 1), "utf8");
		const fromLine = await countSessionLines(file);
		await writeFile(file, (await readFile(file, "utf8")) + usageLine("c", "assistant", 20, 0.02), "utf8");

		const usage = await readSessionUsage(file, { fromLine });
		assert.equal(usage?.totalTokens, 20);
		assert.equal(usage?.turns, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a baseline past the end of the file reports nothing", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		const file = path.join(dir, "s.jsonl");
		await writeFile(file, usageLine("a", "assistant", 100, 0.1), "utf8");
		assert.equal(await readSessionUsage(file, { fromLine: 99 }), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a negative baseline is clamped rather than skipping the head", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
	try {
		const file = path.join(dir, "s.jsonl");
		await writeFile(file, usageLine("a", "assistant", 100, 0.1), "utf8");
		assert.equal((await readSessionUsage(file, { fromLine: -5 }))?.totalTokens, 100);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readSessionUsage tolerates a missing file and an unknown session", async () => {
	assert.equal(await readSessionUsage(undefined), undefined);
	assert.equal(await readSessionUsage("/nonexistent/session.jsonl"), undefined);
});