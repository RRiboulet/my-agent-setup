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
//   - The active branch is serialized into a transcript user message
//     (thinking dropped, tool calls marked, tool results truncated) and sent
//     with the question through `ctx.modelRegistry.streamSimple()` — the
//     documented entry point for provider-neutral nested calls, the same one
//     /answer uses. A nested call never writes to the session, so the
//     exchange stays out of the transcript by construction; no sendMessage
//     or appendEntry exists in this file.
//   - While the call runs, a status-line indicator is shown (opencode shows
//     /btw in its prompt footer); the answer then opens in a scrollable
//     overlay: ↑/↓/PgUp/PgDn/Home/End scroll, C copies via the system
//     clipboard, Esc closes.
//   - A session switch or shutdown aborts an in-flight question. The main
//     run is never touched: the nested call has its own AbortController and
//     no signal is shared with the streaming run.

import type { Api, Model, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

/**
 * Loose view of a session branch entry; only the fields /btw reads. Typed
 * loosely (like goal.ts's reconstruction) so tests can build entries as plain
 * objects without depending on pi-ai's exact shapes.
 */
interface BranchEntryView {
	type?: string;
	message?: {
		role?: string;
		content?: string | readonly unknown[];
		stopReason?: string;
		toolName?: string;
		isError?: boolean;
	};
}

/** Overall size cap for the serialized transcript, in characters (~15k tokens). */
const TRANSCRIPT_CHAR_BUDGET = 60_000;
/** Per-tool-result cap; tool output is the bulk of any transcript. */
const TOOL_OUTPUT_MAX_CHARS = 2_000;

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

function isToolResultBlock(message: { role?: string }): boolean {
	return message.role === "toolResult";
}

/** Head-truncating with a marker; tool results front-load what matters. */
function truncate(text: string, max: number, marker: string): string {
	return text.length > max ? text.slice(0, max) + marker : text;
}

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
 * Serialize the active branch into a plain-text transcript, newest-blocks
 * kept within `budget`. Custom entries and system messages are skipped, and
 * tool results are individually truncated so one noisy tool cannot eat the
 * budget on its own.
 */
export function formatTranscript(
	branch: readonly BranchEntryView[],
	budget: number = TRANSCRIPT_CHAR_BUDGET,
): string {
	const blocks: string[] = [];
	for (const entry of branch) {
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message !== "object") continue;
		const text = textParts(message.content);
		const toolNames = Array.isArray(message.content)
			? message.content.filter(isToolCallBlock).map((block) => block.name)
			: [];
		if (message.role === "user") {
			if (text) blocks.push(`User:\n${text}`);
		} else if (message.role === "assistant") {
			if (!text && toolNames.length === 0) continue;
			const header =
				toolNames.length > 0
					? `Assistant ${toolNames.map((name) => `[tool: ${name}]`).join(" ")}:`
					: "Assistant:";
			blocks.push(text ? `${header}\n${text}` : header);
		} else if (isToolResultBlock(message)) {
			const output = truncate(text, TOOL_OUTPUT_MAX_CHARS, " … [truncated]");
			if (output) {
				blocks.push(`Tool result (${message.toolName ?? "unknown"})${message.isError ? " — error" : ""}:\n${output}`);
			}
		}
		// System messages are runtime bookkeeping, not conversation.
	}
	if (blocks.length === 0) return "";

	const kept: string[] = [];
	let used = 0;
	let omitted = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		const size = (used > 0 ? 1 : 0) + block.length; // +1 for the joining "\n\n"
		if (used + size > budget) {
			omitted = i + 1;
			break;
		}
		kept.unshift(block);
		used += size;
	}
	if (kept.length === 0) {
		// The newest block alone exceeds the budget: keep its tail.
		const newest = blocks[blocks.length - 1];
		kept.push(`… [truncated]\n${newest.slice(newest.length - budget)}`);
		omitted = blocks.length - 1;
	}

	const marker = omitted > 0 ? "[earlier messages omitted]\n\n" : "";
	return marker + kept.join("\n\n");
}

