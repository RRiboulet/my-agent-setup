import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
	DEFAULT_BASE_URL,
	DEFAULT_TOKEN_FILE,
	formatAuthCheck,
	formatComments,
	formatIssue,
	formatProject,
	formatProjectList,
	formatSearchResults,
	formatTransitions,
	getConfig,
	jiraRequest,
	readToken,
	redact,
	validateIssueKey,
	validateProjectKey,
} from "./jira_client.mjs";
import { createJiraTools } from "./tools.mjs";

async function withTempDir(fn) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jira-ext-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function writeTokenFile(dir, content, name = "token") {
	const filePath = path.join(dir, name);
	await fs.writeFile(filePath, content, "utf8");
	return filePath;
}

function makeResponse({
	status = 200,
	statusText = "OK",
	body = "",
	contentType = "application/json;charset=UTF-8",
	redirected = false,
} = {}) {
	const textBody = typeof body === "string" ? body : JSON.stringify(body);
	return {
		status,
		statusText,
		ok: status >= 200 && status < 300,
		redirected,
		headers: {
			get(name) {
				if (name.toLowerCase() === "content-type") {
					return contentType;
				}
				return null;
			},
		},
		async text() {
			return textBody;
		},
	};
}

describe("jira_client: getConfig", () => {
	it("returns defaults when environment variables are absent or blank", () => {
		assert.deepEqual(getConfig({}), {
			baseUrl: DEFAULT_BASE_URL,
			tokenFile: DEFAULT_TOKEN_FILE,
		});
		assert.deepEqual(getConfig({ JIRA_BASE_URL: "   ", JIRA_TOKEN_FILE: "" }), {
			baseUrl: DEFAULT_BASE_URL,
			tokenFile: DEFAULT_TOKEN_FILE,
		});
	});

	it("trims whitespace and strips trailing slashes from JIRA_BASE_URL and overrides JIRA_TOKEN_FILE", () => {
		const cfg = getConfig({
			JIRA_BASE_URL: "  https://jira.example.com///  ",
			JIRA_TOKEN_FILE: "  /home/user/.config/jira/token  ",
		});
		assert.deepEqual(cfg, {
			baseUrl: "https://jira.example.com",
			tokenFile: "/home/user/.config/jira/token",
		});
	});
});

describe("jira_client: readToken", () => {
	it("reads and trims a valid token with trailing newline", async () => {
		await withTempDir(async (dir) => {
			const tokenFile = await writeTokenFile(dir, "  pat-secret-123\n");
			const token = await readToken(tokenFile);
			assert.equal(token, "pat-secret-123");
		});
	});

	it("throws actionable guidance on ENOENT without referencing repo-specific paths", async () => {
		await withTempDir(async (dir) => {
			const missing = path.join(dir, "missing-token");
			await assert.rejects(
				() => readToken(missing),
				(err) => {
					assert.match(err.message, /ENOENT/);
					assert.match(err.message, /JIRA_TOKEN_FILE/);
					assert.match(err.message, /\/run\/secrets\/jira_token/);
					assert.match(err.message, /extensions\/jira\/README\.md/);
					assert.doesNotMatch(err.message, /\.devcontainer\/README\.md/);
					return true;
				},
			);
		});
	});

	it("rejects empty or whitespace-only token files", async () => {
		await withTempDir(async (dir) => {
			const emptyFile = await writeTokenFile(dir, "", "empty");
			const blankFile = await writeTokenFile(dir, "  \n\t \n", "blank");

			for (const file of [emptyFile, blankFile]) {
				await assert.rejects(
					() => readToken(file),
					(err) => {
						assert.match(err.message, /is empty/);
						assert.match(err.message, /JIRA_TOKEN_FILE/);
						assert.doesNotMatch(err.message, /\.devcontainer\/README\.md/);
						return true;
					},
				);
			}
		});
	});

	it("rejects tokens containing internal whitespace or control characters", async () => {
		await withTempDir(async (dir) => {
			const spaceFile = await writeTokenFile(dir, "abc def\n", "space");
			const multilineFile = await writeTokenFile(dir, "abc\ndef\n", "multiline");
			const ctrlFile = await writeTokenFile(dir, "abc\x07def\n", "ctrl");

			for (const file of [spaceFile, multilineFile, ctrlFile]) {
				await assert.rejects(
					() => readToken(file),
					/whitespace or control characters/,
				);
			}
		});
	});
});

