// Child session usage parsing for the subagent extension.
//
// Child Pi processes persist their transcript as JSONL under their session
// directory. We sum the usage reported on assistant messages (and any nested
// LLM work recorded on tool results) so `subagent_status` and the `/subagents`
// overlay can show tokens and cost per run.

import { readFile } from "node:fs/promises";

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	turns: number;
}

interface RawUsage {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	totalTokens?: unknown;
	cost?: { total?: unknown };
}

function toNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function accumulate(target: RunUsage, usage: RawUsage, countTurn: boolean): void {
	target.input += toNumber(usage.input);
	target.output += toNumber(usage.output);
	target.cacheRead += toNumber(usage.cacheRead);
	target.cacheWrite += toNumber(usage.cacheWrite);
	target.totalTokens += toNumber(usage.totalTokens);
	target.cost += toNumber(usage.cost?.total);
	if (countTurn) target.turns += 1;
}

export async function readSessionUsage(sessionFile: string | undefined): Promise<RunUsage | undefined> {
	if (!sessionFile) return undefined;

	let content: string;
	try {
		content = await readFile(sessionFile, "utf8");
	} catch {
		return undefined;
	}

	const total: RunUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		turns: 0,
	};

	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: { role?: string; usage?: RawUsage } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message?.usage) continue;
		if (entry.message.role === "assistant") accumulate(total, entry.message.usage, true);
		else if (entry.message.role === "toolResult") accumulate(total, entry.message.usage, false);
	}

	if (total.turns === 0 && total.totalTokens === 0) return undefined;
	return total;
}

export function formatUsage(usage: RunUsage | undefined): string | undefined {
	if (!usage) return undefined;
	const parts = [`${formatTokens(usage.totalTokens)} tok`];
	if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(6)}`);
	return parts.join(" · ");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}
