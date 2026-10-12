// Unit tests for the review-triage thin collectors (delta-brief §7).
//
// The properties that matter here are the ones a quiet bug would destroy:
//
//   - no fabrication: without a baseline there is no diff, and none is
//     invented — the artifact is recorded with its extent unknown and a
//     limitation says so, because an assumed-zero change is how a confident
//     "no review" gets fabricated;
//   - outcome distinctness: `passed`, `not-run` and `unknown` stay three
//     different things, and an unrecognised label becomes `unknown`, never
//     `passed`;
//   - nothing runs: the collectors are pure — no filesystem, no child process,
//     no clock they did not receive. The validation collector consumes
//     results; a check started by the triage tool would be a side effect a
//     recommendation is not allowed to have.
//
// Everything is pure: no git, no repository, no network.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	collectArtifacts,
	collectHarnessContext,
	collectValidations,
	MAX_DIFF_LINES,
	type CallerArtifact,
	type ExistingValidationResult,
	type HarnessEditRecord,
} from "../../review-triage/collectors.ts";
import {
	buildDossier,
	type ArtifactChangeItem,
	type DossierInput,
	type LimitationItem,
	type ValidationResultItem,
} from "../../review-triage/dossier.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASELINE = "abc123";
const NOW = 1_800_000_000_000; // an arbitrary fixed reference time

function artifact(path: string, overrides: Partial<CallerArtifact> = {}): CallerArtifact {
	return { path, ...overrides };
}

function artifactChange(items: readonly ArtifactChangeItem[], path: string): ArtifactChangeItem {
	const found = items.find((item) => item.kind === "artifact-change" && item.path === path);
	assert.ok(found && found.kind === "artifact-change", `no artifact-change item for ${path}`);
	return found;
}

function limitationOf(items: readonly LimitationItem[]): LimitationItem {
	const found = items.find((item) => item.kind === "limitation");
	assert.ok(found && found.kind === "limitation", "no limitation item");
	return found;
}

function validationOf(items: readonly ValidationResultItem[], check: string): ValidationResultItem {
	const found = items.find((item) => item.kind === "validation-result" && item.check === check);
	assert.ok(found && found.kind === "validation-result", `no validation-result item for ${check}`);
	return found;
}

// ---------------------------------------------------------------------------
// Artifact collector: computed diffs
// ---------------------------------------------------------------------------

test("artifacts: before/after snapshots produce a computed diff, not an asserted one", () => {
	const items = collectArtifacts([artifact("src/a.ts", { before: "one\ntwo\n", after: "one\nTWO\nthree\n" })], {
		baseline: BASELINE,
	});
	assert.equal(items.length, 1);
	const item = artifactChange(items, "src/a.ts");
	assert.equal(item.source, "filesystem");
	assert.equal(item.kind, "artifact-change");
	assert.equal(item.added, 2);
	assert.equal(item.removed, 1);
	assert.equal(item.patch, "-two\n+TWO\n+three");
	assert.equal(item.completeness, "complete");
	assert.equal(item.trust, "observed", "a diff derived from the supplied snapshots is observed");
	assert.equal(item.snapshot, BASELINE);
	assert.match(item.provenance, /snapshot/u);
});

test("artifacts: an edit shows as one removal and one addition", () => {
	const item = artifactChange(
		collectArtifacts([artifact("src/a.ts", { before: "line\n", after: "LINE\n" })], {}),
		"src/a.ts",
	);
	assert.equal(item.added, 1);
	assert.equal(item.removed, 1);
	assert.equal(item.patch, "-line\n+LINE");
});

test("artifacts: identical snapshots are a computed no-change", () => {
	const item = artifactChange(
		collectArtifacts([artifact("src/a.ts", { before: "same\n", after: "same\n" })], {}),
		"src/a.ts",
	);
	assert.equal(item.added, 0);
	assert.equal(item.removed, 0);
	assert.equal(item.patch, undefined, "an empty diff carries no patch");
});

test("artifacts: line endings normalise, so CRLF against LF is not a phantom diff", () => {
	const item = artifactChange(
		collectArtifacts([artifact("src/a.ts", { before: "same\r\n", after: "same\n" })], {}),
		"src/a.ts",
	);
	assert.equal(item.added, 0);
	assert.equal(item.removed, 0);
	assert.equal(item.patch, undefined, "no phantom diff means no patch");
});

test("artifacts: the snapshots show an added and a deleted file", () => {
	const items = collectArtifacts(
		[artifact("src/new.ts", { before: "", after: "body\n" }), artifact("src/gone.ts", { before: "body\n", after: "" })],
		{},
	);
	assert.equal(artifactChange(items, "src/new.ts").status, "A");
	assert.equal(artifactChange(items, "src/gone.ts").status, "D");
});

