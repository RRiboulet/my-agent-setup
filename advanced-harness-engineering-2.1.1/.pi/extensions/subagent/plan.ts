// Dependency plans for the `subagent` tool's fan-out surface.
//
// One request can launch several children. `tasks` is the canonical shape, and
// an item without `dependsOn` is simply a fan-out step with no edges, so there
// is one validation path and one plan record whether the caller declared a
// dependency graph or not. The older single `task` parameter is retained as
// sugar for a one-step, edge-free request because it is the standalone contract
// that every existing caller and test already uses.
//
// This module is deliberately PURE and structural: it knows step ids, edges,
// statuses and attempts, and nothing about tmux, run ids, `RunRecord` or the
// filesystem. `index.ts` owns the runs, resolves a step's launch arguments, and
// is the only place that starts anything. The split is what makes the readiness,
// cycle, retry and policy rules testable without a watcher or a tmux server.
//
// The advance design, stated once because every later ticket builds on it:
//
//   - A settlement comes from the EXISTING settle path (`finalizeRun` /
//     `markRunFailed`). There is no scheduler process and no polling loop of its
//     own. THREE places know a step ended, and they are named here because a
//     fourth one invented in passing is how a plan gets wedged:
//       1. the settle path, which calls `settlePlanStep` once per settled run;
//       2. the cancel path (`subagent_cancel`), which calls `cancelPlanStep` for
//          a cancelled step's run and `cancelPlan` for a whole plan — a cancel
//          produces no `result.json`, so the finaliser never sees it;
//       3. load-time reconciliation (`reconcilePlan`), one shot, for what a
//          reload missed: a settlement or a launch that landed in the run index
//          and not (yet) in the plan index.
//     Nothing else may settle a step.
//   - Every one of those is IDEMPOTENT by construction. `settlePlanStep` only
//     acts when the step is still `running` and the settling run is the step's
//     LATEST attempt; cancellation has the same guard; `reconcilePlan` adopts a
//     run the plan has no record of instead of launching a second attempt. A
//     replayed settlement, a late duplicate from a reload, a double-load or a
//     call for an older attempt is a no-op, so nothing can be launched twice.
//   - Retry identity is a NEW RUN with a new id, not the same run restarted.
//     Each attempt therefore gets its own run dir, report and usage, and the
//     plan records every attempt's id in `runIds` while `attempts`/`retries`
//     make the cap visible. Restarting one run would have had to rewrite a
//     settled run record and could not report per-attempt usage.
//   - `stop` is fail-fast, not a cancel cascade: no further step STARTS. Steps
//     that never started are cancelled, and `index.ts` abandons their queued
//     runs; children already running are left alone. The plan's terminal state
//     is `failed` at the moment the policy stops it, and a live step that
//     finishes later still has its own status recorded truthfully.
//   - Cancellation is the second settlement source, and it answers two
//     questions at once. `cancelPlanStep` (one step's run was cancelled) follows
//     the policy: `continue` keeps independent branches running and cancels only
//     the cancelled step's TRANSITIVE DEPENDENTS, which can never run now;
//     `stop` starts nothing further and ends the plan as `cancelled` (a
//     deliberate cancel is not a failure). `cancelPlan` (the whole plan) cancels
//     every live and pending step, keeps completed and failed step records
//     untouched, and ends the plan as `cancelled`.
//     A dependent of a cancelled step is cancelled rather than left `pending`
//     even under `continue`: `pending` would claim something will launch it,
//     nothing ever can, and the plan could then never become terminal. That is
//     the same rule `continue` already applies to the dependents of a FAILED
//     step, so cancellation and failure agree about blocked work.
//   - `continue` marks the failed step failed, cancels only the steps that
//     transitively depend on a failure, and keeps launching every independent
//     branch as its own dependencies complete. The plan is terminal only once
//     no step is running or pending.
//
// The policy default is `continue`: the base case is a plain fan-out with no
// edges, where one child failing must not abandon unrelated children. A caller
// that wants fail-fast plan semantics asks for `stop` explicitly.

