// repo-explorer — browse a branch's file tree and print a file into the
// transcript, for working from a phone over tmux where the working tree is on
// a machine you cannot open an editor on.
//
// Design decisions (2026-10-08, discussed before building):
//  - Scope is the current repo only; anything beyond was rejected as unlikely
//    to be needed.
//  - File content prints into the conversation transcript (pi.sendMessage)
//    rather than an ephemeral overlay: it lands in tmux scrollback, survives
//    the browse session, can be selected and copied with phone gestures, and
//    the agent sees it too. Menus stay ephemeral; content persists.
//  - v1 is browse + view. `git blame` and inter-branch diff navigation are
//    explicitly deferred to v2.
//
// Flow: /explore [path] — pick a branch, browse its files with type-to-filter,
// Enter opens a file. Path and branch arguments skip menu steps they fill in.
//
// The git layer lives in git.ts — listBranches / listFiles (tip-keyed cache) /
// readFile (binary, size and 2000-line caps), all read-only, and pinned by
// .pi/extensions/subagent/test/repo-explorer-git.test.ts against a real
// repository. Two more modules sit between it and the UI: runner.ts is the one
// place a process is spawned (it deliberately bypasses pi.exec to keep stdout
// byte-faithful), and branch-menu.ts owns the ordering, labelling and
// ambiguity of the branch list. Both are pinned by
// .pi/extensions/subagent/test/repo-explorer-menu.test.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chooseBranch, type ExploreBranchState } from "./branch-menu.ts";
import { openGit, RepoGitError } from "./git.ts";
import { makeGitRunner } from "./runner.ts";

export default function (pi: ExtensionAPI) {
	// The branch the user last picked, kept for the steps that follow: the file
	// browser's title and the `/explore <path>` quick-open default
	// (TODO-da336cab, TODO-bfdd2343) both read this instead of asking again.
	const lastBranch: ExploreBranchState = {};

	pi.registerCommand("explore", {
		description: "Browse a branch's files (v1: browse + print file to transcript)",
		handler: async (args, ctx) => {
			// Guarded on mode, not hasUI: RPC reports hasUI too, but the whole v1 flow
			// includes a file browser driven by ctx.ui.custom(), which RPC silently
			// drops (see the comment at the top of .pi/extensions/subagent/index.ts,
			// and pi's rpc-extension-ui.md).
			if (ctx.mode !== "tui") {
				ctx.ui.notify("repo-explorer requires interactive TUI mode", "error");
				return;
			}

			// TODO(repo-explorer): argument quick-open (TODO-bfdd2343). Until it
			// lands, a typed path is reported and then set aside rather than
			// silently ignored — the menu is still the useful thing to do.
			if (args.trim().length > 0) {
				ctx.ui.notify(`repo-explorer: arguments are not supported yet ("${args.trim()}") — picking a branch instead`, "warning");
			}

			try {
				// One plumbing instance per invocation: it resolves the repository
				// root from ctx.cwd, so a /explore after the session moved must not
				// reuse one bound to the old root.
				const git = await openGit(makeGitRunner({ signal: ctx.signal }), ctx.cwd);
				const choice = await chooseBranch(git, ctx.ui, lastBranch);
				if (!choice) return;
				// TODO(repo-explorer): the fuzzy file browser (TODO-da336cab) takes
				// over here, then printing the picked file (TODO-a4e734e5).
				ctx.ui.notify(`repo-explorer: browsing ${choice.label} — the file browser is the next step`, "info");
			} catch (err) {
				// Branch on kind, never on message text: git.ts's kinds
				// (not-a-repo, unknown-branch, not-found, not-a-file, binary,
				// mojibake, too-large, git-failed) are the contract.
				if (err instanceof RepoGitError) {
					ctx.ui.notify(`repo-explorer: ${err.message}`, "error");
					return;
				}
				throw err;
			}
		},
	});
}
