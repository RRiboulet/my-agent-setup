/**
 * Parsing of pi key identifiers for the voice shortcut.
 *
 * The shortcut is user-configurable (`voice.json` or `PI_VOICE_SHORTCUT`), so
 * its values are untyped strings that must be checked against pi's key grammar
 * before they reach `registerShortcut`. The grammar is the one `matchesKey`
 * parses: strip leading `ctrl`/`shift`/`alt`/`super` modifiers, each at most
 * once, and the remainder is the base key — a letter, a digit, one of the special
 * names, or one of the symbol keys. `+` alone is a base key, so it is the one
 * remainder that still contains the separator.
 *
 * The base keys come from pi's exported `Key` rather than a hand copy: a copied
 * list drifts from the grammar the rest of this module mirrors, and nothing
 * would notice until a valid key was refused. `Key`'s values include the
 * modifier *functions*, so they are filtered, and they are lowercased to match
 * the lowercased remainder `normalizeKeyId` checks (pi lowercases too).
 *
 * An unrecognised value is dropped with a warning rather than guessed: the
 * default shortcut must survive a typo, and a silent no-op key would look
 * exactly like a broken feature.
 */

import { Key } from "@earendil-works/pi-tui";

/** Modifiers `matchesKey` accepts, each at most once per key id. */
const MODIFIER_NAMES = ["ctrl", "shift", "alt", "super"] as const;

/**
 * Every base key pi accepts. The special and symbol keys come straight from
 * the export that defines them; `Key` does not carry the alphanumerics (those
 * are built by `Key.ctrl("r")` and friends), so that range is spelled out —
 * and a range cannot drift.
 */
const BASE_KEYS = new Set<string>([
	...Object.values(Key)
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.toLowerCase()),
	..."abcdefghijklmnopqrstuvwxyz0123456789",
]);

/**
 * Normalise one key id, or `undefined` when it is not a valid id. Mirrors pi's
 * `parseKeyId`, including its `+`-base exemption: `ctrl++` is ctrl plus `+`.
 */
export function normalizeKeyId(raw: string): string | undefined {
	const id = raw.trim().toLowerCase();
	const seen = new Set<string>();
	let key = id;
	for (;;) {
		const modifier = MODIFIER_NAMES.find((name) => key.startsWith(`${name}+`));
		if (modifier === undefined) break;
		if (seen.has(modifier)) return undefined;
		seen.add(modifier);
		key = key.slice(modifier.length + 1);
	}
	if (key === "" || (key.includes("+") && key !== "+")) return undefined;
	if (!BASE_KEYS.has(key)) return undefined;
	return id;
}

/** A warning sink; the same shape config.ts and the recorder use. */
export type Warn = (message: string) => void;

/**
 * Read a shortcut setting — a single id, a comma-separated list, or an array of
 * ids — into a de-duplicated list of valid ids. Invalid entries warn and are
 * dropped. An empty result means "nothing usable", which the caller treats as
 * "leave the default alone" so a typo cannot remove the shortcut.
 *
 * `,` is the list separator, but it is also a base key (`ctrl+,`). The whole
 * string is tried as a single id first, so `"ctrl+,"` is that one key rather
 * than a broken list; the consequence is that a comma-based key cannot share the
 * string form with another — use the array form for a list containing one.
 */
export function parseShortcutIds(raw: unknown, label: string, warn: Warn): string[] {
	if (typeof raw !== "string" && !Array.isArray(raw)) {
		warn(`voice: ignoring ${label}: expected a pi key like "ctrl+shift+r"`);
		return [];
	}
	const single = typeof raw === "string" ? normalizeKeyId(raw) : undefined;
	const entries = typeof raw !== "string" ? raw : single !== undefined ? [single] : raw.split(",");
	const ids: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") {
			warn(`voice: ignoring ${label}: expected a pi key like "ctrl+shift+r"`);
			continue;
		}
		// An empty entry is the caller's "nothing here" (an empty setting, or a
		// trailing comma), not a typo worth a warning.
		if (entry.trim() === "") continue;
		const id = normalizeKeyId(entry);
		if (id === undefined) {
			warn(`voice: ignoring ${label} entry ${JSON.stringify(entry)}: expected a pi key like "ctrl+shift+r"`);
			continue;
		}
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}
