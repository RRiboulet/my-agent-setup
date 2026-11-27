import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
	analyzeTicketSet,
	createTicket,
	discoverTicketSets,
	loadTicketSet,
	parseTicketMarkdown,
	renderDependencyGraph,
	updateTicket,
} from "./store.mjs";
import { createTicketTools } from "./tools.mjs";
import { runTicketsCommand } from "./ui.mjs";

async function withTempDir(fn) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tickets-ext-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function writeFile(filePath, content) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf8");
}

const SAMPLE_T1 = `# 01: Walking skeleton

**Repo:** Compass-A2A (service)
**Blocked by:** None (can start immediately)
**Status:** ready

Spec: \`docs/specs/2026-11-12-sample.md\`

## What to build

Build the initial walking skeleton so callers get a health response.

## Scope

- Service entrypoint and health route.
- Out of scope: auth (02).

## Acceptance criteria

- [x] Health endpoint returns 200.
- [ ] Unit test runs cleanly.

## Validation

Run pytest on health route.
`;

const SAMPLE_T2 = `# 02: Add auth guard

**Blocked by:** 01
**Status:** blocked

## What to build

Reject unauthenticated requests with 401.

## Scope

- Auth middleware.

## Acceptance criteria

- [ ] Anonymous request returns 401.
- [ ] Valid token returns 200.

## Validation

Auth middleware tests.
`;

const SAMPLE_T3 = `# 03: Audit logging

**Blocked by:** 01, 02
**Status:** blocked

## What to build

Write one audit entry per authenticated write.

## Scope

- Audit table and writer.

## Acceptance criteria

- [ ] Every write records an audit row.

## Validation

Integration test.
`;

describe("store: parseTicketMarkdown", () => {
	it("parses heading, metadata, blockers, sections, and acceptance criteria", () => {
		const t = parseTicketMarkdown(SAMPLE_T1, "/repo/docs/specs/tickets/demo/01-walking-skeleton.md");
		assert.equal(t.id, "01");
		assert.equal(t.title, "Walking skeleton");
		assert.equal(t.repo, "Compass-A2A (service)");
		assert.equal(t.status, "ready");
		assert.deepEqual(t.blockedBy, []);
		assert.equal(t.spec, "docs/specs/2026-11-12-sample.md");
		assert.match(t.sections.whatToBuild, /health response/);
		assert.equal(t.acceptanceCriteria.length, 2);
		assert.equal(t.acceptanceCriteria[0].checked, true);
		assert.equal(t.acceptanceCriteria[0].text, "Health endpoint returns 200.");
		assert.equal(t.acceptanceCriteria[1].checked, false);
		assert.equal(t.acceptanceCriteria[1].text, "Unit test runs cleanly.");
	});

	it("parses multiple blockers with various punctuation formats", () => {
		const md = `# 05: Combine\n\n**Blocked by:** #01, 02 (schema), and 04\n**Status:** in progress\n`;
		const t = parseTicketMarkdown(md, "/repo/docs/tickets/demo/05-combine.md");
		assert.equal(t.id, "05");
		assert.equal(t.status, "in progress");
		assert.deepEqual(t.blockedBy, ["01", "02", "04"]);
	});

	it("parses YAML frontmatter (status, blocked-by, tier-override) and strips frontmatter before body parsing", () => {
		const md = [
			"---",
			"status: in-progress",
			"blocked-by: [01, 02]",
			"# tier-override: 1",
			"tier-override: 2",
			"---",
			"",
			"# 03: Cross-harness ticket",
			"",
			"**Blocked by:** None",
			"**Status:** ready",
			"",
			"## What to build",
			"",
			"Ensure frontmatter wins over stale body metadata.",
			"",
			"## Acceptance criteria",
			"",
			"- [ ] Works across harnesses",
			"",
		].join("\n");
		const t = parseTicketMarkdown(md, "/repo/docs/tickets/demo/03-cross-harness.md");
		assert.equal(t.id, "03");
		assert.equal(t.title, "Cross-harness ticket");
		assert.equal(t.status, "in progress");
		assert.deepEqual(t.blockedBy, ["01", "02"]);
		assert.equal(t.tierOverride, 2);
		assert.match(t.sections.whatToBuild, /frontmatter wins/);
		assert.equal(t.acceptanceCriteria.length, 1);
		assert.equal(t.acceptanceCriteria[0].text, "Works across harnesses");
	});
});

