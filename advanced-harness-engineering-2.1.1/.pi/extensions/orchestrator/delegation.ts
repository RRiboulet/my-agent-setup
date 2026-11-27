/**
 * Pure logic and configuration loader for the Pragmatic Orchestrator delegation
 * workflow: role->model routing, per-turn discovery budgets, parent write caps,
 * read-only shell allowlist, and post-edit test/code-review completion gates.
 *
 * Zero Pi runtime coupling: every rule is testable as a pure function.
 */

import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GATE_CONFIG_BASENAME } from "./config.ts";
import type { RunSettledPayload, RunStartedPayload, RunsSnapshotPayload } from "./events.ts";
import { detectWeakCommand } from "./verify.ts";

export const DELEGATION_MODES = ["enforce", "warn", "off"] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];

export const DELEGATION_SECTION = "delegation";
export const DELEGATION_CONFIG_BASENAME = "orchestrator-delegation.json";
export const DELEGATION_ENV = "PI_ORCHESTRATOR_DELEGATION";
export const DELEGATION_CONFIG_ENV = "PI_ORCHESTRATOR_DELEGATION_CONFIG";
export const RECORD_REVIEW_TOOL = "orchestrator_record_review";
export const MAIN_REVIEW_VERDICTS = ["pass", "accepted_with_notes", "fail"] as const;
export type MainReviewVerdict = (typeof MAIN_REVIEW_VERDICTS)[number];

export interface MainModelReviewRecord {
	verdict: MainReviewVerdict;
	scope: string;
	summary: string;
	inspectedPaths?: string[];
	recordedAt: number;
}

export interface MainModelReviewResult {
	ok: boolean;
	error?: string;
	review?: MainModelReviewRecord;
}

export type TurnMode = "qa" | "debug" | "review" | "implement" | "quick-fix" | "security";

export interface RoleSpec {
	provider?: string;
	model?: string;
	inheritModel?: boolean;
	thinking?: string;
	tools?: string[];
	description: string;
	configuredByUser: boolean;
}

export interface DelegationConfig {
	mode: DelegationMode;
	directPrefix: string;
	discoveryTools: string[];
	discoveryBudgets: Record<TurnMode, number>;
	maxEditLines: number;
	maxEditedFilesPerTurn: number;
	steerUnlockThreshold: number;
	settleAttemptCap: number;
	reviewThresholdFiles: number;
	reviewThresholdLines: number;
	exemptExtensions: string[];
	testExtensions: string[];
	reviewExtensions: string[];
	verifyCommandPatterns: string[];
	verifyExcludePatterns: string[];
	modelMentionPatterns: string[];
	roles: Record<string, RoleSpec>;
}

export interface DelegationConfigRead {
	config: DelegationConfig;
	warnings: string[];
}

export interface TurnClassification {
	turnMode: TurnMode;
	discoveryBudget: number;
	directBypass: boolean;
	promptHasModelMention: boolean;
}

export interface DelegationState {
	// Turn state
	turnMode: TurnMode;
	discoveryBudget: number;
	discoveryCount: number;
	directBypass: boolean;
	promptHasModelMention: boolean;
	editedFilesThisTurn: Set<string>;
	steerCounts: Map<string, number>;
	countedSteerToolCallIds: Set<string>;
	escalationUnlocked: boolean;
	settleBlocksThisTurn: number;
	// Session state
	viewedFiles: Set<string>;
	testsRequired: boolean;
	testsVerified: boolean;
	reviewRequired: boolean;
	reviewVerified: boolean;
	dirtyReviewFiles: Set<string>;
	dirtyReviewLines: number;
	lastCodeEditAt: number;
	lastReviewEditAt: number;
	lastReviewInspectionAt: number;
	lastMainReview: MainModelReviewRecord | null;
	runLineage: Map<string, string>;
}

export const DEFAULT_ROLES: Readonly<Record<string, RoleSpec>> = {
	explore: {
		provider: "opencode-go",
		model: "deepseek-v4.1-flash",
		inheritModel: false,
		thinking: "medium",
		tools: ["read", "grep", "find", "ls"],
		description: "Fast/cheap read-only codebase search and discovery",
		configuredByUser: false,
	},
	research: {
		provider: "opencode-go",
		model: "deepseek-v4.1-flash",
		inheritModel: false,
		thinking: "low",
		tools: ["read", "grep", "find", "ls"],
		description: "Fast/cheap read-only docs and reference lookup",
		configuredByUser: false,
	},
	coder: {
		provider: "opencode-go",
		model: "hy4-flash-free",
		inheritModel: false,
		thinking: "high",
		description: "Mid-tier implementation, multi-file edits, and running tests/linters",
		configuredByUser: false,
	},
	reviewer: {
		inheritModel: true,
		thinking: "high",
		tools: ["read", "grep", "find", "ls", "bash"],
		description: "Frontier-model independent code review",
		configuredByUser: false,
	},
	"security-reviewer": {
		inheritModel: true,
		thinking: "high",
		tools: ["read", "grep", "find", "ls", "bash"],
		description: "Frontier-model security and vulnerability audit",
		configuredByUser: false,
	},
};

export const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
	mode: "enforce",
	directPrefix: "!direct",
	discoveryTools: ["read", "grep", "find", "ls"],
	discoveryBudgets: {
		qa: 8,
		debug: 5,
		review: 5,
		implement: 4,
		"quick-fix": 4,
		security: 2,
	},
	maxEditLines: 20,
	maxEditedFilesPerTurn: 1,
	steerUnlockThreshold: 2,
	settleAttemptCap: 2,
	reviewThresholdFiles: 2,
	reviewThresholdLines: 50,
	exemptExtensions: [".md", ".txt", ".rst", ".adoc"],
	testExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".sh"],
	reviewExtensions: [
		".ts",
		".tsx",
		".js",
		".jsx",
		".mjs",
		".cjs",
		".py",
		".go",
		".rs",
		".java",
		".rb",
		".sh",
		".tf",
		".sql",
		".json",
		".yml",
		".yaml",
		".toml",
	],
	verifyCommandPatterns: [
		String.raw`\bnode\s+--test\b`,
		String.raw`\bpytest\b`,
		String.raw`\bruff\b`,
		String.raw`\bvitest\b`,
		String.raw`\bjest\b`,
		String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|check|typecheck)\b`,
		String.raw`\bcargo\s+(test|check|clippy)\b`,
		String.raw`\bgo\s+test\b`,
		String.raw`\bmake\s+test\b`,
		String.raw`\bunittest\b`,
		String.raw`run_[^\s]*tests\.sh`,
		String.raw`test-isolated-[^\s]*\.sh`,
	],
	verifyExcludePatterns: ["test-local-", String.raw`\buvicorn\b`, String.raw`\bwatch\b`, String.raw`--watch\b`],
	modelMentionPatterns: [
		String.raw`\b(opus|sonnet|haiku|neon|hydrogen|deepseek|glm|mistral|gemini|claude|gpt[\w.-]*|hy4|openrouter|opencode-go|model|provider)\b`,
	],
	roles: DEFAULT_ROLES as Record<string, RoleSpec>,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneRoles(roles: Readonly<Record<string, RoleSpec>>): Record<string, RoleSpec> {
	const out: Record<string, RoleSpec> = {};
	for (const [name, spec] of Object.entries(roles)) {
		out[name] = {
			...spec,
			...(spec.tools ? { tools: [...spec.tools] } : {}),
		};
	}
	return out;
}

function cloneDefaultConfig(): DelegationConfig {
	return {
		...DEFAULT_DELEGATION_CONFIG,
		discoveryTools: [...DEFAULT_DELEGATION_CONFIG.discoveryTools],
		discoveryBudgets: { ...DEFAULT_DELEGATION_CONFIG.discoveryBudgets },
		exemptExtensions: [...DEFAULT_DELEGATION_CONFIG.exemptExtensions],
		testExtensions: [...DEFAULT_DELEGATION_CONFIG.testExtensions],
		reviewExtensions: [...DEFAULT_DELEGATION_CONFIG.reviewExtensions],
		verifyCommandPatterns: [...DEFAULT_DELEGATION_CONFIG.verifyCommandPatterns],
		verifyExcludePatterns: [...DEFAULT_DELEGATION_CONFIG.verifyExcludePatterns],
		modelMentionPatterns: [...DEFAULT_DELEGATION_CONFIG.modelMentionPatterns],
		roles: cloneRoles(DEFAULT_DELEGATION_CONFIG.roles),
	};
}

function isDelegationMode(value: unknown): value is DelegationMode {
	return typeof value === "string" && (DELEGATION_MODES as readonly string[]).includes(value);
}

function mergeStringArray(
	raw: unknown,
	fieldName: string,
	warnings: string[],
	validateRegex = false,
): string[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		warnings.push(`${fieldName} must be an array of strings`);
		return undefined;
	}
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string" || !item.trim()) {
			warnings.push(`${fieldName} contains a non-string or empty entry; skipping it`);
			continue;
		}
		if (validateRegex) {
			try {
				new RegExp(item, "i");
			} catch (err) {
				warnings.push(`${fieldName} invalid regex "${item}": ${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
		}
		out.push(item);
	}
	return out;
}

function mergeNonNegativeInt(
	raw: unknown,
	fieldName: string,
	warnings: string[],
): number | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
		warnings.push(`${fieldName} must be a non-negative integer`);
		return undefined;
	}
	return raw;
}

function mergePositiveInt(
	raw: unknown,
	fieldName: string,
	warnings: string[],
): number | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
		warnings.push(`${fieldName} must be a positive integer`);
		return undefined;
	}
	return raw;
}

