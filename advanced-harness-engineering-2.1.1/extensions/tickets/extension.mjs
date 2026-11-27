import { joinSession } from "@microsoft/copilot-sdk/extension";

import { createTicketTools } from "./tools.mjs";
import { runTicketsCommand } from "./ui.mjs";

let activeSession = null;
let lastWorkingDirectory = process.cwd();
const uiState = { lastSetId: null, includeWorktrees: false };

async function getRootDir() {
	try {
		const ctx = await activeSession?.rpc?.metadata?.getWorkingDirectoryContext?.({});
		const cwd = ctx?.workingDirectory || ctx?.cwd || ctx?.gitRoot;
		if (typeof cwd === "string" && cwd.trim()) {
			lastWorkingDirectory = cwd;
			return cwd;
		}
	} catch {
		// Fall back to tracked working directory / process.cwd()
	}
	return lastWorkingDirectory || process.cwd();
}

const session = await joinSession({
	tools: {
		definitions: createTicketTools({ getRootDir }),
	},
	hooks: {
		handlers: {
			onSessionStart: async (input) => {
				const dir = input?.workingDirectory || input?.cwd;
				if (typeof dir === "string" && dir.trim()) {
					lastWorkingDirectory = dir;
				}
			},
		},
	},
	interaction: {
		commands: [
			{
				name: "tickets",
				description:
					"Interactive browser for to-tickets markdown tickets (status, frontier, AC checklists, /implement)",
				handler: async (context) => {
					const rootDir = await getRootDir();
					await runTicketsCommand({
						session,
						rootDir,
						args: context.args ?? "",
						state: uiState,
					});
				},
			},
		],
	},
});

activeSession = session;
