// Tests for tools/mcp-catalogue.mjs and bin/mcp-catalogue.
//
// The contract is the process: an exit code, one stdout line naming the servers
// added or skipped, and the bytes of the file that came out — read the way a
// setup script, `postCreate.sh` or a colleague at a terminal reads them. So every
// test spawns the CLI against a throwaway agent dir and then asserts the file,
// because the properties this module exists for are file properties: a pinned
// entry that survived byte-identically, an unrelated key still in its own
// indentation, a second run that changed nothing. A function-level test could
// pass while the wrapper, the `PI_CODING_AGENT_DIR` resolution, or the write
// itself failed.
//
// The invalid-catalogue cases run against a copy of the module beside a mutated
// catalogue in a throwaway package root. That is the shape of the failure being
// guarded — a colleague's clone with a broken data file — and it keeps the
// shipped catalogue and a broken one in the same run.
//
// The write gets the same treatment because a crash in it is the expensive case:
// one test runs the CLI under a file-size limit so the write fails mid-flight and
// then checks the operator's file byte for byte. A unit test of a "write the text"
// helper would pass for both the direct write that truncated the file and the
// temp-file rename that does not.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const CLI = path.join(HERE, "mcp-catalogue.mjs");
const WRAPPER = path.join(REPO_ROOT, "bin", "mcp-catalogue");
const CATALOGUE = path.join(REPO_ROOT, "mcp", "catalogue.json");

// A test process can itself be running under pi with an agent dir selected. The
// resolution tests are the only place that may set either variable, so both are
// dropped from the inherited environment and added back explicitly.
const BASE_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => key !== "PI_CODING_AGENT_DIR" && key !== "HOME"),
);

const scratchRoots = [];