function mergeRoleOverride(
	base: Record<string, RoleSpec>,
	rawRoles: unknown,
	sourceLabel: string,
	warnings: string[],
): void {
	if (rawRoles === undefined) return;
	if (!isRecord(rawRoles)) {
		warnings.push(`${sourceLabel}: delegation.roles must be an object`);
		return;
	}
	for (const [roleName, rawSpec] of Object.entries(rawRoles)) {
		const trimmedName = roleName.trim();
		if (!trimmedName || !isRecord(rawSpec)) {
			warnings.push(`${sourceLabel}: role "${roleName}" must be an object`);
			continue;
		}
		const prev = base[trimmedName];
		const next: RoleSpec = prev
			? { ...prev, ...(prev.tools ? { tools: [...prev.tools] } : {}) }
			: { description: `Custom role ${trimmedName}`, configuredByUser: true };

		const hasExplicitProvider = typeof rawSpec.provider === "string" && rawSpec.provider.trim().length > 0;
		const hasExplicitModel = typeof rawSpec.model === "string" && rawSpec.model.trim().length > 0;

		if (hasExplicitProvider) next.provider = (rawSpec.provider as string).trim();
		if (hasExplicitModel) next.model = (rawSpec.model as string).trim();
		if (typeof rawSpec.thinking === "string" && rawSpec.thinking.trim()) {
			next.thinking = rawSpec.thinking.trim();
		}
		if (typeof rawSpec.description === "string" && rawSpec.description.trim()) {
			next.description = rawSpec.description.trim();
		}
		if (rawSpec.tools !== undefined) {
			const tools = mergeStringArray(rawSpec.tools, `${sourceLabel}: roles.${trimmedName}.tools`, warnings);
			if (tools) next.tools = tools;
		}

		if (typeof rawSpec.inheritModel === "boolean") {
			next.inheritModel = rawSpec.inheritModel;
			next.configuredByUser = true;
			if (rawSpec.inheritModel && !hasExplicitProvider && !hasExplicitModel) {
				delete next.provider;
				delete next.model;
			}
		} else if (hasExplicitProvider || hasExplicitModel) {
			next.inheritModel = false;
			next.configuredByUser = true;
		} else if (!prev) {
			next.configuredByUser = true;
		}

		base[trimmedName] = next;
	}
}

function mergeDelegationLayer(
	target: DelegationConfig,
	rawLayer: unknown,
	sourceLabel: string,
	warnings: string[],
): void {
	if (!isRecord(rawLayer)) {
		warnings.push(`${sourceLabel}: delegation config must be a JSON object`);
		return;
	}

	if (rawLayer.mode !== undefined) {
		if (isDelegationMode(rawLayer.mode)) target.mode = rawLayer.mode;
		else warnings.push(`${sourceLabel}: invalid mode "${String(rawLayer.mode)}"`);
	}

	if (rawLayer.directPrefix !== undefined) {
		if (typeof rawLayer.directPrefix === "string" && rawLayer.directPrefix.trim()) {
			target.directPrefix = rawLayer.directPrefix.trim();
		} else {
			warnings.push(`${sourceLabel}: directPrefix must be a non-empty string`);
		}
	}

	const discoveryTools = mergeStringArray(rawLayer.discoveryTools, `${sourceLabel}: discoveryTools`, warnings);
	if (discoveryTools) target.discoveryTools = discoveryTools;

	if (rawLayer.discoveryBudgets !== undefined) {
		if (!isRecord(rawLayer.discoveryBudgets)) {
			warnings.push(`${sourceLabel}: discoveryBudgets must be an object`);
		} else {
			for (const mode of Object.keys(target.discoveryBudgets) as TurnMode[]) {
				const v = mergeNonNegativeInt(
					rawLayer.discoveryBudgets[mode],
					`${sourceLabel}: discoveryBudgets.${mode}`,
					warnings,
				);
				if (v !== undefined) target.discoveryBudgets[mode] = v;
			}
		}
	}

	const maxEditLines = mergePositiveInt(rawLayer.maxEditLines, `${sourceLabel}: maxEditLines`, warnings);
	if (maxEditLines !== undefined) target.maxEditLines = maxEditLines;

	const maxEditedFiles = mergePositiveInt(
		rawLayer.maxEditedFilesPerTurn,
		`${sourceLabel}: maxEditedFilesPerTurn`,
		warnings,
	);
	if (maxEditedFiles !== undefined) target.maxEditedFilesPerTurn = maxEditedFiles;

	const steerThreshold = mergePositiveInt(
		rawLayer.steerUnlockThreshold,
		`${sourceLabel}: steerUnlockThreshold`,
		warnings,
	);
	if (steerThreshold !== undefined) target.steerUnlockThreshold = steerThreshold;

	const settleCap = mergeNonNegativeInt(rawLayer.settleAttemptCap, `${sourceLabel}: settleAttemptCap`, warnings);
	if (settleCap !== undefined) target.settleAttemptCap = settleCap;

	const revFiles = mergePositiveInt(rawLayer.reviewThresholdFiles, `${sourceLabel}: reviewThresholdFiles`, warnings);
	if (revFiles !== undefined) target.reviewThresholdFiles = revFiles;

	const revLines = mergePositiveInt(rawLayer.reviewThresholdLines, `${sourceLabel}: reviewThresholdLines`, warnings);
	if (revLines !== undefined) target.reviewThresholdLines = revLines;

	const exemptExts = mergeStringArray(rawLayer.exemptExtensions, `${sourceLabel}: exemptExtensions`, warnings);
	if (exemptExts) target.exemptExtensions = exemptExts.map((e) => e.toLowerCase());

	const testExts = mergeStringArray(rawLayer.testExtensions, `${sourceLabel}: testExtensions`, warnings);
	if (testExts) target.testExtensions = testExts.map((e) => e.toLowerCase());

	const revExts = mergeStringArray(rawLayer.reviewExtensions, `${sourceLabel}: reviewExtensions`, warnings);
	if (revExts) target.reviewExtensions = revExts.map((e) => e.toLowerCase());

	const verifyPatterns = mergeStringArray(
		rawLayer.verifyCommandPatterns,
		`${sourceLabel}: verifyCommandPatterns`,
		warnings,
		true,
	);
	if (verifyPatterns) target.verifyCommandPatterns = verifyPatterns;

	const verifyExcludes = mergeStringArray(
		rawLayer.verifyExcludePatterns,
		`${sourceLabel}: verifyExcludePatterns`,
		warnings,
		true,
	);
	if (verifyExcludes) target.verifyExcludePatterns = verifyExcludes;

	const mentionPatterns = mergeStringArray(
		rawLayer.modelMentionPatterns,
		`${sourceLabel}: modelMentionPatterns`,
		warnings,
		true,
	);
	if (mentionPatterns) target.modelMentionPatterns = mentionPatterns;

	mergeRoleOverride(target.roles, rawLayer.roles, sourceLabel, warnings);
}

function readJsonSafe(filePath: string, warnings: string[]): unknown | undefined {
	try {
		const raw = readFileSync(filePath, "utf8");
		return JSON.parse(raw) as unknown;
	} catch (err) {
		warnings.push(`Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}

export function readDelegationConfig(
	cwd: string,
	options: { trusted?: boolean; env?: NodeJS.ProcessEnv; agentDir?: string } = {},
): DelegationConfigRead {
	const env = options.env ?? process.env;
	const warnings: string[] = [];
	const config = cloneDefaultConfig();

	const agentDir = options.agentDir ?? (env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent"));
	const explicitGlobalPath = env[DELEGATION_CONFIG_ENV]?.trim();
	const globalPath = explicitGlobalPath || path.join(agentDir, DELEGATION_CONFIG_BASENAME);

	if (existsSync(globalPath)) {
		const parsed = readJsonSafe(globalPath, warnings);
		if (parsed !== undefined) mergeDelegationLayer(config, parsed, globalPath, warnings);
	} else if (explicitGlobalPath) {
		warnings.push(`${DELEGATION_CONFIG_ENV} points to missing file: ${explicitGlobalPath}`);
	}

	if (options.trusted === true) {
		const projectPath = path.join(cwd, ".pi", GATE_CONFIG_BASENAME);
		if (existsSync(projectPath)) {
			const parsed = readJsonSafe(projectPath, warnings);
			if (parsed !== undefined) {
				if (!isRecord(parsed)) {
					warnings.push(`${projectPath}: expected top-level JSON object`);
				} else if (parsed[DELEGATION_SECTION] !== undefined) {
					mergeDelegationLayer(config, parsed[DELEGATION_SECTION], `${projectPath}#${DELEGATION_SECTION}`, warnings);
				}
			}
		}
	}

	const envMode = env[DELEGATION_ENV]?.trim().toLowerCase();
	if (envMode) {
		if (isDelegationMode(envMode)) {
			config.mode = envMode;
		} else {
			warnings.push(`${DELEGATION_ENV}="${envMode}" is invalid; expected enforce | warn | off`);
		}
	}

	return { config, warnings };
}

// --- Turn classifier -------------------------------------------------------

const SECURITY_REGEX =
	/\b(security|vulnerab\w*|cve|xss|sqli|sql\s+injection|csrf|ssrf|auth(?:entication|orization)?\s+bypass|exploit|pentest|red[- ]?team|secrets?\s+leak|audit\s+security|owasp)\b/i;
const REVIEW_REGEX =
	/(?:^|\s)(?:code[- ]?review|review\s+(?:this|the|my|our|pr|pull\s+request|diff|branch|changes?|commit|patch)|audit\s+(?:diff|changes|pr)|inspect\s+pr)\b|^review\b/i;
const DEBUG_REGEX =
	/\b(debug|diagnose|troubleshoot|why\s+(?:is|does|did|are|were)|failing\s+test|test\s+fail\w*|stack\s*trace|exception|traceback|crash(?:ing|ed)?|flaky|regression|root\s+cause|investigate\s+(?:the\s+)?(?:bug|error|failure|issue))\b/i;
const QUICK_FIX_REGEX =
	/\b(quick[- ]?fix|typo|rename|formatting|lint\s+fix|one[- ]?liner|small\s+(?:fix|change|edit|tweak)|trivial|minor\s+(?:fix|change|edit))\b/i;
const QA_LEAD_REGEX =
	/^(?:what|where|when|who|why|how|which|does|do|is|are|can|could|explain|describe|list|show|find|summarize|tell\s+me)\b/i;
