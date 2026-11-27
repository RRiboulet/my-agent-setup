import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const VALID_STATUSES = ["ready", "in progress", "blocked", "done"];

const TICKET_FILE_RE = /^(\d+)-(.+)\.md$/i;
const HEADING_RE = /^#\s+(?:(\d+)\s*[:.\-–—]\s*)?(.+?)\s*$/;
const FIELD_RE = /^\*\*([^*:]+):\*\*\s*(.*?)\s*$/;
const SPEC_LINE_RE = /^(?:\*\*Spec:\*\*|Spec:)\s*(.*?)\s*$/i;
const AC_LINE_RE = /^(\s*[-*]\s+)\[([ xX])\](\s+.*)$/;
const SECTION_RE = /^##\s+(.+?)\s*$/;

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	"dist",
	"build",
	"target",
	".cache",
	".pytest_cache",
	"htmlcov",
]);

function normalizeTicketId(raw) {
	const digits = String(raw).replace(/^#/, "").trim();
	if (!/^\d+$/.test(digits)) return null;
	return digits.length === 1 ? digits.padStart(2, "0") : digits;
}

export function normalizeStatus(raw) {
	const cleaned = String(raw ?? "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ");
	if (cleaned === "in-progress" || cleaned === "in_progress") return "in progress";
	if (cleaned === "closed" || cleaned === "completed" || cleaned === "complete") return "done";
	if (cleaned === "open" || cleaned === "todo") return "ready";
	return cleaned || "ready";
}

function parseBlockedBy(raw) {
	const trimmed = String(raw ?? "").trim();
	if (!trimmed || /^(none|n\/a|-|—|nothing)\b/i.test(trimmed)) {
		return { ids: [], externalText: "" };
	}
	const ids = [];
	const seen = new Set();
	// Strip parenthetical annotations such as "02 (schema)" or "01 (done)" before scanning
	const withoutParens = trimmed.replace(/\([^)]*\)/g, " ");
	const tokenRe = /(?:^|[\s,;]|#|\band\s+)(\d{1,4})(?=$|[\s,;:–—-])/gi;
	for (const match of withoutParens.matchAll(tokenRe)) {
		const id = normalizeTicketId(match[1]);
		if (id && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}
	// Check whether meaningful prose remains beyond ticket IDs and conjunctions
	const residual = withoutParens
		.replace(/#?\b\d{1,4}\b/g, " ")
		.replace(/\b(and|or|tickets?)\b/gi, " ")
		.replace(/[,;:+–—\-.\s]+/g, " ")
		.trim();
	const externalText = residual.length > 0 ? trimmed : "";
	return { ids, externalText };
}

function stripBackticks(value) {
	const s = String(value ?? "").trim();
	if (s.startsWith("`") && s.endsWith("`") && s.length >= 2) {
		return s.slice(1, -1).trim();
	}
	return s;
}

function toFrontmatterStatus(canonicalStatus) {
	return canonicalStatus === "in progress" ? "in-progress" : canonicalStatus;
}

function findFrontmatter(lines) {
	const first = (lines[0] ?? "").replace(/^\uFEFF/, "").trim();
	if (first !== "---") return null;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i].trim() === "---") {
			return { start: 0, end: i };
		}
	}
	return null;
}

function unquoteYaml(value) {
	const trimmed = String(value ?? "").trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if (first === '"' && last === '"') {
			return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
		if (first === "'" && last === "'") {
			return trimmed.slice(1, -1).replace(/''/g, "'");
		}
	}
	return trimmed;
}