describe("jira_client: validateIssueKey & validateProjectKey", () => {
	it("normalizes valid issue keys to uppercase", () => {
		assert.equal(validateIssueKey("  proj_1-123 "), "PROJ_1-123");
		assert.equal(validateIssueKey("abc-1"), "ABC-1");
	});

	it("rejects invalid issue keys", () => {
		for (const bad of [null, undefined, 123, "", "PROJ", "PROJ-", "-123", "1PROJ-1", "PROJ-12a", "PROJ 1-2"]) {
			assert.throws(() => validateIssueKey(bad), /Invalid issue key/);
		}
	});

	it("normalizes valid project keys to uppercase", () => {
		assert.equal(validateProjectKey("  proj_2 "), "PROJ_2");
		assert.equal(validateProjectKey("a"), "A");
	});

	it("rejects invalid project keys", () => {
		for (const bad of [null, undefined, 42, "", "   ", "1PROJ", "PROJ-1", "PROJ NAME"]) {
			assert.throws(() => validateProjectKey(bad), /Invalid project key/);
		}
	});
});

describe("jira_client: redact", () => {
	it("redacts all occurrences of token from strings", () => {
		assert.equal(
			redact("Bearer super-secret failed with super-secret", "super-secret"),
			"Bearer [REDACTED] failed with [REDACTED]",
		);
	});

	it("handles empty, missing, or non-string tokens and nullish text safely", () => {
		assert.equal(redact("plain text", ""), "plain text");
		assert.equal(redact("plain text", null), "plain text");
		assert.equal(redact("plain text", undefined), "plain text");
		assert.equal(redact(null, "secret"), "");
		assert.equal(redact(undefined, "secret"), "");
	});
});