const EDIT_INTENT_REGEX =
	/\b(implement|build|create|add|write|refactor|fix|update|change|modify|delete|remove|migrate|wire|integrate)\b/i;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function classifyTurn(prompt: string, config: DelegationConfig): TurnClassification {
	const trimmed = String(prompt ?? "").trimStart();
	const prefix = config.directPrefix || "!direct";
	const directRegex = new RegExp(`^${escapeRegExp(prefix)}(?=\\s|$)`, "i");
	const directMatch = directRegex.exec(trimmed);
	const directBypass = Boolean(directMatch);
	const body = directMatch ? trimmed.slice(directMatch[0].length).trim() : trimmed.trim();

	let turnMode: TurnMode = "implement";
	if (SECURITY_REGEX.test(body)) {
		turnMode = "security";
	} else if (REVIEW_REGEX.test(body)) {
		turnMode = "review";
	} else if (DEBUG_REGEX.test(body)) {
		turnMode = "debug";
	} else if (QUICK_FIX_REGEX.test(body)) {
		turnMode = "quick-fix";
	} else if (QA_LEAD_REGEX.test(body) && !EDIT_INTENT_REGEX.test(body)) {
		turnMode = "qa";
	} else if (body.endsWith("?") && !EDIT_INTENT_REGEX.test(body)) {
		turnMode = "qa";
	}

	let promptHasModelMention = false;
	for (const pattern of config.modelMentionPatterns) {
		try {
			if (new RegExp(pattern, "i").test(body)) {
				promptHasModelMention = true;
				break;
			}
		} catch {
			// Ignore malformed regex already reported at config load
		}
	}

	const discoveryBudget = config.discoveryBudgets[turnMode] ?? DEFAULT_DELEGATION_CONFIG.discoveryBudgets[turnMode];
	return {
		turnMode,
		discoveryBudget,
		directBypass,
		promptHasModelMention,
	};
}

// --- State lifecycle -------------------------------------------------------

export function createDelegationState(): DelegationState {
	return {
		turnMode: "implement",
		discoveryBudget: DEFAULT_DELEGATION_CONFIG.discoveryBudgets.implement,
		discoveryCount: 0,
		directBypass: false,
		promptHasModelMention: false,
		editedFilesThisTurn: new Set<string>(),
		steerCounts: new Map<string, number>(),
		countedSteerToolCallIds: new Set<string>(),
		escalationUnlocked: false,
		settleBlocksThisTurn: 0,
		viewedFiles: new Set<string>(),
		testsRequired: false,
		testsVerified: false,
		reviewRequired: false,
		reviewVerified: false,
		dirtyReviewFiles: new Set<string>(),
		dirtyReviewLines: 0,
		lastCodeEditAt: 0,
		lastReviewEditAt: 0,
		lastReviewInspectionAt: 0,
		lastMainReview: null,
		runLineage: new Map<string, string>(),
	};
}

export function resetTurnCounters(state: DelegationState): void {
	state.discoveryCount = 0;
	state.editedFilesThisTurn.clear();
	state.steerCounts.clear();
	state.countedSteerToolCallIds.clear();
	state.escalationUnlocked = false;
}

export function resetTurnState(state: DelegationState, classification: TurnClassification): void {
	state.turnMode = classification.turnMode;
	state.discoveryBudget = classification.discoveryBudget;
	state.directBypass = classification.directBypass;
	state.promptHasModelMention = classification.promptHasModelMention;
	resetTurnCounters(state);
	state.settleBlocksThisTurn = 0;
}

// --- Edit sizing & discovery/write guardrails ------------------------------

export function normalizeFilePath(filePath: string, cwd?: string): string {
	const trimmed = String(filePath ?? "").trim();
	if (!trimmed) return "";
	const base = typeof cwd === "string" ? cwd.trim() : "";
	return base ? path.resolve(base, trimmed) : path.normalize(trimmed);
}

export function countChangedLines(oldText: string, newText: string): number {
	const oldLines = oldText === "" ? [] : oldText.split(/\r?\n/);
	const newLines = newText === "" ? [] : newText.split(/\r?\n/);

	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
		start += 1;
	}

	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
		oldEnd -= 1;
		newEnd -= 1;
	}

	return Math.max(oldEnd - start, newEnd - start);
}

export function extractEditInfo(
	toolName: string,
	input: unknown,
	cwd?: string,
): { path: string; changedLines: number; isWrite: boolean } {
	const rec = isRecord(input) ? input : {};
	const rawPath = typeof rec.path === "string" ? rec.path : typeof rec.file_path === "string" ? rec.file_path : "";
	const filePath = normalizeFilePath(rawPath, cwd);

	if (toolName === "write") {
		const content = typeof rec.content === "string" ? rec.content : "";
		return { path: filePath, changedLines: countChangedLines("", content), isWrite: true };
	}

	if (Array.isArray(rec.edits)) {
		let total = 0;
		for (const item of rec.edits) {
			if (!isRecord(item)) continue;
			const oldT =
				typeof item.oldText === "string"
					? item.oldText
					: typeof item.old_str === "string"
						? item.old_str
						: "";
			const newT =
				typeof item.newText === "string"
					? item.newText
					: typeof item.new_str === "string"
						? item.new_str
						: "";
			total += countChangedLines(oldT, newT);
		}
		return { path: filePath, changedLines: total, isWrite: false };
	}

	const oldText =
		typeof rec.oldText === "string" ? rec.oldText : typeof rec.old_str === "string" ? rec.old_str : "";
	const newText =
		typeof rec.newText === "string" ? rec.newText : typeof rec.new_str === "string" ? rec.new_str : "";
	return { path: filePath, changedLines: countChangedLines(oldText, newText), isWrite: false };
}

export function evaluateDiscovery(
	state: DelegationState,
	config: DelegationConfig,
	toolName: string,
): { allowed: boolean; count: number; budget: number; reason?: string } {
	if (!config.discoveryTools.includes(toolName)) {
		return { allowed: true, count: state.discoveryCount, budget: state.discoveryBudget };
	}
	if (state.discoveryCount >= state.discoveryBudget) {
		return {
			allowed: false,
			count: state.discoveryCount,
			budget: state.discoveryBudget,
			reason: `Discovery budget exceeded (${state.discoveryCount}/${state.discoveryBudget} calls in "${state.turnMode}" mode). Delegate codebase exploration to subagent({ role: "explore", task: "..." }).`,
		};
	}
	state.discoveryCount += 1;
	return { allowed: true, count: state.discoveryCount, budget: state.discoveryBudget };
}

export function evaluateParentWrite(
	state: DelegationState,
	config: DelegationConfig,
	toolName: string,
	input: unknown,
	cwd?: string,
): { allowed: boolean; path: string; changedLines: number; reason?: string } {
	const info = extractEditInfo(toolName, input, cwd);

	if (state.escalationUnlocked) {
		if (info.path) state.editedFilesThisTurn.add(info.path);
		return { allowed: true, path: info.path, changedLines: info.changedLines };
	}

	if (toolName === "write") {
		return {
			allowed: false,
			path: info.path,
			changedLines: info.changedLines,
			reason: 'Parent cannot invoke `write` directly. Delegate file creation/rewrites to subagent({ role: "coder", task: "..." }).',
		};
	}

	if (!info.path) {
		return {
			allowed: false,
			path: "",
			changedLines: info.changedLines,
			reason: "Parent edit requires a target file path.",
		};
	}

	if (!state.viewedFiles.has(info.path)) {
		return {
			allowed: false,
			path: info.path,
			changedLines: info.changedLines,
			reason: `Parent cannot edit unread file "${info.path}". Read it first or delegate to subagent({ role: "coder", task: "..." }).`,
		};
	}

	if (info.changedLines > config.maxEditLines) {
		return {
			allowed: false,
			path: info.path,
			changedLines: info.changedLines,
			reason: `Parent edit to "${info.path}" changes ${info.changedLines} lines (cap: ${config.maxEditLines}). Delegate larger edits to subagent({ role: "coder", task: "..." }).`,
		};
	}

	if (!state.editedFilesThisTurn.has(info.path) && state.editedFilesThisTurn.size >= config.maxEditedFilesPerTurn) {
		return {
			allowed: false,
			path: info.path,
			changedLines: info.changedLines,
			reason: `Parent can edit at most ${config.maxEditedFilesPerTurn} file(s) per turn (already touched: ${[...state.editedFilesThisTurn].join(", ")}). Delegate multi-file edits to subagent({ role: "coder", task: "..." }).`,
		};
	}

	// Reserve path immediately on allow so parallel tool calls in the same turn are caught.
	state.editedFilesThisTurn.add(info.path);
	return { allowed: true, path: info.path, changedLines: info.changedLines };
}

// --- Shell tokenization & allowlists ---------------------------------------

interface ShellPipelineParse {
	ok: boolean;
	stages: string[][];
}

function parseReadOnlyPipeline(command: string): ShellPipelineParse {
	if (!command || /[\r\n]/.test(command)) return { ok: false, stages: [] };

	const stages: string[][] = [];
	let currentTokens: string[] = [];
	let current = "";
	let hasToken = false;
	let inSingle = false;
	let inDouble = false;

	const flushToken = () => {
		if (hasToken) {
			currentTokens.push(current);
			current = "";
			hasToken = false;
		}
	};

	const flushStage = (): boolean => {
		flushToken();
		if (currentTokens.length === 0) return false;
		stages.push(currentTokens);
		currentTokens = [];
		return true;
	};

	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i]!;
		const next = command[i + 1];

		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
			} else {
				current += ch;
			}
			continue;
		}

		if (inDouble) {
			if (ch === "`") return { ok: false, stages: [] };
			if (ch === "$" && next === "(") return { ok: false, stages: [] };
			if (ch === "\\") {
				if (next === undefined) return { ok: false, stages: [] };
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					current += next;
				} else {
					current += ch + next;
				}
				i += 1;
				continue;
			}
			if (ch === '"') {
				inDouble = false;
			} else {
				current += ch;
			}
			continue;
		}

		// Unquoted
		if (ch === "`" || ch === ";" || ch === "&" || ch === ">" || ch === "<" || ch === "(" || ch === ")") {
			return { ok: false, stages: [] };
		}
		if (ch === "$" && next === "(") {
			return { ok: false, stages: [] };
		}
		if (ch === "|") {
			if (next === "|") return { ok: false, stages: [] };
			if (!flushStage()) return { ok: false, stages: [] };
			continue;
		}
		if (ch === "\\") {
			if (next === undefined) return { ok: false, stages: [] };
			current += next;
			hasToken = true;
			i += 1;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			hasToken = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			hasToken = true;
			continue;
		}
		if (/\s/.test(ch)) {
			flushToken();
			continue;
		}
		current += ch;
		hasToken = true;
	}

	if (inSingle || inDouble) return { ok: false, stages: [] };
	if (!flushStage()) return { ok: false, stages: [] };
	return { ok: true, stages };
}

