// tickets.mjs — the ticket graph the orchestrate skill dispatches over.
//
// A `to-tickets` folder is a graph written in prose plus a three-key frontmatter
// block (`.pi/skills/to-tickets/SKILL.md` §4): `status`, `blocked-by`, and an
// optional `tier-override`. This module turns that folder into nodes and edges
// and answers the questions a dispatcher must ask BEFORE it starts anything —
// which tickets are on the frontier, and whether the graph is dispatchable at
// all (cycles, dangling blockers). Those two checks live in code rather than in
// skill prose for the reason `.pi/skills/orchestrate/ladder.mjs` exists: a rule
// written only in a prompt cannot fail, so it cannot be trusted.
//
// **Reported, never thrown.** The reader's failure rule is the one this repo's
// gate config reader and ladder reader already state, with one split: a
// malformed file must never trap a session, so every read returns a graph plus
// an `issues` list and nothing here throws. What is left to the caller is the
// gate — `blockingIssues(graph)` — because a cycle or a dangling blocker is not
// a malformed input to work around, it is a reason not to dispatch. Severity is
// per issue: a numbered file with no frontmatter is a broken ticket (`error`),
// while a stray `README.md` in the folder is reported (`warning`) without
// stopping a run that has nothing to do with it.
//
// **Why a hand-written YAML subset and not a parser.** The contract is three
// keys; a full YAML parser would also accept shapes the contract forbids, which
// hides the drift between what `to-tickets` writes and what the orchestrator
// reads — the exact failure a second copy of a table causes. It would also mean
// this repo's first npm dependency, and there is no build step to carry it.
//
// **Why a ticket's id is its filename's number.** Frontmatter carries no id
// field, so the id has to come from somewhere that cannot disagree with itself;
// the filename is also what a human cites (`03`). `blocked-by` ids are quoted in
// the template (`["01"]`) precisely so a zero-padded id stays the string `01`
// instead of the number `1`, which would never match a filename.
//
// **Why the frontier is recomputed from the files on every call.** Ticket status
// is the mid-run status surface: `setTicketStatus` writes it, a plain `grep`
// reads it, and the next wave re-reads the folder. A cached node status would
// dispatch a finished ticket a second time.
//
// **Why write-back edits two lines instead of re-serializing.** A ticket's body
// is prose a human maintains. Re-emitting the file from a parsed model would
// reformat it, drop unknown frontmatter keys and rewrap the body; editing the
// two `status` fields in place leaves every other byte identical, which is what
// makes a status update safe to run on a file full of in-flight work.
//
// **Why `tier-override` is range-checked here and not at parse time.** The
// ladder owns how many tiers exist (`ladder.json`, read by `ladder.mjs`), so
// this module takes `maxTier` from the caller. An override naming a tier the
// ladder does not define would dispatch nothing at all, so it is reported and
// the classification stands in.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/**
 * The statuses the ticket contract names, in the order a ticket normally moves
 * through them. `in-progress` and `blocked` are both "not on the frontier":
 * `blocked` because a human or an exhausted escalation put it aside, which is a
 * decision the orchestrator must not undo by re-dispatching.
 */
export const TICKET_STATUSES = Object.freeze(["ready", "in-progress", "done", "blocked"]);

/**
 * What a ticket with no `status` field means. The `to-tickets` template says so
 * in prose and the reader has to agree: "a missing status reads as ready" is the
 * machine reading of "None (can start immediately)".
 */
export const DEFAULT_STATUS = "ready";

/**
 * The tier a ticket dispatches at when neither a `tier-override` nor a triage
 * classification is available. Tier 1 is the quality floor: escalation moves up
 * one tier from there, so the safe wrong answer is cheap rather than expensive.
 */
export const DEFAULT_TIER = 1;

/**
 * The tier count assumed when a caller does not say. It mirrors the shipped
 * `ladder.json`, but the ladder is the source of truth — a caller that has read
 * the ladder passes `ladder.tiers.length` and this constant stops mattering.
 */
export const DEFAULT_MAX_TIER = 3;

const FRONTMATTER_DELIMITER = "---";
const TICKET_FILE = /\.md$/i;
const NUMBERED_FILE = /^\d+/;

/**
 * The codes that mean "this file's machine contract could not be read". Their
 * severity depends on the filename: a numbered file claims to be a ticket, so a
 * broken contract is an error that stops dispatch; any other markdown file in
 * the folder is reported as a warning and does not.
 */
