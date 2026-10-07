// Behaviour of the vendored continue.ts: one shortcut, gated on `isIdle()`.
//
// The factory is driven with a fake pi API rather than through jiti, so the
// handler runs directly and both branches are covered. The strict-ESM load
// guard for the module itself lives in extension-load.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

interface ShortcutSpec {
	description?: string;
	handler: (ctx: { isIdle: () => boolean }) => void;
}

type Factory = (pi: unknown) => void;

async function loadFactory(): Promise<Factory> {
	const specifier = new URL("../../continue.ts", import.meta.url).href;
	const module = (await import(specifier)) as { default?: unknown };
	assert.equal(typeof module.default, "function", "continue.ts must export a default extension factory");
	return module.default as Factory;
}

/** Drive the factory and capture what it registers and sends. */
function capture(factory: Factory) {
	let shortcut: string | undefined;
	let spec: ShortcutSpec | undefined;
	const sent: string[] = [];
	factory({
		registerShortcut(id: string, options: ShortcutSpec) {
			shortcut = id;
			spec = options;
		},
		sendUserMessage(content: string) {
			sent.push(content);
		},
	});
	assert.ok(spec, "the factory must register a shortcut");
	return { shortcut, spec: spec as ShortcutSpec, sent };
}

test("registers shift+alt+enter", async () => {
	const { shortcut, spec } = capture(await loadFactory());
	assert.equal(shortcut, "shift+alt+enter");
	assert.match(spec.description ?? "", /continue/i);
});

test("sends the literal prompt when idle", async () => {
	const { spec, sent } = capture(await loadFactory());
	spec.handler({ isIdle: () => true });
	assert.deepEqual(sent, ["continue"]);
});

test("sends nothing while the agent is not idle", async () => {
	const { spec, sent } = capture(await loadFactory());
	spec.handler({ isIdle: () => false });
	assert.deepEqual(sent, []);
});
