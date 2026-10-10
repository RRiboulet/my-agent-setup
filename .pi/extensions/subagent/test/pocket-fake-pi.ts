// A stand-in for `pi --mode rpc`, for the supervisor tests.
//
// The supervisor's whole promise is that a child can die and come back with the
// conversation intact. That promise cannot be tested by mocking the child: the
// parts that matter — exit codes, signals, respawn argv, the pid changing — are
// process facts. So this is a real subprocess that speaks the subset of the RPC
// protocol pocket uses, in about a hundred lines.
//
// It is deliberately honest about pi's awkward bits:
//   - it writes its session file lazily, on the first prompt, exactly like pi
//   - it reports where the conversation lives from `get_state`, using the same
//     `--session-dir`/`--session-id`/`--session` flags the real one takes
//   - it restores the file it is pointed at, so a respawned child sees the
//     transcript its predecessor wrote

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

interface Args {
	// `--session-dir` is only passed when the child is naming a new file; a resumed
	// child gets `--session` alone. The directory comes from the file instead.
	sessionDir: string;
	sessionId: string;
	sessionPath: string | undefined;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { sessionDir: "", sessionId: "", sessionPath: undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index + 1];
		switch (argv[index]) {
			case "--session-dir":
				args.sessionDir = value;
				index += 1;
				break;
			case "--session-id":
				args.sessionId = value;
				index += 1;
				break;
			case "--session":
				args.sessionPath = value;
				index += 1;
				break;
			default:
				break;
		}
	}
	if (args.sessionDir === "" && args.sessionPath !== undefined) args.sessionDir = path.dirname(args.sessionPath);
	return args;
}

function sessionFileFor(args: Args): string {
	if (args.sessionPath !== undefined) return args.sessionPath;
	// pi names the file after the id but prefixes a timestamp, which is why the
	// supervisor has to take the path from the child rather than guess it.
	const dated = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(args.sessionDir, `${dated}-${args.sessionId}.jsonl`);
}

function send(record: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.sessionDir, { recursive: true });

const transcript = sessionFileFor(args);
let messages: Array<Record<string, unknown>> = [];
try {
	// A file that already exists (the resume case) contributes its messages; a
	// fresh session starts empty, like pi does.
	messages = readFileSync(transcript, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
} catch {
	messages = [];
}

send({ type: "ready" });

let dead = false;
const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line: string) => {
	if (dead) return;
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return;
	}
	const id = typeof record.id === "string" ? record.id : "";
	const type = typeof record.type === "string" ? record.type : "";

	switch (type) {
		case "get_state":
			send({ type: "response", id, command: "get_state", success: true, data: { sessionFile: transcript, cwd: process.cwd() } });
			break;
		case "get_messages":
			send({ type: "response", id, command: "get_messages", success: true, data: { messages } });
			break;
		case "prompt": {
			// The transcript is written here, not at start-up: pi does the same,
			// so a recorded session file very often does not exist yet and the
			// supervisor's resume path has to cope with that.
			const message = String((record as { message?: string }).message ?? "");
			const user = { role: "user", content: message };
			writeFileSync(transcript, `${messages.concat(user).map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			messages = messages.concat([user]);
			send({ type: "agent_start" });
			send({ type: "response", id, command: "prompt", success: true, data: { disposition: "started" } });
			setTimeout(() => {
				const reply = { role: "assistant", content: `echo: ${message}` };
				appendFileSync(transcript, `${JSON.stringify(reply)}\n`);
				messages = messages.concat([reply]);
				send({ type: "agent_settled" });
			}, 10);
			break;
		}
		default:
			send({ type: "response", id, command: type, success: true, data: {} });
			break;
	}
});

process.on("SIGTERM", () => {
	dead = true;
	process.exit(0);
});
process.on("SIGINT", () => {
	dead = true;
	process.exit(0);
});