const CONTRACT_CODES = new Set(["missing-frontmatter", "unterminated-frontmatter", "malformed-frontmatter"]);

const READY_STATUS = DEFAULT_STATUS;

function stripCr(line) {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function carriageReturn(line) {
	return line.endsWith("\r") ? "\r" : "";
}

function describe(value) {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** One reportable problem. `code` is the checkable part; `message` is for humans. */
function makeIssue(code, severity, message, extra = {}) {
	return { code, severity, message, ...extra };
}

// --- Frontmatter -----------------------------------------------------------

/**
 * Locate the frontmatter block. It has to open the file: a `---` further down is
 * a markdown horizontal rule, and treating it as a delimiter would read prose as
 * fields. A byte-order mark is tolerated because an editor may add one.
 *
 * Returns line indexes of the opening and closing delimiters, or which of the two
 * ways the block can be unusable was found.
 */
function findFrontmatter(lines) {
	const opening = stripCr(lines[0] ?? "").replace(/^\uFEFF/, "").trim();
	if (opening !== FRONTMATTER_DELIMITER) return { missing: true };
	for (let index = 1; index < lines.length; index += 1) {
		if (stripCr(lines[index]).trim() === FRONTMATTER_DELIMITER) return { start: 0, end: index };
	}
	return { unterminated: true };
}

function unquote(value) {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if (first === '"' && last === '"') {
		return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	if (first === "'" && last === "'") return trimmed.slice(1, -1).replace(/''/g, "'");
	return trimmed;
}

/**
 * Split a YAML flow sequence (`["01", "02"]`) on commas that are not inside a
 * quoted item, so a blocker id containing a comma survives. Empty items are
 * dropped: `[]` is the empty list, not a list of one empty string.
 */
function splitFlowSequence(inner) {
	const items = [];
	let current = "";
	let quote = null;
	for (const character of inner) {
		if (quote !== null) {
			if (character === quote) quote = null;
			current += character;
		} else if (character === '"' || character === "'") {
			quote = character;
			current += character;
		} else if (character === ",") {
			items.push(current);
			current = "";
		} else {
			current += character;
		}
	}
	items.push(current);
	return items.map((item) => unquote(item)).filter((item) => item.length > 0);
}

/**
 * Read one ticket's text into the three contract fields, the body, and whatever
 * could not be read. `present` is false when there is no usable frontmatter
 * block; the fields then hold the contract defaults, because a caller that
 * ignores `present` should still get something safe rather than `undefined`.
 *
 * Unknown frontmatter keys are parsed past and dropped on purpose: a ticket
 * written for a newer build must still dispatch here.
 */
export function parseTicketText(text) {
	const source = typeof text === "string" ? text : "";
	const lines = source.split("\n");
	const where = findFrontmatter(lines);
	if (where.missing || where.unterminated) {
		const code = where.missing ? "missing-frontmatter" : "unterminated-frontmatter";
		const detail = where.missing
			? "does not start with a `---` frontmatter block"
			: "opens a `---` frontmatter block that is never closed";
		return {
			present: false,
			status: DEFAULT_STATUS,
			blockedBy: [],
			tierOverride: undefined,
			body: source,
			issues: [makeIssue(code, "error", `the ticket ${detail}`)],
		};
	}

	const issues = [];
	const body = lines.slice(where.end + 1).join("\n");
	let status = DEFAULT_STATUS;
	let statusSeen = false;
	let blockedBy = [];
	let tierOverride;
	let malformed = false;

	for (let index = where.start + 1; index < where.end; index += 1) {
		const raw = stripCr(lines[index]);
		const trimmed = raw.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;

		const match = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(raw);
		if (!match) {
			malformed = true;
			issues.push(
				makeIssue(
					"malformed-frontmatter",
					"error",
					`frontmatter line ${index + 1} is not a \`key: value\` pair: ${describe(trimmed)}`,
					{ line: index + 1 },
				),
			);
			continue;
		}

		const key = match[1];
		const value = match[2].trim();
		if (key === "status") {
			const parsed = unquote(value);
			statusSeen = parsed.length > 0;
			status = statusSeen ? parsed : DEFAULT_STATUS;
			continue;
		}
		if (key === "blocked-by") {
			if (value === "") {
				// A block sequence: consume the `- item` lines that follow.
				const items = [];
				while (index + 1 < where.end) {
					const next = stripCr(lines[index + 1]).trim();
					if (!next.startsWith("-")) break;
					index += 1;
					const item = unquote(next.slice(1).trim());
					if (item.length > 0) items.push(item);
				}
				blockedBy = items;
				continue;
			}
			if (value.startsWith("[") && value.endsWith("]")) {
				blockedBy = splitFlowSequence(value.slice(1, -1));
				continue;
			}
			const single = unquote(value);
			blockedBy = single.length > 0 ? [single] : [];
			issues.push(
				makeIssue(
					"blocked-by-not-a-list",
					"warning",
					`blocked-by is ${describe(value)}, not a list; reading it as one blocker`,
				),
			);
			continue;
		}
		if (key === "tier-override") {
			const parsed = unquote(value);
			if (/^\d+$/.test(parsed)) {
				tierOverride = Number.parseInt(parsed, 10);
			} else if (parsed !== "" && parsed !== "null" && parsed !== "~") {
				issues.push(
					makeIssue(
						"bad-tier-override",
						"warning",
						`tier-override is ${describe(value)}, not a tier number; ignoring it`,
					),
				);
			}
		}
		// Every other key is ignored: the contract is three fields, and a newer
		// ticket may carry more.
	}

	if (malformed) {
		// A line that is not `key: value` means the block is not the contract: the
		// fields that did parse may be the half that happens to be spelled right,
		// and dispatching from defaults when the broken line was `blocked-by:` would
		// run a ticket that is genuinely blocked. So the node is withheld and the
		// broken line is reported — a refusal a human can fix, not a guess.
		return { present: false, status: DEFAULT_STATUS, blockedBy: [], tierOverride: undefined, body, issues };
	}

	if (statusSeen && !TICKET_STATUSES.includes(status)) {
		issues.push(
			makeIssue(
				"unknown-status",
				"warning",
				`status ${describe(status)} is not one of ${TICKET_STATUSES.join(", ")}; the ticket is never on the frontier`,
			),
		);
	}

	return { present: true, status, blockedBy, tierOverride, body, issues };
}

/** The ticket id: the filename's leading number when it has one, else the stem. */
export function ticketIdFromFile(file) {
	const stem = path.basename(file).replace(TICKET_FILE, "");
	const numbered = NUMBERED_FILE.exec(stem);
	return numbered ? numbered[0] : stem;
}

/**
 * Read one ticket file. The node it returns is small on purpose — id, file,
 * status, blockers, override — because everything else (acceptance criteria, the
 * `Validation` section) is prose the dispatcher reads from the file itself.
 *
 * `ticket` is null when the file cannot serve as a node: unreadable, no
 * frontmatter, or frontmatter broken mid-block. The issues say which, and they
 * carry the file so a report can name it.
 */
export function readTicket(file) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		return {
			ticket: null,
			issues: [
				makeIssue("unreadable-ticket", "error", `could not read ${file}: ${messageOf(error)}`, { file }),
			],
		};
	}

	const parsed = parseTicketText(text);
	const severity = NUMBERED_FILE.test(path.basename(file)) ? "error" : "warning";
	const issues = parsed.issues.map((issue) => ({
		...issue,
		severity: CONTRACT_CODES.has(issue.code) ? severity : issue.severity,
		file,
		message: `${file}: ${issue.message}`,
	}));
	if (!parsed.present) return { ticket: null, issues };

	const ticket = {
		id: ticketIdFromFile(file),
		file,
		status: parsed.status,
		blockedBy: [...parsed.blockedBy],
	};
	if (parsed.tierOverride !== undefined) ticket.tierOverride = parsed.tierOverride;
	return { ticket, issues };
}

// --- Graph -----------------------------------------------------------------

/**
 * Rotate a cycle so its smallest id comes first, then serialize it. Two walks
 * that find the same loop from different entry points produce the same key, so a
 * cycle is reported once rather than once per ticket in it.
 */
function cycleKey(cycle) {
	let smallest = 0;
	for (let index = 1; index < cycle.length; index += 1) {
		if (cycle[index] < cycle[smallest]) smallest = index;
	}
	return [...cycle.slice(smallest), ...cycle.slice(0, smallest)].join(">");
}

/**
 * Find every dependency cycle, as arrays of ticket ids in dependency order.
 *
 * Iterative rather than recursive: a folder is small, but "never throws" is the
 * rule this module is built on, and a recursive walk over a pathological folder
 * turns a report into a stack overflow. An edge to a missing ticket is not a
 * cycle candidate — that is a dangling blocker, reported separately.
 */
export function findCycles(graph) {
	const colour = new Map();
	const pathStack = [];
	const cycles = [];
	const seen = new Set();
	const blockersOf = (id) => graph.byId.get(id).blockedBy.filter((blocker) => graph.byId.has(blocker));

	for (const root of graph.byId.keys()) {
		if ((colour.get(root) ?? 0) !== 0) continue;
		const frames = [{ id: root, next: 0 }];
		colour.set(root, 1);
		pathStack.push(root);
		while (frames.length > 0) {
			const frame = frames[frames.length - 1];
			const blockers = blockersOf(frame.id);
			if (frame.next < blockers.length) {
				const blocker = blockers[frame.next];
				frame.next += 1;
				const state = colour.get(blocker) ?? 0;
				if (state === 0) {
					colour.set(blocker, 1);
					pathStack.push(blocker);
					frames.push({ id: blocker, next: 0 });
				} else if (state === 1) {
					const cycle = pathStack.slice(pathStack.lastIndexOf(blocker));
					const key = cycleKey(cycle);
					if (!seen.has(key)) {
						seen.add(key);
						cycles.push(cycle);
					}
				}
				continue;
			}
			colour.set(frame.id, 2);
			pathStack.pop();
			frames.pop();
		}
	}
	return cycles;
}

/** Add the two errors that must be visible before dispatch to `graph.issues`. */
function reportGraphProblems(graph) {
	for (const ticket of graph.tickets) {
		for (const blocker of ticket.blockedBy) {
			if (graph.byId.has(blocker)) continue;
			graph.issues.push(
				makeIssue(
					"dangling-blocker",
					"error",
					`ticket ${ticket.id} is blocked by ${describe(blocker)}, which is not a ticket in this folder`,
					{ id: ticket.id, blocker, file: ticket.file },
				),
			);
		}
	}
	for (const cycle of findCycles(graph)) {
		graph.issues.push(
			makeIssue(
				"cycle",
				"error",
				`tickets ${[...cycle, cycle[0]].join(" → ")} form a cycle, so none of them can ever reach the frontier`,
				{ cycle },
			),
		);
	}
}

/**
 * Build a graph from already-read nodes. Pure: no filesystem, so tests and a
 * caller holding nodes for another reason get the same queries.
 *
 * Duplicate ids are reported and the first node wins, because a graph has to
 * stay a function: two nodes with one id would make "whose status is it" a coin
 * toss, and the report names both files so a human can pick.
 */
export function buildGraph(tickets, options = {}) {
	const byId = new Map();
	const nodes = [];
	const duplicates = new Map();
	const issues = [];

	for (const ticket of tickets) {
		const existing = byId.get(ticket.id);
		if (existing) {
			const files = duplicates.get(ticket.id) ?? [existing.file];
			files.push(ticket.file);
			duplicates.set(ticket.id, files);
			continue;
		}
		byId.set(ticket.id, ticket);
		nodes.push(ticket);
	}
	for (const [id, files] of duplicates) {
		issues.push(
			makeIssue(
				"duplicate-id",
				"error",
				`${files.join(" and ")} both claim ticket ${id}; the first one is graphed`,
				{ id, files },
			),
		);
	}

	nodes.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
	const graph = { dir: options.dir ?? null, tickets: nodes, byId, issues };
	reportGraphProblems(graph);
	return graph;
}

/**
 * Read a tickets folder. Flat, one `.md` file per ticket, as `to-tickets` writes
 * them. Never throws: an unreadable folder comes back as an empty graph with an
 * issue naming it, so a caller printing the graph does not have to catch.
 */
export function readTickets(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		return {
			dir,
			tickets: [],
			byId: new Map(),
			issues: [
				makeIssue("unreadable-directory", "error", `could not read the tickets folder ${dir}: ${messageOf(error)}`, {
					dir,
				}),
			],
		};
	}

	const files = entries
		.filter((entry) => entry.isFile() && TICKET_FILE.test(entry.name))
		.map((entry) => path.join(dir, entry.name))
		.sort();

	const parseIssues = [];
	const tickets = [];
	for (const file of files) {
		const read = readTicket(file);
		parseIssues.push(...read.issues);
		if (read.ticket) tickets.push(read.ticket);
	}

	const graph = buildGraph(tickets, { dir });
	graph.issues.unshift(...parseIssues);
	return graph;
}

