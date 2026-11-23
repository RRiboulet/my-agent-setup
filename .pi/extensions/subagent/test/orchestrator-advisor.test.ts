// The advisor: one bounded second opinion, delivered as a prompt section.
//
// Two halves, matching the module. The pure half pins the rules that decide
// whether a consultation happens — the trigger, the cooldown, the budget, the
// credential refusal — and the digest's bounds and exclusions. The factory half
// drives the real wiring through `fake-pi.ts` and pins what the acceptance
// criteria ask for and a unit test can see: exactly one call per trigger, the
// verdict as an additive `sections.advisor`, an unchanged model and thinking
// level, an unchanged `systemPrompt`, the refusal surfaced with the provider's
// name, and the usage reaching the session's accounting.
//
// The digest test deliberately builds a branch containing a tool result with a
// huge body: the point of the exclusion is that no such body can reach the
// request, not that the composer forgot to trim one.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	ADVISOR_ENTRY_TYPE,
	ADVISOR_SECTION,
	advisorSkipReason,
	buildAdvisorDigest,
	consultAdvisor,
	detectAdvisorTrigger,
	formatAdvisorRecord,
	formatAdvisorSection,
	gateTriggerKey,
	loopTriggerKey,
	readAdvisorState,
	redactSecrets,
	MAX_ADVISOR_DIGEST_BYTES,
	MAX_ADVISOR_VERDICT_CHARS,
	type AdvisorConfig,
	type AdvisorRecord,
} from "../../orchestrator/advisor.ts";
import {
	gateConfigPath,
	normalizeGateConfig,
	DEFAULT_ADVISOR_BUDGET,
	DEFAULT_ADVISOR_COOLDOWN_MS,
	DEFAULT_ADVISOR_MIN_GATE_BLOCKS,
	DEFAULT_ADVISOR_TIMEOUT_MS,
} from "../../orchestrator/config.ts";
import {
	GATE_ENTRY_TYPE,
	GATE_LOOP_ENTRY_TYPE,
	evaluateGate,
	scanEditVerification,
	scanFailures,
	type GateVerdict,
} from "../../orchestrator/gate.ts";
import orchestratorExtension from "../../orchestrator/index.ts";
import type { OrchestratorRole } from "../../orchestrator/role.ts";
import { createFakeHost } from "./fake-pi.ts";
import { withEnv } from "./helpers.ts";

type Entry = Record<string, unknown>;

const PROVIDER = "opencode-go";
const MODEL = "glm-5.3-flash";

function config(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
	return {
		provider: PROVIDER,
		model: MODEL,
		cooldownMs: DEFAULT_ADVISOR_COOLDOWN_MS,
		budget: DEFAULT_ADVISOR_BUDGET,
		minGateBlocks: DEFAULT_ADVISOR_MIN_GATE_BLOCKS,
		timeoutMs: DEFAULT_ADVISOR_TIMEOUT_MS,
		redact: true,
		fallback: null,
		...overrides,
	};
}

function custom(customType: string, data: unknown): Entry {
	return { type: "custom", id: `entry-${Math.random()}`, customType, data };
}

/** One committed settlement block, shaped like `evaluateGate`'s verdict. */
function gateBlock(attempts: number, blockedBy: string[], extra: Record<string, unknown> = {}): Entry {
	return custom(GATE_ENTRY_TYPE, {
		version: 2,
		kind: "attention",
		decision: "continue",
		outcome: "completed",
		at: attempts,
		scope: "parent",
		attempts,
		attemptCap: 3,
		remainingAttempts: Math.max(0, 3 - attempts),
		blockedBy,
		blockedConditions: blockedBy,
		blockedEvidence: {},
		verification: null,
		override: null,
		reason: `blocked: ${blockedBy.join(", ")}`,
		reasons: [{ code: "settlement-blocked", summary: `blocked: ${blockedBy.join(", ")}` }],
		conditions: [],
		...extra,
	});
}

function loopBlock(
	attempts: number,
	overrides: { tool?: string; invocation?: string; kind?: string; count?: number; action?: string } = {},
): Entry {
	return custom(GATE_LOOP_ENTRY_TYPE, {
		version: 2,
		action: overrides.action ?? "block",
		at: attempts,
		tool: overrides.tool ?? "bash",
		invocation: overrides.invocation ?? "npm test",
		kind: overrides.kind ?? "repeated-failure",
		count: overrides.count ?? 3,
		detail: "AssertionError: boom",
		reason: "a loop",
		attempts,
		attemptCap: 3,
		remainingAttempts: Math.max(0, 3 - attempts),
		blocksTheTurn: 1,
	});
}

function advisorRecord(overrides: Partial<AdvisorRecord> = {}): AdvisorRecord {
	return {
		version: 1,
		at: Date.now(),
		trigger: { kind: "loop-block", key: "loop:bash|npm test|repeated-failure", summary: "a loop" },
		model: { provider: PROVIDER, model: MODEL },
		fallbackFrom: null,
		status: "ok",
		called: true,
		reason: `${PROVIDER}/${MODEL} returned a verdict`,
		verdict: "Root cause: the test is wrong.",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.001 },
		digest: { text: "digest", bytes: 6, truncated: false },
		latencyMs: 12,
		...overrides,
	};
}

/** A fake registry that records every call and answers like the host would. */
function fakeRegistry(options: {
	answer?: string;
	/** One answer per model id, for a fallback that answers differently. */
	answerByModel?: Record<string, string>;
	auth?: { configured: boolean } | undefined;
	/** Per-provider credential status, for a matrix that refuses one of two. */
	authByProvider?: Record<string, { configured: boolean }>;
	hasModel?: boolean;
	fail?: Error | string;
	/** Model ids whose completion throws, so the primary fails and a fallback answers. */
	failModels?: string[];
	/** Model ids whose completion returns an error message, which may still carry usage. */
	errorModels?: string[];
	/** Per-model usage, for a failed primary that reports what it spent. */
	usageByModel?: Record<string, Record<string, unknown>>;
	stopReason?: string;
	usage?: Record<string, unknown> | null;
} = {}) {
	const calls: { model: { provider: string; id: string }; context: Record<string, unknown>; options: Record<string, unknown> }[] = [];
	const registry = {
		find: (provider: string, modelId: string) =>
			options.hasModel === false ? undefined : { provider, id: modelId, name: modelId, api: "openai-completions" },
		getProviderAuthStatus: (provider: string) =>
			options.authByProvider ? options.authByProvider[provider] : options.auth,
		complete: async (model: { provider: string; id: string }, context: Record<string, unknown>, callOptions: Record<string, unknown>) => {
			calls.push({ model, context, options: callOptions });
			if (options.failModels?.includes(model.id)) throw new Error(`provider ${model.provider} exploded`);
			if (options.errorModels?.includes(model.id)) {
				// A provider error reported as a message, not a throw: this is the shape
				// that can still carry the usage of the failed call.
				return {
					role: "assistant",
					content: [],
					api: "openai-completions",
					provider: model.provider,
					model: model.id,
					usage: options.usageByModel?.[model.id] ?? options.usage ?? undefined,
					stopReason: "error",
					errorMessage: `provider ${model.provider} refused`,
					timestamp: Date.now(),
				};
			}
			if (options.fail instanceof Error) throw options.fail;
			if (typeof options.fail === "string") throw new Error(options.fail);
			return {
				role: "assistant",
				content: [
					{
						type: "text",
						text: options.answerByModel?.[model.id] ?? options.answer ?? "Root cause: it is retrying the wrong command.",
					},
				],
				api: "openai-completions",
				provider: PROVIDER,
				model: MODEL,
				usage: options.usage === null
					? undefined
					: options.usageByModel?.[model.id] ?? options.usage ?? {
							input: 120,
							output: 40,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 160,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
						},
				stopReason: options.stopReason ?? "stop",
				timestamp: Date.now(),
			};
		},
	};
	return { registry, calls };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "orchestrator-advisor-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeConfig(dir: string, advisor: unknown): Promise<void> {
	await mkdir(path.join(dir, ".pi"), { recursive: true });
	await writeFile(gateConfigPath(dir), JSON.stringify({ version: 1, block: { loops: true }, advisor }));
}

