#!/usr/bin/env node
// branch-base.mjs — enforce the branch-base rule: a branch descends from the
// current origin/dev and carries only its own commits.
//
//   node tools/branch-base.mjs
//
// This is the enforcer for the first row of AGENTS.md's "Rules and
// enforcement" table. The rule has three recorded misses in AGENTS.md, all
// caught by a reviewer rather than by anything automatic; this is the check
// that makes the fourth cost a red build instead of a review round.
//
// Node standard library only. It fetches origin/dev, reads history, and prints
// one line: the classification plus the command that fixes it. It does not
// commit, push, check anything out, or move a ref beyond that fetch.
//
// Exit codes: 0 the base is right, 1 the rule is broken, 2 the check could not
// run (not a work tree, no origin/dev to compare against).
//
// Classifications, and why there are four rather than "pass/fail":
//
//   correct         origin/dev is an ancestor of HEAD, and the oldest commit in
//                   origin/dev..HEAD sits directly on origin/dev. Every commit
//                   the branch carries is its own and none is a foreign one.
//                   HEAD being exactly origin/dev is correct too: the branch
//                   carries nothing of its own, so there is no base to check.
//   foreign-commits origin/dev is an ancestor, but the oldest commit in
//                   origin/dev..HEAD does not sit on origin/dev. HEAD reaches
//                   the dev tip without the branch's own commits sitting on it:
//                   the branch merged dev in instead of being rebased onto it,
//                   or it carries another branch's commits as well. The
//                   `--onto` command on the line replays this branch's commits
//                   onto origin/dev.
//   behind-dev      HEAD is an ancestor of origin/dev: the branch has no commits
//                   of its own yet. Reported separately because "rebase or start
//                   from dev" is the fix, and calling it a wrong base would send
//                   the reader looking for a branch point that is not there.
//   wrong-base      Neither ancestor case holds, so the branch does not descend
//                   from origin/dev at all — the branch-off-main mistake. The
//                   line names the branch point, i.e. the commit the branch
//                   actually started from.
//
// Known limits, stated rather than papered over:
//
// - A branch stacked on an *unmerged* feature branch is invisible here when dev
//   has not moved: the oldest commit in origin/dev..HEAD is then that branch's
//   first commit, whose parent is origin/dev. AGENTS.md says the same thing
//   about its two hand-run commands; only naming the base branch would tell the
//   difference.
// - A branch cut from an older dev, with no merge of dev into it, fails as
//   wrong-base rather than foreign-commits, because the current dev tip is not
//   an ancestor of HEAD at all. That is still the right red build, just a
//   different line, and it is why the classification text sends the reader to
//   `git log --oneline origin/dev..HEAD` for the detail.

import { spawnSync } from "node:child_process";
import process from "node:process";

const REMOTE = "origin";
const BRANCH = "dev";
const BASE_LABEL = `${REMOTE}/${BRANCH}`;
// The explicit refspec, rather than a bare `git fetch origin dev`: a bare fetch
// writes FETCH_HEAD and only updates refs/remotes/origin/dev when the remote's
// configured refspec happens to cover it, which is not guaranteed in CI.
const BASE_REF = `refs/remotes/${REMOTE}/${BRANCH}`;
const SHORT = 7;

const USAGE = `usage: node tools/branch-base.mjs
       node tools/branch-base.mjs --help

Checks that HEAD descends from the freshly fetched origin/dev and carries only
its own commits. Run it from the repository root or any linked worktree; the
repository is resolved with \`git rev-parse --show-toplevel\`, never a
hard-coded path.

Exit codes
  0  correct: based on origin/dev, or HEAD is origin/dev itself
  1  behind-dev, foreign-commits, or wrong-base; the line names the fix
  2  the check could not run: not a work tree, or origin/dev cannot be resolved
`;

/**
 * Run git and capture it, never throw. A non-zero status is a fact about the
 * repository that the classifications below turn into a line, not an exception.
 */
function git(args) {
	const result = spawnSync("git", args, { encoding: "utf8" });
	const status = typeof result.status === "number" ? result.status : 1;
	return {
		status,
		ok: status === 0,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? result.error?.message ?? "").trim(),
	};
}

const short = (sha) => sha.slice(0, SHORT);

/** `<short sha> "<subject>"` for a commit, so a line names what it is talking about. */
function describe(sha) {
	const subject = git(["show", "-s", "--format=%s", sha]).stdout.split("\n")[0] ?? "";
	return `${short(sha)} "${subject}"`;
}

/** One line on stdout: the classification, then the concrete next command. */
function report(line) {
	process.stdout.write(`branch-base: ${line}\n`);
}

/** Exit 2: the check could not run, so it says nothing about the branch. */
function environmentError(message) {
	process.stderr.write(`branch-base: ${message}\n`);
	return 2;
}