/**
 * The issues that must be empty before anything dispatches: a cycle, a dangling
 * blocker, a duplicate id, a ticket whose contract could not be read. Warnings
 * (an odd status, a stray file) are reported and do not stop a run.
 */
export function blockingIssues(graph) {
	return graph.issues.filter((issue) => issue.severity === "error");
}

/**
 * The frontier: tickets whose own status is `ready` and whose every blocker is
 * `done`, plus — for every other ticket — why it is not there.
 *
 * Reasons are per-cause rather than one string, so the report can say "waiting
 * on 02 (in-progress)" instead of "not ready". A blocking ticket that is absent
 * from the folder gets `blocker-missing` and never becomes ready by waiting.
 *
 * This function does not check the graph for cycles: a caller gates dispatch on
 * `blockingIssues` first, and a cycle's members are `not done` anyway unless
 * someone marked a whole loop done, which the cycle report still names.
 */
export function frontier(graph) {
	const ready = [];
	const waiting = [];
	for (const ticket of graph.tickets) {
		const reasons = [];
		if (ticket.status !== READY_STATUS) {
			reasons.push({ code: "status-not-ready", status: ticket.status });
		}
		for (const blocker of ticket.blockedBy) {
			const node = graph.byId.get(blocker);
			if (!node) reasons.push({ code: "blocker-missing", blocker });
			else if (node.status !== "done") reasons.push({ code: "blocker-not-done", blocker, status: node.status });
		}
		const entry = { id: ticket.id, file: ticket.file };
		if (reasons.length === 0) ready.push(entry);
		else waiting.push({ ...entry, status: ticket.status, reasons });
	}
	return { ready, waiting };
}

