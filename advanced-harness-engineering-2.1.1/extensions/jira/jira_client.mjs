import { readFile } from "node:fs/promises";

export const DEFAULT_BASE_URL = "https://central.jira.automotive.cloud";
export const DEFAULT_TOKEN_FILE = "/run/secrets/jira_token";
export const DEFAULT_TIMEOUT_MS = 30_000;

const DEFAULT_SEARCH_FIELDS = [
	"summary",
	"status",
	"issuetype",
	"priority",
	"assignee",
	"reporter",
	"updated",
	"created",
	"labels",
];

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampInt(value, fallback, min, max) {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}
	const num = Number(value);
	if (!Number.isFinite(num)) {
		return fallback;
	}
	const intVal = Math.trunc(num);
	if (max !== undefined) {
		return Math.min(max, Math.max(min, intVal));
	}
	return Math.max(min, intVal);
}

function truncateText(text, maxLen) {
	const str = text == null ? "" : String(text);
	if (str.length <= maxLen) {
		return str;
	}
	return `${str.slice(0, maxLen)}\n... [truncated, ${str.length - maxLen} more chars]`;
}

function formatUser(user) {
	if (!user) {
		return "Unassigned";
	}
	if (typeof user === "string") {
		return user;
	}
	const display = user.displayName || user.name || user.key || user.emailAddress;
	if (user.displayName && user.name && user.displayName !== user.name) {
		return `${user.displayName} (${user.name})`;
	}
	return display || "Unknown";
}

function formatDate(iso) {
	if (!iso || typeof iso !== "string") {
		return "—";
	}
	return iso.slice(0, 10);
}

