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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("explore", {
		description: "Browse a branch's files (v1: browse + print file to transcript)",
		handler: async (args: string, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("repo-explorer requires interactive mode", "error");
				return;
			}

			// TODO(repo-explorer): branch selection menu (TODO-937a1b91),
			// fuzzy file browser (TODO-da336cab), print to transcript
			// (TODO-a4e734e5), argument parsing (TODO-bfdd2343).
			ctx.ui.notify(`repo-explorer: not implemented yet${args ? ` (args: ${args})` : ""}`, "info");
		},
	});
}
