// Tests for the ticket-graph parser.
//
// The contract these pin is the ticket frontmatter written by `to-tickets`
// (`.pi/skills/to-tickets/SKILL.md` §4 and its ticket template): `status`,
// `blocked-by` (quoted ids), and an optional `tier-override`. Everything here is
// built from real files in a temp folder rather than from hand-made objects,
// because the two properties that matter — "a plain file read sees the status"
// and "the rest of the file survives a write untouched" — can only be asserted
// against bytes on disk.
//
// The reader's failure rule is the one `ladder.mjs` and the orchestrator config
// reader already state: a malformed input is REPORTED, never thrown, so a
// half-broken ticket folder neither dispatches silently nor traps the session.
// A cycle and a dangling blocker are the two errors that must be visible before
// any dispatch, which is why they are asserted both as named issues and through
// `blockingIssues`.
//
// The frontier cases run as one progression — diamond, dispatch one, re-read —
// because the graph is recomputed from disk every wave. A parser that cached
// node status would pass a single-read assertion and be wrong in the skill.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	DEFAULT_MAX_TIER,
	DEFAULT_STATUS,
	TICKET_STATUSES,
	blockingIssues,
	findCycles,
	frontier,
	parseTicketText,
	readTicket,
	readTickets,
	resolveTier,
	setTicketStatus,
	ticketIdFromFile,
} from "./tickets.mjs";
import { readLadder } from "./ladder.mjs";

