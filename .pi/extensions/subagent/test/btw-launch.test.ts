// Unit tests for the btw launch core.
//
// Risk covered: `launch.ts` decides everything the side panel does before it
// touches tmux or the filesystem — the per-session socket, the scratch paths,
// the child pi argv, the tmux argv and the shell command string. The panel
// itself needs a terminal and a live tmux server, so the deterministic parts
// are pinned here: the exact argv, the `-e` that keeps an extension-registered
// provider resolvable under `--no-extensions`, the `@question.md` form that
// keeps the question out of argv parsing, `exec` so `#{pane_dead}` works, and
// the read-only tool allowlist.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	BTW_SIDE_PROMPT,
	BTW_TOOLS,
	buildBtwChildCommand,
	buildBtwChildPiArgs,
	buildBtwRemainOnExitArgs,
	buildBtwSendKeysArgs,
	buildBtwSessionCreateArgs,
	buildBtwSubmitArgs,
	btwForkPath,
	btwQuestionPath,
	btwRunDir,
	btwSessionName,
	btwSidePromptPath,
	btwSocketPath,
	btwTarget,
	providerExtensionPath,
	requireBtwQuestion,
} from "../../btw/launch.ts";

const AGENT_DIR = "/home/x/.pi/agent";
const BTW_DIR = "/repo/.pi/extensions/btw";
const SID = "1a2b3c4d-0000-4000-8000-000000000000";
const SOCKET = `${AGENT_DIR}/tmux-btw-1a2b3c4d.sock`;
const SESSION = "btw-1a2b3c4d";

test("the socket, session and target derive from the session id", () => {
	assert.equal(btwSocketPath(AGENT_DIR, SID), SOCKET);
	assert.equal(btwSessionName(SID), SESSION);
	assert.equal(btwTarget(SID), `${SESSION}:0.0`);
});

test("scratch paths are under the full session id, not the short one", () => {
	const runDir = `${AGENT_DIR}/btw/${SID}`;
	assert.equal(btwRunDir(AGENT_DIR, SID), runDir);
	assert.equal(btwForkPath(AGENT_DIR, SID), `${runDir}/fork.jsonl`);
	assert.equal(btwQuestionPath(AGENT_DIR, SID), `${runDir}/question.md`);
	assert.equal(btwSidePromptPath(AGENT_DIR, SID), `${runDir}/side-prompt.md`);
});

test("a relative agent dir is refused instead of silently producing tilde paths", () => {
	for (const builder of [
		() => btwSocketPath("~/.pi/agent", SID),
		() => btwRunDir("relative/agent", SID),
		() => btwForkPath("~/.pi/agent", SID),
	]) {
		assert.throws(builder, /absolute agent directory/);
	}
});

test("an empty or whitespace question is refused", () => {
	assert.equal(requireBtwQuestion("  why did it fail?  "), "why did it fail?");
	for (const raw of ["", "   ", "\n\t "]) {
		assert.throws(() => requireBtwQuestion(raw), /cannot be empty/);
	}
});

test("the allowlist is pi's read-only tool set", () => {
	assert.deepEqual([...BTW_TOOLS], ["read", "grep", "find", "ls"]);
	assert.ok(!/bash|edit|write|powershell/.test(BTW_TOOLS.join(",")));
});

test("the side prompt marks the replayed loadout as inapplicable", () => {
	assert.match(BTW_SIDE_PROMPT, /do not apply/i);
	assert.match(BTW_SIDE_PROMPT, /Escape/);
	assert.match(BTW_SIDE_PROMPT, /no bash, edit or write/i);
});

const CHILD_SPEC = {
	invocation: ["/usr/bin/node", "/usr/lib/pi/cli.js"],
	provider: "opencode-go",
	model: "glm-5.3-flash",
	thinking: "max" as string | undefined,
	sessionFile: `${AGENT_DIR}/btw/${SID}/fork.jsonl`,
	questionPath: `${AGENT_DIR}/btw/${SID}/question.md`,
	sidePromptPath: `${AGENT_DIR}/btw/${SID}/side-prompt.md`,
	btwDir: BTW_DIR,
	name: SESSION,
};

test("the child argv pins the side-panel contract and loads the provider extension", () => {
	assert.deepEqual(buildBtwChildPiArgs(CHILD_SPEC), [
		"/usr/bin/node",
		"/usr/lib/pi/cli.js",
		"-e",
		"/repo/.pi/extensions/opencode-go-provider/index.ts",
		"--provider",
		"opencode-go",
		"--model",
		"glm-5.3-flash",
		"--thinking",
		"max",
		"--session",
		`${AGENT_DIR}/btw/${SID}/fork.jsonl`,
		"--name",
		SESSION,
		"--no-approve",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-mcp",
		"--tools",
		"read,grep,find,ls",
		"--append-system-prompt",
		`${AGENT_DIR}/btw/${SID}/side-prompt.md`,
		`@${AGENT_DIR}/btw/${SID}/question.md`,
	]);
});

test("a core provider gets no -e and an absent thinking level drops the flag", () => {
	const args = buildBtwChildPiArgs({ ...CHILD_SPEC, provider: "anthropic", thinking: undefined });
	assert.ok(!args.includes("-e"), "no extension is loaded for a core provider");
	assert.ok(!args.includes("--thinking"), "an unset thinking level is the model default, not a flag");
	assert.equal(args[args.indexOf("--provider") + 1], "anthropic");
});

test("the question travels as @file so its text never re-enters argv parsing", () => {
	const args = buildBtwChildPiArgs(CHILD_SPEC);
	assert.equal(args[args.length - 1], `@${AGENT_DIR}/btw/${SID}/question.md`);
});

test("the provider extension path resolves only for an extension-registered provider", () => {
	assert.equal(providerExtensionPath("opencode-go", BTW_DIR), "/repo/.pi/extensions/opencode-go-provider/index.ts");
	assert.equal(providerExtensionPath("anthropic", BTW_DIR), undefined);
});

test("tmux session creation is detached, named and anchored to the main cwd", () => {
	assert.deepEqual(buildBtwSessionCreateArgs({ socket: SOCKET, session: SESSION, cwd: "/work/project" }), [
		"-S",
		SOCKET,
		"new-session",
		"-d",
		"-s",
		SESSION,
		"-n",
		"btw",
		"-c",
		"/work/project",
	]);
});

test("remain-on-exit keeps a crashed child visible", () => {
	assert.deepEqual(buildBtwRemainOnExitArgs({ socket: SOCKET, session: SESSION }), [
		"-S",
		SOCKET,
		"set-window-option",
		"-t",
		`${SESSION}:0`,
		"remain-on-exit",
		"on",
	]);
});

test("send-keys is literal and option-safe; Enter is a separate call", () => {
	assert.deepEqual(buildBtwSendKeysArgs({ socket: SOCKET, target: `${SESSION}:0.0`, command: "--not-a-flag; echo hi" }), [
		"-S",
		SOCKET,
		"send-keys",
		"-t",
		`${SESSION}:0.0`,
		"-l",
		"--",
		"--not-a-flag; echo hi",
	]);
	assert.deepEqual(buildBtwSubmitArgs({ socket: SOCKET, target: `${SESSION}:0.0` }), [
		"-S",
		SOCKET,
		"send-keys",
		"-t",
		`${SESSION}:0.0`,
		"Enter",
	]);
});

test("the child command execs and shell-quotes every argv element", () => {
	assert.equal(
		buildBtwChildCommand(["/usr/bin/node", "/path with space/cli.js", "it's"]),
		`exec '/usr/bin/node' '/path with space/cli.js' 'it'"'"'s'`,
	);
});
