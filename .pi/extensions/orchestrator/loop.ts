/**
 * The loop breaker's evidence rules, as a pure state machine.
 *
 * R29 asks for **no-progress evidence**, not repetition. Repetition alone is a
 * legitimate workflow here — a model polls `subagent_status` while a child runs,
 * and this repository documents a status command after each edit — so a detector
 * that counted identical calls would fight the two workflows the repository
 * teaches. Two evidence forms are used instead, and both need the *calls to be
 * identical* as well as their *results*:
 *
 *   1. **no-progress**: the same invocation has just produced the same successful
 *      result three times with no successful `edit`/`write` in between, and only
 *      for `edit`/`write`. A shell command is deliberately excluded: its effect
 *      on the filesystem is invisible here (`echo x >> log` mutates and would
 *      look idle), and polling a server through `bash` is the same documented
 *      workflow as polling `subagent_status`. Shell calls are covered by the
 *      repeated-failure rule below, which does not need to see mutations.
 *   2. **repeated failure**: the same invocation has just failed with the same
 *      first error line three times. This one deliberately spans intervening
 *      edits: an edit/test cycle that reproduces one failure is not converging,
 *      and that is exactly the loop a settlement gate cannot see, because the
 *      run never settles.
 *
 * Only `edit`, `write`, `bash` and `powershell` are considered. An observation
 * cannot make progress by definition, so blocking one removes information
 * without breaking a loop — polling a status tool is therefore never a loop
 * here, and a failing poll is where a block would hurt most. A repeated shell
 * call is considered, because a shell is where a model retries the command it
 * just watched fail.
 *
 * The *state* is bounded and in-memory: at most `LOOP_WINDOW` records, no
 * filesystem access per call. The caller records calls and results, asks
 * `evaluateLoop` before a call runs, and enforces the per-turn cap; a persisted
 * budget for the gate as a whole lives in the session log, not here.
 */

/** The invocation-and-result record for one tool call. */
export interface LoopRecord {
	/** Host-assigned call id when available, for exact call/result pairing. */
	toolCallId?: string;
	/** Tool plus a canonical hash of the input; equality means "the same call". */
	signature: string;
	tool: string;
	/** Short human form for the block reason. */
	invocation: string;
	/** Result signature once the call finished; `null` while blocked or running. */
	result: string | null;
	/** First line of an error result, for the repeated-failure rule. */
	error: string | null;
	/** A successful `edit`/`write`: the only progress this detector can observe. */
	mutation: boolean;
}

export interface LoopState {
	records: LoopRecord[];
	blocksTheTurn: number;
}

export interface LoopCall {
	toolCallId?: string;
	tool: string;
	signature: string;
	invocation: string;
}

export interface LoopEvidence {
	kind: "no-progress" | "repeated-failure";
	/** Occurrences of this invocation, including the call being evaluated. */
	count: number;
	tool: string;
	invocation: string;
	signature: string;
	/** First error line for `repeated-failure`; the identical result signature
	 *  for `no-progress`. */
	detail: string;
}

/** Tools whose repetition can be a loop; see the header for why this is narrow. */
export const LOOP_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "bash", "powershell"]);
/**
 * Tools the NO-PROGRESS rule may fire on. Only file mutations: an identical
 * `edit`/`write` that keeps succeeding is provably doing nothing new, while a
 * shell command's mutation is not observable and a shell poll is a workflow.
 */
export const NO_PROGRESS_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);
/** Occurrences, including the current call, that make a repetition a loop. */
export const LOOP_REPEAT_LIMIT = 3;
/** Loop blocks allowed in one turn. The reason names the override. */
export const LOOP_BLOCKS_PER_TURN = 1;
/** Records kept; a budget, not a time window. */
export const LOOP_WINDOW = 40;
/** Longest invocation shown in a reason or a session entry. */
const INVOCATION_LIMIT = 160;

export function createLoopState(): LoopState {
	return { records: [], blocksTheTurn: 0 };
}

export function resetLoopState(state: LoopState): void {
	state.records = [];
	state.blocksTheTurn = 0;
}

/** Called at the start of each turn; the per-turn cap is a turn concept, and
 *  any still-unresolved records from an earlier turn will never finish. */