const BRANCH_SHORT_CHARS = new Set(["a", "r", "v", "l", "i"]);
const BRANCH_BOOL_LONG_FLAGS = new Set([
	"--all",
	"--remotes",
	"--verbose",
	"--list",
	"--show-current",
	"--no-abbrev",
	"--no-color",
	"--no-column",
	"--no-merged",
	"--merged",
	"--contains",
	"--no-contains",
	"--ignore-case",
	"--omit-empty",
]);
const BRANCH_OPTIONAL_VALUE_LONG_FLAGS = new Set([
	"--contains",
	"--no-contains",
	"--merged",
	"--no-merged",
]);
const BRANCH_EQ_ONLY_OPTIONAL_LONG_FLAGS = new Set([
	"--abbrev",
	"--color",
	"--column",
]);
const BRANCH_REQUIRED_VALUE_LONG_FLAGS = new Set(["--points-at", "--sort", "--format"]);
const GIT_INSPECTION_OUTPUT_PREFIXES = new Set(["diff", "log", "show"]);
const ALLOWED_GIT_READ_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"rev-parse",
	"merge-base",
	"describe",
]);
const FETCH_BOOL_LONG_FLAGS = new Set([
	"--all",
	"--dry-run",
	"--quiet",
	"--verbose",
	"--tags",
	"--no-tags",
	"--multiple",
	"--no-recurse-submodules",
	"--no-auto-maintenance",
	"--no-auto-gc",
	"--no-write-fetch-head",
	"--ipv4",
	"--ipv6",
	"--progress",
	"--no-progress",
]);
const FETCH_VALUE_LONG_FLAGS = new Set([
	"--depth",
	"--shallow-since",
	"--shallow-exclude",
	"--deepen",
]);
const FETCH_SHORT_CHARS = new Set(["q", "v", "t", "n", "a", "m", "4", "6"]);
const ALLOWED_GH_READ_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
	auth: new Set(["status"]),
	pr: new Set(["view", "list", "checks", "diff", "status"]),
	run: new Set(["list", "view"]),
	issue: new Set(["list", "view"]),
	release: new Set(["list", "view"]),
};
const ALLOWED_PIPE_SINKS = new Set(["head", "tail", "wc", "cat"]);

function isSafeGitBranchArgs(args: string[]): boolean {
	let hasListFlag = false;
	let endOfOptions = false;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (endOfOptions) {
			if (!hasListFlag) return false;
			continue;
		}
		if (arg === "--") {
			endOfOptions = true;
			continue;
		}
		if (arg === "--list" || arg === "-l") {
			hasListFlag = true;
			continue;
		}
		if (arg.startsWith("--")) {
			const eqIdx = arg.indexOf("=");
			const flagName = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
			const hasEq = eqIdx !== -1;

			if (BRANCH_REQUIRED_VALUE_LONG_FLAGS.has(flagName)) {
				if (!hasEq) {
					if (i + 1 >= args.length) return false;
					i += 1;
				}
				continue;
			}
			if (BRANCH_OPTIONAL_VALUE_LONG_FLAGS.has(flagName)) {
				if (!hasEq && i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
					i += 1;
				}
				continue;
			}
			if (BRANCH_EQ_ONLY_OPTIONAL_LONG_FLAGS.has(flagName)) {
				// Accepts bare `--flag` or `--flag=value`; never consumes a following positional token.
				continue;
			}
			if (BRANCH_BOOL_LONG_FLAGS.has(flagName)) {
				if (hasEq) return false;
				continue;
			}
			return false;
		}
		if (arg.startsWith("-")) {
			if (arg.length === 1) return false;
			for (const ch of arg.slice(1)) {
				if (!BRANCH_SHORT_CHARS.has(ch)) return false;
				if (ch === "l") hasListFlag = true;
			}
			continue;
		}
		// Positional argument: allowed only as pattern after --list / -l
		if (!hasListFlag) return false;
	}
	return true;
}

function isSafeGitInspectionArgs(sub: string, args: string[]): boolean {
	if (!GIT_INSPECTION_OUTPUT_PREFIXES.has(sub)) return true;
	for (const arg of args) {
		if (arg === "--") break;
		if (arg === "--output" || arg.startsWith("--output=") || arg === "--ext-diff" || arg.startsWith("--ext-diff=")) {
			return false;
		}
	}
	return true;
}

function isSafeGitFetchArgs(args: string[]): boolean {
	let endOfOptions = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (!endOfOptions && arg === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && arg.startsWith("--")) {
			const eqIdx = arg.indexOf("=");
			const flagName = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
			const hasEq = eqIdx !== -1;

			if (FETCH_BOOL_LONG_FLAGS.has(flagName)) {
				if (hasEq) return false;
				continue;
			}
			if (FETCH_VALUE_LONG_FLAGS.has(flagName)) {
				if (hasEq) {
					const val = arg.slice(eqIdx + 1);
					if (!val || val.includes(":")) return false;
				} else {
					if (i + 1 >= args.length) return false;
					const val = args[i + 1]!;
					if (!val || val.startsWith("-") || val.includes(":")) return false;
					i += 1;
				}
				continue;
			}
			return false;
		}
		if (!endOfOptions && arg.startsWith("-")) {
			if (arg.length === 1) return false;
			for (const ch of arg.slice(1)) {
				if (!FETCH_SHORT_CHARS.has(ch)) return false;
			}
			continue;
		}
		if (arg.includes(":") || arg.startsWith("+")) return false;
	}
	return true;
}

function isSafeGhReadArgs(group: string, sub: string, args: string[]): boolean {
	if (group === "auth" && sub === "status") {
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i]!;
			if (arg === "--") break;
			if (arg.startsWith("--")) {
				const eqIdx = arg.indexOf("=");
				const flagName = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
				if (flagName === "--show-token" || (flagName.length >= 3 && "--show-token".startsWith(flagName))) {
					return false;
				}
				if ((flagName === "--hostname" || flagName === "--json" || flagName === "--jq") && eqIdx === -1) {
					i += 1;
				}
				continue;
			}
			if (arg.startsWith("-") && arg.length > 1) {
				for (let j = 1; j < arg.length; j += 1) {
					const ch = arg[j]!;
					if (ch === "t") return false;
					if (ch === "h" || ch === "q") {
						if (j + 1 >= arg.length) {
							i += 1;
						}
						break;
					}
				}
			}
		}
	}
	return true;
}

function skipGitPrefix(tokens: string[]): number {
	let idx = 1;
	while (idx < tokens.length) {
		const tok = tokens[idx]!;
		if (tok === "-c" || (tok.startsWith("-c") && tok.length > 2)) {
			return -1;
		}
		if (tok === "--no-pager") {
			idx += 1;
			continue;
		}
		if (tok === "-C") {
			if (idx + 1 >= tokens.length) return -1;
			idx += 2;
			continue;
		}
		if (tok.startsWith("-C") && tok.length > 2) {
			idx += 1;
			continue;
		}
		break;
	}
	return idx;
}

export function isReadOnlyBashAllowed(command: string): boolean {
	const parsed = parseReadOnlyPipeline(String(command ?? "").trim());
	if (!parsed.ok || parsed.stages.length === 0) return false;

	const first = parsed.stages[0]!;
	const cmd = first[0]!;

	if (cmd === "ls" || cmd === "wc") {
		// Allowed read-only inspection commands
	} else if (cmd === "git") {
		const subIdx = skipGitPrefix(first);
		if (subIdx < 0 || subIdx >= first.length) return false;
		const sub = first[subIdx]!;
		const subArgs = first.slice(subIdx + 1);
		if (sub === "branch") {
			if (!isSafeGitBranchArgs(subArgs)) return false;
		} else if (sub === "fetch") {
			if (!isSafeGitFetchArgs(subArgs)) return false;
		} else if (!ALLOWED_GIT_READ_SUBCOMMANDS.has(sub)) {
			return false;
		} else if (!isSafeGitInspectionArgs(sub, subArgs)) {
			return false;
		}
	} else if (cmd === "gh") {
		if (first.length < 3) return false;
		const group = first[1]!;
		const sub = first[2]!;
		const allowedSubs = ALLOWED_GH_READ_SUBCOMMANDS[group];
		if (!allowedSubs || !allowedSubs.has(sub)) return false;
		if (!isSafeGhReadArgs(group, sub, first.slice(3))) return false;
	} else {
		return false;
	}

	for (let i = 1; i < parsed.stages.length; i += 1) {
		const sink = parsed.stages[i]![0];
		if (!sink || !ALLOWED_PIPE_SINKS.has(sink)) return false;
	}

	return true;
}

const FIND_MUTATING_FLAGS = new Set([
	"-delete",
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-fprint",
	"-fprintf",
	"-fls",
]);

interface ShellCommandAnalysis {
	firstStageTokens: string[];
	stages: string[][];
	disallowedConstructs: string[];
	hasEmptyPipeStage: boolean;
	unclosedQuote: boolean;
}

function addUnique(list: string[], item: string): void {
	if (!list.includes(item)) list.push(item);
}

