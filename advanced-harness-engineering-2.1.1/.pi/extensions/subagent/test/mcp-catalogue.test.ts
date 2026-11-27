// `/mcp-catalogue` is the session half of the MCP catalogue installer, and this
// is its behaviour: the file it writes, the names it reports, and the two things
// it must never do.
//
// The failure it guards is asymmetric, which is why the assertions are about
// files rather than about the command's own wording. A merge that is not
// add-only silently undoes the Playwright pin the README tells a colleague to
// make; a second run that rewrites the file is indistinguishable from a working
// one until it reformats an entry someone edited; and a command that resolved the
// project's `.pi/mcp.json` instead of the agent dir's would turn one project's
// opt-in into every project's — with an OAuth prompt and two background
// processes attached, in a session that was already open. None of those show up
// in a report string, so the file bytes are asserted directly.
//
// The catalogue is read from the repository, not hard-coded here: these tests
// are about the command, and a literal list of servers would go stale the day a
// third one ships.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { withTempAgentDir } from "./helpers.ts";

const ENTRY_POINT = new URL("../../mcp-catalogue.ts", import.meta.url).href;
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const CATALOGUE = JSON.parse(readFileSync(path.join(REPO_ROOT, "mcp", "catalogue.json"), "utf8")) as {
	mcpServers: Record<string, Record<string, unknown>>;
};
const CATALOGUE_NAMES = Object.keys(CATALOGUE.mcpServers);

interface Handler {
	(args: string, ctx: unknown): Promise<void>;
}

interface Capture {
	command?: { name: string; description?: string; handler: Handler };
	/** Tools and MCP servers the factory registers — there must be none. */
	tools: string[];
	mcpServers: string[];
}

async function loadFactory(): Promise<(pi: unknown) => void> {
	const module = (await import(ENTRY_POINT)) as { default?: unknown };
	assert.equal(typeof module.default, "function", "mcp-catalogue.ts must export a default extension factory");
	return module.default as (pi: unknown) => void;
}

/** Load the extension against a fake API and keep what it registered. */
async function loadExtension(): Promise<Capture> {
	const registered: Capture = { tools: [], mcpServers: [] };
	(await loadFactory())({
		registerCommand: (name: string, options: { description?: string; handler: Handler }) => {
			registered.command = { name, ...options };
		},
		// Not registered today, and pinned so a future "just enable it by
		// extension registration" cannot arrive unnoticed: the spec rules that
		// out, and it is what would break the per-project override.
		registerTool: (tool: { name: string }) => registered.tools.push(tool.name),
		registerMcpServer: (name: string) => registered.mcpServers.push(name),
	});
	assert.ok(registered.command, "the factory must register a command");
	return registered;
}

interface Notice {
	text: string;
	level: string;
}

/** A fake command context that records what the command told the session. */
function session(cwd: string) {
	const notices: Notice[] = [];
	const ctx = {
		hasUI: true,
		cwd,
		ui: {
			notify: (text: string, level?: string) => notices.push({ text, level: level ?? "info" }),
		},
	};
	return { ctx, notices };
}

/** The agent dir's file, parsed, plus a helper that reads it as bytes. */
function agentFile(agentDir: string) {
	const file = path.join(agentDir, "mcp.json");
	return {
		file,
		bytes: () => readFileSync(file),
		json: () => JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, { enabled?: boolean }> },
	};
}

test("loading the extension installs nothing and adds no tool or server", async () => {
	await withTempAgentDir(async (agentDir) => {
		const extension = await loadExtension();
		assert.equal(extension.command?.name, "mcp-catalogue");
		assert.match(extension.command?.description ?? "", /mcp servers.*disabled/i);
		assert.deepEqual(extension.tools, [], "a tool would ride on every request's prompt");
		assert.deepEqual(extension.mcpServers, [], "extension registration would defeat the project override");

		// Loading is registration, not installation: a write here would be the
		// write-at-session-start the spec explicitly rules out.
		assert.equal(existsSync(path.join(agentDir, "mcp.json")), false, "loading must not install the catalogue");
	});
});

test("the first run creates the agent dir's mcp.json with every catalogue server disabled", async () => {
	await withTempAgentDir(async (agentDir) => {
		const command = (await loadExtension()).command!;
		const { ctx, notices } = session(process.cwd());
		await command.handler("", ctx);

		const file = agentFile(agentDir);
		const written = file.json();
		for (const name of CATALOGUE_NAMES) {
			assert.ok(written.mcpServers[name], `the file must contain ${name}`);
			assert.equal(written.mcpServers[name]!.enabled, false, `${name} must be installed disabled`);
			assert.deepEqual(written.mcpServers[name], CATALOGUE.mcpServers[name], `${name} must be the catalogue's entry`);
			assert.equal((written.mcpServers[name] as { exposure?: unknown }).exposure, "codemode");
			assert.equal(Object.hasOwn(written.mcpServers[name]!, "auth"), false, "no shared credential in an agent dir file");
		}

		assert.equal(notices.length, 1, "one message per run");
		assert.equal(notices[0]!.level, "info");
		for (const name of CATALOGUE_NAMES) {
			assert.match(notices[0]!.text, new RegExp(name), `the report must name ${name}`);
		}
		assert.ok(notices[0]!.text.includes(file.file), `the report must name the file it wrote, got: ${notices[0]!.text}`);
		assert.match(notices[0]!.text, /disabled/);
	});
});

