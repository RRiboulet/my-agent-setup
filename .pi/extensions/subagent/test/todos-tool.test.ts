// Behaviour pin for the `todo` tool's result shapes.
//
// Risk covered: the six id-taking actions (get/update/append/delete/claim/
// release) each used to spell out the same guard/validate/`existsSync`/
// error-shape block by hand. The cleanup folded them into `resolveExistingTodo`
// + `todoToolResult` + `todoToolError`, and a refactor of ~250 lines of tool
// plumbing is exactly the kind that is "obviously" behaviour-preserving until a
// string changes. The expected text and `details` below are the PRE-refactor
// values, written out rather than produced by the new helpers, so this file
// fails if the collapse altered an output.
//
// The not-found test deliberately pins an inconsistency: `get`/`update`/`append`
// store the terse "not found" in `details.error` while the text carries the full
// message, and `delete`/`claim`/`release` store the full message in both. That is
// what the code did. Harmonising it is a separate, deliberate change, and this
// assertion is what forces it to be deliberate.
//
// todos.ts used to be unloadable under node's strip-only loader (a TypeScript
// parameter property), which is why it had no unit test at all. That syntax is
// gone, so this file imports the real factory and drives the real `execute`.
// extension-load.test.ts now lists todos.ts too, pinning the strict-ESM load.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import todosExtension from "../../todos.ts";

const SESSION_ID = "todos-tool-test";

type ToolResult = {
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
};

type Call = (
	label: string,
	params: Record<string, unknown>,
) => Promise<{ text: string; details: Record<string, unknown> }>;

/**
 * Boot the real `todo` tool against a throwaway PI_TODO_PATH directory and hand
 * `fn` a caller. The extension factory is called, not the helpers directly, so
 * the test exercises the same `execute` switch the agent hits.
 */
async function withTodoTool<T>(fn: (call: Call) => Promise<T>): Promise<T> {
	const todosDir = await mkdtemp(path.join(tmpdir(), "todos-tool-test-"));
	const previousTodoPath = process.env.PI_TODO_PATH;
	process.env.PI_TODO_PATH = todosDir;
	try {
		let definition: { execute: (...args: unknown[]) => Promise<ToolResult> } | undefined;
		const pi = {
			on: () => undefined,
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<ToolResult> }) => {
				if (tool.name === "todo") definition = tool;
			},
			registerCommand: () => undefined,
		};
		todosExtension(pi as never);
		assert.ok(definition, "the todo tool must be registered");

		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: {
				getSessionId: () => SESSION_ID,
				getSessionFile: () => path.join(todosDir, `${SESSION_ID}.jsonl`),
			},
		};
		const call: Call = async (label, params) => {
			const result = await definition!.execute(`call-${label}`, params, undefined, undefined, ctx);
			return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
		};
		return await fn(call);
	} finally {
		if (previousTodoPath === undefined) delete process.env.PI_TODO_PATH;
		else process.env.PI_TODO_PATH = previousTodoPath;
		await rm(todosDir, { recursive: true, force: true });
	}
}

const ACTIONS = ["get", "update", "append", "delete", "claim", "release"] as const;

/**
 * Pin a success result's exact key set, not just the fields a test happens to
 * read: an extra key (a stray `error`, say) or a dropped `todo` would otherwise
 * pass every other assertion here.
 */
function assertSuccess(details: Record<string, unknown>, action: string): void {
	assert.deepEqual(Object.keys(details).sort(), ["action", "todo"], `${action}: success details keys`);
	assert.equal(details.action, action, `${action}: success details action`);
}

test("every id-taking action reports a missing id identically", async () => {
	await withTodoTool(async (call) => {
		for (const action of ACTIONS) {
			const { text, details } = await call(action, { action });
			assert.equal(text, "Error: id required", `${action}: content text`);
			assert.deepEqual(details, { action, error: "id required" }, `${action}: details`);
		}
	});
});

