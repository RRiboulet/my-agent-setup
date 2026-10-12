// Unit tests for the review-triage dossier builder.
//
// The properties that matter here are the ones a quiet bug would destroy:
//
//   - determinism: the same evidence must produce the same fingerprint, so a
//     re-run over an unchanged change is recognisable as one and a cache key
//     cannot drift with the wall clock;
//   - honesty: every truncation, omission and redaction must be recorded, and a
//     manifest that overflowed must say so, because "we could not see
//     everything" must never read as "there was nothing to see";
//   - redaction: a configured secret must not survive into the serialised form,
//     while the fact that something was removed must.
//
// Everything is pure: no network, no git, no filesystem.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildDossier,
	canonicalJson,
	DEFAULT_MANIFEST_LIMIT,
	normalisePath,
	pathPriority,
	RISK_RULES_VERSION,
	type ArtifactChangeItem,
	type DossierInput,
	type LimitationItem,
	type RequirementItem,
	type RiskSignalItem,
	type ValidationResultItem,
} from "../../review-triage/dossier.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function artifact(path: string, overrides: Partial<ArtifactChangeItem> = {}): ArtifactChangeItem {
	return {
		source: "git",
		kind: "artifact-change",
		provenance: "git diff --numstat",
		snapshot: "HEAD",
		completeness: "complete",
		trust: "observed",
		path,
		added: 1,
		removed: 0,
		...overrides,
	};
}

function signal(text: string, paths?: string[]): RiskSignalItem {
	return {
		source: "git",
		kind: "risk-signal",
		provenance: "detectSignals",
		snapshot: "HEAD",
		completeness: "complete",
		trust: "observed",
		signal: text,
		...(paths ? { paths } : {}),
	};
}

function validation(
	check: string,
	outcome: ValidationResultItem["outcome"],
	freshness: ValidationResultItem["freshness"],
): ValidationResultItem {
	return {
		source: "harness",
		kind: "validation-result",
		provenance: "test runner",
		snapshot: "HEAD",
		completeness: "complete",
		trust: "observed",
		check,
		outcome,
		freshness,
	};
}

function limitation(text: string): LimitationItem {
	return {
		source: "git",
		kind: "limitation",
		provenance: "collector",
		snapshot: "HEAD",
		completeness: "partial",
		trust: "observed",
		text,
	};
}

function requirement(text: string): RequirementItem {
	return {
		source: "user",
		kind: "requirement",
		provenance: "caller",
		snapshot: "HEAD",
		completeness: "complete",
		trust: "asserted",
		text,
	};
}

function input(overrides: Partial<DossierInput> = {}): DossierInput {
	return {
		items: [],
		task: { summary: "add a thing" },
		scope: { target: "uncommitted" },
		catalog: ["low:low", "medium:high", "high:max"],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// canonical form and fingerprint
// ---------------------------------------------------------------------------

test("dossier: canonical JSON sorts keys and drops undefined", () => {
	assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
	assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
	assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]", "arrays keep their order");
});

test("dossier: the same evidence gives the same fingerprint", () => {
	const items = [artifact("src/a.ts", { patch: "+x" }), signal("changes error handling")];
	const first = buildDossier(input({ items }));
	const second = buildDossier(input({ items }));
	assert.equal(first.fingerprint, second.fingerprint);
	assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
});

test("dossier: a timestamp never enters the fingerprint", () => {
	const first = buildDossier(input({ items: [artifact("src/a.ts")] }));
	// A real wall-clock wait, to catch any Date.now() that crept into the build.
	const until = Date.now() + 5;
	while (Date.now() < until) {
		/* spin */
	}
	const second = buildDossier(input({ items: [artifact("src/a.ts")] }));
	assert.equal(first.fingerprint, second.fingerprint);
	assert.doesNotMatch(canonicalJson(first.dossier), /"(generatedAt|builtAt|timestamp|collectedAt)"/u);
});

test("dossier: a different change gives a different fingerprint", () => {
	const a = buildDossier(input({ items: [artifact("src/a.ts")] }));
	const b = buildDossier(input({ items: [artifact("src/b.ts")] }));
	assert.notEqual(a.fingerprint, b.fingerprint);
});

// ---------------------------------------------------------------------------
// manifest limit and omissions
// ---------------------------------------------------------------------------

test("dossier: a manifest over its limit is truncated and marked as overflow", () => {
	const items = Array.from({ length: 5 }, (_, index) => artifact(`src/f${index}.ts`));
	const built = buildDossier(input({ items, manifestLimit: 3 }));
	assert.equal(built.manifestOverflow, true);
	assert.equal(built.dossier.manifest.total, 5);
	assert.equal(built.dossier.manifest.entries.length, 3);
	assert.equal(built.dossier.manifest.omitted, 2);
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("manifest truncated")));
});

