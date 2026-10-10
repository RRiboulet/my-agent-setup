// spawn-args — the arguments that make a pi child the pocket session it should be
//
// Two flags do the work that a pocket session's durability is built on:
//
//   --session-dir  writes pi's session file inside this session's own directory,
//                  so nothing is ever shared between sessions
//   --session-id   gives a new session file a name containing the pocket id, so
//                  a human browsing the data root can tell sessions apart
//   --session      resumes an existing file
//
// The catch, verified against the installed pi, is that `--session-id` and
// `--session` are mutually exclusive: passing both exits with
// "Error: --session-id cannot be combined with --session" and code 1, which is a
// child that dies before it can answer a single request. So they are two modes,
// not one:
//
//   no file yet    --session-dir <dir> --session-id <id>   (name it and create)
//   file recorded  --session <path>                        (resume it)
//
// Naming is only interesting for a file that does not exist yet — once a file
// exists, its name is whatever it already is, so pairing it with `--session`
// would buy nothing and cost the session.
//
// No --cwd flag exists; pi takes its working directory from its process cwd, so
// that is passed to spawn() alongside these.

import { existsSync } from "node:fs";

/** Resume an existing recorded session file, or name a new one. Never both. */
export function resumeArgs(sessionId: string, sessionDir: string, sessionFile: string | undefined): string[] {
	if (sessionFile !== undefined && existsSync(sessionFile)) return ["--session", sessionFile];
	return ["--session-dir", sessionDir, "--session-id", sessionId];
}

/** Everything a freshly spawned child needs, in order. */
export function spawnArgs(options: {
	sessionId: string;
	sessionDir: string;
	sessionFile: string | undefined;
	model?: string | undefined;
	thinkingLevel?: string | undefined;
}): string[] {
	const args = ["--mode", "rpc"];
	args.push(...resumeArgs(options.sessionId, options.sessionDir, options.sessionFile));
	if (options.model !== undefined) args.push("--model", options.model);
	if (options.thinkingLevel !== undefined) args.push("--thinking", options.thinkingLevel);
	return args;
}