function analyzeShellCommand(command: string): ShellCommandAnalysis {
	const stages: string[][] = [];
	let firstStageTokens: string[] | null = null;
	let currentTokens: string[] = [];
	let current = "";
	let hasToken = false;
	let inSingle = false;
	let inDouble = false;
	const disallowedConstructs: string[] = [];
	let hasEmptyPipeStage = false;
	let sawChainOrBoundary = false;

	const flushToken = () => {
		if (hasToken) {
			currentTokens.push(current);
			current = "";
			hasToken = false;
		}
	};

	const captureFirstStageIfNeeded = () => {
		if (firstStageTokens === null) {
			flushToken();
			firstStageTokens = [...currentTokens];
		}
	};

	const flushPipeStage = () => {
		flushToken();
		if (firstStageTokens === null) {
			firstStageTokens = [...currentTokens];
		}
		if (!sawChainOrBoundary) {
			if (currentTokens.length === 0) {
				hasEmptyPipeStage = true;
			} else {
				stages.push(currentTokens);
			}
			currentTokens = [];
		}
	};

	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i]!;
		const next = command[i + 1];

		if (ch === "\r" || ch === "\n") {
			captureFirstStageIfNeeded();
			sawChainOrBoundary = true;
			addUnique(disallowedConstructs, "newline");
			if (ch === "\r" && next === "\n") i += 1;
			continue;
		}

		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
			} else {
				current += ch;
			}
			continue;
		}

		if (inDouble) {
			if (ch === "`") {
				captureFirstStageIfNeeded();
				addUnique(disallowedConstructs, "backtick (`...`)");
				continue;
			}
			if (ch === "$" && next === "(") {
				captureFirstStageIfNeeded();
				addUnique(disallowedConstructs, "command substitution ($(...))");
				i += 1;
				continue;
			}
			if (ch === "\\") {
				if (next === undefined) break;
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					current += next;
				} else {
					current += ch + next;
				}
				i += 1;
				continue;
			}
			if (ch === '"') {
				inDouble = false;
			} else {
				current += ch;
			}
			continue;
		}

		// Unquoted
		if (ch === "`") {
			captureFirstStageIfNeeded();
			sawChainOrBoundary = true;
			addUnique(disallowedConstructs, "backtick (`...`)");
			continue;
		}
		if (ch === "$" && next === "(") {
			captureFirstStageIfNeeded();
			sawChainOrBoundary = true;
			addUnique(disallowedConstructs, "command substitution ($(...))");
			i += 1;
			continue;
		}
		if (ch === "&") {
			captureFirstStageIfNeeded();
			sawChainOrBoundary = true;
			if (next === "&") {
				addUnique(disallowedConstructs, "&&");
				i += 1;
			} else {
				addUnique(disallowedConstructs, "&");
			}
			continue;
		}
		if (ch === ";") {
			captureFirstStageIfNeeded();
			sawChainOrBoundary = true;
			addUnique(disallowedConstructs, ";");
			continue;
		}
		if (ch === ">") {
			if (!sawChainOrBoundary && hasToken && /^[0-9]+$/.test(current)) {
				const fd = current;
				current = "";
				hasToken = false;
				captureFirstStageIfNeeded();
				addUnique(disallowedConstructs, `redirect (${fd}>)`);
			} else {
				captureFirstStageIfNeeded();
				addUnique(disallowedConstructs, "redirect (>)");
			}
			sawChainOrBoundary = true;
			continue;
		}
		if (ch === "<") {
			captureFirstStageIfNeeded();
			sawChainOrBoundary = true;
			if (next === "(") {
				addUnique(disallowedConstructs, "process substitution (<(...))");
				i += 1;
			} else {
				addUnique(disallowedConstructs, "redirect (<)");
			}
			continue;
		}
		if (ch === "(" || ch === ")") {
			captureFirstStageIfNeeded();
			sawChainOrBoundary = true;
			addUnique(disallowedConstructs, "subshell (...)");
			continue;
		}
		if (ch === "|") {
			if (next === "|") {
				captureFirstStageIfNeeded();
				sawChainOrBoundary = true;
				addUnique(disallowedConstructs, "||");
				i += 1;
				continue;
			}
			flushPipeStage();
			continue;
		}
		if (ch === "\\") {
			if (next === undefined) break;
			if (next === "\r" || next === "\n") {
				captureFirstStageIfNeeded();
				sawChainOrBoundary = true;
				addUnique(disallowedConstructs, "newline");
				i += 1;
				continue;
			}
			if (!sawChainOrBoundary) {
				current += next;
				hasToken = true;
			}
			i += 1;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			if (!sawChainOrBoundary) hasToken = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			if (!sawChainOrBoundary) hasToken = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (!sawChainOrBoundary) flushToken();
			continue;
		}
		if (!sawChainOrBoundary) {
			current += ch;
			hasToken = true;
		}
	}

	if (!sawChainOrBoundary) {
		flushPipeStage();
	} else {
		captureFirstStageIfNeeded();
	}

	return {
		firstStageTokens: firstStageTokens ?? [],
		stages,
		disallowedConstructs,
		hasEmptyPipeStage,
		unclosedQuote: inSingle || inDouble,
	};
}

type LeadingCommandClass =
	| { kind: "allowed-direct" }
	| { kind: "git-ls-files" }
	| { kind: "read-only-search"; toolHint: string }
	| { kind: "other" };

function classifyReadOnlyCommandPrefix(tokens: string[]): LeadingCommandClass {
	if (tokens.length === 0) return { kind: "other" };
	const cmd = tokens[0]!;

	if (cmd === "ls" || cmd === "wc") {
		return { kind: "allowed-direct" };
	}

	if (cmd === "git") {
		const subIdx = skipGitPrefix(tokens);
		if (subIdx < 0 || subIdx >= tokens.length) return { kind: "other" };
		const sub = tokens[subIdx]!;
		const subArgs = tokens.slice(subIdx + 1);
		if (sub === "ls-files") return { kind: "git-ls-files" };
		if (sub === "branch") return isSafeGitBranchArgs(subArgs) ? { kind: "allowed-direct" } : { kind: "other" };
		if (sub === "fetch") return isSafeGitFetchArgs(subArgs) ? { kind: "allowed-direct" } : { kind: "other" };
		if (ALLOWED_GIT_READ_SUBCOMMANDS.has(sub)) {
			return isSafeGitInspectionArgs(sub, subArgs) ? { kind: "allowed-direct" } : { kind: "other" };
		}
		return { kind: "other" };
	}

	if (cmd === "gh") {
		if (tokens.length < 3) return { kind: "other" };
		const group = tokens[1]!;
		const sub = tokens[2]!;
		const allowedSubs = ALLOWED_GH_READ_SUBCOMMANDS[group];
		if (!allowedSubs || !allowedSubs.has(sub)) return { kind: "other" };
		return isSafeGhReadArgs(group, sub, tokens.slice(3)) ? { kind: "allowed-direct" } : { kind: "other" };
	}

	if (cmd === "grep" || cmd === "rg" || cmd === "ag" || cmd === "ack") {
		return { kind: "read-only-search", toolHint: "grep" };
	}
	if (cmd === "find") {
		if (tokens.slice(1).some((arg) => FIND_MUTATING_FLAGS.has(arg))) return { kind: "other" };
		return { kind: "read-only-search", toolHint: "find/ls" };
	}
	if (cmd === "fd" || cmd === "tree") {
		return { kind: "read-only-search", toolHint: "find/ls" };
	}
	if (cmd === "cat" || cmd === "head" || cmd === "tail" || cmd === "less" || cmd === "more" || cmd === "nl") {
		return { kind: "read-only-search", toolHint: "read" };
	}

	return { kind: "other" };
}

const DEFAULT_BASH_CODER_REASON = "Delegate shell/test/build execution to subagent({ role: 'coder', task: '...' })";

export function explainReadOnlyBashBlock(command: string): string {
	const trimmed = String(command ?? "").trim();
	if (!trimmed) return DEFAULT_BASH_CODER_REASON;

	const analysis = analyzeShellCommand(trimmed);
	const prefix = classifyReadOnlyCommandPrefix(analysis.firstStageTokens);

	if (prefix.kind === "allowed-direct" || prefix.kind === "git-ls-files") {
		if (analysis.disallowedConstructs.length > 0) {
			return `Direct bash only allows single simple read-only commands without shell chaining, subshells, redirects, or newlines (found: ${analysis.disallowedConstructs.join(", ")}). Split into separate simple calls or delegate read-only discovery to subagent({ role: 'explore', task: '...' }).`;
		}
		if (analysis.unclosedQuote) {
			return "Direct bash command has an unclosed quote. Fix quoting for a single simple command or delegate read-only discovery to subagent({ role: 'explore', task: '...' }).";
		}
		if (analysis.hasEmptyPipeStage) {
			return "Direct bash command has an empty pipe stage. Run a single simple command or delegate read-only discovery to subagent({ role: 'explore', task: '...' }).";
		}

		const badSinks = analysis.stages
			.slice(1)
			.map((stage) => stage[0] ?? "")
			.filter((sink) => !ALLOWED_PIPE_SINKS.has(sink));
		if (badSinks.length > 0) {
			const formattedSinks = badSinks.map((s) => `| ${s}`).join(", ");
			if (prefix.kind === "git-ls-files") {
				return `Unsupported pipe sink (${formattedSinks}) in direct bash (only | head, | tail, | wc, | cat are allowed; \`git ls-files\` is also outside the direct bash allowlist). Filter in JS/codemode, use \`find\`/\`grep\`/\`ls\`, or delegate read-only discovery to subagent({ role: 'explore', task: '...' }).`;
			}
			return `Unsupported pipe sink (${formattedSinks}) in direct bash (only | head, | tail, | wc, | cat are allowed). Run without the pipe and filter in JS/codemode, split calls, or delegate read-only discovery to subagent({ role: 'explore', task: '...' }).`;
		}

		if (prefix.kind === "git-ls-files") {
			return "Direct bash does not allow `git ls-files`. Use `find`/`ls` directly or delegate read-only discovery to subagent({ role: 'explore', task: '...' }).";
		}

		return DEFAULT_BASH_CODER_REASON;
	}

	if (prefix.kind === "read-only-search") {
		const hasOutputRedirect = analysis.disallowedConstructs.some(
			(c) => c === "redirect (>)" || (c.startsWith("redirect (") && c !== "redirect (2>)"),
		);
		if (hasOutputRedirect) {
			return DEFAULT_BASH_CODER_REASON;
		}
		return `Direct bash does not allow \`${analysis.firstStageTokens[0]}\` for read-only search/inspection. Use \`read\`/\`grep\`/\`find\`/\`ls\` directly (prefer \`${prefix.toolHint}\`) or delegate read-only discovery to subagent({ role: 'explore', task: '...' }).`;
	}

	return DEFAULT_BASH_CODER_REASON;
}