function splitYamlFlowSequence(inner) {
	const items = [];
	let current = "";
	let quote = null;
	for (const ch of inner) {
		if (quote !== null) {
			if (ch === quote) quote = null;
			current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
		} else if (ch === ",") {
			items.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	items.push(current);
	return items.map((item) => unquoteYaml(item)).filter((item) => item.length > 0);
}

function parseFrontmatter(lines) {
	const bounds = findFrontmatter(lines);
	if (!bounds) {
		return {
			present: false,
			start: -1,
			end: -1,
			bodyStartIndex: 0,
			hasStatus: false,
			status: undefined,
			statusLineIndex: -1,
			hasBlockedBy: false,
			blockedBy: [],
			tierOverride: undefined,
		};
	}

	let hasStatus = false;
	let status;
	let statusLineIndex = -1;
	let hasBlockedBy = false;
	const blockedBy = [];
	const seenBlockers = new Set();
	let tierOverride;

	const addBlocker = (rawItem) => {
		const id = normalizeTicketId(unquoteYaml(rawItem));
		if (id && !seenBlockers.has(id)) {
			seenBlockers.add(id);
			blockedBy.push(id);
		}
	};

	for (let i = bounds.start + 1; i < bounds.end; i += 1) {
		const raw = lines[i];
		const trimmed = raw.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;

		const match = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(raw);
		if (!match) continue;

		const key = match[1].toLowerCase();
		const value = match[2].trim();

		if (key === "status") {
			const parsedStatus = unquoteYaml(value);
			if (parsedStatus.length > 0) {
				hasStatus = true;
				status = normalizeStatus(parsedStatus);
				statusLineIndex = i;
			}
		} else if (key === "blocked-by") {
			hasBlockedBy = true;
			if (value === "") {
				while (i + 1 < bounds.end) {
					const next = lines[i + 1].trim();
					if (!next.startsWith("-")) break;
					i += 1;
					addBlocker(next.slice(1).trim());
				}
			} else if (value.startsWith("[") && value.endsWith("]")) {
				for (const item of splitYamlFlowSequence(value.slice(1, -1))) {
					addBlocker(item);
				}
			} else {
				const parsed = parseBlockedBy(unquoteYaml(value));
				for (const id of parsed.ids) {
					if (!seenBlockers.has(id)) {
						seenBlockers.add(id);
						blockedBy.push(id);
					}
				}
			}
		} else if (key === "tier-override") {
			const parsed = unquoteYaml(value);
			if (/^\d+$/.test(parsed)) {
				tierOverride = Number.parseInt(parsed, 10);
			}
		}
	}

	return {
		present: true,
		start: bounds.start,
		end: bounds.end,
		bodyStartIndex: bounds.end + 1,
		hasStatus,
		status,
		statusLineIndex,
		hasBlockedBy,
		blockedBy,
		tierOverride,
	};
}

export function parseTicketMarkdown(content, filePath) {
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.split(/\r?\n/);
	const fm = parseFrontmatter(lines);
	const fileName = path.basename(filePath);
	const fileMatch = fileName.match(TICKET_FILE_RE);
	const fileId = fileMatch ? normalizeTicketId(fileMatch[1]) : null;

	let id = fileId ?? fileName.replace(/\.md$/i, "");
	let title = fileMatch ? fileMatch[2].replace(/-/g, " ") : fileName;
	let status = fm.hasStatus ? fm.status : "ready";
	let statusLineIndex = fm.statusLineIndex;
	let blockedBy = fm.hasBlockedBy ? [...fm.blockedBy] : [];
	let blockedByRaw = fm.hasBlockedBy ? (fm.blockedBy.length > 0 ? fm.blockedBy.join(", ") : "None") : "None";
	let externalBlockerLines = [];
	let readingBlockedByContinuation = false;
	let repo = "";
	let spec = "";

	const sectionBuffers = new Map();
	let currentSection = null;
	const acceptanceCriteria = [];

	for (let i = fm.bodyStartIndex; i < lines.length; i += 1) {
		const line = lines[i];

		if (currentSection === null) {
			const h = line.match(HEADING_RE);
			if (h) {
				if (h[1]) id = normalizeTicketId(h[1]) ?? id;
				title = h[2].trim();
				readingBlockedByContinuation = false;
				continue;
			}
			const field = line.match(FIELD_RE);
			if (field) {
				readingBlockedByContinuation = false;
				const key = field[1].trim().toLowerCase();
				const val = field[2].trim();
				if (key === "status") {
					if (!fm.hasStatus) {
						status = normalizeStatus(val);
					}
					statusLineIndex = i;
				} else if (key === "blocked by") {
					const parsedBlockers = parseBlockedBy(val);
					if (!fm.hasBlockedBy) {
						blockedByRaw = val;
						blockedBy = parsedBlockers.ids;
					}
					if (parsedBlockers.externalText) {
						externalBlockerLines.push(parsedBlockers.externalText);
					}
					readingBlockedByContinuation = true;
				} else if (key === "repo") {
					repo = val;
				} else if (key === "spec") {
					spec = stripBackticks(val);
				}
				continue;
			}
			const specMatch = line.match(SPEC_LINE_RE);
			if (specMatch && !spec) {
				readingBlockedByContinuation = false;
				spec = stripBackticks(specMatch[1]);
				continue;
			}
			if (readingBlockedByContinuation && !SECTION_RE.test(line)) {
				if (line.trim()) {
					externalBlockerLines.push(line);
				}
				continue;
			}
		}

		const sec = line.match(SECTION_RE);
		if (sec) {
			currentSection = sec[1].trim().toLowerCase();
			if (!sectionBuffers.has(currentSection)) {
				sectionBuffers.set(currentSection, []);
			}
			continue;
		}

		if (currentSection !== null) {
			sectionBuffers.get(currentSection).push(line);
			if (currentSection === "acceptance criteria") {
				const acMatch = line.match(AC_LINE_RE);
				if (acMatch) {
					acceptanceCriteria.push({
						index: acceptanceCriteria.length + 1,
						lineIndex: i,
						checked: acMatch[2].toLowerCase() === "x",
						text: acMatch[3].trim(),
					});
				}
			}
		}
	}

	const readSection = (...names) => {
		for (const name of names) {
			const buf = sectionBuffers.get(name);
			if (buf) return buf.join("\n").trim();
		}
		return "";
	};

	const externalBlockers = externalBlockerLines.join("\n").trim();
	const hasExternalBlockers = externalBlockers.length > 0;

	return {
		id,
		fileName,
		filePath,
		title,
		status,
		statusLineIndex,
		blockedBy,
		blockedByRaw,
		...(fm.tierOverride !== undefined ? { tierOverride: fm.tierOverride } : {}),
		hasExternalBlockers,
		externalBlockers,
		repo,
		spec,
		eol,
		sections: {
			whatToBuild: readSection("what to build", "summary", "description"),
			scope: readSection("scope"),
			acceptanceCriteria: readSection("acceptance criteria"),
			validation: readSection("validation"),
			notes: readSection("notes", "amendments"),
		},
		acceptanceCriteria,
		raw: content,
	};
}

async function pathExists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function isSecondaryGitWorktree(dirPath) {
	const gitPath = path.join(dirPath, ".git");
	try {
		const stat = await fs.lstat(gitPath);
		if (!stat.isFile()) return false;
		const content = await fs.readFile(gitPath, "utf8");
		return /^gitdir:\s*.*\/worktrees\//m.test(content);
	} catch {
		return false;
	}
}

async function isGitRepoRoot(dirPath) {
	return pathExists(path.join(dirPath, ".git"));
}

async function isDirectoryEntry(parentDir, entry) {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return (await fs.stat(path.join(parentDir, entry.name))).isDirectory();
	} catch {
		return false;
	}
}

async function isFileEntry(parentDir, entry) {
	if (entry.isFile()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return (await fs.stat(path.join(parentDir, entry.name))).isFile();
	} catch {
		return false;
	}
}

async function hasTicketFiles(dirPath) {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		for (const e of entries) {
			if (TICKET_FILE_RE.test(e.name) && (await isFileEntry(dirPath, e))) {
				return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

async function resolveRealpath(dirPath) {
	try {
		return await fs.realpath(dirPath);
	} catch {
		return path.resolve(dirPath);
	}
}

async function findTicketSetsInProject(projectRoot, projectName, isWorktree, seenRealpaths = new Set()) {
	const sets = [];
	const candidateBases = [
		path.join(projectRoot, "docs", "specs", "tickets"),
		path.join(projectRoot, "docs", "tickets"),
	];

	for (const base of candidateBases) {
		if (!(await pathExists(base))) continue;

		// Case 1: tickets placed directly in base (unusual, but handle gracefully)
		if (await hasTicketFiles(base)) {
			const canonical = await resolveRealpath(base);
			if (!seenRealpaths.has(canonical)) {
				seenRealpaths.add(canonical);
				sets.push({
					id: `${projectName}/${path.basename(base)}`,
					project: projectName,
					slug: path.basename(base),
					dir: base,
					relDir: path.relative(projectRoot, base) || ".",
					isWorktree,
				});
			}
		}

		// Case 2: standard <base>/<slug>/NN-*.md
		let entries = [];
		try {
			entries = await fs.readdir(base, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || !(await isDirectoryEntry(base, entry))) continue;
			const setDir = path.join(base, entry.name);
			if (await hasTicketFiles(setDir)) {
				const canonical = await resolveRealpath(setDir);
				if (seenRealpaths.has(canonical)) continue;
				seenRealpaths.add(canonical);
				sets.push({
					id: projectName ? `${projectName}/${entry.name}` : entry.name,
					project: projectName,
					slug: entry.name,
					dir: setDir,
					relDir: path.relative(projectRoot, setDir),
					isWorktree,
				});
			}
		}
	}

	return sets;
}

export async function discoverTicketSets(rootDir, { includeWorktrees = false } = {}) {
	const resolvedRoot = path.resolve(rootDir);
	const sets = [];
	const seenRealpaths = new Set();
	let hiddenWorktreeCount = 0;

	const rootHasTickets = await findTicketSetsInProject(resolvedRoot, "", false, seenRealpaths);
	sets.push(...rootHasTickets);

	const rootIsGit = await isGitRepoRoot(resolvedRoot);
	// Scan immediate child directories if we're in a multi-repo workspace root or found no root sets
	if (!rootIsGit || sets.length === 0) {
		let children = [];
		try {
			children = await fs.readdir(resolvedRoot, { withFileTypes: true });
		} catch {
			children = [];
		}

		for (const entry of children) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
				continue;
			}
			const childDir = path.join(resolvedRoot, entry.name);
			const worktree = await isSecondaryGitWorktree(childDir);
			const childSeen = worktree && !includeWorktrees ? new Set() : seenRealpaths;
			const childSets = await findTicketSetsInProject(childDir, entry.name, worktree, childSeen);
			if (childSets.length === 0) continue;

			if (worktree && !includeWorktrees) {
				hiddenWorktreeCount += childSets.length;
				continue;
			}
			for (const s of childSets) {
				s.relDir = path.relative(resolvedRoot, s.dir);
				sets.push(s);
			}
		}
	}

	sets.sort((a, b) => a.id.localeCompare(b.id));
	return { rootDir: resolvedRoot, sets, hiddenWorktreeCount };
}

export async function loadTicketSet(setDir) {
	const entries = await fs.readdir(setDir, { withFileTypes: true });
	const ticketFiles = [];
	for (const e of entries) {
		if (TICKET_FILE_RE.test(e.name) && (await isFileEntry(setDir, e))) {
			ticketFiles.push(e.name);
		}
	}
	ticketFiles.sort((a, b) => {
		const na = Number(a.match(TICKET_FILE_RE)?.[1] ?? 0);
		const nb = Number(b.match(TICKET_FILE_RE)?.[1] ?? 0);
		return na - nb || a.localeCompare(b);
	});

	const tickets = [];
	for (const name of ticketFiles) {
		const filePath = path.join(setDir, name);
		const content = await fs.readFile(filePath, "utf8");
		tickets.push(parseTicketMarkdown(content, filePath));
	}
	return tickets;
}

function detectCycles(byId) {
	const state = new Map(); // 0=unvisited, 1=visiting, 2=done
	const cycles = [];
	const stack = [];

	function dfs(id) {
		state.set(id, 1);
		stack.push(id);
		const ticket = byId.get(id);
		for (const dep of ticket?.blockedBy ?? []) {
			if (!byId.has(dep)) continue;
			const depState = state.get(dep) ?? 0;
			if (depState === 1) {
				const start = stack.indexOf(dep);
				cycles.push([...stack.slice(start), dep]);
			} else if (depState === 0) {
				dfs(dep);
			}
		}
		stack.pop();
		state.set(id, 2);
	}

	for (const id of byId.keys()) {
		if ((state.get(id) ?? 0) === 0) {
			dfs(id);
		}
	}
	return cycles;
}

export function analyzeTicketSet(tickets) {
	const rawById = new Map(tickets.map((t) => [t.id, t]));
	const unblocksMap = new Map(tickets.map((t) => [t.id, []]));

	for (const t of tickets) {
		for (const dep of t.blockedBy) {
			if (unblocksMap.has(dep)) {
				unblocksMap.get(dep).push(t.id);
			}
		}
	}

	const cycles = detectCycles(rawById);
	const inCycle = new Set(cycles.flat());
	const byId = new Map();
	const items = [];

	let done = 0;
	let inProgress = 0;
	let ready = 0;
	let blocked = 0;
	let staleBlocked = 0;
	let acDone = 0;
	let acTotal = 0;

	for (const t of tickets) {
		const missingBlockers = t.blockedBy.filter((dep) => !rawById.has(dep));
		const unresolvedBlockers = t.blockedBy.filter((dep) => {
			const target = rawById.get(dep);
			return target && target.status !== "done";
		});

		const isDone = t.status === "done";
		const isInProgress = t.status === "in progress";
		const externallyBlocked = t.hasExternalBlockers && t.status === "blocked";
		const allBlockersDone =
			unresolvedBlockers.length === 0 &&
			missingBlockers.length === 0 &&
			!inCycle.has(t.id) &&
			!externallyBlocked;
		const isFrontier = !isDone && allBlockersDone;

		let effectiveState;
		if (isDone) {
			effectiveState = "done";
			done += 1;
		} else if (isInProgress) {
			effectiveState = "in progress";
			inProgress += 1;
		} else if (isFrontier && t.status === "blocked") {
			effectiveState = "stale-blocked";
			staleBlocked += 1;
			ready += 1;
		} else if (isFrontier) {
			effectiveState = "ready";
			ready += 1;
		} else {
			effectiveState = "blocked";
			blocked += 1;
		}

		const tAcDone = t.acceptanceCriteria.filter((c) => c.checked).length;
		const tAcTotal = t.acceptanceCriteria.length;
		acDone += tAcDone;
		acTotal += tAcTotal;

		const enriched = {
			...t,
			unresolvedBlockers,
			missingBlockers,
			unblocks: unblocksMap.get(t.id) ?? [],
			isFrontier,
			inCycle: inCycle.has(t.id),
			effectiveState,
			acDone: tAcDone,
			acTotal: tAcTotal,
		};
		byId.set(t.id, enriched);
		items.push(enriched);
	}

	const frontier = items.filter((t) => t.isFrontier);

	return {
		items,
		byId,
		frontier,
		cycles,
		stats: {
			total: items.length,
			done,
			inProgress,
			ready,
			blocked,
			staleBlocked,
			frontierCount: frontier.length,
			acDone,
			acTotal,
		},
	};
}

export function sortTicketsForDisplay(items) {
	const rank = (state) => {
		switch (state) {
			case "in progress":
				return 0;
			case "ready":
				return 1;
			case "stale-blocked":
				return 2;
			case "blocked":
				return 3;
			case "done":
				return 4;
			default:
				return 2;
		}
	};
	return [...items].sort((a, b) => {
		const diff = rank(a.effectiveState) - rank(b.effectiveState);
		if (diff !== 0) return diff;
		return Number(a.id) - Number(b.id) || a.id.localeCompare(b.id);
	});
}

async function atomicWriteFile(filePath, content) {
	let targetPath = filePath;
	try {
		targetPath = await fs.realpath(filePath);
	} catch {
		targetPath = filePath;
	}
	const dir = path.dirname(targetPath);
	const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
	await fs.writeFile(tmpPath, content, "utf8");
	await fs.rename(tmpPath, targetPath);
}

function applyStatusPatch(lines, status) {
	const canonical = normalizeStatus(status);
	const fmStatus = toFrontmatterStatus(canonical);
	const fm = findFrontmatter(lines);
	let bodyStart = 0;

	if (fm) {
		bodyStart = fm.end + 1;
		let updatedFm = false;
		for (let i = fm.start + 1; i < fm.end; i += 1) {
			const match = /^([ \t]*status[ \t]*:[ \t]*)(.*)$/i.exec(lines[i]);
			if (match) {
				lines[i] = `${match[1]}${fmStatus}`;
				updatedFm = true;
				break;
			}
		}
		if (!updatedFm) {
			lines.splice(fm.start + 1, 0, `status: ${fmStatus}`);
			bodyStart += 1;
		}
	}

	for (let i = bodyStart; i < lines.length; i += 1) {
		if (/^##\s+/.test(lines[i])) break;
		if (/^\*\*Status:\*\*/i.test(lines[i])) {
			lines[i] = `**Status:** ${canonical}`;
			return true;
		}
	}
	// If no **Status:** line existed in the header, insert right after **Blocked by:** or the H1
	let insertAt = fm
		? bodyStart < lines.length && lines[bodyStart].trim() === ""
			? bodyStart + 1
			: bodyStart
		: Math.min(1, lines.length);
	for (let i = bodyStart; i < lines.length; i += 1) {
		if (/^##\s+/.test(lines[i])) break;
		if (/^\*\*Blocked by:\*\*/i.test(lines[i]) || HEADING_RE.test(lines[i])) {
			insertAt = i + 1;
		}
	}
	lines.splice(insertAt, 0, `**Status:** ${canonical}`);
	return true;
}

function applyAcPatch(lines, parsed, { toggleAcIndices, setAcChecked }) {
	const toggleSet = new Set((toggleAcIndices ?? []).map(Number));
	const hasExplicitSet = Array.isArray(setAcChecked);
	const checkedSet = new Set((setAcChecked ?? []).map(Number));

	for (const ac of parsed.acceptanceCriteria) {
		const line = lines[ac.lineIndex];
		const match = line?.match(AC_LINE_RE);
		if (!match) continue;

		let nextChecked = ac.checked;
		if (hasExplicitSet) {
			nextChecked = checkedSet.has(ac.index);
		} else if (toggleSet.has(ac.index)) {
			nextChecked = !ac.checked;
		}

		lines[ac.lineIndex] = `${match[1]}[${nextChecked ? "x" : " "}]${match[3]}`;
	}
}

function applyNotePatch(lines, note) {
	const cleaned = String(note ?? "").trim();
	if (!cleaned) return;

	const entry = `- ${cleaned}`;
	let notesHeadingIndex = -1;
	for (let i = 0; i < lines.length; i += 1) {
		if (/^##\s+Notes\s*$/i.test(lines[i])) {
			notesHeadingIndex = i;
			break;
		}
	}

	if (notesHeadingIndex !== -1) {
		// Insert at the end of the Notes section
		let insertAt = lines.length;
		for (let i = notesHeadingIndex + 1; i < lines.length; i += 1) {
			if (/^##\s+/.test(lines[i])) {
				insertAt = i;
				break;
			}
		}
		while (insertAt > notesHeadingIndex + 1 && lines[insertAt - 1].trim() === "") {
			insertAt -= 1;
		}
		lines.splice(insertAt, 0, entry);
		return;
	}

	while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
		lines.pop();
	}
	lines.push("", "## Notes", "", entry, "");
}

export async function updateTicket(
	filePath,
	{ status, toggleAcIndices, setAcChecked, appendNote, autoUnblock = true } = {},
) {
	const content = await fs.readFile(filePath, "utf8");
	const parsed = parseTicketMarkdown(content, filePath);
	const lines = content.split(/\r?\n/);

	if (toggleAcIndices !== undefined || setAcChecked !== undefined) {
		applyAcPatch(lines, parsed, { toggleAcIndices, setAcChecked });
	}
	if (status !== undefined) {
		applyStatusPatch(lines, status);
	}
	if (appendNote !== undefined && String(appendNote).trim()) {
		applyNotePatch(lines, appendNote);
	}

	const nextContent = lines.join(parsed.eol);
	if (nextContent !== content) {
		await atomicWriteFile(filePath, nextContent);
	}
	const updated = parseTicketMarkdown(nextContent, filePath);

	const unblocked = [];
	if (autoUnblock && updated.status === "done") {
		const setDir = path.dirname(filePath);
		const siblings = await loadTicketSet(setDir);
		const analysis = analyzeTicketSet(siblings);
		for (const item of analysis.items) {
			if (
				item.id !== updated.id &&
				item.effectiveState === "stale-blocked" &&
				item.blockedBy.includes(updated.id)
			) {
				const res = await updateTicket(item.filePath, {
					status: "ready",
					autoUnblock: false,
				});
				unblocked.push(res.ticket);
			}
		}
	}

	return { ticket: updated, unblocked };
}

export async function syncStaleBlocked(setDir) {
	const tickets = await loadTicketSet(setDir);
	const analysis = analyzeTicketSet(tickets);
	const promoted = [];
	for (const item of analysis.items) {
		if (item.effectiveState === "stale-blocked") {
			const res = await updateTicket(item.filePath, { status: "ready", autoUnblock: false });
			promoted.push(res.ticket);
		}
	}
	return promoted;
}

function slugify(title) {
	const slug = String(title)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return slug || "ticket";
}

export async function createTicket(
	setDir,
	{
		title,
		blockedBy = [],
		status,
		repo = "",
		spec = "",
		whatToBuild = "",
		scope = "",
		acceptanceCriteria = [],
		validation = "",
	},
) {
	const cleanTitle = String(title ?? "").trim();
	if (!cleanTitle) {
		throw new Error("Ticket title is required.");
	}

	await fs.mkdir(setDir, { recursive: true });
	const existing = await loadTicketSet(setDir);
	const maxNum = existing.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0);
	const nextId = String(maxNum + 1).padStart(2, "0");

	const normalizedBlockers = (
		Array.isArray(blockedBy) ? blockedBy : parseBlockedBy(blockedBy).ids
	)
		.map(normalizeTicketId)
		.filter(Boolean);

	const doneIds = new Set(existing.filter((t) => t.status === "done").map((t) => t.id));
	const hasOpenBlocker = normalizedBlockers.some((id) => !doneIds.has(id));
	const effectiveStatus = status ? normalizeStatus(status) : hasOpenBlocker ? "blocked" : "ready";
	const fmStatus = toFrontmatterStatus(effectiveStatus);
	const fmBlockedBy =
		normalizedBlockers.length > 0
			? `[${normalizedBlockers.map((id) => JSON.stringify(id)).join(", ")}]`
			: "[]";

	const lines = [
		"---",
		`status: ${fmStatus}`,
		`blocked-by: ${fmBlockedBy}`,
		"---",
		"",
		`# ${nextId}: ${cleanTitle}`,
		"",
	];
	if (repo.trim()) lines.push(`**Repo:** ${repo.trim()}`);
	lines.push(
		`**Blocked by:** ${normalizedBlockers.length > 0 ? normalizedBlockers.join(", ") : "None (can start immediately)"}`,
	);
	lines.push(`**Status:** ${effectiveStatus}`);
	if (spec.trim()) {
		lines.push("", `Spec: \`${spec.trim()}\``);
	}

	lines.push("", "## What to build", "", whatToBuild.trim() || "_Describe the end-to-end behavior._");
	lines.push("", "## Scope", "", scope.trim() || "_Describe what this ticket touches and leaves out._");
	lines.push("", "## Acceptance criteria", "");
	if (acceptanceCriteria.length > 0) {
		for (const item of acceptanceCriteria) {
			const text = String(item).trim();
			if (text) lines.push(`- [ ] ${text}`);
		}
	} else {
		lines.push("- [ ] Observable, checkable criterion");
	}
	lines.push("", "## Validation", "", validation.trim() || "_Specify the test or check that proves it._", "");

	const filePath = path.join(setDir, `${nextId}-${slugify(cleanTitle)}.md`);
	const content = lines.join("\n");
	await atomicWriteFile(filePath, content);
	return parseTicketMarkdown(content, filePath);
}

export function statusGlyph(effectiveState) {
	switch (effectiveState) {
		case "done":
			return "✓";
		case "in progress":
			return "▶";
		case "ready":
			return "●";
		case "stale-blocked":
			return "⚠";
		case "blocked":
			return "◌";
		default:
			return "•";
	}
}

export function renderProgressBar(done, total, width = 10) {
	if (total <= 0) return `[${"░".repeat(width)}] 0/0`;
	const filled = Math.round((done / total) * width);
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${done}/${total}`;
}

export function renderTicketRow(item) {
	const glyph = statusGlyph(item.effectiveState);
	const stateTag =
		item.effectiveState === "stale-blocked" ? "ready (stale: blocked)" : item.effectiveState;
	const ac = item.acTotal > 0 ? ` [${item.acDone}/${item.acTotal} AC]` : "";
	const blockers =
		item.unresolvedBlockers.length > 0
			? ` ← ${item.unresolvedBlockers.join(",")}`
			: item.missingBlockers.length > 0
				? ` ← missing:${item.missingBlockers.join(",")}`
				: item.hasExternalBlockers && item.status === "blocked"
					? " ← external"
					: "";
	return `${glyph} ${item.id} (${stateTag}) ${item.title}${ac}${blockers}`;
}

export function renderDependencyGraph(analysis, heading = "") {
	const lines = [];
	if (heading) lines.push(heading);
	const { stats } = analysis;
	lines.push(
		`Progress: ${renderProgressBar(stats.done, stats.total)} · ${stats.inProgress} in progress · ${stats.frontierCount} ready frontier · ${stats.blocked} blocked`,
	);
	if (stats.staleBlocked > 0) {
		lines.push(`Note: ${stats.staleBlocked} ticket(s) still say "blocked" though all blockers are done.`);
	}
	if (analysis.cycles.length > 0) {
		lines.push(`Cycles detected: ${analysis.cycles.map((c) => c.join(" → ")).join("; ")}`);
	}
	lines.push("");

	for (const item of analysis.items) {
		const deps = item.blockedBy.length > 0 ? `blocked by: ${item.blockedBy.join(", ")}` : "root";
		const next = item.unblocks.length > 0 ? ` → unblocks: ${item.unblocks.join(", ")}` : "";
		lines.push(`  ${renderTicketRow(item)}`);
		lines.push(`      (${deps}${next})`);
	}

	if (analysis.frontier.length > 0) {
		lines.push("");
		lines.push(`Ready frontier: ${analysis.frontier.map((t) => `#${t.id} ${t.title}`).join(" | ")}`);
	}
	return lines.join("\n");
}

export function renderTicketDetail(item, relPath = "") {
	const lines = [`# ${item.id}: ${item.title}`];
	if (relPath) lines.push(`File: ${relPath}`);
	const stateLabel =
		item.effectiveState === "stale-blocked"
			? `${item.status} (all blockers done → ready!)`
			: item.effectiveState;
	lines.push(`Status: ${statusGlyph(item.effectiveState)} ${stateLabel}`);
	lines.push(
		`Blocked by: ${item.blockedBy.length > 0 ? item.blockedBy.join(", ") : "None"}${
			item.unresolvedBlockers.length > 0
				? ` (waiting on: ${item.unresolvedBlockers.join(", ")})`
				: ""
		}${item.hasExternalBlockers ? " + external prerequisites" : ""}`,
	);
	if (item.hasExternalBlockers) {
		lines.push(`External blockers:\n${item.externalBlockers}`);
	}
	if (item.unblocks.length > 0) {
		lines.push(`Unblocks: ${item.unblocks.join(", ")}`);
	}
	if (item.spec) lines.push(`Spec: ${item.spec}`);
	if (item.acTotal > 0) {
		lines.push(`Acceptance criteria: ${item.acDone}/${item.acTotal} checked`);
	}
	if (item.sections.whatToBuild) {
		const preview =
			item.sections.whatToBuild.length > 400
				? `${item.sections.whatToBuild.slice(0, 397)}...`
				: item.sections.whatToBuild;
		lines.push("", preview);
	}
	return lines.join("\n");
}
