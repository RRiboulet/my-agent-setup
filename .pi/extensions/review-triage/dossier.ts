/**
 * The dossier: the deterministic, fingerprinted state Jev receives.
 *
 * Evidence arrives as typed {@link EvidenceItem}s — each one tagged with where
 * it came from, what kind of thing it is, who produced it, which snapshot it
 * describes, how complete it is and how far it can be trusted. This module
 * turns that pile into one canonical document and a SHA-256 of it.
 *
 * The build is a fixed pipeline, and every stage that removes something records
 * why:
 *
 *   validate → normalise paths → fixed sort → redact → manifest limit →
 *   patch budget → total budget → canonical serialise → fingerprint
 *
 * Two properties matter more than any single section:
 *
 *   - **Determinism.** The same inputs — items, task, scope, catalog, redaction
 *     and budget — produce the same fingerprint, byte for byte, whatever the
 *     wall clock says and whatever order the collector emitted its items in.
 *     The dossier contains no build timestamp, and every sort has a total
 *     tie-break, so a re-run over unchanged inputs is recognisable as one. The
 *     fingerprint is a cache/replay key; it does not make Jev's answer
 *     deterministic.
 *   - **Honesty about what is missing.** Truncation, redaction and omission are
 *     recorded in `exclusions`, and anything that made the document incomplete
 *     sets {@link BuiltDossier.manifestOverflow} — which policy turns into a
 *     refusal to skip, because "we could not see everything" must never read
 *     as "there was nothing to see".
 *
 * This file is pure. It reads no config, no clock and no filesystem.
 */

import { createHash } from "node:crypto";
import { MIGRATION_PATH, SECURITY_PATH, type ArtifactFlags } from "./evidence.ts";

// ---------------------------------------------------------------------------
// Evidence items
// ---------------------------------------------------------------------------

export type EvidenceSource = "git" | "filesystem" | "harness" | "user" | "agent-summary";
export type EvidenceKind =
	| "requirement"
	| "artifact-change"
	| "validation-result"
	| "risk-signal"
	| "limitation";
export type EvidenceCompleteness = "complete" | "partial" | "missing" | "unsupported" | "unknown";
export type EvidenceTrust = "observed" | "asserted" | "self-reported";
/** Freshness is a state, not a timestamp, so it cannot perturb the fingerprint. */
export type EvidenceFreshness = "fresh" | "stale" | "unknown";
export type ValidationOutcome = "passed" | "failed" | "not-run" | "unknown";

/** The fields every evidence item carries, whatever its payload. */
export interface EvidenceItemBase {
	source: EvidenceSource;
	kind: EvidenceKind;
	/** The command or caller that produced it, e.g. `git diff --numstat`. */
	provenance: string;
	/** Baseline identity, e.g. a commit sha or `uncommitted`. */
	snapshot: string;
	completeness: EvidenceCompleteness;
	trust: EvidenceTrust;
}

export interface ArtifactChangeItem extends EvidenceItemBase {
	kind: "artifact-change";
	path: string;
	added: number;
	removed: number;
	/** git status letter, when known (`A`, `M`, `D`, `R`, ...). */
	status?: string;
	/** Zero-context patch text for this path, when the collector has one. */
	patch?: string;
	flags?: ArtifactFlags;
}

export interface RiskSignalItem extends EvidenceItemBase {
	kind: "risk-signal";
	signal: string;
	paths?: string[];
}

export interface ValidationResultItem extends EvidenceItemBase {
	kind: "validation-result";
	check: string;
	outcome: ValidationOutcome;
	freshness: EvidenceFreshness;
	detail?: string;
}

export interface RequirementItem extends EvidenceItemBase {
	kind: "requirement";
	text: string;
}

export interface LimitationItem extends EvidenceItemBase {
	kind: "limitation";
	text: string;
}

export type EvidenceItem =
	| ArtifactChangeItem
	| RiskSignalItem
	| ValidationResultItem
	| RequirementItem
	| LimitationItem;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Configurable removal, applied before anything is serialised or fingerprinted.
 * A path exclusion drops the whole artifact; a pattern masks matching text in
 * every text-bearing field, including caller-supplied task and scope strings.
 * The *fact* of removal is recorded; the removed value is not, because
 * recording a secret to prove you removed it defeats the point.
 */
