#!/usr/bin/env node
// mcp-catalogue.mjs — install this package's MCP server catalogue into an agent
// dir, adding only the servers that dir does not already have.
//
//   node tools/mcp-catalogue.mjs               # add the missing servers
//   node tools/mcp-catalogue.mjs --if-missing  # create the file only if absent
//
// The failure this prevents. `pi install` ships extensions and skills from the
// `pi` manifest, and MCP configuration from nothing at all: pi reads it only
// from `<agent dir>/mcp.json` and a trusted project's `.pi/mcp.json`. So a
// colleague who installs this package gets the operator's extensions and none of
// the operator's MCP servers, and the obvious cure — `pi mcp add` per machine —
// cannot write a *disabled* entry, so it switches two servers on in every
// project at once, with an OAuth prompt and two background processes attached.
// This is the other half: one catalogue, one merge, one file.
//
// Add-only, deliberately unlike pi's own `addMcpServerConfig`. A name already in
// the file — pinned to an older `@playwright/mcp`, given a local `args`, or
// replaced by a full definition — is left exactly as written and reported as
// skipped. Overwriting it would silently undo the pin the README tells a
// colleague to make when a Playwright release breaks, and no marker can help
// here: a project override may carry only `enabled`, `exposure` and
// `toolExposure`, so re-installation has to be name-based.
//
// Formatting is this file's problem, so the merge is textual rather than a
// re-serialisation of parsed JSON: the new entries are spliced into the existing
// `mcpServers` object, and every other byte of the document — `autoEnableCodemode`,
// a hand-edited entry's own line breaks, the file's indentation and line endings
// — survives untouched. Re-stringifying would reformat a pinned entry while
// claiming to have preserved it.
//
// `--if-missing` is the seeding mode: create the file from the catalogue only
// when it is absent, and otherwise do not read, merge into, or rewrite it. That
// is what an unattended step needs (a container rebuild, a per-checkout agent
// dir), because seeding must never resurrect an entry someone deleted on
// purpose. Installing is a person asking, so adding a name they have not got yet
// is the whole point there.
//
// The write is atomic, and that is what the temp file is for: the whole document
// is rendered first and then renamed over the target, so a crash or a full
// filesystem leaves the file the operator had. Writing the target directly
// truncated an existing mcp.json to zero bytes when the write died half-way, and
// a truncated file is the one outcome worse than refusing: the operator's own
// entries are gone and the run reported nothing worth reading.
//
// The catalogue may carry no credential at all. Validation refuses an entry with
// `auth`, `env` or `headers` outright rather than shape-checking the last two,
// because a shared catalogue ships to every colleague and `{"env":
// {"FIGMA_TOKEN": "…"}}` is a well-shaped object. A server that needs an
// environment variable or an authorization header is the user's to define in
// their own agent dir, where the secret lives.
//
// What it does not do: no network, no OAuth, no `pi mcp add`, and no connection
// to any server. Writing a disabled entry is a file write, nothing more.
//
// Known limits, stated rather than papered over:
//
// - A one-line file (`{"mcpServers":{}}`) gains its entries with line breaks
//   inside that object, because the object's own closing brace is the only
//   indentation evidence a one-line file offers. Valid JSON, mixed layout; the
//   file's existing bytes are still untouched.
// - The indent unit is taken from the first indented line in the file. A file
//   whose first indented line is nested deeper than the root reports a wider
//   unit, which affects only how the *new* entries are laid out.
// - A duplicated top-level "mcpServers" key is merged into its last occurrence,
//   because that is the one `JSON.parse` keeps.
// - The catalogue is validated, not the file: a hand-mangled existing entry that
//   pi's validator rejects is preserved as-is along with everything else.
// - `--if-missing` reports "kept" only for a regular file with content. A target
//   that is a directory, a pipe or an empty file is refused instead: pi would
//   load none of them, so calling that state fine is the silent no-op every other
//   refusal in this file exists to avoid.
// - A document nested too deeply for the raw scanner to walk is refused rather
//   than crashed on. The scanner recurses per object level, so some depth the
//   parser still accepts overflows the stack; that is a refusal with a reason,
//   not a RangeError with a stack trace.

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The catalogue this package ships: `<package root>/mcp/catalogue.json`. */
export const DEFAULT_CATALOGUE_PATH = path.resolve(MODULE_DIR, "..", "mcp", "catalogue.json");