function promptEvent() {
	return {
		messageType: "user",
		prompt: "continue",
		systemPrompt: "BASE PROMPT",
		systemPromptOptions: { sections: { base: "the base section" } },
	};
}

interface HostOptions {
	branch?: Entry[];
	cwd?: string;
	registry?: Record<string, unknown>;
	trusted?: boolean;
	model?: { provider: string; id: string };
	/** The process-level role; `worker` is a delegated child. */
	role?: OrchestratorRole;
}

function startHost(options: HostOptions = {}) {
	const host = createFakeHost({
		sessionId: "orchestrator-advisor-test",
		branch: options.branch ?? [],
		cwd: options.cwd,
		modelRegistry: options.registry,
		trusted: options.trusted,
		model: options.model ?? { provider: PROVIDER, id: "current-model" },
	});
	// The role is resolved once at module load; the seam drives the worker path
	// without mutating this process's environment after load.
	orchestratorExtension(host.pi, { role: options.role });
	return host;
}

// --- Configuration ----------------------------------------------------------

test("normalizeGateConfig reads the advisor block, and a half-configured advisor is off with a warning", () => {
	const configured = normalizeGateConfig({
		version: 1,
		advisor: { provider: PROVIDER, model: MODEL, cooldownMs: 1000, budget: 4, minGateBlocks: 3, timeoutMs: 5000 },
	});
	assert.deepEqual(configured.warnings, []);
	assert.deepEqual(configured.config.advisor, {
		provider: PROVIDER,
		model: MODEL,
		cooldownMs: 1000,
		budget: 4,
		minGateBlocks: 3,
		timeoutMs: 5000,
		redact: true,
		fallback: null,
	});

	const defaults = normalizeGateConfig({ version: 1, advisor: { provider: PROVIDER, model: MODEL } });
	assert.deepEqual(defaults.config.advisor, config());

	assert.equal(normalizeGateConfig({ version: 1 }).config.advisor, null, "absent means off");

	const half = normalizeGateConfig({ version: 1, advisor: { provider: PROVIDER } });
	assert.equal(half.config.advisor, null);
	assert.match(half.warnings.join(" "), /advisor\.provider and advisor\.model/);

	const invalid = normalizeGateConfig({
		version: 1,
		advisor: { provider: PROVIDER, model: MODEL, cooldownMs: 0, budget: -1, minGateBlocks: 0, timeoutMs: "soon" },
	});
	assert.deepEqual(invalid.config.advisor, config(), "every invalid number falls back rather than guessing");
	assert.match(invalid.warnings.join(" "), /advisor\.cooldownMs must be a positive integer/);
	assert.match(invalid.warnings.join(" "), /advisor\.budget must be a non-negative integer/);

	const capped = normalizeGateConfig({
		version: 1,
		advisor: { provider: PROVIDER, model: MODEL, budget: 1e9, timeoutMs: 1e9 },
	});
	assert.equal(capped.config.advisor?.budget, 20);
	assert.equal(capped.config.advisor?.timeoutMs, 300_000);

	const disabled = normalizeGateConfig({ version: 1, advisor: { provider: PROVIDER, model: MODEL, budget: 0 } });
	assert.equal(disabled.config.advisor?.budget, 0, "0 is a value: it disables the advisor, it is not invalid");
});

test("normalizeGateConfig turns redaction on by default, honours `redact: false`, and validates one fallback", () => {
	const byDefault = normalizeGateConfig({ version: 1, advisor: { provider: PROVIDER, model: MODEL } });
	assert.equal(byDefault.config.advisor?.redact, true, "redaction is on unless a config turns it off");
	assert.equal(byDefault.config.advisor?.fallback, null, "and there is no fallback unless one is named");

	const off = normalizeGateConfig({ version: 1, advisor: { provider: PROVIDER, model: MODEL, redact: false } });
	assert.equal(off.config.advisor?.redact, false);
	assert.deepEqual(off.warnings, []);

	const notBoolean = normalizeGateConfig({ version: 1, advisor: { provider: PROVIDER, model: MODEL, redact: "yes" } });
	assert.equal(notBoolean.config.advisor?.redact, true, "a non-boolean leaves redaction on");
	assert.match(notBoolean.warnings.join(" "), /advisor\.redact must be a boolean/);

	const named = normalizeGateConfig({
		version: 1,
		advisor: { provider: PROVIDER, model: MODEL, fallback: { provider: "backup", model: "backup-model" } },
	});
	assert.deepEqual(named.config.advisor?.fallback, { provider: "backup", model: "backup-model" });
	assert.deepEqual(named.warnings, []);

	// Validated like the primary: both keys, or no fallback and a warning.
	const half = normalizeGateConfig({ version: 1, advisor: { provider: PROVIDER, model: MODEL, fallback: { provider: "backup" } } });
	assert.equal(half.config.advisor?.fallback, null);
	assert.match(half.warnings.join(" "), /advisor\.fallback\.provider and advisor\.fallback\.model/);

	const badShape = normalizeGateConfig({ version: 1, advisor: { provider: PROVIDER, model: MODEL, fallback: "backup/backup-model" } });
	assert.equal(badShape.config.advisor?.fallback, null);
	assert.match(badShape.warnings.join(" "), /advisor\.fallback must be an object/);
});

// --- The trigger ------------------------------------------------------------

test("one settlement block is not a trigger; the same conditions blocking twice is", () => {
	const single = [gateBlock(1, ["todos"])];
	assert.equal(
		detectAdvisorTrigger({ branch: single, config: config(), consumedKeys: [] }),
		null,
		"the gate's first nudge has not failed yet — it has not been tried",
	);

	const repeated = [gateBlock(1, ["todos"]), gateBlock(2, ["todos"])];
	const match = detectAdvisorTrigger({ branch: repeated, config: config(), consumedKeys: [] });
	assert.equal(match?.trigger.kind, "repeated-gate-failure");
	assert.equal(match?.trigger.key, "gate:todos");
	assert.match(match?.trigger.summary ?? "", /blocked settlement 2 times/);
	assert.equal(match?.gate?.attempts, 2, "the digest carries the newest block");

	const different = [gateBlock(1, ["todos"]), gateBlock(2, ["verification"])];
	assert.equal(
		detectAdvisorTrigger({ branch: different, config: config(), consumedKeys: [] }),
		null,
		"a different set of conditions is a different failure, not the same one repeating",
	);

	const third = [gateBlock(1, ["todos"]), gateBlock(2, ["todos"]), gateBlock(3, ["todos"])];
	assert.equal(
		detectAdvisorTrigger({ branch: third, config: config({ minGateBlocks: 3 }), consumedKeys: [] })?.trigger.key,
		"gate:todos",
		"the third block is the trigger when minGateBlocks is 3",
	);
	assert.equal(
		detectAdvisorTrigger({ branch: third, config: config({ minGateBlocks: 4 }), consumedKeys: [] }),
		null,
		"minGateBlocks is honoured",
	);
	assert.equal(detectAdvisorTrigger({ branch: third, config: config(), consumedKeys: ["gate:todos"] }), null, "answered once");
});