test("artifacts: a caller-supplied status beats the inference", () => {
	const item = artifactChange(
		collectArtifacts([artifact("src/a.ts", { before: "", after: "body\n", status: "M" })], {}),
		"src/a.ts",
	);
	assert.equal(item.status, "M");
});

test("artifacts: flags pass through", () => {
	const item = artifactChange(
		collectArtifacts([artifact("src/a.ts", { added: 1, removed: 0, flags: { binary: true } })], {}),
		"src/a.ts",
	);
	assert.deepEqual(item.flags, { binary: true });
});

// ---------------------------------------------------------------------------
// Artifact collector: no baseline is a recorded gap, never a fabricated diff
// ---------------------------------------------------------------------------

test("artifacts: a one-sided snapshot records the limitation and fabricates no diff", () => {
	const items = collectArtifacts([artifact("src/a.ts", { after: "new content\n" })], { baseline: BASELINE });
	const item = artifactChange(items, "src/a.ts");
	assert.equal(item.added, 0, "no counts are invented");
	assert.equal(item.removed, 0);
	assert.equal(item.patch, undefined, "no diff is fabricated");
	assert.equal(item.completeness, "missing");
	const limitation = limitationOf(items);
	assert.equal(limitation.source, "filesystem");
	assert.match(limitation.text, /one side/u);
});

test("artifacts: an entry with no counts and no snapshots is recorded with unknown extent", () => {
	const items = collectArtifacts([artifact("src/mystery.ts")], {});
	const item = artifactChange(items, "src/mystery.ts");
	assert.equal(item.added, 0);
	assert.equal(item.removed, 0);
	assert.equal(item.patch, undefined);
	assert.equal(item.completeness, "missing");
	assert.match(limitationOf(items).text, /no usable counts/u);
});

test("artifacts: a snapshot beyond the line cap is not diffed, and says what to do instead", () => {
	const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, index) => `line ${index}`).join("\n");
	const items = collectArtifacts([artifact("src/big.ts", { before: "small\n", after: big })], {});
	const item = artifactChange(items, "src/big.ts");
	assert.equal(item.patch, undefined);
	assert.equal(item.completeness, "missing");
	const limitation = limitationOf(items);
	assert.match(limitation.text, new RegExp(`${MAX_DIFF_LINES} lines`, "u"));
	assert.match(limitation.text, /explicit counts/u);
});

test("artifacts: an entry without a usable path is dropped, loudly", () => {
	const items = collectArtifacts([artifact("   "), artifact("", { before: "x" })], {});
	assert.equal(items.length, 2, "each bad entry is recorded, not swallowed");
	assert.ok(items.every((item) => item.kind === "limitation"));
	assert.match((items[0] as LimitationItem).text, /without a usable path/u);
});

// ---------------------------------------------------------------------------
// Artifact collector: asserted counts
// ---------------------------------------------------------------------------

test("artifacts: explicit counts are passed through as asserted, complete evidence", () => {
	const item = artifactChange(
		collectArtifacts([artifact("src/b.ts", { added: 3, removed: 2, status: "M" })], { baseline: BASELINE }),
		"src/b.ts",
	);
	assert.equal(item.added, 3);
	assert.equal(item.removed, 2);
	assert.equal(item.status, "M");
	assert.equal(item.completeness, "complete");
	assert.equal(item.trust, "asserted");
	assert.equal(item.patch, undefined);
});

test("artifacts: asserted counts that disagree with the snapshot diff lose, and the loss is recorded", () => {
	const items = collectArtifacts(
		[artifact("src/a.ts", { before: "one\n", after: "one\ntwo\n", added: 9, removed: 9 })],
		{},
	);
	const item = artifactChange(items, "src/a.ts");
	assert.equal(item.added, 1);
	assert.equal(item.removed, 0, "the computed diff wins over the asserted counts");
	assert.match(limitationOf(items).text, /disagree/u);
});

test("artifacts: the baseline stamps every item, and defaults to unknown", () => {
	const stamped = collectArtifacts([artifact("src/a.ts", { added: 1, removed: 0 })], { baseline: "dev" });
	assert.equal(artifactChange(stamped, "src/a.ts").snapshot, "dev");
	const unstamped = collectArtifacts([artifact("src/a.ts", { added: 1, removed: 0 })], {});
	assert.equal(artifactChange(unstamped, "src/a.ts").snapshot, "unknown");
});

