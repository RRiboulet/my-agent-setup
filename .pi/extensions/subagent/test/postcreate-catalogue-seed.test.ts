// postCreate.sh seeds the MCP catalogue, once, and in the only order that works.
//
// The container half of R5: a container built from this repo starts with
// `mcp.json` in the agent dir pi reads, so a fresh private volume is not the one
// machine where the catalogue is missing. The work itself belongs to
// `tools/mcp-catalogue.mjs --if-missing` — the seeding mode whose two filesystem
// behaviours (fresh dir → both names, all disabled; existing file → untouched)
// `tools/mcp-catalogue.test.mjs` proves against a temp agent dir — so the only
// thing left that can go wrong here is that `postCreate.sh` stops reaching it, or
// reaches it too early.
//
// Too early is the failure this file exists for. `set -euo pipefail` is line 2, so
// a seed placed above the `mkdir -p "$PROJECT_AGENT_DIR"` line is not "skipped on
// a fresh volume": it exits non-zero and aborts the whole of postCreate, taking
// the trust entry, the theme and the git identity with it. That is the class of
// failure the script already records for the volume's ownership — a write as
// vscode before the chown — and there it is worse, because the module's own
// contract says it does *not* create the agent dir (exit 2), i.e. it fails on the
// one run that matters; one line lower, above the `sudo chown -R` that makes the
// volume writable, it fails EACCES *silently*, since the seed only warns.
//
// So both placements are asserted, not just the mkdir: an order guard that pinned
// only "after the agent dir exists" let the seed drift back above the chown, which
// is the failure the script's own comment sets out at length.
//
// A static check, because running postCreate.sh needs the devcontainer user and a
// container around it (`sudo chown`, `sudo install`), neither of which
// `node --test` has — the same reason `devcontainer-agent-dir.test.ts` reads
// `devcontainer.json` rather than launching a container. What it proves: the call
// exists exactly once, names the module through the script's own repo variable,
// passes `--if-missing`, cannot abort postCreate, and sits after the agent dir is
// created and after the private pi volume is chowned, and before the package-free
// invariant block. What it deliberately cannot prove: that the call succeeded.
// Only a real run of postCreate can say that, and the module's own tests are what
// make the side effect true.
//
// The anchors are derived from the files, in the style of
// `devcontainer-agent-dir.test.ts`: the repo variable is the assignment whose
// value is `devcontainer.json`'s `workspaceFolder`, and the agent dir variable is
// the one the `mkdir -p "$…_AGENT_DIR"` line creates. A hard-coded needle would
// make this guard vacuous the moment either is renamed, and would fail with a
// message about the wrong thing.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const SCRIPT = ".devcontainer/postCreate.sh";
const read = (...parts: string[]) => readFileSync(path.join(REPO_ROOT, ...parts), "utf8");

/** 1-based `SCRIPT:line`, so a failure names the line to move rather than a needle. */
const at = (index: number) => `${SCRIPT}:${index + 1}`;

const lines = read(SCRIPT).split("\n");

function anchor(predicate: (line: string) => boolean, what: string): number {
	const index = lines.findIndex((line) => predicate(line));
	assert.ok(
		index >= 0,
		`${SCRIPT} no longer contains ${what}. This guard reads its anchors out of the script: update the anchor along with the restructuring instead of deleting the guard.`,
	);
	return index;
}

/**
 * The variable the script names the checkout by. Read from `devcontainer.json`'s
 * `workspaceFolder` rather than assumed to be `REPO`, so the spelling this guard
 * insists on is the one the script already uses for the mount.
 */