test("a loop block triggers on its own, an override does not, and the newest unanswered loop wins", () => {
	const blocked = [loopBlock(1)];
	const match = detectAdvisorTrigger({ branch: blocked, config: config(), consumedKeys: [] });
	assert.equal(match?.trigger.kind, "loop-block");
	assert.equal(match?.trigger.key, loopTriggerKey({ tool: "bash", invocation: "npm test", kind: "repeated-failure" }));
	assert.equal(match?.loop?.tool, "bash");
	assert.match(match?.trigger.summary ?? "", /npm test/);

	const overridden = [loopBlock(1, { action: "override" })];
	assert.equal(
		detectAdvisorTrigger({ branch: overridden, config: config(), consumedKeys: [] }),
		null,
		"an override let the call run: nothing was broken",
	);

	const two = [loopBlock(1, { tool: "edit", invocation: "src/a.ts" }), loopBlock(2)];
	const newest = detectAdvisorTrigger({ branch: two, config: config(), consumedKeys: [] });
	assert.equal(newest?.loop?.tool, "bash", "the freshest trigger is answered first");

	const gateAndLoop = [gateBlock(1, ["todos"]), gateBlock(2, ["todos"]), loopBlock(3)];
	assert.equal(
		detectAdvisorTrigger({ branch: gateAndLoop, config: config(), consumedKeys: [] })?.trigger.kind,
		"loop-block",
		"a loop is the more specific evidence and wins",
	);
});

test("advisorSkipReason bounds attempts by settings, budget and cooldown", () => {
	const state = { attempts: 0, lastAt: null, consumedKeys: [], last: null };
	assert.equal(advisorSkipReason({ state, config: config(), now: 1000 }), null);
	assert.equal(advisorSkipReason({ state, config: config({ budget: 0 }), now: 1000 }), "disabled");
	assert.equal(advisorSkipReason({ state: { ...state, attempts: 2 }, config: config(), now: 1 }), "budget");
	assert.equal(
		advisorSkipReason({ state: { ...state, lastAt: 5_000 }, config: config({ cooldownMs: 10_000 }), now: 10_000 }),
		"cooldown",
	);
	assert.equal(
		advisorSkipReason({ state: { ...state, lastAt: 5_000 }, config: config({ cooldownMs: 10_000 }), now: 15_000 }),
		null,
		"the cooldown expires",
	);
});

test("readAdvisorState counts attempts, keeps the last record and the answered trigger keys", () => {
	const branch = [
		custom(ADVISOR_ENTRY_TYPE, advisorRecord({ at: 10, trigger: { kind: "loop-block", key: "loop:a", summary: "a" } })),
		custom(ADVISOR_ENTRY_TYPE, { nonsense: true }),
		custom(
			ADVISOR_ENTRY_TYPE,
			advisorRecord({
				at: 15,
				status: "refused",
				called: false,
				verdict: null,
				trigger: { kind: "loop-block", key: "loop:refused", summary: "c" },
			}),
		),
		custom(ADVISOR_ENTRY_TYPE, advisorRecord({ at: 20, trigger: { kind: "loop-block", key: "loop:b", summary: "b" } })),
	];
	const state = readAdvisorState(branch);
	assert.equal(state.attempts, 3, "a malformed entry is not an attempt");
	assert.equal(state.lastAt, 20);
	assert.deepEqual(state.consumedKeys.sort(), ["loop:a", "loop:b"], "a refusal spends budget but leaves the trigger open");
	assert.equal(state.last?.at, 20);
	assert.deepEqual(readAdvisorState([]), { attempts: 0, lastAt: null, consumedKeys: [], last: null });
});

// --- The digest -------------------------------------------------------------

test("the digest is bounded, names the trigger, and never carries tool output bodies", () => {
	// The shape the factory feeds it: evidence read from the branch by the gate's
	// own scanners. The body below lives in a toolResult message and must not
	// appear anywhere in the digest.
	const body = "TOOL-OUTPUT-BODY ".repeat(500);
	const branch: Entry[] = [
		{
			type: "message",
			id: "m1",
			message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] },
		},
		{
			type: "message",
			id: "m2",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: `AssertionError: boom\n${body}` }],
				isError: true,
			},
		},
		{
			type: "message",
			id: "m3",
			message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "src/a.ts" } }] },
		},
		{
			type: "message",
			id: "m4",
			message: { role: "toolResult", toolCallId: "c2", toolName: "edit", content: [{ type: "text", text: body }], isError: false },
		},
	];
	const edits = scanEditVerification(branch);
	const gate = evaluateGate({
		outcome: "completed",
		attempts: 2,
		attemptCap: 3,
		edits,
		failure: { signature: "bash|npm test|AssertionError: boom", count: 2, tool: "bash", detail: "AssertionError: boom" },
		verification: {
			status: "failed",
			command: "node --test",
			exitCode: 1,
			durationMs: 5,
			killed: false,
			truncated: false,
			summary: "verification command `node --test` failed",
			output: body,
		},
		now: 5,
	});
	const digest = buildAdvisorDigest({
		trigger: { kind: "loop-block", key: "loop:bash|npm test|repeated-failure", summary: "the loop breaker stopped `bash npm test`" },
		gate,
		loop: {
			version: 2,
			action: "block",
			at: 3,
			tool: "bash",
			invocation: "npm test",
			kind: "repeated-failure",
			count: 3,
			detail: "AssertionError: boom",
			reason: "a loop",
			attempts: 3,
			attemptCap: 3,
			remainingAttempts: 0,
			blocksTheTurn: 1,
		},
		goal: { objective: "ship the advisor" },
		openTodos: [{ id: "aaaaaaaa", title: "write the test" }],
		edits,
	});

	assert.ok(digest.bytes <= MAX_ADVISOR_DIGEST_BYTES);
	assert.equal(digest.truncated, false);
	assert.doesNotMatch(digest.text, /TOOL-OUTPUT-BODY/, "no tool output body may reach the request");
	assert.match(digest.text, /the loop breaker stopped/);
	assert.match(digest.text, /AssertionError: boom/, "the bounded failure signature is evidence");
	assert.match(digest.text, /Verification: failed \(exit 1\)/, "the summary, not the output");
	assert.match(digest.text, /src\/a\.ts/);
	assert.match(digest.text, /ship the advisor/);
});

test("a digest that would exceed the bound is truncated and says so", () => {
	const digest = buildAdvisorDigest({
		trigger: { kind: "repeated-gate-failure", key: "gate:todos", summary: "the gate blocked 2 times" },
		gate: null,
		loop: null,
		goal: { objective: "y".repeat(400) },
		openTodos: Array.from({ length: 5 }, (_, index) => ({ id: `todo-${index}`, title: "z".repeat(400) })),
		edits: {
			editedFiles: Array.from({ length: 200 }, (_, index) => `a/very/long/path/number-${index}/${"x".repeat(150)}.ts`),
			verificationRuns: 0,
		},
	});
	assert.equal(digest.truncated, true);
	assert.ok(digest.bytes <= MAX_ADVISOR_DIGEST_BYTES, `${digest.bytes} must fit ${MAX_ADVISOR_DIGEST_BYTES}`);
	assert.match(digest.text, /\[digest truncated\]$/);
});

