/**
 * Provider-credential lookup for orchestrator callers (such as `advisor`).
 *
 * The auth source is injected so callers stay pure and tests never read real
 * credentials. `authSourceFromRegistry` is the production adapter: pi resolves
 * availability without exposing the secret.
 */

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
 * pi's own status covers a stored `auth.json` credential, a runtime `--api-key`,
 * and the environment as it stood at startup. The live environment is also
 * consulted so a key loaded after startup is still recognized.
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
	// One OpenCode key authenticates both OpenCode Zen (`opencode`) and Go (`opencode-go`).
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