export type FailurePolicy = "stop" | "continue";
export type PlanStatus = "running" | "completed" | "failed" | "cancelled";
export type PlanStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * One requested step, with its launch arguments already resolved by the tool.
 *
 * Resolution happens once, at plan creation: the model/provider defaults belong
 * to the request that made them, and a plan reloaded later must relaunch with
 * the same arguments rather than whatever the parent happens to be using then.
 */
export interface PlanStepSpec {
	/** Explicit id, or omitted to receive `step-<n>` in request order. */
	id?: string;
	task: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** `standalone` | `lineage` | `fork`; kept as a string so this module stays free of launch types. */
	handoff: string;
	trusted: boolean;
	role?: string;
	tools?: string[];
	skills?: string[];
	dependsOn?: string[];
	/** Retries allowed AFTER the first attempt. `0` means one attempt total. */
	retries?: number;
}

export interface PlanOptions {
	/** What a permanently failed step does to the rest of the plan. */
	policy?: FailurePolicy;
	/** Default retry cap for steps that do not set their own. */
	retryLimit?: number;
}

export interface PlanStepState {
	id: string;
	task: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	handoff: string;
	trusted: boolean;
	role?: string;
	tools?: string[];
	skills?: string[];
	dependsOn: string[];
	/** Effective retry cap, always recorded so the plan shows the limit it used. */
	retries: number;
	/** Attempts STARTED, so a launch that fails still consumes budget. */
	attempts: number;
	status: PlanStepStatus;
	/** One run id per attempt, oldest first. The last is the current attempt. */
	runIds: string[];
	error?: string;
	startedAt?: number;
	finishedAt?: number;
}

export interface PlanRecord {
	id: string;
	policy: FailurePolicy;
	status: PlanStatus;
	createdAt: number;
	finishedAt?: number;
	/**
	 * Why the plan ended as it did, in one line: the step and error that stopped
	 * a `stop` plan, the cancellation, or the reconciliation note. The reason is
	 * the ONLY place a stop reason reaches the caller — the error that caused it
	 * lives on a run this module never sees — so it is part of the report surface
	 * (status, wait) and not a debugging aid.
	 */
	reason?: string;
	/** In the order the caller requested, which is the order results are returned in. */
	steps: PlanStepState[];
}

export type PlanBuild = { ok: true; plan: PlanRecord } | { ok: false; error: string };

/**
 * What the settle path must do after a settlement, as data.
 *
 * `launch` names steps that are ready NOW and must be started by the caller;
 * `cancelled` names steps the policy has just cancelled, whose queued runs (if
 * any) must be abandoned; `stop` says the plan failed under the stop policy, so
 * the caller must also abandon any queued run belonging to a step left
 * `running`. Doing the run-side work in `index.ts` keeps this module unable to
 * start or cancel anything by itself.
 */
export interface PlanAdvance {
	changed: boolean;
	launch: string[];
	stop: boolean;
	cancelled: string[];
	terminal?: PlanStatus;
}

export interface PlanSettlement {
	stepId: string;
	runId: string;
	outcome: "completed" | "failed";
	error?: string;
	at?: number;
}

/**
 * One run a plan's step has, as reconciliation sees it.
 *
 * `status` is a string for the same reason `PlanStepSpec.handoff` is: this module
 * stays free of the run record and of launch types. `createdAt` orders attempts
 * the plan index did not record, so adoption appends them in the order they ran.
 */
export interface PlanStepRun {
	runId: string;
	status: string;
	error?: string;
	createdAt?: number;
}

/** What load-time reconciliation did, and why. */
export interface PlanReconcile {
	advance: PlanAdvance;
	/** One line per step it had to reconcile, for the caller's log and for tests. */
	recovered: string[];
}

/** What cancelling a whole plan did. */
export interface PlanCancel {
	changed: boolean;
	/** Steps that still had a live attempt: the caller must cancel their runs. */
	live: string[];
	/** Steps this cancellation moved to `cancelled`, in plan order. */
	cancelled: string[];
}