function repoVariable(): string {
	const folder = /"workspaceFolder"\s*:\s*"([^"]+)"/u.exec(read(".devcontainer/devcontainer.json"))?.[1];
	assert.ok(folder, '.devcontainer/devcontainer.json must declare "workspaceFolder"');
	const assignment = new RegExp(
		`^([A-Za-z_][A-Za-z0-9_]*)=${folder.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
		"mu",
	).exec(lines.join("\n"));
	assert.ok(assignment?.[1], `${SCRIPT} must assign the workspace folder (${folder}) to a variable`);
	return assignment[1] as string;
}

/** The agent dir variable the script creates, spelled as it spells it: `$PROJECT_AGENT_DIR`. */
const AGENT_DIR_CREATION = /^mkdir -p "(\$[A-Za-z_]*AGENT_DIR)"$/u;
const agentDirIndex = anchor(
	(line) => AGENT_DIR_CREATION.test(line),
	'the line that creates the agent dir with `mkdir -p "$…_AGENT_DIR"`',
);
const agentDirVariable = AGENT_DIR_CREATION.exec(lines[agentDirIndex] as string)?.[1] as string;

/** A top-level `NAME=value` assignment in the script, with any wrapping quotes removed. */
function assignmentValue(name: string): string {
	const value = new RegExp(String.raw`^${name}=(.*)$`, "mu").exec(lines.join("\n"))?.[1]?.trim() ?? "";
	return value.replace(/^"(.*)"$/u, "$1");
}

/**
 * The private pi volume: the directory the agent dir lives in, and so the directory
 * a first-run volume can arrive root-owned.
 *
 * Derived rather than hard-coded, in the style of the anchors above: `mkdir -p
 * "$X_AGENT_DIR"` creates a variable whose value may reach the path through one
 * `${VAR:-fallback}` expansion — `PROJECT_AGENT_DIR="${PI_CODING_AGENT_DIR:-$AGENT_DIR}"`,
 * then `AGENT_DIR=/home/vscode/.pi/agent` — and the volume is that path's parent.
 * Hard-coding today's `/home/vscode/.pi` would let the guard keep passing after
 * the volume moves, which is the one thing it is here to notice.
 */
function volumePath(): string {
	const expansion = /\$\{?[A-Za-z_][A-Za-z0-9_]*:?-?(\$[A-Za-z_][A-Za-z0-9_]*|\/[^}\s"]*)\}?$/u;
	let value = assignmentValue(agentDirVariable.replace(/^\$/u, ""));
	for (let hop = 0; hop < 2 && !path.posix.isAbsolute(value); hop += 1) {
		const inner = expansion.exec(value)?.[1] ?? "";
		value = inner.startsWith("$") ? assignmentValue(inner.slice(1)) : inner;
	}
	assert.ok(
		path.posix.isAbsolute(value),
		`${SCRIPT} must name the agent dir through a value that resolves to an absolute path — directly, or through one \${VAR:-fallback} expansion: this guard derives the private pi volume it lives in from that line, so it can check the seed comes after the volume is chowned`,
	);
	return path.posix.dirname(value);
}

/**
 * The line that hands the private pi volume, and the checkout, to vscode. Every
 * write into the volume has to come after it: on a first-run volume Docker copies
 * the image's `/home/vscode/.pi` into the volume *root-owned*, so a write as vscode
 * above this line fails EACCES — which the script's own comment records as
 * measured, not reasoned (`mkdir: cannot create directory '…': Permission denied`).
 */
const OWNED_VOLUME = volumePath();
const ownershipIndex = anchor(
	(line) => /^\s*sudo chown -R\b/u.test(line) && line.includes(OWNED_VOLUME) && line.includes(`"$${repoVariable()}"`),
	`the \`sudo chown -R\` line that gives vscode ownership of ${OWNED_VOLUME} and \`"$${repoVariable()}"\` before anything writes into either`,
);

/**
 * The package-free invariant block: the `if command -v jq` that opens the `jq`
 * filter dropping this repo's entries from `.packages`. Found by its filter
 * rather than its prose comment, and then by walking back to the `if` that opens
 * it, so rewording the TODO comment does not break the guard.
 */
function packageFreeInvariantIndex(): number {
	const filter = anchor(
		(line) => !/^\s*#/u.test(line) && /\.packages\b/u.test(line),
		"the package-free jq filter (the line that edits `.packages`)",
	);
	for (let index = filter; index >= 0; index -= 1) {
		if (/^if command -v jq\b/u.test(lines[index] as string)) return index;
	}
	assert.fail(`${at(filter)} edits .packages, but no \`if command -v jq\` opens that block`);
}

/**
 * Every line that runs the module in seeding mode: the module named through the
 * script's repo variable, quoted, with `--if-missing` as an argument. Matching the
 * whole invocation rather than looking for the string `--if-missing` is the point:
 * a removed call whose message still mentions the flag would otherwise pass.
 */
