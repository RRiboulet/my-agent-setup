// /btw — a quick side question about the session, mirroring opencode's /btw.
//
// opencode v2 ships `/btw <question>`: the question is answered from the
// conversation's current context with the session's model, as a one-shot call
// with no tools, and neither question nor answer is added to the conversation,
// so later prompts are unaffected. A footer indicator shows while it runs, and
// the answer opens in a dismissible dialog where C copies it.
//
// This extension ports that contract to pi:
//   - pi dispatches extension commands immediately, even while the agent is
//     streaming (agent-session.js handles them before queueing), so /btw can
//     be used mid-task just like opencode's.
//   - "The conversation's current context" is the model-visible context: the
//     handler serializes `ctx.sessionManager.buildContextEntries()` — the
//     compaction-aware entry list pi feeds its own model — so compaction and
//     branch summaries count and the shape matches what the main agent sees.
//     Custom-message entries count too (pi's `sessionEntryToContextMessages`
//     sends them to the model); plain custom entries stay skipped, because
//     that function drops them as display/state bookkeeping. Thinking is
//     dropped, tool calls are marked inline, tool results and summaries are
//     individually truncated, and the newest conversation blocks are kept
//     within a char budget, so one noisy tool cannot own the prompt. The
//     summaries are pinned outside the newest-first trim: they describe the
//     oldest conversation, which is exactly what that trim would drop first.
//     (pi exports `serializeConversation` for summaries, but it has no
//     overall budget and inlines full tool-call arguments, so /btw keeps its
//     own serializer.)
//   - The request goes through `ctx.modelRegistry.streamSimple()` — the
//     documented entry point for provider-neutral nested calls, the same one
//     /answer uses — with `toolChoice: "none"` pinning the tool-free
//     guarantee. A nested call never writes to the session: no sendMessage
//     or appendEntry exists in this file, so the exchange stays out of the
//     transcript by construction.
//   - While the call runs, a status-line indicator is shown (opencode shows
//     /btw in its prompt footer); the answer then opens in a scrollable,
//     theme-colored overlay: ↑/↓/PgUp/PgDn/Home/End scroll, C copies via the
//     system clipboard, Esc closes. The question title and the answer are
//     stripped of terminal sequences before rendering, so a hostile
//     transcript cannot clear the screen or retitle the tab from inside the
//     dialog.
//   - A session switch or shutdown aborts an in-flight question. The main
//     run is never touched: the nested call has its own AbortController and
//     no signal is shared with the streaming run.

import type { Api, Model, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	Markdown,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

/**
 * Loose view of a context entry; only the fields /btw reads. Typed loosely
 * (like goal.ts's reconstruction) so tests can build entries as plain
 * objects without depending on pi's exact session-entry shapes. `message`
 * backs message entries; `content`/`customType` backs custom_message entries
 * (whose content sits on the entry, not in a nested message); `summary`
 * backs compaction and branch_summary entries.
 */
interface ContextEntryView {
	type?: string;
	message?: {
		role?: string;
		content?: string | readonly unknown[];
		toolName?: string;
		isError?: boolean;
	};
	customType?: string;
	content?: string | readonly unknown[];
	summary?: string;
}

/** Overall size cap for the serialized transcript, in characters (~15k tokens). */
const TRANSCRIPT_CHAR_BUDGET = 60_000;
/** Per-block cap for tool results and custom-message notes. */
const TOOL_OUTPUT_MAX_CHARS = 2_000;
/** Per-block cap for pinned compaction/branch summaries. */
const SUMMARY_MAX_CHARS = 6_000;
/** Announces what the budget cost; deliberately outside the budget itself. */
const OMISSION_MARKER = "[earlier messages omitted]";
/** Announces that even pinned summaries were dropped. */
const SUMMARIES_OMISSION_MARKER = "[earlier summaries omitted]";
const TRUNCATION_MARKER = " … [truncated]";

const SYSTEM_PROMPT = `You answer a quick side question about an ongoing coding-agent session. You are given the session transcript and one question from the user.

Rules:
- Answer the question directly, grounded in the transcript.
- Be concise; skip pleasantries and do not restate the transcript.
- You have no tools: if the transcript does not contain what the answer needs, say so plainly instead of guessing.
- Your reply is ephemeral. It is not added to the session and the main agent will not see it, so nothing you say steers it.`;

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "text" &&
		typeof (block as { text?: unknown }).text === "string"
	);
}