const FILE_NAME = "mcp.json";
const DEFAULT_INDENT = "  ";
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const EXPOSURES = new Set(["codemode", "deferred", "direct", "hidden"]);
const TYPES = new Set(["stdio", "http", "streamable-http"]);
const MODES = new Set(["merge", "if-missing"]);

const USAGE = `usage: node tools/mcp-catalogue.mjs [--if-missing]
       bash bin/mcp-catalogue [--if-missing]
       (either form) --help

Installs this package's MCP server catalogue (mcp/catalogue.json) into
<agent dir>/mcp.json, with every server disabled and exposure "codemode", so
nothing connects until a project enables it.

The agent dir is $PI_CODING_AGENT_DIR when it is set and non-blank, with a
leading "~" expanded to $HOME as pi does, else $HOME/.pi/agent. The directory
and the file are created when they are absent.

  (no flag)     add the catalogue servers the file does not already have. An
                existing server of the same name is left byte-identical and
                reported as skipped; every other byte of the file is preserved,
                including unrelated keys and the file's own indentation.
  --if-missing  create the file from the catalogue only when it is absent. An
                existing file is neither read nor merged into nor rewritten, so
                an entry deleted on purpose stays deleted across re-runs. A
                target that exists but is not a regular file with content (a
                directory, a pipe, an empty file) is refused.

Exit codes
  0  installed, created, or nothing to do
  1  refused to write: the catalogue fails validation, <agent dir>/mcp.json
     exists and cannot be merged into (unparseable, or not a JSON object), or
     --if-missing found a target that is not a regular file with content.
     Nothing was written.
  2  could not run: an unknown option, a catalogue that cannot be read, an
     agent dir that cannot be resolved (no PI_CODING_AGENT_DIR and no HOME), or
     a target that cannot be written (a permission or directory error).

One line on stdout names the file with the servers added or skipped, or says
nothing changed; a refusal prints its reasons on stderr. Nothing else is written
and no server is contacted.
`;

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a value means "not set" rather than "here": null, undefined, "" or " ". */
const isBlank = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/**
 * Every reason the catalogue would be a silent no-op in an agent dir. pi reports
 * an invalid entry and skips it, so a malformed catalogue costs a colleague the
 * server with nothing but one line in a log; the caller refuses to write instead.
 *
 * Returns human sentences, empty when the catalogue is installable.
 */
