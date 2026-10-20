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

import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/** pi's theme module, inside pi's installation. */
const THEME_MODULE = path.join("dist", "modes", "interactive", "theme", "theme.js");

/** Whether the path is a file that can be imported. */
function isFile(candidate) {
	try {
		return statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/**
 * A package's entry point, from its own manifest.
 *
 * The manifest is the package's public statement of where it starts, so this
 * survives a change of layout in a way a hard-coded path does not.
 */
function packageEntry(packageDir) {
	try {
		const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
		const main = manifest.main ?? manifest.exports?.["."]?.import;
		if (typeof main !== "string") return undefined;
		const entry = path.join(packageDir, main);
		return isFile(entry) ? entry : undefined;
	} catch {
		return undefined;
	}
}

/**
 * pi-tui's entry point.
 *
 * The way Node finds a package's own dependencies is tried first; it walks
 * the `node_modules` chain the way a package manager left it. The nested
 * layout is the fallback, for the day that resolution stops working for a
 * package that publishes only an ESM entry.
 */
function piTuiEntry(packageDir) {
	try {
		const resolved = createRequire(path.join(packageDir, "package.json")).resolve("@earendil-works/pi-tui");
		if (isFile(resolved)) return resolved;
	} catch {
		// Fall through to the layout below.
	}
	return packageEntry(path.join(packageDir, "node_modules", "@earendil-works", "pi-tui"));
}

/**
 * The entry points the viewer needs, or undefined where they cannot be found.
 *
 * `tui` is pi-tui's entry point. `theme` is the module that carries pi's
 * `Theme` class, its Markdown theme and the API that installs a theme
 * instance: the module inside pi's installation, which is the one that has
 * all three, with pi's public entry point as the fallback for the day it
 * moves.
 */
export function resolvePiEntryPoints(packageDir) {
	const theme = path.join(packageDir, THEME_MODULE);
	return {
		tui: piTuiEntry(packageDir),
		theme: isFile(theme) ? theme : packageEntry(packageDir),
	};
}
