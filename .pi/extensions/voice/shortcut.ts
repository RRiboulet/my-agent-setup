/**
 * Parsing of pi key identifiers for the voice shortcut.
 *
 * The shortcut is user-configurable (`voice.json` or `PI_VOICE_SHORTCUT`), so
 * its values are untyped strings that must be checked against pi's key grammar
 * before they reach `registerShortcut`. The grammar is the one `matchesKey`
 * parses: any number of distinct `ctrl`/`shift`/`alt`/`super` modifiers in any
 * order, then a base key — a letter, a digit, one of the special names, or one
 * of the symbol keys. `+` alone is a base key, so it is the one string that
 * contains the separator.
 *
 * An unrecognised value is dropped with a warning rather than guessed: the
 * default shortcut must survive a typo, and a silent no-op key would look
 * exactly like a broken feature.
 */

/** Modifiers `matchesKey` accepts, each at most once per key id. */
const MODIFIER_NAMES = new Set(["ctrl", "shift", "alt", "super"]);

/** The non-alphanumeric base keys, lowercase — pi lowercases the whole id. */
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"f11",
	"f12",
]);

/** The symbol base keys, matching pi-tui's `SYMBOL_KEYS`. */
const SYMBOL_KEYS = new Set([
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
]);

const BASE_KEY = /^[a-z0-9]$/;

/** Normalise one key id, or `undefined` when it is not a valid id. */
export function normalizeKeyId(raw: string): string | undefined {
	const id = raw.trim().toLowerCase();
	// The separator is itself a base key, so handle it before splitting.
	if (id === "+") return "+";
	const parts = id.split("+");
	const seen = new Set<string>();
	for (const part of parts.slice(0, -1)) {
		if (!MODIFIER_NAMES.has(part) || seen.has(part)) return undefined;
		seen.add(part);
	}
	const base = parts.at(-1);
	if (base === undefined || (!BASE_KEY.test(base) && !SPECIAL_KEYS.has(base) && !SYMBOL_KEYS.has(base))) {
		return undefined;
	}
	return id;
}

/** A warning sink; the same shape config.ts and the recorder use. */
export type Warn = (message: string) => void;

/**
 * Read a shortcut setting — a single id, a comma-separated list, or an array of
 * ids — into a de-duplicated list of valid ids. Invalid entries warn and are
 * dropped. An empty result means "nothing usable", which the caller treats as
 * "leave the default alone" so a typo cannot remove the shortcut.
 */
export function parseShortcutIds(raw: unknown, label: string, warn: Warn): string[] {
	const entries = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
	const ids: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") {
			warn(`voice: ignoring ${label}: expected a pi key like "ctrl+shift+r"`);
			continue;
		}
		const id = normalizeKeyId(entry);
		if (id === undefined) {
			warn(`voice: ignoring ${label} entry ${JSON.stringify(entry)}: expected a pi key like "ctrl+shift+r"`);
			continue;
		}
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}