const REVIEW_INSPECTION_GIT_SUBCOMMANDS = new Set(["diff", "show", "status", "log"]);

export function isReviewInspectionBashCommand(command: string): boolean {
	if (!isReadOnlyBashAllowed(command)) return false;
	const parsed = parseReadOnlyPipeline(String(command ?? "").trim());
	if (!parsed.ok || parsed.stages.length === 0) return false;
	const first = parsed.stages[0]!;
	if (first[0] === "git") {
		const subIdx = skipGitPrefix(first);
		if (subIdx < 0 || subIdx >= first.length) return false;
		return REVIEW_INSPECTION_GIT_SUBCOMMANDS.has(first[subIdx]!);
	}
	if (first[0] === "gh" && first[1] === "pr" && first[2] === "diff") {
		return true;
	}
	return false;
}

export function classifyCommitOrPrCommand(command: string): "commit" | "push" | "pr-create" | "pr-merge" | null {
	const text = String(command ?? "").trim();
	if (!text) return null;

	// Tokenize respecting quotes; allow optional leading `git add ... && ` before commit/push/pr-create.
	const segments: string[][] = [];
	let tokens: string[] = [];
	let current = "";
	let hasToken = false;
	let inSingle = false;
	let inDouble = false;

	const flushToken = () => {
		if (hasToken) {
			tokens.push(current);
			current = "";
			hasToken = false;
		}
	};

	const flushSegment = (): boolean => {
		flushToken();
		if (tokens.length === 0) return false;
		segments.push(tokens);
		tokens = [];
		return true;
	};

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i]!;
		const next = text[i + 1];

		if (inSingle) {
			if (ch === "'") inSingle = false;
			else current += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "`" || (ch === "$" && next === "(")) return null;
			if (ch === "\\") {
				if (next === undefined) return null;
				current += next === '"' || next === "\\" || next === "$" || next === "`" ? next : ch + next;
				i += 1;
				continue;
			}
			if (ch === '"') inDouble = false;
			else current += ch;
			continue;
		}

		if (ch === "`" || ch === ";" || ch === "|" || ch === ">" || ch === "<" || ch === "\n" || ch === "\r") {
			return null;
		}
		if (ch === "$" && next === "(") return null;
		if (ch === "&") {
			if (next !== "&") return null;
			if (!flushSegment()) return null;
			i += 1;
			continue;
		}
		if (ch === "\\") {
			if (next === undefined) return null;
			current += next;
			hasToken = true;
			i += 1;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			hasToken = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			hasToken = true;
			continue;
		}
		if (/\s/.test(ch)) {
			flushToken();
			continue;
		}
		current += ch;
		hasToken = true;
	}

	if (inSingle || inDouble) return null;
	if (!flushSegment() || segments.length === 0) return null;

	// Any preceding segment before the final commit/push/pr command may only be `git add ...`
	for (let i = 0; i < segments.length - 1; i += 1) {
		const seg = segments[i]!;
		if (seg[0] !== "git") return null;
		const subIdx = skipGitPrefix(seg);
		if (subIdx < 0 || seg[subIdx] !== "add") return null;
	}

	const last = segments[segments.length - 1]!;
	if (last[0] === "git") {
		const subIdx = skipGitPrefix(last);
		if (subIdx < 0 || subIdx >= last.length) return null;
		if (last[subIdx] === "commit") return "commit";
		if (last[subIdx] === "push") return "push";
		return null;
	}
	if (last[0] === "gh" && last[1] === "pr") {
		if (last[2] === "create") return "pr-create";
		if (last[2] === "merge") return "pr-merge";
	}
	return null;
}

export function isCommitOrPrCommand(command: string): boolean {
	return classifyCommitOrPrCommand(command) !== null;
}

export function isVerifyCommand(
	command: string,
	config: DelegationConfig,
	projectVerifyCmd?: string | null,
): boolean {
	const trimmed = String(command ?? "").trim();
	if (!trimmed) return false;
	if (detectWeakCommand(trimmed) !== null) return false;

	for (const exclude of config.verifyExcludePatterns) {
		try {
			if (new RegExp(exclude, "i").test(trimmed)) return false;
		} catch {
			// Skip invalid regex
		}
	}

	const normalizedProj = typeof projectVerifyCmd === "string" ? projectVerifyCmd.trim().replace(/\s+/g, " ") : "";
	if (normalizedProj) {
		const normalizedCmd = trimmed.replace(/\s+/g, " ");
		if (normalizedCmd === normalizedProj || normalizedCmd.startsWith(`${normalizedProj} `)) {
			return true;
		}
	}

	for (const pattern of config.verifyCommandPatterns) {
		try {
			if (new RegExp(pattern, "i").test(trimmed)) return true;
		} catch {
			// Skip invalid regex
		}
	}

	return false;
}

// --- Role->model routing ---------------------------------------------------

export interface SubagentPatch {
	target: Record<string, unknown>;
	role: string;
	provider?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	fallbackWarning?: string;
}

export interface SubagentCallEvaluation {
	allowed: boolean;
	reason?: string;
	kind?: "missing-role" | "unknown-role" | "explicit-override" | "fork-handoff";
	patches: SubagentPatch[];
	fallbackWarnings: string[];
	warnings: string[];
}

function hasNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isForkHandoff(value: unknown): boolean {
	return (typeof value === "string" && value.trim().toLowerCase() === "fork") || value === true;
}

export function evaluateSubagentCall(
	state: DelegationState,
	config: DelegationConfig,
	input: unknown,
	options: { canUseModel?: (provider: string, model: string) => boolean; allowExplicitModelOverride?: boolean } = {},
): SubagentCallEvaluation {
	if (!isRecord(input)) {
		return { allowed: true, patches: [], fallbackWarnings: [], warnings: [] };
	}

	const isTaskList = Array.isArray(input.tasks);
	const entries: Record<string, unknown>[] = [];
	if (isTaskList) {
		for (const item of input.tasks) {
			if (isRecord(item)) entries.push(item);
		}
	}
	if (hasNonEmptyString(input.role) || !isTaskList) {
		entries.push(input);
	}

	const directPrefix = config.directPrefix || "!direct";
	const known = Object.keys(config.roles).sort().join(", ");
	const forkReason = `handoff: "fork" is blocked in enforce mode because transplanting the parent transcript into a cold-cache worker adds heavy prompt overhead. Use handoff: "standalone" (default) or "lineage", or prefix the prompt with ${directPrefix}.`;

	const patches: SubagentPatch[] = [];
	const fallbackWarnings: string[] = [];
	const warnings: string[] = [];
	let firstKind: SubagentCallEvaluation["kind"];

	if (isTaskList && !hasNonEmptyString(input.role) && isForkHandoff(input.handoff) && !state.directBypass) {
		if (config.mode === "enforce") {
			return {
				allowed: false,
				kind: "fork-handoff",
				reason: forkReason,
				patches: [],
				fallbackWarnings: [],
				warnings: [],
			};
		}
		if (config.mode === "warn") {
			firstKind ??= "fork-handoff";
			warnings.push(forkReason);
		}
	}

	for (const entry of entries) {
		if (isForkHandoff(entry.handoff) && !state.directBypass) {
			if (config.mode === "enforce") {
				return {
					allowed: false,
					kind: "fork-handoff",
					reason: forkReason,
					patches: [],
					fallbackWarnings: [],
					warnings: [],
				};
			}
			if (config.mode === "warn") {
				firstKind ??= "fork-handoff";
				warnings.push(forkReason);
			}
		}

		if (!hasNonEmptyString(entry.role)) {
			if (!state.directBypass) {
				const missingReason = `Subagent call requires an explicit "role" in enforce mode (or prefix the prompt with ${directPrefix}). Valid roles: ${known}.`;
				if (config.mode === "enforce") {
					return {
						allowed: false,
						kind: "missing-role",
						reason: missingReason,
						patches: [],
						fallbackWarnings: [],
						warnings: [],
					};
				}
				if (config.mode === "warn") {
					firstKind ??= "missing-role";
					warnings.push(missingReason);
				}
			}
			continue;
		}

		const roleName = entry.role.trim();
		const spec = config.roles[roleName];
		if (!spec) {
			const unknownReason = `Unknown subagent role "${roleName}". Known roles: ${known}.`;
			if (config.mode === "enforce") {
				return {
					allowed: false,
					kind: "unknown-role",
					reason: unknownReason,
					patches: [],
					fallbackWarnings: [],
					warnings: [],
				};
			}
			firstKind ??= "unknown-role";
			warnings.push(unknownReason);
			continue;
		}

		const hasExplicitProvider = hasNonEmptyString(entry.provider);
		const hasExplicitModel = hasNonEmptyString(entry.model);
		if (
			(hasExplicitProvider || hasExplicitModel) &&
			config.mode === "enforce" &&
			!state.directBypass &&
			!state.promptHasModelMention &&
			!options.allowExplicitModelOverride
		) {
			return {
				allowed: false,
				kind: "explicit-override",
				reason: `Omit provider/model when using role '${roleName}' so configured role routing applies (or specify the model in the user prompt).`,
				patches: [],
				fallbackWarnings: [],
				warnings: [],
			};
		}

		const patch: SubagentPatch = { target: entry, role: roleName };

		if (!hasExplicitProvider && !hasExplicitModel && !spec.inheritModel && spec.provider && spec.model) {
			if (!spec.configuredByUser && options.canUseModel && !options.canUseModel(spec.provider, spec.model)) {
				const warning = `Role "${roleName}" default model ${spec.provider}/${spec.model} has no configured credentials; falling back to inherited parent model.`;
				patch.fallbackWarning = warning;
				fallbackWarnings.push(warning);
			} else {
				patch.provider = spec.provider;
				patch.model = spec.model;
			}
		}

		if (spec.thinking && !hasNonEmptyString(entry.thinking)) {
			patch.thinking = spec.thinking;
		}
		if (spec.tools && spec.tools.length > 0 && entry.tools === undefined) {
			patch.tools = [...spec.tools];
		}

		patches.push(patch);
	}

	return {
		allowed: true,
		...(firstKind !== undefined ? { kind: firstKind } : {}),
		...(warnings.length > 0 ? { reason: warnings.join(" ") } : {}),
		patches,
		fallbackWarnings,
		warnings,
	};
}