test("a second run in the same session changes nothing and says so", async () => {
	await withTempAgentDir(async (agentDir) => {
		const command = (await loadExtension()).command!;
		const { ctx, notices } = session(process.cwd());

		await command.handler("", ctx);
		const afterFirst = agentFile(agentDir).bytes();
		await command.handler("", ctx);
		const afterSecond = agentFile(agentDir).bytes();

		assert.deepEqual(afterSecond, afterFirst, "idempotent means byte-identical, not merely equivalent");
		assert.equal(notices.length, 2);
		assert.match(notices[1]!.text, /nothing added/);
		for (const name of CATALOGUE_NAMES) {
			assert.match(notices[1]!.text, new RegExp(`skipped [^\\n]*${name}|skipped ${name}`), `the report must say ${name} was skipped`);
		}
	});
});

test("a project's own .pi/mcp.json is never the file written", async () => {
	await withTempAgentDir(async (agentDir) => {
		// A trusted project that has already opted Figma in. Resolving the project
		// file here would enable Figma in every other project of this agent dir.
		const projectRoot = mkdtempSync(path.join(tmpdir(), "mcp-catalogue-project-"));
		try {
			mkdirSync(path.join(projectRoot, ".pi"), { recursive: true });
			const projectFile = path.join(projectRoot, ".pi", "mcp.json");
			const projectBytes = '{\n  "mcpServers": {\n    "figma": { "enabled": true }\n  }\n}\n';
			writeFileSync(projectFile, projectBytes);

			const command = (await loadExtension()).command!;
			const { ctx, notices } = session(projectRoot);
			await command.handler("", ctx);

			assert.equal(readFileSync(projectFile, "utf8"), projectBytes, "the project override is the project's, byte for byte");

			const written = agentFile(agentDir).json();
			for (const name of CATALOGUE_NAMES) {
				assert.ok(written.mcpServers[name], `the agent dir's file must contain ${name}`);
				assert.equal(written.mcpServers[name]!.enabled, false, "the catalogue entry, not the project's override");
			}
			for (const name of CATALOGUE_NAMES) assert.match(notices[0]!.text, new RegExp(name));
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});
});

test("arguments are refused rather than guessed at", async () => {
	await withTempAgentDir(async (agentDir) => {
		const command = (await loadExtension()).command!;
		const { ctx, notices } = session(process.cwd());
		// `/mcp-catalogue figma` reads as "install, and enable this one". Installing
		// everything and enabling nothing would look like it obeyed.
		await command.handler("figma", ctx);

		assert.equal(notices.length, 1);
		assert.equal(notices[0]!.level, "warning");
		assert.match(notices[0]!.text, /takes no arguments/);
		assert.equal(existsSync(path.join(agentDir, "mcp.json")), false, "a refused argument writes nothing");
	});
});

test("an unmergeable agent file is reported and left alone", async () => {
	await withTempAgentDir(async (agentDir) => {
		const file = agentFile(agentDir);
		const broken = '{\n  "mcpServers": \n';
		writeFileSync(file.file, broken);

		const command = (await loadExtension()).command!;
		const { ctx, notices } = session(process.cwd());
		await command.handler("", ctx);

		assert.equal(readFileSync(file.file, "utf8"), broken, "a file we cannot parse is still the operator's");
		assert.equal(notices.length, 1);
		assert.equal(notices[0]!.level, "error");
		assert.match(notices[0]!.text, /nothing was written/);
		assert.match(notices[0]!.text, /not valid JSON/);
	});
});

test("a session with no UI gets the report on stdout, as a shell command does", async () => {
	await withTempAgentDir(async (agentDir) => {
		const command = (await loadExtension()).command!;
		const printed: string[] = [];
		const original = console.log;
		console.log = (...parts: unknown[]) => {
			printed.push(parts.join(" "));
		};
		try {
			await command.handler("", { hasUI: false, cwd: process.cwd(), ui: { notify: () => assert.fail("no UI to notify") } });
		} finally {
			console.log = original;
		}

		const report = printed.join("\n");
		assert.match(report, /created .*mcp\.json/);
		for (const name of CATALOGUE_NAMES) assert.match(report, new RegExp(name));
		assert.ok(existsSync(path.join(agentDir, "mcp.json")));
	});
});
