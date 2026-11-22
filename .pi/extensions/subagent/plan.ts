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
//     own: within this change the finaliser is the only place that knows a step
//     ended, so it calls
//     `settlePlanStep` exactly once per settled run.
//   - `settlePlanStep` is IDEMPOTENT by construction. It only acts when the
//     step is still `running` and the settling run is the step's LATEST attempt.
//     A replayed settlement, a late duplicate from a reload, or a second call
//     for an older attempt is a no-op, so nothing can be launched twice.
//   - Retry identity is a NEW RUN with a new id, not the same run restarted.
//     Each attempt therefore gets its own run dir, report and usage, and the
//     plan records every attempt's id in `runIds` while `attempts`/`retries`
//     make the cap visible. Restarting one run would have had to rewrite a
//     settled run record and could not report per-attempt usage.
//   - `stop` is fail-fast, not a cancel cascade: no further step STARTS. Steps
//     that never started are cancelled, and `index.ts` abandons their queued
//     runs; children already running are left alone (cancelling live children
//     is ticket 06's cascade). The plan's terminal state is `failed` at the
//     moment the policy stops it, and a live step that finishes later still has
//     its own status recorded truthfully.
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
		return {
			id,
			task: spec.task,
			cwd: spec.cwd,
			provider: spec.provider,
			model: spec.model,
			thinking: spec.thinking,
			handoff: spec.handoff,
			trusted: spec.trusted,
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
		return resolve(plan, at);
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
	const advance = resolve(plan, now);
	advance.cancelled = [...cancelled, ...advance.cancelled];
	return advance;
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

/** Cancel `failedId`'s dependents, and their dependents, transitively. */
function cancelDependents(plan: PlanRecord, failedId: string, now: number): string[] {
	const blocked = new Set<string>([failedId]);
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
 */
function resolve(plan: PlanRecord, now: number): PlanAdvance {
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