export function applySubagentPatches(patches: readonly SubagentPatch[]): void {
	for (const patch of patches) {
		if (patch.provider !== undefined) patch.target.provider = patch.provider;
		if (patch.model !== undefined) patch.target.model = patch.model;
		if (patch.thinking !== undefined) patch.target.thinking = patch.thinking;
		if (patch.tools !== undefined) patch.target.tools = [...patch.tools];
	}
}

// --- Steer & completion gate tracking --------------------------------------

const STEER_TOOLS = new Set(["subagent_interrupt", "subagent_resume", "subagent_answer"]);

export function recordRunStarted(state: DelegationState, payload: RunStartedPayload): void {
	const runId = hasNonEmptyString(payload.runId) ? payload.runId.trim() : "";
	if (!runId) return;
	const resumeOf = hasNonEmptyString(payload.resumeOf) ? payload.resumeOf.trim() : "";
	const rootId = resumeOf ? (state.runLineage.get(resumeOf) ?? resumeOf) : runId;
	state.runLineage.set(runId, rootId);
}

export function recordRunsSnapshot(state: DelegationState, payload: RunsSnapshotPayload): void {
	if (!Array.isArray(payload.runs)) return;
	for (const run of payload.runs) {
		const runId = hasNonEmptyString(run?.runId) ? run.runId.trim() : "";
		if (!runId) continue;
		if (!state.runLineage.has(runId)) {
			state.runLineage.set(runId, runId);
		}
	}
}

export function resolveSteerRunId(
	state: DelegationState,
	toolName: string,
	input: unknown,
): { rawRunId: string; rootId: string | null } {
	const rec = isRecord(input) ? input : {};
	const candidates =
		toolName === "subagent_answer"
			? [rec.runId, rec.run_id, rec.id]
			: [rec.id, rec.runId, rec.run_id];
	const nonEmpty: string[] = [];
	for (const candidate of candidates) {
		if (hasNonEmptyString(candidate)) {
			const trimmed = candidate.trim();
			nonEmpty.push(trimmed);
			const mapped = state.runLineage.get(trimmed);
			if (mapped !== undefined) {
				return { rawRunId: trimmed, rootId: mapped };
			}
		}
	}
	return { rawRunId: nonEmpty[0] ?? "", rootId: null };
}

export function recordSteer(
	state: DelegationState,
	config: DelegationConfig,
	toolName: string,
	input: unknown,
): { unlocked: boolean; newlyUnlocked: boolean; count: number; runId: string } {
	const { rawRunId, rootId } = resolveSteerRunId(state, toolName, input);
	if (!STEER_TOOLS.has(toolName) || !rawRunId || rootId === null) {
		return { unlocked: state.escalationUnlocked, newlyUnlocked: false, count: 0, runId: rawRunId || "default" };
	}
	const count = (state.steerCounts.get(rootId) ?? 0) + 1;
	state.steerCounts.set(rootId, count);

	if (count >= config.steerUnlockThreshold) {
		const newlyUnlocked = !state.escalationUnlocked;
		state.escalationUnlocked = true;
		return { unlocked: true, newlyUnlocked, count, runId: rootId };
	}
	return { unlocked: false, newlyUnlocked: false, count, runId: rootId };
}

export function isReviewFile(filePath: string, config: DelegationConfig, cwd?: string): boolean {
	const norm = normalizeFilePath(filePath, cwd);
	if (!norm) return false;
	const ext = path.extname(norm).toLowerCase();
	if (config.exemptExtensions.includes(ext)) return false;
	return config.reviewExtensions.includes(ext);
}

export function recordFileMutation(
	state: DelegationState,
	config: DelegationConfig,
	filePath: string,
	changedLines: number,
	at: number,
	cwd?: string,
): void {
	const norm = normalizeFilePath(filePath, cwd);
	if (!norm) return;
	const ext = path.extname(norm).toLowerCase();
	if (config.exemptExtensions.includes(ext)) return;

	if (config.testExtensions.includes(ext)) {
		state.testsRequired = true;
		state.testsVerified = false;
		state.lastCodeEditAt = Math.max(state.lastCodeEditAt, at);
	}

	if (isReviewFile(norm, config)) {
		state.dirtyReviewFiles.add(norm);
		state.dirtyReviewLines += Math.max(0, changedLines);
		state.lastReviewEditAt = Math.max(state.lastReviewEditAt, at);
		state.reviewVerified = false;
		if (at >= state.lastReviewInspectionAt) {
			state.lastReviewInspectionAt = 0;
		}
		if (
			state.dirtyReviewFiles.size >= config.reviewThresholdFiles ||
			state.dirtyReviewLines >= config.reviewThresholdLines
		) {
			state.reviewRequired = true;
		}
	}
}

export function recordReviewInspection(state: DelegationState, at: number): void {
	state.lastReviewInspectionAt = Math.max(state.lastReviewInspectionAt, at);
}

export function recordMainModelReview(
	state: DelegationState,
	input: unknown,
	now: number,
): MainModelReviewResult {
	if (!isRecord(input)) {
		return {
			ok: false,
			error: `${RECORD_REVIEW_TOOL} requires an object with verdict, scope, and summary.`,
		};
	}

	const verdict = input.verdict;
	if (typeof verdict !== "string" || !(MAIN_REVIEW_VERDICTS as readonly string[]).includes(verdict)) {
		return {
			ok: false,
			error: `Invalid verdict "${String(verdict ?? "")}"; expected one of: ${MAIN_REVIEW_VERDICTS.join(", ")}.`,
		};
	}

	const scope = typeof input.scope === "string" ? input.scope.trim() : "";
	if (!scope) {
		return {
			ok: false,
			error: `${RECORD_REVIEW_TOOL} requires a non-empty scope describing the inspected diff or files.`,
		};
	}

	const summary = typeof input.summary === "string" ? input.summary.trim() : "";
	if (!summary) {
		return {
			ok: false,
			error: `${RECORD_REVIEW_TOOL} requires a non-empty summary of findings or clean review confirmation.`,
		};
	}

	let inspectedPaths: string[] | undefined;
	if (input.inspectedPaths !== undefined) {
		if (!Array.isArray(input.inspectedPaths)) {
			return {
				ok: false,
				error: "inspectedPaths must be an array of non-empty strings when provided.",
			};
		}
		inspectedPaths = [];
		for (const item of input.inspectedPaths) {
			if (typeof item !== "string" || !item.trim()) {
				return {
					ok: false,
					error: "inspectedPaths entries must be non-empty strings.",
				};
			}
			inspectedPaths.push(item.trim());
		}
	}

	if (
		state.lastReviewEditAt > 0 &&
		(state.lastReviewInspectionAt <= 0 || state.lastReviewInspectionAt < state.lastReviewEditAt)
	) {
		return {
			ok: false,
			error:
				"Post-edit inspection evidence is missing or stale. Inspect the current changes (e.g. run `git diff` / `git show` or `read` the modified files) before calling orchestrator_record_review.",
		};
	}

	const typedVerdict = verdict as MainReviewVerdict;
	const review: MainModelReviewRecord = {
		verdict: typedVerdict,
		scope,
		summary,
		...(inspectedPaths && inspectedPaths.length > 0 ? { inspectedPaths } : {}),
		recordedAt: now,
	};
	state.lastMainReview = review;
	state.reviewVerified = typedVerdict === "pass" || typedVerdict === "accepted_with_notes";
	return { ok: true, review };
}

export function recordPassedCommand(
	state: DelegationState,
	config: DelegationConfig,
	command: string,
	at: number,
	projectVerifyCmd?: string | null,
): boolean {
	if (!state.testsRequired) return false;
	if (at < state.lastCodeEditAt) return false;
	if (!isVerifyCommand(command, config, projectVerifyCmd)) return false;
	state.testsVerified = true;
	return true;
}

export function recordChildSettled(
	state: DelegationState,
	config: DelegationConfig,
	payload: RunSettledPayload,
	projectVerifyCmd?: string | null,
	fallbackCwd?: string,
): void {
	if (hasNonEmptyString(payload.runId)) {
		const id = payload.runId.trim();
		if (!state.runLineage.has(id)) {
			state.runLineage.set(id, id);
		}
	}
	const summary = payload.activitySummary;
	if (summary) {
		const editCwd = payload.cwd ?? fallbackCwd;
		for (const edit of summary.editedFiles) {
			const editAt = edit.lastEditAt ?? summary.lastEditAt ?? payload.finishedAt;
			recordFileMutation(state, config, edit.path, edit.changedLines, editAt, editCwd);
		}
		for (const cmd of summary.passedCommands) {
			if (cmd.at >= state.lastCodeEditAt) {
				recordPassedCommand(state, config, cmd.command, cmd.at, projectVerifyCmd);
			}
		}
	}

	if (
		payload.status === "completed" &&
		(payload.role === "reviewer" || payload.role === "security-reviewer")
	) {
		const startedAt = payload.startedAt ?? payload.finishedAt;
		if (startedAt >= state.lastReviewEditAt) {
			state.reviewVerified = true;
		}
	}
}

