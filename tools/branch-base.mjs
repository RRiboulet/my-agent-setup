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
//   correct         origin/dev is an ancestor of HEAD, origin/dev..HEAD has
//                   exactly one root commit, and that root's parent is
//                   origin/dev. One root is what a branch carrying only its own
//                   commits has; HEAD being exactly origin/dev is correct too,
//                   because the branch carries nothing of its own.
//   foreign-commits origin/dev is an ancestor, but the range starts somewhere
//                   else. Either its one root sits on an older dev (the branch
//                   merged dev in instead of being rebased onto it), or it has
//                   several roots because a merge brought a second history in.
//                   The `--onto` command on the line replays this branch's
//                   commits onto origin/dev.
//   behind-dev      HEAD is an ancestor of origin/dev, so the tip already
//                   contains everything the branch has. Reported separately
//                   because "start a new branch from dev" is the fix, and calling
//                   it a wrong base would send the reader looking for a branch
//                   point that is not there.
//   wrong-base      Neither ancestor case holds, so the branch does not descend
//                   from origin/dev at all — the branch-off-main mistake. The
//                   line names the branch point, i.e. the commit the branch
//                   actually started from.
//
// Known limits, stated rather than papered over:
//
// - A branch stacked on an *unmerged* feature branch is invisible here when dev
//   has not moved: the range then has one root, that base branch's first commit,
//   whose parent is origin/dev. AGENTS.md says the same thing about its two
//   hand-run commands; only naming the base branch would tell the difference.
// - Commits committed on top of this branch's own commits are indistinguishable
//   from this branch's own work. The root count catches a second lineage merged
//   in, not one grafted on.
// - A shallow clone cannot decide ancestry, so it exits 2 rather than guessing:
//   the graft boundary looks exactly like unrelated history.
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
  2  the check could not run: not a work tree, no origin/dev to resolve, a
     shallow clone, a failed fetch, or a repository with no commit yet