// --- Tier precedence -------------------------------------------------------

function inTierRange(tier, maxTier) {
	return typeof tier === "number" && Number.isInteger(tier) && tier >= 1 && tier <= maxTier;
}

/**
 * Which tier a ticket dispatches at, and where that number came from.
 *
 * `tier-override` wins over everything, which is the point of the field: it is
 * the human's decision, recorded in the ticket, and a triage model must not be
 * able to talk past it. Without an override, the triage classification stands;
 * without either, the quality floor (Tier 1) does.
 *
 * An override naming a tier outside the ladder is reported rather than honoured:
 * dispatching at a tier the ladder does not define is not a dispatch at all. The
 * classification then stands in, so the ticket still runs — one tier of quality
 * is a recoverable miss, a ticket that never starts is not.
 */
export function resolveTier(ticket, classification = null, options = {}) {
	const maxTier =
		typeof options.maxTier === "number" && Number.isInteger(options.maxTier) && options.maxTier >= 1
			? options.maxTier
			: DEFAULT_MAX_TIER;
	const issues = [];
	const override = ticket?.tierOverride;
	if (override !== undefined && override !== null) {
		if (inTierRange(override, maxTier)) return { tier: override, source: "tier-override", issues };
		issues.push(
			makeIssue(
				"tier-override-out-of-range",
				"warning",
				`tier-override ${describe(override)} is outside the ladder's 1..${maxTier}; the triage classification is used instead`,
				{ id: ticket?.id, tierOverride: override },
			),
		);
	}
	const classified = classification?.tier;
	if (inTierRange(classified, maxTier)) return { tier: classified, source: "triage", issues };
	if (classified !== undefined) {
		issues.push(
			makeIssue(
				"bad-classification",
				"warning",
				`the triage classification names tier ${describe(classified)}, outside 1..${maxTier}; dispatching at tier ${Math.min(DEFAULT_TIER, maxTier)}`,
			),
		);
	}
	return { tier: Math.min(DEFAULT_TIER, maxTier), source: "default", issues };
}

