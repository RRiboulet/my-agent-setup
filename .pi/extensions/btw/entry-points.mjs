// Where the packages the panel needs live.
//
// The viewer is a separate process, and a bare specifier does not resolve
// there. Pi maps `@earendil-works/pi-tui` onto its own installation for the
// extensions it loads, but a spawned `node` gets no such mapping - and the
// installed package has no `node_modules` of its own, because pi installs the
// host-provided packages for the extension, not for a process the extension
// spawns. So a viewer that imported them by name would die on every panel in
// an installed package, which is how the package is meant to be used.
//
// The parent resolves the entry points instead, where the mapping exists, and
// hands the viewer paths it can import. Where a path cannot be found, the
// viewer falls back to the bare specifier, which is what works in a checkout
// whose own `node_modules` has them.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/** pi's theme module, inside pi's installation. */
const THEME_MODULE = path.join("dist", "modes", "interactive", "theme", "theme.js");

/**
 * The entry points the viewer needs, or undefined where they cannot be found.
 *
 * `tui` is pi-tui's entry point, found the way Node finds a package's own
 * dependencies. `theme` is the module that carries pi's `Theme` class and its
 * Markdown theme; it is pi's internal layout, so it is a path with a
 * fallback rather than a promise.
 */
export function resolvePiEntryPoints(packageDir) {
	let tui;
	try {
		tui = createRequire(path.join(packageDir, "package.json")).resolve("@earendil-works/pi-tui");
	} catch {
		tui = undefined;
	}
	const theme = path.join(packageDir, THEME_MODULE);
	return { tui, theme: existsSync(theme) ? theme : undefined };
}