// --- Redaction --------------------------------------------------------------

test("redactSecrets removes the documented credential shapes and keeps the key name", () => {
	const cases: { label: string; text: string; secret: string; keeps?: string }[] = [
		{ label: "an OpenAI-style key", text: "using sk-proj-AbCdEf0123456789GhIjKlMnOpQrSt", secret: "sk-proj-AbCdEf0123456789GhIjKlMnOpQrSt" },
		{ label: "a GitHub classic token", text: "export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ012345", secret: "ghp_0123456789abcdefghijABCDEFGHIJ012345", keeps: "GITHUB_TOKEN" },
		{ label: "a GitHub fine-grained token", text: "clone https://github_pat_11ABCDEFG0123456789_abcdefghijklmnop@github.com/x/y", secret: "github_pat_11ABCDEFG0123456789_abcdefghijklmnop" },
		{ label: "an AWS access key id", text: "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE", secret: "AKIAIOSFODNN7EXAMPLE" },
		{ label: "a Slack token", text: "curl -H xoxb-123456789012-abcdefghijkl https://slack.example", secret: "xoxb-123456789012-abcdefghijkl" },
		{ label: "a Bearer header", text: "Authorization: Bearer abcdef0123456789abcdef", secret: "abcdef0123456789abcdef", keeps: "Bearer" },
		{ label: "an api key assignment", text: "OPENAI_API_KEY: sk-test-value", secret: "sk-test-value", keeps: "OPENAI_API_KEY" },
		{ label: "a password assignment", text: "password = \"hunter2\"", secret: "hunter2", keeps: "password" },
		{ label: "a quoted multi-word password", text: 'password: "correct horse battery staple"', secret: "correct horse battery staple", keeps: "password" },
		{ label: "a single-quoted multi-word secret", text: "secret = 'two words here'", secret: "two words here", keeps: "secret" },
		{ label: "an unquoted multi-word password", text: "password: correct horse battery staple", secret: "correct horse battery staple", keeps: "password" },
		{ label: "a doubled-quote password", text: "password: 'it''s a secret'", secret: "it''s a secret", keeps: "password" },
		{ label: "an unquoted value with a residual tail", text: "api_key:   spaced  out  value", secret: "out", keeps: "api_key" },
		{ label: "a Basic header", text: "Authorization: Basic dXNlcjpwYXNzd29yZA==", secret: "dXNlcjpwYXNzd29yZA==", keeps: "Basic" },
		{ label: "URL userinfo", text: "https://user:hunter2@api.example.com/v1", secret: "hunter2", keeps: "api.example.com" },
		{ label: "a lowercase bearer", text: "authorization: bearer abcdef0123456789abcdef", secret: "abcdef0123456789abcdef", keeps: "Bearer" },
		{ label: "an access token assignment", text: "access_token=abc123def456", secret: "abc123def456", keeps: "access_token" },
	];
	for (const entry of cases) {
		const redacted = redactSecrets(entry.text);
		assert.doesNotMatch(redacted, new RegExp(entry.secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")), `${entry.label} must be redacted`);
		assert.match(redacted, /\[redacted\]/, `${entry.label} leaves a marker`);
		if (entry.keeps) assert.match(redacted, new RegExp(entry.keeps), `${entry.label} keeps the key name`);
	}
});

test("redactSecrets leaves ordinary prose and file paths alone", () => {
	const clean = [
		"src/auth/password.test.ts was edited",
		"rotate the secret only after the migration lands",
		"docs/api-key-rotation.md explains the setting",
		"the loop stopped after `npm test` failed 3 times",
	];
	for (const text of clean) assert.equal(redactSecrets(text), text);
});

test("a credential-shaped assignment is over-redacted rather than leak a passphrase", () => {
	// The unquoted branch runs to the end of the field. A sentence that uses one of
	// the key words loses its tail; that is the safe direction for evidence that is
	// about to be sent to another provider.
	assert.equal(redactSecrets("rotate the password: tomorrow"), "rotate the password: [redacted]");
	assert.equal(redactSecrets("password: correct horse battery staple"), "password: [redacted]");
});

test("a credential in any kept digest field is redacted before the size bound, and `redact: false` keeps it", () => {
	const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
	const slack = "xoxb-123456789012-abcdefghijkl";
	const openai = "sk-proj-AbCdEf0123456789GhIjKlMnOpQrSt";
	const input = {
		trigger: { kind: "loop-block" as const, key: "loop:bash|deploy", summary: "the loop breaker stopped `bash deploy`" },
		gate: {
			kind: "attention" as const,
			decision: "continue" as const,
			attempts: 2,
			attemptCap: 3,
			scope: "parent" as const,
			blockedBy: ["verification"],
			reason: "blocked: verification",
			reasons: [{ code: "verification-failed", summary: `verification failed with ${token}` }],
			verification: { status: "failed" as const, command: "deploy", exitCode: 1, summary: `deploy --token ${slack} exited 1` },
		},
		loop: {
			version: 2 as const,
			action: "block" as const,
			at: 3,
			tool: "bash",
			invocation: "deploy",
			kind: "repeated-failure" as const,
			count: 3,
			detail: `fatal: remote rejected ${openai}`,
			reason: "a loop",
			attempts: 3,
			attemptCap: 3,
			remainingAttempts: 0,
			blocksTheTurn: 1,
		},
		goal: { objective: `ship it with ${token} rotated` },
		openTodos: [{ id: "aaaaaaaa", title: `rotate password = ${slack}` }],
		edits: { editedFiles: [`certs/${token}.pem`, "src/a.ts"], verificationRuns: 0 },
	};

	const digest = buildAdvisorDigest(input);
	for (const secret of [token, slack, openai]) {
		assert.doesNotMatch(digest.text, new RegExp(secret), "no retained field may carry a credential");
	}
	assert.match(digest.text, /\[redacted\]/);
	assert.match(digest.text, /certs\/\[redacted\]\.pem/, "the field, not the line, is replaced");
	assert.match(digest.text, /rotate password = \[redacted\]/, "a todo title is redacted too");
	assert.match(digest.text, /Verification: failed \(exit 1\)/, "the digest's structure survives redaction");
	assert.match(digest.text, /Edited since the last verification \(2\)/);
	assert.match(digest.text, /Open todos \(1\)/);
	assert.ok(digest.bytes <= MAX_ADVISOR_DIGEST_BYTES, "the bound is applied after redaction");

	const verbatim = buildAdvisorDigest({ ...input, redact: false });
	assert.match(verbatim.text, new RegExp(token), "a config can turn redaction off");

	// A redacted digest that is still over the bound is truncated, not enlarged.
	const huge = buildAdvisorDigest({
		...input,
		gate: {
			...input.gate,
			reasons: Array.from({ length: 8 }, (_, index) => ({
				code: `reason-${index}`,
				summary: `reason ${index} ${"w".repeat(150)}`,
			})),
		},
		edits: {
			editedFiles: Array.from({ length: 200 }, (_, index) =>
				index === 0 ? `certs/${token}.pem` : `a/very/long/path/number-${index}/${"x".repeat(150)}.ts`,
			),
			verificationRuns: 0,
		},
		openTodos: Array.from({ length: 5 }, (_, index) => ({
			id: `todo-${index}`,
			title: index === 0 ? `rotate secret = ${token}` : `z${index}`.repeat(80),
		})),
		goal: { objective: "y".repeat(160) },
	});
	assert.equal(huge.truncated, true);
	assert.ok(huge.bytes <= MAX_ADVISOR_DIGEST_BYTES);
	assert.doesNotMatch(huge.text, new RegExp(token));
	assert.match(huge.text, /certs\/\[redacted\]\.pem/, "the redaction happens before the cut, not after it");
});

// --- The consultation -------------------------------------------------------

test("consultAdvisor bounds the verdict it keeps", async () => {
	// A provider can return far more than the section should carry; the record is what
	// /gate and the prompt section render.
	const { registry } = fakeRegistry({ answer: "v".repeat(MAX_ADVISOR_VERDICT_CHARS + 50) });
	const digest = buildAdvisorDigest({ trigger: { kind: "loop-block", key: "k", summary: "a loop" }, gate: null, loop: null, goal: null, openTodos: [], edits: null });
	const call = await consultAdvisor({ registry, config: config(), digest, env: {} });
	assert.equal(call.status, "ok");
	assert.equal(call.verdict?.length, MAX_ADVISOR_VERDICT_CHARS);
});

test("consultAdvisor reports an in-band provider error instead of an empty verdict", async () => {
	// A thrown error is not the only failure shape: a provider can answer with
	// `stopReason: "error"` and no text. Turning that into "empty"/"ok" would hide it.
	const { registry } = fakeRegistry({ stopReason: "error", answer: "" });
	const digest = buildAdvisorDigest({ trigger: { kind: "loop-block", key: "k", summary: "a loop" }, gate: null, loop: null, goal: null, openTodos: [], edits: null });
	const call = await consultAdvisor({ registry, config: config(), digest, env: {} });
	assert.equal(call.status, "error");
	assert.match(call.reason, /failed/);
	assert.equal(call.verdict, null);
});

test("consultAdvisor reports an aborted call instead of waiting on it", async () => {
	const { registry } = fakeRegistry({});
	const digest = buildAdvisorDigest({ trigger: { kind: "loop-block", key: "k", summary: "a loop" }, gate: null, loop: null, goal: null, openTodos: [], edits: null });
	const call = await consultAdvisor({
		registry,
		config: config(),
		digest,
		env: {},
		signal: AbortSignal.abort(),
	});
	assert.equal(call.status, "error");
	assert.match(call.reason, /aborted/);
});

test("consultAdvisor makes one completion, returns the verdict and its usage", async () => {
	const { registry, calls } = fakeRegistry({ answer: "Root cause: wrong command.\nNext step: run the right one." });
	const digest = buildAdvisorDigest({ trigger: { kind: "loop-block", key: "k", summary: "a loop" }, gate: null, loop: null, goal: null, openTodos: [], edits: null });
	const call = await consultAdvisor({ registry, config: config(), digest, env: {} });

	assert.equal(calls.length, 1);
	assert.equal(call.status, "ok");
	assert.equal(call.verdict, "Root cause: wrong command.\nNext step: run the right one.");
	assert.deepEqual(call.usage, { input: 120, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 160, cost: 0.002 });
	const sent = calls[0]!.context as { systemPrompt: string; messages: { content: { text: string }[] }[] };
	assert.match(sent.systemPrompt, /second opinion/);
	assert.equal(sent.messages[0]?.content[0]?.text, digest.text);
	assert.equal(calls[0]?.options.timeoutMs, DEFAULT_ADVISOR_TIMEOUT_MS);
});

test("with no credentials the provider is not called and the reason names it", async () => {
	const { registry, calls } = fakeRegistry({ auth: { configured: false } });
	const call = await consultAdvisor({
		registry,
		config: config({ provider: "nowhere" }),
		digest: { text: "d", bytes: 1, truncated: false },
		env: {},
	});
	assert.equal(calls.length, 0, "no call may be made without credentials");
	assert.equal(call.called, false);
	assert.equal(call.status, "refused");
	assert.match(call.reason, /no credentials for provider "nowhere"/);
	assert.match(call.reason, /NOWHERE_API_KEY/, "the reason says how to fix it");
});

test("an unknown credential status is usable, and a provider failure is reported, not thrown", async () => {
	// No status method at all: pi could not tell, which must not disable a setup
	// that authenticates in a way pi cannot see.
	const withoutStatus = fakeRegistry();
	delete (withoutStatus.registry as { getProviderAuthStatus?: unknown }).getProviderAuthStatus;
	const usable = await consultAdvisor({
		registry: withoutStatus.registry,
		config: config(),
		digest: { text: "d", bytes: 1, truncated: false },
		env: {},
	});
	assert.equal(usable.status, "ok");
	assert.equal(withoutStatus.calls.length, 1);

	const failing = fakeRegistry({ fail: new Error("provider exploded") });
	const failed = await consultAdvisor({
		registry: failing.registry,
		config: config(),
		digest: { text: "d", bytes: 1, truncated: false },
		env: {},
	});
	assert.equal(failed.called, true);
	assert.equal(failed.status, "error");
	assert.match(failed.reason, /provider exploded/);

	const missing = fakeRegistry({ hasModel: false });
	const absent = await consultAdvisor({
		registry: missing.registry,
		config: config(),
		digest: { text: "d", bytes: 1, truncated: false },
		env: {},
	});
	assert.equal(absent.called, false);
	assert.match(absent.reason, new RegExp(`${PROVIDER}/${MODEL}`));

	const empty = fakeRegistry({ answer: "" });
	const blank = await consultAdvisor({
		registry: empty.registry,
		config: config(),
		digest: { text: "d", bytes: 1, truncated: false },
		env: {},
	});
	assert.equal(blank.called, true);
	assert.equal(blank.status, "empty");
	assert.match(blank.reason, /no verdict text/);
});

// --- The fallback -----------------------------------------------------------

/** The digest every fallback test sends; the content is irrelevant there. */
const FALLBACK_DIGEST = { text: "d", bytes: 1, truncated: false };

function fallbackConfig(): AdvisorConfig {
	return config({ fallback: { provider: "backup", model: "backup-model" } });
}

test("the fallback answers only on a provider error: not on a refusal, an abort or an empty verdict", async () => {
	const answered = fakeRegistry();
	const primaryOk = await consultAdvisor({ registry: answered.registry, config: fallbackConfig(), digest: FALLBACK_DIGEST, env: {} });
	assert.equal(answered.calls.length, 1, "the primary answered, so the fallback is not called");
	assert.equal(primaryOk.status, "ok");
	assert.deepEqual(primaryOk.model, { provider: PROVIDER, model: MODEL }, "the record names the answering model");
	assert.equal(primaryOk.fallbackFrom, null);

	const failing = fakeRegistry({ failModels: [MODEL] });
	const fellBack = await consultAdvisor({ registry: failing.registry, config: fallbackConfig(), digest: FALLBACK_DIGEST, env: {} });
	assert.equal(failing.calls.length, 2, "one attempt on the primary, one on the fallback");
	assert.deepEqual(failing.calls.map((call) => call.model.id), [MODEL, "backup-model"]);
	assert.equal(fellBack.status, "ok");
	assert.deepEqual(fellBack.model, { provider: "backup", model: "backup-model" }, "the record names the model that answered");
	assert.deepEqual(fellBack.fallbackFrom, { provider: PROVIDER, model: MODEL }, "and the primary it replaced");
	assert.match(fellBack.reason, /fallback/, "the reason says a fallback answered");

	// A credential refusal is a configuration error, not an outage: no fallback.
	const refused = fakeRegistry({ authByProvider: { [PROVIDER]: { configured: false } } });
	const refusedCall = await consultAdvisor({ registry: refused.registry, config: fallbackConfig(), digest: FALLBACK_DIGEST, env: {} });
	assert.equal(refused.calls.length, 0, "a refusal falls back to nothing");
	assert.equal(refusedCall.status, "refused");
	assert.deepEqual(refusedCall.model, { provider: PROVIDER, model: MODEL }, "a refusal names the model it refused");
	assert.equal(refusedCall.fallbackFrom, null);

	const aborted = fakeRegistry();
	const abortedCall = await consultAdvisor({
		registry: aborted.registry,
		config: fallbackConfig(),
		digest: FALLBACK_DIGEST,
		env: {},
		signal: AbortSignal.abort(),
	});
	assert.equal(aborted.calls.length, 1, "an aborted attempt is not retried on another provider");
	assert.equal(abortedCall.status, "error");
	assert.equal(abortedCall.fallbackFrom, null);

	const stopped = fakeRegistry({ stopReason: "aborted" });
	const stoppedCall = await consultAdvisor({ registry: stopped.registry, config: fallbackConfig(), digest: FALLBACK_DIGEST, env: {} });
	assert.equal(stopped.calls.length, 1, "a provider that reports an abort is not a provider outage");
	assert.equal(stoppedCall.status, "error");
	assert.equal(stoppedCall.fallbackFrom, null);

	// Empty is not an error either: documented, so a later change is deliberate.
	const empty = fakeRegistry({ answer: "" });
	const emptyCall = await consultAdvisor({ registry: empty.registry, config: fallbackConfig(), digest: FALLBACK_DIGEST, env: {} });
	assert.equal(empty.calls.length, 1, "an empty verdict is reported, not spent on a second provider");
	assert.equal(emptyCall.status, "empty");
	assert.equal(emptyCall.fallbackFrom, null);
});

test("a fallback that also fails is one record, naming the fallback and keeping the primary's reason", async () => {
	const both = fakeRegistry({ failModels: [MODEL, "backup-model"] });
	const failed = await consultAdvisor({ registry: both.registry, config: fallbackConfig(), digest: FALLBACK_DIGEST, env: {} });
	assert.equal(both.calls.length, 2);
	assert.equal(failed.status, "error");
	assert.deepEqual(failed.model, { provider: "backup", model: "backup-model" }, "the failure names the model that failed");
	assert.deepEqual(failed.fallbackFrom, { provider: PROVIDER, model: MODEL });
	assert.match(failed.reason, /backup\/backup-model/);
	assert.match(failed.reason, /provider backup exploded/);
	assert.match(failed.reason, new RegExp(`${PROVIDER}/${MODEL}`), "the primary's failure is not lost");
	assert.equal(failed.called, true);

	// A fallback whose own credentials are missing is a refusal, still named.
	const noBackupCredential = fakeRegistry({ failModels: [MODEL], authByProvider: { backup: { configured: false } } });
	const refusedFallback = await consultAdvisor({
		registry: noBackupCredential.registry,
		config: fallbackConfig(),
		digest: FALLBACK_DIGEST,
		env: {},
	});
	assert.equal(noBackupCredential.calls.length, 1, "the fallback's credential check happens before its call");
	assert.equal(refusedFallback.status, "refused");
	assert.equal(refusedFallback.called, true, "the primary was called even though the fallback's credential check refused");
	assert.deepEqual(refusedFallback.model, { provider: "backup", model: "backup-model" });
	assert.deepEqual(refusedFallback.fallbackFrom, { provider: PROVIDER, model: MODEL });
	assert.match(refusedFallback.reason, /no credentials for provider "backup"/);
});

// --- The factory ------------------------------------------------------------

test("with no advisor configured, no consultation is made and no section is injected", async () => {
	await withTempDir(async (cwd) => {
		const { registry, calls } = fakeRegistry();
		const host = startHost({ cwd, branch: [loopBlock(1)], registry });
		await host.fire("session_start", {});
		const event = promptEvent();
		await host.fire("before_agent_start", event);
		assert.equal(calls.length, 0);
		assert.deepEqual(Object.keys(event.systemPromptOptions.sections), ["base"]);
		assert.deepEqual(host.appended, []);
	});
});

test("a configured trigger makes exactly one consultation and injects the verdict as an additive section", async () => {
	await withTempDir(async (cwd) => {
		await writeConfig(cwd, { provider: PROVIDER, model: MODEL });
		const { registry, calls } = fakeRegistry();
		const branch = [gateBlock(1, ["todos"]), gateBlock(2, ["todos"])];
		const host = startHost({ cwd, branch, registry });
		await host.fire("session_start", {});

		const event = promptEvent();
		const returned = await host.fire("before_agent_start", event);

		assert.equal(calls.length, 1, "exactly one consultation per trigger");
		assert.equal(returned, undefined, "nothing replaces the system prompt");
		assert.equal(event.systemPrompt, "BASE PROMPT", "the system prompt is untouched");
		assert.deepEqual(event.systemPromptOptions.sections.base, "the base section", "every other section is identical");
		assert.match(event.systemPromptOptions.sections[ADVISOR_SECTION] ?? "", /Root cause: it is retrying the wrong command\./);
		assert.match(event.systemPromptOptions.sections[ADVISOR_SECTION] ?? "", new RegExp(`${PROVIDER}/${MODEL}`));

		const entry = host.appended.find((candidate) => candidate.customType === ADVISOR_ENTRY_TYPE);
		assert.ok(entry, "the consultation is auditable in the session");
		const record = entry.data as AdvisorRecord;
		assert.equal(record.trigger.key, gateTriggerKey({ blockedBy: ["todos"] } as GateVerdict));
		assert.equal(record.status, "ok");
		assert.equal(record.verdict, "Root cause: it is retrying the wrong command.");
		assert.ok(record.digest.text.length > 0, "the entry keeps what the advisor was asked");

		// The model and thinking level are the session's, not the advisor's.
		assert.deepEqual(host.modelChanges, []);
		assert.deepEqual(host.thinkingChanges, []);
		assert.deepEqual(host.ctx.model, { provider: PROVIDER, id: "current-model" });

		// And the call's usage reaches the session's accounting, not only the entry.
		assert.equal(host.usageEntries.length, 1);
		assert.equal(host.usageEntries[0]?.kind, "advisor");
		assert.equal(host.usageEntries[0]?.provider, PROVIDER);
		assert.equal(host.usageEntries[0]?.model, MODEL);
		assert.equal((host.usageEntries[0]?.usage as { totalTokens: number }).totalTokens, 160);
	});
});

test("the consultation carries the parent session id, so a provider that routes by it can answer", async () => {
	await withTempDir(async (cwd) => {
		await writeConfig(cwd, { provider: PROVIDER, model: MODEL });
		const { registry, calls } = fakeRegistry();
		const host = startHost({ cwd, branch: [loopBlock(1)], registry });
		await host.fire("session_start", {});
		await host.fire("before_agent_start", promptEvent());

		// OpenCode Go rejects a request without `x-opencode-session`; the
		// registry turns this option into that header.
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.options.sessionId, "orchestrator-advisor-test");
	});
});

test("the same trigger is not consulted twice: the answered key is reconstructed from the branch", async () => {
	await withTempDir(async (cwd) => {
		await writeConfig(cwd, { provider: PROVIDER, model: MODEL });
		const branch = [gateBlock(1, ["todos"]), gateBlock(2, ["todos"])];
		const first = startHost({ cwd, branch, registry: fakeRegistry().registry });
		await first.fire("session_start", {});
		await first.fire("before_agent_start", promptEvent());
		const record = first.appended.find((candidate) => candidate.customType === ADVISOR_ENTRY_TYPE)?.data;
		assert.ok(record);

		// What a reload, or the next prompt, sees: the entry is part of the branch.
		const { registry, calls } = fakeRegistry();
		const resumed = startHost({ cwd, branch: [...branch, custom(ADVISOR_ENTRY_TYPE, record)], registry });
		await resumed.fire("session_start", {});
		const event = promptEvent();
		await resumed.fire("before_agent_start", event);
		assert.equal(calls.length, 0, "an answered trigger does not buy a second opinion");
		assert.deepEqual(Object.keys(event.systemPromptOptions.sections), ["base"]);
	});
});

test("a trigger inside the cooldown makes no call, and an exhausted budget stops calls", async () => {
	await withTempDir(async (cwd) => {
		await writeConfig(cwd, { provider: PROVIDER, model: MODEL, cooldownMs: 600_000, budget: 2 });
		const branch = [gateBlock(1, ["todos"]), gateBlock(2, ["todos"])];

		const cooling = fakeRegistry();
		const coolHost = startHost({
			cwd,
			branch: [...branch, custom(ADVISOR_ENTRY_TYPE, advisorRecord({ at: Date.now() - 1_000, trigger: { kind: "loop-block", key: "loop:other", summary: "a different loop" } }))],
			registry: cooling.registry,
		});
		await coolHost.fire("session_start", {});
		await coolHost.fire("before_agent_start", promptEvent());
		assert.equal(cooling.calls.length, 0, "a recent attempt suppresses the next one");

		const spent = fakeRegistry();
		const spentHost = startHost({
			cwd,
			branch: [
				...branch,
				custom(ADVISOR_ENTRY_TYPE, advisorRecord({ at: 1, trigger: { kind: "loop-block", key: "loop:a", summary: "a" } })),
				custom(ADVISOR_ENTRY_TYPE, advisorRecord({ at: 2, trigger: { kind: "loop-block", key: "loop:b", summary: "b" } })),
			],
			registry: spent.registry,
		});
		await spentHost.fire("session_start", {});
		await spentHost.fire("before_agent_start", promptEvent());
		assert.equal(spent.calls.length, 0, "the budget is spent on the branch and stays spent");
	});
});

test("a missing credential makes no call, and the reason is surfaced naming the provider", async () => {
	await withEnv({ NOWHERE_API_KEY: undefined }, async () => {
		await withTempDir(async (cwd) => {
			await writeConfig(cwd, { provider: "nowhere", model: "some-model" });
			const { registry, calls } = fakeRegistry({ auth: { configured: false } });
			const host = startHost({ cwd, branch: [loopBlock(1)], registry });
			await host.fire("session_start", {});
			const event = promptEvent();
			await host.fire("before_agent_start", event);

			assert.equal(calls.length, 0);
			assert.deepEqual(Object.keys(event.systemPromptOptions.sections), ["base"], "no verdict to inject");
			const notice = host.messages.find((message) => message.message.customType === "orchestrator-advisor-notice");
			assert.ok(notice, "a refusal is not a silent skip");
			assert.match(String(notice.message.content), /no credentials for provider "nowhere"/);
			const entry = host.appended.find((candidate) => candidate.customType === ADVISOR_ENTRY_TYPE);
			assert.equal((entry?.data as AdvisorRecord).status, "refused");
			assert.equal(host.usageEntries.length, 0, "a refusal costs nothing");
		});
	});
});

test("an untrusted project ignores the advisor key: no call, no entry, no section", async () => {
	await withTempDir(async (cwd) => {
		await writeConfig(cwd, { provider: PROVIDER, model: MODEL });
		const { registry, calls } = fakeRegistry();
		const host = startHost({ cwd, branch: [loopBlock(1)], registry, trusted: false });
		await host.fire("session_start", {});
		const event = promptEvent();
		await host.fire("before_agent_start", event);
		assert.equal(calls.length, 0, "a committed file cannot spend the user's tokens in an untrusted clone");
		assert.deepEqual(host.appended, []);
		assert.deepEqual(Object.keys(event.systemPromptOptions.sections), ["base"]);
	});
});

test("a delegated child consults nothing, exactly like the gate", async () => {
	await withTempDir(async (cwd) => {
		await writeConfig(cwd, { provider: PROVIDER, model: MODEL });
		const { registry, calls } = fakeRegistry();
		const host = startHost({ cwd, branch: [loopBlock(1)], registry, role: "worker" });
		await host.fire("session_start", {});
		await host.fire("before_agent_start", promptEvent());
		assert.equal(calls.length, 0);
		assert.deepEqual(host.appended, []);
	});
});

test("a host with no prompt sections records the verdict and says it was not attached", async () => {
	// The only delivery channel is a section. A host that offers none must not swallow
	// the verdict silently: it is recorded, and a notice says it was not attached.
	await withTempDir(async (dir) => {
		await writeConfig(dir, { provider: PROVIDER, model: MODEL });
		const { registry } = fakeRegistry({ answer: "try the other command" });
		// Reachable only through a host whose event carries no sections.
		const host = startHost({ cwd: dir, registry, branch: [loopBlock(1)] });
		await host.fire("before_agent_start", {
			messageType: "user",
			prompt: "continue",
			systemPrompt: "BASE",
		});
		const notice = host.messages.find((entry) => entry.message.customType === "orchestrator-advisor-notice");
		assert.ok(notice, "the verdict must not be dropped silently");
		assert.match(String(notice?.message.content), /no prompt sections/);
	});
});

test("the digest sent to the model excludes tool output bodies, end to end", async () => {
	await withTempDir(async (cwd) => {
		await writeConfig(cwd, { provider: PROVIDER, model: MODEL });
		const body = "SECRET-TOOL-OUTPUT ".repeat(2000);
		const branch: Entry[] = [
			loopBlock(1),
			{
				type: "message",
				id: "m1",
				message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] },
			},
			{
				type: "message",
				id: "m2",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text", text: `Error: boom\n${body}` }],
					isError: true,
				},
			},
		];
		const { registry, calls } = fakeRegistry();
		const host = startHost({ cwd, branch, registry });
		await host.fire("session_start", {});
		await host.fire("before_agent_start", promptEvent());

		assert.equal(calls.length, 1);
		const sent = calls[0]!.context as { messages: { content: { text: string }[] }[] };
		const text = sent.messages[0]?.content[0]?.text ?? "";
		assert.doesNotMatch(text, /SECRET-TOOL-OUTPUT/);
		assert.ok(Buffer.byteLength(text, "utf8") <= MAX_ADVISOR_DIGEST_BYTES);
		assert.match(text, /the loop breaker stopped/);
	});
});