const NON_NEGATIVE_INT = /^\d+$/;

/** Validate and materialise a plan, rejecting every graph defect before a run exists. */
export function buildPlan(id: string, specs: PlanStepSpec[], options: PlanOptions = {}, now = Date.now()): PlanBuild {
	if (specs.length === 0) return { ok: false, error: "A plan needs at least one step." };
	if (!id.trim()) return { ok: false, error: "A plan needs an id." };

	const policy = options.policy ?? "continue";
	const retryLimit = options.retryLimit ?? 0;
	if (policy !== "stop" && policy !== "continue") {
		return { ok: false, error: `Unknown failure policy: ${String(policy)}` };
	}
	if (!isNonNegativeInt(retryLimit)) {
		return { ok: false, error: "retryLimit must be a non-negative whole number." };
	}

	const steps: PlanStepState[] = specs.map((spec, index) => {
		const id = spec.id?.trim() || `step-${index + 1}`;
		const role = spec.role?.trim() || undefined;
		const tools = spec.tools
			?.filter((tool): tool is string => typeof tool === "string")
			.map((tool) => tool.trim())
			.filter((tool) => tool.length > 0);
		const rawSkills = spec.skills
			?.filter((skill): skill is string => typeof skill === "string")
			.map((skill) => skill.trim())
			.filter((skill) => skill.length > 0);
		const skills = rawSkills && rawSkills.length > 0 ? [...new Set(rawSkills)] : undefined;
		return {
			id,
			task: spec.task,
			cwd: spec.cwd,
			provider: spec.provider,
			model: spec.model,
			thinking: spec.thinking,
			handoff: spec.handoff,
			trusted: spec.trusted,
			...(role ? { role } : {}),
			...(tools && tools.length > 0 ? { tools } : {}),
			...(skills ? { skills } : {}),
			dependsOn: [...new Set((spec.dependsOn ?? []).map((dep) => dep.trim()))],
			retries: spec.retries ?? retryLimit,
			attempts: 0,
			status: "pending",
			runIds: [],
		};
	});

	const seen = new Map<string, PlanStepState>();
	for (const step of steps) {
		if (!step.task.trim()) return { ok: false, error: `Step "${step.id}" has an empty task.` };
		const existing = seen.get(step.id);
		if (existing) return { ok: false, error: `Duplicate step id "${step.id}" in one plan.` };
		seen.set(step.id, step);
		if (!isNonNegativeInt(step.retries)) {
			return { ok: false, error: `Step "${step.id}" has an invalid retry cap.` };
		}
	}

	for (const step of steps) {
		for (const dep of step.dependsOn) {
			if (!dep) return { ok: false, error: `Step "${step.id}" lists an empty dependency.` };
			if (dep === step.id) return { ok: false, error: `Step "${step.id}" depends on itself.` };
			if (!seen.has(dep)) {
				return { ok: false, error: `Step "${step.id}" depends on unknown step "${dep}".` };
			}
		}
	}

	const cycle = findCycle(steps);
	if (cycle) {
		return { ok: false, error: `Dependency cycle: ${cycle.join(" -> ")}.` };
	}

	return {
		ok: true,
		plan: { id, policy, status: "running", createdAt: now, steps },
	};
}

/**
 * Steps whose dependencies have ALL completed successfully, in request order.
 *
 * A step with no edges is ready immediately, which is how plain fan-out is just
 * a plan with no edges. An unknown dependency cannot reach here (buildPlan
 * rejected it), and a cancelled/failed/running dependency is not `completed`, so
 * it never makes its dependents ready.
 */
export function readyStepIds(plan: PlanRecord): string[] {
	const byId = new Map(plan.steps.map((step) => [step.id, step]));
	return plan.steps
		.filter((step) => step.status === "pending")
		.filter((step) => step.dependsOn.every((dep) => byId.get(dep)?.status === "completed"))
		.map((step) => step.id);
}

