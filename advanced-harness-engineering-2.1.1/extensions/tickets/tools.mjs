import fs from "node:fs/promises";
import path from "node:path";

import {
	VALID_STATUSES,
	analyzeTicketSet,
	createTicket,
	discoverTicketSets,
	loadTicketSet,
	normalizeStatus,
	renderDependencyGraph,
	renderProgressBar,
	renderTicketDetail,
	renderTicketRow,
	sortTicketsForDisplay,
	updateTicket,
} from "./store.mjs";

function fail(message) {
	return { textResultForLlm: message, resultType: "failure" };
}

function matchSet(sets, setQuery) {
	if (!setQuery) return sets;
	const q = String(setQuery).trim().toLowerCase();
	const exact = sets.filter(
		(s) =>
			s.id.toLowerCase() === q ||
			s.slug.toLowerCase() === q ||
			s.relDir.toLowerCase() === q ||
			s.dir.toLowerCase() === q,
	);
	if (exact.length > 0) return exact;
	return sets.filter(
		(s) =>
			s.id.toLowerCase().includes(q) ||
			s.slug.toLowerCase().includes(q) ||
			s.relDir.toLowerCase().includes(q),
	);
}

function normalizeIdQuery(id) {
	const digits = String(id ?? "")
		.replace(/^#/, "")
		.trim();
	return /^\d+$/.test(digits) && digits.length === 1 ? digits.padStart(2, "0") : digits;
}

async function resolveTicketTarget(rootDir, { path: filePathArg, set: setArg, id: idArg, includeWorktrees = false }) {
	if (filePathArg) {
		const resolved = path.isAbsolute(filePathArg)
			? filePathArg
			: path.resolve(rootDir, filePathArg);
		try {
			await fs.access(resolved);
		} catch {
			return { error: `Ticket file not found: ${filePathArg}` };
		}
		const setDir = path.dirname(resolved);
		const tickets = await loadTicketSet(setDir);
		const analysis = analyzeTicketSet(tickets);
		const item = analysis.items.find((t) => path.resolve(t.filePath) === resolved);
		if (!item) {
			return { error: `File is not a numbered ticket markdown file: ${filePathArg}` };
		}
		return {
			item,
			analysis,
			set: { id: path.basename(setDir), dir: setDir, relDir: path.relative(rootDir, setDir) },
		};
	}

	if (!idArg) {
		return { error: "Provide either 'path' or 'id' (and optionally 'set')." };
	}

	const wantedId = normalizeIdQuery(idArg);
	const discovery = await discoverTicketSets(rootDir, { includeWorktrees });
	const candidateSets = matchSet(discovery.sets, setArg);
	if (candidateSets.length === 0) {
		return {
			error: setArg
				? `No ticket set matched "${setArg}".`
				: `No ticket sets found under ${rootDir}.`,
		};
	}

	const matches = [];
	for (const set of candidateSets) {
		const tickets = await loadTicketSet(set.dir);
		const analysis = analyzeTicketSet(tickets);
		const item = analysis.byId.get(wantedId);
		if (item) {
			matches.push({ item, analysis, set });
		}
	}

	if (matches.length === 0) {
		return {
			error: `Ticket #${wantedId} not found${setArg ? ` in set "${setArg}"` : ""}.`,
		};
	}
	if (matches.length > 1) {
		const list = matches.map((m) => `${m.set.id} (${path.relative(rootDir, m.item.filePath)})`).join(", ");
		return {
			error: `Ticket #${wantedId} matches multiple sets: ${list}. Pass 'set' or 'path' to disambiguate.`,
		};
	}
	return matches[0];
}

function matchesTextQuery(item, query) {
	if (!query) return true;
	const tokens = String(query)
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	if (tokens.length === 0) return true;
	const haystack = [
		item.id,
		`#${item.id}`,
		item.title,
		item.status,
		item.effectiveState,
		item.repo,
		item.sections.whatToBuild,
		item.sections.scope,
	]
		.join(" ")
		.toLowerCase();
	return tokens.every((tok) => haystack.includes(tok));
}

export function createTicketTools({ getRootDir }) {
	return [
		{
			name: "tickets_list",
			description:
				"List to-tickets markdown ticket sets and tickets with status, dependency frontier state, blockers, and acceptance-criteria progress.",
			parameters: {
				type: "object",
				properties: {
					set: {
						type: "string",
						description: "Optional ticket set slug, project/slug, or relative path filter.",
					},
					status: {
						type: "string",
						description:
							"Optional status filter: ready, in progress, blocked, done, stale-blocked, or frontier.",
					},
					query: {
						type: "string",
						description: "Optional search terms matched against ticket id, title, status, and body.",
					},
					includeWorktrees: {
						type: "boolean",
						description: "Include secondary git worktree copies when scanning a multi-repo workspace root (default false).",
					},
				},
			},
			handler: async (args = {}) => {
				const rootDir = await getRootDir();
				const discovery = await discoverTicketSets(rootDir, {
					includeWorktrees: Boolean(args.includeWorktrees),
				});
				const sets = matchSet(discovery.sets, args.set);
				if (sets.length === 0) {
					return args.set
						? `No ticket sets matched "${args.set}" under ${rootDir}.`
						: `No to-tickets sets found under ${rootDir}.`;
				}

				const statusFilter = args.status ? String(args.status).trim().toLowerCase() : "";
				const sections = [];
				for (const set of sets) {
					const tickets = await loadTicketSet(set.dir);
					const analysis = analyzeTicketSet(tickets);
					const filtered = sortTicketsForDisplay(analysis.items).filter((item) => {
						if (statusFilter === "frontier" && !item.isFrontier) return false;
						if (
							statusFilter &&
							statusFilter !== "frontier" &&
							item.status !== normalizeStatus(statusFilter) &&
							item.effectiveState !== statusFilter
						) {
							return false;
						}
						return matchesTextQuery(item, args.query);
					});

					const header = `## ${set.id} (${set.relDir}) — ${renderProgressBar(analysis.stats.done, analysis.stats.total)} · ${analysis.stats.frontierCount} frontier`;
					if (filtered.length === 0) {
						if (!statusFilter && !args.query) {
							sections.push(`${header}\n  (no tickets)`);
						}
						continue;
					}
					const rows = filtered.map(
						(item) =>
							`  ${renderTicketRow(item)}\n    path: ${path.relative(rootDir, item.filePath)}`,
					);
					sections.push(`${header}\n${rows.join("\n")}`);
				}

				if (sections.length === 0) {
					return "No tickets matched the given filters.";
				}
				if (discovery.hiddenWorktreeCount > 0) {
					sections.push(
						`(${discovery.hiddenWorktreeCount} secondary git worktree ticket set(s) hidden; pass includeWorktrees: true to include them.)`,
					);
				}
				return sections.join("\n\n");
			},
		},
		{
			name: "tickets_get",
			description:
				"Read full details, markdown body, blocker status, downstream dependents, and acceptance criteria for a single to-tickets ticket.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative or absolute path to the ticket markdown file.",
					},
					set: {
						type: "string",
						description: "Ticket set slug or project/slug (optional if id is unambiguous).",
					},
					id: {
						type: "string",
						description: "Ticket number (e.g. '01', '3', or '#03').",
					},
					includeWorktrees: {
						type: "boolean",
						description: "Include secondary git worktrees when searching by set/id.",
					},
				},
			},
			handler: async (args = {}) => {
				const rootDir = await getRootDir();
				const resolved = await resolveTicketTarget(rootDir, args);
				if (resolved.error) return fail(resolved.error);
				const relPath = path.relative(rootDir, resolved.item.filePath);
				return `${renderTicketDetail(resolved.item, relPath)}\n\n--- Full markdown ---\n${resolved.item.raw}`;
			},
		},
		{
			name: "tickets_frontier",
			description:
				"Compute the current dependency graph and ready frontier (tickets whose blockers are all done) for one or all to-tickets sets.",
			parameters: {
				type: "object",
				properties: {
					set: {
						type: "string",
						description: "Optional ticket set slug or project/slug.",
					},
					includeWorktrees: {
						type: "boolean",
						description: "Include secondary git worktrees (default false).",
					},
				},
			},
			handler: async (args = {}) => {
				const rootDir = await getRootDir();
				const discovery = await discoverTicketSets(rootDir, {
					includeWorktrees: Boolean(args.includeWorktrees),
				});
				const sets = matchSet(discovery.sets, args.set);
				if (sets.length === 0) {
					return args.set
						? `No ticket sets matched "${args.set}".`
						: `No to-tickets sets found under ${rootDir}.`;
				}

				const parts = [];
				for (const set of sets) {
					const tickets = await loadTicketSet(set.dir);
					const analysis = analyzeTicketSet(tickets);
					parts.push(renderDependencyGraph(analysis, `=== ${set.id} (${set.relDir}) ===`));
				}
				return parts.join("\n\n");
			},
		},
		{
			name: "tickets_update",
			description:
				"Update a to-tickets ticket's status, acceptance criteria checkboxes, or notes in place. When marked done, automatically promotes newly unblocked dependent tickets from blocked to ready.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Relative or absolute path to the ticket file." },
					set: { type: "string", description: "Ticket set slug or project/slug." },
					id: { type: "string", description: "Ticket number (e.g. '01')." },
					status: {
						type: "string",
						enum: VALID_STATUSES,
						description: "New status: ready, in progress, blocked, or done.",
					},
					toggleAcIndices: {
						type: "array",
						items: { type: "integer" },
						description: "1-based indices of acceptance criteria checkboxes to toggle.",
					},
					setAcChecked: {
						type: "array",
						items: { type: "integer" },
						description: "Complete list of 1-based acceptance criteria indices that should be checked.",
					},
					appendNote: {
						type: "string",
						description: "Optional note or amendment to append under ## Notes.",
					},
					autoUnblock: {
						type: "boolean",
						description: "When marking done, auto-promote newly unblocked dependents from blocked to ready (default true).",
					},
				},
			},
			handler: async (args = {}) => {
				const rootDir = await getRootDir();
				const resolved = await resolveTicketTarget(rootDir, args);
				if (resolved.error) return fail(resolved.error);

				const result = await updateTicket(resolved.item.filePath, {
					status: args.status,
					toggleAcIndices: args.toggleAcIndices,
					setAcChecked: args.setAcChecked,
					appendNote: args.appendNote,
					autoUnblock: args.autoUnblock !== false,
				});

				const relPath = path.relative(rootDir, result.ticket.filePath);
				const acDone = result.ticket.acceptanceCriteria.filter((c) => c.checked).length;
				const acTotal = result.ticket.acceptanceCriteria.length;
				const lines = [
					`Updated #${result.ticket.id}: ${result.ticket.title} (${relPath})`,
					`Status: ${result.ticket.status}${acTotal > 0 ? ` · AC: ${acDone}/${acTotal}` : ""}`,
				];
				if (result.unblocked.length > 0) {
					lines.push(
						`Auto-unblocked (blocked → ready): ${result.unblocked.map((t) => `#${t.id} ${t.title}`).join(", ")}`,
					);
				}
				return lines.join("\n");
			},
		},
		{
			name: "tickets_create",
			description:
				"Create a new sequentially numbered ticket in a to-tickets folder using the standard ticket template.",
			parameters: {
				type: "object",
				properties: {
					set: {
						type: "string",
						description:
							"Existing ticket set slug/id/path, or a new feature slug (created under docs/tickets/<slug>).",
					},
					title: { type: "string", description: "Outcome-focused ticket title." },
					blockedBy: {
						type: "array",
						items: { type: "string" },
						description: "Ticket IDs that block this ticket (e.g. ['01', '02']).",
					},
					status: {
						type: "string",
						enum: VALID_STATUSES,
						description: "Optional explicit status (defaults to blocked if open blockers exist, else ready).",
					},
					repo: { type: "string", description: "Optional Repo field value." },
					spec: { type: "string", description: "Optional relative path to the owning spec." },
					whatToBuild: { type: "string", description: "End-to-end behavior to build." },
					scope: { type: "string", description: "Components touched and what is out of scope." },
					acceptanceCriteria: {
						type: "array",
						items: { type: "string" },
						description: "Observable, checkable acceptance criteria items.",
					},
					validation: { type: "string", description: "Test or check that proves the ticket." },
				},
				required: ["set", "title"],
			},
			handler: async (args = {}) => {
				const rootDir = await getRootDir();
				if (!args.set || !args.title) {
					return fail("Both 'set' and 'title' are required.");
				}
				const discovery = await discoverTicketSets(rootDir, { includeWorktrees: false });
				const matched = matchSet(discovery.sets, args.set);
				let targetDir;
				if (matched.length === 1) {
					targetDir = matched[0].dir;
				} else if (matched.length > 1) {
					return fail(
						`Multiple ticket sets matched "${args.set}": ${matched.map((s) => s.id).join(", ")}. Pass a more specific set id or path.`,
					);
				} else if (args.set.includes("/") || args.set.includes(path.sep)) {
					targetDir = path.isAbsolute(args.set) ? args.set : path.resolve(rootDir, args.set);
				} else {
					targetDir = path.join(rootDir, "docs", "tickets", args.set);
				}

				const created = await createTicket(targetDir, args);
				const relPath = path.relative(rootDir, created.filePath);
				return `Created #${created.id}: ${created.title}\nPath: ${relPath}\nStatus: ${created.status}\nBlocked by: ${created.blockedBy.join(", ") || "None"}`;
			},
		},
	];
}