test("a credential in a kept digest field is redacted in the request and in the record, and a config can turn it off", async () => {
	await withTempDir(async (cwd) => {
		const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
		await writeConfig(cwd, { provider: PROVIDER, model: MODEL });
		const branch = [loopBlock(1, { invocation: `deploy --token ${token}` })];
		const { registry, calls } = fakeRegistry();
		const host = startHost({ cwd, branch, registry });
		await host.fire("session_start", {});
		await host.fire("before_agent_start", promptEvent());

		assert.equal(calls.length, 1);
		const sent = calls[0]!.context as { messages: { content: { text: string }[] }[] };
		const text = sent.messages[0]!.content[0]!.text;
		assert.doesNotMatch(text, new RegExp(token), "a credential-shaped invocation reaches the model only redacted");
		assert.match(text, /\[redacted\]/);
		assert.match(text, /the loop breaker stopped/, "the digest's structure is unchanged");

		const record = host.appended.find((candidate) => candidate.customType === ADVISOR_ENTRY_TYPE)?.data as AdvisorRecord;
		assert.doesNotMatch(record.digest.text, new RegExp(token), "the recorded digest is redacted too");
		assert.ok(record.digest.bytes <= MAX_ADVISOR_DIGEST_BYTES);

		// The same project can opt out; then the digest is sent verbatim.
		const verbatimDir = path.join(cwd, "verbatim");
		await writeConfig(verbatimDir, { provider: PROVIDER, model: MODEL, redact: false });
		const verbatim = fakeRegistry();
		const verbatimHost = startHost({ cwd: verbatimDir, branch, registry: verbatim.registry });
		await verbatimHost.fire("session_start", {});
		await verbatimHost.fire("before_agent_start", promptEvent());
		const verbatimSent = verbatim.calls[0]!.context as { messages: { content: { text: string }[] }[] };
		assert.match(verbatimSent.messages[0]!.content[0]!.text, new RegExp(token), "redact: false is honoured end to end");
	});
});