/**
 * Record that a step's next attempt has started, BEFORE its run does any I/O.
 *
 * Called by the launch path as soon as the run id exists. Counting the attempt
 * here rather than on success means an attempt that dies while creating its run
 * directory still consumes budget, so a broken launch cannot retry forever, and
 * `runIds` stays one entry per attempt.
 */
export function markStepLaunched(plan: PlanRecord, stepId: string, runId: string, now = Date.now()): boolean {
	const step = plan.steps.find((candidate) => candidate.id === stepId);
	if (!step || plan.status !== "running" || step.status !== "pending") return false;
	step.status = "running";
	step.attempts += 1;
	step.startedAt ??= now;
	step.finishedAt = undefined;
	step.runIds.push(runId);
	return true;
}

/**
 * Reduce one settled run into the plan.
 *
 * The guard is the idempotency rule: only the step's LATEST running attempt can
 * settle it. Anything else — a duplicate call, a stale attempt, a step already
 * failed by policy — returns `changed: false` and launches nothing.
 */
export function settlePlanStep(plan: PlanRecord, settlement: PlanSettlement): PlanAdvance {
	const step = plan.steps.find((candidate) => candidate.id === settlement.stepId);
	const at = settlement.at ?? Date.now();
	if (!step || step.status !== "running" || step.runIds.at(-1) !== settlement.runId) {
		return noAdvance();
	}
	if (settlement.outcome === "completed") {
		step.status = "completed";
		step.error = undefined;
		step.finishedAt = at;
		return resolvePlan(plan, at);
	}
	return failPlanStep(plan, step.id, settlement.error ?? "The step failed.", at);
}

/**
 * Fail a step that was recorded as running but has no settlement to report —
 * today, a launch that threw before `startRun` could register the run.
 *
 * Exported separately so the caller does not have to fabricate a run id: the
 * attempt was already counted by `markStepLaunched`, so the retry cap still
 * bounds how many times a broken launch may be retried.
 */
export function failPlanStep(plan: PlanRecord, stepId: string, error: string, now = Date.now()): PlanAdvance {
	const step = plan.steps.find((candidate) => candidate.id === stepId);
	if (!step || step.status !== "running") return noAdvance();
	return failPlanStepRecord(plan, step, error, now);
}

function failPlanStepRecord(plan: PlanRecord, step: PlanStepState, error: string, now: number): PlanAdvance {
	step.error = error;
	// A plan already stopped by policy has no budget left to spend: a late
	// failure from a child that was already running is recorded, not retried.
	const retryable = plan.status === "running" && step.attempts > 0 && step.attempts <= step.retries;

	if (retryable) {
		// Retry is a NEW run (see the header): put the step back to pending and
		// let the caller launch the next attempt with a fresh run id.
		step.status = "pending";
		step.finishedAt = undefined;
		return { changed: true, launch: [step.id], stop: false, cancelled: [] };
	}

	step.status = "failed";
	step.finishedAt = now;
	// Recorded for BOTH policies, and even while the plan keeps running: the error
	// lives on a run this module never sees, so the plan's reason is the only
	// place a caller can read why a branch is dead (finding 4 from ticket 05).
	plan.reason ??= `Step "${step.id}" failed: ${firstLine(error)}`;

	if (plan.status !== "running") {
		// Late settlement after a terminal plan: record the step, change nothing
		// else. In particular a second failure must not re-run the stop policy.
		return { changed: true, launch: [], stop: false, cancelled: [] };
	}

	if (plan.policy === "stop") {
		const cancelled = cancelPending(plan, now);
		plan.status = "failed";
		plan.finishedAt = now;
		return { changed: true, launch: [], stop: true, cancelled, terminal: "failed" };
	}

	// `continue`: a dependent can never run once a dependency has failed, so
	// those steps are cancelled transitively. Independent branches are untouched
	// and are launched as soon as their own dependencies are all completed.
	const cancelled = cancelDependents(plan, step.id, now);
	const advance = resolvePlan(plan, now);
	advance.cancelled = [...cancelled, ...advance.cancelled];
	return advance;
}

