import { joinSession } from "@microsoft/copilot-sdk/extension";

import { createJiraTools } from "./tools.mjs";

await joinSession({
	tools: {
		definitions: createJiraTools(),
	},
});
