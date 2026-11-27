// Shared fixtures for the workspace coordination suites (tickets 11–13).
//
// Real temporary git repositories, a real `git` runner shaped like `pi.exec`,
// and a fake pi host that records tools, handlers, messages and entries. The
// store must be exercised against real repositories — a linked worktree's
// `.git` is a file, and that shape is the whole reason the resolver uses
// `--git-common-dir` — while the session half only needs the fake host.

import { execFile as execFileCb, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import type { GitRun } from "../../orchestrator/workspace.ts";

const execFileP = promisify(execFileCb);

export function gitIn(dir: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

export function makeRunner(): GitRun {
	return async (args, cwd) => {
		try {
			const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
			return { stdout, stderr: "", code: 0, killed: false };
		} catch (error) {
			const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
			return {
				stdout: failure.stdout ?? "",
				stderr: failure.stderr ?? "",
				code: typeof failure.code === "number" ? failure.code : 1,
				killed: false,
			};
		}
	};
}

export interface RepoFixture {
	base: string;
	root: string;
	linked: string;
	other: string;
	outside: string;
	rootRegistry: string;
	linkedRegistry: string;
	otherRegistry: string;
	cleanup: () => Promise<void>;
}

/**
 * A main checkout with a linked worktree on its own branch, plus an unrelated
 * repository and a non-repository directory. `.git/pi-agents` is cleared
 * before/after each test by the caller through `resetRegistries`.
 */
export async function makeRepoFixture(prefix = "orchestrator-workspace-"): Promise<RepoFixture> {
	const base = await mkdtemp(path.join(tmpdir(), prefix));
	const root = path.join(base, "main");
	const linked = path.join(base, "linked");
	const other = path.join(base, "other");
	const outside = path.join(base, "outside");
	await mkdir(outside, { recursive: true });
	await mkdir(root, { recursive: true });
	gitIn(root, "init", "-b", "main", "-q");
	gitIn(root, "config", "user.name", "Workspace Harness");
	gitIn(root, "config", "user.email", "workspace@harness.invalid");
	await mkdir(path.join(root, "src", "nested"), { recursive: true });
	await writeFile(path.join(root, "README.md"), "workspace fixture\n");
	await writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n");
	await writeFile(path.join(root, "src/nested/b.ts"), "export const b = 2;\n");
	gitIn(root, "add", "-A");
	gitIn(root, "commit", "-q", "-m", "initial");
	gitIn(root, "worktree", "add", "-q", "-b", "linked-branch", linked);

	await mkdir(other, { recursive: true });
	gitIn(other, "init", "-b", "trunk", "-q");
	gitIn(other, "config", "user.name", "Workspace Harness");
	gitIn(other, "config", "user.email", "workspace@harness.invalid");
	await writeFile(path.join(other, "x.txt"), "other\n");
	gitIn(other, "add", "-A");
	gitIn(other, "commit", "-q", "-m", "other initial");

	return {
		base,
		root,
		linked,
		other,
		outside,
		rootRegistry: path.join(root, ".git", "pi-agents"),
		linkedRegistry: path.join(root, ".git", "pi-agents"), // the worktree resolves to the main checkout's store
		otherRegistry: path.join(other, ".git", "pi-agents"),
		cleanup: async () => {
			await rm(base, { recursive: true, force: true });
		},
	};
}

export async function resetRegistries(fixture: RepoFixture): Promise<void> {
	await rm(fixture.rootRegistry, { recursive: true, force: true });
	await rm(fixture.otherRegistry, { recursive: true, force: true });
}

export interface FakePi {
	tools: Map<string, Record<string, unknown>>;
	handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
	entries: { type: string; data: unknown }[];
	messages: { message: Record<string, unknown>; options: Record<string, unknown> | undefined }[];
	notifications: { message: string; type: string | undefined }[];
	registerTool: (definition: Record<string, unknown>) => void;
	appendEntry: (type: string, data: unknown) => void;
	sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => void;
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
	fire: (event: string, ...args: unknown[]) => Promise<void>;
}

export function fakePi(): FakePi {
	const tools = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	const entries: { type: string; data: unknown }[] = [];
	const messages: { message: Record<string, unknown>; options: Record<string, unknown> | undefined }[] = [];
	const notifications: { message: string; type: string | undefined }[] = [];
	const host: FakePi = {
		tools,
		handlers,
		entries,
		messages,
		notifications,
		registerTool: (definition) => {
			tools.set(String(definition.name), definition);
		},
		appendEntry: (type, data) => {
			entries.push({ type, data });
		},
		sendMessage: (message, options) => {
			messages.push({ message, options });
		},
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		fire: async (event, ...args) => {
			for (const handler of handlers.get(event) ?? []) await handler(...args);
		},
	};
	return host;
}

export interface FakeCtx {
	cwd: string;
	hasUI: boolean;
	ui: { notify: (message: string, type?: string) => void };
	isIdle: () => boolean;
	hasPendingMessages: () => boolean;
	signal: AbortSignal | undefined;
	sessionManager: { getSessionId: () => string };
}

export function fakeCtx(
	pi: FakePi,
	sessionId: string,
	cwd: string,
	overrides: Partial<Omit<FakeCtx, "ui">> & { notify?: (message: string, type?: string) => void } = {},
): FakeCtx {
	const { notify, ...rest } = overrides;
	return {
		cwd,
		hasUI: false,
		ui: {
			notify: (message, type) => {
				if (notify) notify(message, type);
				else pi.notifications.push({ message, type });
			},
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		sessionManager: { getSessionId: () => sessionId },
		...rest,
	};
}

export function toolExecute(pi: FakePi, name: string): (...args: unknown[]) => Promise<unknown> {
	const tool = pi.tools.get(name);
	if (!tool || typeof tool.execute !== "function") throw new Error(`tool ${name} was not registered`);
	return tool.execute as (...args: unknown[]) => Promise<unknown>;
}

export async function callTool(
	pi: FakePi,
	name: string,
	params: Record<string, unknown>,
	ctx: FakeCtx,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const result = (await toolExecute(pi, name)("call", params, undefined, undefined, ctx)) as {
		content: { type: string; text: string }[];
		details: Record<string, unknown>;
	};
	return { text: result.content.map((block) => block.text).join("\n"), details: result.details };
}
