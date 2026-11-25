// Lazy tool exposure (local patch 15).
//
// The management tools stop being declared on every request once pi has a way
// to reach them on demand. What matters is not losing them: a tool the model
// cannot find is worse than one it pays for, so every path that cannot answer
// the question must leave them declared. The harness models pi's DECLARED set
// rather than the definitions, because a payload assertion alone once let a
// change that hid the tools and removed nothing pass.

import assert from "node:assert/strict";
import { test } from "node:test";

import { type RunRecord } from "../index.ts";
import { withTempAgentDir } from "./helpers.ts";
import { createHarness, withHarness } from "./lifecycle-harness.ts";

test("the management tools are declared when pi has no way to reach them on demand", async () => {
	await withHarness(undefined, async (h) => {
		for (const name of ["subagent", "subagent_status", "subagent_wait", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
			assert.equal(h.toolExposure(name), undefined, `${name} is registered direct without codemode or tool_search`);
			assert.equal(h.declared(name), true, `${name} must stay declared`);
		}
		// And the fallback is not a degraded extension: they still work.
		const run = (await h.call("subagent", { task: "still works" })).details as unknown as RunRecord;
		assert.match((await h.call("subagent_status", { id: run.id })).text, /still works/);
		await h.call("subagent_cancel", { id: run.id });
	});
});

test("codemode or tool_search hides the management tools but never `subagent`", async () => {
	// `subagent` stays declared: it is the entry point, and a model that cannot
	// start a run has no reason to search for the tools that manage one.
	for (const activeTools of [["read", "bash", "edit", "write", "codemode"], ["read", "tool_search"]]) {
		await withHarness({ activeTools }, async (h) => {
			assert.equal(h.toolExposure("subagent"), undefined, "the launch tool is always declared");
			for (const name of ["subagent_status", "subagent_wait", "subagent_answer", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
				assert.equal(h.toolExposure(name), "codemode", `${name} should be hidden from every request`);
				assert.equal(
					h.toolRegistrations.filter((entry) => entry.name === name).length,
					1,
					`${name} is registered exactly once: re-registering cannot un-declare a tool that was activated on registration`,
				);
			}
			// Hidden from the model, not gone: still registered and still callable.
			await h.call("subagent", { task: "reachable" });
			assert.match((await h.call("subagent_status", {})).text, /reachable/);
		});
	}
});

test("/tools switching discovery off mid-session does not strand the tools", async () => {
	// The regression that made "fails safe" untrue: registration happens once, and a
	// host can change the tool set afterwards. Without the before_agent_start
	// re-check, all five would be registered as codemode, no longer declared, and
	// no longer reachable — with `subagent` still declared, so the model could
	// start a run it then could not poll or cancel.
	await withHarness({ activeTools: ["read", "codemode", "tool_search"] }, async (h) => {
		for (const name of ["subagent_status", "subagent_wait", "subagent_answer", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
			assert.equal(h.declared(name), false, `${name} starts hidden`);
		}

		// The host switches both discovery tools off, as /tools does.
		h.setActiveTools(["read", "bash", "edit", "write"]);
		await h.fireBeforeAgentStart();

		for (const name of ["subagent_status", "subagent_wait", "subagent_answer", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
			assert.equal(h.toolExposure(name), undefined, `${name} must be re-registered direct`);
			assert.equal(h.declared(name), true, `${name} must be declared again, or the model cannot reach it at all`);
		}
		await h.call("subagent", { task: "still manageable" });
		assert.match((await h.call("subagent_status", {})).text, /still manageable/);
	});
});

test("the note about hidden tools only ships when they are hidden", async () => {
	// ~360 bytes of system prompt per request, and it is a lie in a session that
	// never enabled discovery — so it lives in prepareLoadout, not in the tool.
	await withHarness(undefined, async (h) => {
		await h.call("subagent", { task: "no discovery" });
		assert.doesNotMatch(h.tools.get("subagent")?.description as string, /not declared while/);
	});

	await withHarness({ activeTools: ["read", "codemode"] }, async (h) => {
		await h.call("subagent", { task: "with discovery" });
		// The hook is pi's, so exercise it the way pi does: with a loadout.
		const loadout = {
			declared: [{ name: "subagent", description: h.tools.get("subagent")?.description }],
			getExposure: (name: string) => h.toolExposure(name),
		};
		const changes = (h.tools.get("subagent") as { prepareLoadout?: (l: unknown) => { descriptions?: Record<string, string> } }).prepareLoadout?.(loadout);
		const note = changes?.descriptions?.subagent;
		assert.ok(note?.includes("not declared while"), `the note must be added when the tools are hidden: ${note}`);
		assert.ok(note.startsWith(h.tools.get("subagent")?.description as string), "it extends the description rather than replacing it");

		// A loadout that does not list the tool at all: the hook must fall back to
		// the extension's own description rather than throwing. This branch was
		// unreachable while every test passed a declared `subagent`, and it did
		// throw — a bare `subagentDescription` that does not exist, hidden because pi
		// wraps prepareLoadout in a try/catch that only logs. pi would have shipped a
		// session with no note and no error.
		const empty = {
			declared: [] as Array<{ name: string; description?: string }>,
			getExposure: (name: string) => h.toolExposure(name),
		};
		const fallback = (h.tools.get("subagent") as { prepareLoadout?: (l: unknown) => { descriptions?: Record<string, string> } }).prepareLoadout?.(empty);
		assert.match(fallback?.descriptions?.subagent ?? "", /not declared while/);
		assert.match(fallback?.descriptions?.subagent ?? "", /delegated task/, "and falls back to the tool's own description");
	});
});

test("the exposure is re-checked without churning the tool registry", async () => {
	// The memo is what makes the per-turn re-check free; this is the case that
	// would catch it being removed (and the registry churn that follows).
	await withHarness({ activeTools: ["read", "codemode"] }, async (h) => {
		await h.call("subagent", { task: "one turn" });
		await h.fireBeforeAgentStart();
		await h.fireBeforeAgentStart();
		for (const name of ["subagent_status", "subagent_wait", "subagent_answer", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
			assert.equal(h.toolRegistrations.filter((entry) => entry.name === name).length, 1, `${name} registered once`);
		}
	});
});

test("an unbound tool API leaves every tool declared instead of throwing", async () => {
	// pi.getActiveTools() throws before the runtime binds. Asking anyway must not
	// take the session down, and must not leave a half-applied exposure.
	await withHarness({ unbound: true }, async (h) => {
		for (const name of ["subagent", "subagent_status", "subagent_wait", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
			assert.equal(h.toolExposure(name), undefined, `${name} must stay direct`);
			assert.equal(h.declared(name), true, `${name} must stay declared`);
		}
		const run = (await h.call("subagent", { task: "unbound is survivable" })).details as unknown as RunRecord;
		assert.match((await h.call("subagent_status", { id: run.id })).text, /unbound is survivable/);
	});
});

test("the management tools are registered once, not on every tick", async () => {
	await withHarness({ activeTools: ["read", "tool_search"] }, async (h) => {
		await h.call("subagent", { task: "counts registrations" });
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		for (const name of ["subagent_status", "subagent_wait", "subagent_answer", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
			assert.equal(h.toolRegistrations.filter((entry) => entry.name === name).length, 1, `${name} must not churn the tool registry`);
		}
	});
});

test("a fresh extension load re-registers the management tools", async () => {
	// The registration memo is CLOSURE state, so a new load starts unregistered.
	// If it were hoisted to module scope, the second load in this same process
	// would skip registration and the new session would have no subagent_status at
	// all — and "registered once" would not notice, because it only ever looks at
	// one load.
	await withTempAgentDir(async () => {
		const first = await createHarness();
		await first.shutdown();
		const second = await createHarness();
		try {
			for (const name of ["subagent_status", "subagent_wait", "subagent_answer", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
				assert.ok(second.tools.has(name), `${name} must be registered again after a fresh load, not skipped by a shared memo`);
			}
		} finally {
			await second.shutdown();
		}
	});
});
