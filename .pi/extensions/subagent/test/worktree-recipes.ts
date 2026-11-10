// Executable harness for the recipes in `.pi/skills/worktree/SKILL.md`.
//
// `worktree-skill.test.ts` used to be substring assertions only, which is how a
// documented Create block that could not start, and a Remove block that exited 0
// after refusing to remove a dirty tree, both shipped green. This module extracts
// the fenced bash blocks from the skill and runs them in a scratch repository, so
// a recipe is pinned by what it does, not by tokens it happens to contain.
//
// Two deliberate choices:
//
// - **No `set -e` by default.** The blocks are written to be pasted into a shell,
//   so the harness runs them exactly as written and reports the block's real exit
//   status. Wrapping every block in errexit would make a recipe look safe that is
//   not, and would hide an ignored failure the author meant to handle.
// - **`errexit: true` is a separate, explicit mode.** It runs the block under
//   `set -euo pipefail`, which is the shape the fix for the removal
//   exit-code bug introduces: a block must survive it, and a block that only
//   exits non-zero because of errexit must be distinguishable from one that
//   propagates a failure on its own.
//
// Everything runs against a real `git` binary and a real repository tree under
// os.tmpdir(): the recipes' own output is the fixture.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
export const SKILL_PATH = path.join(REPO_ROOT, ".pi/skills/worktree/SKILL.md");

/** One fenced ```bash block from the skill, named by its `## <section>` heading. */
export interface RecipeBlock {
	section: string;
	index: number;
	/** 1-based line number of the opening fence, for diagnostics. */
	line: number;
	code: string;
}

export function readSkill(): string {
	return readFileSync(SKILL_PATH, "utf8");
}

/**
 * Every fenced bash block in the skill, in document order, tagged with the
 * `## ` heading it appears under and its position within that section.
 *
 * `index` is per section rather than global so a test can name
 * `recipe("Remove", 3)` and survive an unrelated block being added above it.
 */
export function blocks(): RecipeBlock[] {
	const out: RecipeBlock[] = [];
	const counters = new Map<string, number>();
	let section = "(preamble)";
	let open: { section: string; index: number; line: number; buf: string[] } | null = null;

	readSkill().split("\n").forEach((line, i) => {
		if (!open) {
			const heading = /^##\s+(.+?)\s*$/.exec(line);
			if (heading) section = heading[1];
			if (/^```bash\s*$/.test(line)) {
				const index = counters.get(section) ?? 0;
				counters.set(section, index + 1);
				open = { section, index, line: i + 1, buf: [] };
			}
			return;
		}
		if (/^```\s*$/.test(line)) {
			out.push({ section: open.section, index: open.index, line: open.line, code: open.buf.join("\n") });
			open = null;
			return;
		}
		open.buf.push(line);
	});

	if (open) throw new Error(`unterminated bash fence in ${SKILL_PATH} at line ${open.line}`);
	return out;
}

/** The `index`-th bash block of `section`; throws with the real section names when misnamed. */
export function recipe(section: string, index = 0): string {
	const block = blocks().find((b) => b.section === section && b.index === index);
	if (!block) {
		const known = [...new Set(blocks().map((b) => b.section))].join(", ");
		throw new Error(`no bash block ${index} in section "${section}" (known sections: ${known})`);
	}
	return block.code;
}

/**
 * Rewrite the placeholder the skill uses so a recipe can be pointed at a scratch
 * repository. Only `"task-name"` is touched: `BASE` already reads from the
 * environment (`BASE="${BASE:-origin/dev}"`), so a test sets that in `env`.
 */
export function retarget(code: string, vars: { SLUG: string }): string {
	return code.replaceAll('"task-name"', JSON.stringify(vars.SLUG));
}

/** Deterministic, isolated git: no user config, no credential prompts, fixed identity. */
export function gitEnv(): Record<string, string> {
	return {
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "Worktree Recipe Test",
		GIT_AUTHOR_EMAIL: "worktree@test.invalid",
		GIT_COMMITTER_NAME: "Worktree Recipe Test",
		GIT_COMMITTER_EMAIL: "worktree@test.invalid",
	};
}

/** process.env without inherited GIT_* (a pi child can carry GIT_DIR), plus `extra`. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return { ...env, ...gitEnv(), ...extra };
}

export interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Run a recipe exactly as a shell would: `bash -c <code>`, in `cwd`, with the
 * scratch git environment. `errexit` prepends `set -euo pipefail`.
 */
export function runScript(
	code: string,
	opts: { cwd: string; env?: Record<string, string>; errexit?: boolean },
): RunResult {
	const script = opts.errexit ? `set -euo pipefail\n${code}` : code;
	const result = spawnSync("bash", ["-c", script], {
		cwd: opts.cwd,
		encoding: "utf8",
		env: cleanEnv(opts.env),
		timeout: 60_000,
	});
	if (result.error) throw result.error;
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export interface ScratchRepo {
	/** Temp directory holding the bare origin and the clone. */
	root: string;
	/** Bare repository acting as `origin`. */
	origin: string;
	/** The clone: a normal checkout on `dev`, tracking `origin/dev`. */
	main: string;
	/** `git` in the main checkout. */
	git(...args: string[]): string;
	/** `git` in any directory inside the scratch tree. */
	gitIn(dir: string, ...args: string[]): string;
	/** Where the skill puts a worktree for `slug`. */
	pathOf(slug: string): string;
	/** One record per worktree, from `git worktree list --porcelain`. */
	worktrees(): string;
	/** Tip of `origin/dev` as the clone sees it. */
	originDev(): string;
	cleanup(): Promise<void>;
}

/**
 * A scratch repository shaped like this one: `dev` as the integration branch,
 * an `origin` to fetch from, and a `.gitignore` that deliberately has no
 * trailing newline (the ignore guard's documented failure mode).
 */
export async function scratchRepo(): Promise<ScratchRepo> {
	const root = await mkdtemp(path.join(tmpdir(), "worktree-skill-"));
	const origin = path.join(root, "origin.git");
	const seed = path.join(root, "seed");
	const main = path.join(root, "main");

	const gitIn = (dir: string, ...args: string[]): string =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv() });

	await mkdir(seed);
	gitIn(seed, "init", "-q", "-b", "dev");
	await writeFile(path.join(seed, "README.md"), "seed\n");
	// No trailing newline on purpose: appending `.worktrees/` to this file
	// without a newline prelude yields `node_modules.worktrees/`.
	await writeFile(path.join(seed, ".gitignore"), "node_modules");
	gitIn(seed, "add", ".");
	gitIn(seed, "commit", "-q", "-m", "seed");
	gitIn(root, "init", "-q", "--bare", "-b", "dev", origin);
	gitIn(seed, "remote", "add", "origin", origin);
	gitIn(seed, "push", "-q", "origin", "dev");
	gitIn(root, "clone", "-q", origin, main);
	gitIn(main, "config", "user.name", "Worktree Recipe Test");
	gitIn(main, "config", "user.email", "worktree@test.invalid");

	return {
		root,
		origin,
		main,
		git: (...args: string[]) => gitIn(main, ...args),
		gitIn,
		pathOf: (slug: string) => path.join(main, ".worktrees", slug),
		worktrees: () => gitIn(main, "worktree", "list", "--porcelain"),
		originDev: () => gitIn(main, "rev-parse", "origin/dev").trim(),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}