test("every id-taking action reports a malformed id identically", async () => {
	await withTodoTool(async (call) => {
		const message = "Invalid todo id. Expected TODO-<hex>.";
		for (const action of ACTIONS) {
			const { text, details } = await call(action, { action, id: "not-hex" });
			assert.equal(text, message, `${action}: content text`);
			assert.deepEqual(details, { action, error: message }, `${action}: details`);
		}
	});
});

test("not-found text is shared; details.error keeps each action's historical shape", async () => {
	await withTodoTool(async (call) => {
		const full = "Todo TODO-deadbeef not found";
		for (const action of ACTIONS) {
			const { text, details } = await call(action, { action, id: "deadbeef" });
			assert.equal(text, full, `${action}: content text`);
			const terse = action === "get" || action === "update" || action === "append";
			assert.deepEqual(details, { action, error: terse ? "not found" : full }, `${action}: details`);
		}
	});
});

test("not-found keeps the id case each action always echoed", async () => {
	// The one place the six actions do NOT agree. get/update/append/delete resolve
	// the id in the tool itself, which lower-cases it; claim/release hand the raw
	// id to a module mutator whose message preserves the caller's case. That is
	// the pre-refactor behaviour and the reason those mutators were left alone:
	// folding them onto `resolveExistingTodo` would lower-case their messages.
	await withTodoTool(async (call) => {
		for (const action of ACTIONS) {
			const { text } = await call(action, { action, id: "DEADBEEF" });
			const preservesCase = action === "claim" || action === "release";
			assert.equal(
				text,
				preservesCase ? "Todo TODO-DEADBEEF not found" : "Todo TODO-deadbeef not found",
				`${action}: content text`,
			);
		}
	});
});

test("create without a title reports the title guard", async () => {
	await withTodoTool(async (call) => {
		const { text, details } = await call("create", { action: "create" });
		assert.equal(text, "Error: title required");
		assert.deepEqual(details, { action: "create", error: "title required" });
	});
});

test("a created todo round-trips through the success shapes unchanged", async () => {
	await withTodoTool(async (call) => {
		const created = await call("create", { action: "create", title: "Ship it", tags: ["x"], body: "first" });
		assertSuccess(created.details, "create");
		assert.match(created.text, /"id": "TODO-[a-f0-9]{8}"/, "agent-facing text uses the TODO- prefix");
		const createdTodo = created.details.todo as { id: string };
		assert.match(createdTodo.id, /^[a-f0-9]{8}$/, "details carry the raw id");

		const got = await call("get", { action: "get", id: createdTodo.id });
		assertSuccess(got.details, "get");
		const gotTodo = got.details.todo as { id: string; title: string; body: string };
		assert.equal(gotTodo.id, createdTodo.id, "get returns the todo create wrote");
		assert.equal(gotTodo.title, "Ship it");
		// create hands back the in-memory body ("first"); get re-parses the file,
		// whose body carries the serializer's trailing newline. Compare the text.
		assert.equal(gotTodo.body.trim(), "first");

		const updated = await call("update", { action: "update", id: createdTodo.id, title: "Ship it well" });
		assertSuccess(updated.details, "update");
		assert.match(updated.text, /"title": "Ship it well"/);

		const appended = await call("append", { action: "append", id: createdTodo.id, body: "more" });
		assertSuccess(appended.details, "append");
		assert.match(appended.text, /"body": "first\\n\\nmore/, "append keeps the original text and adds the new");

		const claimed = await call("claim", { action: "claim", id: createdTodo.id });
		assertSuccess(claimed.details, "claim");
		assert.equal((claimed.details.todo as { assigned_to_session?: string }).assigned_to_session, SESSION_ID);

		const released = await call("release", { action: "release", id: createdTodo.id });
		assertSuccess(released.details, "release");
		assert.equal((released.details.todo as { assigned_to_session?: string }).assigned_to_session, undefined);

		const deleted = await call("delete", { action: "delete", id: createdTodo.id });
		assertSuccess(deleted.details, "delete");

		const gone = await call("get", { action: "get", id: createdTodo.id });
		assert.deepEqual(gone.details, { action: "get", error: "not found" });
	});
});
