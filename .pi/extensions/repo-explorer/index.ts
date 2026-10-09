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
// repository. Four more modules sit between it and the UI: runner.ts is the one
// place a process is spawned (it deliberately bypasses pi.exec to keep stdout
// byte-faithful), branch-menu.ts owns the ordering, labelling and ambiguity of
// the branch list, file-browser.ts is the directory-by-directory browser
// component, and file-transcript.ts formats and renders the picked file's
// message. sanitize.ts is the display boundary all three UI-facing modules use
// (a repository can hand back control bytes). Runner and branch-menu are pinned
// by .pi/extensions/subagent/test/repo-explorer-menu.test.ts, the browser by
// repo-explorer-browser.test.ts, the transcript and the sanitizers by
// repo-explorer-transcript.test.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chooseBranch, type ExploreBranchState } from "./branch-menu.ts";
import { FileBrowser, type FileBrowserResult } from "./file-browser.ts";
import { FILE_MESSAGE_TYPE, fileMessageRenderer, formatFileTranscript } from "./file-transcript.ts";
import { openGit, RepoGitError } from "./git.ts";
import { makeGitRunner } from "./runner.ts";
import { sanitizeDisplay } from "./sanitize.ts";

export default function (pi: ExtensionAPI) {
	// The branch the user last picked, kept for the steps that follow: the file
	// browser's title and the `/explore <path>` quick-open default
	// (TODO-bfdd2343) both read this instead of asking again.
	const lastBranch: ExploreBranchState = {};

	// A picked file prints itself into the transcript, and this renderer is what
	// makes that safe for the terminal: the default renderer would run the file
	// through Markdown and pass control bytes through untouched (see
	// file-transcript.ts).
	pi.registerMessageRenderer(FILE_MESSAGE_TYPE, fileMessageRenderer);

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

				// The tree is listed before the browser opens, because the browser's
				// whole model is the flat path list: it synthesizes directories from
				// the prefixes itself and never calls git. A very large repo makes
				// this the slow step, with the menu already closed and no spinner —
				// acceptable for v1, and the one place to add a loader if it bites.
				const files = await git.listFiles(choice.refname);
				const picked = await ctx.ui.custom<FileBrowserResult>((tui, theme, keybindings, done) =>
					new FileBrowser(tui, theme, keybindings, { branchLabel: choice.label, files }, done),
				);
				if (!picked) return;

				// The file is printed into the transcript, not shown in an overlay:
				// it lands in tmux scrollback, survives the browse, can be selected and
				// copied with phone gestures, and the agent reads it in the next turn's
				// context (a custom message becomes `role: "user"`). `display: true`
				// shows it; no `triggerTurn`, so viewing a file does not prompt the
				// agent.
				const file = await git.readFile(choice.refname, picked.path);
				const { content, details } = formatFileTranscript(file, choice.label, picked.path);
				// triggerTurn: false is load-bearing, not tidiness. Without it,
				// `sendCustomMessage`'s `isStreaming && options?.triggerTurn !== false`
				// branch sees `undefined !== false` and STEERS the page into the
				// running turn — the agent would be prompted by an act of browsing.
				// Explicit false routes a streaming send through the deferred queue
				// (flushed in order at turn end) and an idle one to a plain append.
				pi.sendMessage({ customType: FILE_MESSAGE_TYPE, content, display: true, details }, { triggerTurn: false });
			} catch (err) {
				// Branch on kind, never on message text: git.ts's kinds
				// (not-a-repo, unknown-branch, not-found, not-a-file, binary,
				// mojibake, too-large, git-failed) are the contract. The message is
				// sanitized for display: it embeds the path (and sometimes git's own
				// stderr), either of which may carry control bytes.
				if (err instanceof RepoGitError) {
					ctx.ui.notify(`repo-explorer: ${sanitizeDisplay(err.message)}`, "error");
					return;
				}
				throw err;
			}
		},
	});
}