export interface RedactionConfig {
	/** Path globs (`*`, `**`, `?`) to exclude entirely. */
	paths?: readonly string[];
	/** Regular-expression sources; matching substrings are masked. */
	patterns?: readonly string[];
	/** Replacement for a masked match. Default `[redacted]`. */
	mask?: string;
}

// ---------------------------------------------------------------------------
// Dossier shape
// ---------------------------------------------------------------------------

export interface DossierManifestEntry {
	path: string;
	added: number;
	removed: number;
	status?: string;
	flags?: ArtifactFlags;
}

export interface DossierManifest {
	entries: DossierManifestEntry[];
	/** Artifact items the collector reported, before redaction or the limit. */
	total: number;
	/** Reported entries not present: redacted, over the limit, or budget-trimmed. */
	omitted: number;
	/** The documented limit applied. */
	limit: number;
}

export interface DossierPatch {
	path: string;
	patch: string;
	/** True when the patch was cut or dropped by the budget. */
	omitted?: boolean;
}

export interface DossierValidation {
	check: string;
	outcome: ValidationOutcome;
	freshness: EvidenceFreshness;
	provenance: string;
	completeness: EvidenceCompleteness;
	detail?: string;
}

/** A risk label plus the paths it was observed on. */
export interface DossierRiskSignal {
	signal: string;
	paths: string[];
}

export interface DossierTask {
	summary: string;
	objective?: string;
	acceptance?: string[];
	identity?: string;
	requirements: string[];
}

/** The task as supplied by the caller; requirements arrive as evidence items. */
export type DossierTaskInput = Omit<DossierTask, "requirements">;

export interface DossierScope {
	target: string;
	base?: string;
	ref?: string;
	snapshot: string;
}

/** The scope as supplied; the snapshot is resolved from the ref/base when omitted. */
export type DossierScopeInput = Omit<DossierScope, "snapshot"> & { snapshot?: string };

export interface Dossier {
	task: DossierTask;
	scope: DossierScope;
	manifest: DossierManifest;
	artifactEvidence: DossierPatch[];
	validation: DossierValidation[];
	riskSignals: DossierRiskSignal[];
	supplementary: string[];
	limitations: string[];
	catalog: string[];
	/** Every removal, truncation and omission, in the order it happened. */
	exclusions: string[];
	/** Version tags so a fingerprint can be replayed against the rules that made it. */
	versions: Record<string, string>;
}

export interface BuiltDossier {
	dossier: Dossier;
	/** SHA-256 (hex) of the canonical serialisation of `dossier`. */
	fingerprint: string;
	/**
	 * True when the document could not be made complete: the manifest overflowed
	 * its limit, or the character budget forced an omission. Policy must refuse
	 * to skip when this is set — an incomplete dossier is not evidence of a small
	 * change.
	 */
	manifestOverflow: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Identifies the rule set that ordered and labelled the dossier. */
export const RISK_RULES_VERSION = "1";
/**
 * Fallback character budget. The real path feeds this from `TriageConfig.stateChars`,
 * so the two are the same knob; the default exists only for standalone callers.
 */
export const DEFAULT_BUDGET_CHARS = 12_000;
/**
 * The documented manifest limit. It is deliberately small enough that a full
 * manifest fits the default budget; past it, the omission is recorded and skip
 * is blocked rather than the document quietly shrinking.
 */
export const DEFAULT_MANIFEST_LIMIT = 200;
export const DEFAULT_PATCH_CHARS = 4_000;

export interface DossierInput {
	items: readonly EvidenceItem[];
	task: DossierTaskInput;
	scope: DossierScopeInput;
	catalog: readonly string[];
	/** Caller context that is not itself an artifact or a signal. */
	supplementary?: readonly string[];
	/** Limitations the caller already knows about, merged with item limitations. */
	limitations?: readonly string[];
	redaction?: RedactionConfig;
	versions?: Record<string, string>;
	/** Total character budget for the canonical form. */
	budgetChars?: number;
	manifestLimit?: number;
	/** Per-file patch cap. */
	patchChars?: number;
	/** Total patch cap; defaults to half the character budget. */
	patchBudgetChars?: number;
}

// ---------------------------------------------------------------------------
// Determinism helpers
// ---------------------------------------------------------------------------

/**
 * Stable JSON: object keys sorted, `undefined` object members dropped, arrays
 * left in the order the builder set them (`undefined` elements become `null`,
 * matching `JSON.stringify`, so an array cannot collapse two distinct inputs).
 * Two structurally identical dossiers serialise to the same bytes, which is
 * what makes the fingerprint a replay key.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
	}
	const object = value as Record<string, unknown>;
	const keys = Object.keys(object)
		.filter((key) => object[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function fingerprintDossier(dossier: Dossier): string {
	return createHash("sha256").update(canonicalJson(dossier)).digest("hex");
}

// ---------------------------------------------------------------------------
// Path and redaction helpers
// ---------------------------------------------------------------------------

/**
 * Forward slashes, `.` and `..` segments folded, no leading `./`, so the same
 * file cannot hash twice under two spellings.
 */
export function normalisePath(path: string): string {
	const slashed = path.replace(/\\/gu, "/");
	const absolute = slashed.startsWith("/");
	const segments: string[] = [];
	for (const segment of slashed.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
			else if (!absolute) segments.push("..");
			continue;
		}
		segments.push(segment);
	}
	const joined = segments.join("/");
	return absolute ? `/${joined}` : joined;
}