// ---------------------------------------------------------------------------
// Harness context collector
// ---------------------------------------------------------------------------

test("harness: objective, acceptance criteria and identity land on the task, not the items", () => {
	const context = collectHarnessContext({
		objective: "make triage cheap",
		acceptanceCriteria: ["skips obvious edits", "reviews subtle ones"],
		identity: "TODO-18b56a2e",
	});
	assert.deepEqual(context.task, {
		objective: "make triage cheap",
		acceptance: ["skips obvious edits", "reviews subtle ones"],
		identity: "TODO-18b56a2e",
	});
});

test("harness: recorded edits become partial artifact items, and the coverage limit is stated", () => {
	const context = collectHarnessContext({ recordedEdits: [{ path: "src/a.ts", tool: "edit" }] });
	const item = artifactChange(context.items, "src/a.ts");
	assert.equal(item.source, "harness");
	assert.equal(item.completeness, "partial", "the record says edited, not by how much");
	assert.equal(item.added, 0);
	assert.equal(item.removed, 0);
	assert.equal(item.patch, undefined);
	assert.match(item.provenance, /edit/u);
	const limitation = limitationOf(context.items);
	assert.match(limitation.text, /shell/u);
});

test("harness: a recorded edit without a usable path is dropped, loudly", () => {
	const context = collectHarnessContext({ recordedEdits: [{ path: "  ", tool: "write" }] });
	assert.equal(context.items.length, 2, "the dropped edit plus the coverage limitation");
	assert.match(limitationOf(context.items).text, /without a usable path/u);
});

test("harness: an empty edit record says the footprint is unknown", () => {
	const context = collectHarnessContext({ recordedEdits: [] });
	const limitation = limitationOf(context.items);
	assert.match(limitation.text, /no recorded edits/u);
	assert.match(limitation.text, /shell/u);
});

test("harness: tool results pass through as supplementary context", () => {
	const context = collectHarnessContext({ toolResults: ["npm test: 42 passed", "tsc: clean"] });
	assert.deepEqual(context.supplementary, ["npm test: 42 passed", "tsc: clean"]);
});

test("harness: unresolved issues are self-reported limitations", () => {
	const context = collectHarnessContext({ unresolvedIssues: ["the Windows path is untested"] });
	const limitation = limitationOf(context.items);
	assert.equal(limitation.text, "the Windows path is untested");
	assert.equal(limitation.trust, "self-reported");
	assert.equal(limitation.completeness, "missing");
});

test("harness: an empty context records nothing", () => {
	const context = collectHarnessContext({});
	assert.deepEqual(context.items, []);
	assert.deepEqual(context.supplementary, []);
	assert.deepEqual(context.task, { acceptance: [] });
});

// ---------------------------------------------------------------------------
// Harness collector: malformed input is a recorded gap, not a crash or garbage
// ---------------------------------------------------------------------------

test("harness: a non-list edit record is a loud limitation, not a silent drop", () => {
	const context = collectHarnessContext({ recordedEdits: "yes" as never });
	assert.equal(context.items.length, 1);
	assert.match((context.items[0] as LimitationItem).text, /not a list/u);
});

test("harness: a non-list tool result is a loud limitation, not a throw", () => {
	const context = collectHarnessContext({ toolResults: "npm test" as never });
	assert.equal(context.items.length, 1);
	assert.match((context.items[0] as LimitationItem).text, /not a list/u);
	assert.deepEqual(context.supplementary, []);
});

test("harness: a non-list unresolved issue is one limitation, not per-character garbage", () => {
	const context = collectHarnessContext({ unresolvedIssues: "the Windows path is untested" as never });
	assert.equal(context.items.length, 1, "a string is not iterated into characters");
	assert.match((context.items[0] as LimitationItem).text, /not a list/u);
});

// ---------------------------------------------------------------------------
// Artifact collector: caller mistakes are recorded, not trusted
// ---------------------------------------------------------------------------

test("artifacts: a non-list artifact list reads nothing, loudly", () => {
	const items = collectArtifacts("src/a.ts" as never, {});
	assert.equal(items.length, 1);
	assert.match((items[0] as LimitationItem).text, /not a list/u);
});

test("artifacts: negative counts are a caller mistake, recorded rather than trusted", () => {
	const items = collectArtifacts([artifact("src/a.ts", { added: -5, removed: -2 })], {});
	const item = artifactChange(items, "src/a.ts");
	assert.equal(item.added, 0);
	assert.equal(item.removed, 0);
	assert.equal(item.completeness, "missing");
	const limitation = limitationOf(items);
	assert.match(limitation.text, /no usable counts/u);
	assert.match(limitation.text, /-5/u, "the offending value is quoted as data");
});