function main(argv) {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(USAGE);
		return 0;
	}
	const unknown = argv.find((argument) => argument.startsWith("-"));
	if (unknown !== undefined) {
		process.stderr.write(`branch-base: unknown option: ${unknown}\n${USAGE}`);
		return 2;
	}
	if (argv.length > 0) {
		process.stderr.write(`branch-base: takes no arguments, got ${argv.join(" ")}\n${USAGE}`);
		return 2;
	}

	const root = git(["rev-parse", "--show-toplevel"]);
	if (!root.ok || root.stdout === "") {
		return environmentError(`not a git work tree: ${process.cwd()}`);
	}

	const fetch = git(["fetch", "--quiet", "--no-tags", REMOTE, `+refs/heads/${BRANCH}:${BASE_REF}`]);
	const base = git(["rev-parse", "--verify", "--quiet", `${BASE_REF}^{commit}`]);
	if (!base.ok || base.stdout === "") {
		const reason = fetch.stderr === "" ? `no such ref after fetching ${BASE_LABEL}` : fetch.stderr;
		return environmentError(
			`cannot resolve ${BASE_LABEL} in ${root.stdout}: ${reason}\n` +
				`       fix: git remote -v, then git fetch ${REMOTE} ${BRANCH}`,
		);
	}
	const baseSha = base.stdout;

	const head = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
	if (!head.ok || head.stdout === "") {
		return environmentError(`${root.stdout} has no HEAD commit to check`);
	}
	const headSha = head.stdout;

	// A detached HEAD (CI checks out the pull request's head commit) has no
	// branch name; say so rather than inventing one, and push HEAD.
	const attached = git(["symbolic-ref", "--short", "-q", "HEAD"]);
	const branch = attached.ok && attached.stdout !== "" ? attached.stdout : "HEAD (detached)";
	const target = attached.ok && attached.stdout !== "" ? attached.stdout : "HEAD";

	if (headSha === baseSha) {
		report(
			`correct — HEAD is exactly ${BASE_LABEL} (${short(baseSha)}): there is no branch base to check, because the branch carries nothing of its own yet; ` +
				`next: git checkout -b <change-name> ${BASE_LABEL}`,
		);
		return 0;
	}

	if (git(["merge-base", "--is-ancestor", "HEAD", BASE_REF]).ok) {
		report(
			`behind-dev — ${branch} has no commits of its own: HEAD ${short(headSha)} is an ancestor of ${BASE_LABEL} ${short(baseSha)}; ` +
				`next: git rebase ${BASE_LABEL} (or start again with git checkout -b <change-name> ${BASE_LABEL})`,
		);
		return 1;
	}

	if (!git(["merge-base", "--is-ancestor", BASE_REF, "HEAD"]).ok) {
		const point = git(["merge-base", BASE_REF, "HEAD"]).stdout;
		const where = point === "" ? "no common ancestor with " + BASE_LABEL : describe(point);
		report(
			`wrong-base — ${branch} does not descend from ${BASE_LABEL} (${short(baseSha)}); the branch point is ${where}; ` +
				`next: git rebase --onto ${BASE_LABEL} ${point === "" ? "<base>" : short(point)} ${target}`,
		);
		return 1;
	}

	// Based on origin/dev somewhere. "The oldest commit this branch carries" is
	// the first one out of a reverse topological walk of the range: topo-order
	// keeps an ancestry chain in order, and --reverse then puts the earliest
	// commit of that chain first.
	const range = `${BASE_REF}..HEAD`;
	const oldest = git(["rev-list", "--reverse", "--topo-order", range])
		.stdout.split("\n")
		.filter((line) => line !== "")[0];
	if (oldest === undefined) {
		// origin/dev is an ancestor and HEAD is not an ancestor of origin/dev, so
		// the range cannot be empty; treat it as runnable-but-broken rather than
		// pretending the branch is fine.
		return environmentError(`cannot list the commits in ${BASE_LABEL}..HEAD`);
	}

	const parentResult = git(["rev-parse", `${oldest}^`]);
	const parent = parentResult.ok ? parentResult.stdout : "";

	if (parent === baseSha) {
		const count = Number(git(["rev-list", "--count", range]).stdout);
		report(
			`correct — ${branch} descends from ${BASE_LABEL} (${short(baseSha)}) and carries ` +
				`${count} commit${count === 1 ? "" : "s"} of its own; ` +
				`next: git push -u ${REMOTE} ${target} && gh pr create --base ${BRANCH} --fill`,
		);
		return 0;
	}

	report(
		`foreign-commits — the oldest commit on top of ${BASE_LABEL} is ${describe(oldest)}, whose parent is ` +
			`${parent === "" ? "nothing (a root commit)" : describe(parent)}, not ${BASE_LABEL} ${short(baseSha)}: ` +
			`the branch merged ${BRANCH} in instead of being rebased onto it, or it carries another branch's commits; ` +
			`next: git rebase --onto ${BASE_LABEL} ${parent === "" ? "<base>" : short(parent)} ${target}, ` +
			`then confirm git log --oneline ${BASE_LABEL}..HEAD lists only this branch's commits`,
	);
	return 1;
}

process.exitCode = main(process.argv.slice(2));