function isToolCallBlock(block: unknown): block is { type: "toolCall"; name: string } {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "toolCall" &&
		typeof (block as { name?: unknown }).name === "string"
	);
}

function isImageBlock(block: unknown): boolean {
	return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image";
}

function isHighSurrogate(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
	return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * First `count` code units of `text`, cut before a surrogate pair rather
 * than through it: the high surrogate straddling the cut leaves the prefix
 * together with its low mate, so no lone surrogate ever travels to a
 * provider or renderer.
 */
function firstCodeUnits(text: string, count: number): string {
	if (count >= text.length) return text;
	if (count <= 0) return "";
	const splitPair = isHighSurrogate(text.charCodeAt(count - 1)) && isLowSurrogate(text.charCodeAt(count));
	return text.slice(0, splitPair ? count - 1 : count);
}

/**
 * Last `count` code units of `text`, cut after a surrogate pair rather than
 * through it: the pair straddling the cut is excluded whole.
 */
function lastCodeUnits(text: string, count: number): string {
	if (count >= text.length) return text;
	if (count <= 0) return "";
	const cut = text.length - count;
	const splitPair = isHighSurrogate(text.charCodeAt(cut - 1)) && isLowSurrogate(text.charCodeAt(cut));
	return text.slice(splitPair ? cut + 1 : cut);
}

/** Head-truncating with a marker; tool results front-load what matters. */
function truncate(text: string, max: number, marker: string): string {
	if (text.length <= max) return text;
	return firstCodeUnits(text, max) + marker;
}

/** Text content of a session-file message or a custom message. */
function textParts(content: string | readonly unknown[] | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content.trim();
	const parts: string[] = [];
	for (const block of content) {
		if (isTextBlock(block)) parts.push(block.text);
		else if (isImageBlock(block)) parts.push("[image]");
	}
	return parts.join("\n").trim();
}

/**
 * Serialize the model-visible context into a plain-text transcript.
 *
 * `entries` must be in context order — i.e. `buildContextEntries()` output.
 * Two ledgers keep the total inside `budget`:
 *   - pinned summaries (compaction/branch_summary) describe the oldest
 *     conversation and would be dropped first by a newest-first trim, so
 *     they are priced first, newest-most-relevant-first, within half the
 *     budget; they also lead the assembled transcript, chronological
 *     between themselves;
 *   - conversation blocks are kept newest-first within the remainder, the
 *     same contiguous-run rule: once a block does not fit, everything
 *     older is marked omitted together.
 * Each ledger charges the 2-char block separator ("\n\n") to the newly added
 * older block, so a kept run costs exactly separators + block lengths; the
 * omission markers sit outside the budget because they announce the cap
 * rather than join content.
 */
export function formatTranscript(
	entries: readonly ContextEntryView[],
	budget: number = TRANSCRIPT_CHAR_BUDGET,
): string {
	const pinned: string[] = [];
	const flow: string[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "message") {
			const message = entry.message;
			if (!message || typeof message !== "object") continue;
			const text = textParts(message.content);
			const toolNames = Array.isArray(message.content)
				? message.content.filter(isToolCallBlock).map((block) => block.name)
				: [];
			if (message.role === "user") {
				if (text) flow.push(`User:\n${text}`);
			} else if (message.role === "assistant") {
				if (!text && toolNames.length === 0) continue;
				const header =
					toolNames.length > 0 ? `Assistant ${toolNames.map((name) => `[tool: ${name}]`).join(" ")}:` : "Assistant:";
				flow.push(text ? `${header}\n${text}` : header);
			} else if (message.role === "toolResult") {
				const output = truncate(text, TOOL_OUTPUT_MAX_CHARS, TRUNCATION_MARKER);
				if (output) {
					flow.push(`Tool result (${message.toolName ?? "unknown"})${message.isError ? " — error" : ""}:\n${output}`);
				}
			}
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.summary) {
			pinned.push(`Summary:\n${truncate(entry.summary, SUMMARY_MAX_CHARS, TRUNCATION_MARKER)}`);
		} else if (entry.type === "custom_message") {
			const text = truncate(textParts(entry.content), TOOL_OUTPUT_MAX_CHARS, TRUNCATION_MARKER);
			if (text) flow.push(`Note (${entry.customType ?? "unknown"}):\n${text}`);
		}
		// Every other entry kind (plain custom, context edits, model changes…)
		// is runtime bookkeeping that pi itself never sends to the model; the
		// side transcript mirrors that.
	}
	if (pinned.length === 0 && flow.length === 0) return "";

	// Pinned ledger: newest summaries are the most relevant to a current
	// question, so they run newest-first within half the budget.
	const pinnedBudget = Math.max(0, Math.floor(budget / 2));
	const keptPinned: string[] = []; // unshifted newest-first, so output order is chronological
	let pinnedUsed = 0;
	let pinnedDropped = false;
	for (let i = pinned.length - 1; i >= 0; i--) {
		const size = pinned[i].length + (keptPinned.length > 0 ? 2 : 0);
		if (pinnedUsed + size > pinnedBudget) {
			pinnedDropped = true;
			break;
		}
		keptPinned.unshift(pinned[i]);
		pinnedUsed += size;
	}
	if (keptPinned.length === 0 && pinned.length > 0) {
		// A single summary alone can exceed the pinned budget: keep its tail.
		keptPinned.push(`… [truncated]\n${lastCodeUnits(pinned[pinned.length - 1], pinnedBudget)}`);
		pinnedUsed = Math.min(pinnedBudget, keptPinned[0].length);
		pinnedDropped = pinned.length > 1;
	}

	// Flow ledger: the newest contiguous run of conversation blocks within
	// whatever the summaries left.
	const flowBudget = Math.max(0, budget - pinnedUsed);
	const keptFlow: string[] = [];
	let flowUsed = 0;
	let flowDropped = false;
	for (let i = flow.length - 1; i >= 0; i--) {
		const size = flow[i].length + (keptFlow.length > 0 ? 2 : 0);
		if (flowUsed + size > flowBudget) {
			flowDropped = true;
			break;
		}
		keptFlow.unshift(flow[i]);
		flowUsed += size;
	}
	if (keptFlow.length === 0 && flow.length > 0) {
		if (flowBudget > 0) {
			// The newest block alone exceeds the flow budget: keep its tail. Its
			// own header announces the cut; the omission marker only appears
			// when the remaining older blocks lost their representation whole.
			keptFlow.push(`… [truncated]\n${lastCodeUnits(flow[flow.length - 1], flowBudget)}`);
			flowDropped = flow.length > 1;
		} else {
			flowDropped = true;
		}
	}

	const markers: string[] = [];
	if (pinnedDropped) markers.push(SUMMARIES_OMISSION_MARKER);
	if (flowDropped) markers.push(OMISSION_MARKER);

	const parts: string[] = [];
	if (markers.length > 0) parts.push(markers.join("\n"));
	parts.push(...keptPinned);
	parts.push(...keptFlow);
	return parts.join("\n\n");
}

