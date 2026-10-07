/**
 * /session-breakdown
 *
 * Interactive TUI that analyzes ~/.pi/agent/sessions (recursively, *.jsonl) and shows
 * last 7/30/90 days of:
 * - sessions/day
 * - messages/day
 * - tokens/day (if available)
 * - cost/day (if available)
 * - model breakdown (sessions/messages/tokens + cost)
 *
 * Graph:
 * - GitHub-contributions-style calendar (weeks x weekdays)
 * - Hue: weighted mix of popular model colors (weighted by the selected metric)
 * - Brightness: selected metric per day (log-scaled)
 */

// ---------------------------------------------------------------------------
// VENDORED, NOT OURS.
//
//   session-breakdown.ts — Copyright (c) mitsuhiko and contributors
//   https://github.com/mitsuhiko/agent-stuff (extensions/session-breakdown.ts)
//   Licensed under the Apache License, Version 2.0.
//
// Vendored verbatim, with four LOCAL PATCH hunks below — each marked in place
// with a `LOCAL PATCH n` comment and listed here so a later `diff` against
// upstream stays readable.
//
// Upstream base: commit 0865c84 ("fix(session-breakdown): only count models that
// produced messages"). Verified on 2026-10-05 by diffing against upstream: of
// the 160 lines the three commits before it added, this file carries 158
// verbatim, and the only two it does not are the two lines below that
// LOCAL PATCH 2 amends on purpose. So this file is current, and the local
// amendments are the whole of the delta — do not re-vendor it on the assumption
// that it lags.
//
//   1. SESSION_ROOTS instead of a hardcoded SESSION_ROOT: follows pi's
//      getAgentDir() (so PI_CODING_AGENT_DIR works — upstream PR #24 was closed
//      unmerged) and sweeps the subagent extension's child sessions, which live
//      outside sessions/ and are otherwise invisible.
//   2. Inherited-entry exclusion: a forked session file carries a verbatim copy
//      of its parent's tail (pi's own /fork, /clone and --fork do this too, and
//      so do our subagent `handoff: fork` children). Those copies are not
//      requests this session made, so they are excluded from messages, tokens
//      and cost, while the file still counts as one session.
//   3. A one-line footer saying how much inherited context was excluded, so a
//      surprising total explains itself next to the number.
//   4. A __test__ export, so the aggregation can be tested over fixtures.
//
// Why patch 2 is not optional: summing whole files counted a fork run's
// inherited prefix again — measured 2026-10-04 on a real `handoff: "fork"`
// child (see CHANGELOG.md for the figures) — and the same duplication was
// already present inside sessions/ from pi's native forking, with no subagent
// involved. Measurements and rationale: TODO-859f419f.
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	type Component,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import readline from "node:readline";

type ModelKey = string; // `${provider}/${model}`
type CwdKey = string; // normalized cwd path
type DowKey = string; // "Mon", "Tue", etc.
type TodKey = string; // "after-midnight", "morning", "afternoon", "evening", "night"
type BreakdownView = "model" | "cwd" | "dow" | "tod";

function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	if (length <= 0) return "";
	const endCol = startCol + length;
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	let result = "";
	let currentCol = 0;
	let i = 0;
	let pendingAnsi = "";

	while (i < line.length) {
		if (line[i] === "\x1b") {
			const match = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*(?:\x1b\\)|[@-_])/.exec(line.slice(i));
			if (match) {
				if (currentCol >= startCol && currentCol < endCol) {
					result += match[0];
				} else if (currentCol < startCol) {
					pendingAnsi += match[0];
				}
				i += match[0].length;
				continue;
			}
		}

		const nextAnsi = line.indexOf("\x1b", i);
		const textEnd = nextAnsi === -1 ? line.length : nextAnsi;
		for (const { segment } of segmenter.segment(line.slice(i, textEnd))) {
			const w = visibleWidth(segment);
			const inRange = currentCol >= startCol && currentCol < endCol;
			const fits = !strict || currentCol + w <= endCol;
			if (inRange && fits) {
				if (pendingAnsi) {
					result += pendingAnsi;
					pendingAnsi = "";
				}
				result += segment;
			}
			currentCol += w;
			if (currentCol >= endCol) break;
		}
		i = textEnd;
		if (currentCol >= endCol) break;
	}

	return result;
}