test("dossier: a manifest within its limit is not an overflow", () => {
	const built = buildDossier(input({ items: [artifact("src/a.ts")], manifestLimit: DEFAULT_MANIFEST_LIMIT }));
	assert.equal(built.manifestOverflow, false);
	assert.equal(built.dossier.manifest.omitted, 0);
	assert.deepEqual(built.dossier.exclusions, []);
});

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

test("dossier: a redacted path is removed and the removal recorded without the value", () => {
	const built = buildDossier(
		input({
			items: [artifact("src/auth/secret.ts"), artifact("src/public.ts")],
			redaction: { paths: ["src/auth/**"] },
		}),
	);
	assert.deepEqual(
		built.dossier.manifest.entries.map((entry) => entry.path),
		["src/public.ts"],
	);
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("paths withheld")));
	assert.ok(
		!canonicalJson(built.dossier).includes("src/auth/secret.ts"),
		"recording the excluded path to prove the exclusion would defeat it",
	);
	assert.equal(
		built.manifestOverflow,
		true,
		"a path redaction leaves the judge blind, so the document cannot read as complete",
	);
});

test("dossier: a redacted pattern is masked, recorded, and absent from the serialised form", () => {
	const secret = "AKIAIOSFODNN7EXAMPLE";
	const built = buildDossier(
		input({
			items: [artifact("src/config.ts", { patch: `+const key = "${secret}"` })],
			supplementary: [`leaked ${secret}`],
			redaction: { patterns: ["AKIA[0-9A-Z]{16}"] },
		}),
	);
	const serialised = canonicalJson(built.dossier);
	assert.ok(!serialised.includes(secret), "the secret value must not survive");
	assert.ok(serialised.includes("[redacted]"));
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("redacted pattern")));
});

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

test("dossier: patch budget spends on security and migration paths first", () => {
	const built = buildDossier(
		input({
			items: [
				artifact("src/ordinary.ts", { patch: "x".repeat(100) }),
				artifact("src/auth/session.ts", { patch: "y".repeat(100) }),
			],
			budgetChars: 100_000,
			patchBudgetChars: 100,
		}),
	);
	const evidence = built.dossier.artifactEvidence;
	assert.equal(evidence[0]?.path, "src/auth/session.ts", "the security path gets the budget");
	assert.equal(evidence[1]?.omitted, true, "the ordinary patch is dropped once the budget is spent");
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("patch omitted for src/ordinary.ts")));
});

test("dossier: a patch over the per-file cap is truncated and recorded", () => {
	const built = buildDossier(
		input({
			items: [artifact("src/a.ts", { patch: "z".repeat(50) })],
			budgetChars: 100_000,
			patchChars: 10,
		}),
	);
	assert.equal(built.dossier.artifactEvidence[0]?.patch.length, 10);
	assert.equal(built.dossier.artifactEvidence[0]?.omitted, true);
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("patch truncated for src/a.ts")));
});

test("dossier: an over-budget document drops supplementary then patches, and says so", () => {
	const built = buildDossier(
		input({
			items: [artifact("src/a.ts", { patch: "p".repeat(500) })],
			supplementary: ["n".repeat(500)],
			budgetChars: 600,
			patchBudgetChars: 1_000,
		}),
	);
	assert.deepEqual(built.dossier.supplementary, []);
	assert.deepEqual(built.dossier.artifactEvidence, []);
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("supplementary context dropped")));
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("artifact evidence dropped")));
});

test("dossier: a budget that forces the manifest down is also an overflow", () => {
	const items = Array.from({ length: 40 }, (_, index) => artifact(`src/very/long/path/number/${index}.ts`));
	const built = buildDossier(input({ items, budgetChars: 300 }));
	assert.equal(built.manifestOverflow, true);
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("manifest trimmed")));
});

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

test("dossier: validation results are sorted and keep not-run distinct from passed", () => {
	const built = buildDossier(
		input({
			items: [validation("z-check", "passed", "fresh"), validation("a-check", "not-run", "unknown")],
		}),
	);
	assert.deepEqual(
		built.dossier.validation.map((entry) => entry.check),
		["a-check", "z-check"],
	);
	assert.equal(built.dossier.validation[0]?.outcome, "not-run");
	assert.equal(built.dossier.validation[1]?.freshness, "fresh");
});

