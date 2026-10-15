/**
 * `/voice` — dictate into pi's editor with the phone as the microphone.
 *
 * `termux-microphone-record` runs on the phone over ssh; the recording is
 * fetched here, transcribed through an OpenAI-compatible endpoint, and pasted
 * at the cursor (or submitted as a prompt, with `autoSubmit`). The phone-side
 * mechanics — start, stop, fetch, cleanup, the device-global recorder's
 * quirks — live in recorder.ts; transcription lives in transcribe.ts.
 *
 * Trigger surfaces: `/voice` toggles, `/voice cancel` aborts. The
 * `ctrl+shift+r` shortcut is for Kitty-capable desktop terminals (it is
 * silently ignored on legacy protocols, including the phone's keyboard), so
 * the command is the reliable path everywhere.
 *
 * The factory only wires things up: config is read once here (edit
 * voice.json, then `/reload`), and nothing long-running starts until a
 * command runs. Cleanup hangs off the recorder's idempotent, bounded
 * `session_shutdown`.
 */

import { spawn } from "node:child_process";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import { loadConfig } from "./config.ts";
import { Recorder, type RecorderStatus, type Run } from "./recorder.ts";

/** One status key, one place in the footer. */
export const VOICE_STATUS_KEY = "voice";

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
 * The real runner: one `ssh` per remote shell string, stdout collected as
 * Buffers (the fetch streams an m4a through it; `pi.exec` cannot, because it
 * accumulates strings). Abort kills the child; the resulting non-zero close is
 * ignored by the caller, which checks its own signal first.
 */
export function makeSshRun(target: string): Run {
	return (command, signal) =>
		new Promise((resolve, reject) => {
			if (signal.aborted) {
				reject(new Error("voice: aborted before ssh started"));
				return;
			}
			const child = spawn("ssh", [target, command], { stdio: ["ignore", "pipe", "pipe"] });
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
			child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
			child.on("error", reject);
			child.on("close", (code) => {
				resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") });
			});
			signal.addEventListener("abort", () => child.kill(), { once: true });
		});
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	// The recorder outlives any single ctx (session replacement creates new
	// ones), so status rendering uses the most recent one.
	let latest: ExtensionContext | undefined;

	const recorder = new Recorder({
		config,
		run: makeSshRun(config.sshTarget),
		status: (status) => renderStatus(latest, status),
		deliver: async (localPath) => {
			// The hand-off is where transcription and paste land once
			// transcribe.ts is wired in; until then, say where the audio is.
			if (latest?.hasUI) latest.ui.notify(`voice: recorded to ${localPath}`, "info");
		},
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

	pi.registerCommand(VOICE_STATUS_KEY, {
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

	pi.registerShortcut(Key.ctrlShift("r"), {
		description: "Dictate (toggle the phone recorder)",
		handler: async (ctx) => {
			await toggle(ctx);
		},
	});

	pi.on("session_shutdown", async () => {
		await recorder.shutdown();
		latest = undefined;
	});
}

export const __test__ = {
	statusText,
	formatElapsed,
	makeSshRun,
};