test("when the primary fails the fallback answers, the record names it, and one attempt spends one budget unit", async () => {
	await withTempDir(async (cwd) => {
		await writeConfig(cwd, {
			provider: PROVIDER,
			model: MODEL,
			budget: 1,
			fallback: { provider: "backup", model: "backup-model" },
		});
		const { registry, calls } = fakeRegistry({
			failModels: [MODEL],
			answerByModel: { "backup-model": "Root cause: the fallback saw the wrong command." },
		});
		const host = startHost({ cwd, branch: [loopBlock(1)], registry });
		await host.fire("session_start", {});
		const event = promptEvent();
		await host.fire("before_agent_start", event);

		assert.equal(calls.length, 2, "the primary, then the fallback once");
		assert.deepEqual(calls.map((call) => call.model.id), [MODEL, "backup-model"]);

		const entries = host.appended.filter((candidate) => candidate.customType === ADVISOR_ENTRY_TYPE);
		assert.equal(entries.length, 1, "two provider calls are still one recorded attempt");
		const record = entries[0]!.data as AdvisorRecord;
		assert.equal(record.status, "ok");
		assert.deepEqual(record.model, { provider: "backup", model: "backup-model" }, "the record names the model that answered");
		assert.deepEqual(record.fallbackFrom, { provider: PROVIDER, model: MODEL });
		assert.match(record.verdict ?? "", /the fallback saw the wrong command/);
		assert.match(event.systemPromptOptions.sections[ADVISOR_SECTION] ?? "", /backup\/backup-model/);

		// One attempt: the branch that holds the record is out of a budget of one.
		const state = readAdvisorState([custom(ADVISOR_ENTRY_TYPE, record)]);
		assert.equal(state.attempts, 1);
		assert.equal(advisorSkipReason({ state, config: config({ budget: 1 }), now: Date.now() }), "budget");

		// And the answering model is the one billed.
		assert.equal(host.usageEntries.length, 1);
		assert.equal(host.usageEntries[0]?.provider, "backup");
		assert.equal(host.usageEntries[0]?.model, "backup-model");
	});
});