`;

// A hook or a wrapper can export GIT_DIR and point every git call at another
// repository than the one whose root this check resolves. The check means the
// repository it was run in, so those overrides are dropped. The test suite
// depends on the same hygiene for the opposite reason.
const ENV = Object.fromEntries(
	Object.entries(process.env).filter(
		([key]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|NAMESPACE)$/.test(key),
	),
);

/**
 * Run git and capture it, never throw. A non-zero status is a fact about the
 * repository that the classifications below turn into a line, not an exception.
 */
function git(args) {
	const result = spawnSync("git", args, { encoding: "utf8", env: ENV });
	const status = typeof result.status === "number" ? result.status : 1;
	return {
		status,
		ok: status === 0,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? result.error?.message ?? "").trim(),
	};
}

const short = (sha) => sha.slice(0, SHORT);

/** The first line of git's stderr: the rest is advice, and the contract is one line. */
function firstLine(text) {
	return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}

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

	const shallow = git(["rev-parse", "--is-shallow-repository"]);
	if (shallow.ok && shallow.stdout === "true") {
		return environmentError(
			`${root.stdout} is a shallow clone, so its grafted history cannot say what descends from ${BASE_LABEL}\n` +
				`       fix: git fetch --unshallow, then run the check again`,
		);
	}

	const fetch = git(["fetch", "--quiet", "--no-tags", REMOTE, `+refs/heads/${BRANCH}:${BASE_REF}`]);
	const base = git(["rev-parse", "--verify", "--quiet", `${BASE_REF}^{commit}`]);
	if (!base.ok || base.stdout === "") {
		const reason = fetch.stderr === "" ? `no such ref after fetching ${BASE_LABEL}` : firstLine(fetch.stderr);
		return environmentError(
			`cannot resolve ${BASE_LABEL} in ${root.stdout}: ${reason}\n` +
				`       fix: git remote -v, then git fetch ${REMOTE} ${BRANCH}`,
		);
	}
	const baseSha = base.stdout;
	// A failed fetch leaves whatever origin/dev was last seen, and classifying
	// against a stale base would report on history the remote no longer has. That
	// is a check that could not run, which is never a pass.
	if (!fetch.ok) {
		const reason = fetch.stderr === "" ? `git fetch exited ${fetch.status}` : firstLine(fetch.stderr);
		return environmentError(
			`cannot refresh ${BASE_LABEL}: ${reason}\n` +
				`       ${short(baseSha)} may be stale, so this check cannot tell whether the base is right\n` +
				`       fix: git remote -v, then git fetch ${REMOTE} ${BRANCH}`,
		);
	}

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
			`behind-dev — ${branch} adds no commit of its own: HEAD ${short(headSha)} is already contained in ${BASE_LABEL} ${short(baseSha)}; ` +
				`next: git checkout -b <change-name> ${BASE_LABEL} (or git rebase ${BASE_LABEL} to continue on this branch)`,
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

	// "The commits this branch carries" can have more than one root: one when the
	// branch is its own line of work, several when a merge brought a second
	// history in. A root is a commit in the range whose parents are all outside
	// it. Exactly one root, sitting on origin/dev, is the branch carrying only
	// its own commits; anything else is foreign.
	const range = `${BASE_REF}..HEAD`;
	const listed = git(["rev-list", "--parents", range])
		.stdout.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const [sha, ...parents] = line.split(" ");
			return { sha, parents };
		});
	if (listed.length === 0) {
		// origin/dev is an ancestor and HEAD is not an ancestor of origin/dev, so
		// the range cannot be empty; treat it as runnable-but-broken rather than
		// pretending the branch is fine.
		return environmentError(`cannot list the commits in ${BASE_LABEL}..HEAD`);
	}

	const carried = new Set(listed.map((entry) => entry.sha));
	const roots = listed.filter((entry) => !entry.parents.some((parent) => carried.has(parent)));
	const count = listed.length;
	const commits = `${count} commit${count === 1 ? "" : "s"}`;
	const none = (parents) =>
		parents.length === 0 ? "nothing (a root commit)" : parents.map((parent) => describe(parent)).join(" and ");

	if (roots.length > 1) {
		report(
			`foreign-commits — ${branch} carries ${roots.length} root commits in ${BASE_LABEL}..HEAD: ` +
				roots.map((entry) => `${describe(entry.sha)} (parent ${none(entry.parents)})`).join(" and ") +
				`; only one lineage may sit on ${BASE_LABEL}, so a merge brought another branch's commits in; ` +
				`next: git log --oneline --graph ${BASE_LABEL}..HEAD to see the two, then move the other lineage to its own branch and re-create this one from ${BASE_LABEL} with its own commits`,
		);
		return 1;
	}

	const start = roots[0];
	const parent = start.parents.length === 0 ? "" : start.parents[0];

	if (parent === baseSha) {
		// A detached HEAD is what CI checks out. `git push -u origin HEAD` fails
		// there, so the line names the reattach instead of advice already known to
		// break in the one mode CI runs the check in.
		const next =
			attached.ok && attached.stdout !== ""
				? `git push -u ${REMOTE} ${target} && gh pr create --base ${BRANCH} --fill`
				: `git switch -c <change-name> to reattach, or git push ${REMOTE} HEAD:refs/heads/<branch>, then gh pr create --base ${BRANCH} --fill`;
		report(
			`correct — ${branch} descends from ${BASE_LABEL} (${short(baseSha)}) and carries ${commits} of its own; ` +
				`next: ${next}`,
		);
		return 0;
	}

	report(
		`foreign-commits — the oldest commit on top of ${BASE_LABEL} is ${describe(start.sha)}, whose parent is ` +
			`${parent === "" ? "nothing (a root commit)" : describe(parent)}, not ${BASE_LABEL} ${short(baseSha)}: ` +
			`the branch merged ${BRANCH} in instead of being rebased onto it, or it carries another branch's commits; ` +
			`next: git rebase --onto ${BASE_LABEL} ${parent === "" ? "<base>" : short(parent)} ${target}, ` +
			`then confirm git log --oneline ${BASE_LABEL}..HEAD lists only this branch's commits`,
	);
	return 1;
}

process.exitCode = main(process.argv.slice(2));
