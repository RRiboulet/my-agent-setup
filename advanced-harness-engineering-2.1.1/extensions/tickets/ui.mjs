import path from "node:path";

import {
	analyzeTicketSet,
	createTicket,
	discoverTicketSets,
	loadTicketSet,
	renderDependencyGraph,
	renderProgressBar,
	renderTicketDetail,
	renderTicketRow,
	sortTicketsForDisplay,
	syncStaleBlocked,
	updateTicket,
} from "./store.mjs";

async function pickOne(session, message, fieldName, title, options, defaultValue) {
	const result = await session.ui.elicitation({
		message,
		requestedSchema: {
			type: "object",
			properties: {
				[fieldName]: {
					type: "string",
					title,
					oneOf: options,
					...(defaultValue !== undefined ? { default: defaultValue } : {}),
				},
			},
			required: [fieldName],
		},
	});
	if (result.action !== "accept" || !result.content) return null;
	const value = result.content[fieldName];
	return typeof value === "string" ? value : null;
}

function filterItems(items, query) {
	const q = String(query ?? "").trim().toLowerCase();
	if (!q) return items;
	const tokens = q.split(/\s+/).filter(Boolean);
	return items.filter((item) => {
		const hay = [
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
		return tokens.every((tok) => hay.includes(tok));
	});
}

async function promptCreateTicket(session, setDir, rootDir) {
	const result = await session.ui.elicitation({
		message: `Create a new ticket in ${path.relative(rootDir, setDir) || setDir}`,
		requestedSchema: {
			type: "object",
			properties: {
				title: { type: "string", title: "Title (outcome, not activity)" },
				blockedBy: {
					type: "string",
					title: "Blocked by (comma-separated ticket numbers, or leave blank)",
					default: "",
				},
				whatToBuild: {
					type: "string",
					title: "What to build (short end-to-end description)",
					default: "",
				},
				criteria: {
					type: "string",
					title: "Acceptance criteria (separate multiple items with ';')",
					default: "",
				},
			},
			required: ["title"],
		},
	});
	if (result.action !== "accept" || !result.content?.title) return null;

	const criteria = String(result.content.criteria ?? "")
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean);

	const created = await createTicket(setDir, {
		title: String(result.content.title),
		blockedBy: String(result.content.blockedBy ?? ""),
		whatToBuild: String(result.content.whatToBuild ?? ""),
		acceptanceCriteria: criteria,
	});
	await session.log(
		`Created #${created.id}: ${created.title} (${path.relative(rootDir, created.filePath)})`,
		{ ephemeral: true },
	);
	return created;
}

