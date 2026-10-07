// ---------------------------------------------------------------------------
// VENDORED, NOT OURS.
//
//   continue.ts — Copyright (c) mitsuhiko and contributors
//   https://github.com/mitsuhiko/agent-stuff (extensions/continue.ts)
//   Licensed under the Apache License, Version 2.0.
//
// Byte-identical to upstream: no local changes. Kept that way on purpose so a
// later refresh is a readable diff. The only addition is this header.
//
// Upstream base: commit 0865c84 ("fix(session-breakdown): only count models
// that produced messages").
//
// Registers `shift+alt+enter` to send the literal prompt "continue", but only
// when `ctx.isIdle()`, so it never steers or queues a message mid-run. The
// shortcut does not collide with a pi default (`app.message.followUp` is
// `alt+enter`, `ctrl+q` on Windows/WSL) or with another extension here
// (`answer.ts` uses `ctrl+.`).
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Send a literal continuation prompt, but never steer or queue one mid-run. */
export default function (pi: ExtensionAPI) {
	pi.registerShortcut("shift+alt+enter", {
		description: 'Send "continue" when the agent is stopped',
		handler: (ctx) => {
			// isIdle() also remains false while Pi is retrying, compacting, or has
			// queued messages, so this cannot accidentally create a follow-up.
			if (!ctx.isIdle()) return;
			pi.sendUserMessage("continue");
		},
	});
}