export function clearDirtyState(state: DelegationState): void {
	state.testsRequired = false;
	state.testsVerified = false;
	state.reviewRequired = false;
	state.reviewVerified = false;
	state.dirtyReviewFiles.clear();
	state.dirtyReviewLines = 0;
	state.lastCodeEditAt = 0;
	state.lastReviewEditAt = 0;
	state.lastReviewInspectionAt = 0;
	state.lastMainReview = null;
}

export interface CompletionGateOptions {
	waveReadyToCommit?: boolean;
	waveReadyToCommitAt?: number | null;
}

export function evaluateCompletionGate(
	state: DelegationState,
	_config: DelegationConfig,
	options: CompletionGateOptions = {},
): { pending: Array<"tests" | "code-review">; reason: string } {
	const waveBypassAllowed =
		options.waveReadyToCommit === true &&
		(options.waveReadyToCommitAt === undefined ||
			(options.waveReadyToCommitAt !== null &&
				options.waveReadyToCommitAt >= Math.max(state.lastCodeEditAt, state.lastReviewEditAt)));
	if (waveBypassAllowed) {
		return { pending: [], reason: "" };
	}
	const pending: Array<"tests" | "code-review"> = [];
	if (state.testsRequired && !state.testsVerified) pending.push("tests");
	if (state.reviewRequired && !state.reviewVerified) pending.push("code-review");
	if (pending.length === 0) return { pending, reason: "" };

	const parts: string[] = [];
	if (pending.includes("tests")) {
		parts.push('run verification tests via subagent({ role: "coder", task: "Run the test suite and report results" })');
	}
	if (pending.includes("code-review")) {
		parts.push(
			`inspect the diff and call ${RECORD_REVIEW_TOOL}, or run an independent review (${state.dirtyReviewFiles.size} file(s), ${state.dirtyReviewLines} changed line(s)) via subagent({ role: "reviewer", task: "Review the diff for bugs and regressions" })`,
		);
	}
	return {
		pending,
		reason: `Delegation completion gate pending [${pending.join(", ")}]: ${parts.join(" and ")}.`,
	};
}

export function formatLiveRunsSettlementMessage(
	liveRunIds: readonly string[],
	pendingGateReason?: string,
): string {
	const ids = liveRunIds.filter((id) => typeof id === "string" && id.trim().length > 0);
	const listed = ids.length > 0 ? ids.join(", ") : "active background worker(s)";
	const base = `Live delegated subagent run(s) are still active (${listed}). Wait for and collect their results with subagent_wait({ id / ids / plan }) or inspect with subagent_status before settling (or grant orchestrator_override if intentionally leaving them running).`;
	return pendingGateReason ? `${base} ${pendingGateReason}` : base;
}

// --- Formatting ------------------------------------------------------------

export function formatModeDirective(turnMode: TurnMode, discoveryBudget: number): string {
	switch (turnMode) {
		case "security":
			return `Mode: security (direct discovery budget: ${discoveryBudget}). Delegate vulnerability inspection to \`security-reviewer\` first; avoid broad manual reads or test runs on the parent.`;
		case "review":
			return `Mode: review (direct discovery budget: ${discoveryBudget}). Delegate diff review to \`reviewer\` and broader lookups to \`explore\`; keep parent shell calls read-only.`;
		case "debug":
			return `Mode: debug (direct discovery budget: ${discoveryBudget}). Delegate broad search to \`explore\` and test/repro/fix execution to \`coder\`.`;
		case "implement":
			return `Mode: implement (direct discovery budget: ${discoveryBudget}). Plan on the parent, then delegate discovery to \`explore\` and code/test execution to \`coder\`.`;
		case "quick-fix":
			return `Mode: quick-fix (direct discovery budget: ${discoveryBudget}). Keep tiny single-file edits surgical or delegate to \`coder\`; delegate tests/lint to \`coder\`.`;
		case "qa":
			return `Mode: qa (direct discovery budget: ${discoveryBudget}). Answer directly for small lookups; delegate broad or multi-area codebase discovery to \`explore\`.`;
	}
}

export function formatDelegationSection(state: DelegationState, config: DelegationConfig): string {
	const roleLines = Object.entries(config.roles).map(([name, spec]) => {
		const target = spec.inheritModel
			? "inherit parent model"
			: spec.provider && spec.model
				? `${spec.provider}/${spec.model}`
				: "inherit parent model";
		const details = [target];
		if (spec.thinking) details.push(`thinking=${spec.thinking}`);
		if (spec.tools?.length) details.push(`tools=[${spec.tools.join(",")}]`);
		return `- ${name} (${details.join(", ")}): ${spec.description}`;
	});
	const bypassNote = state.directBypass ? ` | ${config.directPrefix} active for this turn` : "";

	return [
		`## Pragmatic Orchestrator Delegation (${config.mode}${bypassNote})`,
		"You are the user-facing orchestrator on the current session model. Understand intent, clarify tradeoffs, plan, delegate heavy execution to subagents, and verify results—avoid spending frontier tokens on broad discovery, routine multi-file edits, or verbose command output.",
		formatModeDirective(state.turnMode, state.discoveryBudget),
		"",
		"**Role split:**",
		`- **Handle directly (orchestrator):** conversation, requirement playback, clarifying questions, architecture decisions, task breakdown, short read-only inspection within the discovery budget (\`read\`/\`grep\`/\`find\`/\`ls\`; read-only shell \`ls\`, \`wc\`, \`git status|diff|log|show|rev-parse|branch|merge-base|describe|fetch\`, \`gh auth status|pr|run|issue|release\` — single simple commands only: no \`&&\`, \`||\`, \`;\`, subshells \`(...)\`, redirects \`>\`/\`<\`, or pipes other than \`| head|tail|wc|cat\`; split into separate calls or delegate to \`explore\` otherwise), reviewing subagent diffs/output (and recording main-model reviews via \`${RECORD_REVIEW_TOOL}\` after diff inspection), and tiny single-file surgical \`edit\`s (≤${config.maxEditLines} changed lines on an already-\`read\` file, max ${config.maxEditedFilesPerTurn} file/turn, no \`write\`).`,
		`- **Delegate by default (\`subagent\`):** \`explore\` (broad/parallel codebase discovery), \`research\` (docs/external references), \`coder\` (implementation, file creation/\`write\`, multi-file or >${config.maxEditLines}-line edits, tests/lint/build without long-lived servers/watchers), \`reviewer\` (independent diff review at ≥${config.reviewThresholdFiles} non-doc files or ≥${config.reviewThresholdLines} changed lines), \`security-reviewer\` (vulnerability audits and \`/security-review\`).`,
		"",
		"**Configured roles:**",
		...roleLines,
		"",
		"**Delegation rules:**",
		`1. Always pass \`role\` on \`subagent\` calls (single and \`tasks[]\`); omit \`provider\`/\`model\` unless the user prompt explicitly names one or uses \`${config.directPrefix}\`.`,
		`2. Write self-contained briefs: workers do not see prior turns or loaded skills. Include goal, exact paths, constraints, conventions, acceptance criteria, and verification commands verbatim; use \`handoff: "standalone"\` (default) or \`"lineage"\` (\`"fork"\` is blocked in \`enforce\`).`,
		"3. Parallelize non-overlapping work (`tasks[]`); keep edits to overlapping files sequential.",
		`4. Steer at most ${config.steerUnlockThreshold} times (\`subagent_answer\` / \`subagent_resume\` / \`subagent_interrupt\`) for same-task follow-ups before escalating; after ${config.steerUnlockThreshold} steers to the same stalled worker lineage in a turn, direct parent editing unlocks for that turn.`,
		`5. Verify before claiming done: run real test/lint/build commands in \`coder\` after code edits, satisfy code review at ≥${config.reviewThresholdFiles} files or ≥${config.reviewThresholdLines} lines (either inspect the diff/files and call \`${RECORD_REVIEW_TOOL}\`, or run \`reviewer\`/\`security-reviewer\`/\`/review\`), and report honest statuses (\`passed\`, \`failed\`, \`not_run\`, \`unavailable\`).`,
		`Skill override: in \`enforce\` mode, route adapted skills' inline edit/test/build steps through \`subagent({ role: "coder" })\` or \`/orchestrate\` (unless \`${config.directPrefix}\`). Escape hatches: \`${config.directPrefix}\` (single turn) or \`/delegation [enforce|warn|off]\`.`,
	].join("\n");
}

export function formatDelegationStatus(
	state: DelegationState,
	config: DelegationConfig,
	options: CompletionGateOptions = {},
): string {
	const gate = evaluateCompletionGate(state, config, options);
	const lastReviewNote = state.lastMainReview ? `, lastMainReview=${state.lastMainReview.verdict}` : "";
	const lines = [
		`Delegation mode: ${config.mode}`,
		`Turn: mode=${state.turnMode}, directBypass=${state.directBypass}, discovery=${state.discoveryCount}/${state.discoveryBudget}, editedFilesThisTurn=${state.editedFilesThisTurn.size}, escalationUnlocked=${state.escalationUnlocked}, settleBlocks=${state.settleBlocksThisTurn}/${config.settleAttemptCap}`,
		`Gates: testsRequired=${state.testsRequired} (verified=${state.testsVerified}), reviewRequired=${state.reviewRequired} (verified=${state.reviewVerified}), dirtyFiles=${state.dirtyReviewFiles.size}, dirtyLines=${state.dirtyReviewLines}${lastReviewNote}`,
		`Pending gates: ${gate.pending.length > 0 ? gate.pending.join(", ") : "none"}`,
		"Roles:",
	];
	for (const [name, spec] of Object.entries(config.roles)) {
		const route = spec.inheritModel
			? "inherit"
			: spec.provider && spec.model
				? `${spec.provider}/${spec.model}`
				: "inherit";
		const extras = [
			spec.thinking ? `thinking=${spec.thinking}` : null,
			spec.tools?.length ? `tools=${spec.tools.join(",")}` : null,
			spec.configuredByUser ? "user-configured" : "default",
		].filter(Boolean);
		lines.push(`- ${name}: ${route} (${extras.join(", ")}) — ${spec.description}`);
	}
	return lines.join("\n");
}