test("a failed primary's reported usage is added to the fallback's, so both calls are billed", async () => {
	const { registry, calls } = fakeRegistry({
		errorModels: [MODEL],
		usageByModel: {
			[MODEL]: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
			},
			"backup-model": {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
			},
		},
	});
	const call = await consultAdvisor({ registry, config: fallbackConfig(), digest: FALLBACK_DIGEST, env: {} });
	assert.equal(calls.length, 2, "the error primary, then the fallback");
	assert.equal(call.status, "ok");
	assert.equal(call.called, true);
	assert.deepEqual(call.model, { provider: "backup", model: "backup-model" });
	assert.equal(call.usage?.input, 150, "the failed primary's input is billed too");
	assert.equal(call.usage?.output, 30);
	assert.equal(call.usage?.totalTokens, 180);
	assert.ok(Math.abs((call.usage?.cost ?? 0) - 0.003) < 1e-12, "both calls' costs are summed");
});

test("a refused primary is not retried on the fallback", async () => {
	await withEnv({ NOWHERE_API_KEY: undefined }, async () => {
		await withTempDir(async (cwd) => {
			await writeConfig(cwd, { provider: "nowhere", model: "some-model", fallback: { provider: "backup", model: "backup-model" } });
			const { registry, calls } = fakeRegistry({ authByProvider: { nowhere: { configured: false } } });
			const host = startHost({ cwd, branch: [loopBlock(1)], registry });
			await host.fire("session_start", {});
			await host.fire("before_agent_start", promptEvent());

			assert.equal(calls.length, 0, "a credential refusal is a configuration error, not an outage");
			const record = host.appended.find((candidate) => candidate.customType === ADVISOR_ENTRY_TYPE)?.data as AdvisorRecord;
			assert.equal(record.status, "refused");
			assert.equal(record.fallbackFrom, null);
			assert.deepEqual(record.model, { provider: "nowhere", model: "some-model" });
		});
	});
});

test("the section and the /gate record render the trigger, the verdict and the usage", () => {
	const record = advisorRecord();
	const section = formatAdvisorSection(record);
	assert.match(section, /Root cause: the test is wrong\./);
	assert.match(section, new RegExp(`${PROVIDER}/${MODEL}`));
	assert.match(section, /not an instruction from the user/);

	const refused = formatAdvisorRecord(
		advisorRecord({ status: "refused", called: false, verdict: null, reason: 'no credentials for provider "nowhere"', usage: null }),
	);
	assert.match(refused, /REFUSED/);
	assert.match(refused, /no credentials for provider "nowhere"/);

	const shown = formatAdvisorRecord(record);
	assert.match(shown, /OK/);
	assert.match(shown, /Usage: 10 in \/ 5 out/);
	assert.match(shown, /cost 0\.001/);

	const fellBack = formatAdvisorRecord(
		advisorRecord({ model: { provider: "backup", model: "backup-model" }, fallbackFrom: { provider: PROVIDER, model: MODEL } }),
	);
	assert.match(fellBack, /backup\/backup-model/);
	assert.match(fellBack, /fallback after/);
});