export function getConfig(env = process.env) {
	const rawBaseUrl = typeof env?.JIRA_BASE_URL === "string" ? env.JIRA_BASE_URL.trim() : "";
	const rawTokenFile = typeof env?.JIRA_TOKEN_FILE === "string" ? env.JIRA_TOKEN_FILE.trim() : "";
	const baseUrl = (rawBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
	const tokenFile = rawTokenFile || DEFAULT_TOKEN_FILE;
	return { baseUrl, tokenFile };
}

export async function readToken(tokenFile = DEFAULT_TOKEN_FILE) {
	let raw;
	try {
		raw = await readFile(tokenFile, "utf8");
	} catch (err) {
		if (err && (err.code === "ENOENT" || err.code === "EACCES")) {
			throw new Error(
				`Jira token file not accessible at "${tokenFile}" (${err.code}). ` +
					`Save a Jira Personal Access Token (e.g. ~/.config/jira/token with chmod 600) and either set JIRA_TOKEN_FILE or mount it at /run/secrets/jira_token (see extensions/jira/README.md).`,
			);
		}
		throw new Error(
			`Failed to read Jira token file "${tokenFile}": ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const token = raw.trim();
	if (!token) {
		throw new Error(
			`Jira token file at "${tokenFile}" is empty. ` +
				`Save a Jira Personal Access Token (e.g. ~/.config/jira/token with chmod 600) and either set JIRA_TOKEN_FILE or mount it at /run/secrets/jira_token (see extensions/jira/README.md).`,
		);
	}

	if (/\s|[\x00-\x1f\x7f]/.test(token)) {
		throw new Error(
			`Jira token in "${tokenFile}" contains whitespace or control characters and is invalid. Replace it with a single-line Personal Access Token.`,
		);
	}

	return token;
}

export function validateIssueKey(key) {
	if (typeof key !== "string") {
		throw new Error("Invalid issue key: expected a string like PROJ-123.");
	}
	const normalized = key.trim().toUpperCase();
	if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(normalized)) {
		throw new Error(`Invalid issue key "${key.trim()}": expected format like PROJ-123.`);
	}
	return normalized;
}

export function validateProjectKey(key) {
	if (typeof key !== "string") {
		throw new Error("Invalid project key: expected a string like PROJ.");
	}
	const normalized = key.trim().toUpperCase();
	if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) {
		throw new Error(
			`Invalid project key "${key.trim()}": expected uppercase letters, digits, or underscores starting with a letter.`,
		);
	}
	return normalized;
}

export function redact(text, token) {
	const str = text == null ? "" : String(text);
	if (!token || typeof token !== "string") {
		return str;
	}
	return str.split(token).join("[REDACTED]");
}

export async function jiraRequest(
	endpointPath,
	{
		method = "GET",
		query,
		body,
		env = process.env,
		fetchImpl = fetch,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		baseUrl: overrideBaseUrl,
		tokenFile: overrideTokenFile,
	} = {},
) {
	const config = getConfig(env);
	const baseUrl = overrideBaseUrl ? String(overrideBaseUrl).trim().replace(/\/+$/, "") : config.baseUrl;
	const tokenFile = overrideTokenFile ? String(overrideTokenFile).trim() : config.tokenFile;

	const token = await readToken(tokenFile);
	const normalizedPath = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
	const url = new URL(`${baseUrl}/rest/api/2${normalizedPath}`);

	if (query && typeof query === "object") {
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined && v !== null) {
				url.searchParams.set(k, String(v));
			}
		}
	}

	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
	};

	let requestBody;
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		requestBody = typeof body === "string" ? body : JSON.stringify(body);
	}

	let res;
	try {
		res = await fetchImpl(url.toString(), {
			method,
			headers,
			body: requestBody,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		const rawMsg = err instanceof Error ? err.message : String(err);
		const safeMsg = redact(rawMsg, token);
		if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
			throw new Error(`Jira request timed out after ${timeoutMs}ms (${method} ${normalizedPath}): ${safeMsg}`);
		}
		throw new Error(`Jira request failed (${method} ${normalizedPath}): ${safeMsg}`);
	}

	if (res.status === 204) {
		return null;
	}

	let rawText = "";
	try {
		rawText = await res.text();
	} catch (err) {
		const safeMsg = redact(err instanceof Error ? err.message : String(err), token);
		throw new Error(`Failed reading Jira response (${res.status} ${res.statusText}): ${safeMsg}`);
	}

	const contentType = (res.headers?.get?.("content-type") || "").toLowerCase();
	const hasBody = rawText.trim().length > 0;
	let parsed = null;
	let jsonValid = false;
	if (hasBody && contentType.includes("json")) {
		try {
			parsed = JSON.parse(rawText);
			jsonValid = true;
		} catch {
			parsed = null;
		}
	}

	if (!res.ok) {
		const parts = [];
		if (parsed && typeof parsed === "object") {
			if (Array.isArray(parsed.errorMessages) && parsed.errorMessages.length > 0) {
				parts.push(parsed.errorMessages.join("; "));
			}
			if (parsed.errors && typeof parsed.errors === "object" && Object.keys(parsed.errors).length > 0) {
				const fieldErrors = Object.entries(parsed.errors)
					.map(([field, msg]) => `${field}: ${msg}`)
					.join("; ");
				parts.push(fieldErrors);
			}
		}

		let detail = parts.length > 0 ? redact(parts.join(" | "), token) : "";
		if (!detail) {
			const safeRaw = redact(rawText.trim(), token);
			detail = safeRaw.length > 300 ? `${safeRaw.slice(0, 300)}...` : safeRaw || "No response body";
		}

		const authHint =
			res.status === 401 || res.status === 403
				? " Verify your Personal Access Token validity and permissions in ~/.config/jira/token."
				: "";
		throw new Error(`Jira API ${res.status} ${res.statusText}: ${detail}${authHint}`);
	}

	if (!hasBody) {
		return null;
	}

	if (!contentType.includes("json") || !jsonValid) {
		const safeRaw = redact(rawText.trim(), token);
		const snippet = safeRaw.length > 200 ? `${safeRaw.slice(0, 200)}...` : safeRaw;
		const redirectHint =
			res.redirected || contentType.includes("html")
				? " Possible SSO/login redirect — verify your network/VPN connection and Jira token."
				: "";
		const reason = !contentType.includes("json") ? "Expected JSON response" : "Invalid JSON response";
		throw new Error(
			`${reason} from Jira API (${res.status}${res.statusText ? ` ${res.statusText}` : ""}, content-type: ${contentType || "unknown"}).${redirectHint} Body: ${snippet}`,
		);
	}

	return parsed;
}

export function createJiraClient(options = {}) {
	const { env = process.env, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, baseUrl, tokenFile } = options;

	function getBaseUrl() {
		if (baseUrl) {
			return String(baseUrl).trim().replace(/\/+$/, "");
		}
		return getConfig(env).baseUrl;
	}

	function req(endpointPath, reqOptions = {}) {
		return jiraRequest(endpointPath, {
			env,
			fetchImpl,
			timeoutMs,
			baseUrl,
			tokenFile,
			...reqOptions,
		});
	}

	async function checkAuth() {
		const [myself, serverInfo] = await Promise.all([req("/myself"), req("/serverInfo")]);
		return { baseUrl: getBaseUrl(), myself, serverInfo };
	}

	async function getIssue(issueKey, { fields, expand } = {}) {
		const key = validateIssueKey(issueKey);
		const query = {};
		if (Array.isArray(fields)) {
			const cleaned = fields.map((f) => String(f).trim()).filter(Boolean);
			if (cleaned.length > 0) {
				query.fields = cleaned.join(",");
			}
		} else if (typeof fields === "string" && fields.trim()) {
			query.fields = fields.trim();
		}

		if (Array.isArray(expand)) {
			const cleaned = expand.map((e) => String(e).trim()).filter(Boolean);
			if (cleaned.length > 0) {
				query.expand = cleaned.join(",");
			}
		} else if (typeof expand === "string" && expand.trim()) {
			query.expand = expand.trim();
		}

		return req(`/issue/${key}`, { query });
	}

	async function searchIssues(jql, { startAt = 0, maxResults = 20, fields } = {}) {
		if (typeof jql !== "string" || !jql.trim()) {
			throw new Error("JQL query must be a non-empty string.");
		}
		const safeStartAt = clampInt(startAt, 0, 0);
		const safeMaxResults = clampInt(maxResults, 20, 1, 50);

		let resolvedFields = DEFAULT_SEARCH_FIELDS;
		if (Array.isArray(fields) && fields.length > 0) {
			resolvedFields = fields.map((f) => String(f).trim()).filter(Boolean);
			if (resolvedFields.length === 0) {
				resolvedFields = DEFAULT_SEARCH_FIELDS;
			}
		} else if (typeof fields === "string" && fields.trim()) {
			const split = fields
				.split(",")
				.map((f) => f.trim())
				.filter(Boolean);
			if (split.length > 0) {
				resolvedFields = split;
			}
		}

		return req("/search", {
			method: "POST",
			body: {
				jql: jql.trim(),
				startAt: safeStartAt,
				maxResults: safeMaxResults,
				fields: resolvedFields,
			},
		});
	}

	async function getComments(issueKey, { startAt = 0, maxResults = 20 } = {}) {
		const key = validateIssueKey(issueKey);
		const safeStartAt = clampInt(startAt, 0, 0);
		const safeMaxResults = clampInt(maxResults, 20, 1, 50);
		return req(`/issue/${key}/comment`, {
			query: { startAt: safeStartAt, maxResults: safeMaxResults },
		});
	}

	async function addComment(issueKey, body, { visibilityType, visibilityValue } = {}) {
		const key = validateIssueKey(issueKey);
		if (typeof body !== "string" || !body.trim()) {
			throw new Error("Comment body must be a non-empty string.");
		}

		const payload = { body };
		if (visibilityType !== undefined || visibilityValue !== undefined) {
			const typeStr = typeof visibilityType === "string" ? visibilityType.trim() : "";
			const valStr = typeof visibilityValue === "string" ? visibilityValue.trim() : "";
			if (!typeStr || !valStr) {
				throw new Error("Both visibilityType and visibilityValue must be provided when setting visibility.");
			}
			payload.visibility = { type: typeStr, value: valStr };
		}

		return req(`/issue/${key}/comment`, {
			method: "POST",
			body: payload,
		});
	}

	async function getTransitions(issueKey) {
		const key = validateIssueKey(issueKey);
		return req(`/issue/${key}/transitions`);
	}

	async function transitionIssue(
		issueKey,
		{ transitionId, transitionName, comment, resolution, fields } = {},
	) {
		const key = validateIssueKey(issueKey);
		const hasId = transitionId !== undefined && transitionId !== null && String(transitionId).trim() !== "";
		const hasName = typeof transitionName === "string" && transitionName.trim() !== "";

		if (!hasId && !hasName) {
			throw new Error("Either transitionId or transitionName must be provided.");
		}

		let resolvedId;
		let matchedName;

		if (hasId) {
			resolvedId = String(transitionId).trim();
			matchedName = hasName ? transitionName.trim() : undefined;
		} else {
			const data = await getTransitions(key);
			const transitions = Array.isArray(data?.transitions) ? data.transitions : [];
			const target = transitionName.trim().toLowerCase();
			const matches = transitions.filter(
				(t) => typeof t?.name === "string" && t.name.trim().toLowerCase() === target,
			);

			if (matches.length !== 1) {
				const available =
					transitions.length > 0
						? transitions.map((t) => `${t.id}: ${t.name} -> ${t.to?.name ?? "unknown"}`).join("; ")
						: "none";
				const reason =
					matches.length === 0
						? `No transition matching "${transitionName.trim()}" found for ${key}.`
						: `Multiple transitions matched "${transitionName.trim()}" for ${key}.`;
				throw new Error(`${reason} Available transitions: ${available}`);
			}

			resolvedId = String(matches[0].id);
			matchedName = matches[0].name;
		}

		const payload = {
			transition: { id: String(resolvedId) },
		};

		const mergedFields = isPlainObject(fields) ? { ...fields } : {};
		if (typeof resolution === "string" && resolution.trim() !== "") {
			mergedFields.resolution = { name: resolution.trim() };
		}
		if (Object.keys(mergedFields).length > 0) {
			payload.fields = mergedFields;
		}

		if (typeof comment === "string" && comment.trim() !== "") {
			payload.update = {
				comment: [{ add: { body: comment } }],
			};
		}

		await req(`/issue/${key}/transitions`, {
			method: "POST",
			body: payload,
		});

		return { key, transitionId: resolvedId, transitionName: matchedName };
	}

	async function createIssue({
		projectKey,
		issueType,
		summary,
		description,
		priority,
		assignee,
		labels,
		components,
		parentKey,
		extraFields,
	} = {}) {
		const validatedProjectKey = validateProjectKey(projectKey);
		if (typeof issueType !== "string" || !issueType.trim()) {
			throw new Error("issueType must be a non-empty string.");
		}
		if (typeof summary !== "string" || !summary.trim()) {
			throw new Error("summary must be a non-empty string.");
		}

		const fields = isPlainObject(extraFields) ? { ...extraFields } : {};
		fields.project = { key: validatedProjectKey };
		fields.issuetype = { name: issueType.trim() };
		fields.summary = summary.trim();

		if (description !== undefined) {
			fields.description = description;
		}
		if (priority !== undefined && priority !== null && String(priority).trim() !== "") {
			fields.priority = { name: String(priority).trim() };
		}
		if (assignee !== undefined) {
			fields.assignee = assignee === null || String(assignee).trim() === "" ? null : { name: String(assignee).trim() };
		}
		if (Array.isArray(labels)) {
			fields.labels = labels.map((l) => String(l));
		}
		if (Array.isArray(components)) {
			fields.components = components.map((c) => (typeof c === "string" ? { name: c } : c));
		}
		if (parentKey !== undefined && parentKey !== null && String(parentKey).trim() !== "") {
			fields.parent = { key: validateIssueKey(parentKey) };
		}

		return req("/issue", {
			method: "POST",
			body: { fields },
		});
	}

	async function updateIssue(
		issueKey,
		{ summary, description, priority, assignee, labels, components, extraFields } = {},
	) {
		const key = validateIssueKey(issueKey);
		const fields = isPlainObject(extraFields) ? { ...extraFields } : {};

		if (summary !== undefined) {
			if (typeof summary !== "string" || !summary.trim()) {
				throw new Error("summary must be a non-empty string when provided.");
			}
			fields.summary = summary.trim();
		}
		if (description !== undefined) {
			fields.description = description;
		}
		if (priority !== undefined) {
			fields.priority =
				priority === null || String(priority).trim() === "" ? null : { name: String(priority).trim() };
		}
		if (assignee !== undefined) {
			fields.assignee = assignee === null || String(assignee).trim() === "" ? null : { name: String(assignee).trim() };
		}
		if (Array.isArray(labels)) {
			fields.labels = labels.map((l) => String(l));
		}
		if (Array.isArray(components)) {
			fields.components = components.map((c) => (typeof c === "string" ? { name: c } : c));
		}

		if (Object.keys(fields).length === 0) {
			throw new Error("At least one field must be provided to update the issue.");
		}

		await req(`/issue/${key}`, {
			method: "PUT",
			body: { fields },
		});

		return { key, updatedFields: Object.keys(fields) };
	}

	async function getProject(projectKey) {
		if (projectKey !== undefined && projectKey !== null && String(projectKey).trim() !== "") {
			const key = validateProjectKey(projectKey);
			return req(`/project/${key}`);
		}
		return req("/project");
	}

	return {
		getBaseUrl,
		checkAuth,
		getIssue,
		searchIssues,
		getComments,
		addComment,
		getTransitions,
		transitionIssue,
		createIssue,
		updateIssue,
		getProject,
	};
}

export function formatAuthCheck({ baseUrl, myself, serverInfo }) {
	const lines = [
		"## Jira Connection Verified",
		`- **Base URL**: ${baseUrl}`,
		`- **User**: ${formatUser(myself)}`,
	];
	if (myself?.emailAddress) {
		lines.push(`- **Email**: ${myself.emailAddress}`);
	}
	if (myself?.active !== undefined) {
		lines.push(`- **Active**: ${myself.active ? "Yes" : "No"}`);
	}
	if (serverInfo) {
		if (serverInfo.serverTitle) {
			lines.push(`- **Server Title**: ${serverInfo.serverTitle}`);
		}
		if (serverInfo.version) {
			lines.push(`- **Version**: ${serverInfo.version}`);
		}
		if (serverInfo.deploymentType) {
			lines.push(`- **Deployment**: ${serverInfo.deploymentType}`);
		}
	}
	return lines.join("\n");
}

function formatExtraFieldValue(value) {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "string") {
		return value.trim() ? truncateText(value.trim(), 500) : null;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return null;
		}
		const items = value.map((item) => formatExtraFieldValue(item)).filter(Boolean);
		return items.length > 0 ? items.join(", ") : null;
	}
	if (typeof value === "object") {
		if (typeof value.displayName === "string") {
			return value.displayName;
		}
		if (typeof value.name === "string") {
			return value.name;
		}
		if (typeof value.value === "string") {
			return value.value;
		}
		if (typeof value.key === "string") {
			return value.key;
		}
		const json = JSON.stringify(value);
		if (json === "{}") {
			return null;
		}
		return truncateText(json, 500);
	}
	return String(value);
}

export function formatIssue(issue, baseUrl, { includeComments = true, maxComments = 10 } = {}) {
	if (!issue || !issue.key) {
		return "No issue data returned.";
	}

	const fields = issue.fields || {};
	const browseUrl = `${baseUrl}/browse/${issue.key}`;
	const lines = [
		`## [${issue.key}](${browseUrl}): ${fields.summary || "(No summary)"}`,
		`- **URL**: ${browseUrl}`,
		`- **Type**: ${fields.issuetype?.name || "—"} | **Status**: ${fields.status?.name || "—"} | **Priority**: ${fields.priority?.name || "—"}`,
		`- **Resolution**: ${fields.resolution?.name || "Unresolved"}`,
		`- **Assignee**: ${formatUser(fields.assignee)} | **Reporter**: ${formatUser(fields.reporter)}`,
		`- **Created**: ${fields.created || "—"} | **Updated**: ${fields.updated || "—"}`,
	];

	if (Array.isArray(fields.labels) && fields.labels.length > 0) {
		lines.push(`- **Labels**: ${fields.labels.join(", ")}`);
	}
	if (Array.isArray(fields.components) && fields.components.length > 0) {
		lines.push(`- **Components**: ${fields.components.map((c) => c.name || c.id).join(", ")}`);
	}
	if (Array.isArray(fields.fixVersions) && fields.fixVersions.length > 0) {
		lines.push(`- **Fix Versions**: ${fields.fixVersions.map((v) => v.name || v.id).join(", ")}`);
	}
	if (fields.parent?.key) {
		lines.push(
			`- **Parent**: [${fields.parent.key}](${baseUrl}/browse/${fields.parent.key})${fields.parent.fields?.summary ? ` — ${fields.parent.fields.summary}` : ""}`,
		);
	}

	if (Array.isArray(fields.subtasks) && fields.subtasks.length > 0) {
		lines.push("", "### Subtasks");
		for (const sub of fields.subtasks) {
			lines.push(
				`- [${sub.key}](${baseUrl}/browse/${sub.key}) [${sub.fields?.status?.name || "—"}]: ${sub.fields?.summary || ""}`,
			);
		}
	}

	if (Array.isArray(fields.issuelinks) && fields.issuelinks.length > 0) {
		lines.push("", "### Issue Links");
		for (const link of fields.issuelinks) {
			if (link.outwardIssue) {
				const rel = link.type?.outward || link.type?.name || "relates to";
				const target = link.outwardIssue;
				lines.push(
					`- ${rel} [${target.key}](${baseUrl}/browse/${target.key}) [${target.fields?.status?.name || "—"}]: ${target.fields?.summary || ""}`,
				);
			}
			if (link.inwardIssue) {
				const rel = link.type?.inward || link.type?.name || "relates to";
				const target = link.inwardIssue;
				lines.push(
					`- ${rel} [${target.key}](${baseUrl}/browse/${target.key}) [${target.fields?.status?.name || "—"}]: ${target.fields?.summary || ""}`,
				);
			}
		}
	}

	const standardKeys = new Set([
		"summary",
		"issuetype",
		"status",
		"priority",
		"resolution",
		"assignee",
		"reporter",
		"created",
		"updated",
		"labels",
		"components",
		"fixVersions",
		"parent",
		"subtasks",
		"issuelinks",
		"description",
		"comment",
		"project",
		"creator",
		"watches",
		"votes",
		"workratio",
		"progress",
		"aggregateprogress",
		"lastViewed",
		"statuscategorychangedate",
		"timetracking",
		"attachment",
		"worklog",
	]);

	const extraLines = [];
	for (const [k, v] of Object.entries(fields)) {
		if (standardKeys.has(k)) {
			continue;
		}
		const formatted = formatExtraFieldValue(v);
		if (formatted !== null) {
			extraLines.push(`- **${k}**: ${formatted}`);
		}
	}
	if (extraLines.length > 0) {
		lines.push("", "### Additional Fields", ...extraLines);
	}

	lines.push("", "### Description");
	if (typeof fields.description === "string" && fields.description.trim()) {
		lines.push(truncateText(fields.description, 8000));
	} else {
		lines.push("_No description._");
	}

	if (includeComments && fields.comment) {
		const allComments = Array.isArray(fields.comment.comments) ? fields.comment.comments : [];
		const total = fields.comment.total ?? allComments.length;
		const limit = clampInt(maxComments, 10, 0);
		const slice = limit > 0 ? allComments.slice(-limit) : [];
		lines.push("", `### Comments (${slice.length} shown of ${total})`);
		if (allComments.length === 0) {
			lines.push("_No comments._");
		} else if (slice.length === 0) {
			lines.push("_No comments shown._");
		} else {
			for (const c of slice) {
				const vis = c.visibility ? ` [visibility: ${c.visibility.type}=${c.visibility.value}]` : "";
				lines.push(
					`\n**#${c.id}** — ${formatUser(c.author)} (${c.created || "—"})${vis}:\n${truncateText(c.body || "", 3000)}`,
				);
			}
		}
	}

	if (Array.isArray(issue.changelog?.histories)) {
		const histories = issue.changelog.histories;
		const totalHistories = issue.changelog.total ?? histories.length;
		const shown = histories.slice(-20);
		lines.push("", "### Changelog");
		if (shown.length === 0) {
			lines.push("_No changelog entries._");
		} else {
			if (totalHistories > shown.length) {
				lines.push(`_Showing the most recent ${shown.length} of ${totalHistories} entries (truncated)._`);
			}
			for (const h of shown) {
				const date = h.created || "—";
				const author = formatUser(h.author);
				const items = Array.isArray(h.items) ? h.items : [];
				if (items.length === 0) {
					lines.push(`- **${date}** — ${author}: _(no item details)_`);
				} else {
					const itemStrs = items.map((it) => {
						const fieldName = it.field || "unknown";
						const fromRaw = it.fromString ?? it.from ?? "—";
						const toRaw = it.toString ?? it.to ?? "—";
						const fromStr = String(fromRaw === "" ? "—" : fromRaw);
						const toStr = String(toRaw === "" ? "—" : toRaw);
						const safeFrom = fromStr.length > 300 ? `${fromStr.slice(0, 300)}...` : fromStr;
						const safeTo = toStr.length > 300 ? `${toStr.slice(0, 300)}...` : toStr;
						return `${fieldName}: ${safeFrom} -> ${safeTo}`;
					});
					lines.push(`- **${date}** — ${author}: ${itemStrs.join("; ")}`);
				}
			}
		}
	}

	if (isPlainObject(issue.renderedFields)) {
		const renderedLines = [];
		for (const [k, v] of Object.entries(issue.renderedFields)) {
			if (v === null || v === undefined) {
				continue;
			}
			let text;
			if (typeof v === "string") {
				const trimmed = v.trim();
				if (!trimmed) {
					continue;
				}
				text = truncateText(trimmed, 2000);
			} else {
				const formatted = formatExtraFieldValue(v);
				if (formatted === null) {
					continue;
				}
				text = truncateText(formatted, 1000);
			}
			renderedLines.push(`- **${k}**: ${text}`);
		}
		if (renderedLines.length > 0) {
			lines.push("", "### Rendered Fields", ...renderedLines);
		}
	}

	const knownTopLevelKeys = new Set([
		"id",
		"self",
		"key",
		"expand",
		"fields",
		"changelog",
		"renderedFields",
	]);
	for (const [k, v] of Object.entries(issue)) {
		if (knownTopLevelKeys.has(k) || v === null || v === undefined) {
			continue;
		}
		let content = null;
		if (typeof v === "string") {
			const trimmed = v.trim();
			content = trimmed ? truncateText(trimmed, 2000) : null;
		} else if (Array.isArray(v)) {
			if (v.length > 0) {
				content = truncateText(JSON.stringify(v, null, 2), 2000);
			}
		} else if (typeof v === "object") {
			if (Object.keys(v).length > 0) {
				content = truncateText(JSON.stringify(v, null, 2), 2000);
			}
		} else {
			content = String(v);
		}
		if (content !== null) {
			lines.push("", `### Expanded: ${k}`, content);
		}
	}

	return lines.join("\n");
}

const TABLE_FIELD_KEYS = new Set(["issuetype", "status", "priority", "assignee", "updated", "summary"]);

export function formatSearchResults(data, baseUrl) {
	const issues = Array.isArray(data?.issues) ? data.issues : [];
	const total = data?.total ?? issues.length;
	const startAt = data?.startAt ?? 0;

	if (issues.length === 0) {
		return `Found 0 issues (total: ${total}).`;
	}

	const endIndex = startAt + issues.length;
	const lines = [
		`Showing issues ${startAt + 1}–${endIndex} of ${total}:`,
		"",
		"| Key | Type | Status | Priority | Assignee | Updated | Summary |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	];
	const extraLines = [];

	for (const issue of issues) {
		const f = issue.fields || {};
		const link = `[${issue.key}](${baseUrl}/browse/${issue.key})`;
		const type = f.issuetype?.name || "—";
		const status = f.status?.name || "—";
		const priority = f.priority?.name || "—";
		const assignee = "assignee" in f ? formatUser(f.assignee) : "—";
		const updated = formatDate(f.updated);
		const summary = "summary" in f ? String(f.summary || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ") : "—";
		lines.push(`| ${link} | ${type} | ${status} | ${priority} | ${assignee} | ${updated} | ${summary} |`);

		const extraPairs = [];
		for (const [k, v] of Object.entries(f)) {
			if (TABLE_FIELD_KEYS.has(k)) {
				continue;
			}
			const formatted = formatExtraFieldValue(v);
			if (formatted !== null) {
				const compact = formatted.replace(/\r?\n+/g, " ");
				extraPairs.push(`**${k}**: ${compact}`);
			}
		}
		if (extraPairs.length > 0) {
			extraLines.push(`- **${issue.key}**: ${extraPairs.join(" | ")}`);
		}
	}

	if (extraLines.length > 0) {
		lines.push("", "### Additional Fields", ...extraLines);
	}

	return lines.join("\n");
}

export function formatComments(issueKey, data, baseUrl) {
	const comments = Array.isArray(data?.comments) ? data.comments : [];
	const total = data?.total ?? comments.length;
	const startAt = data?.startAt ?? 0;
	const browseUrl = `${baseUrl}/browse/${issueKey}`;

	const header = `## Comments for [${issueKey}](${browseUrl}) (${comments.length} shown from index ${startAt}, total ${total})`;
	if (comments.length === 0) {
		return `${header}\n\n_No comments found._`;
	}

	const parts = [header];
	for (const c of comments) {
		const vis = c.visibility ? ` [visibility: ${c.visibility.type}=${c.visibility.value}]` : "";
		parts.push(
			`\n### Comment #${c.id} — ${formatUser(c.author)} (${c.created || "—"})${vis}\n${truncateText(c.body || "", 3000)}`,
		);
	}
	return parts.join("\n");
}

export function formatTransitions(issueKey, data) {
	const transitions = Array.isArray(data?.transitions) ? data.transitions : [];
	if (transitions.length === 0) {
		return `No transitions available for ${issueKey}.`;
	}

	const lines = [`## Available Transitions for ${issueKey}`, ""];
	for (const t of transitions) {
		const toName = t.to?.name || "Unknown";
		lines.push(`- **${t.id}**: ${t.name} -> ${toName}`);
	}
	return lines.join("\n");
}

export function formatProject(project, baseUrl) {
	if (!project) {
		return "No project data returned.";
	}
	const browseUrl = `${baseUrl}/browse/${project.key}`;
	const lines = [
		`## [${project.key}](${browseUrl}): ${project.name || ""}`,
		`- **URL**: ${browseUrl}`,
		`- **Type**: ${project.projectTypeKey || "—"}`,
		`- **Lead**: ${formatUser(project.lead)}`,
	];

	if (project.description) {
		lines.push(`- **Description**: ${truncateText(project.description, 1000)}`);
	}
	if (Array.isArray(project.issueTypes) && project.issueTypes.length > 0) {
		lines.push(`- **Issue Types**: ${project.issueTypes.map((it) => it.name).join(", ")}`);
	}
	if (Array.isArray(project.components) && project.components.length > 0) {
		lines.push(`- **Components**: ${project.components.map((c) => c.name).join(", ")}`);
	}
	if (Array.isArray(project.versions) && project.versions.length > 0) {
		lines.push(`- **Versions**: ${project.versions.map((v) => v.name).join(", ")}`);
	}
	return lines.join("\n");
}

export function formatProjectList(projects, baseUrl) {
	const list = Array.isArray(projects) ? projects : [];
	if (list.length === 0) {
		return "No accessible Jira projects found.";
	}

	const lines = [
		`Found ${list.length} Jira project(s):`,
		"",
		"| Key | Name | Type | Lead |",
		"| --- | --- | --- | --- |",
	];

	for (const p of list) {
		const link = `[${p.key}](${baseUrl}/browse/${p.key})`;
		const name = String(p.name || "").replace(/\|/g, "\\|");
		const type = p.projectTypeKey || "—";
		const lead = p.lead ? formatUser(p.lead) : "—";
		lines.push(`| ${link} | ${name} | ${type} | ${lead} |`);
	}

	return lines.join("\n");
}
