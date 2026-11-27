// Regression tests for codemode's inline tool catalog under `mode: "only"`
// with pi's default 3,000-token inline budget.
//
// In `codemode.mode = "only"`, pi hides direct tool declarations (including
// `subagent`) and lists callable tools inside `codemode`'s own description up
// to `DEFAULT_CODEMODE_INLINE_BUDGET` (3,000 tokens), sorted cheapest-first.
// When `subagent` is too large, `selectCatalog` drops it from the inline
// catalog, forcing orchestrators to spend turns on `tool_search` / `ALL_TOOLS`
// before they can delegate.

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import orchestratorExtension from "../../orchestrator/index.ts";
import webSearchExtension from "../../native-web-search.ts";
import todosExtension from "../../todos.ts";
import subagentExtension from "../index.ts";
import { createFakeHost } from "./fake-pi.ts";
import { withTempAgentDir } from "./helpers.ts";

const piCodingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piDistDir = path.dirname(piCodingAgentEntry);

const {
	createCodemodeDescription,
	createCodemodeToolDefinition,
	DEFAULT_CODEMODE_INLINE_BUDGET,
} = (await import(path.join(piDistDir, "extensions/codemode/tool.js"))) as {
	createCodemodeDescription: (
		tools: ToolDefinition[],
		options?: {
			models?: boolean;
			guidelines?: Map<string, string[]>;
			inlineBudget?: number;
		},
	) => string;
	createCodemodeToolDefinition: (options?: {
		getMode?: () => "on" | "only";
		getInlineBudget?: () => number | undefined;
	}) => {
		prepareLoadout?: (loadout: {
			declared: ToolDefinition[];
			callable: ToolDefinition[];
			getExposure: (name: string) => string;
			getNamespace: (name: string) => { name: string; description?: string } | undefined;
			getPromptGuidelines: (name: string) => string[];
		}) => {
			descriptions: Record<string, string>;
			hiddenDeclarations: string[];
		};
	};
	DEFAULT_CODEMODE_INLINE_BUDGET: number;
};

const { createCodingToolDefinitions } = (await import(path.join(piDistDir, "core/tools/index.js"))) as {
	createCodingToolDefinitions: (cwd: string) => ToolDefinition[];
};

async function collectRealisticToolset(): Promise<Map<string, ToolDefinition>> {
	return withTempAgentDir(async () => {
		const tools = new Map<string, ToolDefinition>();
		for (const def of createCodingToolDefinitions(process.cwd())) {
			tools.set(def.name, def as ToolDefinition);
		}

		const host = createFakeHost({
			sessionId: "codemode-catalog-test",
			cwd: process.cwd(),
			trusted: true,
			model: { provider: "anthropic", id: "claude-opus-4-6" },
		});

		let activeTools = ["read", "bash", "edit", "write", "codemode", "tool_search"];
		const pi = host.pi as unknown as {
			registerTool: (def: ToolDefinition) => void;
			registerFlag: (name: string, opts?: unknown) => void;
			getFlag: (name: string) => unknown;
			registerMessageRenderer: () => void;
			registerShortcut: () => void;
			getThinkingLevel: () => string;
			getActiveTools: () => string[];
			setActiveTools: (names: string[]) => void;
		};
		const origRegisterTool = pi.registerTool.bind(pi);
		pi.registerTool = (def: ToolDefinition) => {
			tools.set(def.name, def);
			origRegisterTool(def);
		};
		pi.registerFlag = () => {};
		pi.getFlag = () => undefined;
		pi.registerMessageRenderer = () => {};
		pi.registerShortcut = () => {};
		pi.getThinkingLevel = () => "medium";
		pi.getActiveTools = () => [...activeTools];
		pi.setActiveTools = (names: string[]) => {
			activeTools = [...names];
		};

		subagentExtension(host.pi);
		orchestratorExtension(host.pi, { role: "parent" });
		todosExtension(host.pi);
		webSearchExtension(host.pi);

		await host.fire("session_start", {});
		await host.fire("session_shutdown", {});
		return tools;
	});
}

test("mode: 'only' with default 3,000-token inline budget includes subagent and core tools", async () => {
	assert.equal(DEFAULT_CODEMODE_INLINE_BUDGET, 3_000);

	const tools = await collectRealisticToolset();
	const allTools = [...tools.values()];
	const getExposure = (name: string) => (tools.get(name) as { exposure?: string } | undefined)?.exposure ?? "direct";
	const declared = allTools.filter((tool) => getExposure(tool.name) === "direct");

	const codemode = createCodemodeToolDefinition({ getMode: () => "only" });
	assert.ok(codemode.prepareLoadout, "codemode defines prepareLoadout");

	const result = codemode.prepareLoadout({
		declared,
		callable: allTools,
		getExposure,
		getNamespace: () => undefined,
		getPromptGuidelines: (name) => tools.get(name)?.promptGuidelines ?? [],
	});

	assert.ok(
		result.hiddenDeclarations.includes("subagent"),
		"mode: 'only' hides subagent's direct declaration, so inline catalog inclusion is critical",
	);

	const description = result.descriptions.codemode ?? "";
	assert.ok(
		description.includes("### `subagent`"),
		`subagent must be included in codemode's inline catalog under mode: 'only' (3,000-token budget); got ${description.length} chars`,
	);

	for (const essential of [
		"read",
		"bash",
		"edit",
		"write",
		"todo",
		"subagent",
		"subagent_wait",
		"subagent_status",
		"subagent_answer",
		"subagent_cancel",
		"subagent_interrupt",
		"subagent_resume",
		"subagent_clean",
	]) {
		assert.ok(
			description.includes(`### \`${essential}\``),
			`essential tool \`${essential}\` should fit inside the 3,000-token inline catalog`,
		);
	}
});

test("createCodemodeDescription preserves subagent's essential contract details within budget", async () => {
	const tools = await collectRealisticToolset();
	const allTools = [...tools.values()];
	const guidelines = new Map(allTools.map((tool) => [tool.name, tool.promptGuidelines ?? []]));

	const description = createCodemodeDescription(allTools, {
		guidelines,
		inlineBudget: DEFAULT_CODEMODE_INLINE_BUDGET,
	});

	const subagentStart = description.indexOf("### `subagent`");
	assert.notEqual(subagentStart, -1, "subagent section must be rendered");
	const nextHeading = description.indexOf("\n### `", subagentStart + 1);
	const subagentSection = nextHeading === -1 ? description.slice(subagentStart) : description.slice(subagentStart, nextHeading);

	for (const term of ["role", "task", "tasks", "dependsOn", "failurePolicy", "handoff", "subagent_wait"]) {
		assert.ok(subagentSection.includes(term), `subagent catalog section must preserve '${term}'`);
	}
});
