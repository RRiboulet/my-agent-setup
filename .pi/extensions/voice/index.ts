/**
 * `/voice` — dictate into pi's editor with the phone as the microphone.
 *
 * `termux-microphone-record` runs on the phone over ssh; the recording is
 * fetched here, transcribed through an OpenAI-compatible endpoint, and pasted
 * at the cursor (or submitted as a prompt, with `autoSubmit`). The phone-side
 * mechanics — start, stop, fetch, cleanup, the device-global recorder's
 * quirks — live in recorder.ts; transcription lives in transcribe.ts.
 *
 * Trigger surfaces: `/voice` toggles, `/voice cancel` aborts. The configured
 * shortcut(s) toggle the same cycle; the defaults are `ctrl+shift+r` (distinct
 * only under the Kitty keyboard protocol) and `alt+r` (the legacy-expressible
 * form, so it fires on the phone's soft keyboard and on terminals without
 * Kitty). `/voice` remains the reliable path everywhere.
 *
 * The factory only wires things up: config is read once here (edit
 * voice.json, then `/reload`), and nothing long-running starts until a
 * command runs. Cleanup hangs off the recorder's idempotent, bounded
 * `session_shutdown`.
 */

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

import { loadConfig, type VoiceConfig } from "./config.ts";
import { Recorder, type RecorderStatus, type Run } from "./recorder.ts";
import { assertUploadSize, resolveApiKey, transcribeAudio } from "./transcribe.ts";
import { makeSshRun } from "./transport.ts";

/** The footer key for the voice status; the command name is a literal. */
const VOICE_STATUS_KEY = "voice";

/** `m:ss` for the recording timer. */
export function formatElapsed(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(whole / 60);
	return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/** Footer text per phase; `undefined` clears the key. */
export function statusText(status: RecorderStatus): string | undefined {
	switch (status.phase) {
		case "idle":
			return undefined;
		case "starting":
			return "starting…";
		case "recording":
			return `● rec ${formatElapsed(status.elapsedSeconds ?? 0)}`;
		case "stopping":
			return "stopping…";
		case "fetching":
			return "fetching…";
		case "transcribing":
			return "transcribing…";
		case "error":
			// The message goes through notify(); an error leaves no status.
			return undefined;
	}
}

function renderStatus(ctx: ExtensionContext | undefined, status: RecorderStatus): void {
	if (!ctx?.hasUI) return;
	ctx.ui.setStatus(VOICE_STATUS_KEY, statusText(status));
	if (status.phase === "error" && status.message) {
		const kept = status.localPath ? ` — audio kept at ${status.localPath}` : "";
		ctx.ui.notify(`voice: ${status.message}${kept}`, "error");
	} else if (status.phase === "idle" && status.localPath) {
		ctx.ui.notify(`voice: audio kept at ${status.localPath}`, "info");
	}
}

/**
 * Hand the transcript to the session. `autoSubmit` routes it as a user
 * message — never through exceptions: while the agent is streaming,
 * `sendUserMessage` routes the conflict to an internal extension error
 * instead of throwing, so the idle check decides `deliverAs` up front.
 * Without autoSubmit the text lands in the editor at the cursor (pi's editor
 * collapses a large paste to a marker and expands it on submit); with no
 * editor (non-interactive session) it is submitted, under the same idle
 * check as autoSubmit. `expandPromptTemplates` is deliberately never
 * enabled: a dictated transcript is content, not a command, even when it
 * starts with `/`.
 */
function presentTranscript(
	pi: ExtensionAPI,
	config: VoiceConfig,
	ctx: ExtensionContext | undefined,
	text: string,
): void {
	if (!config.autoSubmit && ctx?.hasUI) {
		ctx.ui.pasteToEditor(text);
		return;
	}
	// Submit it: either autoSubmit asked for it, or there is no editor to
	// paste into. Either way a streaming agent would swallow a plain send as
	// an internal extension error, so the idle check decides up front.
	if (ctx?.isIdle() ?? true) pi.sendUserMessage(text);
	else pi.sendUserMessage(text, { deliverAs: "followUp" });
}

/** Test seams; production callers use the defaults (ssh, global fetch, os.tmpdir()). */
export interface VoiceSeams {
	/** Replaces the ssh runner, so tests drive the state machine without a phone. */
	run?: Run;
	/** Replaces the global fetch for the transcription POST. */
	fetch?: typeof fetch;
	/** Replaces os.tmpdir() for fetched recordings. */
	tmpDir?: string;
}

export function createVoiceExtension(pi: ExtensionAPI, seams: VoiceSeams = {}): void {
	const config = loadConfig();
	const doFetch = seams.fetch ?? fetch;
	// The recorder outlives any single ctx (session replacement creates new
	// ones), so status rendering uses the most recent one.
	let latest: ExtensionContext | undefined;

	const deliver = async (localPath: string, signal: AbortSignal): Promise<void> => {
		// Refuse an oversized upload before reading it: the API's cap is
		// 25 MB, and a recording past it would only come back as a 413.
		assertUploadSize((await stat(localPath)).size);
		const audio = await readFile(localPath);
		const apiKey = await resolveApiKey({ config, modelRegistry: latest?.modelRegistry });
		const text = await transcribeAudio({
			audio,
			fileName: basename(localPath),
			config,
			...(apiKey !== undefined ? { apiKey } : {}),
			fetch: doFetch,
			signal,
		});
		if (signal.aborted) return;
		presentTranscript(pi, config, latest, text);
	};

	const recorder = new Recorder({
		config,
		run: seams.run ?? makeSshRun(config.sshTarget),
		status: (status) => renderStatus(latest, status),
		deliver,
		...(seams.tmpDir !== undefined ? { tmpDir: seams.tmpDir } : {}),
	});

	const toggle = async (ctx: ExtensionContext): Promise<void> => {
		latest = ctx;
		switch (recorder.phase()) {
			case "idle":
			case "error":
				await recorder.start();
				return;
			case "recording":
				await recorder.stop();
				return;
			default:
				if (ctx.hasUI) ctx.ui.notify(`voice: busy (${recorder.phase()}) — /voice cancel aborts`, "info");
		}
	};

	pi.registerCommand("voice", {
		description: "Dictate with the phone as microphone: /voice toggles, /voice cancel aborts",
		handler: async (args, ctx) => {
			latest = ctx;
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "cancel") {
				if (recorder.phase() === "idle") {
					if (ctx.hasUI) ctx.ui.notify("voice: nothing to cancel", "info");
					return;
				}
				await recorder.cancel();
				return;
			}
			if (sub !== "") {
				if (ctx.hasUI) ctx.ui.notify("voice: usage — /voice toggles, /voice cancel aborts", "info");
				return;
			}
			await toggle(ctx);
		},
	});

	// The ids are config strings, so the cast is the runtime validator's
	// (`shortcutField`) word, not the compiler's — an unparseable id never
	// reaches here. An empty list disables the shortcut entirely.
	for (const id of config.shortcut) {
		pi.registerShortcut(id as KeyId, {
			description: "Dictate (toggle the phone recorder)",
			handler: async (ctx) => {
				await toggle(ctx);
			},
		});
	}

	pi.on("session_shutdown", async () => {
		await recorder.shutdown();
		latest = undefined;
	});
}

export default function (pi: ExtensionAPI): void {
	createVoiceExtension(pi);
}