/**
 * Budget ordering: security and migration paths are the ones a reviewer most
 * needs to see, so their patches are allocated first. This is an *ordering*
 * rule; the path categories themselves are shared with the collector so they
 * cannot drift.
 */
export function pathPriority(path: string): number {
	return SECURITY_PATH.test(path) || MIGRATION_PATH.test(path) ? 1 : 0;
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
	const pattern = escaped.replace(/\*\*|\*|\?/gu, (token) => {
		if (token === "**") return ".*";
		if (token === "*") return "[^/]*";
		return ".";
	});
	return new RegExp(`^${pattern}$`, "u");
}

interface CompiledRedaction {
	excludes(path: string): boolean;
	mask(text: string): string;
}

/**
 * Compile the redaction rules. An invalid glob or regex is a policy the owner
 * meant to apply and did not, so it is recorded rather than thrown — a config
 * typo must not take down the build.
 */
function compileRedaction(config: RedactionConfig | undefined, exclusions: string[]): CompiledRedaction {
	const pathMatchers: RegExp[] = [];
	for (const glob of config?.paths ?? []) {
		try {
			pathMatchers.push(globToRegExp(normalisePath(glob)));
		} catch {
			exclusions.push("ignored an invalid redaction path glob");
		}
	}
	const patternMatchers: RegExp[] = [];
	for (const source of config?.patterns ?? []) {
		try {
			patternMatchers.push(new RegExp(source, "gsu"));
		} catch {
			// The pattern source is configuration and may itself be secret-shaped,
			// so it is not echoed into a record that travels to the judge.
			exclusions.push("ignored an invalid redaction pattern (source withheld)");
		}
	}
	const mask = config?.mask ?? "[redacted]";
	return {
		excludes: (path) => pathMatchers.some((matcher) => matcher.test(path)),
		// A function replacement keeps `$&`, `$1` etc. in the mask literal.
		mask: (text) => patternMatchers.reduce((value, matcher) => value.replace(matcher, () => mask), text),
	};
}

/**
 * Mask a text field and record that something was removed — the fact, not the
 * value. Centralised so every text-bearing section behaves the same way.
 */