export function buildBtwRequest(
	branch: readonly BranchEntryView[],
	question: string,
	now: number = Date.now(),
): { systemPrompt: string; messages: UserMessage[] } {
	const transcript = formatTranscript(branch);
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
 * so a provider failure can never masquerade as an answer.
 */
export async function askBtw(
	model: Model<Api>,
	modelRegistry: ModelRegistry,
	branch: readonly BranchEntryView[],
	question: string,
	signal: AbortSignal,
): Promise<BtwOutcome> {
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) {
		return { status: "error", message: auth.error };
	}

	const response = await modelRegistry
		.streamSimple(model, buildBtwRequest(branch, question), {
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal,
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
	return { status: "ok", answer };
}

/**
 * Dismissible answer overlay, in the hand-rolled style of /answer's
 * QnAComponent. The answer renders through pi-tui's Markdown; scrolling is a
 * window over the rendered lines. C copies the raw answer via the system
 * clipboard and confirms in the footer; Esc or ctrl+c closes.
 */
export class BtwAnswerComponent implements Component {
	private readonly markdown: Markdown;
	private scroll = 0;
	private copied: "ok" | "failed" | null = null;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

	private readonly question: string;
	private readonly answer: string;
	private readonly tui: TUI;
	private readonly onDone: () => void;
	private readonly copy: (text: string) => Promise<void>;

	constructor(
		question: string,
		answer: string,
		tui: TUI,
		onDone: () => void,
		copy: (text: string) => Promise<void> = copyToClipboard,
	) {
		this.question = question;
		this.answer = answer;
		this.tui = tui;
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

		const boxWidth = Math.min(width - 4, 110);
		const contentWidth = boxWidth - 4;

		const answerLines = this.markdown.render(contentWidth);
		const viewport = this.viewportHeight();
		const maxScroll = Math.max(0, answerLines.length - viewport);
		if (this.scroll > maxScroll) this.scroll = maxScroll;
		if (this.scroll < 0) this.scroll = 0;
		const visible = answerLines.slice(this.scroll, this.scroll + viewport);

		const horizontalLine = (count: number) => "─".repeat(count);
		const boxLine = (content: string, leftPad: number = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const rightPad = Math.max(0, boxWidth - visibleWidth(paddedContent) - 2);
			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};
		const padToWidth = (line: string): string => {
			return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		};

		const lines: string[] = [];
		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));

		const title = `${this.bold(this.cyan("btw"))} ${this.dim(`· ${truncateToWidth(this.question, contentWidth - 4)}`)}`;
		lines.push(padToWidth(boxLine(title)));

		if (maxScroll > 0) {
			const from = this.scroll + 1;
			const to = this.scroll + visible.length;
			lines.push(
				padToWidth(
					boxLine(this.dim(`lines ${from}–${to} of ${answerLines.length} — more with ↓`)),
				),
			);
		}

		for (const answerLine of visible) {
			lines.push(padToWidth(boxLine(answerLine)));
		}

		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
		const controls: string[] = ["↑/↓ scroll", "C copy", "Esc close"];
		const copiedNote =
			this.copied === "ok" ? ` · ${this.green("copied ✓")}` : this.copied === "failed" ? ` · ${this.yellow("copy failed")}` : "";
		lines.push(padToWidth(boxLine(truncateToWidth(`${this.dim(controls.join(" · "))}${copiedNote}`, contentWidth))));
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

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

		const branch = ctx.sessionManager.getBranch() as unknown as readonly BranchEntryView[];

		inFlight = true;
		controller = new AbortController();
		ctx.ui.setStatus("btw", ctx.ui.theme.fg("accent", "/btw thinking…"));

		try {
			const outcome = await askBtw(ctx.model, ctx.modelRegistry, branch, question, controller.signal);
			if (outcome.status === "cancelled") {
				ctx.ui.notify("btw cancelled", "info");
				return;
			}
			if (outcome.status === "error") {
				ctx.ui.notify(`btw failed: ${outcome.message}`, "error");
				return;
			}
			await ctx.ui.custom<void>((tui, _theme, _kb, done) => new BtwAnswerComponent(question, outcome.answer, tui, done));
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
