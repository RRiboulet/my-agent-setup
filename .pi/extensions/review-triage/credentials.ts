/**
 * Provider-credential check.
 *
 * The gap this closes: a configured candidate whose provider has no credential
 * is dropped by the `available` filter in {@link generateCatalog}, with only a
 * per-band note, and an agent that reads `candidates` directly (as `AGENTS.md`
 * tells it to) sees no filtering at all. The failure then arrives much later as
 * `No API key found for <provider>` from a subagent, after the plan has already
 * named the model. The judge has the same problem one step earlier: asking it
 * without an OpenCode credential spends a round trip to learn what pi already
 * knows.
 *
 * So the policy's providers are checked up front and the result is data:
 *
 *   - a candidate whose provider has no credential is not offered, and the
 *     reason travels into the plan's limitations as an actionable sentence;
 *   - a missing judge credential short-circuits the request and is reported as
 *     `judgeFailure: { kind: "unavailable" }`, reusing the existing failure
 *     kind rather than inventing a second one;
 *   - when every reviewer provider is missing, the catalog is empty and policy
 *     already reports `unavailable` for each track — never a fictional model.
 *
 * Nothing here is hard-failed: a machine that can still run at least one band
 * gets a plan from it, marked with the gap, which follows the extension's
 * existing "degrade loudly, do not brick the tool call" philosophy.
 *
 * The auth source is injected so this module stays pure and the tests never
 * read real credentials. `authSourceFromRegistry` is the production adapter;
 * pi resolves the status without exposing the secret.
 */

import type { Candidate, JudgeConfig } from "./config.ts";

/** What pi knows about a provider's credentials — no secret, only availability. */
export interface ProviderAuth {
	configured: boolean;
	source?: string;
	label?: string;
}

/**
 * Ask whether a provider can authenticate. `undefined` means "unknown" — a
 * provider extension may authenticate in a way pi's status cannot see, so an
 * unknown status is treated as usable. A false "missing credentials" must not
 * disable a working setup.
 */
export type AuthSource = (provider: string) => ProviderAuth | undefined;

/** The structural slice of `ctx.modelRegistry` this check needs. */
export interface AuthStatusRegistry {
	getProviderAuthStatus?(provider: string): ProviderAuth;
}

/**
 * The production auth source. It only reports readiness; it never reads
 * `auth.json` or an API key itself, so nothing here can log or carry a secret.
 *
 * pi's own status covers a stored `auth.json` credential, a runtime `--api-key`
 * and the environment as it stood at startup. That last part is why the live
 * environment is consulted as well: this extension may load a key from its
 * `.env` during the run (`applyDotEnv`), after pi built its availability
 * snapshot, and blocking a judge whose key is actually present would be worse
 * than the silent band drop this check replaces.
 */
export function authSourceFromRegistry(
	registry: AuthStatusRegistry,
	env: NodeJS.ProcessEnv = process.env,
): AuthSource {
	return (provider) => {
		let status: ProviderAuth | undefined;
		if (typeof registry.getProviderAuthStatus === "function") {
			try {
				status = registry.getProviderAuthStatus(provider);
			} catch {
				// Status resolution is a convenience, never a gate on the run. An
				// extension/provider that throws here leaves the provider unknown,
				// which the caller treats as usable.
				status = undefined;
			}
		}
		if (status?.configured) return status;
		const envVar = providerEnvVar(provider);
		if (env[envVar]?.trim()) return { configured: true, source: "environment", label: envVar };
		// `false` means pi is sure the provider has no credential; `undefined`
		// means it could not tell, which the caller treats as usable.
		return status;
	};
}

/** The environment variable pi reads for a provider whose key is not in auth.json. */
export const PROVIDER_ENV_VARS: Readonly<Record<string, string>> = {
	openrouter: "OPENROUTER_API_KEY",
	// The judge runs on OpenCode Zen, the reviewers on the Go endpoint; one
	// OpenCode key authenticates both, so `opencode-go` costs no extra credential.
	opencode: "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
};

/** `OPENROUTER_API_KEY` for `openrouter`, `OPENCODE_API_KEY` for either OpenCode provider, and a
 * predictable fallback for anything else. */
export function providerEnvVar(provider: string): string {
	const known = PROVIDER_ENV_VARS[provider];
	if (known) return known;
	return `${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_API_KEY`;
}

/** The one-line fix, naming both routes pi accepts. */
export function credentialFix(provider: string): string {
	return (
		`set ${providerEnvVar(provider)}, run /login for ${provider}, or add "${provider}" ` +
		"to auth.json in the pi agent directory (~/.pi/agent by default, or $PI_CODING_AGENT_DIR in a container)"
	);
}

/** A provider the configured policy cannot use, with what is missing and how to fix it. */
export interface CredentialGap {
	role: "judge" | "reviewer";
	provider: string;
	/** `provider/model` refs the gap blocks. */
	models: string[];
	/** Actionable sentence naming the provider, the models and the fix. */
	message: string;
}

export interface CredentialReport {
	/** The candidates that can run; the configured list with gaps removed. */
	candidates: Candidate[];
	gaps: CredentialGap[];
	/** Set when the judge's provider has no credential. */
	judgeGap?: CredentialGap;
}

function usable(auth: AuthSource, provider: string): boolean {
	const status = auth(provider);
	return status === undefined || status.configured;
}

/**
 * Check every provider the policy names. Gaps are grouped per provider, in the
 * order the providers first appear, so one missing provider is one sentence
 * rather than one per model.
 */
export function credentialReport(args: {
	judge: Pick<JudgeConfig, "provider" | "model">;
	candidates: readonly Candidate[];
	auth: AuthSource;
}): CredentialReport {
	const gaps: CredentialGap[] = [];
	let judgeGap: CredentialGap | undefined;

	if (!usable(args.auth, args.judge.provider)) {
		const model = `${args.judge.provider}/${args.judge.model}`;
		judgeGap = {
			role: "judge",
			provider: args.judge.provider,
			models: [model],
			message: `no credentials for provider "${args.judge.provider}", so judge model ${model} cannot run: ${credentialFix(args.judge.provider)}`,
		};
		gaps.push(judgeGap);
	}

	const kept: Candidate[] = [];
	const reviewerGaps = new Map<string, CredentialGap>();
	for (const candidate of args.candidates) {
		if (usable(args.auth, candidate.provider)) {
			kept.push(candidate);
			continue;
		}
		const model = `${candidate.provider}/${candidate.model}`;
		const existing = reviewerGaps.get(candidate.provider);
		if (existing) {
			existing.models.push(model);
			continue;
		}
		const gap: CredentialGap = {
			role: "reviewer",
			provider: candidate.provider,
			models: [model],
			message: "",
		};
		reviewerGaps.set(candidate.provider, gap);
		gaps.push(gap);
	}
	for (const gap of reviewerGaps.values()) {
		gap.message =
			`no credentials for provider "${gap.provider}", so reviewer model(s) ` +
			`${gap.models.join(", ")} cannot run and their bands are not offered: ` +
			credentialFix(gap.provider);
	}

	return { candidates: kept, gaps, ...(judgeGap ? { judgeGap } : {}) };
}