test("dossier: risk signals keep their paths, deduplicated and sorted", () => {
	const built = buildDossier(
		input({
			items: [
				signal("beta", ["src/b.ts"]),
				signal("alpha", ["src/z.ts", "src/a.ts"]),
				signal("beta", ["src/a.ts"]),
			],
		}),
	);
	assert.deepEqual(built.dossier.riskSignals, [
		{ signal: "alpha", paths: ["src/a.ts", "src/z.ts"] },
		{ signal: "beta", paths: ["src/a.ts", "src/b.ts"] },
	]);
});

test("dossier: requirements and limitations are gathered from items and caller", () => {
	const built = buildDossier(
		input({
			items: [requirement("must not regress"), limitation("z-gap")],
			limitations: ["a-gap"],
		}),
	);
	assert.deepEqual(built.dossier.task.requirements, ["must not regress"]);
	assert.deepEqual(built.dossier.limitations, ["a-gap", "z-gap"]);
});

test("dossier: the catalog and the risk-rules version are part of the document", () => {
	const built = buildDossier(input({ catalog: ["low:low", "high:max"] }));
	assert.deepEqual(built.dossier.catalog, ["low:low", "high:max"]);
	assert.equal(built.dossier.versions.riskRules, RISK_RULES_VERSION);
});

test("dossier: a malformed item is dropped loudly, not trusted", () => {
	const built = buildDossier(input({ items: [{ kind: "bogus" } as never] }));
	assert.equal(built.dossier.manifest.entries.length, 0);
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("failed validation")));
});

// ---------------------------------------------------------------------------
// path handling
// ---------------------------------------------------------------------------

test("dossier: paths are normalised before they are counted or hashed", () => {
	assert.equal(normalisePath("./src\\auth\\a.ts"), "src/auth/a.ts");
	assert.equal(normalisePath("src/../secret.ts"), "secret.ts", "`..` is folded, not aliased");
	assert.equal(normalisePath("../outside.ts"), "../outside.ts", "a leading `..` is kept");
	const built = buildDossier(input({ items: [artifact("./src\\a.ts")] }));
	assert.equal(built.dossier.manifest.entries[0]?.path, "src/a.ts");
});

test("dossier: pathPriority marks security and migration paths", () => {
	assert.equal(pathPriority("src/auth/session.ts"), 1);
	assert.equal(pathPriority("db/migrations/001.sql"), 1);
	assert.equal(pathPriority("src/util/format.ts"), 0);
});

test("dossier: the scope snapshot resolves from the ref when not given", () => {
	const built = buildDossier(input({ scope: { target: "commit", ref: "abc123" } }));
	assert.equal(built.dossier.scope.snapshot, "abc123");
});

test("dossier: a validation entry carries the collector's trust level", () => {
	const built = buildDossier(
		input({
			items: [
				{
					source: "harness",
					kind: "validation-result",
					provenance: "npm test",
					snapshot: "HEAD",
					completeness: "complete",
					trust: "self-reported",
					check: "tests",
					outcome: "passed",
					freshness: "unknown",
				},
			],
		}),
	);
	assert.equal(
		built.dossier.validation[0]?.trust,
		"self-reported",
		"a caller's word must not reach Jev looking like an observed result",
	);
});

// ---------------------------------------------------------------------------
// validation and determinism regressions
// ---------------------------------------------------------------------------

test("dossier: a kind-specific payload that is missing is dropped, not crashed on", () => {
	// An `artifact-change` without a path used to reach normalisePath(undefined).
	const broken = { source: "git", kind: "artifact-change", provenance: "p", snapshot: "s", completeness: "complete", trust: "observed" };
	const built = buildDossier(input({ items: [broken as never] }));
	assert.equal(built.dossier.manifest.entries.length, 0);
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("failed validation")));
});

test("dossier: a non-finite count cannot collide with null in the fingerprint", () => {
	const nan = artifact("src/a.ts", { added: Number.NaN });
	const built = buildDossier(input({ items: [nan] }));
	assert.equal(built.dossier.manifest.entries.length, 0, "NaN is not a valid count");
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("failed validation")));
});

test("dossier: duplicate paths cannot make the fingerprint depend on arrival order", () => {
	const first = buildDossier(
		input({ items: [artifact("src/a.ts", { added: 1 }), artifact("src/a.ts", { added: 2 })] }),
	);
	const second = buildDossier(
		input({ items: [artifact("src/a.ts", { added: 2 }), artifact("src/a.ts", { added: 1 })] }),
	);
	assert.equal(first.fingerprint, second.fingerprint);
});

