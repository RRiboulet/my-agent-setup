/**
 * The orchestration role of this process: is it the parent that owns a run, or a
 * delegated worker that must never act on that run's behalf?
 *
 * **Why the role is resolved once, at module load.** It used to be read at every
 * call site (`inChildSession()` reading `PI_TMUX_SUBAGENT_CHILD`), and the
 * subagent extension's factory reads that variable and then deletes it from
 * `process.env` so a `pi` spawned from a child's shell tool cannot re-enter child
 * mode on the same result file. Extension factories run before any session event,
 * so by the first `agent_before_settle` the variable was gone, the gate treated a
 * child as a parent, and the child ran the project's verification command and
 * blocked its own settlement — stalling the delegation its parent was waiting on.
 * A process does not change role mid-run: resolving it into the constant below
 * means no later `delete process.env…` (by this extension or another) can change
 * the answer.
 *
 * **Why the marker is separate from `PI_TMUX_SUBAGENT_CHILD`.** That variable is
 * the subagent extension's own switch for child mode, and it is deliberately
 * scrubbed from the environment. Scrubbing it must not also erase "this process
 * is a worker", because the launcher solved a different problem (nested `pi`
 * re-entry) than the gate does (who owns the run's decisions). `PI_ORCHESTRATOR_ROLE`
 * is written by the launcher as a literal in the child command, so it arrives
 * with the child's environment and nothing needs to read it twice.
 *
 * The legacy `PI_TMUX_SUBAGENT_CHILD=1` marker is still honoured, so a child
 * launched by a build that predates the role marker stays guarded. That
 * fallback is read at module load too, so it depends on this extension loading
 * before the subagent factory scrubs the legacy variable; the documented marker
 * above has no such ordering requirement and is what current launchers write.
 */

/** Who owns this run's decisions. */
export type OrchestratorRole = "parent" | "worker";

/** The documented role marker; the launcher writes it as a literal. */
const ROLE_ENV = "PI_ORCHESTRATOR_ROLE";
/** The legacy child marker, honoured as a fallback. */
const LEGACY_CHILD_ENV = "PI_TMUX_SUBAGENT_CHILD";

/**
 * Resolve a role from an environment. Pure: it reads the object it is given and
 * nothing else, so a caller can ask "what would this environment be?" and a test
 * need not mutate `process.env`.
 */
export function resolveOrchestratorRole(env: NodeJS.ProcessEnv = process.env): OrchestratorRole {
	const named = env[ROLE_ENV]?.trim().toLowerCase();
	if (named === "worker") return "worker";
	if (env[LEGACY_CHILD_ENV] === "1") return "worker";
	return "parent";
}

/**
 * This process's role, read ONCE at module load. Never re-read: a later scrub of
 * the environment (the subagent factory does exactly that) must not turn a
 * worker back into a parent.
 */
export const ORCHESTRATOR_ROLE: OrchestratorRole = resolveOrchestratorRole();

/** True for a delegated worker, which reports and never acts. */
export function isWorkerRole(role: OrchestratorRole = ORCHESTRATOR_ROLE): boolean {
	return role === "worker";
}