/**
 * One step's run was cancelled: record the step, then follow the policy.
 *
 * The cancel counterpart of `settlePlanStep`, and the second place that knows a
 * step ended (see the header): `subagent_cancel` produces no `result.json`, so
 * the finaliser can never learn about it, and a plan whose only live step was
 * cancelled would otherwise sit `running` with a `running` step forever.
 *
 * `stop` ends the plan as `cancelled` — not `failed`: the caller asked for this,
 * and no step failed. `continue` cancels the cancelled step's transitive
 * DEPENDENTS, which can never run now, and lets independent branches finish; the
 * plan becomes terminal once nothing is live, which is how a `continue` plan
 * with one step stops being wedged.
 */
export function cancelPlanStep(plan: PlanRecord, stepId: string, reason: string, now = Date.now()): PlanAdvance {
	const step = plan.steps.find((candidate) => candidate.id === stepId);
	if (!step || step.status !== "running") return noAdvance();
	step.status = "cancelled";
	step.error = reason;
	step.finishedAt = now;
	// Like a failure, the reason is recorded whether or not this ends the plan: a
	// cancelled branch of a `continue` plan still has to say why it stopped.
	plan.reason ??= `Cancelled: step "${step.id}" was cancelled.`;

	// A plan already stopped by policy has no budget left: a late cancel of a
	// child it abandoned is recorded, and changes nothing else.
	if (plan.status !== "running") {
		return { changed: true, launch: [], stop: false, cancelled: [] };
	}

	if (plan.policy === "stop") {
		const cancelled = cancelPending(plan, now);
		plan.status = "cancelled";
		plan.finishedAt = now;
		return { changed: true, launch: [], stop: false, cancelled, terminal: "cancelled" };
	}

	const cancelled = cancelDependents(plan, stepId, now);
	const advance = resolvePlan(plan, now);
	advance.cancelled = [...cancelled, ...advance.cancelled];
	return advance;
}

/**
 * Cancel a whole plan: every live attempt and every step that has not started.
 *
 * Completed and failed steps keep their records — a cancellation says nothing
 * about work that already finished, and their run ids, attempts and errors stay
 * truthful. The steps returned in `live` still have a run for the caller to
 * kill; this module can neither start nor stop anything.
 */
export function cancelPlan(plan: PlanRecord, reason: string, now = Date.now()): PlanCancel {
	const live: string[] = [];
	const cancelled: string[] = [];
	for (const step of plan.steps) {
		if (step.status === "running") live.push(step.id);
		if (step.status === "running" || step.status === "pending") {
			step.status = "cancelled";
			// Overwritten, not defaulted: a step retried after an earlier failure still
			// carries that attempt's error, and the cancellation is the reason it ended.
			step.error = reason;
			step.finishedAt = now;
			cancelled.push(step.id);
		}
	}
	const wasRunning = plan.status === "running";
	if (wasRunning) {
		plan.status = "cancelled";
		plan.finishedAt = now;
		plan.reason ??= reason;
	}
	return { changed: wasRunning || cancelled.length > 0, live, cancelled };
}

/**
 * Reconcile a plan against the runs that actually exist, once, after a load.
 *
 * The two indexes are written as two renames under one chain, so a crash between
 * them leaves a run index NEWER than the plan index. The plan is therefore the
 * record that can be behind, and reconciliation works in that direction only:
 *
 *   - a run the plan has no record of is ADOPTED (its id appended to the step's
 *     attempts), never launched a second time;
 *   - a `running` step is settled from its latest run when that run is already
 *     terminal (completed / failed / cancelled), because the crash swallowed the
 *     plan half of a settlement the run half had written;
 *   - a step whose latest run is `queued`, `running` or `interrupted` is LEFT
 *     ALONE. Those are exactly the statuses whose child can outlive the parent
 *     reload, and the watcher re-arms for them on load; treating one as orphaned
 *     would relaunch live work or abandon it. Only a step with NO live run — no
 *     record at all — is reconciled as interrupted;
 *   - an orphaned attempt (no run record, e.g. a run dir pruned) is reported as
 *     `failed` with an interruption reason and then follows the ordinary failure
 *     policy, which is what may retry it if the budget allows. It is never
 *     reported as complete;
 *   - finally the plan is re-resolved, so a step that is ready now is launched
 *     and a plan that has nothing live becomes terminal.
 *
 * Idempotent against the settle path: every reduction here goes through
 * `settlePlanStep` / `cancelPlanStep` / `failPlanStep`, each of which refuses a
 * step that is no longer `running` or a run that is not the latest attempt, and
 * the launch list is only a request — `index.ts` launches a step only while it
 * is still `pending`.
 */