// --- Status write-back -----------------------------------------------------

/**
 * The prose value a status writes. The machine field stays a bare status; the
 * human line carries the reason, because the frontmatter contract is three keys
 * and a fourth (`blocked-reason`) would be a contract change made by a writer
 * that no reader agreed to.
 */
function proseValueFor(status, reason) {
	return status === "blocked" && reason ? `${status} — ${reason}` : status;
}

/**
 * Move one ticket to `status`, in the frontmatter and in the prose
 * `**Status:**` line beside it, which the `to-tickets` contract requires to
 * agree. Idempotent: writing the status a ticket already has changes nothing and
 * reports `changed: false`, so a retried wave is not a file churn.
 *
 * Every other byte of the file is preserved — that is the whole design of this
 * function. The two `status` lines are edited in place, nothing is re-serialized,
 * and a file is written only when a line actually differs.
 *
 * Refusals, all without touching the file: a status outside `TICKET_STATUSES`
 * (the contract has no such state), a missing or unterminated frontmatter block
 * (there is no machine field to write), and an unwritable file. A numbered
 * ticket with a missing prose line is written and reported: the frontmatter is
 * the machine contract, so the write is still correct.
 *
 * Transitions are not policed — any status may move to any other. The graph is
 * recomputed from disk each wave, so a stale transition cannot wedge a run, and a
 * human reopening a `blocked` or `done` ticket is a legitimate edit rather than
 * an error this function should refuse.
 *
 * `reason` is appended to the prose line for `blocked` only, and only when given.
 */
