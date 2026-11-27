import {
	createJiraClient,
	formatAuthCheck,
	formatComments,
	formatIssue,
	formatProject,
	formatProjectList,
	formatSearchResults,
	formatTransitions,
} from "./jira_client.mjs";

function toFailure(err) {
	return {
		textResultForLlm: err instanceof Error ? err.message : String(err),
		resultType: "failure",
	};
}

export function createJiraTools(clientOptions = {}) {
	const client = createJiraClient(clientOptions);

	return [
		{
			name: "jira_check_auth",
			description: "Verify Jira Server/Data Center connectivity and Personal Access Token authentication.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			handler: async () => {
				try {
					const result = await client.checkAuth();
					return formatAuthCheck(result);
				} catch (err) {
					return toFailure(err);
				}
			},
		},
		{
			name: "jira_get_issue",
			description: "Fetch full details of a Jira issue by key (e.g. PROJ-123).",
			parameters: {
				type: "object",
				properties: {
					issueKey: {
						type: "string",
						description: "Jira issue key (e.g. PROJ-123).",
					},
					fields: {
						type: "array",
						items: { type: "string" },
						description: "Optional list of field names to retrieve.",
					},
					expand: {
						type: "string",
						description: "Optional Jira expand parameter (e.g. renderedFields,changelog).",
					},
					includeComments: {
						type: "boolean",
						description: "Include comments in formatted output (default true).",
					},
					maxComments: {
						type: "integer",
						description: "Maximum number of most recent comments to include (default 10).",
					},
				},
				required: ["issueKey"],
				additionalProperties: false,
			},
			handler: async (args) => {
				try {
					const { issueKey, fields, expand, includeComments = true, maxComments = 10 } = args || {};
					const issue = await client.getIssue(issueKey, { fields, expand });
					return formatIssue(issue, client.getBaseUrl(), { includeComments, maxComments });
				} catch (err) {
					return toFailure(err);
				}
			},
		},
		{
			name: "jira_search",
			description: "Search Jira issues using a JQL query.",
			parameters: {
				type: "object",
				properties: {
					jql: {
						type: "string",
						description: "Jira Query Language (JQL) query string.",
					},
					startAt: {
						type: "integer",
						description: "Zero-based pagination offset (default 0).",
					},
					maxResults: {
						type: "integer",
						description: "Maximum number of issues to return (1-50, default 20).",
					},
					fields: {
						type: "array",
						items: { type: "string" },
						description: "Optional list of fields to return for each issue.",
					},
				},
				required: ["jql"],
				additionalProperties: false,
			},
			handler: async (args) => {
				try {
					const { jql, startAt = 0, maxResults = 20, fields } = args || {};
					const data = await client.searchIssues(jql, { startAt, maxResults, fields });
					return formatSearchResults(data, client.getBaseUrl());
				} catch (err) {
					return toFailure(err);
				}
			},
		},
		{
			name: "jira_get_comments",
			description: "List comments on a Jira issue with pagination.",
			parameters: {
				type: "object",
				properties: {
					issueKey: {
						type: "string",
						description: "Jira issue key (e.g. PROJ-123).",
					},
					startAt: {
						type: "integer",
						description: "Zero-based pagination offset (default 0).",
					},
					maxResults: {
						type: "integer",
						description: "Maximum number of comments to return (1-50, default 20).",
					},
				},
				required: ["issueKey"],
				additionalProperties: false,
			},
			handler: async (args) => {
				try {
					const { issueKey, startAt = 0, maxResults = 20 } = args || {};
					const data = await client.getComments(issueKey, { startAt, maxResults });
					return formatComments(issueKey.trim().toUpperCase(), data, client.getBaseUrl());
				} catch (err) {
					return toFailure(err);
				}
			},
		},
		{
			name: "jira_get_transitions",
			description: "List available workflow transitions for a Jira issue.",
			parameters: {
				type: "object",
				properties: {
					issueKey: {
						type: "string",
						description: "Jira issue key (e.g. PROJ-123).",
					},
				},
				required: ["issueKey"],
				additionalProperties: false,
			},
			handler: async (args) => {
				try {
					const { issueKey } = args || {};
					const data = await client.getTransitions(issueKey);
					return formatTransitions(issueKey.trim().toUpperCase(), data);
				} catch (err) {
					return toFailure(err);
				}
			},
		},
		{
			name: "jira_get_project",
			description: "Get metadata for a Jira project by key, or list all accessible projects when omitted.",
			parameters: {
				type: "object",
				properties: {
					projectKey: {
						type: "string",
						description: "Optional Jira project key (e.g. PROJ). Omit to list all accessible projects.",
					},
				},
				additionalProperties: false,
			},
			handler: async (args) => {
				try {
					const { projectKey } = args || {};
					const data = await client.getProject(projectKey);
					if (projectKey && String(projectKey).trim() !== "") {
						return formatProject(data, client.getBaseUrl());
					}
					return formatProjectList(data, client.getBaseUrl());
				} catch (err) {
					return toFailure(err);
				}
			},
		},
		{
			name: "jira_add_comment",
			description: "Add a comment to a Jira issue.",
			parameters: {
				type: "object",
				properties: {
					issueKey: {
						type: "string",
						description: "Jira issue key (e.g. PROJ-123).",
					},
					body: {
						type: "string",
						description: "Comment text.",
					},
					visibilityType: {
						type: "string",
						description: "Optional visibility restriction type (e.g. role or group).",
					},
					visibilityValue: {
						type: "string",
						description: "Optional visibility restriction value (e.g. Developers).",
					},
				},
				required: ["issueKey", "body"],
				additionalProperties: false,
			},
			handler: async (args) => {
				try {
					const { issueKey, body, visibilityType, visibilityValue } = args || {};
					const created = await client.addComment(issueKey, body, { visibilityType, visibilityValue });
					const normalizedKey = issueKey.trim().toUpperCase();
					const browseUrl = `${client.getBaseUrl()}/browse/${normalizedKey}`;
					const author = created?.author?.displayName || created?.author?.name || "current user";
					return `Added comment #${created?.id ?? "?"} to [${normalizedKey}](${browseUrl}) by ${author}.`;
				} catch (err) {
					return toFailure(err);
				}
			},
		},
		{
			name: "jira_transition_issue",
			description: "Transition a Jira issue to another workflow status by transition ID or name.",
			parameters: {
				type: "object",
				properties: {
					issueKey: {
						type: "string",
						description: "Jira issue key (e.g. PROJ-123).",
					},
					transitionId: {
						type: "string",
						description: "Transition ID (from jira_get_transitions).",
					},
					transitionName: {
						type: "string",
						description: "Case-insensitive transition name if transitionId is not provided.",
					},
					comment: {
						type: "string",
						description: "Optional comment to add during the transition.",
					},
					resolution: {
						type: "string",
						description: "Optional resolution name (e.g. Done, Fixed).",
					},
					fields: {
						type: "object",
						description: "Optional additional Jira fields required by the transition screen.",
					},
				},
				required: ["issueKey"],
				additionalProperties: false,
			},
			handler: async (args) => {
				try {
					const { issueKey, transitionId, transitionName, comment, resolution, fields } = args || {};
					const res = await client.transitionIssue(issueKey, {
						transitionId,
						transitionName,
						comment,
						resolution,
						fields,
					});
					const browseUrl = `${client.getBaseUrl()}/browse/${res.key}`;
					const label = res.transitionName ? `${res.transitionName} (id: ${res.transitionId})` : `id: ${res.transitionId}`;
					return `Transitioned [${res.key}](${browseUrl}) using transition ${label}.`;
				} catch (err) {
					return toFailure(err);
				}
			},
		},
		{
			name: "jira_create_issue",
			description: "Create a new Jira issue in a project.",
			parameters: {
				type: "object",
				properties: {
					projectKey: {
						type: "string",
						description: "Jira project key (e.g. PROJ).",
					},
					issueType: {
						type: "string",
						description: "Issue type name (e.g. Bug, Task, Story).",
					},
					summary: {
						type: "string",
						description: "Issue summary/title.",
					},
					description: {
						type: "string",
						description: "Optional issue description.",
					},
					priority: {
						type: "string",
						description: "Optional priority name (e.g. High, Medium).",
					},
					assignee: {
						type: ["string", "null"],
						description: "Optional assignee username, or null/empty string for unassigned.",
					},
					labels: {
						type: "array",
						items: { type: "string" },
						description: "Optional list of labels.",
					},
					components: {
						type: "array",
						items: { type: "string" },
						description: "Optional list of component names.",
					},
					parentKey: {
						type: "string",
						description: "Optional parent issue key (e.g. PROJ-100) for subtasks.",
					},
					extraFields: {
						type: "object",
						description: "Optional additional Jira fields object.",
					},
				},
				required: ["projectKey", "issueType", "summary"],
				additionalProperties: false,
			},
			handler: async (args) => {
				try {
					const created = await client.createIssue(args || {});
					const browseUrl = `${client.getBaseUrl()}/browse/${created.key}`;
					return `Created Jira issue [${created.key}](${browseUrl}) (id: ${created.id}).`;
				} catch (err) {
					return toFailure(err);
				}
			},
		},
		{
			name: "jira_update_issue",
			description: "Update fields on an existing Jira issue.",
			parameters: {
				type: "object",
				properties: {
					issueKey: {
						type: "string",
						description: "Jira issue key (e.g. PROJ-123).",
					},
					summary: {
						type: "string",
						description: "Updated summary/title.",
					},
					description: {
						type: "string",
						description: "Updated description.",
					},
					priority: {
						type: "string",
						description: "Updated priority name.",
					},
					assignee: {
						type: ["string", "null"],
						description: "Updated assignee username, or null/empty string to unassign.",
					},
					labels: {
						type: "array",
						items: { type: "string" },
						description: "Updated labels list.",
					},
					components: {
						type: "array",
						items: { type: "string" },
						description: "Updated component names list.",
					},
					extraFields: {
						type: "object",
						description: "Optional additional Jira fields object.",
					},
				},
				required: ["issueKey"],
				additionalProperties: false,
			},
			handler: async (args) => {
				try {
					const { issueKey, summary, description, priority, assignee, labels, components, extraFields } = args || {};
					const res = await client.updateIssue(issueKey, {
						summary,
						description,
						priority,
						assignee,
						labels,
						components,
						extraFields,
					});
					const browseUrl = `${client.getBaseUrl()}/browse/${res.key}`;
					return `Updated Jira issue [${res.key}](${browseUrl}) (fields: ${res.updatedFields.join(", ")}).`;
				} catch (err) {
					return toFailure(err);
				}
			},
		},
	];
}