describe("store: discoverTicketSets", () => {
	it("discovers ticket sets inside a single repo (docs/specs/tickets and docs/tickets)", async () => {
		await withTempDir(async (root) => {
			await fs.mkdir(path.join(root, ".git"));
			await writeFile(path.join(root, "docs/specs/tickets/alpha/01-one.md"), SAMPLE_T1);
			await writeFile(path.join(root, "docs/tickets/beta/01-one.md"), SAMPLE_T1);

			const result = await discoverTicketSets(root);
			assert.equal(result.hiddenWorktreeCount, 0);
			assert.deepEqual(
				result.sets.map((s) => s.slug).sort(),
				["alpha", "beta"],
			);
		});
	});

	it("skips secondary git worktrees at workspace root by default and shows them when requested", async () => {
		await withTempDir(async (root) => {
			// Primary repo: .git is a directory
			await fs.mkdir(path.join(root, "Compass/.git"), { recursive: true });
			await writeFile(path.join(root, "Compass/docs/specs/tickets/feat/01-one.md"), SAMPLE_T1);

			// Secondary worktree: .git is a file pointing to gitdir
			await writeFile(
				path.join(root, "Compass.t01-wt/.git"),
				"gitdir: /workspace/Compass/.git/worktrees/t01-wt\n",
			);
			await writeFile(
				path.join(root, "Compass.t01-wt/docs/specs/tickets/feat/01-one.md"),
				SAMPLE_T1,
			);

			const defaultResult = await discoverTicketSets(root);
			assert.equal(defaultResult.sets.length, 1);
			assert.equal(defaultResult.sets[0].project, "Compass");
			assert.equal(defaultResult.hiddenWorktreeCount, 1);

			const withWorktrees = await discoverTicketSets(root, { includeWorktrees: true });
			assert.equal(withWorktrees.sets.length, 2);
			assert.equal(withWorktrees.hiddenWorktreeCount, 0);
		});
	});

	it("discovers a valid directory symlink under docs/tickets/<slug> and loads its tickets cleanly", async () => {
		await withTempDir(async (root) => {
			const repoDir = path.join(root, "repo");
			await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
			await fs.mkdir(path.join(repoDir, "docs/tickets"), { recursive: true });

			const targetDir = path.join(root, "external-tickets/pi-orchestration-parity");
			await writeFile(path.join(targetDir, "01-skeleton.md"), SAMPLE_T1);
			await writeFile(path.join(root, "external-tickets/02-linked.md"), SAMPLE_T2);
			await fs.symlink(
				path.join(root, "external-tickets/02-linked.md"),
				path.join(targetDir, "02-linked.md"),
			);

			await fs.symlink(targetDir, path.join(repoDir, "docs/tickets/pi-orchestration-parity"));

			const result = await discoverTicketSets(repoDir);
			assert.equal(result.sets.length, 1);
			assert.equal(result.sets[0].slug, "pi-orchestration-parity");

			const tickets = await loadTicketSet(result.sets[0].dir);
			assert.deepEqual(
				tickets.map((t) => t.id),
				["01", "02"],
			);
		});
	});

	it("skips broken symlinks under docs/tickets/<slug> without throwing", async () => {
		await withTempDir(async (root) => {
			await fs.mkdir(path.join(root, ".git"));
			await writeFile(path.join(root, "docs/tickets/valid/01-one.md"), SAMPLE_T1);
			await fs.symlink(
				path.join(root, "does-not-exist"),
				path.join(root, "docs/tickets/broken-link"),
			);

			const result = await discoverTicketSets(root);
			assert.deepEqual(
				result.sets.map((s) => s.slug),
				["valid"],
			);
		});
	});

	it("deduplicates symlinked ticket sets by realpath so tools operate without ambiguity", async () => {
		await withTempDir(async (root) => {
			await fs.mkdir(path.join(root, ".git"));
			await writeFile(path.join(root, "docs/specs/tickets/feat/01-skeleton.md"), SAMPLE_T1);
			await fs.mkdir(path.join(root, "docs/tickets"), { recursive: true });
			await fs.symlink("../specs/tickets/feat", path.join(root, "docs/tickets/feat"));

			const result = await discoverTicketSets(root);
			assert.equal(result.sets.length, 1);
			assert.equal(result.sets[0].slug, "feat");

			const tools = createTicketTools({ getRootDir: async () => root });
			const byName = new Map(tools.map((t) => [t.name, t]));

			const getOut = await byName.get("tickets_get").handler({ set: "feat", id: "01" });
			assert.equal(typeof getOut, "string");
			assert.match(getOut, /Walking skeleton/);

			const createOut = await byName.get("tickets_create").handler({
				set: "feat",
				title: "Add auth guard",
				blockedBy: ["01"],
			});
			assert.equal(typeof createOut, "string");
			assert.match(createOut, /Created #02: Add auth guard/);
		});
	});
});

describe("store: analyzeTicketSet", () => {
	it("computes frontier, unresolved blockers, downstream unblocks, and stale-blocked state", async () => {
		await withTempDir(async (root) => {
			const setDir = path.join(root, "docs/specs/tickets/demo");
			await writeFile(path.join(setDir, "01-skeleton.md"), SAMPLE_T1.replace("ready", "done"));
			await writeFile(path.join(setDir, "02-auth.md"), SAMPLE_T2);
			await writeFile(path.join(setDir, "03-audit.md"), SAMPLE_T3);

			const tickets = await loadTicketSet(setDir);
			const analysis = analyzeTicketSet(tickets);

			assert.equal(analysis.stats.total, 3);
			assert.equal(analysis.stats.done, 1);
			assert.equal(analysis.frontier.map((t) => t.id).join(","), "02");

			const t2 = analysis.byId.get("02");
			assert.equal(t2.isFrontier, true);
			assert.equal(t2.effectiveState, "stale-blocked");
			assert.deepEqual(t2.unblocks, ["03"]);

			const t3 = analysis.byId.get("03");
			assert.equal(t3.isFrontier, false);
			assert.deepEqual(t3.unresolvedBlockers, ["02"]);
			assert.equal(t3.effectiveState, "blocked");

			const graph = renderDependencyGraph(analysis);
			assert.match(graph, /01/);
			assert.match(graph, /02/);
			assert.match(graph, /03/);
		});
	});

	it("detects dependency cycles", async () => {
		const a = parseTicketMarkdown("# 01: A\n**Blocked by:** 02\n**Status:** blocked\n", "/a/01-a.md");
		const b = parseTicketMarkdown("# 02: B\n**Blocked by:** 01\n**Status:** blocked\n", "/a/02-b.md");
		const analysis = analyzeTicketSet([a, b]);
		assert.equal(analysis.cycles.length > 0, true);
		assert.equal(analysis.frontier.length, 0);
	});

	it("keeps externally blocked tickets out of stale-blocked and auto-unblock", async () => {
		await withTempDir(async (root) => {
			const setDir = path.join(root, "docs/specs/tickets/demo");
			const p1 = path.join(setDir, "01-skeleton.md");
			const p2 = path.join(setDir, "02-external.md");
			await writeFile(p1, SAMPLE_T1);
			await writeFile(
				p2,
				`# 02: Needs external infra\n\n**Blocked by:** 01 (done), plus these external prerequisites:\n\n- Provision Keycloak client\n- Approve firewall rule\n\n**Status:** blocked\n\n## What to build\n\nWait for infra.\n`,
			);

			const res = await updateTicket(p1, { status: "done", autoUnblock: true });
			assert.deepEqual(res.unblocked, []);

			const tickets = await loadTicketSet(setDir);
			const analysis = analyzeTicketSet(tickets);
			const t2 = analysis.byId.get("02");
			assert.equal(t2.hasExternalBlockers, true);
			assert.match(t2.externalBlockers, /Provision Keycloak client/);
			assert.equal(t2.effectiveState, "blocked");
			assert.equal(t2.isFrontier, false);
		});
	});
});

describe("store: updateTicket & createTicket", () => {
	it("updates status, toggles acceptance criteria, appends notes, and auto-unblocks dependents", async () => {
		await withTempDir(async (root) => {
			const setDir = path.join(root, "docs/specs/tickets/demo");
			const p1 = path.join(setDir, "01-skeleton.md");
			const p2 = path.join(setDir, "02-auth.md");
			const p3 = path.join(setDir, "03-audit.md");
			await writeFile(p1, SAMPLE_T1);
			await writeFile(p2, SAMPLE_T2);
			await writeFile(p3, SAMPLE_T3);

			// Toggle AC #2 and mark 01 done with autoUnblock
			const res = await updateTicket(p1, {
				status: "done",
				setAcChecked: [1, 2],
				appendNote: "Verified with pytest.",
				autoUnblock: true,
			});

			assert.equal(res.ticket.status, "done");
			assert.deepEqual(
				res.ticket.acceptanceCriteria.map((c) => c.checked),
				[true, true],
			);
			assert.deepEqual(
				res.unblocked.map((t) => t.id),
				["02"],
			);

			// Confirm disk persistence for 01, 02 (promoted to ready), and 03 (still blocked by 02)
			const raw1 = await fs.readFile(p1, "utf8");
			assert.match(raw1, /\*\*Status:\*\* done/);
			assert.match(raw1, /- \[x\] Unit test runs cleanly\./);
			assert.match(raw1, /Verified with pytest\./);

			const raw2 = await fs.readFile(p2, "utf8");
			assert.match(raw2, /\*\*Status:\*\* ready/);

			const raw3 = await fs.readFile(p3, "utf8");
			assert.match(raw3, /\*\*Status:\*\* blocked/);
		});
	});

	it("creates a sequentially numbered ticket using the to-tickets template", async () => {
		await withTempDir(async (root) => {
			const setDir = path.join(root, "docs/specs/tickets/demo");
			await writeFile(path.join(setDir, "01-skeleton.md"), SAMPLE_T1);

			const created = await createTicket(setDir, {
				title: "Export metrics endpoint",
				blockedBy: ["01"],
				whatToBuild: "Expose /metrics in Prometheus format.",
				scope: "Metrics route only.",
				acceptanceCriteria: ["GET /metrics returns 200", "Includes request counter"],
				validation: "pytest test_metrics.py",
			});

			assert.equal(created.id, "02");
			assert.equal(path.basename(created.filePath), "02-export-metrics-endpoint.md");
			assert.equal(created.status, "blocked");
			assert.deepEqual(created.blockedBy, ["01"]);
			assert.equal(created.acceptanceCriteria.length, 2);

			const raw = await fs.readFile(created.filePath, "utf8");
			assert.match(raw, /^---\nstatus: blocked\nblocked-by: \["01"\]\n---\n/);
			assert.match(raw, /\*\*Blocked by:\*\* 01/);
			assert.match(raw, /\*\*Status:\*\* blocked/);
		});
	});

	it("writes valid YAML frontmatter on create and updates both frontmatter and body on updateTicket (including auto-unblock)", async () => {
		await withTempDir(async (root) => {
			const setDir = path.join(root, "docs/specs/tickets/demo");

			const t1 = await createTicket(setDir, {
				title: "First slice",
				whatToBuild: "Foundation.",
				acceptanceCriteria: ["Passes check"],
			});
			const t2 = await createTicket(setDir, {
				title: "Second slice",
				blockedBy: ["01"],
				whatToBuild: "Depends on first.",
				acceptanceCriteria: ["Works end-to-end"],
			});

			// Add optional tier-override to t2 frontmatter to ensure updateTicket preserves it
			const t2RawWithTier = (await fs.readFile(t2.filePath, "utf8")).replace(
				'blocked-by: ["01"]\n---',
				'blocked-by: ["01"]\ntier-override: 3\n---',
			);
			await fs.writeFile(t2.filePath, t2RawWithTier, "utf8");

			// Move t1 to in progress -> frontmatter gets `in-progress` for wave-tickets compatibility, body gets `in progress`
			await updateTicket(t1.filePath, { status: "in progress" });
			const t1InProgress = await fs.readFile(t1.filePath, "utf8");
			assert.match(t1InProgress, /^---\nstatus: in-progress\nblocked-by: \[\]\n---/m);
			assert.match(t1InProgress, /\*\*Status:\*\* in progress/);

			// Mark t1 done -> t2 frontmatter & body both auto-unblock to ready, preserving blocked-by and tier-override
			const res = await updateTicket(t1.filePath, {
				status: "done",
				setAcChecked: [1],
				autoUnblock: true,
			});
			assert.equal(res.ticket.status, "done");
			assert.deepEqual(
				res.unblocked.map((t) => t.id),
				["02"],
			);

			const t1Done = await fs.readFile(t1.filePath, "utf8");
			assert.match(t1Done, /^---\nstatus: done\nblocked-by: \[\]\n---/m);
			assert.match(t1Done, /\*\*Status:\*\* done/);

			const t2After = await fs.readFile(t2.filePath, "utf8");
			assert.match(t2After, /^---\nstatus: ready\nblocked-by: \["01"\]\ntier-override: 3\n---/m);
			assert.match(t2After, /\*\*Status:\*\* ready/);
			assert.equal(parseTicketMarkdown(t2After, t2.filePath).tierOverride, 3);
		});
	});

	it("preserves symlinks on ticket files during direct update and auto-unblock", async () => {
		await withTempDir(async (root) => {
			const setDir = path.join(root, "docs/tickets/demo");
			const externalDir = path.join(root, "external");
			const real1 = path.join(externalDir, "01-real.md");
			const real2 = path.join(externalDir, "02-real.md");
			await writeFile(real1, SAMPLE_T1);
			await writeFile(real2, SAMPLE_T2);

			await fs.mkdir(setDir, { recursive: true });
			const link1 = path.join(setDir, "01-skeleton.md");
			const link2 = path.join(setDir, "02-auth.md");
			await fs.symlink(real1, link1);
			await fs.symlink(real2, link2);

			const res = await updateTicket(link1, {
				status: "done",
				setAcChecked: [1, 2],
				appendNote: "Updated through symlink.",
				autoUnblock: true,
			});

			assert.equal(res.ticket.status, "done");
			assert.deepEqual(
				res.unblocked.map((t) => t.id),
				["02"],
			);

			assert.equal((await fs.lstat(link1)).isSymbolicLink(), true);
			assert.equal((await fs.lstat(link2)).isSymbolicLink(), true);

			const real1Content = await fs.readFile(real1, "utf8");
			assert.match(real1Content, /\*\*Status:\*\* done/);
			assert.match(real1Content, /- \[x\] Unit test runs cleanly\./);
			assert.match(real1Content, /Updated through symlink\./);

			const real2Content = await fs.readFile(real2, "utf8");
			assert.match(real2Content, /\*\*Status:\*\* ready/);
		});
	});
});

describe("tools: createTicketTools", () => {
	it("supports list, frontier, get, update (with auto-unblock), and create", async () => {
		await withTempDir(async (root) => {
			await fs.mkdir(path.join(root, ".git"));
			const setDir = path.join(root, "docs/specs/tickets/demo");
			await writeFile(path.join(setDir, "01-skeleton.md"), SAMPLE_T1);
			await writeFile(path.join(setDir, "02-auth.md"), SAMPLE_T2);

			const tools = createTicketTools({ getRootDir: async () => root });
			const byName = new Map(tools.map((t) => [t.name, t]));

			const listOut = await byName.get("tickets_list").handler({});
			assert.match(listOut, /demo/);
			assert.match(listOut, /01/);
			assert.match(listOut, /02/);

			const frontierOut = await byName.get("tickets_frontier").handler({});
			assert.match(frontierOut, /01/);
			assert.doesNotMatch(frontierOut, /Ready frontier:.*02/);

			const getOut = await byName.get("tickets_get").handler({ set: "demo", id: "01" });
			assert.match(getOut, /Walking skeleton/);
			assert.match(getOut, /Unblocks: 02/);

			const updateOut = await byName.get("tickets_update").handler({
				set: "demo",
				id: "01",
				status: "done",
				setAcChecked: [1, 2],
			});
			assert.match(updateOut, /Updated #01/);
			assert.match(updateOut, /Auto-unblocked.*#02/);

			const createOut = await byName.get("tickets_create").handler({
				set: "demo",
				title: "Add dashboards",
				blockedBy: ["02"],
				acceptanceCriteria: ["Dashboard loads"],
			});
			assert.match(createOut, /Created #03/);
		});
	});
});

describe("ui: runTicketsCommand", () => {
	function makeFakeSession(answers, { hasUi = true } = {}) {
		const queue = [...answers];
		const logs = [];
		const sent = [];
		const prompts = [];
		return {
			logs,
			sent,
			prompts,
			session: {
				capabilities: { ui: { elicitation: hasUi } },
				ui: {
					elicitation: async (params) => {
						prompts.push(params);
						return queue.shift() ?? { action: "cancel" };
					},
					input: async (message) => {
						prompts.push({ message, kind: "input" });
						const next = queue.shift();
						return typeof next === "string" ? next : null;
					},
					confirm: async (message) => {
						prompts.push({ message, kind: "confirm" });
						return Boolean(queue.shift());
					},
				},
				log: async (message, options) => {
					logs.push({ message, options });
				},
				send: async (options) => {
					sent.push(options);
				},
			},
		};
	}

	it("lets the user mark a ticket done (auto-unblocking next) and launch /implement on the next ticket", async () => {
		await withTempDir(async (root) => {
			await fs.mkdir(path.join(root, ".git"));
			const setDir = path.join(root, "docs/specs/tickets/demo");
			await writeFile(path.join(setDir, "01-skeleton.md"), SAMPLE_T1);
			await writeFile(path.join(setDir, "02-auth.md"), SAMPLE_T2);

			const harness = makeFakeSession([
				// 1. Ticket list -> pick 01
				{ action: "accept", content: { selection: "ticket:01" } },
				// 2. Ticket 01 actions -> toggle AC
				{ action: "accept", content: { action: "ac" } },
				// 3. AC multi-select -> check both 1 and 2
				{ action: "accept", content: { checked: ["1", "2"] } },
				// 4. Ticket 01 actions -> mark done (auto-unblocks 02!)
				{ action: "accept", content: { action: "status:done" } },
				// 5. Ticket 01 actions -> back to list
				{ action: "accept", content: { action: "back" } },
				// 6. Ticket list -> pick 02 (now ready!)
				{ action: "accept", content: { selection: "ticket:02" } },
				// 7. Ticket 02 actions -> work on ticket
				{ action: "accept", content: { action: "work" } },
			]);

			await runTicketsCommand({ session: harness.session, rootDir: root, args: "" });

			assert.equal(harness.sent.length, 1);
			assert.match(harness.sent[0].prompt, /\/implement/);
			assert.match(harness.sent[0].prompt, /02-auth\.md/);

			const t1 = parseTicketMarkdown(
				await fs.readFile(path.join(setDir, "01-skeleton.md"), "utf8"),
				path.join(setDir, "01-skeleton.md"),
			);
			const t2 = parseTicketMarkdown(
				await fs.readFile(path.join(setDir, "02-auth.md"), "utf8"),
				path.join(setDir, "02-auth.md"),
			);
			assert.equal(t1.status, "done");
			assert.deepEqual(
				t1.acceptanceCriteria.map((c) => c.checked),
				[true, true],
			);
			assert.equal(t2.status, "in progress");
		});
	});

	it("prints dependency graph directly for `/tickets graph` without opening dialogs", async () => {
		await withTempDir(async (root) => {
			await fs.mkdir(path.join(root, ".git"));
			const setDir = path.join(root, "docs/specs/tickets/demo");
			await writeFile(path.join(setDir, "01-skeleton.md"), SAMPLE_T1);
			await writeFile(path.join(setDir, "02-auth.md"), SAMPLE_T2);

			const harness = makeFakeSession([]);
			await runTicketsCommand({ session: harness.session, rootDir: root, args: "graph" });

			assert.equal(harness.prompts.length, 0);
			assert.equal(harness.logs.length, 1);
			assert.match(harness.logs[0].message, /Ready frontier: #01/);
		});
	});

	it("falls back to timeline logging when host does not support elicitation UI", async () => {
		await withTempDir(async (root) => {
			await fs.mkdir(path.join(root, ".git"));
			const setDir = path.join(root, "docs/specs/tickets/demo");
			await writeFile(path.join(setDir, "01-skeleton.md"), SAMPLE_T1);

			const harness = makeFakeSession([], { hasUi: false });
			await runTicketsCommand({ session: harness.session, rootDir: root, args: "" });

			assert.equal(harness.logs.length, 1);
			assert.match(harness.logs[0].message, /Walking skeleton/);
		});
	});
});