/**
 * The side-question request shape: the transcript (if any) as one user
 * message, the question as the one that follows it. Two user messages keep
 * the transcript prefix stable across consecutive /btw calls, which is the
 * prompt-cache-friendly shape for a flat side request.
 */
export function buildBtwRequest(
	entries: readonly ContextEntryView[],
	question: string,
	now: number = Date.now(),
): { systemPrompt: string; messages: UserMessage[] } {
	const transcript = formatTranscript(entries);
	const userMessage = (text: string): UserMessage => ({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: now,
	});
	const messages = transcript
		? [userMessage(`Session transcript so far:\n\n${transcript}`), userMessage(question)]
		: [userMessage(question)];
	return { systemPrompt: SYSTEM_PROMPT, messages };
}

export type BtwOutcome =
	| { status: "ok"; answer: string }
	| { status: "cancelled" }
	| { status: "error"; message: string };

/**
 * One-shot, tool-free side question on the given model. Mirrors
 * /answer's extraction call: auth through the registry, the nested stream
 * resolved to its final AssistantMessage, aborted/error stop reasons mapped
 * so a provider failure can never masquerade as an answer. The answer is
 * stripped of terminal sequences before it leaves this function, so the
 * overlay and the clipboard both receive inert text.
 */
export async function askBtw(
	model: Model<Api>,
	modelRegistry: ModelRegistry,
	entries: readonly ContextEntryView[],
	question: string,
	signal: AbortSignal,
): Promise<BtwOutcome> {
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) {
		return { status: "error", message: auth.error };
	}

	const response = await modelRegistry
		.streamSimple(model, buildBtwRequest(entries, question), {
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal,
			// The documented default is adapter-defined ("provider-specific
			// behavior"); "none" makes the tool-free guarantee unconditional.
			toolChoice: "none",
		})
		.result();

	if (response.stopReason === "aborted") {
		return { status: "cancelled" };
	}
	if (response.stopReason === "error") {
		return { status: "error", message: response.errorMessage ?? "the model call failed" };
	}

	const answer = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!answer) {
		return { status: "error", message: "the model returned no text" };
	}
	return { status: "ok", answer: stripTerminalSequences(answer) };
}