describe("jira_client: jiraRequest", () => {
	it("sends Bearer auth, JSON headers, query params, and JSON body", async () => {
		await withTempDir(async (dir) => {
			const tokenFile = await writeTokenFile(dir, "secret-token-xyz\n");
			const calls = [];
			const fetchImpl = async (url, init) => {
				calls.push({ url, init });
				return makeResponse({ body: { ok: true } });
			};

			const res = await jiraRequest("search", {
				method: "POST",
				query: { expand: "names", skipNull: null, skipUndef: undefined, limit: 10 },
				body: { jql: "project = TEST" },
				env: { JIRA_BASE_URL: "https://jira.example.com/", JIRA_TOKEN_FILE: tokenFile },
				fetchImpl,
			});

			assert.deepEqual(res, { ok: true });
			assert.equal(calls.length, 1);
			assert.equal(calls[0].url, "https://jira.example.com/rest/api/2/search?expand=names&limit=10");
			assert.equal(calls[0].init.method, "POST");
			assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token-xyz");
			assert.equal(calls[0].init.headers.Accept, "application/json");
			assert.equal(calls[0].init.headers["Content-Type"], "application/json");
			assert.equal(calls[0].init.body, JSON.stringify({ jql: "project = TEST" }));
		});
	});

	it("returns null for 204 No Content and empty 200 responses", async () => {
		await withTempDir(async (dir) => {
			const tokenFile = await writeTokenFile(dir, "secret-token-xyz\n");

			const r204 = await jiraRequest("/issue/PROJ-1", {
				method: "PUT",
				tokenFile,
				fetchImpl: async () => makeResponse({ status: 204, statusText: "No Content", body: "" }),
			});
			assert.equal(r204, null);

			const rEmpty = await jiraRequest("/issue/PROJ-1", {
				method: "PUT",
				tokenFile,
				fetchImpl: async () => makeResponse({ status: 200, statusText: "OK", body: "   " }),
			});
			assert.equal(rEmpty, null);
		});
	});

	it("redacts token on HTTP errors and includes auth hint for 401/403", async () => {
		await withTempDir(async (dir) => {
			const token = "my-top-secret-token";
			const tokenFile = await writeTokenFile(dir, `${token}\n`);

			await assert.rejects(
				() =>
					jiraRequest("/myself", {
						tokenFile,
						fetchImpl: async () =>
							makeResponse({
								status: 401,
								statusText: "Unauthorized",
								body: { errorMessages: [`Bad token ${token}`], errors: { auth: `invalid ${token}` } },
							}),
					}),
				(err) => {
					assert.match(err.message, /Jira API 401 Unauthorized/);
					assert.match(err.message, /\[REDACTED\]/);
					assert.match(err.message, /Verify your Personal Access Token/);
					assert.doesNotMatch(err.message, /my-top-secret-token/);
					return true;
				},
			);

			await assert.rejects(
				() =>
					jiraRequest("/issue/BAD-1", {
						tokenFile,
						fetchImpl: async () =>
							makeResponse({
								status: 400,
								statusText: "Bad Request",
								contentType: "text/plain",
								body: `Raw error leaking ${token}`,
							}),
					}),
				(err) => {
					assert.match(err.message, /Jira API 400 Bad Request: Raw error leaking \[REDACTED\]/);
					assert.doesNotMatch(err.message, /my-top-secret-token/);
					return true;
				},
			);
		});
	});

	it("redacts token on network failures and timeouts", async () => {
		await withTempDir(async (dir) => {
			const token = "net-secret-token";
			const tokenFile = await writeTokenFile(dir, `${token}\n`);

			await assert.rejects(
				() =>
					jiraRequest("/myself", {
						tokenFile,
						fetchImpl: async () => {
							throw new Error(`connect ECONNREFUSED with ${token}`);
						},
					}),
				(err) => {
					assert.match(err.message, /Jira request failed \(GET \/myself\): connect ECONNREFUSED with \[REDACTED\]/);
					assert.doesNotMatch(err.message, /net-secret-token/);
					return true;
				},
			);

			await assert.rejects(
				() =>
					jiraRequest("/myself", {
						tokenFile,
						timeoutMs: 250,
						fetchImpl: async () => {
							const e = new Error(`Aborted ${token}`);
							e.name = "TimeoutError";
							throw e;
						},
					}),
				(err) => {
					assert.match(err.message, /Jira request timed out after 250ms \(GET \/myself\): Aborted \[REDACTED\]/);
					assert.doesNotMatch(err.message, /net-secret-token/);
					return true;
				},
			);
		});
	});

	it("flags non-JSON / SSO HTML responses clearly", async () => {
		await withTempDir(async (dir) => {
			const tokenFile = await writeTokenFile(dir, "pat-123\n");
			await assert.rejects(
				() =>
					jiraRequest("/myself", {
						tokenFile,
						fetchImpl: async () =>
							makeResponse({
								status: 200,
								contentType: "text/html",
								redirected: true,
								body: "<html>Login</html>",
							}),
					}),
				/Expected JSON response.*Possible SSO\/login redirect/,
			);
		});
	});
});