export function setTicketStatus(file, status, options = {}) {
	const reason = typeof options.reason === "string" && options.reason.trim().length > 0 ? options.reason.trim() : null;
	if (!TICKET_STATUSES.includes(status)) {
		return {
			ok: false,
			changed: false,
			status,
			previous: undefined,
			issues: [
				makeIssue(
					"unknown-status",
					"error",
					`${describe(status)} is not one of ${TICKET_STATUSES.join(", ")}; ${file} is unchanged`,
					{ file },
				),
			],
		};
	}

	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		return {
			ok: false,
			changed: false,
			status,
			previous: undefined,
			issues: [makeIssue("unreadable-ticket", "error", `could not read ${file}: ${messageOf(error)}`, { file })],
		};
	}

	const lines = text.split("\n");
	const where = findFrontmatter(lines);
	if (where.missing || where.unterminated) {
		const code = where.missing ? "missing-frontmatter" : "unterminated-frontmatter";
		return {
			ok: false,
			changed: false,
			status,
			previous: undefined,
			issues: [
				makeIssue(code, "error", `${file} has no usable frontmatter block, so it cannot be written back`, {
					file,
				}),
			],
		};
	}

	const issues = [];
	let previous;
	let wroteField = false;
	for (let index = where.start + 1; index < where.end; index += 1) {
		const match = /^([ \t]*status[ \t]*:[ \t]*)(.*)$/.exec(stripCr(lines[index]));
		if (!match) continue;
		previous = unquote(match[2].trim());
		wroteField = true;
		if (match[2].trim() !== status) lines[index] = `${match[1]}${status}${carriageReturn(lines[index])}`;
		break;
	}
	if (!wroteField) {
		// A ticket may omit `status` (it then reads as ready), but a write-back has
		// to leave a field behind or the next reader would disagree with this one.
		// The inserted line takes the file's own line ending, so a file that was
		// CRLF before the write is not left half-CRLF after it.
		lines.splice(where.start + 1, 0, `status: ${status}${carriageReturn(lines[where.start])}`);
		previous = DEFAULT_STATUS;
	}

	const prose = proseValueFor(status, reason);
	let foundProse = false;
	for (let index = where.end + 1; index < lines.length; index += 1) {
		const match = /^([ \t]*\*\*Status:\*\*[ \t]*)(.*)$/.exec(stripCr(lines[index]));
		if (!match) continue;
		foundProse = true;
		if (match[2].trim() !== prose) lines[index] = `${match[1]}${prose}${carriageReturn(lines[index])}`;
		break;
	}
	if (!foundProse) {
		issues.push(
			makeIssue(
				"missing-status-line",
				"warning",
				`${file} has no prose \`**Status:**\` line; only the frontmatter was updated`,
				{ file },
			),
		);
	}

	const next = lines.join("\n");
	if (next === text) return { ok: true, changed: false, status, previous, issues };
	try {
		writeFileSync(file, next, "utf8");
	} catch (error) {
		return {
			ok: false,
			changed: false,
			status,
			previous,
			issues: [makeIssue("unwritable-ticket", "error", `could not write ${file}: ${messageOf(error)}`, { file })],
		};
	}
	return { ok: true, changed: true, status, previous, issues };
}