export function resetLoopTurn(state: LoopState): void {
	state.blocksTheTurn = 0;
	state.records = state.records.filter((record) => record.result !== null);
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** djb2 over UTF-16 code units. Cheap, and a collision can only merge two
 *  different invocations, never split one — the failure mode is one missed
 *  loop, not a false block on unrelated work. */
function hash(text: string): string {
	let value = 5381;
	for (let index = 0; index < text.length; index += 1) {
		value = ((value * 33) ^ text.charCodeAt(index)) >>> 0;
	}
	return value.toString(36);
}

/** Key-order-independent JSON, so the same arguments always hash the same. */
function canonical(value: unknown, depth = 0): string {
	if (depth > 8) return "…";
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`).join(",")}}`;
}

/** Identify a call: the tool, plus a hash of every argument. */
export function loopSignature(tool: string, input: unknown): string {
	const json = canonical(input ?? {});
	return `${tool}|${json.length}|${hash(json)}`;
}

/** Identify a result, so "no new result" is decidable without keeping it. */
export function resultSignature(text: string): string {
	return `${text.length}|${hash(text)}`;
}

/** Short human form of a call, for the block reason and the session entry. */
export function invocationLabel(tool: string, input: unknown): string {
	const record = (input ?? {}) as Record<string, unknown>;
	let detail: string;
	if (tool === "bash" || tool === "powershell") detail = typeof record.command === "string" ? record.command : "";
	else if (tool === "edit" || tool === "write") detail = typeof record.path === "string" ? record.path : "";
	else detail = canonical(input ?? {});
	const collapsed = collapse(detail);
	return collapsed.length > INVOCATION_LIMIT ? `${collapsed.slice(0, INVOCATION_LIMIT)}…` : collapsed;
}

function firstLine(text: string): string {
	return collapse(text.split("\n", 1)[0] ?? "").slice(0, 160);
}

/**
 * Decide whether the call about to run is a loop. Pure: reads the state, does
 * not change it. The caller records the call only when it RUNS: a blocked call is
 * not recorded, so the evidence that justified the block survives, and the
 * per-turn cap — not a result-less record — is what stops a second block in the
 * same turn.
 */
export function evaluateLoop(state: LoopState, call: LoopCall): LoopEvidence | null {
	if (!LOOP_TOOLS.has(call.tool)) return null;
	// Only completed calls are evidence: an unresolved record (still running,
	// downstream-blocked, or superseded) has no result and must neither count as
	// evidence nor disable detection over completed calls.
	const matching = state.records.filter((record) => record.signature === call.signature && record.result !== null);
	if (matching.length < LOOP_REPEAT_LIMIT - 1) return null;

	const previous = matching.slice(-(LOOP_REPEAT_LIMIT - 1));

	// 1. No-progress: identical successful results, and nothing was attempted in
	// between. `mutation` records are only file edits/writes, because a shell
	// command's effect is not observable from the outside.
	const firstIndex = state.records.indexOf(previous[0]!);
	const progressed = state.records
		.slice(firstIndex + 1)
		.some((record) => record.mutation && record.signature !== call.signature);
	const results = previous.map((record) => record.result);
	if (NO_PROGRESS_TOOLS.has(call.tool) && !progressed && results.every((result) => result === results[0])) {
		return {
			kind: "no-progress",
			count: previous.length + 1,
			tool: call.tool,
			invocation: call.invocation,
			signature: call.signature,
			detail: results[0] ?? "",
		};
	}

	// 2. Repeated failure: the same first error line, however many edits sit in
	// between. Counted over the whole window, so the reason can say how long it
	// has been going on.
	const lastError = previous.at(-1)?.error ?? null;
	if (lastError) {
		const sameFailure = state.records.filter(
			(record) => record.signature === call.signature && record.error === lastError,
		);
		if (sameFailure.length >= LOOP_REPEAT_LIMIT - 1) {
			return {
				kind: "repeated-failure",
				count: sameFailure.length + 1,
				tool: call.tool,
				invocation: call.invocation,
				signature: call.signature,
				detail: lastError,
			};
		}
	}

	return null;
}

/** Record a call that is about to run. Bounded: the oldest record is dropped. */
export function recordCall(state: LoopState, call: LoopCall): void {
	state.records.push({
		...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
		signature: call.signature,
		tool: call.tool,
		invocation: call.invocation,
		result: null,
		error: null,
		mutation: false,
	});
	if (state.records.length > LOOP_WINDOW) state.records.splice(0, state.records.length - LOOP_WINDOW);
}

/**
 * Attach the finished result to the matching pending call: by `toolCallId` when
 * provided, falling back to signature only when `toolCallId` is absent. A
 * successful `edit`/`write` is also the progress marker the no-progress rule
 * reads.
 */
export function recordResult(
	state: LoopState,
	call: LoopCall,
	result: { isError: boolean; text: string },
): void {
	const apply = (record: LoopRecord): void => {
		record.result = resultSignature(result.text);
		record.error = result.isError ? firstLine(result.text) : null;
		record.mutation = !result.isError && (call.tool === "edit" || call.tool === "write");
	};
	if (call.toolCallId) {
		for (let index = state.records.length - 1; index >= 0; index -= 1) {
			const record = state.records[index]!;
			if (record.result !== null || record.toolCallId !== call.toolCallId) continue;
			apply(record);
			return;
		}
		return;
	}
	for (let index = state.records.length - 1; index >= 0; index -= 1) {
		const record = state.records[index]!;
		if (record.signature !== call.signature || record.result !== null) continue;
		apply(record);
		return;
	}
}

/** The reason a blocked call carries: what was seen, and how to proceed anyway. */
export function loopBlockReason(evidence: LoopEvidence, overrideTool: string): string {
	const seen =
		evidence.kind === "repeated-failure"
			? `the same failure ${evidence.count} times: ${evidence.detail}`
			: `the same result ${evidence.count} times with nothing edited in between`;
	const called = evidence.invocation ? `\`${evidence.tool} ${evidence.invocation}\`` : `\`${evidence.tool}\``;
	return [
		`Blocked by the orchestration loop breaker: ${called} was called with the same input and ${seen}.`,
		`Nothing changes by repeating it. Change the input, edit something, or call \`${overrideTool}\` with a reason if you are deliberately iterating — the override is recorded and this call then runs.`,
	].join(" ");
}
