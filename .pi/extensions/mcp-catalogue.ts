// /mcp-catalogue — install this package's MCP servers into the agent dir without
// leaving the session.
//
// The failure this prevents, the session side of the one
// `tools/mcp-catalogue.mjs` describes: `pi install` ships this package's
// extensions and skills and none of its MCP servers, because the `pi` manifest
// has no MCP key and pi reads MCP configuration only from `<agent dir>/mcp.json`
// and a trusted project's `.pi/mcp.json`. A colleague therefore gets the
// operator's setup minus Figma and Playwright, and the obvious cure — `pi mcp
// add` on every machine — cannot write a *disabled* entry, so it switches both
// on in every project at once, with an OAuth prompt and two background processes
// attached. This command is that installer's session surface; the shell surface
// is `bin/mcp-catalogue`, and both run the same merge.
//
// Deliberately thin. The merge, the catalogue's validation and its
// add-only-and-report-what-happened semantics live in the module, because a
// second copy of them is how the two surfaces would drift. This file only
// decides what to say about the record the module returns.
//
// What it does not do is as load-bearing as what it does: it registers no tool
// and no MCP server, and it connects to nothing — writing a disabled entry is a
// file write, and a server stays off until a project asks for it. It also never
// reads `ctx.cwd`. The file it writes is the agent dir's even when the session
// sits in a trusted project with its own `.pi/mcp.json`, because writing the
// project's file is how one project's opt-in would leak into every other.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
// Resolved against this module's own URL, never the session's cwd: a
// package-installed copy of this file lives in
// `~/.pi/agent/git/<host>/<org>/<repo>/.pi/extensions/` with `tools/` beside it,
// while the session may sit anywhere.
import { installCatalogue } from "../../tools/mcp-catalogue.mjs";

/** The record `installCatalogue()` returns, as far as this command reads it. */
interface InstallResult {
	ok: boolean;
	action: "created" | "merged" | "unchanged" | "kept" | "none";
	path: string;
	added: string[];
	skipped: string[];
	problems: string[];
}

interface Report {
	text: string;
	level: "info" | "warning" | "error";
}

const USAGE: Report = {
	level: "warning",
	text:
		"usage: /mcp-catalogue — it takes no arguments.\n" +
		"Every catalogue server is installed disabled; a project enables the ones it wants in its .pi/mcp.json, or through /mcp.",
};

/** One message per run: the file, then what was added, skipped, or refused. */
function describeInstall(result: InstallResult): Report {
	if (!result.ok) {
		return {
			level: "error",
			text: ["mcp-catalogue: nothing was written", ...result.problems.map((problem) => `  ${problem}`)].join("\n"),
		};
	}

	const names = (list: string[]) => list.join(", ");
	const skipped = result.skipped.length > 0 ? ` — skipped ${names(result.skipped)} (already present)` : "";
	// "kept" only happens in the module's --if-missing seeding mode, which a person
	// asking for servers never is; it reads as "nothing added", correctly.
	const text =
		result.action === "created"
			? `mcp-catalogue: created ${result.path} — added ${names(result.added)}, all disabled, so nothing connects until a project enables one`
			: result.action === "merged"
				? `mcp-catalogue: added ${names(result.added)} to ${result.path}${skipped}`
				: `mcp-catalogue: nothing added to ${result.path}${skipped}`;
	return { level: "info", text };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("mcp-catalogue", {
		description: "Install this package's MCP servers into the agent dir, all disabled (/mcp-catalogue)",
		handler: async (args, ctx) => {
			if ((args ?? "").trim() !== "") {
				// `/mcp-catalogue figma` is a reasonable guess — "install, and enable
				// this one" — that this command does not do, so it says so rather than
				// installing everything and looking like it obeyed.
				speak(ctx, USAGE);
				return;
			}
			// Merge, never the module's --if-missing seeding mode: a person asked, so
			// adding the servers their agent dir has not got yet is the point. The
			// module resolves the agent dir the way pi and the shell entry point do
			// (PI_CODING_AGENT_DIR, else ~/.pi/agent) and reports failure in the
			// record instead of throwing.
			speak(ctx, describeInstall(installCatalogue({ mode: "merge" })));
		},
	});
}

function speak(ctx: ExtensionCommandContext, report: Report): void {
	if (ctx.hasUI) {
		ctx.ui.notify(report.text, report.level);
		return;
	}
	// print and JSON sessions have no notification area; stdout is what a script or
	// an agent reads, and a refusal belongs on stderr where the shell command puts it.
	if (report.level === "error") console.error(report.text);
	else console.log(report.text);
}