async function runTicketDetailLoop({ session, rootDir, set, ticketId }) {
	while (true) {
		const tickets = await loadTicketSet(set.dir);
		const analysis = analyzeTicketSet(tickets);
		const item = analysis.byId.get(ticketId);
		if (!item) {
			await session.log(`Ticket #${ticketId} no longer exists in ${set.id}.`, {
				level: "warning",
				ephemeral: true,
			});
			return "back";
		}

		const relPath = path.relative(rootDir, item.filePath);
		const actions = [
			{ const: "work", title: "🚀 Work on ticket (/implement)" },
			{ const: "refine", title: "✏️ Refine / discuss ticket with Copilot" },
			{ const: "view", title: "📄 Print full ticket markdown to timeline" },
		];

		if (item.acTotal > 0) {
			actions.push({
				const: "ac",
				title: `☑ Toggle acceptance criteria (${item.acDone}/${item.acTotal} checked)`,
			});
		}
		if (item.status !== "done") {
			actions.push({ const: "status:done", title: "✓ Mark done (+ auto-unblock dependents)" });
		}
		if (item.status !== "in progress") {
			actions.push({ const: "status:in progress", title: "▶ Mark in progress" });
		}
		if (item.status !== "ready") {
			actions.push({ const: "status:ready", title: "● Mark ready" });
		}
		if (item.status !== "blocked") {
			actions.push({ const: "status:blocked", title: "◌ Mark blocked" });
		}
		actions.push({ const: "note", title: "📝 Append note / amendment" });
		actions.push({ const: "back", title: "← Back to ticket list" });

		const choice = await pickOne(
			session,
			renderTicketDetail(item, relPath),
			"action",
			"Action",
			actions,
			item.status === "done" ? "view" : "work",
		);
		if (!choice || choice === "back") return "back";

		if (choice === "view") {
			await session.log(`${renderTicketDetail(item, relPath)}\n\n${item.raw}`);
			continue;
		}

		if (choice === "work") {
			if (item.status !== "in progress" && item.status !== "done") {
				await updateTicket(item.filePath, { status: "in progress", autoUnblock: false });
			}
			await session.send({
				prompt: `/implement ${relPath}`,
			});
			return "exit";
		}

		if (choice === "refine") {
			await session.send({
				prompt: `Let's refine ticket #${item.id} ("${item.title}") at \`${relPath}\`. Read it in full and highlight any open assumptions, unclear scope, or missing acceptance criteria before proposing edits.`,
			});
			return "exit";
		}

		if (choice === "ac") {
			const acResult = await session.ui.elicitation({
				message: `Acceptance criteria for #${item.id}: ${item.title}`,
				requestedSchema: {
					type: "object",
					properties: {
						checked: {
							type: "array",
							title: "Checked criteria",
							items: {
								type: "string",
								anyOf: item.acceptanceCriteria.map((c) => ({
									const: String(c.index),
									title: `${c.index}. ${c.text}`,
								})),
							},
							default: item.acceptanceCriteria
								.filter((c) => c.checked)
								.map((c) => String(c.index)),
						},
					},
				},
			});
			if (acResult.action === "accept") {
				const selected = Array.isArray(acResult.content?.checked)
					? acResult.content.checked.map(Number)
					: [];
				await updateTicket(item.filePath, { setAcChecked: selected, autoUnblock: false });
				await session.log(
					`Updated acceptance criteria for #${item.id} (${selected.length}/${item.acTotal} checked).`,
					{ ephemeral: true },
				);
			}
			continue;
		}

		if (choice === "note") {
			const note = await session.ui.input(`Append note to #${item.id}: ${item.title}`, {
				title: "Note / amendment",
			});
			if (note && note.trim()) {
				await updateTicket(item.filePath, { appendNote: note.trim(), autoUnblock: false });
				await session.log(`Added note to #${item.id}.`, { ephemeral: true });
			}
			continue;
		}

		if (choice.startsWith("status:")) {
			const nextStatus = choice.slice("status:".length);
			const res = await updateTicket(item.filePath, {
				status: nextStatus,
				autoUnblock: nextStatus === "done",
			});
			const extra =
				res.unblocked.length > 0
					? ` · Auto-unblocked → ready: ${res.unblocked.map((t) => `#${t.id}`).join(", ")}`
					: "";
			await session.log(`#${item.id} → ${res.ticket.status}${extra}`, { ephemeral: true });
		}
	}
}

async function runSetLoop({ session, rootDir, set, multipleSets, initialFilter = "" }) {
	let filter = initialFilter;

	while (true) {
		const tickets = await loadTicketSet(set.dir);
		const analysis = analyzeTicketSet(tickets);
		const sorted = sortTicketsForDisplay(analysis.items);
		const visible = filterItems(sorted, filter);

		const headerLines = [
			`Tickets: ${set.id} (${set.relDir})`,
			`${renderProgressBar(analysis.stats.done, analysis.stats.total)} · ${analysis.stats.inProgress} in progress · ${analysis.stats.frontierCount} frontier · ${analysis.stats.blocked} blocked`,
		];
		if (analysis.stats.staleBlocked > 0) {
			headerLines.push(
				`⚠ ${analysis.stats.staleBlocked} ticket(s) say "blocked" though all blockers are done.`,
			);
		}
		if (analysis.cycles.length > 0) {
			headerLines.push(`⚠ Cycle detected: ${analysis.cycles.map((c) => c.join(" → ")).join("; ")}`);
		}
		if (filter) {
			headerLines.push(`Filter: "${filter}" (${visible.length}/${analysis.items.length} shown)`);
		}

		const options = visible.map((item) => ({
			const: `ticket:${item.id}`,
			title: renderTicketRow(item),
		}));

		if (filter) {
			options.push({ const: "action:clearFilter", title: `✕ Clear filter ("${filter}")` });
		}
		options.push({ const: "action:filter", title: "🔍 Filter / search tickets" });
		options.push({ const: "action:graph", title: "📊 Print dependency graph to timeline" });
		if (analysis.stats.staleBlocked > 0) {
			options.push({
				const: "action:syncStale",
				title: `⚡ Sync ${analysis.stats.staleBlocked} stale-blocked ticket(s) → ready`,
			});
		}
		options.push({ const: "action:create", title: "＋ Create new ticket" });
		if (multipleSets) {
			options.push({ const: "action:switchSet", title: "⇄ Switch ticket set" });
		}
		options.push({ const: "action:close", title: "✕ Close" });

		const choice = await pickOne(
			session,
			headerLines.join("\n"),
			"selection",
			"Select a ticket or action",
			options,
		);
		if (!choice || choice === "action:close") return "exit";
		if (choice === "action:switchSet") return "switch";
		if (choice === "action:clearFilter") {
			filter = "";
			continue;
		}
		if (choice === "action:filter") {
			const next = await session.ui.input("Filter tickets by id, title, status, or text", {
				title: "Search query",
				default: filter,
			});
			if (next !== null) filter = next.trim();
			continue;
		}
		if (choice === "action:graph") {
			await session.log(renderDependencyGraph(analysis, `=== ${set.id} (${set.relDir}) ===`));
			continue;
		}
		if (choice === "action:syncStale") {
			const promoted = await syncStaleBlocked(set.dir);
			await session.log(
				promoted.length > 0
					? `Promoted to ready: ${promoted.map((t) => `#${t.id} ${t.title}`).join(", ")}`
					: "No stale-blocked tickets needed syncing.",
				{ ephemeral: true },
			);
			continue;
		}
		if (choice === "action:create") {
			const created = await promptCreateTicket(session, set.dir, rootDir);
			if (created) {
				const outcome = await runTicketDetailLoop({
					session,
					rootDir,
					set,
					ticketId: created.id,
				});
				if (outcome === "exit") return "exit";
			}
			continue;
		}
		if (choice.startsWith("ticket:")) {
			const ticketId = choice.slice("ticket:".length);
			const outcome = await runTicketDetailLoop({ session, rootDir, set, ticketId });
			if (outcome === "exit") return "exit";
		}
	}
}