const DOW_NAMES: DowKey[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const TOD_BUCKETS: { key: TodKey; label: string; from: number; to: number }[] = [
	{ key: "after-midnight", label: "After midnight (0–5)", from: 0, to: 5 },
	{ key: "morning", label: "Morning (6–11)", from: 6, to: 11 },
	{ key: "afternoon", label: "Afternoon (12–16)", from: 12, to: 16 },
	{ key: "evening", label: "Evening (17–21)", from: 17, to: 21 },
	{ key: "night", label: "Night (22–23)", from: 22, to: 23 },
];

function todBucketForHour(hour: number): TodKey {
	for (const b of TOD_BUCKETS) {
		if (hour >= b.from && hour <= b.to) return b.key;
	}
	return "after-midnight";
}

function todBucketLabel(key: TodKey): string {
	return TOD_BUCKETS.find((b) => b.key === key)?.label ?? key;
}

interface ParsedSession {
	filePath: string;
	startedAt: Date;
	dayKeyLocal: string; // YYYY-MM-DD (local)
	cwd: CwdKey | null;
	dow: DowKey;
	tod: TodKey;
	modelsUsed: Set<ModelKey>;
	messages: number;
	tokens: number;
	totalCost: number;
	costByModel: Map<ModelKey, number>;
	messagesByModel: Map<ModelKey, number>;
	tokensByModel: Map<ModelKey, number>;
	// LOCAL PATCH 2: the usage this session inherited from an ancestor and had
	// excluded again. Upstream keeps no equivalent field.
	inherited: InheritedTotals;
}

/** Usage carried by entries a session inherited from an ancestor file. */
interface InheritedTotals {
	entries: number;
	tokens: number;
	cost: number;
}

/** What the scan learned about forked and child sessions, for the footer. */
interface InheritedReport extends InheritedTotals {
	/** Files that excluded at least one inherited entry. */
	forkedSessions: number;
	/**
	 * Files whose own header, or whose ancestor chain, could not be read. Whatever
	 * ids were recovered before the break are still excluded and the rest is
	 * counted, so the error is always towards counting too much — but the number is
	 * reported rather than left to be discovered.
	 */
	unknownLineage: number;
	/** Files scanned outside `sessions/`: child transcripts of the subagent extension. */
	childSessions: number;
}

function emptyInheritedTotals(): InheritedTotals {
	return { entries: 0, tokens: 0, cost: 0 };
}

interface DayAgg {
	date: Date; // local midnight
	dayKeyLocal: string;
	sessions: number;
	messages: number;
	tokens: number;
	totalCost: number;
	costByModel: Map<ModelKey, number>;
	sessionsByModel: Map<ModelKey, number>;
	messagesByModel: Map<ModelKey, number>;
	tokensByModel: Map<ModelKey, number>;
	groupedCostByModel: Map<ModelKey, number>;
	groupedSessionsByModel: Map<ModelKey, number>;
	groupedMessagesByModel: Map<ModelKey, number>;
	groupedTokensByModel: Map<ModelKey, number>;
	sessionsByCwd: Map<CwdKey, number>;
	messagesByCwd: Map<CwdKey, number>;
	tokensByCwd: Map<CwdKey, number>;
	costByCwd: Map<CwdKey, number>;
	sessionsByTod: Map<TodKey, number>;
	messagesByTod: Map<TodKey, number>;
	tokensByTod: Map<TodKey, number>;
	costByTod: Map<TodKey, number>;
}

interface RangeAgg {
	days: DayAgg[];
	dayByKey: Map<string, DayAgg>;
	sessions: number;
	totalMessages: number;
	totalTokens: number;
	totalCost: number;
	modelCost: Map<ModelKey, number>;
	modelSessions: Map<ModelKey, number>; // number of sessions where model was used
	modelMessages: Map<ModelKey, number>;
	modelTokens: Map<ModelKey, number>;
	// Provider-agnostic (grouped by model name, e.g. radius/foo + openai/foo → foo)
	groupedModelCost: Map<ModelKey, number>;
	groupedModelSessions: Map<ModelKey, number>;
	groupedModelMessages: Map<ModelKey, number>;
	groupedModelTokens: Map<ModelKey, number>;
	cwdCost: Map<CwdKey, number>;
	cwdSessions: Map<CwdKey, number>;
	cwdMessages: Map<CwdKey, number>;
	cwdTokens: Map<CwdKey, number>;
	dowCost: Map<DowKey, number>;
	dowSessions: Map<DowKey, number>;
	dowMessages: Map<DowKey, number>;
	dowTokens: Map<DowKey, number>;
	todCost: Map<TodKey, number>;
	todSessions: Map<TodKey, number>;
	todMessages: Map<TodKey, number>;
	todTokens: Map<TodKey, number>;
}

interface RGB {
	r: number;
	g: number;
	b: number;
}

interface BreakdownData {
	generatedAt: Date;
	ranges: Map<number, RangeAgg>;
	palette: {
		modelColors: Map<ModelKey, RGB>;
		otherColor: RGB;
		orderedModels: ModelKey[];
	};
	groupedPalette: {
		modelColors: Map<ModelKey, RGB>;
		otherColor: RGB;
		orderedModels: ModelKey[];
	};
	cwdPalette: {
		cwdColors: Map<CwdKey, RGB>;
		otherColor: RGB;
		orderedCwds: CwdKey[];
	};
	dowPalette: {
		dowColors: Map<DowKey, RGB>;
		orderedDows: DowKey[];
	};
	todPalette: {
		todColors: Map<TodKey, RGB>;
		orderedTods: TodKey[];
	};
	// LOCAL PATCH 2/3: how much inherited context was excluded from the totals.
	inherited: InheritedReport;
}

// LOCAL PATCH 1 (ours): the agent dir, not a hardcoded homedir path.
//
// Upstream hardcodes `<homedir>/.pi/agent/sessions` and walks only that. Two
// consequences, both measured on this machine (see the vendor header):
//   - A relocated agent dir is ignored entirely. The env var is
//     PI_CODING_AGENT_DIR (there is no PI_AGENT_DIR).
//   - The subagent extension's child sessions are invisible: they live at
//     <agentDir>/tmux-subagents/<parent-session-id>/<run-id>/session/, a SIBLING
//     of sessions/. Measured 2026-10-04: real cost was missing from the view
//     (see CHANGELOG.md for the figure). (Token counts are deliberately not
//     quoted: they move with every run, and every duplicated entry on that
//     machine reported cost.total = 0 anyway.)
//
// Legacy `subagents` is that extension's run dir under its previous name
// (RUNS_DIR was "subagents" before it became "tmux-subagents"); three files
// from that era are still on disk. Absent roots are harmless: walkSessionFiles
// already tolerates directories it cannot read.
function defaultSessionRoots(agentDir: string = getAgentDir()): string[] {
	return [
		path.join(agentDir, "sessions"),
		path.join(agentDir, "tmux-subagents"),
		path.join(agentDir, "subagents"),
	];
}
const RANGE_DAYS = [7, 30, 90] as const;

type MeasurementMode = "sessions" | "messages" | "tokens";

type BreakdownProgressPhase = "scan" | "parse" | "finalize";

interface BreakdownProgressState {
	phase: BreakdownProgressPhase;
	foundFiles: number;
	parsedFiles: number;
	totalFiles: number;
	currentFile?: string;
}

function setBorderedLoaderMessage(loader: BorderedLoader, message: string) {
	// BorderedLoader wraps a (Cancellable)Loader which supports setMessage(),
	// but it doesn't expose it publicly. Access the inner loader for progress updates.
	const inner = (loader as any)["loader"]; // eslint-disable-line @typescript-eslint/no-explicit-any
	if (inner && typeof inner.setMessage === "function") {
		inner.setMessage(message);
	}
}

// Dark-ish background and empty cell color (close to GitHub dark)
const DEFAULT_BG: RGB = { r: 13, g: 17, b: 23 };
const EMPTY_CELL_BG: RGB = { r: 22, g: 27, b: 34 };

// Default palette (assigned to top models)
const PALETTE: RGB[] = [
	{ r: 64, g: 196, b: 99 }, // green
	{ r: 47, g: 129, b: 247 }, // blue
	{ r: 163, g: 113, b: 247 }, // purple
	{ r: 255, g: 159, b: 10 }, // orange
	{ r: 244, g: 67, b: 54 }, // red
];

function clamp01(x: number): number {
	return Math.max(0, Math.min(1, x));
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
	return {
		r: Math.round(lerp(a.r, b.r, t)),
		g: Math.round(lerp(a.g, b.g, t)),
		b: Math.round(lerp(a.b, b.b, t)),
	};
}

function weightedMix(colors: Array<{ color: RGB; weight: number }>): RGB {
	let total = 0;
	let r = 0;
	let g = 0;
	let b = 0;
	for (const c of colors) {
		if (!Number.isFinite(c.weight) || c.weight <= 0) continue;
		total += c.weight;
		r += c.color.r * c.weight;
		g += c.color.g * c.weight;
		b += c.color.b * c.weight;
	}
	if (total <= 0) return EMPTY_CELL_BG;
	return { r: Math.round(r / total), g: Math.round(g / total), b: Math.round(b / total) };
}

function ansiBg(rgb: RGB, text: string): string {
	return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`;
}

function ansiFg(rgb: RGB, text: string): string {
	return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`;
}

function dim(text: string): string {
	return `\x1b[2m${text}\x1b[0m`;
}

function bold(text: string): string {
	return `\x1b[1m${text}\x1b[0m`;
}

function formatCount(n: number): string {
	if (!Number.isFinite(n) || n === 0) return "0";
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toLocaleString("en-US");
}

function formatUsd(cost: number): string {
	if (!Number.isFinite(cost)) return "$0.00";
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

/**
 * Abbreviate a path for display. Strategy:
 * - Replace home dir with ~
 * - If still too long, keep first segment + last N segments with … in between
 * Examples:
 *   /Users/mitsuhiko/Development/agent-stuff  →  ~/Development/agent-stuff
 *   /Users/mitsuhiko/Development/minijinja/minijinja-go  →  ~/…/minijinja/minijinja-go
 */
function abbreviatePath(p: string, maxWidth = 40): string {
	const home = os.homedir();
	let display = p;
	if (display.startsWith(home)) {
		display = "~" + display.slice(home.length);
	}
	if (display.length <= maxWidth) return display;

	const parts = display.split("/").filter(Boolean);
	// Always keep the first part (~ or root indicator) and try to keep as many trailing parts as possible
	if (parts.length <= 2) return display;

	const prefix = parts[0]; // typically "~"
	// Try keeping last N parts, increasing until it fits
	for (let keep = parts.length - 1; keep >= 1; keep--) {
		const tail = parts.slice(parts.length - keep);
		const candidate = prefix + "/…/" + tail.join("/");
		if (candidate.length <= maxWidth || keep === 1) return candidate;
	}
	return display;
}

function padRight(s: string, n: number): string {
	const delta = n - s.length;
	return delta > 0 ? s + " ".repeat(delta) : s;
}

function padLeft(s: string, n: number): string {
	const delta = n - s.length;
	return delta > 0 ? " ".repeat(delta) + s : s;
}

function toLocalDayKey(d: Date): string {
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function localMidnight(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function addDaysLocal(d: Date, days: number): Date {
	const x = new Date(d);
	x.setDate(x.getDate() + days);
	return x;
}

function countDaysInclusiveLocal(start: Date, end: Date): number {
	// Avoid ms-based day math because DST transitions can make a “day” 23/25h in local time.
	let n = 0;
	for (let d = new Date(start); d <= end; d = addDaysLocal(d, 1)) n++;
	return n;
}

function mondayIndex(date: Date): number {
	// Mon=0 .. Sun=6
	return (date.getDay() + 6) % 7;
}

function modelKeyFromParts(provider?: unknown, model?: unknown): ModelKey | null {
	const p = typeof provider === "string" ? provider.trim() : "";
	const m = typeof model === "string" ? model.trim() : "";
	if (!p && !m) return null;
	if (!p) return m;
	if (!m) return p;
	return `${p}/${m}`;
}

function normalizedLowerString(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isFauxModelReference(parts: { api?: unknown; provider?: unknown; model?: unknown; modelId?: unknown }): boolean {
	// pi-ai's test/mock provider is registered as api "faux:<random>" with provider "faux"
	// and default model ids like "faux-1".  It can emit token estimates, but those are
	// synthetic and should not affect real session usage breakdowns.
	const api = normalizedLowerString(parts.api);
	if (api === "faux" || api.startsWith("faux:")) return true;
	if (normalizedLowerString(parts.provider) === "faux") return true;

	const model = normalizedLowerString(parts.model ?? parts.modelId);
	return model === "faux" || model.startsWith("faux-");
}

function parseSessionStartFromFilename(name: string): Date | null {
	// Example: 2026-02-02T21-52-28-774Z_<uuid>.jsonl
	const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
	if (!m) return null;
	const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
	const d = new Date(iso);
	return Number.isFinite(d.getTime()) ? d : null;
}

function extractProviderModelAndUsage(obj: any): { api?: any; provider?: any; model?: any; modelId?: any; usage?: any } {
	// Session format varies across versions.
	// - Newer: { provider, model, usage } on the message wrapper
	// - Older: { message: { provider, model, usage } }
	const msg = obj?.message;
	return {
		api: obj?.api ?? msg?.api,
		provider: obj?.provider ?? msg?.provider,
		model: obj?.model ?? msg?.model,
		modelId: obj?.modelId ?? msg?.modelId,
		usage: obj?.usage ?? msg?.usage,
	};
}

function extractCostTotal(usage: any): number {
	if (!usage) return 0;
	const c = usage?.cost;
	if (typeof c === "number") return Number.isFinite(c) ? c : 0;
	if (typeof c === "string") {
		const n = Number(c);
		return Number.isFinite(n) ? n : 0;
	}
	const t = c?.total;
	if (typeof t === "number") return Number.isFinite(t) ? t : 0;
	if (typeof t === "string") {
		const n = Number(t);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

function extractTokensTotal(usage: any): number {
	// Usage format varies across providers and pi versions.
	// We try a few common shapes:
	// - { totalTokens }
	// - { total_tokens }
	// - { promptTokens, completionTokens }
	// - { prompt_tokens, completion_tokens }
	// - { input_tokens, output_tokens }
	// - { inputTokens, outputTokens }
	// - { tokens: number | { total } }
	if (!usage) return 0;

	const readNum = (v: any): number => {
		if (typeof v === "number") return Number.isFinite(v) ? v : 0;
		if (typeof v === "string") {
			const n = Number(v);
			return Number.isFinite(n) ? n : 0;
		}
		return 0;
	};

	let total = 0;
	// direct totals
	total =
		readNum(usage?.totalTokens) ||
		readNum(usage?.total_tokens) ||
		readNum(usage?.tokens) ||
		readNum(usage?.tokenCount) ||
		readNum(usage?.token_count);
	if (total > 0) return total;

	// nested tokens object
	total = readNum(usage?.tokens?.total) || readNum(usage?.tokens?.totalTokens) || readNum(usage?.tokens?.total_tokens);
	if (total > 0) return total;

	// sum of parts
	const a =
		readNum(usage?.promptTokens) ||
		readNum(usage?.prompt_tokens) ||
		readNum(usage?.inputTokens) ||
		readNum(usage?.input_tokens);
	const b =
		readNum(usage?.completionTokens) ||
		readNum(usage?.completion_tokens) ||
		readNum(usage?.outputTokens) ||
		readNum(usage?.output_tokens);
	const sum = a + b;
	return sum > 0 ? sum : 0;
}

async function walkSessionFiles(
	root: string,
	startCutoffLocal: Date,
	signal?: AbortSignal,
	onFound?: (found: number) => void,
): Promise<string[]> {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length) {
		if (signal?.aborted) break;
		const dir = stack.pop()!;
		let entries: Dirent[] = [];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const ent of entries) {
			if (signal?.aborted) break;
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				stack.push(p);
				continue;
			}
			if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;

			// Prefer filename timestamp, else fall back to mtime.
			const startedAt = parseSessionStartFromFilename(ent.name);
			if (startedAt) {
				if (localMidnight(startedAt) >= startCutoffLocal) {
					out.push(p);
					if (onFound && out.length % 10 === 0) onFound(out.length);
				}
				continue;
			}

			try {
				const st = await fs.stat(p);
				const approx = new Date(st.mtimeMs);
				if (localMidnight(approx) >= startCutoffLocal) {
					out.push(p);
					if (onFound && out.length % 10 === 0) onFound(out.length);
				}
			} catch {
				// ignore
			}
		}
	}
	onFound?.(out.length);
	return out;
}

// LOCAL PATCH 2 (ours): read the v3 header's `parentSession` field, which pi
// core, upstream's split-fork.ts and our subagent `handoff.ts` all write, and
// which upstream's parser walks straight past. It holds the ABSOLUTE PATH of the
// file this session was forked from, so it is the only lineage signal available
// without knowing anything about who produced the file.
//
// Returns null when the file cannot be read or has no session header, which is
// different from "readable, no parent" (that is `{ parentSession: null }`).
async function readSessionHeader(filePath: string, signal?: AbortSignal): Promise<{ parentSession: string | null } | null> {
	const stream = createReadStream(filePath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of rl) {
			if (signal?.aborted) return null;
			if (!line.trim()) continue;
			let obj: any;
			try {
				obj = JSON.parse(line);
			} catch {
				return null;
			}
			if (obj?.type !== "session") return null;
			return { parentSession: typeof obj.parentSession === "string" && obj.parentSession ? obj.parentSession : null };
		}
		return null;
	} catch {
		return null;
	} finally {
		rl.close();
		stream.destroy();
	}
}

// LOCAL PATCH 2 (ours): the entry ids of a file, used to recognise the verbatim
// prefix a forked file starts with. Only ancestors of scanned files are read, so
// this never walks the whole archive.
//
// Returns null when the file cannot be read, which the caller reports rather
// than treating as "nothing was inherited".
async function readEntryIds(filePath: string, signal?: AbortSignal): Promise<Set<string> | null> {
	const ids = new Set<string>();
	const stream = createReadStream(filePath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of rl) {
			if (signal?.aborted) return null;
			if (!line.trim()) continue;
			try {
				const obj = JSON.parse(line);
				if (obj?.id) ids.add(obj.id);
			} catch {
				// A malformed line cannot contribute an id; keep reading.
			}
		}
		return ids;
	} catch {
		return null;
	} finally {
		rl.close();
		stream.destroy();
	}
}

async function parseSessionFile(
	filePath: string,
	signal?: AbortSignal,
	// LOCAL PATCH 2: ids this file inherited from its ancestors. Entries carrying
	// one of these are copies of another file's entries, not requests this
	// session made, so they are skipped for every aggregate.
	inheritedIds?: ReadonlySet<string>,
	// LOCAL PATCH 2: the same header's `parentSession`, handed down by the lineage
	// walk so this function does not read the header a second time. Used only by
	// the dead-session filter below.
	parentSession?: string | null,
): Promise<ParsedSession | null> {
	const fileName = path.basename(filePath);
	let startedAt = parseSessionStartFromFilename(fileName);
	let currentModel: ModelKey | null = null;
	let currentModelIsFaux = false;
	let cwd: CwdKey | null = null;

	const modelsUsed = new Set<ModelKey>();
	// LOCAL PATCH 2: usage carried by entries inherited from an ancestor.
	const inherited = emptyInheritedTotals();
	let messages = 0;
	let tokens = 0;
	let totalCost = 0;
	const costByModel = new Map<ModelKey, number>();
	const messagesByModel = new Map<ModelKey, number>();
	const tokensByModel = new Map<ModelKey, number>();

	const stream = createReadStream(filePath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

	try {
		for await (const line of rl) {
			if (signal?.aborted) {
				rl.close();
				stream.destroy();
				return null;
			}
			if (!line) continue;
			let obj: any;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}

			if (obj?.type === "session") {
				if (!startedAt && typeof obj?.timestamp === "string") {
					const d = new Date(obj.timestamp);
					if (Number.isFinite(d.getTime())) startedAt = d;
				}
				if (typeof obj?.cwd === "string" && obj.cwd.trim()) {
					cwd = obj.cwd.trim();
				}
				// LOCAL PATCH 2: upstream reads the header and keeps only timestamp
				// and cwd. The `parentSession` it discards is the lineage link, read
				// once by resolveInheritedIds and passed in.
				continue;
			}

			// LOCAL PATCH 2: an inherited entry is a copy of an entry an ancestor
			// file already counts, so it is not this session's to bill. It is still
			// counted (entries += 1) rather than dropped, because the prefix carries
			// non-message entries too (model_change, thinking_level_change) and the
			// footer says "entries excluded". `model_change` state is likewise still
			// replayed from inherited entries — a forked child does not re-announce
			// its model — so only the accounting further down is skipped, never that
			// replay or the entries count.
			const inheritedEntry = inheritedIds !== undefined && obj?.id !== undefined && inheritedIds.has(obj.id);
			if (inheritedEntry) {
				inherited.entries += 1;
			}

			if (obj?.type === "model_change") {
				if (isFauxModelReference({ api: obj.api, provider: obj.provider, modelId: obj.modelId })) {
					currentModel = null;
					currentModelIsFaux = true;
					continue;
				}

				// A model change alone does not mean the model was used: sessions often
				// start on a default model and switch before sending anything. Only
				// count a model once it actually produced a message.
				currentModel = modelKeyFromParts(obj.provider, obj.modelId);
				currentModelIsFaux = false;
				continue;
			}

			if (obj?.type !== "message") continue;

			const { api, provider, model, modelId, usage } = extractProviderModelAndUsage(obj);
			const explicitMk = modelKeyFromParts(provider, model) ?? modelKeyFromParts(provider, modelId);
			if (isFauxModelReference({ api, provider, model, modelId })) {
				currentModel = null;
				currentModelIsFaux = true;
				continue;
			}
			if (!explicitMk && currentModelIsFaux) continue;

			const mk = explicitMk ?? currentModel ?? "unknown";
			const tok = extractTokensTotal(usage);
			const cost = extractCostTotal(usage);

			// LOCAL PATCH 2: record what the inherited entry carried, then skip the
			// message/token/cost aggregates — see the inherited-entry comment above.
			if (inheritedEntry) {
				inherited.tokens += tok;
				inherited.cost += cost;
				continue;
			}

			if (explicitMk) {
				currentModel = explicitMk;
				currentModelIsFaux = false;
			}
			const role = obj?.message?.role ?? obj?.role;
			if (explicitMk || role === "assistant") modelsUsed.add(mk);

			messages += 1;
			messagesByModel.set(mk, (messagesByModel.get(mk) ?? 0) + 1);

			if (tok > 0) {
				tokens += tok;
				tokensByModel.set(mk, (tokensByModel.get(mk) ?? 0) + tok);
			}

			if (cost > 0) {
				totalCost += cost;
				costByModel.set(mk, (costByModel.get(mk) ?? 0) + cost);
			}
		}
	} catch {
		// LOCAL PATCH 2: one vanished file must not cost the whole report.
		//
		// Upstream wraps this loop in try/finally with no catch, so a stream error
		// propagates out of computeBreakdown and the interactive path shows "Failed to
		// analyze sessions" for the entire 90 days. That is not a theoretical race
		// here: `subagent_clean --delete-files` removes run dirs under the very tree
		// being walked, pi's `_rewriteFile` truncates a file before rewriting it, and
		// this function's own header reader — called microseconds earlier for the same
		// path — already degrades to null on any error. Skipping the file is the
		// behaviour every other read path here already has.
		return null;
	} finally {
		rl.close();
		stream.destroy();
	}

	// Skip dead sessions: nothing was ever answered by a model.
	//
	// LOCAL PATCH 2: a fork that inherited its parent's every entry has an empty
	// `modelsUsed`, yet it is a session the user really started — a child seeded
	// from the parent branch and then abandoned. A declared `parentSession` is what
	// distinguishes that from a file that genuinely never spoke to a model.
	if (!startedAt || (modelsUsed.size === 0 && !parentSession)) return null;
	const dayKeyLocal = toLocalDayKey(startedAt);
	const dow = DOW_NAMES[mondayIndex(startedAt)];
	const tod = todBucketForHour(startedAt.getHours());
	return {
		filePath,
		startedAt,
		dayKeyLocal,
		cwd,
		dow,
		tod,
		modelsUsed,
		messages,
		tokens,
		totalCost,
		costByModel,
		messagesByModel,
		tokensByModel,
		inherited,
	};
}

function buildRangeAgg(days: number, now: Date): RangeAgg {
	const end = localMidnight(now);
	const start = addDaysLocal(end, -(days - 1));
	const outDays: DayAgg[] = [];
	const dayByKey = new Map<string, DayAgg>();

	for (let i = 0; i < days; i++) {
		const d = addDaysLocal(start, i);
		const dayKeyLocal = toLocalDayKey(d);
		const day: DayAgg = {
			date: d,
			dayKeyLocal,
			sessions: 0,
			messages: 0,
			tokens: 0,
			totalCost: 0,
			costByModel: new Map(),
			sessionsByModel: new Map(),
			messagesByModel: new Map(),
			tokensByModel: new Map(),
			groupedCostByModel: new Map(),
			groupedSessionsByModel: new Map(),
			groupedMessagesByModel: new Map(),
			groupedTokensByModel: new Map(),
			sessionsByCwd: new Map(),
			messagesByCwd: new Map(),
			tokensByCwd: new Map(),
			costByCwd: new Map(),
			sessionsByTod: new Map(),
			messagesByTod: new Map(),
			tokensByTod: new Map(),
			costByTod: new Map(),
		};
		outDays.push(day);
		dayByKey.set(dayKeyLocal, day);
	}

	return {
		days: outDays,
		dayByKey,
		sessions: 0,
		totalMessages: 0,
		totalTokens: 0,
		totalCost: 0,
		modelCost: new Map(),
		modelSessions: new Map(),
		modelMessages: new Map(),
		modelTokens: new Map(),
		groupedModelCost: new Map(),
		groupedModelSessions: new Map(),
		groupedModelMessages: new Map(),
		groupedModelTokens: new Map(),
		cwdCost: new Map(),
		cwdSessions: new Map(),
		cwdMessages: new Map(),
		cwdTokens: new Map(),
		dowCost: new Map(),
		dowSessions: new Map(),
		dowMessages: new Map(),
		dowTokens: new Map(),
		todCost: new Map(),
		todSessions: new Map(),
		todMessages: new Map(),
		todTokens: new Map(),
	};
}

function addSessionToRange(range: RangeAgg, session: ParsedSession): void {
	const day = range.dayByKey.get(session.dayKeyLocal);
	if (!day) return;

	range.sessions += 1;
	range.totalMessages += session.messages;
	range.totalTokens += session.tokens;
	range.totalCost += session.totalCost;
	day.sessions += 1;
	day.messages += session.messages;
	day.tokens += session.tokens;
	day.totalCost += session.totalCost;

	// Sessions-per-model (presence)
	for (const mk of session.modelsUsed) {
		day.sessionsByModel.set(mk, (day.sessionsByModel.get(mk) ?? 0) + 1);
		range.modelSessions.set(mk, (range.modelSessions.get(mk) ?? 0) + 1);
	}

	// Messages-per-model
	for (const [mk, n] of session.messagesByModel.entries()) {
		day.messagesByModel.set(mk, (day.messagesByModel.get(mk) ?? 0) + n);
		range.modelMessages.set(mk, (range.modelMessages.get(mk) ?? 0) + n);
	}

	// Tokens-per-model
	for (const [mk, n] of session.tokensByModel.entries()) {
		day.tokensByModel.set(mk, (day.tokensByModel.get(mk) ?? 0) + n);
		range.modelTokens.set(mk, (range.modelTokens.get(mk) ?? 0) + n);
	}

	// Cost-per-model
	for (const [mk, cost] of session.costByModel.entries()) {
		day.costByModel.set(mk, (day.costByModel.get(mk) ?? 0) + cost);
		range.modelCost.set(mk, (range.modelCost.get(mk) ?? 0) + cost);
	}

	// Provider-agnostic (grouped) model aggregation.
	// Collapse `${provider}/${model}` → `${model}` and de-duplicate session presence.
	const groupedModels = new Set<ModelKey>();
	for (const mk of session.modelsUsed) groupedModels.add(displayModelName(mk));
	for (const gk of groupedModels) {
		day.groupedSessionsByModel.set(gk, (day.groupedSessionsByModel.get(gk) ?? 0) + 1);
		range.groupedModelSessions.set(gk, (range.groupedModelSessions.get(gk) ?? 0) + 1);
	}
	for (const [mk, n] of session.messagesByModel.entries()) {
		const gk = displayModelName(mk);
		day.groupedMessagesByModel.set(gk, (day.groupedMessagesByModel.get(gk) ?? 0) + n);
		range.groupedModelMessages.set(gk, (range.groupedModelMessages.get(gk) ?? 0) + n);
	}
	for (const [mk, n] of session.tokensByModel.entries()) {
		const gk = displayModelName(mk);
		day.groupedTokensByModel.set(gk, (day.groupedTokensByModel.get(gk) ?? 0) + n);
		range.groupedModelTokens.set(gk, (range.groupedModelTokens.get(gk) ?? 0) + n);
	}
	for (const [mk, cost] of session.costByModel.entries()) {
		const gk = displayModelName(mk);
		day.groupedCostByModel.set(gk, (day.groupedCostByModel.get(gk) ?? 0) + cost);
		range.groupedModelCost.set(gk, (range.groupedModelCost.get(gk) ?? 0) + cost);
	}

	// CWD aggregation
	const cwd = session.cwd;
	if (cwd) {
		day.sessionsByCwd.set(cwd, (day.sessionsByCwd.get(cwd) ?? 0) + 1);
		range.cwdSessions.set(cwd, (range.cwdSessions.get(cwd) ?? 0) + 1);
		day.messagesByCwd.set(cwd, (day.messagesByCwd.get(cwd) ?? 0) + session.messages);
		range.cwdMessages.set(cwd, (range.cwdMessages.get(cwd) ?? 0) + session.messages);
		day.tokensByCwd.set(cwd, (day.tokensByCwd.get(cwd) ?? 0) + session.tokens);
		range.cwdTokens.set(cwd, (range.cwdTokens.get(cwd) ?? 0) + session.tokens);
		day.costByCwd.set(cwd, (day.costByCwd.get(cwd) ?? 0) + session.totalCost);
		range.cwdCost.set(cwd, (range.cwdCost.get(cwd) ?? 0) + session.totalCost);
	}

	// Day-of-week aggregation
	const dow = session.dow;
	range.dowSessions.set(dow, (range.dowSessions.get(dow) ?? 0) + 1);
	range.dowMessages.set(dow, (range.dowMessages.get(dow) ?? 0) + session.messages);
	range.dowTokens.set(dow, (range.dowTokens.get(dow) ?? 0) + session.tokens);
	range.dowCost.set(dow, (range.dowCost.get(dow) ?? 0) + session.totalCost);

	// Time-of-day aggregation
	const tod = session.tod;
	day.sessionsByTod.set(tod, (day.sessionsByTod.get(tod) ?? 0) + 1);
	day.messagesByTod.set(tod, (day.messagesByTod.get(tod) ?? 0) + session.messages);
	day.tokensByTod.set(tod, (day.tokensByTod.get(tod) ?? 0) + session.tokens);
	day.costByTod.set(tod, (day.costByTod.get(tod) ?? 0) + session.totalCost);
	range.todSessions.set(tod, (range.todSessions.get(tod) ?? 0) + 1);
	range.todMessages.set(tod, (range.todMessages.get(tod) ?? 0) + session.messages);
	range.todTokens.set(tod, (range.todTokens.get(tod) ?? 0) + session.tokens);
	range.todCost.set(tod, (range.todCost.get(tod) ?? 0) + session.totalCost);
}

function sortMapByValueDesc<K extends string>(m: Map<K, number>): Array<{ key: K; value: number }> {
	return [...m.entries()]
		.map(([key, value]) => ({ key, value }))
		.sort((a, b) => b.value - a.value);
}

function choosePaletteFromLast30Days(range30: RangeAgg, topN = 4, groupProviders = false): {
	modelColors: Map<ModelKey, RGB>;
	otherColor: RGB;
	orderedModels: ModelKey[];
} {
	const modelCost = groupProviders ? range30.groupedModelCost : range30.modelCost;
	const modelTokens = groupProviders ? range30.groupedModelTokens : range30.modelTokens;
	const modelMessages = groupProviders ? range30.groupedModelMessages : range30.modelMessages;
	const modelSessions = groupProviders ? range30.groupedModelSessions : range30.modelSessions;

	// Prefer cost if any cost exists, else tokens, else messages, else sessions.
	const costSum = [...modelCost.values()].reduce((a, b) => a + b, 0);
	const popularity =
		costSum > 0
			? modelCost
			: range30.totalTokens > 0
				? modelTokens
				: range30.totalMessages > 0
					? modelMessages
					: modelSessions;

	const sorted = sortMapByValueDesc(popularity);
	const orderedModels = sorted.slice(0, topN).map((x) => x.key);
	const modelColors = new Map<ModelKey, RGB>();
	for (let i = 0; i < orderedModels.length; i++) {
		modelColors.set(orderedModels[i], PALETTE[i % PALETTE.length]);
	}
	return {
		modelColors,
		otherColor: { r: 160, g: 160, b: 160 },
		orderedModels,
	};
}

function chooseCwdPaletteFromLast30Days(range30: RangeAgg, topN = 4): {
	cwdColors: Map<CwdKey, RGB>;
	otherColor: RGB;
	orderedCwds: CwdKey[];
} {
	const costSum = [...range30.cwdCost.values()].reduce((a, b) => a + b, 0);
	const popularity =
		costSum > 0
			? range30.cwdCost
			: range30.totalTokens > 0
				? range30.cwdTokens
				: range30.totalMessages > 0
					? range30.cwdMessages
					: range30.cwdSessions;

	const sorted = sortMapByValueDesc(popularity);
	const orderedCwds = sorted.slice(0, topN).map((x) => x.key);
	const cwdColors = new Map<CwdKey, RGB>();
	for (let i = 0; i < orderedCwds.length; i++) {
		cwdColors.set(orderedCwds[i], PALETTE[i % PALETTE.length]);
	}
	return {
		cwdColors,
		otherColor: { r: 160, g: 160, b: 160 },
		orderedCwds,
	};
}

// Fixed palette for day-of-week: weekdays get cool tones, weekend gets warm
const DOW_PALETTE: RGB[] = [
	{ r: 47, g: 129, b: 247 },  // Mon – blue
	{ r: 64, g: 196, b: 99 },   // Tue – green
	{ r: 163, g: 113, b: 247 }, // Wed – purple
	{ r: 47, g: 175, b: 200 },  // Thu – teal
	{ r: 100, g: 200, b: 150 }, // Fri – mint
	{ r: 255, g: 159, b: 10 },  // Sat – orange
	{ r: 244, g: 67, b: 54 },   // Sun – red
];

function buildDowPalette(): { dowColors: Map<DowKey, RGB>; orderedDows: DowKey[] } {
	const dowColors = new Map<DowKey, RGB>();
	for (let i = 0; i < DOW_NAMES.length; i++) {
		dowColors.set(DOW_NAMES[i], DOW_PALETTE[i]);
	}
	return { dowColors, orderedDows: [...DOW_NAMES] };
}

// Fixed palette for time-of-day buckets
const TOD_PALETTE: Map<TodKey, RGB> = new Map([
	["after-midnight", { r: 100, g: 60, b: 180 }],  // deep purple
	["morning", { r: 255, g: 200, b: 50 }],          // golden yellow
	["afternoon", { r: 64, g: 196, b: 99 }],         // green
	["evening", { r: 47, g: 129, b: 247 }],           // blue
	["night", { r: 60, g: 40, b: 140 }],              // dark indigo
]);

function buildTodPalette(): { todColors: Map<TodKey, RGB>; orderedTods: TodKey[] } {
	const todColors = new Map<TodKey, RGB>();
	const orderedTods: TodKey[] = [];
	for (const b of TOD_BUCKETS) {
		const c = TOD_PALETTE.get(b.key);
		if (c) todColors.set(b.key, c);
		orderedTods.push(b.key);
	}
	return { todColors, orderedTods };
}

function dayMixedColor(
	day: DayAgg,
	colorMap: Map<string, RGB>,
	otherColor: RGB,
	mode: MeasurementMode,
	view: BreakdownView = "model",
	groupProviders = false,
): RGB {
	const parts: Array<{ color: RGB; weight: number }> = [];
	let otherWeight = 0;

	let map: Map<string, number>;
	if (view === "dow") {
		// For dow, each day IS a single dow – use the dow color directly
		const dowKey = DOW_NAMES[mondayIndex(day.date)];
		const c = colorMap.get(dowKey);
		return c ?? otherColor;
	} else if (view === "tod") {
		if (mode === "tokens") {
			map = day.tokens > 0 ? day.tokensByTod : day.messages > 0 ? day.messagesByTod : day.sessionsByTod;
		} else if (mode === "messages") {
			map = day.messages > 0 ? day.messagesByTod : day.sessionsByTod;
		} else {
			map = day.sessionsByTod;
		}
	} else if (view === "cwd") {
		if (mode === "tokens") {
			map = day.tokens > 0 ? day.tokensByCwd : day.messages > 0 ? day.messagesByCwd : day.sessionsByCwd;
		} else if (mode === "messages") {
			map = day.messages > 0 ? day.messagesByCwd : day.sessionsByCwd;
		} else {
			map = day.sessionsByCwd;
		}
	} else {
		const sByModel = groupProviders ? day.groupedSessionsByModel : day.sessionsByModel;
		const mByModel = groupProviders ? day.groupedMessagesByModel : day.messagesByModel;
		const tByModel = groupProviders ? day.groupedTokensByModel : day.tokensByModel;
		if (mode === "tokens") {
			map = day.tokens > 0 ? tByModel : day.messages > 0 ? mByModel : sByModel;
		} else if (mode === "messages") {
			map = day.messages > 0 ? mByModel : sByModel;
		} else {
			map = sByModel;
		}
	}

	for (const [mk, w] of map.entries()) {
		const c = colorMap.get(mk);
		if (c) parts.push({ color: c, weight: w });
		else otherWeight += w;
	}
	if (otherWeight > 0) parts.push({ color: otherColor, weight: otherWeight });
	return weightedMix(parts);
}

function graphMetricForRange(
	range: RangeAgg,
	mode: MeasurementMode,
): { kind: "sessions" | "messages" | "tokens"; max: number; denom: number } {
	if (mode === "tokens") {
		const maxTokens = Math.max(0, ...range.days.map((d) => d.tokens));
		if (maxTokens > 0) return { kind: "tokens", max: maxTokens, denom: Math.log1p(maxTokens) };
		// fall back if tokens aren't available
		mode = "messages";
	}

	if (mode === "messages") {
		const maxMessages = Math.max(0, ...range.days.map((d) => d.messages));
		if (maxMessages > 0) return { kind: "messages", max: maxMessages, denom: Math.log1p(maxMessages) };
		// fall back if messages aren't available
		mode = "sessions";
	}

	const maxSessions = Math.max(0, ...range.days.map((d) => d.sessions));
	return { kind: "sessions", max: maxSessions, denom: Math.log1p(maxSessions) };
}

function weeksForRange(range: RangeAgg): number {
	const days = range.days;
	const start = days[0].date;
	const end = days[days.length - 1].date;
	const gridStart = addDaysLocal(start, -mondayIndex(start));
	const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
	const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
	return Math.ceil(totalGridDays / 7);
}

function renderGraphLines(
	range: RangeAgg,
	colorMap: Map<string, RGB>,
	otherColor: RGB,
	mode: MeasurementMode,
	options?: { cellWidth?: number; gap?: number },
	view: BreakdownView = "model",
	groupProviders = false,
): string[] {
	const days = range.days;
	const start = days[0].date;
	const end = days[days.length - 1].date;

	const gridStart = addDaysLocal(start, -mondayIndex(start));
	const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
	const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
	const weeks = Math.ceil(totalGridDays / 7);

	const cellWidth = Math.max(1, Math.floor(options?.cellWidth ?? 1));
	const gap = Math.max(0, Math.floor(options?.gap ?? 1));
	const block = "█".repeat(cellWidth);
	const gapStr = " ".repeat(gap);

	const metric = graphMetricForRange(range, mode);
	const denom = metric.denom;

	// Label only Mon/Wed/Fri like GitHub (saves space)
	const labelByRow = new Map<number, string>([
		[0, "Mon"],
		[2, "Wed"],
		[4, "Fri"],
	]);

	const lines: string[] = [];
	for (let row = 0; row < 7; row++) {
		const label = labelByRow.get(row);
		let line = label ? padRight(label, 3) + " " : "    ";

		for (let w = 0; w < weeks; w++) {
			const cellDate = addDaysLocal(gridStart, w * 7 + row);
			const inRange = cellDate >= start && cellDate <= end;
			const colGap = w < weeks - 1 ? gapStr : "";
			if (!inRange) {
				line += " ".repeat(cellWidth) + colGap;
				continue;
			}

			const key = toLocalDayKey(cellDate);
			const day = range.dayByKey.get(key);
			const value =
				metric.kind === "tokens"
					? (day?.tokens ?? 0)
					: metric.kind === "messages"
						? (day?.messages ?? 0)
						: (day?.sessions ?? 0);

			if (!day || value <= 0) {
				line += ansiFg(EMPTY_CELL_BG, block) + colGap;
				continue;
			}

			const hue = dayMixedColor(day, colorMap, otherColor, mode, view, groupProviders);
			let t = denom > 0 ? Math.log1p(value) / denom : 0;
			t = clamp01(t);
			const minVisible = 0.2;
			const intensity = minVisible + (1 - minVisible) * t;
			const rgb = mixRgb(DEFAULT_BG, hue, intensity);
			line += ansiFg(rgb, block) + colGap;
		}

		lines.push(line);
	}

	return lines;
}

function displayModelName(modelKey: string): string {
	const idx = modelKey.indexOf("/");
	return idx === -1 ? modelKey : modelKey.slice(idx + 1);
}

function renderLegendItems(modelColors: Map<ModelKey, RGB>, orderedModels: ModelKey[], otherColor: RGB): string[] {
	const items: string[] = [];
	for (const mk of orderedModels) {
		const c = modelColors.get(mk);
		if (!c) continue;
		items.push(`${ansiFg(c, "█")} ${displayModelName(mk)}`);
	}
	items.push(`${ansiFg(otherColor, "█")} other`);
	return items;
}

function fitRight(text: string, width: number): string {
	if (width <= 0) return "";
	let w = visibleWidth(text);
	let t = text;
	if (w > width) {
		t = sliceByColumn(t, w - width, width, true);
		w = visibleWidth(t);
	}
	return " ".repeat(Math.max(0, width - w)) + t;
}

function renderLegendBlock(leftLabel: string, items: string[], width: number): string[] {
	if (width <= 0) return [];
	if (items.length === 0) return [truncateToWidth(leftLabel, width)];

	const lines: string[] = [];
	// First line: label on left, first item right-aligned into remaining space.
	const leftW = visibleWidth(leftLabel);
	if (leftW >= width) {
		lines.push(truncateToWidth(leftLabel, width));
		// Put all items on their own lines right-aligned.
		for (const it of items) lines.push(fitRight(it, width));
		return lines;
	}

	const remaining = Math.max(0, width - leftW);
	lines.push(leftLabel + fitRight(items[0], remaining));

	for (let i = 1; i < items.length; i++) {
		lines.push(fitRight(items[i], width));
	}
	return lines;
}

function renderModelTable(range: RangeAgg, mode: MeasurementMode, maxRows = 8, groupProviders = false): string[] {
	// Keep this relatively narrow: model + selected metric + cost + cost/session + share.
	const metric = graphMetricForRange(range, mode);
	const kind = metric.kind;

	const modelCost = groupProviders ? range.groupedModelCost : range.modelCost;
	const modelSessions = groupProviders ? range.groupedModelSessions : range.modelSessions;
	const modelMessages = groupProviders ? range.groupedModelMessages : range.modelMessages;
	const modelTokens = groupProviders ? range.groupedModelTokens : range.modelTokens;

	let perModel: Map<ModelKey, number>;
	let total = 0;
	let label = kind;

	if (kind === "tokens") {
		perModel = modelTokens;
		total = range.totalTokens;
	} else if (kind === "messages") {
		perModel = modelMessages;
		total = range.totalMessages;
	} else {
		perModel = modelSessions;
		total = range.sessions;
	}

	const sorted = sortMapByValueDesc(perModel);
	const rows = sorted.slice(0, maxRows);

	const valueWidth = kind === "tokens" ? 10 : 8;
	const modelWidth = Math.min(52, Math.max("model".length, ...rows.map((r) => r.key.length)));

	const lines: string[] = [];
	lines.push(`${padRight("model", modelWidth)}  ${padLeft(label, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("cost/s", 8)}  ${padLeft("share", 6)}`);
	lines.push(`${"-".repeat(modelWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(8)}  ${"-".repeat(6)}`);

	for (const r of rows) {
		const value = perModel.get(r.key) ?? 0;
		const cost = modelCost.get(r.key) ?? 0;
		const sess = modelSessions.get(r.key) ?? 0;
		const costPerSession = sess > 0 ? formatUsd(cost / sess) : "-";
		const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
		lines.push(
			`${padRight(r.key.slice(0, modelWidth), modelWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(costPerSession, 8)}  ${padLeft(share, 6)}`,
		);
	}

	if (sorted.length === 0) {
		lines.push(dim("(no model data found)"));
	}

	return lines;
}

function renderCwdTable(range: RangeAgg, mode: MeasurementMode, maxRows = 8): string[] {
	const metric = graphMetricForRange(range, mode);
	const kind = metric.kind;

	let perCwd: Map<CwdKey, number>;
	let total = 0;
	let label = kind;

	if (kind === "tokens") {
		perCwd = range.cwdTokens;
		total = range.totalTokens;
	} else if (kind === "messages") {
		perCwd = range.cwdMessages;
		total = range.totalMessages;
	} else {
		perCwd = range.cwdSessions;
		total = range.sessions;
	}

	const sorted = sortMapByValueDesc(perCwd);
	const rows = sorted.slice(0, maxRows);

	const valueWidth = kind === "tokens" ? 10 : 8;
	const displayPaths = rows.map((r) => abbreviatePath(r.key, 40));
	const cwdWidth = Math.min(42, Math.max("directory".length, ...displayPaths.map((p) => p.length)));

	const lines: string[] = [];
	lines.push(`${padRight("directory", cwdWidth)}  ${padLeft(label, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("cost/s", 8)}  ${padLeft("share", 6)}`);
	lines.push(`${"-".repeat(cwdWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(8)}  ${"-".repeat(6)}`);

	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		const value = perCwd.get(r.key) ?? 0;
		const cost = range.cwdCost.get(r.key) ?? 0;
		const sess = range.cwdSessions.get(r.key) ?? 0;
		const costPerSession = sess > 0 ? formatUsd(cost / sess) : "-";
		const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
		lines.push(
			`${padRight(displayPaths[i].slice(0, cwdWidth), cwdWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(costPerSession, 8)}  ${padLeft(share, 6)}`,
		);
	}

	if (sorted.length === 0) {
		lines.push(dim("(no directory data found)"));
	}

	return lines;
}

function dowMetricForRange(
	range: RangeAgg,
	mode: MeasurementMode,
): { kind: "sessions" | "messages" | "tokens"; perDow: Map<DowKey, number>; total: number } {
	const metric = graphMetricForRange(range, mode);
	const kind = metric.kind;

	if (kind === "tokens") {
		return { kind, perDow: range.dowTokens, total: range.totalTokens };
	}
	if (kind === "messages") {
		return { kind, perDow: range.dowMessages, total: range.totalMessages };
	}
	return { kind, perDow: range.dowSessions, total: range.sessions };
}

function renderDowDistributionLines(
	range: RangeAgg,
	mode: MeasurementMode,
	dowColors: Map<DowKey, RGB>,
	width: number,
): string[] {
	const { kind, perDow, total } = dowMetricForRange(range, mode);
	const dayWidth = 3;
	const pctWidth = 4; // "100%"
	const valueWidth = kind === "tokens" ? 10 : 8;
	const showValue = width >= dayWidth + 1 + 10 + 1 + pctWidth + 1 + valueWidth;
	const fixedWidth = dayWidth + 1 + 1 + pctWidth + (showValue ? 1 + valueWidth : 0);
	const barWidth = Math.max(1, width - fixedWidth);
	const fallbackColor: RGB = { r: 160, g: 160, b: 160 };

	const lines: string[] = [];
	for (const dow of DOW_NAMES) {
		const value = perDow.get(dow) ?? 0;
		const share = total > 0 ? value / total : 0;
		let filled = share > 0 ? Math.round(share * barWidth) : 0;
		if (share > 0) filled = Math.max(1, filled);
		filled = Math.min(barWidth, filled);
		const empty = Math.max(0, barWidth - filled);

		const color = dowColors.get(dow) ?? fallbackColor;
		const filledBar = filled > 0 ? ansiFg(color, "█".repeat(filled)) : "";
		const emptyBar = empty > 0 ? ansiFg(EMPTY_CELL_BG, "█".repeat(empty)) : "";
		const pct = padLeft(`${Math.round(share * 100)}%`, pctWidth);

		let line = `${padRight(dow, dayWidth)} ${filledBar}${emptyBar} ${pct}`;
		if (showValue) line += ` ${padLeft(formatCount(value), valueWidth)}`;
		lines.push(line);
	}

	return lines;
}

function renderDowTable(range: RangeAgg, mode: MeasurementMode): string[] {
	const { kind, perDow, total } = dowMetricForRange(range, mode);
	const valueWidth = kind === "tokens" ? 10 : 8;
	const dowWidth = 5; // "day  "

	const lines: string[] = [];
	lines.push(`${padRight("day", dowWidth)}  ${padLeft(kind, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("cost/s", 8)}  ${padLeft("share", 6)}`);
	lines.push(`${"-".repeat(dowWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(8)}  ${"-".repeat(6)}`);

	// Always show in Mon–Sun order
	for (const dow of DOW_NAMES) {
		const value = perDow.get(dow) ?? 0;
		const cost = range.dowCost.get(dow) ?? 0;
		const sess = range.dowSessions.get(dow) ?? 0;
		const costPerSession = sess > 0 ? formatUsd(cost / sess) : "-";
		const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
		lines.push(
			`${padRight(dow, dowWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(costPerSession, 8)}  ${padLeft(share, 6)}`,
		);
	}

	return lines;
}

function renderTodTable(range: RangeAgg, mode: MeasurementMode): string[] {
	const metric = graphMetricForRange(range, mode);
	const kind = metric.kind;

	let perTod: Map<TodKey, number>;
	let total = 0;

	if (kind === "tokens") {
		perTod = range.todTokens;
		total = range.totalTokens;
	} else if (kind === "messages") {
		perTod = range.todMessages;
		total = range.totalMessages;
	} else {
		perTod = range.todSessions;
		total = range.sessions;
	}

	const valueWidth = kind === "tokens" ? 10 : 8;
	const todWidth = 22; // widest label

	const lines: string[] = [];
	lines.push(`${padRight("time of day", todWidth)}  ${padLeft(kind, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("cost/s", 8)}  ${padLeft("share", 6)}`);
	lines.push(`${"-".repeat(todWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(8)}  ${"-".repeat(6)}`);

	// Always show in chronological order
	for (const b of TOD_BUCKETS) {
		const value = perTod.get(b.key) ?? 0;
		const cost = range.todCost.get(b.key) ?? 0;
		const sess = range.todSessions.get(b.key) ?? 0;
		const costPerSession = sess > 0 ? formatUsd(cost / sess) : "-";
		const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
		lines.push(
			`${padRight(b.label, todWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(costPerSession, 8)}  ${padLeft(share, 6)}`,
		);
	}

	return lines;
}

function renderLeftRight(left: string, right: string, width: number): string {
	const leftW = visibleWidth(left);
	if (width <= 0) return "";
	if (leftW >= width) return truncateToWidth(left, width);

	const remaining = width - leftW;
	let rightText = right;
	const rightW = visibleWidth(rightText);
	if (rightW > remaining) {
		// Keep the *rightmost* part visible.
		rightText = sliceByColumn(rightText, rightW - remaining, remaining, true);
	}
	const pad = Math.max(0, remaining - visibleWidth(rightText));
	return left + " ".repeat(pad) + rightText;
}

// LOCAL PATCH 3 (ours): say what was excluded, next to the number. Two decisions
// this extension makes are invisible in the totals — child transcripts are now
// part of the scan (LOCAL PATCH 1) and an inherited prefix is not a request this
// session made (LOCAL PATCH 2) — and someone comparing a day against an invoice
// has no way to know either happened, so one dimmed line under the summary
// carries them. Every clause is conditional on the thing it reports actually
// having happened — a footer that cries wolf is a footer nobody reads:
//   - `child transcripts` only when a file outside sessions/ was scanned.
//   - the exclusion clause only when entries were actually excluded: a `lineage`
//     child whose parent has since been deleted inherits nothing.
//   - the uncertainty clause only when a header or parent chain was unreadable.
//     Such a file is half-measured at worst, which errs towards counting too
//     much, but a half-measurement must not be silent either.
//
// The amount is the excluded usage; cost when there is any, tokens otherwise,
// because a local or zero-priced model reports $0.00 for megabytes of context
// and "$0.0000 excluded" says nothing. The parent clause says "when it is in
// range" because the excluded copy is counted by the parent's own file, which
// may be outside the displayed window or older than the archive.
function inheritedNote(inherited: InheritedReport): string | null {
	const { childSessions, forkedSessions, entries, tokens, cost, unknownLineage } = inherited;
	if (childSessions === 0 && forkedSessions === 0 && unknownLineage === 0) return null;

	const parts: string[] = [];
	if (childSessions > 0) parts.push(`${formatCount(childSessions)} child transcript${childSessions === 1 ? "" : "s"}`);
	if (forkedSessions > 0 && entries > 0) {
		const amount = cost > 0 ? formatUsd(cost) : `${formatCount(tokens)} tokens`;
		parts.push(
			`${formatCount(forkedSessions)} forked session${forkedSessions === 1 ? "" : "s"}, ${formatCount(entries)} inherited entr${entries === 1 ? "y" : "ies"} excluded (${amount}, counted in the parent when it is in range)`,
		);
	}
	if (unknownLineage > 0) {
		// NOT "counted in full": a half-walked chain is both excluded and uncertain —
		// its own prefix was dropped where the ancestor could be read, and whatever
		// could not be resolved stayed in. So this says the lineage was incomplete,
		// which is the thing that is actually true, and leaves the direction of the
		// error to the reader (it is always towards counting more, never less).
		parts.push(`${unknownLineage} with unreadable header or parent, lineage incomplete`);
	}
	if (parts.length === 0) return null;
	return `last 90 days · ${parts.join(" · ")}`;
}

function rangeSummary(range: RangeAgg, days: number, mode: MeasurementMode): string {
	const avg = range.sessions > 0 ? range.totalCost / range.sessions : 0;
	const costPart = range.totalCost > 0 ? `${formatUsd(range.totalCost)} · avg ${formatUsd(avg)}/session` : `$0.0000`;

	if (mode === "tokens") {
		return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalTokens)} tokens · ${costPart}`;
	}
	if (mode === "messages") {
		return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalMessages)} messages · ${costPart}`;
	}
	return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${costPart}`;
}

// LOCAL PATCH 2 (ours): resolve the entries a file inherited.
//
// A forked session file starts with a verbatim copy of its parent's live branch,
// entry ids included, so the copy is recognisable without trusting anyone's
// bookkeeping: collect the ids of every ancestor on the `parentSession` chain
// and let the parser skip them.
//
// Four deliberate limits:
//   - The chain is followed by PATH, not by scanning for ids that happen to
//     match. A global `Set<entryId>` would be simpler and wrong: entry ids are
//     8 hex characters, collision-checked only within a single file, so at
//     ~50k entries a global set starts colliding and silently dropping real
//     usage. Scoping to one lineage keeps that collision space at hundreds.
//   - The chain is walked transitively, not just one level. pi's v1→v2 migration
//     (`migrateV1ToV2`) reissues every entry id and rewrites the file, so a
//     mid-generation session can stop containing ids its own child still holds;
//     only the grandparent's ids catch the rest of the prefix.
//   - Only ancestors of scanned files are read (cached per path), so this costs
//     a second pass over a handful of files, not a second walk of the archive.
//   - `broken` means the chain could not be walked: a parent deleted by
//     `subagent_clean --delete-files`, an `/import`ed transcript whose source is
//     gone, a cycle, an implausibly deep chain, or a file whose OWN header could
//     not be read — the last case matters, because pi's `_rewriteFile` truncates
//     before it writes, so a scan can catch a file mid-rewrite and would then
//     count an inherited prefix twice without knowing it. Whatever ids were
//     recovered are still excluded, and the caller reports the file rather than
//     quietly counting an unknown prefix as this session's own work.
const MAX_ANCESTOR_DEPTH = 64;

interface LineageResolution {
	/** This file's own `parentSession`, or null when it has none (or is unreadable). */
	parent: string | null;
	/** Ids owned by an ancestor. Empty when nothing was inherited. */
	ids: Set<string>;
	broken: boolean;
}

async function resolveInheritedIds(
	filePath: string,
	headerCache: Map<string, { parentSession: string | null } | null>,
	idCache: Map<string, Set<string> | null>,
	signal?: AbortSignal,
): Promise<LineageResolution> {
	const ids = new Set<string>();
	const seen = new Set<string>([filePath]);

	// The header of the file itself, then of each ancestor in turn.
	const first = await cachedHeader(filePath, headerCache, signal);
	if (!first) return { parent: null, ids, broken: true };
	let current = first.parentSession;

	for (let depth = 0; current; depth++) {
		if (depth >= MAX_ANCESTOR_DEPTH || seen.has(current)) return { parent: first.parentSession, ids, broken: true };
		seen.add(current);

		const ancestorIds = await cachedIds(current, idCache, signal);
		if (!ancestorIds) return { parent: first.parentSession, ids, broken: true };
		for (const id of ancestorIds) ids.add(id);

		const header = await cachedHeader(current, headerCache, signal);
		if (!header) return { parent: first.parentSession, ids, broken: true };
		current = header.parentSession;
	}

	return { parent: first.parentSession, ids, broken: false };
}

async function cachedHeader(
	filePath: string,
	cache: Map<string, { parentSession: string | null } | null>,
	signal?: AbortSignal,
): Promise<{ parentSession: string | null } | null> {
	if (!cache.has(filePath)) cache.set(filePath, await readSessionHeader(filePath, signal));
	return cache.get(filePath) ?? null;
}

async function cachedIds(
	filePath: string,
	cache: Map<string, Set<string> | null>,
	signal?: AbortSignal,
): Promise<Set<string> | null> {
	if (!cache.has(filePath)) cache.set(filePath, await readEntryIds(filePath, signal));
	return cache.get(filePath) ?? null;
}

async function computeBreakdown(
	signal?: AbortSignal,
	onProgress?: (update: Partial<BreakdownProgressState>) => void,
	// LOCAL PATCH 1/2: injectable roots and clock, so the aggregation is testable
	// over fixtures instead of the developer's real ~/.pi/agent tree.
	options: { roots?: string[]; now?: Date } = {},
): Promise<BreakdownData> {
	const now = options.now ?? new Date();
	const roots = options.roots ?? defaultSessionRoots();
	const ranges = new Map<number, RangeAgg>();
	for (const d of RANGE_DAYS) ranges.set(d, buildRangeAgg(d, now));
	const range90 = ranges.get(90)!;
	const start90 = range90.days[0].date;

	onProgress?.({ phase: "scan", foundFiles: 0, parsedFiles: 0, totalFiles: 0, currentFile: undefined });

	// LOCAL PATCH 1: one walk per root (sessions/, plus the child-session roots).
	// Which root a file came from is recorded, because LOCAL PATCH 3 has to be able
	// to say that child transcripts are in the graph at all — a workspace that only
	// ever launches `standalone` children has nothing to exclude, and would
	// otherwise get a silently inflated session count with no note at all.
	const candidates: Array<{ filePath: string; isChild: boolean }> = [];
	for (const [index, root] of roots.entries()) {
		const found = await walkSessionFiles(root, start90, signal, (count) => {
			onProgress?.({ phase: "scan", foundFiles: count });
		});
		for (const filePath of found) candidates.push({ filePath, isChild: index > 0 });
	}
	const paths = candidates.map((c) => c.filePath);

	const totalFiles = candidates.length;
	onProgress?.({
		phase: "parse",
		foundFiles: totalFiles,
		totalFiles,
		parsedFiles: 0,
		currentFile: totalFiles > 0 ? path.basename(paths[0]!) : undefined,
	});

	// LOCAL PATCH 2: lineage state for the scan.
	const headerCache = new Map<string, { parentSession: string | null } | null>();
	const idCache = new Map<string, Set<string> | null>();
	const inherited: InheritedReport = {
		entries: 0,
		tokens: 0,
		cost: 0,
		forkedSessions: 0,
		unknownLineage: 0,
		childSessions: 0,
	};

	let parsedFiles = 0;
	for (const { filePath, isChild } of candidates) {
		if (signal?.aborted) break;
		parsedFiles += 1;
		onProgress?.({ phase: "parse", parsedFiles, totalFiles, currentFile: path.basename(filePath) });

		// Every file gets a lineage resolution; for the overwhelming majority
		// (no `parentSession`) that is one header read and an empty id set.
		const lineage = await resolveInheritedIds(filePath, headerCache, idCache, signal);
		const session = await parseSessionFile(
			filePath,
			signal,
			lineage.ids.size > 0 ? lineage.ids : undefined,
			lineage.parent,
		);
		if (!session) continue;

		// LOCAL PATCH 3: the note is rendered as "last 90 days …", so it may only
		// count files that are inside the 90-day range. The walk's inclusion test and
		// the aggregation's day test do not always agree — a file reached by the
		// mtime fallback can be parsed and then attributed outside every window — and
		// counting those anyway would put a number on screen that describes a wider
		// period than the line claims.
		const sessionDay = localMidnight(session.startedAt);
		const days90 = range90.days;
		if (sessionDay < days90[0].date || sessionDay > days90[days90.length - 1].date) continue;

		if (isChild) inherited.childSessions += 1;
		if (lineage.broken) inherited.unknownLineage += 1;
		if (session.inherited.entries > 0) {
			inherited.forkedSessions += 1;
			inherited.entries += session.inherited.entries;
			inherited.tokens += session.inherited.tokens;
			inherited.cost += session.inherited.cost;
		}

		for (const d of RANGE_DAYS) {
			const range = ranges.get(d)!;
			const start = range.days[0].date;
			const end = range.days[range.days.length - 1].date;
			if (sessionDay < start || sessionDay > end) continue;
			addSessionToRange(range, session);
		}
	}

	onProgress?.({ phase: "finalize", currentFile: undefined });

	const palette = choosePaletteFromLast30Days(ranges.get(30)!, 4);
	const groupedPalette = choosePaletteFromLast30Days(ranges.get(30)!, 4, true);
	const cwdPalette = chooseCwdPaletteFromLast30Days(ranges.get(30)!, 4);
	const dowPalette = buildDowPalette();
	const todPalette = buildTodPalette();
	// LOCAL PATCH 2: `inherited` is window-scoped in spirit but cheap to keep
	// whole-scan, and it describes files, not days.
	return { generatedAt: now, ranges, palette, groupedPalette, cwdPalette, dowPalette, todPalette, inherited };
}

class BreakdownComponent implements Component {
	private data: BreakdownData;
	private tui: TUI;
	private onDone: () => void;
	private rangeIndex = 1; // default 30d
	private measurement: MeasurementMode = "sessions";
	private view: BreakdownView = "model";
	private splitProviders = false;
	private cachedWidth?: number;
	private cachedRows?: number;
	private cachedLines?: string[];

	constructor(data: BreakdownData, tui: TUI, onDone: () => void) {
		this.data = data;
		this.tui = tui;
		this.onDone = onDone;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedRows = undefined;
		this.cachedLines = undefined;
	}

	private tableMaxRows(): number {
		const rows = this.tui.terminal.rows || 0;
		if (rows <= 0) return 12;
		// Fixed chrome above/around the table: header, help, blank, summary,
		// blank, graph (7), blank, table header + divider (2), plus some margin.
		const overhead = 17;
		return Math.max(4, Math.min(12, rows - overhead));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "q") {
			this.onDone();
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || data.toLowerCase() === "t") {
			const order: MeasurementMode[] = ["sessions", "messages", "tokens"];
			const idx = Math.max(0, order.indexOf(this.measurement));
			const dir = matchesKey(data, Key.shift("tab")) ? -1 : 1;
			this.measurement = order[(idx + order.length + dir) % order.length] ?? "sessions";
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		const prev = () => {
			this.rangeIndex = (this.rangeIndex + RANGE_DAYS.length - 1) % RANGE_DAYS.length;
			this.invalidate();
			this.tui.requestRender();
		};
		const next = () => {
			this.rangeIndex = (this.rangeIndex + 1) % RANGE_DAYS.length;
			this.invalidate();
			this.tui.requestRender();
		};

		if (data.toLowerCase() === "p") {
			this.splitProviders = !this.splitProviders;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.left) || data.toLowerCase() === "h") prev();
		if (matchesKey(data, Key.right) || data.toLowerCase() === "l") next();

		if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data.toLowerCase() === "j" || data.toLowerCase() === "k") {
			const views: BreakdownView[] = ["model", "cwd", "dow", "tod"];
			const idx = views.indexOf(this.view);
			const dir = matchesKey(data, Key.up) || data.toLowerCase() === "k" ? -1 : 1;
			this.view = views[(idx + views.length + dir) % views.length] ?? "model";
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (data === "1") {
			this.rangeIndex = 0;
			this.invalidate();
			this.tui.requestRender();
		}
		if (data === "2") {
			this.rangeIndex = 1;
			this.invalidate();
			this.tui.requestRender();
		}
		if (data === "3") {
			this.rangeIndex = 2;
			this.invalidate();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const termRows = this.tui.terminal.rows || 0;
		if (this.cachedWidth === width && this.cachedRows === termRows && this.cachedLines) return this.cachedLines;

		const selectedDays = RANGE_DAYS[this.rangeIndex];
		const range = this.data.ranges.get(selectedDays)!;
		const metric = graphMetricForRange(range, this.measurement);

		const tab = (days: number, idx: number): string => {
			const selected = idx === this.rangeIndex;
			const label = `${days}d`;
			return selected ? bold(`[${label}]`) : dim(` ${label} `);
		};

		const metricTab = (mode: MeasurementMode, label: string): string => {
			const selected = mode === this.measurement;
			return selected ? bold(`[${label}]`) : dim(` ${label} `);
		};

		const viewTab = (v: BreakdownView, label: string): string => {
			const selected = v === this.view;
			return selected ? bold(`[${label}]`) : dim(` ${label} `);
		};

		const header =
			`${bold("Session breakdown")}  ${tab(7, 0)}${tab(30, 1)}${tab(90, 2)}  ` +
			`${metricTab("sessions", "sess")}${metricTab("messages", "msg")}${metricTab("tokens", "tok")}  ` +
			`${viewTab("model", "model")}${viewTab("cwd", "cwd")}${viewTab("dow", "dow")}${viewTab("tod", "tod")}`;

		// Choose colors and legend based on current view
		let activeColorMap: Map<string, RGB>;
		let activeOtherColor: RGB = { r: 160, g: 160, b: 160 };
		const legendItems: string[] = [];

		if (this.view === "model") {
			const pal = this.splitProviders ? this.data.palette : this.data.groupedPalette;
			activeColorMap = pal.modelColors;
			activeOtherColor = pal.otherColor;
			for (const mk of pal.orderedModels) {
				const c = activeColorMap.get(mk);
				if (c) legendItems.push(`${ansiFg(c, "█")} ${mk}`);
			}
			legendItems.push(`${ansiFg(activeOtherColor, "█")} other`);
		} else if (this.view === "cwd") {
			activeColorMap = this.data.cwdPalette.cwdColors;
			activeOtherColor = this.data.cwdPalette.otherColor;
			for (const cwd of this.data.cwdPalette.orderedCwds) {
				const c = activeColorMap.get(cwd);
				if (c) legendItems.push(`${ansiFg(c, "█")} ${abbreviatePath(cwd, 30)}`);
			}
			legendItems.push(`${ansiFg(activeOtherColor, "█")} other`);
		} else if (this.view === "dow") {
			activeColorMap = this.data.dowPalette.dowColors;
			for (const dow of this.data.dowPalette.orderedDows) {
				const c = activeColorMap.get(dow);
				if (c) legendItems.push(`${ansiFg(c, "█")} ${dow}`);
			}
		} else {
			activeColorMap = this.data.todPalette.todColors;
			for (const tod of this.data.todPalette.orderedTods) {
				const c = activeColorMap.get(tod);
				if (c) legendItems.push(`${ansiFg(c, "█")} ${todBucketLabel(tod)}`);
			}
		}

		const graphDescriptor = this.view === "dow" ? `share of ${metric.kind} by weekday` : `${metric.kind}/day`;
		const summary = rangeSummary(range, selectedDays, metric.kind) + dim(`   (graph: ${graphDescriptor})`);

		let graphLines: string[];
		if (this.view === "dow") {
			graphLines = renderDowDistributionLines(range, this.measurement, this.data.dowPalette.dowColors, width);
		} else {
			const maxScale = selectedDays === 7 ? 4 : selectedDays === 30 ? 3 : 2;
			const weeks = weeksForRange(range);
			const leftMargin = 4; // "Mon " (or 4 spaces)
			const gap = 1;
			const graphArea = Math.max(1, width - leftMargin);
			// Each week column uses: cellWidth + gap. Last column also gets gap (fine; we truncate anyway).
			const idealCellWidth = Math.floor((graphArea + gap) / Math.max(1, weeks)) - gap;
			const cellWidth = Math.min(maxScale, Math.max(1, idealCellWidth));

			graphLines = renderGraphLines(
				range,
				activeColorMap,
				activeOtherColor,
				this.measurement,
				{ cellWidth, gap },
				this.view,
				this.view === "model" && !this.splitProviders,
			);
		}
		const maxRows = this.tableMaxRows();
		const tableLines =
			this.view === "model" ? renderModelTable(range, metric.kind, maxRows, !this.splitProviders)
			: this.view === "cwd" ? renderCwdTable(range, metric.kind, maxRows)
			: this.view === "dow" ? renderDowTable(range, metric.kind)
			: renderTodTable(range, metric.kind);

		const lines: string[] = [];
		lines.push(truncateToWidth(header, width));
		lines.push(
			truncateToWidth(
				dim(`←/→ range · ↑/↓ view · tab metric · p providers (${this.splitProviders ? "split" : "grouped"}) · q to close`),
				width,
			),
		);
		lines.push("");
		lines.push(truncateToWidth(summary, width));
		// LOCAL PATCH 3 (ours): the inherited-context note.
		const note = inheritedNote(this.data.inherited);
		if (note) lines.push(truncateToWidth(dim(note), width));
		lines.push("");

		if (this.view === "dow") {
			for (const gl of graphLines) lines.push(truncateToWidth(gl, width));
		} else {
			// Render legend on the RIGHT of the graph if there is space.
			const graphWidth = Math.max(0, ...graphLines.map((l) => visibleWidth(l)));
			const sep = 2;
			const legendWidth = width - graphWidth - sep;
			const showSideLegend = legendWidth >= 22;

			if (showSideLegend) {
				const legendBlock: string[] = [];
				const legendTitle =
					this.view === "model" ? "Top models (30d palette):"
					: this.view === "cwd" ? "Top directories (30d palette):"
					: "Time of day:";
				legendBlock.push(dim(legendTitle));
				legendBlock.push(...legendItems);
				// Fit into 7 rows (same as graph). If too many, show a final "+N more" line.
				const maxLegendRows = graphLines.length;
				let legendLines = legendBlock.slice(0, maxLegendRows);
				if (legendBlock.length > maxLegendRows) {
					const remaining = legendBlock.length - (maxLegendRows - 1);
					legendLines = [...legendBlock.slice(0, maxLegendRows - 1), dim(`+${remaining} more`)];
				}
				while (legendLines.length < graphLines.length) legendLines.push("");

				const padRightAnsi = (s: string, target: number): string => {
					const w = visibleWidth(s);
					return w >= target ? s : s + " ".repeat(target - w);
				};

				for (let i = 0; i < graphLines.length; i++) {
					const left = padRightAnsi(graphLines[i] ?? "", graphWidth);
					const right = truncateToWidth(legendLines[i] ?? "", Math.max(0, legendWidth));
					lines.push(truncateToWidth(left + " ".repeat(sep) + right, width));
				}
			} else {
				// Fallback: graph only (legend will be shown below).
				for (const gl of graphLines) lines.push(truncateToWidth(gl, width));
				lines.push("");
				// Compact legend below, left-aligned.
				const legendTitleBelow =
					this.view === "model" ? "Top models (30d palette):"
					: this.view === "cwd" ? "Top directories (30d palette):"
					: "Time of day:";
				lines.push(truncateToWidth(dim(legendTitleBelow), width));
				for (const it of legendItems) lines.push(truncateToWidth(it, width));
			}
		}

		lines.push("");
		for (const tl of tableLines) lines.push(truncateToWidth(tl, width));

		// Ensure no overly long lines (truncateToWidth already), but keep at least 1 line.
		this.cachedWidth = width;
		this.cachedRows = termRows;
		this.cachedLines = lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
		return this.cachedLines;
	}
}

export default function sessionBreakdownExtension(pi: ExtensionAPI) {
	pi.registerCommand("session-breakdown", {
		description: "Interactive breakdown of last 7/30/90 days of ~/.pi session usage (sessions/messages/tokens + cost by model)",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				// Non-interactive fallback: just notify.
				const data = await computeBreakdown(undefined);
				const range = data.ranges.get(30)!;
				// LOCAL PATCH 3 (ours): the note belongs here too — this is the path a
				// script or an agent reads, and it is the one with no visual cues.
				const note = inheritedNote(data.inherited);
				pi.sendMessage(
					{
						customType: "session-breakdown",
						content: `Session breakdown (non-interactive)\n${rangeSummary(range, 30, "sessions")}${note ? `\n${note}` : ""}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			let aborted = false;
			const data = await ctx.ui.custom<BreakdownData | null>((tui, theme, _kb, done) => {
				const baseMessage = "Analyzing sessions (last 90 days)…";
				const loader = new BorderedLoader(tui, theme, baseMessage);

				const startedAt = Date.now();
				const progress: BreakdownProgressState = {
					phase: "scan",
					foundFiles: 0,
					parsedFiles: 0,
					totalFiles: 0,
					currentFile: undefined,
				};

				const renderMessage = (): string => {
					const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
					if (progress.phase === "scan") {
						return `${baseMessage}  scanning (${formatCount(progress.foundFiles)} files) · ${elapsed}s`;
					}
					if (progress.phase === "parse") {
						return `${baseMessage}  parsing (${formatCount(progress.parsedFiles)}/${formatCount(progress.totalFiles)}) · ${elapsed}s`;
					}
					return `${baseMessage}  finalizing · ${elapsed}s`;
				};

				let intervalId: NodeJS.Timeout | null = null;
				const stopTicker = () => {
					if (intervalId) {
						clearInterval(intervalId);
						intervalId = null;
					}
				};

				// Update every 0.5s so long-running scans show some visible progress.
				setBorderedLoaderMessage(loader, renderMessage());
				intervalId = setInterval(() => {
					setBorderedLoaderMessage(loader, renderMessage());
				}, 500);

				loader.onAbort = () => {
					aborted = true;
					stopTicker();
					done(null);
				};

				computeBreakdown(loader.signal, (update) => Object.assign(progress, update))
					.then((d) => {
						stopTicker();
						if (!aborted) done(d);
					})
					.catch((err) => {
						stopTicker();
						console.error("session-breakdown: failed to analyze sessions", err);
						if (!aborted) done(null);
					});

				return loader;
			});

			if (!data) {
				ctx.ui.notify(aborted ? "Cancelled" : "Failed to analyze sessions", aborted ? "info" : "error");
				return;
			}

			await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				return new BreakdownComponent(data, tui, done);
			});
		},
	});
}

// LOCAL PATCH 4 (ours): the surface the fixture tests drive.
//
// Upstream exports only the extension factory, so its 1.8k lines of
// aggregation could not be tested without a terminal. These are the pieces the
// tests assert on: the roots, the lineage resolution, the per-file parser and the
// whole-scan aggregation. Nothing here is used at runtime.
export const __test__ = {
	BreakdownComponent,
	computeBreakdown,
	defaultSessionRoots,
	inheritedNote,
	readEntryIds,
	readSessionHeader,
	resolveInheritedIds,
};