test("dossier: duplicate checks cannot make the fingerprint depend on arrival order", () => {
	const a = validation("same", "passed", "fresh");
	const b = validation("same", "failed", "stale");
	assert.equal(
		buildDossier(input({ items: [a, b] })).fingerprint,
		buildDossier(input({ items: [b, a] })).fingerprint,
	);
});

test("dossier: the whole item list can be reversed without changing the fingerprint", () => {
	const items = [
		artifact("src/a.ts", { patch: "+a" }),
		artifact("src/auth/b.ts", { patch: "+b" }),
		signal("changes error handling", ["src/a.ts"]),
		validation("tests", "passed", "fresh"),
	];
	assert.equal(
		buildDossier(input({ items })).fingerprint,
		buildDossier(input({ items: [...items].reverse() })).fingerprint,
	);
});

// ---------------------------------------------------------------------------
// redaction coverage and edge cases
// ---------------------------------------------------------------------------

test("dossier: redaction covers caller-supplied task, scope and catalog text", () => {
	const secret = "AKIAIOSFODNN7EXAMPLE";
	const built = buildDossier(
		input({
			task: { summary: `key ${secret}`, objective: `use ${secret}` },
			scope: { target: `commit ${secret}` },
			catalog: [`low:low ${secret}`],
			redaction: { patterns: ["AKIA[0-9A-Z]{16}"] },
		}),
	);
	assert.ok(!canonicalJson(built.dossier).includes(secret), "caller text must be redacted too");
});

test("dossier: a mask containing `$&` is inserted literally", () => {
	const built = buildDossier(
		input({
			items: [artifact("src/a.ts", { patch: "+secret=ABCD" })],
			redaction: { patterns: ["ABCD"], mask: "$&" },
		}),
	);
	// A `$&` mask must not re-insert the match; it is a literal four-character string.
	assert.equal(built.dossier.artifactEvidence[0]?.patch, "+secret=$&");
});

test("dossier: an invalid redaction pattern is recorded without echoing its source", () => {
	const built = buildDossier(
		input({ items: [artifact("src/a.ts")], redaction: { patterns: ["AKIA[SECRET"] } }),
	);
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("invalid redaction pattern")));
	assert.ok(
		!canonicalJson(built.dossier).includes("AKIA[SECRET"),
		"a pattern source may itself be secret-shaped and must not be echoed",
	);
});

// ---------------------------------------------------------------------------
// manifest accounting and budget exhaustion
// ---------------------------------------------------------------------------

test("dossier: manifest total is what the collector reported, before redaction", () => {
	const built = buildDossier(
		input({
			items: [artifact("src/auth/secret.ts"), artifact("src/public.ts")],
			redaction: { paths: ["src/auth/**"] },
		}),
	);
	assert.equal(built.dossier.manifest.total, 2, "the collector reported two artifacts");
	assert.equal(built.dossier.manifest.entries.length, 1);
	assert.equal(built.dossier.manifest.omitted, 1, "the redacted one is accounted for");
});

test("dossier: an over-budget document that cannot be trimmed is marked as overflow", () => {
	// A huge requirement has no other relief valve; before the fix this returned
	// manifestOverflow:false while the canonical form was far over budget.
	const built = buildDossier(
		input({ items: [requirement("r".repeat(50_000))], budgetChars: 100 }),
	);
	assert.equal(built.manifestOverflow, true);
	assert.ok(built.dossier.exclusions.some((entry) => entry.includes("task requirements dropped")));
});

test("dossier: the built-in risk-rules version cannot be shadowed by a caller", () => {
	const built = buildDossier(input({ versions: { riskRules: "forged" } }));
	assert.equal(built.dossier.versions.riskRules, RISK_RULES_VERSION);
});

test("dossier: supplementary notes are order-independent", () => {
	assert.equal(
		buildDossier(input({ supplementary: ["b", "a"] })).fingerprint,
		buildDossier(input({ supplementary: ["a", "b"] })).fingerprint,
	);
});

test("dossier: items stamped against different baselines are flagged", () => {
	const built = buildDossier(
		input({ items: [artifact("a.ts", { snapshot: "HEAD" }), artifact("b.ts", { snapshot: "abc123" })] }),
	);
	assert.ok(built.dossier.limitations.some((entry) => entry.includes("multiple baselines")));
});
