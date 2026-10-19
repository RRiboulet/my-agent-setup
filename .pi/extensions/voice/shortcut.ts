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
 * Grammar is not enough: pi's matcher refuses modifiers on `escape` and on
 * `f1`–`f12` outright (`if (modifier !== 0) return false`), so `ctrl+f5` is a
 * grammatical id that can never fire. Those are rejected here too, because a
 * registered key that silently never matches is the exact failure this module
 * exists to prevent.
 *
 * The base keys come from pi's exported `Key` rather than a hand copy: a copied
 * list drifts from the grammar the rest of this module mirrors, and nothing
 * would notice until a valid key was refused. `Key`'s values include the
 * modifier *functions*, so they are filtered, and they are lowercased to match
 * the lowercased remainder `normalizeKeyId` checks (pi lowercases too).
 */

import { Key } from "@earendil-works/pi-tui";

import type { Warn } from "./util.ts";

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
	..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
]);

/**
 * Base keys `matchesKey` matches only without a modifier. It returns false for
 * a modified escape or function key before looking at any protocol form, so
 * these must not be registered with one — they could never fire.
 */
const UNMODIFIED_ONLY = new Set<string>(["escape", "esc", ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)]);

/** Strip modifiers the way pi does. Returns the remainder and what it found. */
function stripModifiers(id: string): { key: string; seen: Set<string> } {
	const seen = new Set<string>();
	let key = id;
	for (;;) {
		const modifier = MODIFIER_NAMES.find((name) => key.startsWith(`${name}+`));
		if (modifier === undefined) break;
		if (seen.has(modifier)) return { key, seen: new Set([...seen, "duplicate"]) };
		seen.add(modifier);
		key = key.slice(modifier.length + 1);
	}
	return { key, seen };
}

/**
 * Normalise one key id, or `undefined` when it is not a usable id. Mirrors pi's
 * `parseKeyId`, including its `+`-base exemption (`ctrl++` is ctrl plus `+`),
 * and additionally refuses a modifier on a key pi can only match bare.
 */
export function normalizeKeyId(raw: string): string | undefined {
	const id = raw.trim().toLowerCase();
	const { key, seen } = stripModifiers(id);
	if (seen.has("duplicate")) return undefined;
	if (key === "" || (key.includes("+") && key !== "+")) return undefined;
	if (!BASE_KEYS.has(key)) return undefined;
	if (seen.size > 0 && UNMODIFIED_ONLY.has(key)) return undefined;
	return id;
}

/**
 * The identity two ids share when they name the same physical key. pi's own
 * `parseKey` prints modifiers in a fixed order, so `ctrl+shift+r` and
 * `shift+ctrl+r` are one key; dedupe has to see that even though the configured
 * spelling is kept for display.
 */
function keyIdentity(id: string): string {
	const { key } = stripModifiers(id);
	const order = ["shift", "ctrl", "alt", "super"];
	const modifiers = order.filter((name) => id.startsWith(`${name}+`) || id.includes(`+${name}+`) || id.endsWith(`+${name}`));
	return `${modifiers.join("+")}+${key}`;
}

/**
 * Read a shortcut setting — a single id, a comma-separated list, or an array of
 * ids — into a de-duplicated list of valid ids.
 *
 * Returns `[]` for an explicitly empty setting (which disables the shortcut) and
 * `undefined` when the value is unusable, so the caller keeps the previous
 * setting: any invalid entry, a wrong type, or a list that yields nothing. One
 * bad entry rejects the whole value rather than applying the good rest, which is
 * how every other voice field behaves and what makes "a typo cannot remove the
 * shortcut" true.
 *
 * `,` is the list separator, but it is also a base key (`ctrl+,`). The whole
 * string is tried as a single id first, so `"ctrl+,"` is that one key rather
 * than a broken list; the consequence is that a comma-based key cannot share the
 * string form with another — use the array form for a list containing one.
 */
export function parseShortcutIds(raw: unknown, label: string, warn: Warn): string[] | undefined {
	if (typeof raw !== "string" && !Array.isArray(raw)) {
		warn(`voice: ignoring ${label}: expected a pi key like "ctrl+shift+r"`);
		return undefined;
	}
	if (typeof raw === "string" && raw.trim() === "") return [];
	if (Array.isArray(raw) && raw.length === 0) return [];

	const single = typeof raw === "string" ? normalizeKeyId(raw) : undefined;
	if (single !== undefined) return [single];

	const entries: unknown[] = typeof raw === "string" ? raw.split(",") : raw;
	const ids: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") {
			warn(`voice: ignoring ${label}: expected pi key ids, not ${JSON.stringify(entry)}`);
			return undefined;
		}
		// A trailing comma is tolerated; an empty entry is not a key of its own.
		if (entries.length > 1 && entry.trim() === "") continue;
		const id = normalizeKeyId(entry);
		if (id === undefined) {
			warn(`voice: ignoring ${label} entry ${JSON.stringify(entry)}: ${describeRefusal(entry, raw)}`);
			return undefined;
		}
		const identity = keyIdentity(id);
		if (!ids.some((existing) => keyIdentity(existing) === identity)) ids.push(id);
	}
	if (ids.length === 0) {
		warn(`voice: ignoring ${label}: no key id in it`);
		return undefined;
	}
	return ids;
}

/** Why an entry was refused, in the words a user can act on. `raw` is the whole
 * setting, because the entry quoted above may be a split artefact — `ctrl+,`
 * inside a list arrives here as `"ctrl+"`, which the user never wrote. */
function describeRefusal(entry: string, raw: unknown): string {
	const { key, seen } = stripModifiers(entry.trim().toLowerCase());
	if (seen.size > 0 && UNMODIFIED_ONLY.has(key)) return `${key} takes no modifier`;
	if (typeof raw === "string" && raw.includes(",") && entry.trim().endsWith("+")) {
		return 'a key whose own id contains "," must be listed in an array';
	}
	return 'expected a pi key like "ctrl+shift+r"';
}