export function validateCatalogue(catalogue) {
	if (!isPlainObject(catalogue)) return ["the catalogue is not a JSON object"];
	const servers = catalogue.mcpServers;
	if (!isPlainObject(servers)) return ['the catalogue has no "mcpServers" object'];

	const names = Object.keys(servers);
	const problems = [];
	if (names.length === 0) problems.push('the catalogue\'s "mcpServers" object is empty');

	for (const name of names) {
		const where = `catalogue entry "${name}"`;
		if (!NAME_PATTERN.test(name)) {
			problems.push(`${where} has a name pi rejects: only letters, digits, "_" and "-" are allowed`);
			continue;
		}
		const entry = servers[name];
		if (!isPlainObject(entry)) {
			problems.push(`${where} is not a JSON object`);
			continue;
		}

		// `auth` is global-only in pi and belongs to the agent dir that signs in.
		// A shared catalogue that carried one would hand a credential to every
		// project that installs it.
		if (Object.hasOwn(entry, "auth")) problems.push(`${where} has an "auth" field, which belongs to the agent dir that signs in, never to a shared catalogue`);
		// `env` and `headers` are refused whether or not they are well-shaped, for
		// the same reason: that is exactly where a shipped credential would hide,
		// and `{"env": {"FIGMA_TOKEN": "…"}}` passes any shape check. A server
		// that needs either is defined by the user in their own agent dir.
		for (const key of ["env", "headers"]) {
			if (Object.hasOwn(entry, key)) {
				problems.push(`${where} has a "${key}" field, and a shipped catalogue must carry no credential: define a server that needs "${key}" in your own agent dir instead`);
			}
		}
		if (Object.hasOwn(entry, "sse")) problems.push(`${where} has an "sse" field, and pi rejects the legacy SSE transport`);
		if (entry.type !== undefined && !TYPES.has(entry.type)) {
			problems.push(`${where} has type ${JSON.stringify(entry.type)}; pi accepts "stdio", "http" or "streamable-http"`);
		}

		const hasCommand = entry.command !== undefined;
		const hasUrl = entry.url !== undefined;
		if (!hasCommand && !hasUrl) problems.push(`${where} has neither "command" nor "url"`);
		if (hasCommand && hasUrl) problems.push(`${where} has both "command" and "url"; pi needs exactly one to pick a transport`);
		if (hasCommand && (typeof entry.command !== "string" || entry.command === "")) problems.push(`${where} has a "command" that is not a non-empty string`);
		if (hasUrl && (typeof entry.url !== "string" || entry.url === "")) problems.push(`${where} has a "url" that is not a non-empty string`);
		if (entry.args !== undefined && !(Array.isArray(entry.args) && entry.args.every((argument) => typeof argument === "string"))) {
			problems.push(`${where} has "args" that is not an array of strings`);
		}
		for (const key of ["oauth", "toolExposure"]) {
			if (entry[key] !== undefined && !isPlainObject(entry[key])) problems.push(`${where} has "${key}" that is not a JSON object`);
		}

		// Both are required rather than defaulted: the catalogue's entire promise
		// is that installing it connects nothing, and that must not depend on a
		// future change to pi's defaults.
		if (typeof entry.enabled !== "boolean") problems.push(`${where} has no boolean "enabled": the catalogue ships every server disabled, explicitly`);
		if (!EXPOSURES.has(entry.exposure)) {
			const seen = entry.exposure === undefined ? "no exposure" : `exposure ${JSON.stringify(entry.exposure)}`;
			problems.push(`${where} has ${seen}; the catalogue states "codemode" (or "deferred", "direct", "hidden")`);
		}
	}

	return problems;
}

/**
 * The agent dir the way pi resolves it: `PI_CODING_AGENT_DIR` when set *and*
 * non-blank, with a leading `~` expanded, else `$HOME/.pi/agent`. Returns null
 * when neither is available, so the caller can fail instead of writing into a
 * guess.
 *
 * The `~` expansion is load-bearing: pi runs the variable through
 * `expandTildePath`, so `~/agent2` means the home directory. Resolving it as a
 * relative path writes `<cwd>/~/agent2/mcp.json`, a file pi never reads. A blank
 * value falls back to the home default for the same reason — `" "` is a
 * directory named " " that no session loads.
 */
export function resolveAgentDir(env = process.env) {
	const configured = env.PI_CODING_AGENT_DIR;
	if (typeof configured === "string" && configured.trim() !== "") return absolutePath(configured, env);
	const home = env.HOME;
	if (typeof home !== "string" || home === "") return null;
	return path.join(home, ".pi", "agent");
}

/** `value` as an absolute path, with a leading `~` or `~/…` expanded like pi does. */
function absolutePath(value, env) {
	if (value === "~" || value.startsWith("~/")) {
		const home = typeof env.HOME === "string" && env.HOME !== "" ? env.HOME : os.homedir();
		return path.resolve(value === "~" ? home : path.join(home, value.slice(2)));
	}
	return path.resolve(value);
}

/**
 * Install the catalogue into `agentDir` (default: resolveAgentDir()).
 *
 * `mode` is "merge" (add the names that are missing) or "if-missing" (create the
 * file only when it is absent). Returns a record, never throws for a condition
 * the caller can report:
 *
 *   { ok, mode, action, path, added, skipped, problems, exitCode }
 *
 * `action` is "created", "merged", "unchanged", "kept" (if-missing over an
 * existing file) or "none" (refused). `problems` holds complete sentences naming
 * the entry or file at fault, and `exitCode` is what the CLI returns for it.
 */