function seedInvocations(repo: string): { index: number; modulePath: string }[] {
	const invocation = new RegExp(String.raw`\bnode\s+"\$\{?${repo}\}?/([^"]+)"\s+--if-missing(?:\s|;|$)`, "u");
	return lines.flatMap((line, index) => {
		const match = invocation.exec(line);
		return match ? [{ index, modulePath: match[1] as string }] : [];
	});
}

test("postCreate.sh seeds the catalogue exactly once, through the module's --if-missing mode", () => {
	const repo = repoVariable();
	const seeds = seedInvocations(repo);
	assert.equal(
		seeds.length,
		1,
		`${SCRIPT} must run \`node "$${repo}/<module>" --if-missing\` exactly once so the catalogue is seeded into the agent dir; found ${seeds.length} such line(s)${seeds.length > 0 ? ` at ${seeds.map((seed) => at(seed.index)).join(", ")}` : ""}. Zero means a fresh volume starts with no catalogue; more than one means one of them is somewhere it should not be.`,
	);

	const seed = seeds[0] as { index: number; modulePath: string };
	assert.equal(
		seed.modulePath,
		"tools/mcp-catalogue.mjs",
		`${at(seed.index)} runs ${seed.modulePath}, but the seeding contract — and the process tests for both filesystem behaviours — is tools/mcp-catalogue.mjs`,
	);
	assert.ok(
		existsSync(path.join(REPO_ROOT, seed.modulePath)),
		`${at(seed.index)} names ${seed.modulePath}, which does not exist in this checkout`,
	);

	// `--if-missing` is already required above. What it is *not* allowed to be is a
	// bare command: under `set -e` its failure would abort the rest of postCreate.
	const line = lines[seed.index] as string;
	assert.match(
		line,
		/^\s*(?:if\s+!|.*\|\|)/u,
		`${at(seed.index)} runs the seed unguarded. Under \`set -euo pipefail\` a failed seed aborts postCreate — put it in \`if ! …; then … fi\` with a warning on stderr, like the model-catalog refresh, so a container whose volume cannot be seeded still comes up`,
	);
});

test("the seed sits after the agent dir is created and the volume is chowned, and before the package-free invariant", () => {
	const [seed] = seedInvocations(repoVariable());
	assert.ok(seed, `${SCRIPT} has no seeding invocation to place; see the previous test`);
	const invariantIndex = packageFreeInvariantIndex();

	assert.ok(
		agentDirIndex < seed.index,
		`${at(seed.index)} seeds before ${at(agentDirIndex)} creates ${agentDirVariable}. The module does not create the agent dir (it exits 2 instead), and postCreate runs under \`set -e\`, so a seed above the mkdir aborts the whole script on a fresh volume.`,
	);
	// A fresh volume can arrive root-owned, so "the agent dir exists" is not enough:
	// the write also has to come after the chown that makes it writable. This one is
	// silent rather than fatal — the seed warns — so nothing else would report it.
	assert.ok(
		ownershipIndex < seed.index,
		`${at(seed.index)} seeds before ${at(ownershipIndex)}, the \`sudo chown -R\` that gives vscode ${OWNED_VOLUME}. On a first-run volume Docker copies the image's ${OWNED_VOLUME} into the volume root-owned, so a write above that line fails EACCES — and this seed only warns, so the container would come up with no catalogue and nothing saying why.`,
	);
	assert.ok(
		seed.index < invariantIndex,
		`${at(seed.index)} must run before the package-free invariant at ${at(invariantIndex)}, which is where the ticket places it: the invariant is the last step that rewrites this container's pi configuration`,
	);

	// The seed has to target the directory the script just created. The module
	// falls back to its own resolution ($PI_CODING_AGENT_DIR, else $HOME/.pi/agent),
	// and in this container that fallback is a *different* directory — pi reads the
	// one devcontainer.json names, which is what this variable holds.
	const target = new RegExp(String.raw`PI_CODING_AGENT_DIR="(\$[A-Za-z_][A-Za-z0-9_]*)"`, "u").exec(
		lines[seed.index] as string,
	);
	assert.ok(
		target,
		`${at(seed.index)} must set PI_CODING_AGENT_DIR to ${agentDirVariable} — the agent dir ${at(agentDirIndex)} created — or the seed writes wherever the module's own resolution lands`,
	);
	assert.equal(
		target[1],
		agentDirVariable,
		`${at(seed.index)} seeds ${target[1]}, but ${at(agentDirIndex)} creates ${agentDirVariable}`,
	);
});
