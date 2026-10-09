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
// Flow: /explore — pick a branch, browse its files with type-to-filter, Enter
// opens a file. `/explore <path>` is the quick-open: it resolves the branch
// (explicit, last-picked, or HEAD), prints a file path directly, and opens the
// browser at a directory path — no menu. See quick-open.ts for the grammar.
//
// The git layer lives in git.ts — listBranches / listFiles (tip-keyed cache) /
// readFile (binary, size and 2000-line caps), all read-only, and pinned by
// .pi/extensions/subagent/test/repo-explorer-git.test.ts against a real
// repository. Five more modules sit between it and the UI: runner.ts is the one
// place a process is spawned (it deliberately bypasses pi.exec to keep stdout
// byte-faithful), branch-menu.ts owns the ordering, labelling and ambiguity of
// the branch list, quick-open.ts parses `/explore` arguments and resolves their
// branch to a refname, file-browser.ts is the directory-by-directory browser
// component, and file-transcript.ts formats and renders the picked file's
// message. sanitize.ts is the display boundary all three UI-facing modules use
// (a repository can hand back control bytes). Runner and branch-menu are pinned
// by .pi/extensions/subagent/test/repo-explorer-menu.test.ts, the browser by
// repo-explorer-browser.test.ts, the transcript and the sanitizers by
// repo-explorer-transcript.test.ts, and the argument grammar and branch
// resolution by repo-explorer-quick-open.test.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chooseBranch, type BranchChoice, type ExploreBranchState } from "./branch-menu.ts";
import { FileBrowser, type FileBrowserResult } from "./file-browser.ts";
import { FILE_MESSAGE_TYPE, fileMessageRenderer, formatFileTranscript } from "./file-transcript.ts";
import { openGit, RepoGitError } from "./git.ts";
import { parseExploreArgs, resolveQuickBranch } from "./quick-open.ts";
import { makeGitRunner } from "./runner.ts";
import { sanitizeDisplay } from "./sanitize.ts";

export default function (pi: ExtensionAPI) {
	// The branch the user last picked, kept for the steps that follow: the file
	// browser's title and the `/explore <path>` quick-open default both read this
	// instead of asking again.
	const lastBranch: ExploreBranchState = {};

	// A picked file prints itself into the transcript, and this renderer is what
	// makes that safe for the terminal: the default renderer would run the file
	// through Markdown and pass control bytes through untouched (see
	// file-transcript.ts).
	pi.registerMessageRenderer(FILE_MESSAGE_TYPE, fileMessageRenderer);

	pi.registerCommand("explore", {
		description: "Browse a branch's files, or print a file by path (browse + transcript)",
		handler: async (args, ctx) => {
			// Guarded on mode, not hasUI: RPC reports hasUI too, but the whole v1 flow
			// includes a file browser driven by ctx.ui.custom(), which RPC silently
			// drops (see the comment at the top of .pi/extensions/subagent/index.ts,
			// and pi's rpc-extension-ui.md).
			if (ctx.mode !== "tui") {
				ctx.ui.notify("repo-explorer requires interactive TUI mode", "error");
				return;
			}

			const parsed = parseExploreArgs(args);
			if (parsed.error) {
				// The message embeds the path the user typed (the absolute-path
				// refusal), so it crosses the same display boundary as git's errors.
				ctx.ui.notify(`repo-explorer: ${sanitizeDisplay(parsed.error)}`, "error");
				return;
			}

			try {
				// One plumbing instance per invocation: it resolves the repository
				// root from ctx.cwd, so a /explore after the session moved must not
				// reuse one bound to the old root.
				const git = await openGit(makeGitRunner({ signal: ctx.signal }), ctx.cwd);

				// The file is printed into the transcript, not shown in an overlay:
				// it lands in tmux scrollback, survives the browse, can be selected and
				// copied with phone gestures, and the agent reads it in the next turn's
				// context (a custom message becomes `role: "user"`). `display: true`
				// shows it; no `triggerTurn`, so viewing a file does not prompt the
				// agent. Both the quick-open path and the browser pick funnel through
				// here so they cannot drift apart.
				const printFile = async (choice: BranchChoice, path: string): Promise<void> => {
					const file = await git.readFile(choice.refname, path);
					const { content, details } = formatFileTranscript(file, choice.label, path);
					// triggerTurn: false is load-bearing, not tidiness. Without it,
					// `sendCustomMessage`'s `isStreaming && options?.triggerTurn !== false`
					// branch sees `undefined !== false` and STEERS the page into the
					// running turn — the agent would be prompted by an act of browsing.
					// Explicit false routes a streaming send through the deferred queue
					// (flushed in order at turn end) and an idle one to a plain append.
					pi.sendMessage({ customType: FILE_MESSAGE_TYPE, content, display: true, details }, { triggerTurn: false });
				};

				// Open the browser and print whatever it resolves to. The tree is listed
				// before the browser opens, because the browser's whole model is the flat
				// path list: it synthesizes directories from the prefixes itself and never
				// calls git. A very large repo makes this the slow step, with the menu
				// already closed and no spinner — acceptable for v1, and the one place to
				// add a loader if it bites.
				const browse = async (choice: BranchChoice, initialDir: string): Promise<void> => {
					const files = await git.listFiles(choice.refname);
					const picked = await ctx.ui.custom<FileBrowserResult>((tui, theme, keybindings, done) =>
						new FileBrowser(tui, theme, keybindings, { branchLabel: choice.label, files, initialDir }, done),
					);
					if (!picked) return;
					await printFile(choice, picked.path);
				};

				if (parsed.path !== undefined) {
					const quickPath = parsed.path;
					// Quick-open: no menu. Resolve the branch — explicit argument, last
					// pick, else HEAD — then print a file path or open the browser at a
					// directory path. `listBranches` is only needed to resolve the branch,
					// and a tag or sha falls through it to tipOf's `unknown-branch`.
					const resolved = resolveQuickBranch(await git.listBranches(), lastBranch, parsed.branch);
					if (!resolved.choice) {
						ctx.ui.notify(`repo-explorer: ${sanitizeDisplay(resolved.error ?? "could not resolve a branch")}`, "error");
						return;
					}
					const choice = resolved.choice;
					// An explicit branch becomes the last pick too, so the next
					// `/explore <path>` reuses it. chooseBranch remembers its own pick.
					lastBranch.refname = choice.refname;
					lastBranch.label = choice.label;

					// "" is the repository root — a directory by construction, so skip
					// readFile and go straight to the browser.
					if (quickPath === "") {
						await browse(choice, "");
						return;
					}

					try {
						await printFile(choice, quickPath);
					} catch (err) {
						// A tree path is not an error: it is where the browser should open.
						// Only a path with children is a directory this browser can enter —
						// a gitlink/submodule lists as a leaf, so it stays `not-a-file`.
						if (err instanceof RepoGitError && err.kind === "not-a-file") {
							const files = await git.listFiles(choice.refname);
							if (!files.some((file) => file.startsWith(`${quickPath}/`))) throw err;
							await browse(choice, quickPath);
							return;
						}
						throw err;
					}
					return;
				}

				const choice = await chooseBranch(git, ctx.ui, lastBranch);
				if (!choice) return;
				await browse(choice, "");
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