export function installCatalogue(options = {}) {
	const mode = options.mode ?? "merge";
	if (!MODES.has(mode)) throw new TypeError(`unknown mode: ${mode} (expected one of ${[...MODES].join(", ")})`);

	const env = options.env ?? process.env;
	// A blank `agentDir` option is a caller meaning "not set", not a request to
	// write into the current directory: `path.resolve("")` is the cwd, which would
	// drop an mcp.json beside whatever the process happened to be run from.
	const agentDir = isBlank(options.agentDir) ? resolveAgentDir(env) : options.agentDir;
	const cataloguePath = options.cataloguePath ?? DEFAULT_CATALOGUE_PATH;
	const result = { ok: false, mode, action: "none", path: "", added: [], skipped: [], problems: [], exitCode: 2 };

	if (agentDir === null || agentDir === undefined || agentDir === "") {
		return {
			...result,
			problems: ["cannot resolve the agent dir: PI_CODING_AGENT_DIR is unset and HOME is empty"],
		};
	}
	const target = path.join(absolutePath(agentDir, env), FILE_NAME);
	const here = { ...result, path: target };

	// Seeding stops at "a file is there", and that includes not reading it: an
	// unparseable or hand-mangled file is still the operator's, and a container
	// rebuild must not fail because of one. What is not a file at all is refused
	// below instead of reported as kept.
	if (mode === "if-missing") {
		const existing = targetState(target);
		if (existing.state === "file") return { ...here, ok: true, action: "kept", exitCode: 0 };
		if (existing.state !== "absent") {
			return { ...here, exitCode: existing.exitCode, problems: [`refusing to write ${target}: ${existing.problem}`, "nothing was written"] };
		}
	}

	const catalogue = readCatalogue(cataloguePath);
	if (!catalogue.ok) {
		const problems = catalogue.fatal
			? catalogue.problems
			: [...catalogue.problems.map((problem) => `refusing to write ${target}: ${problem}`), `nothing was written; fix ${cataloguePath}`];
		return { ...here, problems, exitCode: catalogue.exitCode };
	}
	const { servers } = catalogue;
	const names = Object.keys(servers);

	if (!existsSync(target)) {
		const created = { mcpServers: Object.fromEntries(names.map((name) => [name, servers[name]])) };
		const failure = writeText(target, `${JSON.stringify(created, null, DEFAULT_INDENT)}\n`);
		if (failure) return { ...here, problems: [failure] };
		return { ...here, ok: true, action: "created", added: names, exitCode: 0 };
	}

	let original;
	try {
		original = readFileSync(target, "utf8");
	} catch (error) {
		return { ...here, problems: [`cannot read ${target}: ${error.code ?? error.message}`] };
	}

	let parsed;
	try {
		parsed = JSON.parse(original);
	} catch (error) {
		return { ...here, exitCode: 1, problems: [`refusing to write ${target}: it is not valid JSON (${error.message})`, "nothing was written"] };
	}
	if (!isPlainObject(parsed)) {
		return { ...here, exitCode: 1, problems: [`refusing to write ${target}: it is not a JSON object`, "nothing was written"] };
	}
	if (parsed.mcpServers !== undefined && !isPlainObject(parsed.mcpServers)) {
		return { ...here, exitCode: 1, problems: [`refusing to write ${target}: its "mcpServers" is not a JSON object`, "nothing was written"] };
	}

	const existing = parsed.mcpServers ?? {};
	const added = names.filter((name) => !Object.hasOwn(existing, name));
	const skipped = names.filter((name) => Object.hasOwn(existing, name));
	if (added.length === 0) return { ...here, ok: true, action: "unchanged", skipped, exitCode: 0 };

	const merged = spliceServers(original, added.map((name) => [name, servers[name]]));
	if (!merged.ok) {
		return { ...here, exitCode: 1, problems: [`refusing to write ${target}: ${merged.problem}`, "nothing was written"] };
	}
	const failure = writeText(target, merged.text);
	if (failure) return { ...here, problems: [failure] };
	return { ...here, ok: true, action: "merged", added, skipped, exitCode: 0 };
}

/**
 * What is at `target` for the seeding mode: `{ state: "absent" | "file" }`, or
 * the reason it cannot be reported as kept.
 *
 * `--if-missing` promises not to read an existing file, so "kept" is decided by
 * the directory entry: a regular file with content is the operator's, whatever it
 * says. A directory, a pipe or an empty file is not something pi can load, and
 * answering "kept … it exists" for one reports a broken agent dir as fine — the
 * silent no-op this file refuses everywhere else.
 */
