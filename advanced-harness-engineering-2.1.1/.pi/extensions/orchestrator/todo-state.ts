/**
 * Read the todo store from disk for the settlement gate.
 *
 * `todos.ts` is vendored and keeps its front-matter parser private. Two options
 * were considered:
 *
 *   1. Read the directory here, duplicating the documented leading-JSON format.
 *   2. Have the todo extension publish its list and let the gate consume it.
 *
 * (2) is worse at the exact moment the gate runs: the event bus is in-process
 * and carries mutations only, so a fresh session that opens a todo and settles
 * without another mutation would report no open todos — a false negative in the
 * condition the gate exists to notice. Reading the files works on the first
 * settle of a fresh session and has no load-order dependency.
 *
 * What this duplicates, and what drifts: the file layout (one `<id>.md` per
 * todo), the leading JSON front-matter object, and the closed-status vocabulary
 * (`closed`/`done`). If upstream changes any of those, this reader can miss an
 * open todo. That degrades to a clear verdict, never a trap, because this
 * ticket's gate is report-only. When `todos.ts` grows a public reader, delete
 * this module and call that one.
 *
 * `PI_TODO_PATH` is honoured exactly as the todo extension honours it, so this
 * reader sees the same directory the tool wrote.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const TODO_DIR_NAME = ".pi/todos";
const TODO_PATH_ENV = "PI_TODO_PATH";
const CLOSED_STATUSES = new Set(["closed", "done"]);

export interface OpenTodo {
	id: string;
	title: string;
	status: string;
}

export interface TodoRead {
	todos: OpenTodo[];
	/** Set when the directory exists but cannot be read. A missing directory is
	 *  not an error: a project with no todos has no `.pi/todos` yet. */
	error?: string;
}

export function todoDirectory(cwd: string): string {
	const override = process.env[TODO_PATH_ENV];
	if (override && override.trim()) return resolve(cwd, override.trim());
	return resolve(cwd, TODO_DIR_NAME);
}

/**
 * Extract the leading JSON object from a todo file. The front matter is
 * produced by `JSON.stringify(..., null, 2)` in `todos.ts`, so a brace inside a
 * quoted title must not end it early — hence the same small scanner, not
 * `indexOf("}")`.
 */
function leadingJsonObject(text: string): string | null {
	// No leading-whitespace tolerance, deliberately: `todos.ts`'s own
	// `splitFrontMatter` tests the raw content, so a hand-edited file with leading
	// whitespace has NO front matter there and defaults to an open, untitled todo.
	// Trimming here would read the same file as closed and skip it — a missed
	// report for a todo the todo list shows as open.
	if (!text.startsWith("{")) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth += 1;
			continue;
		}
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(0, i + 1);
		}
	}
	return null;
}

/**
 * Mirror `todos.ts`'s fallback: a file with no parsable front matter is an
 * open, untitled todo rather than an invisible one. The todo list shows it, so
 * the gate must not be the only reader that pretends it is absent.
 */
function parseTodo(text: string, id: string): OpenTodo {
	const frontMatter = leadingJsonObject(text);
	if (!frontMatter) return { id, title: "", status: "open" };
	try {
		const parsed = JSON.parse(frontMatter) as { title?: unknown; status?: unknown } | null;
		if (!parsed || typeof parsed !== "object") return { id, title: "", status: "open" };
		return {
			id,
			title: typeof parsed.title === "string" ? parsed.title : "",
			status: typeof parsed.status === "string" && parsed.status ? parsed.status : "open",
		};
	} catch {
		return { id, title: "", status: "open" };
	}
}

/** Read every open todo, newest ordering irrelevant: the caller only needs a
 *  stable list for a report. */
export async function readOpenTodos(cwd: string): Promise<TodoRead> {
	const directory = todoDirectory(cwd);
	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			// ENOTDIR means PI_TODO_PATH points at something that is not a
			// directory. Treat it as an unevaluable condition, not an empty store.
			if (code === "ENOTDIR") {
				return { todos: [], error: `${directory} is not a directory` };
			}
			return { todos: [] };
		}
		return { todos: [], error: `could not read ${directory}: ${error instanceof Error ? error.message : String(error)}` };
	}

	const todos: OpenTodo[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		try {
			const text = await readFile(join(directory, entry), "utf8");
			const todo = parseTodo(text, id);
			if (!CLOSED_STATUSES.has(todo.status.toLowerCase())) todos.push(todo);
		} catch {
			// Unreadable todo: the todo extension also ignores it. The gate must
			// not fail open on a file that vanished between readdir and read.
		}
	}

	todos.sort((a, b) => a.id.localeCompare(b.id));
	return { todos };
}