async function runCrossSetPicker({ session, rootDir, sets, mode, query }) {
	const matches = [];
	for (const set of sets) {
		const tickets = await loadTicketSet(set.dir);
		const analysis = analyzeTicketSet(tickets);
		const pool = mode === "frontier" ? analysis.frontier : filterItems(analysis.items, query);
		for (const item of sortTicketsForDisplay(pool)) {
			matches.push({ set, item });
		}
	}

	if (matches.length === 0) {
		await session.log(
			mode === "frontier"
				? "No ready frontier tickets found."
				: `No tickets matched "${query}".`,
			{ ephemeral: true },
		);
		return;
	}

	const options = matches.map((m, idx) => ({
		const: `m:${idx}`,
		title: `[${m.set.id}] ${renderTicketRow(m.item)}`,
	}));
	options.push({ const: "close", title: "✕ Close" });

	const heading =
		mode === "frontier"
			? `Ready frontier (${matches.length} ticket(s) across ${sets.length} set(s))`
			: `Search results for "${query}" (${matches.length} match(es))`;

	const choice = await pickOne(session, heading, "selection", "Select a ticket", options);
	if (!choice || choice === "close") return;
	const chosen = matches[Number(choice.slice(2))];
	if (!chosen) return;
	await runTicketDetailLoop({ session, rootDir, set: chosen.set, ticketId: chosen.item.id });
}