function targetState(target) {
	let stats;
	try {
		stats = statSync(target);
	} catch (error) {
		if (error.code === "ENOENT") return { state: "absent" };
		return { state: "unreadable", exitCode: 2, problem: `cannot inspect it: ${error.code ?? error.message}` };
	}
	if (stats.isDirectory()) {
		return { state: "unreadable", exitCode: 1, problem: "it is a directory, so nothing was seeded and pi would still find no file; remove it and run again" };
	}
	if (!stats.isFile()) {
		const kind = stats.isFIFO() ? "a named pipe" : stats.isSocket() ? "a socket" : "a device or other non-file";
		return { state: "unreadable", exitCode: 1, problem: `it is ${kind}, not a regular file, so nothing was seeded and pi could not read a file there; remove it and run again` };
	}
	if (stats.size === 0) {
		return { state: "unreadable", exitCode: 1, problem: "it is an empty file, which is what a truncated or never-finished write leaves behind, not a seeded catalogue; fill it in, or delete it and run again" };
	}
	return { state: "file" };
}

function readCatalogue(cataloguePath) {
	let raw;
	try {
		raw = readFileSync(cataloguePath, "utf8");
	} catch (error) {
		return { ok: false, fatal: true, exitCode: 2, problems: [`cannot read the catalogue ${cataloguePath}: ${error.code ?? error.message}`] };
	}
	let catalogue;
	try {
		catalogue = JSON.parse(raw);
	} catch (error) {
		return { ok: false, fatal: true, exitCode: 2, problems: [`the catalogue ${cataloguePath} is not valid JSON: ${error.message}`] };
	}
	const problems = validateCatalogue(catalogue);
	if (problems.length > 0) return { ok: false, fatal: false, exitCode: 1, problems };
	return { ok: true, servers: catalogue.mcpServers };
}

/**
 * What a write that dies part-way costs, and what is done about it: nothing.
 *
 * Write a sibling temp file and rename it over `target` (atomic on POSIX), so a
 * crash, a full filesystem or a signal leaves the operator's file as it was. The
 * direct write this replaces truncated an existing mcp.json to zero bytes when
 * the write failed under `ulimit -f 0` — the original data gone, and a refusal
 * that could not undo it. The temp name is this process's own so two runs cannot
 * collide, the target's mode is reused when it has one (a rename would otherwise
 * widen a 0600 file to the umask), and a symlinked target is followed so a
 * dotfiles-managed mcp.json is written through rather than replaced.
 *
 * Returns null, or why it failed, having cleaned up the temp file.
 */
function writeText(target, text) {
	const destination = writeDestination(target);
	const directory = path.dirname(destination);
	const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
	try {
		const mode = fileMode(destination);
		mkdirSync(directory, { recursive: true });
		writeFileSync(temporary, text, mode === undefined ? undefined : { mode });
		renameSync(temporary, destination);
		return null;
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// Never created, or already gone: nothing to clean up.
		}
		return `cannot write ${target}: ${error.code ?? error.message}`;
	}
}

/** Where a write should land: a symlinked target is written through, not replaced. */
function writeDestination(target) {
	try {
		if (lstatSync(target).isSymbolicLink()) return realpathSync(target);
	} catch {
		// Absent, or a link that points nowhere: the path itself is the destination.
	}
	return target;
}

