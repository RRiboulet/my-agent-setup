// Load guard + behavior tests for review.ts.
//
// Part 1 is a load guard: review.ts must load under a strict ESM linker. pi
// loads extensions through jiti, whose CJS interop resolves missing named
// exports lazily — a module importing a symbol that pi 1.0 removed still
// "loads" through jiti and only fails when the code path runs. Importing the
// module here with `node --test` uses the real ESM linker, so a removed import
// fails at load time and this test goes red.
//
// Part 2 exercises the helpers the local testability refactor moved out of the
// factory and exposed via the `__test__` export: the arg parsers, PR-ref
// parsing, and the rubric/verdict logic the review loop relies on. These are
// the parts of the vendored file we changed, and upstream ships them with no
// tests at all.
//
// Importing the module has no side effects: the factory is only called when
// pi actually loads the extension.

import assert from "node:assert/strict";
import { test } from "node:test";

const SPECIFIER = new URL("../../review.ts", import.meta.url).href;

type ReviewTargetShape = {
	type: string;
	branch?: string;
	sha?: string;
	title?: string;
	paths?: string[];
	ref?: string;
	prNumber?: number;
	baseBranch?: string;
};

type ParsedArgs = {
	target: ReviewTargetShape | null;
	extraInstruction?: string;
	error?: string;
};

type ReviewHelpers = {
	parseReviewPaths: (value: string) => string[];
	tokenizeArgs: (value: string) => string[];
	parseArgs: (args: string | undefined) => ParsedArgs;
	parsePrReference: (ref: string) => number | null;
	parseMarkdownHeading: (line: string) => { level: number; title: string } | null;
	getFindingsSectionBounds: (lines: string[]) => { start: number; end: number } | null;
	isLikelyFindingLine: (line: string) => boolean;
	normalizeVerdictValue: (value: string) => string;
	isNeedsAttentionVerdictValue: (value: string) => boolean;
	hasNeedsAttentionVerdict: (messageText: string) => boolean;
	hasBlockingReviewFindings: (messageText: string) => boolean;
	getUserFacingHint: (target: ReviewTargetShape) => string;
	extractAssistantTextContent: (content: unknown) => string;
};

async function loadHelpers(): Promise<ReviewHelpers> {
	const module = (await import(SPECIFIER)) as { default?: unknown; __test__?: ReviewHelpers };
	assert.ok(typeof module.default === "function", "review.ts must export a default extension factory");
	assert.ok(module.__test__ !== undefined, "review.ts must export __test__ (see the file header)");
	return module.__test__ as ReviewHelpers;
}

test("review.ts loads under strict ESM with a __test__ export", async () => {
	// The load guard itself: fail at import time on a removed pi symbol, and
	// keep the __test__ tail load-bearing for the behavior tests below.
	await loadHelpers();
});

test("tokenizeArgs splits on whitespace and honours quoted spans", async () => {
	const { tokenizeArgs } = await loadHelpers();
	assert.deepEqual(tokenizeArgs("branch main"), ["branch", "main"]);
	assert.deepEqual(tokenizeArgs('--extra "focus on perf"'), ["--extra", "focus on perf"]);
	assert.deepEqual(tokenizeArgs("--extra 'focus on perf'"), ["--extra", "focus on perf"]);
	assert.deepEqual(tokenizeArgs('say "hello\\" world"'), ["say", 'hello" world']);
	assert.deepEqual(tokenizeArgs(""), []);
});

test("parseArgs resolves every review mode", async () => {
	const { parseArgs } = await loadHelpers();
	assert.deepEqual(parseArgs(undefined), { target: null });
	assert.deepEqual(parseArgs("   "), { target: null });
	assert.deepEqual(parseArgs("uncommitted"), { target: { type: "uncommitted" }, extraInstruction: undefined });
	assert.deepEqual(parseArgs("branch main"), { target: { type: "baseBranch", branch: "main" }, extraInstruction: undefined });
	assert.deepEqual(parseArgs("branch"), { target: null, extraInstruction: undefined });
	assert.deepEqual(parseArgs("commit abc123"), { target: { type: "commit", sha: "abc123", title: undefined }, extraInstruction: undefined });
	assert.deepEqual(parseArgs("commit abc123 add docs"), { target: { type: "commit", sha: "abc123", title: "add docs" }, extraInstruction: undefined });
	assert.deepEqual(parseArgs("folder src docs"), { target: { type: "folder", paths: ["src", "docs"] }, extraInstruction: undefined });
	assert.deepEqual(parseArgs("pr 123"), { target: { type: "pr", ref: "123" }, extraInstruction: undefined });
	assert.deepEqual(parseArgs("bogus"), { target: null, extraInstruction: undefined });
});

test("parseArgs handles --extra and reports a missing value", async () => {
	const { parseArgs } = await loadHelpers();
	assert.deepEqual(parseArgs("--extra focus uncommitted"), { target: { type: "uncommitted" }, extraInstruction: "focus" });
	assert.deepEqual(parseArgs('--extra "focus on perf" uncommitted'), { target: { type: "uncommitted" }, extraInstruction: "focus on perf" });
	assert.deepEqual(parseArgs("--extra=perf uncommitted"), { target: { type: "uncommitted" }, extraInstruction: "perf" });
	assert.deepEqual(parseArgs("--extra"), { target: null, error: "Missing value for --extra" });
});

test("parseReviewPaths splits paths and drops empty entries", async () => {
	const { parseReviewPaths } = await loadHelpers();
	assert.deepEqual(parseReviewPaths("src docs"), ["src", "docs"]);
	assert.deepEqual(parseReviewPaths("  a   b\tc "), ["a", "b", "c"]);
	assert.deepEqual(parseReviewPaths(""), []);
});