describe("jira_client: formatters", () => {
	const baseUrl = "https://jira.example.com";

	it("formatAuthCheck formats user and server info", () => {
		const out = formatAuthCheck({
			baseUrl,
			myself: { displayName: "Jane Doe", name: "jdoe", emailAddress: "jane@example.com", active: true },
			serverInfo: { serverTitle: "Central Jira", version: "9.12.0", deploymentType: "DataCenter" },
		});
		assert.match(out, /## Jira Connection Verified/);
		assert.match(out, /https:\/\/jira\.example\.com/);
		assert.match(out, /Jane Doe \(jdoe\)/);
		assert.match(out, /jane@example\.com/);
		assert.match(out, /Active\*\*: Yes/);
		assert.match(out, /Central Jira/);
		assert.match(out, /9\.12\.0/);
	});

	it("formatIssue formats metadata, links, custom fields, description, comments, changelog, and renderedFields", () => {
		const issue = {
			key: "PROJ-42",
			fields: {
				summary: "Fix widget alignment",
				issuetype: { name: "Bug" },
				status: { name: "In Progress" },
				priority: { name: "High" },
				resolution: null,
				assignee: { displayName: "Alice", name: "alice" },
				reporter: { displayName: "Bob", name: "bob" },
				created: "2026-10-01T10:00:00.000+0000",
				updated: "2026-10-02T12:00:00.000+0000",
				labels: ["ui", "urgent"],
				components: [{ name: "Frontend" }],
				fixVersions: [{ name: "v1.2" }],
				parent: { key: "PROJ-10", fields: { summary: "Epic parent" } },
				subtasks: [{ key: "PROJ-43", fields: { status: { name: "Open" }, summary: "Subtask one" } }],
				issuelinks: [{ type: { outward: "blocks" }, outwardIssue: { key: "PROJ-44", fields: { status: { name: "To Do" }, summary: "Blocked issue" } } }],
				customfield_10001: { value: "Team Alpha" },
				description: "Widget is offset by 4px.",
				comment: {
					total: 3,
					comments: [
						{ id: "1", author: { displayName: "Bob" }, created: "2026-10-01", body: "First" },
						{ id: "2", author: { displayName: "Alice" }, created: "2026-10-02", body: "Second", visibility: { type: "role", value: "Developers" } },
					],
				},
			},
			changelog: {
				total: 1,
				histories: [
					{ created: "2026-10-02", author: { displayName: "Alice" }, items: [{ field: "status", fromString: "Open", toString: "In Progress" }] },
				],
			},
			renderedFields: {
				description: "<p>Widget is offset by 4px.</p>",
			},
		};

		const out = formatIssue(issue, baseUrl, { includeComments: true, maxComments: 1 });
		assert.match(out, /## \[PROJ-42\]\(https:\/\/jira\.example\.com\/browse\/PROJ-42\): Fix widget alignment/);
		assert.match(out, /\*\*Labels\*\*: ui, urgent/);
		assert.match(out, /\*\*Components\*\*: Frontend/);
		assert.match(out, /\*\*Parent\*\*: \[PROJ-10\]/);
		assert.match(out, /### Subtasks[\s\S]*PROJ-43/);
		assert.match(out, /### Issue Links[\s\S]*blocks \[PROJ-44\]/);
		assert.match(out, /### Additional Fields[\s\S]*customfield_10001\*\*: Team Alpha/);
		assert.match(out, /Widget is offset by 4px\./);
		assert.match(out, /### Comments \(1 shown of 3\)/);
		assert.match(out, /\[visibility: role=Developers\]/);
		assert.doesNotMatch(out, /\*\*#1\*\*/);
		assert.match(out, /### Changelog[\s\S]*status: Open -> In Progress/);
		assert.match(out, /### Rendered Fields[\s\S]*<p>Widget is offset by 4px\.<\/p>/);

		assert.equal(formatIssue(null, baseUrl), "No issue data returned.");
	});

	it("formatSearchResults renders table, escapes pipes, and handles empty results", () => {
		assert.equal(formatSearchResults({ issues: [], total: 0 }, baseUrl), "Found 0 issues (total: 0).");

		const out = formatSearchResults(
			{
				startAt: 0,
				total: 1,
				issues: [
					{
						key: "PROJ-7",
						fields: {
							issuetype: { name: "Task" },
							status: { name: "Done" },
							priority: { name: "Medium" },
							assignee: null,
							updated: "2026-11-01T08:00:00Z",
							summary: "Handle A | B\ncases",
							customfield_99: "ExtraVal",
						},
					},
				],
			},
			baseUrl,
		);
		assert.match(out, /Showing issues 1–1 of 1:/);
		assert.match(out, /\| \[PROJ-7\]\(https:\/\/jira\.example\.com\/browse\/PROJ-7\) \| Task \| Done \| Medium \| Unassigned \| 2026-11-01 \| Handle A \\\| B cases \|/);
		assert.match(out, /### Additional Fields[\s\S]*\*\*PROJ-7\*\*: \*\*customfield_99\*\*: ExtraVal/);
	});

	it("formatComments formats comments and empty state", () => {
		const empty = formatComments("PROJ-1", { comments: [], total: 0, startAt: 0 }, baseUrl);
		assert.match(empty, /_No comments found\._/);

		const full = formatComments(
			"PROJ-1",
			{
				startAt: 5,
				total: 6,
				comments: [
					{
						id: "55",
						author: { displayName: "Bob" },
						created: "2026-11-01",
						body: "Looks good",
						visibility: { type: "group", value: "devs" },
					},
				],
			},
			baseUrl,
		);
		assert.match(full, /Comments for \[PROJ-1\]\(https:\/\/jira\.example\.com\/browse\/PROJ-1\) \(1 shown from index 5, total 6\)/);
		assert.match(full, /### Comment #55 — Bob \(2026-11-01\) \[visibility: group=devs\]/);
		assert.match(full, /Looks good/);
	});

	it("formatTransitions formats transitions and empty state", () => {
		assert.equal(formatTransitions("PROJ-1", { transitions: [] }), "No transitions available for PROJ-1.");
		const out = formatTransitions("PROJ-1", {
			transitions: [
				{ id: "11", name: "Start Progress", to: { name: "In Progress" } },
				{ id: "21", name: "Done", to: { name: "Closed" } },
			],
		});
		assert.match(out, /## Available Transitions for PROJ-1/);
		assert.match(out, /- \*\*11\*\*: Start Progress -> In Progress/);
		assert.match(out, /- \*\*21\*\*: Done -> Closed/);
	});

	it("formatProject and formatProjectList format project details and handle empty inputs", () => {
		assert.equal(formatProject(null, baseUrl), "No project data returned.");
		const proj = formatProject(
			{
				key: "DEMO",
				name: "Demo Project",
				projectTypeKey: "software",
				lead: { displayName: "Lead User", name: "lead" },
				description: "Project desc",
				issueTypes: [{ name: "Bug" }, { name: "Story" }],
				components: [{ name: "API" }],
				versions: [{ name: "1.0" }],
			},
			baseUrl,
		);
		assert.match(proj, /## \[DEMO\]\(https:\/\/jira\.example\.com\/browse\/DEMO\): Demo Project/);
		assert.match(proj, /\*\*Issue Types\*\*: Bug, Story/);
		assert.match(proj, /\*\*Components\*\*: API/);
		assert.match(proj, /\*\*Versions\*\*: 1\.0/);

		assert.equal(formatProjectList([], baseUrl), "No accessible Jira projects found.");
		const list = formatProjectList(
			[{ key: "DEMO", name: "Demo | One", projectTypeKey: "software", lead: { displayName: "Lead" } }],
			baseUrl,
		);
		assert.match(list, /Found 1 Jira project\(s\):/);
		assert.match(list, /\| \[DEMO\]\(https:\/\/jira\.example\.com\/browse\/DEMO\) \| Demo \\\| One \| software \| Lead \|/);
	});
});

describe("tools: createJiraTools", () => {
	const EXPECTED_TOOLS = [
		"jira_check_auth",
		"jira_get_issue",
		"jira_search",
		"jira_get_comments",
		"jira_get_transitions",
		"jira_get_project",
		"jira_add_comment",
		"jira_transition_issue",
		"jira_create_issue",
		"jira_update_issue",
	];

	it("returns all 10 tools with valid JSON schemas", () => {
		const tools = createJiraTools({ baseUrl: "https://jira.example.com", tokenFile: "/tmp/unused" });
		assert.deepEqual(
			tools.map((t) => t.name),
			EXPECTED_TOOLS,
		);
		for (const tool of tools) {
			assert.equal(typeof tool.description, "string");
			assert.ok(tool.description.length > 0);
			assert.equal(tool.parameters.type, "object");
			assert.equal(typeof tool.parameters.properties, "object");
			assert.equal(tool.parameters.additionalProperties, false);
			assert.equal(typeof tool.handler, "function");
		}
	});

	it("exercises happy paths for all 10 tools with stubbed fetchImpl", async () => {
		await withTempDir(async (dir) => {
			const tokenFile = await writeTokenFile(dir, "pat-tool-test-123\n");
			const requests = [];

			const fetchImpl = async (url, init) => {
				const parsedUrl = new URL(url);
				const method = init.method || "GET";
				const body = init.body ? JSON.parse(init.body) : undefined;
				requests.push({ path: parsedUrl.pathname, search: parsedUrl.search, method, body });

				if (parsedUrl.pathname === "/rest/api/2/myself") {
					return makeResponse({ body: { displayName: "Tester", name: "tester", active: true } });
				}
				if (parsedUrl.pathname === "/rest/api/2/serverInfo") {
					return makeResponse({ body: { serverTitle: "Test Jira", version: "9.12.1" } });
				}
				if (parsedUrl.pathname === "/rest/api/2/issue/PROJ-10" && method === "GET") {
					return makeResponse({
						body: {
							key: "PROJ-10",
							fields: { summary: "Sample issue", status: { name: "Open" }, issuetype: { name: "Task" } },
						},
					});
				}
				if (parsedUrl.pathname === "/rest/api/2/search" && method === "POST") {
					return makeResponse({
						body: {
							startAt: 0,
							total: 1,
							issues: [{ key: "PROJ-10", fields: { summary: "Found", status: { name: "Open" } } }],
						},
					});
				}
				if (parsedUrl.pathname === "/rest/api/2/issue/PROJ-10/comment" && method === "GET") {
					return makeResponse({
						body: {
							startAt: 0,
							total: 1,
							comments: [{ id: "101", author: { displayName: "Tester" }, body: "Hello" }],
						},
					});
				}
				if (parsedUrl.pathname === "/rest/api/2/issue/PROJ-10/comment" && method === "POST") {
					return makeResponse({
						status: 201,
						body: { id: "102", author: { displayName: "Tester" } },
					});
				}
				if (parsedUrl.pathname === "/rest/api/2/issue/PROJ-10/transitions" && method === "GET") {
					return makeResponse({
						body: {
							transitions: [
								{ id: "31", name: "Done", to: { name: "Closed" } },
							],
						},
					});
				}
				if (parsedUrl.pathname === "/rest/api/2/issue/PROJ-10/transitions" && method === "POST") {
					return makeResponse({ status: 204, statusText: "No Content" });
				}
				if (parsedUrl.pathname === "/rest/api/2/project/PROJ" && method === "GET") {
					return makeResponse({ body: { key: "PROJ", name: "Project One", projectTypeKey: "software" } });
				}
				if (parsedUrl.pathname === "/rest/api/2/project" && method === "GET") {
					return makeResponse({ body: [{ key: "PROJ", name: "Project One", projectTypeKey: "software" }] });
				}
				if (parsedUrl.pathname === "/rest/api/2/issue" && method === "POST") {
					return makeResponse({ status: 201, body: { id: "5001", key: "PROJ-11" } });
				}
				if (parsedUrl.pathname === "/rest/api/2/issue/PROJ-10" && method === "PUT") {
					return makeResponse({ status: 204, statusText: "No Content" });
				}

				throw new Error(`Unexpected request: ${method} ${parsedUrl.pathname}`);
			};

			const tools = createJiraTools({
				baseUrl: "https://jira.example.com/",
				tokenFile,
				fetchImpl,
			});
			const byName = new Map(tools.map((t) => [t.name, t]));

			const authOut = await byName.get("jira_check_auth").handler({});
			assert.match(authOut, /Jira Connection Verified/);
			assert.match(authOut, /Tester/);

			const issueOut = await byName.get("jira_get_issue").handler({
				issueKey: "proj-10",
				fields: ["summary", "status"],
				expand: "changelog",
			});
			assert.match(issueOut, /\[PROJ-10\]\(https:\/\/jira\.example\.com\/browse\/PROJ-10\): Sample issue/);

			const searchOut = await byName.get("jira_search").handler({
				jql: "project = PROJ",
				startAt: 0,
				maxResults: 10,
			});
			assert.match(searchOut, /Showing issues 1–1 of 1:/);

			const commentsOut = await byName.get("jira_get_comments").handler({ issueKey: "proj-10" });
			assert.match(commentsOut, /Comment #101 — Tester/);

			const transitionsOut = await byName.get("jira_get_transitions").handler({ issueKey: "proj-10" });
			assert.match(transitionsOut, /\*\*31\*\*: Done -> Closed/);

			const singleProjOut = await byName.get("jira_get_project").handler({ projectKey: "proj" });
			assert.match(singleProjOut, /\[PROJ\]\(https:\/\/jira\.example\.com\/browse\/PROJ\): Project One/);

			const listProjOut = await byName.get("jira_get_project").handler({});
			assert.match(listProjOut, /Found 1 Jira project\(s\):/);

			const addCommentOut = await byName.get("jira_add_comment").handler({
				issueKey: "proj-10",
				body: "Closing now",
				visibilityType: "role",
				visibilityValue: "Developers",
			});
			assert.match(addCommentOut, /Added comment #102 to \[PROJ-10\]/);

			const transitionOut = await byName.get("jira_transition_issue").handler({
				issueKey: "proj-10",
				transitionName: "done",
				comment: "Resolved",
				resolution: "Fixed",
			});
			assert.match(transitionOut, /Transitioned \[PROJ-10\].*Done \(id: 31\)/);

			const createOut = await byName.get("jira_create_issue").handler({
				projectKey: "proj",
				issueType: "Sub-task",
				summary: "New subtask",
				priority: "High",
				assignee: null,
				labels: ["backend"],
				components: ["API"],
				parentKey: "proj-10",
			});
			assert.match(createOut, /Created Jira issue \[PROJ-11\].*\(id: 5001\)/);

			const updateOut = await byName.get("jira_update_issue").handler({
				issueKey: "proj-10",
				summary: "Updated title",
				assignee: null,
				labels: ["triage"],
			});
			assert.match(updateOut, /Updated Jira issue \[PROJ-10\].*\(fields: summary, assignee, labels\)/);

			const createReq = requests.find((r) => r.path === "/rest/api/2/issue" && r.method === "POST");
			assert.deepEqual(createReq.body, {
				fields: {
					project: { key: "PROJ" },
					issuetype: { name: "Sub-task" },
					summary: "New subtask",
					priority: { name: "High" },
					assignee: null,
					labels: ["backend"],
					components: [{ name: "API" }],
					parent: { key: "PROJ-10" },
				},
			});
		});
	});

	it("returns resultType: 'failure' and never leaks token on errors for every tool", async () => {
		await withTempDir(async (dir) => {
			const token = "secret-failure-token-999";
			const tokenFile = await writeTokenFile(dir, `${token}\n`);

			const tools = createJiraTools({
				baseUrl: "https://jira.example.com",
				tokenFile,
				fetchImpl: async () =>
					makeResponse({
						status: 500,
						statusText: "Internal Server Error",
						body: { errorMessages: [`Boom ${token}`] },
					}),
			});
			const byName = new Map(tools.map((t) => [t.name, t]));

			const invocations = [
				["jira_check_auth", {}],
				["jira_get_issue", { issueKey: "PROJ-1" }],
				["jira_search", { jql: "project = PROJ" }],
				["jira_get_comments", { issueKey: "PROJ-1" }],
				["jira_get_transitions", { issueKey: "PROJ-1" }],
				["jira_get_project", { projectKey: "PROJ" }],
				["jira_add_comment", { issueKey: "PROJ-1", body: "hi" }],
				["jira_transition_issue", { issueKey: "PROJ-1", transitionId: "11" }],
				["jira_create_issue", { projectKey: "PROJ", issueType: "Task", summary: "Test" }],
				["jira_update_issue", { issueKey: "PROJ-1", summary: "Test" }],
			];

			for (const [name, args] of invocations) {
				const res = await byName.get(name).handler(args);
				assert.equal(res.resultType, "failure", `${name} should fail`);
				assert.match(res.textResultForLlm, /500 Internal Server Error/, `${name} should report status`);
				assert.doesNotMatch(res.textResultForLlm, /secret-failure-token-999/, `${name} must redact token`);
			}

			// Also verify client-side validation errors convert to failure results
			const badKeyRes = await byName.get("jira_get_issue").handler({ issueKey: "invalid" });
			assert.equal(badKeyRes.resultType, "failure");
			assert.match(badKeyRes.textResultForLlm, /Invalid issue key/);

			const badUpdateRes = await byName.get("jira_update_issue").handler({ issueKey: "PROJ-1" });
			assert.equal(badUpdateRes.resultType, "failure");
			assert.match(badUpdateRes.textResultForLlm, /At least one field/);
		});
	});
});