/** The mode of an existing regular file, so an atomic rename keeps it. */
function fileMode(target) {
	try {
		const stats = statSync(target);
		return stats.isFile() ? stats.mode & 0o777 : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Add `entries` ([name, config] pairs) to the `mcpServers` object of `text`,
 * leaving every other byte of the document alone. Returns the new text, or the
 * reason it could not: JSON is machine-written, layout here is human-owned, and
 * an untouched entry's formatting is part of what "already present" means.
 */
function spliceServers(text, entries) {
	try {
		return spliceInto(text, entries);
	} catch (error) {
		// The raw scanner below recurses once per object level, so a document
		// `JSON.parse` still accepts can overflow the stack. That is a refusal with
		// a reason — the target untouched — rather than a RangeError and a stack
		// trace, which is what an operator reading the output cannot act on.
		if (error instanceof RangeError) return { ok: false, problem: "it is nested too deeply to splice into without overflowing the stack" };
		throw error;
	}
}

function spliceInto(text, entries) {
	const root = topLevelObject(text);
	if (!root) return { ok: false, problem: "it is not a JSON object" };

	let container = root.members.filter((member) => member.key === "mcpServers").pop();
	if (!container) {
		// No mcpServers key yet: add one as a root member, then fill it.
		const welded = insertMembers(text, root.start, root.end, [], [["mcpServers", null]]);
		const grown = topLevelObject(welded);
		container = grown ? grown.members.filter((member) => member.key === "mcpServers").pop() : undefined;
		if (!grown || !container) return { ok: false, problem: "the mcpServers member could not be located after it was added" };
		return { ok: true, text: insertMembers(welded, container.valueStart, container.valueEnd, [], entries) };
	}

	if (text[container.valueStart] !== "{") return { ok: false, problem: 'its "mcpServers" is not a JSON object' };
	return { ok: true, text: insertMembers(text, container.valueStart, container.valueEnd, container.members, entries) };
}

/**
 * Insert `[name, config]` members into the object spanning `start`..`end` (the
 * braces). `existing` are that object's current members, used only to copy their
 * indentation; `config` of null renders a member whose value is an empty object
 * placeholder, which the caller then fills in a second pass.
 */
function insertMembers(text, start, end, existing, entries) {
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const open = start;
	const close = end - 1;
	let whitespaceStart = close;
	while (whitespaceStart > open + 1 && /[ \t\r\n]/.test(text[whitespaceStart - 1])) whitespaceStart -= 1;

	// Where this object's own closing brace goes. The brace's line indent is the
	// answer whether the object spans lines (`{\n  }`) or sits inline
	// (`"mcpServers": {}`), where the line's indent is the key's, not the brace's.
	const closingIndent = lineIndentAt(text, close);
	const unit = detectIndentUnit(text);
	const memberIndent = existing.length > 0 ? (indentOfLine(text, existing[0].keyStart) ?? closingIndent + unit) : closingIndent + unit;

	const rendered = entries
		.map(([name, config]) => {
			// Only the two-pass fill of a missing mcpServers member passes null.
			const body = JSON.stringify(config ?? {}, null, unit).replace(/\n/g, newline + memberIndent);
			return `${JSON.stringify(name)}: ${body}`;
		})
		.join("," + newline + memberIndent);

	if (text.slice(open + 1, whitespaceStart).trim() === "") {
		// An empty object: the braces keep their own line, the members arrive between them.
		return text.slice(0, open + 1) + newline + memberIndent + rendered + newline + closingIndent + text.slice(close);
	}
	return text.slice(0, whitespaceStart) + "," + newline + memberIndent + rendered + text.slice(whitespaceStart);
}

/** The root object's span and its top-level members, from the raw text. */
function topLevelObject(text) {
	const start = skipWhitespace(text, 0);
	if (text[start] !== "{") return null;
	const members = [];
	let cursor = start + 1;
	while (cursor < text.length) {
		cursor = skipWhitespace(text, cursor);
		if (text[cursor] === "}" || cursor >= text.length) break;
		const keyStart = cursor;
		const keyEnd = skipString(text, cursor);
		if (keyEnd === null) return null;
		let key;
		try {
			key = JSON.parse(text.slice(keyStart, keyEnd));
		} catch {
			return null;
		}
		cursor = skipWhitespace(text, keyEnd);
		if (text[cursor] !== ":") return null;
		cursor = skipWhitespace(text, cursor + 1);
		const valueStart = cursor;
		const valueEnd = skipValue(text, cursor);
		members.push({ key, keyStart, valueStart, valueEnd, members: innerMembers(text, valueStart, valueEnd) });
		cursor = skipWhitespace(text, valueEnd);
		if (text[cursor] === ",") cursor += 1;
	}
	return { start, end: skipValue(text, start), members };
}

/** The members of an object value, so a nested object can be filled as well. */
function innerMembers(text, valueStart, valueEnd) {
	if (text[valueStart] !== "{") return [];
	const nested = topLevelObject(text.slice(valueStart, valueEnd));
	return nested ? nested.members.map((member) => ({ ...member, keyStart: member.keyStart + valueStart })) : [];
}

function skipWhitespace(text, index) {
	let cursor = index;
	while (cursor < text.length && /[ \t\r\n]/.test(text[cursor])) cursor += 1;
	return cursor;
}

/** Past the closing quote of the string at `index`, or null if it never closes. */
function skipString(text, index) {
	let cursor = index + 1;
	while (cursor < text.length) {
		if (text[cursor] === "\\") cursor += 2;
		else if (text[cursor] === '"') return cursor + 1;
		else cursor += 1;
	}
	return null;
}

/** Past the value that starts at `index` — string, container, or bare literal. */
function skipValue(text, index) {
	const first = text[index];
	if (first === '"') return skipString(text, index) ?? text.length;
	if (first === "{" || first === "[") {
		let depth = 0;
		let cursor = index;
		while (cursor < text.length) {
			const char = text[cursor];
			if (char === '"') {
				cursor = skipString(text, cursor) ?? text.length;
				continue;
			}
			if (char === "{" || char === "[") depth += 1;
			else if (char === "}" || char === "]") {
				depth -= 1;
				if (depth === 0) return cursor + 1;
			}
			cursor += 1;
		}
		return text.length;
	}
	let cursor = index;
	while (cursor < text.length && !/[,}\]\s]/.test(text[cursor])) cursor += 1;
	return cursor;
}