export function reconcilePlan(
	plan: PlanRecord,
	runsByStep: Record<string, PlanStepRun[]>,
	now = Date.now(),
): PlanReconcile {
	const recovered: string[] = [];
	let advance: PlanAdvance = noAdvance();
	const absorb = (next: PlanAdvance): void => {
		if (!next.changed) return;
		const terminal = next.terminal ?? advance.terminal;
		advance = {
			changed: true,
			launch: [...new Set([...advance.launch, ...next.launch])],
			stop: advance.stop || next.stop,
			cancelled: [...new Set([...advance.cancelled, ...next.cancelled])],
			...(terminal ? { terminal } : {}),
		};
	};

	const runsById = new Map<string, PlanStepRun>();
	for (const runs of Object.values(runsByStep)) {
		for (const run of runs) runsById.set(run.runId, run);
	}

	for (const step of plan.steps) {
		if (step.status !== "running" && step.status !== "pending") continue;

		// A run the plan does not mention: the plan index is older than the run
		// index. Adopt the attempt instead of launching a second one for the same
		// step, which would be the duplicate work R23 forbids.
		const extra = (runsByStep[step.id] ?? [])
			.filter((run) => !step.runIds.includes(run.runId))
			.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
		if (extra.length > 0) {
			step.runIds.push(...extra.map((run) => run.runId));
			step.attempts = Math.max(step.attempts, step.runIds.length);
			step.startedAt ??= extra[0]?.createdAt ?? now;
			step.finishedAt = undefined;
			step.status = "running";
			recovered.push(`step ${step.id}: adopted ${extra.length} run(s) the plan had not recorded`);
		}

		// A step that never launched stays pending; `resolvePlan` below is what
		// decides whether it is ready.
		if (step.status === "pending") continue;

		const latestId = step.runIds.at(-1);
		const latest = latestId ? runsById.get(latestId) : undefined;
		if (!latest) {
			const error = `Interrupted: the session ended while step "${step.id}" was running and no live run remains.`;
			absorb(failPlanStep(plan, step.id, error, now));
			recovered.push(`step ${step.id}: no live run, reported ${step.status}`);
			continue;
		}
		if (latest.status === "completed") {
			absorb(settlePlanStep(plan, { stepId: step.id, runId: latest.runId, outcome: "completed", at: now }));
			recovered.push(`step ${step.id}: completed run ${latest.runId} folded in`);
			continue;
		}
		if (latest.status === "failed") {
			absorb(settlePlanStep(plan, { stepId: step.id, runId: latest.runId, outcome: "failed", error: latest.error, at: now }));
			recovered.push(`step ${step.id}: failed run ${latest.runId} folded in`);
			continue;
		}
		if (latest.status === "cancelled") {
			absorb(
				cancelPlanStep(plan, step.id, `Cancelled: step "${step.id}"'s run was cancelled before the reload.`, now),
			);
			recovered.push(`step ${step.id}: cancelled run ${latest.runId} folded in`);
			continue;
		}
		// queued | running | interrupted: the child may still be alive, so the step
		// is left running on purpose. The watcher re-arms for the run on load.
		// Nothing was recovered, so nothing is reported: a healthy reload is silent.
	}

	if (plan.status === "running") {
		// `resolvePlan` reports a reduction as a change because it is normally
		// called right after one; here it is called on its own, so only work it
		// actually does — a launch or a terminal plan — counts.
		const resolved = resolvePlan(plan, now);
		if (resolved.launch.length > 0 || resolved.terminal !== undefined) absorb(resolved);
	}
	return { advance, recovered };
}