test("artifacts: a half-supplied count pair is not counted as counts", () => {
	const items = collectArtifacts([artifact("src/a.ts", { added: 3 })], {});
	const item = artifactChange(items, "src/a.ts");
	assert.equal(item.added, 0);
	assert.equal(item.completeness, "missing");
	assert.match(limitationOf(items).text, /no usable counts/u);
	assert.match(limitationOf(items).text, /3/u, "the half-supplied value is visible");
});

test("artifacts: an over-cap snapshot keeps the caller's stated counts and status", () => {
	const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, index) => `line ${index}`).join("\n");
	const items = collectArtifacts([artifact("src/big.ts", { before: "small\n", after: big, added: 7, removed: 1, status: "M" })], {});
	const item = artifactChange(items, "src/big.ts");
	assert.equal(item.added, 7, "the stated counts are used when the snapshot cannot be diffed");
	assert.equal(item.removed, 1);
	assert.equal(item.status, "M");
	assert.match(limitationOf(items).text, /stated counts/u);
});

test("artifacts: flags that are not an object are dropped, loudly", () => {
	const items = collectArtifacts([artifact("src/a.ts", { added: 1, removed: 0, flags: "yes" as never })], {});
	const item = artifactChange(items, "src/a.ts");
	assert.equal(item.flags, undefined);
	assert.match(limitationOf(items).text, /flags/u);
});

// ---------------------------------------------------------------------------
// Validation collector: malformed input and the completeness distinction
// ---------------------------------------------------------------------------

test("validation: a non-list result list reads nothing, loudly", () => {
	const items = collectValidations("tests" as never, {});
	assert.equal(items.length, 1);
	assert.match((items[0] as LimitationItem).text, /not a list/u);
});

test("validation: an honestly reported unknown is a complete record; an unrecognised label is not", () => {
	const items = collectValidations(
		[result("a", { outcome: "unknown", provenance: "npm test" }), result("b", { outcome: "mostly-green", provenance: "npm test" })],
		{},
	);
	assert.equal(validationOf(items, "a").outcome, "unknown");
	assert.equal(validationOf(items, "a").completeness, "complete", "the record itself is complete");
	assert.equal(validationOf(items, "b").completeness, "partial", "the collector could not read the label");
});

// ---------------------------------------------------------------------------
// Validation collector
// ---------------------------------------------------------------------------

function result(check: string, overrides: Partial<ExistingValidationResult> = {}): ExistingValidationResult {
	return { check, ...overrides };
}

test("validation: the four outcomes stay distinct, and a fresh pass is fresh", () => {
	const items = collectValidations(
		[
			result("tests", { outcome: "passed", provenance: "npm test", ranAt: NOW - 60_000 }),
			result("lint", { outcome: "failed", provenance: "npm run lint", ranAt: NOW - 60_000 }),
			result("typecheck", { outcome: "not-run" }),
			result("build", { outcome: "unknown" }),
		],
		{ now: NOW },
	);
	assert.equal(validationOf(items, "tests").outcome, "passed");
	assert.equal(validationOf(items, "lint").outcome, "failed");
	assert.equal(validationOf(items, "typecheck").outcome, "not-run");
	assert.equal(validationOf(items, "build").outcome, "unknown");
	assert.equal(validationOf(items, "tests").freshness, "fresh");
	assert.equal(validationOf(items, "typecheck").freshness, "unknown", "not-run without a run time is not fresh");
});

test("validation: an unrecognised label becomes unknown, never passed, and the original is preserved", () => {
	const items = collectValidations([result("tests", { outcome: "mostly-green", provenance: "npm test" })], { now: NOW });
	const item = validationOf(items, "tests");
	assert.equal(item.outcome, "unknown");
	assert.match(item.detail ?? "", /mostly-green/u, "the original label survives as data");
	assert.equal(item.completeness, "partial");
});

test("validation: an absent outcome is not-run, distinct from unknown", () => {
	const items = collectValidations([result("tests", { provenance: "npm test" })], { now: NOW });
	assert.equal(validationOf(items, "tests").outcome, "not-run");
});

test("validation: outcome labels match case-insensitively", () => {
	const items = collectValidations([result("tests", { outcome: "  PASSED  " })], { now: NOW });
	assert.equal(validationOf(items, "tests").outcome, "passed");
});