/**
 * Dismissible answer overlay, in the hand-rolled style of /answer's
 * QnAComponent but themed: all color goes through the session theme (the
 * status line already does), not raw ANSI. The answer renders through
 * pi-tui's Markdown; scrolling is a window over the rendered lines. C
 * copies the answer via the system clipboard and confirms in the footer;
 * Esc or ctrl+c closes.
 */
export class BtwAnswerComponent implements Component {
	private readonly markdown: Markdown;
	private scroll = 0;
	private copied: "ok" | "failed" | null = null;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private readonly question: string;
	private readonly answer: string;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly onDone: () => void;
	private readonly copy: (text: string) => Promise<void>;

	constructor(
		question: string,
		answer: string,
		tui: TUI,
		theme: Theme,
		onDone: () => void,
		copy: (text: string) => Promise<void> = copyToClipboard,
	) {
		this.question = question;
		this.answer = answer;
		this.tui = tui;
		this.theme = theme;
		this.onDone = onDone;
		this.copy = copy;
		this.markdown = new Markdown(answer, 0, 0, getMarkdownTheme());
	}

	private viewportHeight(): number {
		return Math.max(6, Math.min(36, (this.tui.terminal.rows || 24) - 12));
	}

	private scrollBy(lines: number): void {
		this.scroll = Math.max(0, this.scroll + lines);
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onDone();
			return;
		}
		if (data.length === 1 && (data === "c" || data === "C")) {
			void this.copy(this.answer).then(
				() => {
					this.copied = "ok";
					this.invalidate();
					this.tui.requestRender();
				},
				() => {
					this.copied = "failed";
					this.invalidate();
					this.tui.requestRender();
				},
			);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scrollBy(-1);
		} else if (matchesKey(data, Key.down)) {
			this.scrollBy(1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollBy(-this.viewportHeight());
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(this.viewportHeight());
		} else if (matchesKey(data, Key.home)) {
			this.scroll = 0;
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.end)) {
			this.scroll = Number.MAX_SAFE_INTEGER;
			this.invalidate();
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const boxWidth = Math.max(0, Math.min(width - 4, 110));
		const contentWidth = Math.max(0, boxWidth - 4);

		const answerLines = this.markdown.render(contentWidth);
		const viewport = this.viewportHeight();
		const maxScroll = Math.max(0, answerLines.length - viewport);
		if (this.scroll > maxScroll) this.scroll = maxScroll;
		if (this.scroll < 0) this.scroll = 0;
		const visible = answerLines.slice(this.scroll, this.scroll + viewport);

		const horizontal = (count: number) => "─".repeat(Math.max(0, count));
		const boxLine = (content: string, leftPad: number = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const rightPad = Math.max(0, boxWidth - visibleWidth(paddedContent) - 2);
			return this.theme.fg("dim", "│") + paddedContent + " ".repeat(rightPad) + this.theme.fg("dim", "│");
		};
		const padToWidth = (line: string): string => {
			return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		};

		const lines: string[] = [];
		lines.push(padToWidth(this.theme.fg("dim", "╭" + horizontal(boxWidth - 2) + "╮")));

		// One-line title: collapse the question for the box frame and cap it
		// inside the border ("btw" leaves the box edge, the dot adds one more).
		const titleQuestion = truncateToWidth(
			stripTerminalSequences(this.question.replace(/\s+/g, " ").trim()),
			Math.max(0, contentWidth - 6),
		);
		lines.push(padToWidth(boxLine(`${this.theme.fg("accent", "btw")} ${this.theme.fg("dim", `· ${titleQuestion}`)}`)));

		if (maxScroll > 0) {
			const from = this.scroll + 1;
			const to = this.scroll + visible.length;
			lines.push(
				padToWidth(
					boxLine(this.theme.fg("dim", `lines ${from}–${to} of ${answerLines.length} — more with ↓`)),
				),
			);
		}

		for (const answerLine of visible) {
			lines.push(padToWidth(boxLine(answerLine)));
		}

		lines.push(padToWidth(this.theme.fg("dim", "├" + horizontal(boxWidth - 2) + "┤")));
		const controls = this.theme.fg("dim", ["↑/↓ scroll", "C copy", "Esc close"].join(" · "));
		const copiedNote =
			this.copied === "ok"
				? ` · ${this.theme.fg("success", "copied ✓")}`
				: this.copied === "failed"
					? ` · ${this.theme.fg("warning", "copy failed")}`
					: "";
		lines.push(padToWidth(boxLine(truncateToWidth(`${controls}${copiedNote}`, contentWidth))));
		lines.push(padToWidth(this.theme.fg("dim", "╰" + horizontal(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let inFlight = false;
	let controller: AbortController | null = null;

	// A side question is scoped to the session that asked it. A session
	// switch or shutdown aborts the in-flight fetch; the abort surfaces as a
	// "cancelled" outcome and is reported, never thrown.
	const abortInFlight = () => {
		controller?.abort();
		controller = null;
	};
	pi.on("session_start", () => abortInFlight());
	pi.on("session_shutdown", () => abortInFlight());

	const btwHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const question = args.trim();
		if (!question) {
			ctx.ui.notify("Usage: /btw <question>", "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("btw requires interactive mode", "error");
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify("btw needs the interactive TUI for its answer dialog", "error");
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}
		if (inFlight) {
			ctx.ui.notify("A /btw question is already running", "info");
			return;
		}

		const entries = ctx.sessionManager.buildContextEntries() as unknown as readonly ContextEntryView[];

		// Everything from here on owns the single-flight guard: both state
		// flips sit inside the try so no path can wedge the flag, and the
		// finally re-clears the status even on the error path.
		try {
			inFlight = true;
			controller = new AbortController();
			ctx.ui.setStatus("btw", ctx.ui.theme.fg("accent", "/btw thinking…"));

			const outcome = await askBtw(ctx.model, ctx.modelRegistry, entries, question, controller.signal);
			// The indicator's job ends with the answer; the overlay takes over.
			ctx.ui.setStatus("btw", undefined);
			if (outcome.status === "cancelled") {
				ctx.ui.notify("btw cancelled", "info");
				return;
			}
			if (outcome.status === "error") {
				ctx.ui.notify(`btw failed: ${outcome.message}`, "error");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new BtwAnswerComponent(question, outcome.answer, tui, theme, done));
		} catch (error) {
			// pi reports handler errors itself, but a rejection here must not
			// masquerade as an answer or leave the indicator behind. An abort
			// during the call's lazy setup surfaces as an "error" stop reason,
			// so decide by the signal, not by the outcome.
			if (controller?.signal.aborted) {
				ctx.ui.notify("btw cancelled", "info");
			} else {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`btw failed: ${message}`, "error");
			}
		} finally {
			inFlight = false;
			controller = null;
			ctx.ui.setStatus("btw", undefined);
		}
	};

	pi.registerCommand("btw", {
		description: "Ask a quick side question; the answer is not added to the session",
		handler: (args, ctx) => btwHandler(args, ctx),
	});
}