/** The whitespace that starts the line holding `index`, or null if it is not alone on it. */
function indentOfLine(text, index) {
	let cursor = index;
	while (cursor > 0 && (text[cursor - 1] === " " || text[cursor - 1] === "\t")) cursor -= 1;
	if (cursor === 0 || text[cursor - 1] === "\n") return text.slice(cursor, index);
	return null;
}

/** The leading whitespace of the line holding `index`, whatever else is on it. */
function lineIndentAt(text, index) {
	let start = index;
	while (start > 0 && text[start - 1] !== "\n") start -= 1;
	let end = start;
	while (end < text.length && (text[end] === " " || text[end] === "\t")) end += 1;
	return text.slice(start, end);
}

/** How the file indents one level, judged by its first indented line. */
function detectIndentUnit(text) {
	const match = /\r?\n([ \t]+)(?=\S)/.exec(text);
	return match ? match[1] : DEFAULT_INDENT;
}

const line = (text) => process.stdout.write(`mcp-catalogue: ${text}\n`);

/** One stdout line: the file, then the names added or skipped. */
function report(result) {
	const names = (list) => list.join(", ");
	const skipped = result.skipped.length > 0 ? ` — skipped ${names(result.skipped)} (already present)` : "";
	if (result.action === "created") {
		const why = result.mode === "if-missing" ? " — the file was absent (--if-missing)" : "";
		line(`created ${result.path} — added ${names(result.added)}${why}`);
	} else if (result.action === "merged") {
		line(`added ${names(result.added)} to ${result.path}${skipped}`);
	} else if (result.action === "unchanged") {
		line(`nothing added to ${result.path}${skipped}`);
	} else if (result.action === "kept") {
		line(`kept ${result.path} — it exists, so nothing was merged into it (--if-missing)`);
	}
}

function main(argv) {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(USAGE);
		return 0;
	}
	const unknown = argv.find((argument) => argument.startsWith("-") && argument !== "--if-missing");
	if (unknown !== undefined) {
		process.stderr.write(`mcp-catalogue: unknown option: ${unknown}\n${USAGE}`);
		return 2;
	}
	const positional = argv.filter((argument) => !argument.startsWith("-"));
	if (positional.length > 0) {
		process.stderr.write(`mcp-catalogue: takes no arguments, got ${positional.join(" ")}\n${USAGE}`);
		return 2;
	}

	const result = installCatalogue({ mode: argv.includes("--if-missing") ? "if-missing" : "merge" });
	if (!result.ok) {
		for (const problem of result.problems) process.stderr.write(`mcp-catalogue: ${problem}\n`);
		return result.exitCode;
	}
	report(result);
	return 0;
}

/**
 * Whether this file is the program being run, rather than a module imported by
 * the `/mcp-catalogue` command. The distinction is load-bearing: an import that
 * ran `main` would install the catalogue every time a session loads that
 * extension, which is the write-at-session-start the spec rules out. `realpath`
 * on both sides, because a symlinked wrapper and ESM's own symlink resolution
 * disagree about the spelling of the same file.
 */
function invokedAsScript() {
	const invoked = process.argv[1];
	if (typeof invoked !== "string" || invoked === "") return false;
	try {
		return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (invokedAsScript()) process.exitCode = main(process.argv.slice(2));