test("validation: freshness tracks the run time against the reference clock", () => {
	const fresh = validationOf(
		collectValidations([result("a", { outcome: "passed", ranAt: NOW - 59 * 60_000 })], { now: NOW }),
		"a",
	);
	assert.equal(fresh.freshness, "fresh");
	const stale = validationOf(
		collectValidations([result("a", { outcome: "passed", ranAt: NOW - 61 * 60_000 })], { now: NOW }),
		"a",
	);
	assert.equal(stale.freshness, "stale");
	const future = validationOf(
		collectValidations([result("a", { outcome: "passed", ranAt: NOW + 60_000 })], { now: NOW }),
		"a",
	);
	assert.equal(future.freshness, "unknown", "a run time in the future is not a trustworthy timeline");
	const noTime = validationOf(collectValidations([result("a", { outcome: "passed" })], { now: NOW }), "a");
	assert.equal(noTime.freshness, "unknown");
	const noNow = validationOf(collectValidations([result("a", { outcome: "passed", ranAt: NOW - 1_000 })]), "a");
	assert.equal(noNow.freshness, "unknown", "no clock is read unless one is handed in");
});

test("validation: provenance names its source; absent provenance is self-reported, not silent", () => {
	const items = collectValidations(
		[result("tests", { outcome: "passed", provenance: "npm test" }), result("lint", { outcome: "passed" })],
		{},
	);
	const withSource = validationOf(items, "tests");
	assert.equal(withSource.provenance, "npm test");
	assert.equal(withSource.trust, "asserted");
	const without = validationOf(items, "lint");
	assert.equal(without.provenance, "unspecified");
	assert.equal(without.trust, "self-reported");
	assert.equal(without.completeness, "partial");
});

test("validation: the snapshot passes through, defaulting to unknown", () => {
	const items = collectValidations(
		[result("tests", { outcome: "passed", snapshot: "dev" }), result("lint", { outcome: "passed" })],
		{},
	);
	assert.equal(validationOf(items, "tests").snapshot, "dev");
	assert.equal(validationOf(items, "lint").snapshot, "unknown");
});

test("validation: free text from the result is preserved", () => {
	const items = collectValidations([result("tests", { outcome: "failed", detail: "4 failures in a.test.ts" })], {});
	assert.equal(validationOf(items, "tests").detail, "4 failures in a.test.ts");
});

test("validation: a result without a check name is dropped, loudly", () => {
	const items = collectValidations([result("", { outcome: "passed" }), { outcome: "passed" }], {});
	assert.equal(items.length, 2);
	assert.ok(items.every((item) => item.kind === "limitation"), "both entries are recorded as limitations");
});

// ---------------------------------------------------------------------------
// The collectors are thin
// ---------------------------------------------------------------------------

test("collectors: the module reads no filesystem, spawns nothing, and tells no time but the one it is handed", () => {
	const source = readFileSync(new URL("../../review-triage/collectors.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /node:fs|node:child_process|node:path/u);
	assert.doesNotMatch(source, /Date\.now/u);
	assert.doesNotMatch(source, /\bexec\b|\bspawn\b|readFileSync|writeFileSync/u);
});

test("collectors: the same input twice gives the same items", () => {
	const entries: CallerArtifact[] = [
		artifact("src/a.ts", { before: "x\n", after: "y\n" }),
		artifact("src/b.ts", { added: 1, removed: 0 }),
	];
	const edits: HarnessEditRecord[] = [{ path: "src/a.ts", tool: "edit" }];
	const results: ExistingValidationResult[] = [result("tests", { outcome: "passed", ranAt: NOW - 1_000 })];
	assert.deepEqual(collectArtifacts(entries, { baseline: "dev" }), collectArtifacts(entries, { baseline: "dev" }));
	assert.deepEqual(collectHarnessContext({ recordedEdits: edits }), collectHarnessContext({ recordedEdits: edits }));
	assert.deepEqual(collectValidations(results, { now: NOW }), collectValidations(results, { now: NOW }));
});

// ---------------------------------------------------------------------------
// The items are dossier-shaped evidence
// ---------------------------------------------------------------------------

test("collectors: their items build a dossier whose fingerprint ignores item order", () => {
	const items = [
		...collectArtifacts([artifact("src/a.ts", { before: "x\n", after: "y\n" })], { baseline: "dev" }),
		...collectValidations([result("tests", { outcome: "passed", provenance: "npm test", ranAt: NOW })], { now: NOW }),
	];
	const context = collectHarnessContext({ objective: "make triage cheap" });
	const build = (list: DossierInput["items"]) =>
		buildDossier({
			items: list,
			task: { summary: "s", ...context.task },
			scope: { target: "uncommitted" },
			catalog: ["low:low"],
		}).fingerprint;
	assert.equal(build(items), build([...items].reverse()));
});