test("parsePrReference accepts a number or a GitHub pull URL", async () => {
	const { parsePrReference } = await loadHelpers();
	assert.equal(parsePrReference("123"), 123);
	assert.equal(parsePrReference(" 789 "), 789);
	assert.equal(parsePrReference("https://github.com/owner/repo/pull/123"), 123);
	assert.equal(parsePrReference("github.com/owner/repo/pull/456"), 456);
	assert.equal(parsePrReference("0"), null);
	assert.equal(parsePrReference("not a pr"), null);
});

test("parseMarkdownHeading reads level and title", async () => {
	const { parseMarkdownHeading } = await loadHelpers();
	assert.deepEqual(parseMarkdownHeading("## Verdict"), { level: 2, title: "Verdict" });
	assert.deepEqual(parseMarkdownHeading("###### Deep ##"), { level: 6, title: "Deep" });
	assert.deepEqual(parseMarkdownHeading("not a heading"), null);
});

test("getFindingsSectionBounds spans only the findings section", async () => {
	const { getFindingsSectionBounds } = await loadHelpers();
	const lines = ["## Findings", "- [P1] auth bypass", "## Verdict", "needs attention"];
	assert.deepEqual(getFindingsSectionBounds(lines), { start: 1, end: 2 });
	assert.equal(getFindingsSectionBounds(["nothing about findings"]), null);
});

test("verdict values normalize and classify", async () => {
	const { normalizeVerdictValue, isNeedsAttentionVerdictValue } = await loadHelpers();
	assert.equal(normalizeVerdictValue("  - needs attention "), "needs attention");
	assert.equal(normalizeVerdictValue("`needs attention`"), "needs attention");
	assert.equal(isNeedsAttentionVerdictValue("needs attention"), true);
	assert.equal(isNeedsAttentionVerdictValue("correct"), false);
	assert.equal(isNeedsAttentionVerdictValue("not needs attention"), false);
	assert.equal(isNeedsAttentionVerdictValue("correct or needs attention"), false);
});

test("hasNeedsAttentionVerdict reads verdict lines and headings", async () => {
	const { hasNeedsAttentionVerdict } = await loadHelpers();
	assert.equal(hasNeedsAttentionVerdict("## Verdict\nneeds attention"), true);
	assert.equal(hasNeedsAttentionVerdict("Verdict: needs attention"), true);
	assert.equal(hasNeedsAttentionVerdict("- Verdict: correct"), false);
	assert.equal(hasNeedsAttentionVerdict("nothing to see"), false);
});

test("hasBlockingReviewFindings requires a tagged P0-P2 finding", async () => {
	const { hasBlockingReviewFindings } = await loadHelpers();
	const blocking = ["## Findings", "- [P1] auth bypass in login", "## Verdict", "needs attention"].join("\n");
	assert.equal(hasBlockingReviewFindings(blocking), true);
	const p3Only = ["## Findings", "- [P3] cosmetic nit"].join("\n");
	assert.equal(hasBlockingReviewFindings(p3Only), false);
	assert.equal(hasBlockingReviewFindings(""), false);
});

test("hasBlockingReviewFindings skips [P] tags inside code fences", async () => {
	const { hasBlockingReviewFindings } = await loadHelpers();
	const fenced = ["## Findings", "```", "- [P1] auth bypass, shown as example code", "```"].join("\n");
	assert.equal(hasBlockingReviewFindings(fenced), false);
	const unfenced = ["## Findings", "- [P1] auth bypass"].join("\n");
	assert.equal(hasBlockingReviewFindings(unfenced), true);
});

test("hasBlockingReviewFindings falls back to the verdict without tagged findings", async () => {
	const { hasBlockingReviewFindings } = await loadHelpers();
	const untagged = ["## Findings", "- login flow looks suspicious, but untagged", "## Verdict", "needs attention"].join("\n");
	assert.equal(hasBlockingReviewFindings(untagged), true);
	const untaggedCorrect = ["## Findings", "- login flow looks suspicious, but untagged", "## Verdict", "correct"].join("\n");
	assert.equal(hasBlockingReviewFindings(untaggedCorrect), false);
});

test("getUserFacingHint summarises a target", async () => {
	const { getUserFacingHint } = await loadHelpers();
	assert.equal(getUserFacingHint({ type: "uncommitted" }), "current changes");
	assert.equal(getUserFacingHint({ type: "baseBranch", branch: "main" }), "changes against 'main'");
	assert.equal(getUserFacingHint({ type: "commit", sha: "abcdef0123", title: "fix bug" }), "commit abcdef0: fix bug");
	assert.equal(
		getUserFacingHint({ type: "folder", paths: ["src", "docs", "tests", "scripts", "config"] }),
		"folders: src, docs, tests, scripts, config",
	);
	// Titles over 30 chars are trimmed to 27 plus an ellipsis.
	const prHint = getUserFacingHint({ type: "pullRequest", prNumber: 9, baseBranch: "dev", title: "a deliberately long pull request title" });
	assert.equal(prHint.length, 37); // "PR #9: " + 27 chars + "..."
	assert.ok(prHint.startsWith("PR #9: ") && prHint.endsWith("..."));
});

test("extractAssistantTextContent pulls text parts from a message", async () => {
	const { extractAssistantTextContent } = await loadHelpers();
	assert.equal(extractAssistantTextContent("  hello "), "hello");
	assert.equal(
		extractAssistantTextContent([
			{ type: "text", text: "line one" },
			{ type: "tool_use", id: "x", name: "bash" },
			{ type: "text", text: "  line two  " },
		]),
		"line one\n  line two", // parts join verbatim; only the outer edges trim
	);
	assert.equal(extractAssistantTextContent({ not: "content" }), "");
});