function maskText(
	text: string,
	redaction: CompiledRedaction,
	exclusions: string[],
	label: string,
): string {
	const masked = redaction.mask(text);
	if (masked !== text) exclusions.push(`redacted pattern match(es) in ${label}`);
	return masked;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SOURCES: readonly EvidenceSource[] = ["git", "filesystem", "harness", "user", "agent-summary"];
const KINDS: readonly EvidenceKind[] = [
	"requirement",
	"artifact-change",
	"validation-result",
	"risk-signal",
	"limitation",
];
const COMPLETENESS: readonly EvidenceCompleteness[] = [
	"complete",
	"partial",
	"missing",
	"unsupported",
	"unknown",
];
const TRUST: readonly EvidenceTrust[] = ["observed", "asserted", "self-reported"];
const OUTCOMES = ["passed", "failed", "not-run", "unknown"] as const;
const FRESHNESS: readonly EvidenceFreshness[] = ["fresh", "stale", "unknown"];

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate an item, including its kind-specific payload. A generic shape check
 * is not enough: an `artifact-change` without a path would crash the path
 * normaliser, and a non-finite count would serialise as `null` and collide with
 * a genuine `null` in the fingerprint.
 */
function isEvidenceItem(value: unknown): value is EvidenceItem {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	if (!SOURCES.includes(item.source as EvidenceSource)) return false;
	if (!KINDS.includes(item.kind as EvidenceKind)) return false;
	if (!COMPLETENESS.includes(item.completeness as EvidenceCompleteness)) return false;
	if (!TRUST.includes(item.trust as EvidenceTrust)) return false;
	if (typeof item.provenance !== "string" || typeof item.snapshot !== "string") return false;
	switch (item.kind) {
		case "artifact-change":
			return typeof item.path === "string" && isFiniteNumber(item.added) && isFiniteNumber(item.removed);
		case "risk-signal":
			return typeof item.signal === "string";
		case "validation-result":
			return (
				typeof item.check === "string" &&
				OUTCOMES.includes(item.outcome as (typeof OUTCOMES)[number]) &&
				FRESHNESS.includes(item.freshness as EvidenceFreshness)
			);
		case "requirement":
		case "limitation":
			return typeof item.text === "string";
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Total order over artifact items: priority, then path, then the item itself. */
function compareArtifacts(a: ArtifactChangeItem, b: ArtifactChangeItem): number {
	const priority = pathPriority(b.path) - pathPriority(a.path);
	if (priority !== 0) return priority;
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	const left = canonicalJson(a);
	const right = canonicalJson(b);
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Last-resort trim so the canonical form fits the budget. The manifest is the
 * last thing to go, and going at all means the document is incomplete: the
 * return value becomes `manifestOverflow`. If even that cannot meet the budget,
 * the overflow is recorded rather than silently returned as complete.
 */
function trimToBudget(dossier: Dossier, budgetChars: number): boolean {
	const over = () => canonicalJson(dossier).length > budgetChars;
	if (!over()) return false;

	const drop = (label: string, count: number, clear: () => void) => {
		if (count === 0) return;
		clear();
		dossier.exclusions.push(`${label} dropped (${count}) to meet the character budget`);
	};

	drop("supplementary context", dossier.supplementary.length, () => {
		dossier.supplementary = [];
	});
	if (!over()) return false;

	drop("artifact evidence", dossier.artifactEvidence.length, () => {
		dossier.artifactEvidence = [];
	});
	if (!over()) return false;

	drop("validation results", dossier.validation.length, () => {
		dossier.validation = [];
	});
	if (!over()) return false;

	drop("limitations", dossier.limitations.length, () => {
		dossier.limitations = [];
	});
	if (!over()) return false;

	drop("task requirements", dossier.task.requirements.length, () => {
		dossier.task.requirements = [];
	});
	if (!over()) return false;

	drop("catalog", dossier.catalog.length, () => {
		dossier.catalog = [];
	});
	if (!over()) return false;

	// Truncate the task text before touching the manifest.
	const taskCap = 400;
	if (dossier.task.summary.length > taskCap) {
		dossier.task.summary = dossier.task.summary.slice(0, taskCap);
		dossier.exclusions.push(`task summary truncated to ${taskCap} characters to meet the character budget`);
	}
	if (dossier.task.objective && dossier.task.objective.length > taskCap) {
		dossier.task.objective = dossier.task.objective.slice(0, taskCap);
		dossier.exclusions.push(`task objective truncated to ${taskCap} characters to meet the character budget`);
	}
	if (!over()) return false;

	let trimmed = false;
	while (dossier.manifest.entries.length > 0 && over()) {
		dossier.manifest.entries.pop();
		dossier.manifest.omitted += 1;
		trimmed = true;
	}
	if (trimmed) {
		dossier.exclusions.push(
			`manifest trimmed to ${dossier.manifest.entries.length} entries to meet the character budget`,
		);
	}
	if (!over()) return trimmed;

	dossier.exclusions.push("dossier still exceeds the character budget after trimming; marked as overflow");
	return true;
}

/**
 * Build the dossier. Deterministic given the same items, task, scope, catalog,
 * redaction and budget — no wall clock, no filesystem, no randomness, and no
 * dependence on the order the collector emitted its items in.
 */
export function buildDossier(input: DossierInput): BuiltDossier {
	const budgetChars = input.budgetChars ?? DEFAULT_BUDGET_CHARS;
	const manifestLimit = input.manifestLimit ?? DEFAULT_MANIFEST_LIMIT;
	const patchChars = input.patchChars ?? DEFAULT_PATCH_CHARS;
	const patchBudgetChars = input.patchBudgetChars ?? Math.floor(budgetChars / 2);
	const exclusions: string[] = [];
	const redaction = compileRedaction(input.redaction, exclusions);
	const mask = (text: string, label: string) => maskText(text, redaction, exclusions, label);

	// 1. Validate. A malformed item is dropped loudly rather than trusted.
	const items: EvidenceItem[] = [];
	for (const raw of input.items as readonly unknown[]) {
		if (isEvidenceItem(raw)) items.push(raw);
		else exclusions.push("dropped an evidence item that failed validation");
	}

	const artifacts = items.filter((item): item is ArtifactChangeItem => item.kind === "artifact-change");
	const riskItems = items.filter((item): item is RiskSignalItem => item.kind === "risk-signal");
	const validationItems = items.filter(
		(item): item is ValidationResultItem => item.kind === "validation-result",
	);
	const requirementItems = items.filter((item): item is RequirementItem => item.kind === "requirement");
	const limitationItems = items.filter((item): item is LimitationItem => item.kind === "limitation");

	// 2. Normalise paths and 3. redact, before anything is sorted or counted.
	const prepared: ArtifactChangeItem[] = [];
	let redactedArtifacts = 0;
	for (const item of artifacts) {
		const path = normalisePath(item.path);
		if (redaction.excludes(path)) {
			// The path was excluded because it is sensitive. Recording it to prove
			// the exclusion happened would defeat the exclusion, so the fact and
			// the count are recorded and the value is not.
			redactedArtifacts += 1;
			continue;
		}
		prepared.push({ ...item, path });
	}
	if (redactedArtifacts > 0) {
		exclusions.push(`redacted ${redactedArtifacts} artifact(s) (paths withheld)`);
	}

	// 4. Fixed sort with a total tie-break, so duplicate paths cannot make the
	// fingerprint depend on collector order.
	prepared.sort(compareArtifacts);

	// 5. Manifest limit. `total` is what the collector reported, before any
	// deliberate redaction, so omitted = total - kept is always honest.
	const total = artifacts.length;
	const overflow = prepared.length > manifestLimit;
	const kept = prepared.slice(0, manifestLimit);
	if (overflow) {
		exclusions.push(`manifest truncated: ${prepared.length - manifestLimit} of ${prepared.length} entries omitted`);
	}
	const manifestEntries: DossierManifestEntry[] = kept.map((item) => ({
		path: item.path,
		added: item.added,
		removed: item.removed,
		...(item.status ? { status: item.status } : {}),
		...(item.flags ? { flags: item.flags } : {}),
	}));

	// 6. Patch budget, in the already-prioritised order. One allowance covers
	// both the per-file cap and the remaining total, so a truncated patch cannot
	// jump the queue ahead of a later security path.
	const artifactEvidence: DossierPatch[] = [];
	let patchUsed = 0;
	for (const item of kept) {
		if (item.patch === undefined) continue;
		const patch = mask(item.patch, `the patch for ${item.path}`);
		const allowance = Math.min(patchChars, patchBudgetChars - patchUsed);
		if (allowance <= 0) {
			artifactEvidence.push({ path: item.path, patch: "", omitted: true });
			exclusions.push(`patch omitted for ${item.path} (total patch budget reached)`);
			continue;
		}
		if (patch.length > allowance) {
			artifactEvidence.push({ path: item.path, patch: patch.slice(0, allowance), omitted: true });
			patchUsed += allowance;
			exclusions.push(`patch truncated for ${item.path} to ${allowance} characters (kept the first ${allowance})`);
			continue;
		}
		artifactEvidence.push({ path: item.path, patch });
		patchUsed += patch.length;
	}

	// Risk signals carry their observed paths, deduplicated by label.
	const signalPaths = new Map<string, Set<string>>();
	for (const item of riskItems) {
		const signal = mask(item.signal, "a risk signal");
		const paths = signalPaths.get(signal) ?? new Set<string>();
		for (const rawPath of item.paths ?? []) {
			const path = normalisePath(rawPath);
			if (!redaction.excludes(path)) paths.add(mask(path, "a risk-signal path"));
		}
		signalPaths.set(signal, paths);
	}
	const riskSignals: DossierRiskSignal[] = [...signalPaths.entries()]
		.map(([signal, paths]) => ({ signal, paths: [...paths].sort() }))
		.sort((a, b) => (a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0));

	const validation: DossierValidation[] = validationItems
		.map((item) => ({
			check: mask(item.check, "a validation check"),
			outcome: item.outcome,
			freshness: item.freshness,
			provenance: mask(item.provenance, "a validation provenance"),
			completeness: item.completeness,
			...(item.detail ? { detail: mask(item.detail, "a validation detail") } : {}),
		}))
		.sort((a, b) => {
			if (a.check !== b.check) return a.check < b.check ? -1 : 1;
			const left = canonicalJson(a);
			const right = canonicalJson(b);
			return left < right ? -1 : left > right ? 1 : 0;
		});

	// A collector that stamps items against different baselines is telling us the
	// evidence is not all about one change; say so rather than picking one.
	const baselines = [...new Set(items.map((item) => item.snapshot))].sort();
	const mixedBaseline =
		baselines.length > 1
			? `evidence spans multiple baselines: ${baselines
					.map((baseline) => mask(baseline, "an evidence baseline"))
					.join(", ")}`
			: undefined;

	const dossier: Dossier = {
		task: {
			summary: mask(input.task.summary, "the task summary"),
			...(input.task.objective ? { objective: mask(input.task.objective, "the task objective") } : {}),
			...(input.task.acceptance
				? { acceptance: input.task.acceptance.map((entry) => mask(entry, "an acceptance criterion")) }
				: {}),
			...(input.task.identity ? { identity: mask(input.task.identity, "the task identity") } : {}),
			requirements: requirementItems.map((item) => mask(item.text, "a requirement")).sort(),
		},
		scope: {
			target: mask(input.scope.target, "the scope target"),
			...(input.scope.base ? { base: mask(input.scope.base, "the scope base") } : {}),
			...(input.scope.ref ? { ref: mask(input.scope.ref, "the scope ref") } : {}),
			snapshot: mask(
				input.scope.snapshot ?? input.scope.ref ?? input.scope.base ?? input.scope.target,
				"the scope snapshot",
			),
		},
		manifest: { entries: manifestEntries, total, omitted: total - kept.length, limit: manifestLimit },
		artifactEvidence,
		validation,
		riskSignals,
		supplementary: (input.supplementary ?? [])
			.map((note) => mask(note, "a supplementary note"))
			.sort(),
		limitations: [
			...new Set([
				...limitationItems.map((item) => mask(item.text, "a limitation")),
				...(input.limitations ?? []).map((text) => mask(text, "a caller limitation")),
				...(mixedBaseline ? [mixedBaseline] : []),
			]),
		].sort(),
		catalog: input.catalog.map((key) => mask(key, "a catalog entry")),
		exclusions,
		// The built-in rule version is authoritative; a caller cannot shadow it.
		versions: { ...(input.versions ?? {}), riskRules: RISK_RULES_VERSION },
	};

	// 7. Total budget. A manifest trim here is an overflow too.
	const budgetTrimmed = trimToBudget(dossier, budgetChars);

	return {
		dossier,
		fingerprint: fingerprintDossier(dossier),
		manifestOverflow: overflow || budgetTrimmed,
	};
}
