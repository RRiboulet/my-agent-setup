// wave-tickets.mjs — the ticket graph the wave orchestrator dispatches over.
//
// A `to-tickets` folder is a graph written in prose plus a three-key frontmatter
// block (`skills/to-tickets/SKILL.md` §4): `status`, `blocked-by`, and an
// optional `tier-override`. This module turns that folder into nodes and edges
// and answers the questions a dispatcher must ask BEFORE it starts anything —
// which tickets are on the frontier, and whether the graph is dispatchable at
// all (cycles, dangling blockers). Those two checks live in code rather than in
// skill prose for the reason `.pi/extensions/orchestrator/wave-ladder.mjs`
// exists: a rule written only in a prompt cannot fail, so it cannot be trusted.
//
// **Reported, never thrown.** Every read returns a graph plus an `issues` list
// and nothing here throws. `blockingIssues(graph)` surfaces dispatch blockers
// (cycles, dangling blockers, duplicate ids, unreadable numbered ticket
// contracts).
//
// **Why `tier-override` is range-checked here and not at parse time.** The
// ladder owns how many tiers exist (`wave-ladder.json`, read by
// `wave-ladder.mjs`), so `resolveTier` takes `maxTier` from the caller.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export const TICKET_STATUSES = Object.freeze(["ready", "in-progress", "done", "blocked"]);
export const DEFAULT_STATUS = "ready";
export const DEFAULT_TIER = 1;
export const DEFAULT_MAX_TIER = 3;

const FRONTMATTER_DELIMITER = "---";
const TICKET_FILE = /\.md$/i;
const NUMBERED_FILE = /^\d+/;
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

function makeIssue(code, severity, message, extra = {}) {
	return { code, severity, message, ...extra };
}

// --- Frontmatter -----------------------------------------------------------

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
	}

	if (malformed) {
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

export function ticketIdFromFile(file) {
	const stem = path.basename(file).replace(TICKET_FILE, "");
	const numbered = NUMBERED_FILE.exec(stem);
	return numbered ? numbered[0] : stem;
}

function titleFromBody(body, id, fallback) {
	if (typeof body !== "string") return fallback;
	const match = /^[ \t]*#[ \t]+(.+?)[ \t]*$/m.exec(body);
	if (!match) return fallback;
	const raw = match[1].trim();
	const prefix = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`);
	const stripped = raw.replace(prefix, "").trim();
	return stripped || raw || fallback;
}

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

	const id = ticketIdFromFile(file);
	const ticket = {
		id,
		file,
		title: titleFromBody(parsed.body, id, id),
		status: parsed.status,
		blockedBy: [...parsed.blockedBy],
	};
	if (parsed.tierOverride !== undefined) ticket.tierOverride = parsed.tierOverride;
	return { ticket, issues };
}

// --- Graph -----------------------------------------------------------------

function cycleKey(cycle) {
	let smallest = 0;
	for (let index = 1; index < cycle.length; index += 1) {
		if (cycle[index] < cycle[smallest]) smallest = index;
	}
	return [...cycle.slice(smallest), ...cycle.slice(0, smallest)].join(">");
}

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

export function blockingIssues(graph) {
	return graph.issues.filter((issue) => issue.severity === "error");
}

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

function proseValueFor(status, reason) {
	return status === "blocked" && reason ? `${status} — ${reason}` : status;
}

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