/** Everything still pending after a stop is abandoned: no further step starts. */
function cancelPending(plan: PlanRecord, now: number): string[] {
	const cancelled: string[] = [];
	for (const step of plan.steps) {
		if (step.status !== "pending") continue;
		step.status = "cancelled";
		step.finishedAt = now;
		cancelled.push(step.id);
	}
	return cancelled;
}

/**
 * Cancel `blockedId`'s dependents, and their dependents, transitively.
 *
 * Shared by the failure and the cancellation paths: once a step has failed or
 * been cancelled, a step that depends on it can never become `readyStepIds` — it
 * is not `pending` in the plan's future in any sense — so leaving it pending
 * would keep the plan from ever becoming terminal.
 */
function cancelDependents(plan: PlanRecord, blockedId: string, now: number): string[] {
	const blocked = new Set<string>([blockedId]);
	const cancelled: string[] = [];
	let grew = true;
	while (grew) {
		grew = false;
		for (const step of plan.steps) {
			if (step.status !== "pending" || blocked.has(step.id)) continue;
			if (!step.dependsOn.some((dep) => blocked.has(dep))) continue;
			step.status = "cancelled";
			step.finishedAt = now;
			blocked.add(step.id);
			cancelled.push(step.id);
			grew = true;
		}
	}
	return cancelled;
}

/**
 * Compute what is ready and whether the plan is over, without changing step
 * statuses beyond what the caller already set.
 *
 * Exported because load-time reconciliation ends with it: after folding what a
 * reload missed, the plan may have a ready step to launch or be finished with
 * nothing left to wait for.
 */
export function resolvePlan(plan: PlanRecord, now = Date.now()): PlanAdvance {
	const launch = plan.status === "running" ? readyStepIds(plan) : [];
	const live = plan.steps.some((step) => step.status === "running" || step.status === "pending");
	if (plan.status !== "running" || live) {
		return { changed: true, launch, stop: false, cancelled: [] };
	}
	const failed = plan.steps.some((step) => step.status === "failed");
	const cancelled = plan.steps.some((step) => step.status === "cancelled");
	plan.status = failed ? "failed" : cancelled ? "cancelled" : "completed";
	plan.finishedAt = now;
	return { changed: true, launch, stop: false, cancelled: [], terminal: plan.status };
}

/** The steps a caller must cancel the queued runs of after a stop. */
export function queuedStopCandidates(plan: PlanRecord): string[] {
	if (plan.policy !== "stop" || plan.status !== "failed") return [];
	return plan.steps.filter((step) => step.status === "running").map((step) => step.id);
}

function noAdvance(): PlanAdvance {
	return { changed: false, launch: [], stop: false, cancelled: [] };
}

function isNonNegativeInt(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && NON_NEGATIVE_INT.test(String(value));
}

/** The head of a message, for a plan-level reason that must stay one line. */
function firstLine(text: string): string {
	const line = text.split("\n", 1)[0]?.trim() ?? "";
	return line.length <= 160 ? line : `${line.slice(0, 159)}…`;
}

/** Depth-first search with a colour map; returns the cycle path, not just a boolean. */
function findCycle(steps: PlanStepState[]): string[] | undefined {
	const byId = new Map(steps.map((step) => [step.id, step]));
	const colour = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];

	const visit = (id: string): string[] | undefined => {
		const state = colour.get(id) ?? 0;
		if (state === 2) return undefined;
		if (state === 1) {
			const at = stack.indexOf(id);
			return [...stack.slice(at), id];
		}
		colour.set(id, 1);
		stack.push(id);
		for (const dep of byId.get(id)?.dependsOn ?? []) {
			const cycle = visit(dep);
			if (cycle) return cycle;
		}
		stack.pop();
		colour.set(id, 2);
		return undefined;
	};

	for (const step of steps) {
		const cycle = visit(step.id);
		if (cycle) return cycle;
	}
	return undefined;
}