function tempDir(t) {
	const dir = mkdtempSync(path.join(tmpdir(), "orchestrate-tickets-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * A ticket file shaped like the `to-tickets` template. `body` is appended after
 * the prose `**Status:**` line so a test can prove a write-back leaves the body
 * alone.
 */
function ticketMarkdown({
	id = "01",
	title = "A ticket",
	status = DEFAULT_STATUS,
	blockedBy = [],
	tierOverride,
	frontmatterExtra = [],
	body = "The end-to-end behavior this ticket makes work.",
} = {}) {
	const lines = ["---", `status: ${status}`];
	lines.push(`blocked-by: [${blockedBy.map((blocker) => JSON.stringify(blocker)).join(", ")}]`);
	if (tierOverride !== undefined) lines.push(`tier-override: ${tierOverride}`);
	lines.push(...frontmatterExtra);
	lines.push(
		"---",
		"",
		`# ${id}: ${title}`,
		"",
		`**Blocked by:** ${blockedBy.length === 0 ? "None (can start immediately)" : blockedBy.join(", ")}`,
		`**Status:** ${status}`,
		"",
		"## What to build",
		body,
		"",
	);
	return lines.join("\n");
}

/** Write a ticket into `dir`; the filename defaults to `<id>-ticket.md`. */
function writeTicket(dir, spec = {}) {
	const name = spec.name ?? `${spec.id ?? "01"}-ticket.md`;
	const file = path.join(dir, name);
	writeFileSync(file, spec.text ?? ticketMarkdown(spec), "utf8");
	return file;
}

/** A ticket file whose content is raw text, for malformed-input cases. */
function writeRaw(dir, name, text) {
	const file = path.join(dir, name);
	writeFileSync(file, text, "utf8");
	return file;
}

function codes(issues) {
	return issues.map((issue) => issue.code);
}

/** The status write-back must care about these, so a drift is a named failure. */
test("the ticket statuses are the four the contract names", () => {
	assert.deepEqual([...TICKET_STATUSES], ["ready", "in-progress", "done", "blocked"]);
	assert.equal(DEFAULT_STATUS, "ready");
});

/**
 * The default tier ceiling stands in for the ladder's own count when a caller
 * does not pass one, so it has to be the ladder's count. Without this pin a
 * fourth tier could be added to `ladder.json` and every `tier-override: 4` would
 * be quietly ignored until someone read the warnings.
 */
test("the default tier ceiling matches the shipped ladder", () => {
	assert.equal(DEFAULT_MAX_TIER, readLadder().ladder.tiers.length);
});

// --- Frontmatter -----------------------------------------------------------

test("parseTicketText reads the template frontmatter and keeps quoted ids quoted", () => {
	const text = [
		"---",
		"status: ready",
		'blocked-by: ["01", "02"]',
		"# tier-override: 2",
		"---",
		"",
		"# 03: A ticket",
		"",
	].join("\n");
	const parsed = parseTicketText(text);
	assert.equal(parsed.present, true);
	assert.equal(parsed.status, "ready");
	assert.deepEqual(parsed.blockedBy, ["01", "02"]);
	assert.equal(parsed.tierOverride, undefined, "a commented-out override is not an override");
	assert.deepEqual(parsed.issues, []);
	assert.match(parsed.body, /^# 03: A ticket/m, "the body is everything after the closing delimiter");
	assert.doesNotMatch(parsed.body, /blocked-by/, "the frontmatter is not part of the body");
});

test("absent frontmatter fields take the contract defaults", () => {
	const parsed = parseTicketText(["---", "owner: someone", "---", "", "Body.", ""].join("\n"));
	assert.equal(parsed.present, true);
	assert.equal(parsed.status, DEFAULT_STATUS, "a missing status reads as ready");
	assert.deepEqual(parsed.blockedBy, []);
	assert.equal(parsed.tierOverride, undefined);
	assert.deepEqual(parsed.issues, [], "an unknown frontmatter key is ignored, not reported");
});

test("blocked-by may be written as a YAML block sequence", () => {
	const parsed = parseTicketText(
		["---", "status: ready", "blocked-by:", '  - "01"', '  - "02"', "---", "", "Body.", ""].join("\n"),
	);
	assert.deepEqual(parsed.blockedBy, ["01", "02"]);
	assert.deepEqual(parsed.issues, []);
});

test("a scalar blocked-by is used as one blocker and reported", () => {
	const parsed = parseTicketText(["---", "status: ready", 'blocked-by: "01"', "---", "", ""].join("\n"));
	assert.deepEqual(parsed.blockedBy, ["01"]);
	assert.deepEqual(codes(parsed.issues), ["blocked-by-not-a-list"]);
});

test("a non-integer tier-override is reported and ignored", () => {
	const parsed = parseTicketText(["---", "status: ready", "tier-override: two", "---", "", ""].join("\n"));
	assert.equal(parsed.tierOverride, undefined);
	assert.deepEqual(codes(parsed.issues), ["bad-tier-override"]);
});

test("a ticket with no frontmatter block is reported and not graphed", (t) => {
	const dir = tempDir(t);
	const file = writeRaw(dir, "notes.md", "# Notes\n\nNo machine contract here.\n");
	const read = readTicket(file);
	assert.equal(read.ticket, null);
	assert.deepEqual(codes(read.issues), ["missing-frontmatter"]);

	const graph = readTickets(dir);
	assert.deepEqual(graph.tickets, []);
	assert.deepEqual(codes(graph.issues), ["missing-frontmatter"]);
	assert.match(graph.issues[0].message, /notes\.md/, "the report names the file");
});

test("malformed and unterminated frontmatter are reported, never thrown", (t) => {
	const dir = tempDir(t);
	writeRaw(dir, "02-unterminated.md", ["---", "status: ready", "", "Body.", ""].join("\n"));
	writeRaw(dir, "03-bad-line.md", ["---", "status ready", "---", "", "Body.", ""].join("\n"));
	writeTicket(dir, { id: "04", name: "04-valid.md" });

	const graph = readTickets(dir);
	assert.deepEqual(
		graph.tickets.map((ticket) => ticket.id),
		["04"],
		"an unreadable contract cannot become a node",
	);
	assert.deepEqual(
		graph.issues.map((issue) => [issue.code, path.basename(issue.file ?? "")]),
		[
			["unterminated-frontmatter", "02-unterminated.md"],
			["malformed-frontmatter", "03-bad-line.md"],
		],
	);
});

// --- Graph -----------------------------------------------------------------

test("a three-node diamond is dispatched in dependency order", (t) => {
	const dir = tempDir(t);
	writeTicket(dir, { id: "01", name: "01-root.md" });
	writeTicket(dir, { id: "02", name: "02-left.md", blockedBy: ["01"] });
	writeTicket(dir, { id: "03", name: "03-join.md", blockedBy: ["01", "02"] });

	const first = frontier(readTickets(dir));
	assert.deepEqual(first.ready, [{ id: "01", file: path.join(dir, "01-root.md") }]);
	assert.deepEqual(
		first.waiting.map((entry) => [entry.id, entry.reasons.map((reason) => reason.code)]),
		[
			["02", ["blocker-not-done"]],
			["03", ["blocker-not-done", "blocker-not-done"]],
		],
	);
	assert.deepEqual(first.waiting[0].reasons[0], {
		code: "blocker-not-done",
		blocker: "01",
		status: "ready",
	});

	setTicketStatus(path.join(dir, "01-root.md"), "done");
	const second = frontier(readTickets(dir));
	assert.deepEqual(second.ready.map((entry) => entry.id), ["02"]);

	setTicketStatus(path.join(dir, "02-left.md"), "done");
	const third = frontier(readTickets(dir));
	assert.deepEqual(third.ready.map((entry) => entry.id), ["03"]);

	setTicketStatus(path.join(dir, "03-join.md"), "done");
	assert.deepEqual(frontier(readTickets(dir)).ready, [], "a done ticket is not dispatched again");
});

test("a ticket already in progress is not on the frontier", (t) => {
	const dir = tempDir(t);
	writeTicket(dir, { id: "01", status: "in-progress" });
	const result = frontier(readTickets(dir));
	assert.deepEqual(result.ready, []);
	assert.deepEqual(result.waiting[0].reasons, [{ code: "status-not-ready", status: "in-progress" }]);
});

test("a two-ticket cycle is a named error", (t) => {
	const dir = tempDir(t);
	writeTicket(dir, { id: "01", blockedBy: ["02"] });
	writeTicket(dir, { id: "02", blockedBy: ["01"] });
	writeTicket(dir, { id: "03" });

	const graph = readTickets(dir);
	assert.deepEqual(graph.issues.filter((issue) => issue.code === "cycle").map((issue) => issue.cycle), [
		["01", "02"],
	]);
	assert.deepEqual(findCycles(graph), [["01", "02"]]);
	assert.deepEqual(
		blockingIssues(graph).map((issue) => issue.code),
		["cycle"],
		"a cycle blocks dispatch",
	);
	assert.deepEqual(frontier(graph).ready.map((entry) => entry.id), ["03"], "the unrelated ticket is unaffected");
});

test("a ticket that blocks itself is a cycle of one", (t) => {
	const dir = tempDir(t);
	writeTicket(dir, { id: "01", blockedBy: ["01"] });
	const graph = readTickets(dir);
	assert.deepEqual(findCycles(graph), [["01"]]);
	assert.deepEqual(graph.issues.filter((issue) => issue.code === "cycle").map((issue) => issue.cycle), [["01"]]);
});

test("a dangling blocker is a named error and keeps its ticket off the frontier", (t) => {
	const dir = tempDir(t);
	writeTicket(dir, { id: "01", blockedBy: ["09"] });

	const graph = readTickets(dir);
	const dangling = graph.issues.filter((issue) => issue.code === "dangling-blocker");
	assert.equal(dangling.length, 1);
	assert.equal(dangling[0].id, "01");
	assert.equal(dangling[0].blocker, "09");
	assert.match(dangling[0].message, /09/);
	assert.deepEqual(blockingIssues(graph).map((issue) => issue.code), ["dangling-blocker"]);
	assert.deepEqual(frontier(graph).waiting[0].reasons, [{ code: "blocker-missing", blocker: "09" }]);
});

test("two files claiming one ticket id are reported once and the first wins", (t) => {
	const dir = tempDir(t);
	const first = writeTicket(dir, { id: "02", name: "02-first.md" });
	writeTicket(dir, { id: "02", name: "02-second.md" });

	const graph = readTickets(dir);
	const duplicate = graph.issues.filter((issue) => issue.code === "duplicate-id");
	assert.equal(duplicate.length, 1);
	assert.equal(duplicate[0].id, "02");
	assert.deepEqual(duplicate[0].files, [first, path.join(dir, "02-second.md")]);
	assert.equal(graph.tickets.length, 1);
	assert.equal(graph.byId.get("02").file, first);
});

test("an unknown status is reported and never on the frontier", (t) => {
	const dir = tempDir(t);
	writeTicket(dir, { id: "01", status: "finished" });
	const graph = readTickets(dir);
	assert.deepEqual(codes(graph.issues), ["unknown-status"]);
	assert.deepEqual(blockingIssues(graph), [], "an odd status is a warning, not a dispatch error");
	assert.deepEqual(frontier(graph).ready, []);
});

test("ticket ids come from the filename's number, keeping zero padding", (t) => {
	const dir = tempDir(t);
	assert.equal(ticketIdFromFile(path.join(dir, "07-a-long-name.md")), "07");
	assert.equal(ticketIdFromFile(path.join(dir, "notes.md")), "notes");
	const file = writeTicket(dir, { id: "07", name: "07-a-long-name.md" });
	assert.equal(readTickets(dir).byId.get("07").file, file);
});

test("an unreadable directory is reported, never thrown", () => {
	const graph = readTickets(path.join(tmpdir(), "orchestrate-tickets-does-not-exist"));
	assert.deepEqual(graph.tickets, []);
	assert.deepEqual(codes(graph.issues), ["unreadable-directory"]);
});

// --- Tier precedence -------------------------------------------------------

test("tier-override wins over the triage classification", () => {
	const resolved = resolveTier({ id: "01", tierOverride: 3 }, { tier: 1, justification: "small" });
	assert.deepEqual(resolved, { tier: 3, source: "tier-override", issues: [] });
});

test("without an override the classification is used, and without either a safe default", () => {
	assert.deepEqual(resolveTier({ id: "01" }, { tier: 2, justification: "medium" }), {
		tier: 2,
		source: "triage",
		issues: [],
	});
	assert.deepEqual(resolveTier({ id: "01" }, null), { tier: 1, source: "default", issues: [] });
});

test("an override outside the ladder is reported and does not dispatch", () => {
	const resolved = resolveTier({ id: "01", tierOverride: 9 }, { tier: 2 }, { maxTier: 3 });
	assert.equal(resolved.tier, 2, "the classification stands in rather than an off-ladder tier");
	assert.equal(resolved.source, "triage");
	assert.deepEqual(codes(resolved.issues), ["tier-override-out-of-range"]);
});

// --- Status write-back -----------------------------------------------------

test("a status change rewrites frontmatter and prose, and a plain read sees it", (t) => {
	const dir = tempDir(t);
	const file = writeTicket(dir, { id: "01", body: "status: this is body text, not a field" });
	const before = readFileSync(file, "utf8");

	const result = setTicketStatus(file, "in-progress");
	assert.equal(result.ok, true);
	assert.equal(result.changed, true);
	assert.equal(result.previous, "ready");
	assert.deepEqual(result.issues, []);

	const after = readFileSync(file, "utf8");
	assert.equal(
		after,
		before
			.replace("status: ready", "status: in-progress")
			.replace("**Status:** ready", "**Status:** in-progress"),
		"every byte outside the two status fields is untouched",
	);
	assert.equal(parseTicketText(after).status, "in-progress");
	assert.match(after, /^\*\*Status:\*\* in-progress$/m);
});

test("writing the same status twice changes nothing", (t) => {
	const dir = tempDir(t);
	const file = writeTicket(dir, { id: "01" });
	assert.equal(setTicketStatus(file, "done").changed, true);
	const once = readFileSync(file, "utf8");

	const again = setTicketStatus(file, "done");
	assert.equal(again.ok, true);
	assert.equal(again.changed, false);
	assert.equal(again.previous, "done");
	assert.equal(readFileSync(file, "utf8"), once);
});

test("a blocked status carries its reason in prose only, idempotently", (t) => {
	const dir = tempDir(t);
	const file = writeTicket(dir, { id: "01" });

	assert.equal(setTicketStatus(file, "blocked", { reason: "tier 3 exhausted" }).changed, true);
	const after = readFileSync(file, "utf8");
	assert.match(after, /^status: blocked$/m, "frontmatter stays the machine field");
	assert.match(after, /^\*\*Status:\*\* blocked — tier 3 exhausted$/m);

	const again = setTicketStatus(file, "blocked", { reason: "tier 3 exhausted" });
	assert.equal(again.changed, false);
	assert.equal(readFileSync(file, "utf8"), after);

	assert.equal(setTicketStatus(file, "ready").changed, true);
	assert.match(readFileSync(file, "utf8"), /^\*\*Status:\*\* ready$/m, "leaving blocked drops the reason");
	assert.doesNotMatch(readFileSync(file, "utf8"), /tier 3 exhausted/);
});

test("a status the contract does not name is refused before any write", (t) => {
	const dir = tempDir(t);
	const file = writeTicket(dir, { id: "01" });
	const before = readFileSync(file, "utf8");

	const result = setTicketStatus(file, "finished");
	assert.equal(result.ok, false);
	assert.equal(result.changed, false);
	assert.deepEqual(codes(result.issues), ["unknown-status"]);
	assert.equal(readFileSync(file, "utf8"), before);
});

test("a ticket with no frontmatter cannot be written back, and says so", (t) => {
	const dir = tempDir(t);
	const file = writeRaw(dir, "notes.md", "# Notes\n\n**Status:** ready\n");
	const before = readFileSync(file, "utf8");

	const result = setTicketStatus(file, "done");
	assert.equal(result.ok, false);
	assert.equal(result.changed, false);
	assert.deepEqual(codes(result.issues), ["missing-frontmatter"]);
	assert.equal(readFileSync(file, "utf8"), before);
});

test("a CRLF ticket is written back without changing its line endings", (t) => {
	const dir = tempDir(t);
	const file = writeRaw(
		dir,
		"01-crlf.md",
		"\uFEFF---\r\nblocked-by: []\r\n---\r\n\r\n# 01: A ticket\r\n\r\n**Status:** ready\r\n",
	);

	const result = setTicketStatus(file, "done");
	assert.equal(result.ok, true);
	assert.equal(result.changed, true);
	assert.equal(result.previous, "ready");
	assert.equal(
		readFileSync(file, "utf8"),
		"\uFEFF---\r\nstatus: done\r\nblocked-by: []\r\n---\r\n\r\n# 01: A ticket\r\n\r\n**Status:** done\r\n",
		"the inserted field and both edits keep the file's CRLF endings, and the BOM survives",
	);
	assert.equal(parseTicketText(readFileSync(file, "utf8")).status, "done");
});

test("a missing prose status line is updated in frontmatter and reported", (t) => {
	const dir = tempDir(t);
	const file = writeRaw(dir, "01-no-prose.md", ["---", "status: ready", "blocked-by: []", "---", "", "# 01: A ticket", ""].join("\n"));

	const result = setTicketStatus(file, "done");
	assert.equal(result.ok, true);
	assert.equal(result.changed, true);
	assert.deepEqual(codes(result.issues), ["missing-status-line"]);
	assert.match(readFileSync(file, "utf8"), /^status: done$/m);
});
