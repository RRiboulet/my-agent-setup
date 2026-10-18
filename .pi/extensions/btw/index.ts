import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The /btw side-panel extension.
 *
 * `launch.ts` holds the pure core — paths, child argv, tmux argv and the
 * side-prompt appendix — and is pinned by `btw-launch.test.ts`. The `/btw`
 * command, the session fork and the tmux side effects are wired next; this
 * factory deliberately registers nothing yet, so loading the extension is
 * inert.
 */
export default function btwExtension(_pi: ExtensionAPI): void {}