export async function runTicketsCommand({ session, rootDir, args = "", state = {} }) {
	const rawArgs = String(args ?? "").trim();
	const parts = rawArgs ? rawArgs.split(/\s+/) : [];
	const sub = (parts[0] ?? "").toLowerCase();
	const rest = parts.slice(1).join(" ").trim();

	let includeWorktrees = Boolean(state.includeWorktrees);
	const discovery = await discoverTicketSets(rootDir, { includeWorktrees });

	if (discovery.sets.length === 0) {
		await session.log(
			`No to-tickets files found under ${rootDir}.\nRun /to-tickets to generate a ticket set first.`,
			{ ephemeral: true },
		);
		return;
	}

	// Non-interactive fallback OR explicit `/tickets graph`
	if (sub === "graph" || !session.capabilities?.ui?.elicitation) {
		const targetSets =
			sub === "graph" && rest
				? discovery.sets.filter(
						(s) =>
							s.id.toLowerCase().includes(rest.toLowerCase()) ||
							s.slug.toLowerCase().includes(rest.toLowerCase()),
					)
				: discovery.sets;
		const setsToLog = targetSets.length > 0 ? targetSets : discovery.sets;
		const output = [];
		for (const set of setsToLog) {
			const tickets = await loadTicketSet(set.dir);
			const analysis = analyzeTicketSet(tickets);
			output.push(renderDependencyGraph(analysis, `=== ${set.id} (${set.relDir}) ===`));
		}
		if (discovery.hiddenWorktreeCount > 0) {
			output.push(
				`(${discovery.hiddenWorktreeCount} secondary git worktree ticket set(s) hidden)`,
			);
		}
		await session.log(output.join("\n\n"));
		return;
	}

	if (sub === "frontier") {
		await runCrossSetPicker({
			session,
			rootDir,
			sets: discovery.sets,
			mode: "frontier",
			query: "",
		});
		return;
	}

	if (rawArgs) {
		// Direct match on a set slug opens that set; otherwise run cross-set search
		const exactSet = discovery.sets.find(
			(s) =>
				s.id.toLowerCase() === rawArgs.toLowerCase() ||
				s.slug.toLowerCase() === rawArgs.toLowerCase(),
		);
		if (exactSet) {
			state.lastSetId = exactSet.id;
			await runSetLoop({
				session,
				rootDir,
				set: exactSet,
				multipleSets: discovery.sets.length > 1,
			});
			return;
		}
		await runCrossSetPicker({
			session,
			rootDir,
			sets: discovery.sets,
			mode: "search",
			query: rawArgs,
		});
		return;
	}

	// Main interactive loop: single set jumps straight in; multiple sets show the set picker
	while (true) {
		const currentDiscovery = await discoverTicketSets(rootDir, { includeWorktrees });
		const sets = currentDiscovery.sets;

		if (sets.length === 1 && currentDiscovery.hiddenWorktreeCount === 0) {
			await runSetLoop({ session, rootDir, set: sets[0], multipleSets: false });
			return;
		}

		const options = [];
		let totalTickets = 0;
		let totalDone = 0;
		let totalFrontier = 0;

		for (const set of sets) {
			const tickets = await loadTicketSet(set.dir);
			const analysis = analyzeTicketSet(tickets);
			totalTickets += analysis.stats.total;
			totalDone += analysis.stats.done;
			totalFrontier += analysis.stats.frontierCount;
			const wtTag = set.isWorktree ? " [worktree]" : "";
			const staleTag =
				analysis.stats.staleBlocked > 0 ? ` · ⚠${analysis.stats.staleBlocked}` : "";
			options.push({
				const: `set:${set.id}`,
				title: `${set.id}${wtTag}  ${renderProgressBar(analysis.stats.done, analysis.stats.total, 8)} · ${analysis.stats.frontierCount} ready${staleTag}`,
			});
		}

		if (totalFrontier > 0) {
			options.push({
				const: "action:frontier",
				title: `● View ready frontier across all sets (${totalFrontier})`,
			});
		}
		options.push({ const: "action:search", title: "🔍 Search across all tickets" });
		if (currentDiscovery.hiddenWorktreeCount > 0 || includeWorktrees) {
			options.push({
				const: "action:toggleWorktrees",
				title: includeWorktrees
					? "🗂 Hide secondary git worktrees"
					: `🗂 Show ${currentDiscovery.hiddenWorktreeCount} hidden worktree set(s)`,
			});
		}
		options.push({ const: "action:close", title: "✕ Close" });

		const defaultChoice =
			state.lastSetId && sets.some((s) => s.id === state.lastSetId)
				? `set:${state.lastSetId}`
				: options[0]?.const;

		const choice = await pickOne(
			session,
			`Ticket sets under ${rootDir}\nOverall: ${renderProgressBar(totalDone, totalTickets)} · ${totalFrontier} ready frontier`,
			"set",
			"Choose a ticket set",
			options,
			defaultChoice,
		);
		if (!choice || choice === "action:close") return;

		if (choice === "action:toggleWorktrees") {
			includeWorktrees = !includeWorktrees;
			state.includeWorktrees = includeWorktrees;
			continue;
		}
		if (choice === "action:frontier") {
			await runCrossSetPicker({ session, rootDir, sets, mode: "frontier", query: "" });
			continue;
		}
		if (choice === "action:search") {
			const q = await session.ui.input("Search all tickets by id, title, status, or text", {
				title: "Search query",
			});
			if (q && q.trim()) {
				await runCrossSetPicker({ session, rootDir, sets, mode: "search", query: q.trim() });
			}
			continue;
		}
		if (choice.startsWith("set:")) {
			const setId = choice.slice("set:".length);
			const chosen = sets.find((s) => s.id === setId);
			if (!chosen) continue;
			state.lastSetId = chosen.id;
			const outcome = await runSetLoop({
				session,
				rootDir,
				set: chosen,
				multipleSets: true,
			});
			if (outcome === "exit") return;
		}
	}
}