after(() => {
	for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

function scratchDir(label) {
	const root = mkdtempSync(path.join(os.tmpdir(), `mcp-catalogue-${label}-`));
	scratchRoots.push(root);
	return root;
}

/**
 * Spawn a surface of the installer. `agentDir` and `home` are the only two
 * variables the resolution reads, and an explicit `home` keeps the suite from
 * ever reaching the real one. `cwd` matters only to the resolution tests, which
 * need somewhere harmless for a relative path to land.
 */
function spawnSurface(command, argv, options = {}) {
	const env = { ...BASE_ENV };
	if (options.agentDir !== undefined) env.PI_CODING_AGENT_DIR = options.agentDir;
	if (options.home !== undefined) env.HOME = options.home;
	const result = spawnSync(command, argv, { encoding: "utf8", env, timeout: 60_000, cwd: options.cwd });
	return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const run = (args, options = {}) => spawnSurface(process.execPath, [options.modulePath ?? CLI, ...args], options);
const runWrapper = (args, options = {}) => spawnSurface("bash", [options.wrapper ?? WRAPPER, ...args], options);

/** The one stdout line of a successful run, asserting there is exactly one. */
function line(result, expectedCode = 0) {
	assert.equal(result.code, expectedCode, `stderr:\n${result.stderr}`);
	assert.equal(result.stderr, "", "a success writes stdout, not stderr");
	const lines = result.stdout.split("\n").filter((entry) => entry !== "");
	assert.equal(lines.length, 1, `expected one line, got:\n${result.stdout}`);
	assert.match(lines[0], /^mcp-catalogue: /, "every line is prefixed with the command name");
	return lines[0];
}

const fileIn = (dir) => path.join(dir, "mcp.json");
const readText = (file) => readFileSync(file, "utf8");
const readBytes = (file) => readFileSync(file);
const readJson = (file) => JSON.parse(readText(file));

/** A throwaway package root: this module, plus whatever catalogue the test wants. */
function scratchPackage(catalogue) {
	const root = scratchDir("package");
	mkdirSync(path.join(root, "tools"), { recursive: true });
	mkdirSync(path.join(root, "mcp"), { recursive: true });
	copyFileSync(CLI, path.join(root, "tools", "mcp-catalogue.mjs"));
	writeFileSync(path.join(root, "mcp", "catalogue.json"), typeof catalogue === "string" ? catalogue : JSON.stringify(catalogue, null, 2));
	return { root, modulePath: path.join(root, "tools", "mcp-catalogue.mjs") };
}

const SHIPPED = JSON.parse(readText(CATALOGUE));

// ---------------------------------------------------------------------------
// R1: the catalogue is data pi can copy rather than translate
// ---------------------------------------------------------------------------

test("the catalogue is pi's mcpServers shape, and every entry ships disabled, codemode-exposed and auth-free", () => {
	const catalogue = readJson(CATALOGUE);
	assert.ok(catalogue && typeof catalogue === "object", "the catalogue parses as an object");
	const servers = catalogue.mcpServers;
	assert.deepEqual(Object.keys(servers), ["figma", "playwright"], "the two servers this change ships, in order");

	// Generic on purpose: a future entry that forgets one of these fails here,
	// which is what keeps "installing the catalogue connects nothing" a property
	// of the data rather than of whoever last edited it.
	for (const [name, entry] of Object.entries(servers)) {
		assert.match(name, /^[A-Za-z0-9_-]+$/, `${name} is a name pi accepts`);
		assert.equal(entry.enabled, false, `${name} must ship disabled`);
		assert.equal(entry.exposure, "codemode", `${name} states its exposure`);
		// `env` and `headers` are the two fields a shipped credential would hide in.
		for (const credential of ["auth", "env", "headers"]) {
			assert.equal(Object.hasOwn(entry, credential), false, `${name} must carry no credential: ${credential}`);
		}
		assert.equal(typeof entry.description, "string", `${name} describe itself for the prompt and tool search`);
	}

	assert.equal(servers.figma.url, "https://mcp.figma.com/mcp");
	assert.equal(servers.figma.oauth.clientName, "Claude Code", "pi's documented clientName for Figma's authorization server");
	assert.equal(servers.playwright.command, "npx");
	assert.deepEqual(servers.playwright.args, ["-y", "@playwright/mcp@latest"]);
});

test("the module exposes the merge as a function, which the session command imports", async () => {
	const module = await import("../tools/mcp-catalogue.mjs");
	assert.equal(typeof module.installCatalogue, "function");
	assert.equal(typeof module.resolveAgentDir, "function");
	assert.equal(typeof module.validateCatalogue, "function");
	assert.ok(module.DEFAULT_CATALOGUE_PATH.endsWith(path.join("mcp", "catalogue.json")));
});

test("importing the module installs nothing: only running it as a script does", () => {
	const root = scratchDir("import");
	const agentDir = path.join(root, "agent");
	// The session command imports this module in every session that loads the
	// extension. An import that reached `main` would write at session start, which
	// the spec rules out in as many words.
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(CLI)})`], {
		encoding: "utf8",
		env: { ...BASE_ENV, PI_CODING_AGENT_DIR: agentDir },
		timeout: 60_000,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "");
	assert.equal(existsSync(fileIn(agentDir)), false, "an import wrote a file");
});

// ---------------------------------------------------------------------------
// R2: add-only, byte-preserving, indentation-preserving
// ---------------------------------------------------------------------------

test("installing into an agent dir that does not exist yet creates it with both servers disabled", () => {
	const root = scratchDir("empty");
	const agentDir = path.join(root, "not-created-yet", "agent");

	const result = run([], { agentDir });
	const output = line(result);
	assert.match(output, /^mcp-catalogue: created .*not-created-yet\/agent\/mcp\.json — added figma, playwright$/);

	const server = readJson(fileIn(agentDir)).mcpServers;
	assert.deepEqual(Object.keys(server), ["figma", "playwright"]);
	for (const [name, entry] of Object.entries(server)) {
		assert.equal(entry.enabled, false, `${name} is listed, not connected`);
		assert.equal(entry.exposure, "codemode");
	}
	assert.equal(server.figma.url, "https://mcp.figma.com/mcp");
	assert.deepEqual(server.playwright.args, ["-y", "@playwright/mcp@latest"]);
	assert.doesNotMatch(readText(fileIn(agentDir)), /"auth"/, "no credential reaches a shared file");
});

test("an existing playwright entry survives byte-identically and is reported skipped while figma is added", () => {
	const root = scratchDir("pinned");
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir);
	const pinned = [
		"{",
		'  "mcpServers": {',
		'    "playwright": {',
		'      "command": "npx",',
		'      "args": ["-y", "@playwright/mcp@1.2.3"],',
		'      "enabled": false',
		"    }",
		"  }",
		"}",
		"",
	].join("\n");
	writeFileSync(fileIn(agentDir), pinned);

	const output = line(run([], { agentDir }));
	assert.match(output, /added figma/);
	assert.match(output, /skipped playwright \(already present\)/);

	const after = readText(fileIn(agentDir));
	// Everything before the insertion point, byte for byte. The insertion is
	// spliced at the end of the mcpServers object, so the original prefix must come
	// through untouched — not merely equal after re-serialisation.
	const cut = pinned.indexOf("\n  }\n}\n");
	assert.ok(cut > 0, "the fixture has the closing braces this assertion keys on");
	assert.ok(after.startsWith(pinned.slice(0, cut)), `a byte before the insertion point changed:\n${after}`);

	// The whole hand-pinned entry, line breaks and inline args included: this is
	// the pin the README tells a colleague to make, and overwriting it is the one
	// thing an add-only merge exists to prevent.
	const entry = ['    "playwright": {', '      "command": "npx",', '      "args": ["-y", "@playwright/mcp@1.2.3"],', '      "enabled": false', "    }"].join("\n");
	assert.ok(after.includes(entry), `the pinned entry changed:\n${after}`);
	assert.doesNotMatch(after, /@playwright\/mcp@latest/, "the catalogue's args did not replace the pin");
	assert.deepEqual(readJson(fileIn(agentDir)).mcpServers.playwright.args, ["-y", "@playwright/mcp@1.2.3"]);
	assert.ok(readJson(fileIn(agentDir)).mcpServers.figma, "the missing server was still added");
});

test("an unrelated key and the file's four-space indentation survive the merge", () => {
	const root = scratchDir("indent");
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(fileIn(agentDir), '{\n    "autoEnableCodemode": false,\n    "mcpServers": {}\n}\n');

	line(run([], { agentDir }));

	const after = readText(fileIn(agentDir));
	assert.match(after, /^\{\n {4}"autoEnableCodemode": false,\n {4}"mcpServers": \{\n {8}"figma": \{/m, after);
	const parsed = readJson(fileIn(agentDir));
	assert.equal(parsed.autoEnableCodemode, false, "a setting beside mcpServers is not ours to change");
	assert.deepEqual(Object.keys(parsed), ["autoEnableCodemode", "mcpServers"], "key order is the file's");
});

test("a file with no mcpServers key gains one and keeps every other byte", () => {
	const root = scratchDir("no-key");
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir);
	const original = '{\n  "autoEnableCodemode": false,\n  "theme": "seed-theme"\n}\n';
	writeFileSync(fileIn(agentDir), original);

	line(run([], { agentDir }));

	const after = readText(fileIn(agentDir));
	// Everything before the insertion point, verbatim.
	assert.ok(after.startsWith('{\n  "autoEnableCodemode": false,\n  "theme": "seed-theme",\n  "mcpServers": {\n'), after);
	assert.ok(after.endsWith("\n  }\n}\n"), "the closing braces keep their own lines");
	const parsed = readJson(fileIn(agentDir));
	assert.equal(parsed.theme, "seed-theme");
	assert.deepEqual(Object.keys(parsed.mcpServers), ["figma", "playwright"]);
});

// ---------------------------------------------------------------------------
// R3: idempotence
// ---------------------------------------------------------------------------

test("a second install changes no byte and reports nothing added", () => {
	const root = scratchDir("idempotent");
	const agentDir = path.join(root, "agent");

	line(run([], { agentDir }));
	const first = readBytes(fileIn(agentDir));

	const output = line(run([], { agentDir }));
	assert.match(output, /nothing added/);
	assert.match(output, /skipped figma, playwright \(already present\)/);
	assert.deepEqual(readBytes(fileIn(agentDir)), first, "a re-run must not rewrite the file at all");
});

// ---------------------------------------------------------------------------
// The write: a failure costs the operator nothing
// ---------------------------------------------------------------------------

test("a write that fails half-way leaves the original mcp.json byte-identical", () => {
	const root = scratchDir("partial-write");
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir);
	const original = [
		"{",
		'  "mcpServers": {',
		'    "playwright": {',
		'      "command": "npx",',
		'      "args": ["-y", "@playwright/mcp@1.2.3"],',
		'      "enabled": false',
		"    }",
		"  },",
		'  "theme": "seed-theme"',
		"}",
		"",
	].join("\n");
	writeFileSync(fileIn(agentDir), original);

	// RLIMIT_FSIZE 0 fails every write past the first byte with EFBIG, then leaves
	// the process free to report it — the closest a test can get to "the disk
	// filled up between the open and the write". A direct write to the target
	// truncates it to 0 bytes here; writing a sibling and renaming is what keeps
	// the operator's entries, so this test fails against any implementation that
	// opens the target itself.
	const failed = spawnSurface("bash", ["-c", 'ulimit -f 0; exec "$0" "$@"', process.execPath, CLI], { agentDir });
	assert.equal(failed.code, 2, `${failed.stdout}${failed.stderr}`);
	assert.equal(failed.stdout, "", "a failed write reports on stderr");
	assert.match(failed.stderr, /cannot write .*mcp\.json: EFBIG/);
	assert.equal(readText(fileIn(agentDir)), original, "a write that failed truncated the operator's file");
	assert.deepEqual(readdirSync(agentDir), ["mcp.json"], "the temp file is cleaned up, not left beside the target");

	// The failure left no state behind: the same file still merges afterwards, pin
	// and unrelated key included.
	assert.match(line(run([], { agentDir })), /added figma/);
	assert.match(readText(fileIn(agentDir)), /@playwright\/mcp@1\.2\.3/, "the pin survived the failed attempt and the retry");
	assert.equal(readJson(fileIn(agentDir)).theme, "seed-theme");
});

test("a merge keeps the file's own mode, so a 0600 mcp.json is not widened", () => {
	const root = scratchDir("mode");
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(fileIn(agentDir), '{\n  "mcpServers": {}\n}\n');
	chmodSync(fileIn(agentDir), 0o600);

	line(run([], { agentDir }));

	// A rename installs the temp file's mode. Copying the target's own mode keeps
	// the atomic write from being a permission change nobody asked for.
	assert.equal(statSync(fileIn(agentDir)).mode & 0o777, 0o600, "the merge widened the file's permissions");
});

test("a symlinked mcp.json is written through, not replaced by a regular file", () => {
	const root = scratchDir("symlink-target");
	const agentDir = path.join(root, "agent");
	const dotfiles = path.join(root, "dotfiles");
	mkdirSync(agentDir);
	mkdirSync(dotfiles);
	const managed = path.join(dotfiles, "mcp.json");
	writeFileSync(managed, '{\n  "mcpServers": {}\n}\n');
	symlinkSync(managed, fileIn(agentDir));

	line(run([], { agentDir }));

	assert.ok(lstatSync(fileIn(agentDir)).isSymbolicLink(), "the agent dir's mcp.json is still the link it was");
	assert.deepEqual(Object.keys(readJson(managed).mcpServers), ["figma", "playwright"], "the merge landed in the file the link points at");
});

// ---------------------------------------------------------------------------
// Refusals: an invalid catalogue, and a target we must not clobber
// ---------------------------------------------------------------------------

const INVALID = [
	{
		why: "an auth field",
		entry: "figma",
		mutate: (servers) => (servers.figma.auth = "Bearer secret"),
		expect: /"auth"/,
	},
	{
		why: "a name pi rejects",
		entry: "design files",
		mutate: (servers) => {
			servers["design files"] = servers.figma;
			delete servers.figma;
		},
		expect: /name pi rejects/,
	},
	{
		why: "no enabled flag",
		entry: "figma",
		mutate: (servers) => delete servers.figma.enabled,
		expect: /"enabled"/,
	},
	{
		why: "an exposure pi does not know",
		entry: "figma",
		mutate: (servers) => (servers.figma.exposure = "loud"),
		expect: /"loud"/,
	},
	{
		why: "neither command nor url",
		entry: "figma",
		mutate: (servers) => delete servers.figma.url,
		expect: /neither "command" nor "url"/,
	},
	{
		why: "an sse field",
		entry: "playwright",
		mutate: (servers) => (servers.playwright.sse = "https://example.invalid/sse"),
		expect: /"sse"/,
	},
	// Well-shaped objects, which is the point: shape-checking these two is
	// exactly how a token would ship to every colleague unnoticed.
	{
		why: "an env field",
		entry: "playwright",
		mutate: (servers) => (servers.playwright.env = { FIGMA_TOKEN: "ghp_example" }),
		expect: /"env" field, and a shipped catalogue must carry no credential/,
	},
	{
		why: "a headers field",
		entry: "figma",
		mutate: (servers) => (servers.figma.headers = { Authorization: "Bearer example" }),
		expect: /"headers" field, and a shipped catalogue must carry no credential/,
	},
];

for (const { why, entry, mutate, expect } of INVALID) {
	test(`a catalogue entry with ${why} makes it refuse to write, naming the entry`, () => {
		const catalogue = structuredClone(SHIPPED);
		mutate(catalogue.mcpServers);
		const { modulePath } = scratchPackage(catalogue);
		const root = scratchDir("invalid");
		const agentDir = path.join(root, "agent");

		const result = run([], { agentDir, modulePath });
		assert.equal(result.code, 1, `${result.stdout}${result.stderr}`);
		assert.equal(result.stdout, "", "a refusal reports on stderr");
		assert.match(result.stderr, new RegExp(`entry "${entry}"`));
		assert.match(result.stderr, expect);
		assert.match(result.stderr, /refusing to write .*mcp\.json/);
		assert.match(result.stderr, /nothing was written/);
		// pi skips an invalid entry with one log line, so a written file would be
		// the silent no-op this refusal exists to avoid.
		assert.equal(existsSync(fileIn(agentDir)), false, "no file is created when the catalogue is invalid");
		assert.equal(existsSync(agentDir), false, "not even the agent dir is created");
	});
}

test("a catalogue that cannot be read is a could-not-run exit 2", () => {
	const { root, modulePath } = scratchPackage(SHIPPED);
	rmSync(path.join(root, "mcp", "catalogue.json"));
	const agentDir = path.join(scratchDir("no-catalogue"), "agent");

	const result = run([], { agentDir, modulePath });
	assert.equal(result.code, 2, `${result.stdout}${result.stderr}`);
	assert.match(result.stderr, /cannot read the catalogue/);
	assert.equal(existsSync(fileIn(agentDir)), false);
});

test("an existing mcp.json that is not a JSON object is refused rather than clobbered", () => {
	const root = scratchDir("broken-target");
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir);
	const broken = "this is not JSON\n";
	writeFileSync(fileIn(agentDir), broken);

	const result = run([], { agentDir });
	assert.equal(result.code, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /refusing to write .*mcp\.json/);
	assert.equal(readText(fileIn(agentDir)), broken, "the operator's file is left for them to fix");
});

test("a valid mcp.json nested deeper than the scanner can walk is refused, not crashed on", () => {
	const root = scratchDir("deep");
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir);
	// 20000 nested objects. `JSON.parse` accepts it; the raw scanner recurses once
	// per object level and overflows the stack somewhere below this, so the test
	// does not depend on where one machine's stack ends. Built as a string because
	// `JSON.stringify` overflows before the file could be written.
	let deep = "1";
	for (let level = 0; level < 20_000; level += 1) deep = `{"a": ${deep}}`;
	const original = `{\n  "mcpServers": {},\n  "deep": ${deep}\n}\n`;
	writeFileSync(fileIn(agentDir), original);

	const result = run([], { agentDir });
	assert.equal(result.code, 1, `${result.stdout}${result.stderr}`);
	assert.equal(result.stdout, "", "a refusal reports on stderr");
	assert.match(result.stderr, /refusing to write .*mcp\.json: it is nested too deeply/);
	assert.match(result.stderr, /nothing was written/);
	assert.doesNotMatch(result.stderr, /RangeError|Maximum call stack/, "a refusal with a reason, not a stack trace");
	assert.equal(readText(fileIn(agentDir)), original, "the target is untouched");
});

// ---------------------------------------------------------------------------
// R4 (shell half): agent-dir resolution and the wrapper
// ---------------------------------------------------------------------------

test("PI_CODING_AGENT_DIR wins over the home default", () => {
	const root = scratchDir("env");
	const agentDir = path.join(root, "selected");
	const home = path.join(root, "home");
	mkdirSync(home);

	line(run([], { agentDir, home }));
	assert.ok(existsSync(fileIn(agentDir)), "the selected agent dir gets the file");
	assert.equal(existsSync(path.join(home, ".pi", "agent", "mcp.json")), false, "the default is not touched as well");
});

test("with PI_CODING_AGENT_DIR unset, the catalogue goes to $HOME/.pi/agent", () => {
	const root = scratchDir("home");
	const home = path.join(root, "home");
	mkdirSync(home);

	line(run([], { home }));
	const created = path.join(home, ".pi", "agent", "mcp.json");
	assert.ok(existsSync(created), `expected ${created}`);
	assert.deepEqual(Object.keys(readJson(created).mcpServers), ["figma", "playwright"]);
});

test("an empty PI_CODING_AGENT_DIR falls back to the home default, as pi does", () => {
	const root = scratchDir("empty-env");
	const home = path.join(root, "home");
	mkdirSync(home);

	line(run([], { agentDir: "", home }));
	assert.ok(existsSync(path.join(home, ".pi", "agent", "mcp.json")), "an empty value is not a directory");
});

test("a leading ~ in PI_CODING_AGENT_DIR means the home directory, as pi resolves it", () => {
	const root = scratchDir("tilde");
	const home = path.join(root, "home");
	const cwd = path.join(root, "cwd");
	mkdirSync(home);
	mkdirSync(cwd);

	// pi runs the variable through `expandTildePath`; resolving it as a relative
	// path writes a file inside a directory literally named "~", which no session
	// ever reads. `cwd` is a scratch directory so the wrong answer is visible here
	// instead of landing in the checkout.
	line(run([], { agentDir: "~/agent2", home, cwd }));

	assert.ok(existsSync(path.join(home, "agent2", "mcp.json")), "~ resolves to $HOME");
	assert.equal(existsSync(path.join(cwd, "~", "agent2", "mcp.json")), false, "~ is not a directory name");
});

test("a whitespace-only PI_CODING_AGENT_DIR falls back to the home default, not a directory named ' '", () => {
	const root = scratchDir("blank-env");
	const home = path.join(root, "home");
	const cwd = path.join(root, "cwd");
	mkdirSync(home);
	mkdirSync(cwd);

	line(run([], { agentDir: "   ", home, cwd }));

	assert.ok(existsSync(path.join(home, ".pi", "agent", "mcp.json")), "a blank value is unset, not a path");
	assert.deepEqual(readdirSync(cwd), [], "nothing was written into a directory named ' '");
});

test("a blank agentDir option falls back like an unset variable instead of resolving to cwd", () => {
	const root = scratchDir("blank-option");
	const home = path.join(root, "home");
	const cwd = path.join(root, "cwd");
	mkdirSync(home);
	mkdirSync(cwd);

	// `path.resolve("")` is the cwd, so a caller passing an empty or blank value —
	// the shape a shell variable takes when it was never set — would drop an
	// mcp.json wherever the process happened to start. The option has to mean
	// "unset", which is only reachable through the module, not through the CLI.
	const script = [
		`const { installCatalogue } = await import(${JSON.stringify(CLI)});`,
		`const env = ${JSON.stringify({ HOME: home })};`,
		`const cataloguePath = ${JSON.stringify(CATALOGUE)};`,
		`const empty = installCatalogue({ agentDir: "", cataloguePath, env });`,
		`const blank = installCatalogue({ agentDir: "   ", cataloguePath, env });`,
		`process.stdout.write(JSON.stringify({ empty: empty.path, blank: blank.path }));`,
	].join("\n");
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		encoding: "utf8",
		env: BASE_ENV,
		cwd,
		timeout: 60_000,
	});
	assert.equal(result.status, 0, result.stderr);

	const expected = path.join(home, ".pi", "agent", "mcp.json");
	const paths = JSON.parse(result.stdout);
	assert.equal(paths.empty, expected, "an empty agentDir resolves like an unset one");
	assert.equal(paths.blank, expected, "and so does a whitespace-only one");
	assert.equal(existsSync(path.join(cwd, "mcp.json")), false, "nothing was written beside the process");
	assert.ok(existsSync(expected), "the catalogue went to the home default");
});

test("with neither PI_CODING_AGENT_DIR nor HOME there is no agent dir, so it exits 2", () => {
	const result = run([]);
	assert.equal(result.code, 2, `${result.stdout}${result.stderr}`);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /cannot resolve the agent dir/);
	assert.match(result.stderr, /PI_CODING_AGENT_DIR/);
});

test("bin/mcp-catalogue installs the catalogue and passes --if-missing through", () => {
	const root = scratchDir("wrapper");
	const agentDir = path.join(root, "agent");

	const merged = line(runWrapper([], { agentDir }));
	assert.match(merged, /created .*mcp\.json — added figma, playwright/);
	assert.deepEqual(Object.keys(readJson(fileIn(agentDir)).mcpServers), ["figma", "playwright"]);

	const other = path.join(root, "seeded");
	const seeded = line(runWrapper(["--if-missing"], { agentDir: other }));
	assert.match(seeded, /created .*--if-missing/);
	assert.ok(existsSync(fileIn(other)));
});

test("the wrapper finds the module through a symlink, so it can sit on PATH", () => {
	const root = scratchDir("wrapper-link");
	const link = path.join(root, "mcp-catalogue");
	symlinkSync(WRAPPER, link);

	const output = line(runWrapper([], { agentDir: path.join(root, "agent"), wrapper: link }));
	assert.match(output, /created .*mcp\.json/);
});

test("the wrapper's --help prints the module's usage", () => {
	const result = runWrapper(["--help"]);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /^usage: node tools\/mcp-catalogue\.mjs \[--if-missing\]/);
	assert.match(result.stdout, /--if-missing/);
	assert.match(result.stdout, /Exit codes/);
});

// ---------------------------------------------------------------------------
// The seeding mode: --if-missing is a pinned contract (tickets 03 and 04)
// ---------------------------------------------------------------------------

test("--if-missing creates the file when it is absent, with both servers disabled", () => {
	const root = scratchDir("if-missing-create");
	const agentDir = path.join(root, "agent");

	const output = line(run(["--if-missing"], { agentDir }));
	assert.match(output, /created/);
	assert.match(output, /figma, playwright/);
	assert.match(output, /--if-missing/);

	const server = readJson(fileIn(agentDir)).mcpServers;
	assert.equal(server.figma.enabled, false);
	assert.equal(server.playwright.enabled, false);
});

test("--if-missing leaves an existing file alone, even one missing a catalogue entry", () => {
	const root = scratchDir("if-missing-kept");
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir);
	// Only figma: a merge would add playwright, which is exactly what seeding must
	// not do — an operator who deleted a name here means it to stay deleted.
	const existing = '{\n  "mcpServers": {\n    "figma": { "enabled": false }\n  }\n}\n';
	writeFileSync(fileIn(agentDir), existing);

	const output = line(run(["--if-missing"], { agentDir }));
	assert.match(output, /kept .*--if-missing/);
	assert.equal(readText(fileIn(agentDir)), existing, "seeding never merges, so the file is byte-identical");
});

test("--if-missing does not read an existing file, so an unparseable one cannot break a rebuild", () => {
	const root = scratchDir("if-missing-mangled");
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir);
	const mangled = "{ this file is hand-edited and broken\n";
	writeFileSync(fileIn(agentDir), mangled);

	const output = line(run(["--if-missing"], { agentDir }));
	assert.match(output, /kept/);
	assert.equal(readText(fileIn(agentDir)), mangled);
});

test("--if-missing refuses a target that is a directory instead of reporting it kept", () => {
	const root = scratchDir("if-missing-directory");
	const agentDir = path.join(root, "agent");
	// A directory named mcp.json is the shape of a mistake — a stray `mkdir`, or a
	// hand-built agent dir — and "kept … it exists" reports it as fine while pi
	// still finds no file.
	mkdirSync(fileIn(agentDir), { recursive: true });

	const result = run(["--if-missing"], { agentDir });
	assert.equal(result.code, 1, `${result.stdout}${result.stderr}`);
	assert.equal(result.stdout, "", "a refusal reports on stderr");
	assert.match(result.stderr, /refusing to write .*mcp\.json: it is a directory/);
	assert.match(result.stderr, /nothing was written/);
	assert.ok(statSync(fileIn(agentDir)).isDirectory(), "the directory is left alone");
	assert.deepEqual(readdirSync(fileIn(agentDir)), [], "and nothing was seeded inside it");
});

test("--if-missing refuses an empty mcp.json instead of claiming the state is fine", () => {
	const root = scratchDir("if-missing-empty");
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir);
	// A 0-byte file is what the write this tool used to do leaves behind when it
	// dies, and it is not a seeded catalogue. Seeding still does not read it — the
	// size is a property of the directory entry — so the hand-edited case above
	// stays "kept".
	writeFileSync(fileIn(agentDir), "");

	const result = run(["--if-missing"], { agentDir });
	assert.equal(result.code, 1, `${result.stdout}${result.stderr}`);
	assert.equal(result.stdout, "", "a refusal reports on stderr");
	assert.match(result.stderr, /refusing to write .*mcp\.json: it is an empty file/);
	assert.match(result.stderr, /nothing was written/);
	assert.equal(readText(fileIn(agentDir)), "", "an empty file is not filled in by seeding mode");
});

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

test("--help exits 0 and an unknown option exits 2 with the usage", () => {
	const help = run(["--help"]);
	assert.equal(help.code, 0);
	assert.match(help.stdout, /^usage: node tools\/mcp-catalogue\.mjs/);
	// The documented exit codes have to name every cause, including the one a
	// permission or directory error takes, which is the same 2 as an unknown option.
	assert.match(help.stdout, /cannot be written/);

	const unknown = run(["--json"]);
	assert.equal(unknown.code, 2);
	assert.equal(unknown.stdout, "");
	assert.match(unknown.stderr, /unknown option: --json/);
	assert.match(unknown.stderr, /usage: node tools\/mcp-catalogue\.mjs/);

	const positional = run(["unexpected"]);
	assert.equal(positional.code, 2);
	assert.match(positional.stderr, /takes no arguments, got unexpected/);
});
