# A phone-native durable coding agent on Android

**Pi Durable as the kernel, a web client as the passive UI, a foreground service owning SQLite.**

Status: plan, not implementation. Everything below was checked against the
actual sources listed in [§0](#0-sources-checked); anything I could not verify
is marked as an assumption or as a spike.

The native Android layer is a Kotlin host shell only: foreground service,
WebView/browser container, notifications, wake locks, credential access, and
narrow phone-capability bridges. The transcript, composer, status strip, task
tree, and subagent views are a web app served by the kernel over loopback and
hosted in a WebView or the device browser. This is a deliberate choice: a web
client can be hot-reloaded without reinstalling the APK, which is what makes
the self-building loop in §4 practical.

---

## Table of contents

- [0. Sources checked](#0-sources-checked)
- [1. Kernel architecture on Android](#1-kernel-architecture-on-android)
  - [1.1 Three premises to correct first](#11-three-premises-to-correct-first)
  - [1.2 The constraint that decides the architecture](#12-the-constraint-that-decides-the-architecture)
  - [1.3 Option A — bundled Linux/Node runtime](#13-option-a--bundled-linuxnode-runtime)
  - [1.4 Option B — Hermes/JS engine, no shell](#14-option-b--hermesjs-engine-no-shell)
  - [1.5 Option C — remote execution bridge](#15-option-c--remote-execution-bridge)
  - [1.6 Decision](#16-decision)
  - [1.7 Storage: SQLite vs JSONL](#17-storage-sqlite-vs-jsonl)
  - [1.8 Process model: who owns what](#18-process-model-who-owns-what)
  - [1.9 The kernel↔UI contract](#19-the-kernelui-contract)
  - [1.10 Foreground service specifics](#110-foreground-service-specifics)
- [2. Extension porting strategy](#2-extension-porting-strategy)
  - [2.1 The target vocabulary](#21-the-target-vocabulary)
  - [2.2 The replay policy rule](#22-the-replay-policy-rule)
  - [2.3 Decision rule for `replay`](#23-decision-rule-for-replay)
  - [2.4 Per-extension plan](#24-per-extension-plan)
  - [2.5 Subagent: the native ownership model](#25-subagent-the-native-ownership-model)
  - [2.6 Hooks worth adding on a phone](#26-hooks-worth-adding-on-a-phone)
  - [2.7 Skills become sections](#27-skills-become-sections)
- [3. UI/UX plan (web client in a native host)](#3-uiux-plan-web-client-in-a-native-host)
  - [3.1 The invariant](#31-the-invariant)
  - [3.2 Minimum viable screen set](#32-minimum-viable-screen-set)
  - [WebView/browser specifics](#webviewbrowser-specifics)
  - [3.3 Paged loading](#33-paged-loading)
  - [3.4 Task status indicators](#34-task-status-indicators)
  - [3.5 Subagent visualization](#35-subagent-visualization)
  - [3.6 The Resume affordance](#36-the-resume-affordance)
  - [3.7 UI state rules](#37-ui-state-rules)
- [4. The self-building loop](#4-the-self-building-loop)
  - [4.1 What "self-building" means here](#41-what-self-building-means-here)
  - [4.2 Three reload paths, three different mechanisms](#42-three-reload-paths-three-different-mechanisms)
  - [4.3 Restarting the worker is a normal event](#43-restarting-the-worker-is-a-normal-event)
  - [4.4 The workflow](#44-the-workflow)
  - [4.5 Smallest possible first milestone](#45-smallest-possible-first-milestone)
- [5. Risks and decision points](#5-risks-and-decision-points)
- [6. Phased plan](#6-phased-plan)
- [Appendix A — Verified API surface](#appendix-a--verified-api-surface)
- [Appendix B — Open questions to answer before Phase 1](#appendix-b--open-questions-to-answer-before-phase-1)

---

## 0. Sources checked

| Source | What was read | Why it matters |
|---|---|---|
| `earendil-works/pi` monorepo, `packages/durable` @ `1.3.0` | `README.md` (869 lines), `docs/spec.md` (5618 lines), and the source of `src/index.ts`, `src/types.ts`, `src/tasks.ts`, `src/env/index.ts`, `src/harness/{harness,tool,types,define,registry,view,live,task-graph,events,agent,scheduler}.ts`, `src/storage/{sqlite,node,jsonl,memory}/*`, `src/tools/*`, `src/testing/*` | Primary reference. Line citations below are `packages/durable/…` in that repo at tag `v1.3.0`. |
| `earendil-works/pi` monorepo, `packages/chord` @ `1.3.0` | `src/sqlite/database.ts` (`SqliteDatabase`, `SqliteExecutor`), `src/sqlite/node.ts`, `src/delta/index.ts` (`Op`, `WireOp`) | The portable seams: an async SQLite facade and a tuple-based delta format. |
| npm `@earendil-works/pi-durable@1.3.0` | `package.json` `exports` map, `dependencies` | The exact subpath imports a client may use. |
| `sugarforever/pi-durable-expo-env` @ `0.1.0` | `README.md`, `src/core.ts` (the whole `ExecutionEnv` implementation), `src/index.ts` (the Expo backend), `package.json` | The only existing mobile `ExecutionEnv`. It answers "can Pi Durable run without Node?" — yes, with no shell. It does **not** solve storage. |
| `earendil-works/pi` monorepo, `packages/env` | `README.md` | `RemoteExecutionEnv` / `LocalExecutionEnv` over a Rust daemon — the supported remote-execution option, and it lists Android (Termux) as a supported *remote* system. |
| `RRiboulet/my-agent-setup` (this repo) | All 13 extensions and 6 skills, plus `AGENTS.md` | The migration surface. |
| `MaliNamNam/pi-phone`, `petrroll/pocket-pi`, `heikeyangle-code/pi-android`, `TannerMidd/pi-pocket` | READMEs | Precedents for the runtime question. Two of the four are commonly mis-cited; see §1.1. |
| Web search: "Pi Durable Android foreground service SQLite storage" | — | Confirms **no** public project currently runs a Pi Durable harness inside an Android foreground service. The service layer is unproven territory; §5 treats it as the top risk. |

---

## 1. Kernel architecture on Android

### 1.1 Three premises to correct first

**`pi-phone` is not a runtime you can bundle.** `MaliNamNam/pi-phone` describes
itself as "a phone-first remote UI for Pi that lets you drive a real Pi
session from your phone… starts a small local web server, mirrors your current
live Pi CLI session over WebSocket to a mobile web app". Its requirements are
"Pi installed and working" and "Node.js available". It is the *thing you are
replacing*, not a building block. The adjacent projects, and what each
actually contributes:

| Project | What it bundles | Notes |
|---|---|---|
| `petrroll/pocket-pi` | A **Termux runtime** + Node + npm packages, an **Android service** that supervises `pi --mode rpc` + a dashboard's Node server, a Compose WebView, and an on-device HTTP bridge on `127.0.0.1:9998` | 68 MB APK, aarch64 only, sideload, 3–5 min first-launch bootstrap. Uses the *older* `pi-coding-agent`, not Pi Durable. Closest precedent for "APK + Termux + Android service + local bridge". |
| `heikeyangle-code/pi-android` | proot Ubuntu glibc userland with Node 24 | Argues `nodejs-mobile` is frozen at Node 18, below Pi's ≥ 22.19 floor. |
| `TannerMidd/pi-pocket` | Nothing — Pi Durable + Node on the host, **browser** UI | "Runs on Linux, macOS, Windows, and Android (Termux)". Proves Pi Durable runs on a phone under Termux; proves nothing about a native Android UI or a foreground service. |
| `sugarforever/pi-durable-expo-env` | Nothing — an `ExecutionEnv` adapter | No Node runtime; no shell; no storage. See §1.4. |

**`nodejs-mobile` is not a candidate.** Pi requires Node ≥ 22.19
(`packages/durable` targets it too), and `nodejs-mobile` is frozen at Node 18.

**Pi Durable has no "skills" concept.** It has *sections*
(`section(key, render)`), *hooks*, *tools*, *tasks*, *wraps* and *documents*.
Your six skills therefore have to become sections (plus tools for their
scripts) — §2.7.

**The UI is a web client, not Compose.** The passive client is a browser-based
app served over loopback and hosted in a WebView or the device browser.
Jetpack Compose is optional for tiny native shell screens only. The
transcript, composer, task tree and subagent views must be web-based so they
can be hot-reloaded without reinstalling the APK. This is also what makes the
self-building loop in §4.2 (R2) work.

### 1.2 The constraint that decides the architecture

Two facts from the source, together, decide almost everything:

**(a) The harness is TypeScript and runs on a JavaScript runtime.** There is no
"Pi Durable engine" to link against from Kotlin. The durable core is portable
(its SQLite and JSONL cores "run without Node APIs", per the README), but the
*product* — `@earendil-works/pi-ai` providers, `@earendil-works/pi-codemode`
(QuickJS/WASM), the tools, the extensions — is a JS program.

**(b) The UI must not own the runtime that holds the durable state.** Your
requirement is "a native Android host with a web UI that only renders
committed state". React Native's JS context is bound to the Activity: there is
no supported way to keep a live JS runtime with open WebSockets and streaming
model responses inside an Android `Service` process. So the RN shape
("one JS runtime, React UI") fights the foreground-service requirement
directly. The Compose shape ("Kotlin UI in the Activity, kernel in a service")
gets the process separation right but the wrong UI technology: Compose cannot
be hot-reloaded at runtime. The WebView shape ("web client in a WebView,
kernel in a service") gets both the process separation and the hot-reload
property.

**Therefore: the kernel is a separate process from the UI, and the UI is a web
client served by the kernel.** The kernel is a JS runtime hosted by the
foreground service; the web client runs in a WebView or browser and talks to
the kernel over loopback HTTP/WS. The Activity/WebView can be destroyed and
recreated at will — rotation, low memory, user swipe, WebView renderer death —
without touching the kernel, the storage, or the in-flight agent run. This
also gives the self-building loop a real hot-reload path: the web UI can be
rebuilt or HMR-reloaded without an APK reinstall. That property *is* the
"phone-native durable agent" you are after, and it is exactly the property
Termux cannot give you (there, the agent dies with the terminal session).

The remaining question is **which JS runtime**, and therefore **which
ExecutionEnv**.

### 1.3 Option A — bundled Linux/Node runtime

**Shape.** The APK ships a Node binary (a Termux prefix, or a custom
bionic-linked build). The foreground service starts it; the Node process is the
kernel.

**What you get, verbatim from the source:**

- `openNodeSqliteStorage(path)` from `@earendil-works/pi-durable/storage/sqlite/node`
  (`src/storage/sqlite/node.ts:15`) — which is `openNodeSqliteDatabase(path)`
  from `@earendil-works/chord/sqlite/node`, which is `DatabaseSync` from
  `node:sqlite`. WAL mode, `synchronous = NORMAL`.
- `NodeExecutionEnv` from `@earendil-works/pi-durable/env/node` — a **complete
  shell and filesystem**: `bash` works, `git` works, `tmux` works, your
  `repo-explorer`, `review`, `native-web-search` and `btw` extensions work
  essentially unchanged.
- The **entire existing extension set** works, because your extensions are
  plain TS running on Node.

**What it costs.**

- APK size: a Termux prefix is tens of megabytes. `pocket-pi` ships 68 MB.
- `node:sqlite` must exist in the build. It landed in Node 22.5 as
  experimental; a Termux Node 24/25 build should have it, but **this must be
  verified, not assumed** (spike S0.1).
- arm64 only, in practice.
- Play Protect warnings on sideload; sideloading is fine for a personal tool.
- If you use proot rather than a native bionic build, syscall translation
  costs real time on every file operation.

**Verdict: the only option that preserves your whole agent setup.** It is also
the option with the most prior art (`pocket-pi`).

### 1.4 Option B — Hermes/JS engine, no shell

**Shape.** The APK embeds a JS engine (Hermes via RN, or V8/QuickJS via JNI).
The durable core runs there. Storage is the portable core over an Android
SQLite facade (§1.7). The `ExecutionEnv` is a mobile filesystem adapter.

**What exists today:** `pi-durable-expo-env` 0.1.0. Its `createWorkspaceEnv`
(`src/core.ts`) is a complete, portable `ExecutionEnv` with a pluggable
`WorkspaceBackend` — the exact seam an Android app would fill. Its limits are
declared, not discovered:

| Capability | Behaviour |
|---|---|
| read/write/append/truncate, metadata, paged dir reads, rename, remove, temp files | supported, bounded (8 MiB/file, 32 MiB retained readers, 10 000 entries/dir by default) |
| `flushFile`, `canonicalPath`, `watch` | `not_supported` |
| `exec` | `shell_unavailable` (or `aborted`) |
| `listFiles` (optional method) | not implemented |
| Atomicity | "no atomic transaction, fsync guarantee or crash-proof write protocol" |
| Verification | 30 tests; **"The complete Pi environment conformance suite is not claimed."**; "Android native compilation and emulator/device execution have not been tested." |

**The blocker for a coding agent:** no shell means no `git`, no `gradle`, no
`npm test`, no `tmux`. Your `repo-explorer`, `review`, `review-triage`
(evidence collection runs `git diff`), `native-web-search` (spawns a Node
script) and `btw` (tmux) all become non-functional. A coding agent that cannot
run the tests is a chat bot.

**Verdict: viable as a *durability-first* fallback, not as the target.** It
buys you a 15 MB APK and no sideload, at the cost of the agent's core
competence.

### 1.5 Option C — remote execution bridge

**Shape.** The kernel lives on the phone; the *tools* execute on a machine you
control, reached over Tailscale. This is upstream-supported:
`@earendil-works/pi-env` ships `RemoteExecutionEnv` and a Rust daemon that
"speaks a framed protocol on stdin and stdout" and performs file operations and
commands on the remote host; supported remote systems include "Linux, macOS,
Android (Termux) and Windows, on x86-64 and arm64".

Two sub-variants, and the distinction matters:

- **C1 — kernel on the phone, execution remote.** Durable state, transcripts
  and task graph live in the phone's SQLite. `ExecutionEnv` =
  `RemoteExecutionEnv` pointed at your dev box over Tailscale SSH. The phone
  survives; the work happens where the repo is.
- **C2 — kernel on the box, phone is a thin client.** This is `pi-pocket`/
  `pi-phone` today. It does not replace your Tailscale setup, it *is* your
  Tailscale setup. Rejected as the target.

**Verdict: C1 is the best fallback and a good first production mode.** It
gives a shell, a real filesystem and `git` with zero runtime bundling, and it
de-risks the whole project (no proot, no Termux prefix, no APK bloat). Its
cost is that the phone is not self-sufficient — exactly the property you are
building to get — and it keeps a Tailscale dependency in the loop.

Note the combination that makes C1 attractive as *phase 1 of Option A*: the
IPC layer, the storage layer, the UI, and the durability model are all
identical between A and C1. Only the `ExecutionEnv` implementation changes. So
C1 is not a throwaway: build the app so that swapping the env is one line.

### 1.6 Decision

**Target: Option A** — Kotlin Android host shell, Pi Durable kernel in a
foreground service on a bundled Node runtime, a web client served over loopback
and hosted in a WebView, `NodeExecutionEnv` (decorated with an Android bridge
for phone capabilities), SQLite owned by the kernel process.

**Ship C1 first if the Phase 0 spike on Node-on-Android fails.** The app, the
IPC, the storage, the UI and every ported extension are identical; only the
`ExecutionEnv` factory differs:

```ts
// kernel/env.ts — the single seam
export function envFor(cwd: string): ExecutionEnv {
  // Option A: full local shell
  return decorate(new NodeExecutionEnv({ cwd }), androidBridge);
  // Option C1: remote shell over Tailscale
  // return decorate(new RemoteExecutionEnv({ connection, id: "pi-env:box", cwd }), androidBridge);
  // Option B: local files, no shell
  // return createWorkspaceEnv({ backend: androidBackend, rootUri });
}
```

**Escalation order, and why:** Option A is chosen because the migration cost
of your 13 extensions is near zero there and near total elsewhere. Option C1 is
the fallback because it is the only configuration that works *today* with
zero new runtime work. Option B is last because it removes the shell, which
removes the product.

### 1.7 Storage: SQLite vs JSONL

**SQLite. Unambiguously.**

From the README's storage table:

> **SQLite** — `openNodeSqliteStorage(file)` … One database file. WAL mode with
> `synchronous = NORMAL`: commits survive process crashes; the newest may be
> lost on power or host failure.
>
> **JSONL** — `openNodeJsonlStorage(directory, context)` … Append-only files in
> one directory. Pass `{ fsync: true }` to flush before each commit marker.
> **Keeps the whole history in memory too, so memory grows with it; use SQLite
> for long-running agents.**

The deciding factors, in order:

1. **Memory.** JSONL keeps the whole history resident. A phone running an
   agent for a week does not have that memory, and Android will kill the
   process for it.
2. **Atomicity.** Durable's core promise is that a commit is all-or-nothing:
   "an atomic write… can append entries, edit documents, and create tasks
   together; either all of it is stored or none of it is". JSONL's
   append-only log gives you that at the cost of the memory above, but SQLite
   gives it *and* bounded memory *and* indexed queries over entries, tasks and
   documents — which the UI needs for paged loading (`conversation.entries(query,
   limit, cursor, context)`).
3. **Crash semantics match the platform.** WAL + `synchronous = NORMAL` means
   "commits survive process crashes". Android kills processes; it does not
   usually cut power. You lose at most the newest commits on a battery death —
   the same exposure as any SQLite app on Android.
4. **Query surface.** The SQLite schema has dedicated indexes for
   `conversations_by_owner_task`, `entries_by_conversation`,
   `tasks_by_status`, `documents_by_scope_kind` (`src/storage/sqlite/schema.ts`)
   — the exact access patterns a subagent tree and a paged transcript need.
   JSONL would mean scanning files.

**The Android caveat, and it is a real one.** `openNodeSqliteStorage` is
Node-only (`node:sqlite`). Under Option B (Hermes) you cannot use it. But the
portable core is exported and takes a facade:

```ts
// src/storage/sqlite/index.ts
export { SqliteStorage, type SqliteStorageOptions } from "./storage.ts";
// src/storage/sqlite/storage.ts imports only from @earendil-works/chord — no Node APIs.
```

and the facade contract is small (`packages/chord/src/sqlite/database.ts`):

```ts
export interface SqliteDatabase extends SqliteExecutor {
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface SqliteExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: SqliteValue[]): Promise<void>;
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
}
```

with two rules an Android adapter must honour: the transaction handle expires
when the callback settles, and "Adapters must queue unrelated operations and
other transactions until the transaction finishes".

**Spike S0.2 implements exactly this facade over `android.database.sqlite` and
runs it against `registerStorageConformance` from
`@earendil-works/pi-durable/testing`.** That is a cheap, decisive test, and
it also de-risks Option B for free.

**One more storage rule you must internalize:** "One process owns a storage at a
time; there is no cross-process locking." Only the kernel process opens the Pi
database. The Compose UI never touches the `.sqlite` file — it reads through
the kernel's IPC. This is not a style preference; two writers is a corruption
risk, and the `prefix` option exists only for *sharing a database with host
tables in the same process*, not for sharing across processes.

### 1.8 Process model: who owns what

```
┌───────────────────────────── APP (one uid) ──────────────────────────────┐
│                                                                          │
│  Activity (WebView host)            ForegroundService                    │
│  ┌────────────────────┐             ┌──────────────────────────────┐     │
│  │ Kotlin host shell  │             │ supervises: node kernel      │     │
│  │ ┌────────────────┐ │◄───────────►│  ┌────────────────────────┐  │     │
│  │ │ Web client     │ │static assets│  │ Pi Durable kernel      │  │     │
│  │ │ (HTML/JS)      │ │ + WS/HTTP   │  │  Harness               │  │     │
│  │ └────────────────┘ │ 127.0.0.1   │  │  ├ registry            │  │     │
│  │ holds NO durable   │  + bearer   │  │  ├ models (pi-ai)      │  │     │
│  │ state, only a      │             │  │  └ env (ExecutionEnv)  │  │     │
│  │ projection of it   │             │  └───────────┬────────────┘  │     │
│  └────────────────────┘             └──────────────┼───────────────┘     │
│                                                    │                     │
│                                     app-private /data/data/<pkg>/        │
│                                        pi/session.sqlite   (WAL)         │
│                                        pi/workspace/       (files)       │
│                                        pi/kernel.log                     │
└──────────────────────────────────────────────────────────────────────────┘
```

Rules, in order of how much they matter:

1. **Exactly one kernel process at a time.** The service holds a `FileLock`
   on `pi/kernel.lock` and passes the fd to the child; a second kernel refuses
   to start. This is the enforcement of "one process owns a storage at a time".
2. **The kernel owns the database.** The Activity never opens it.
3. **The Activity is disposable.** Rotation, config change, low memory,
   "don't keep activities" — the Activity dies and is recreated; the kernel,
   the storage and the run are untouched. This is the single most important
   property of the design and the reason the kernel is not in the Activity.
4. **Graceful stop is the default, not the exception.** `onDestroy` sends
   `SIGTERM`; the kernel traps it and calls `harness.close(context)`. This
   matters more on Android than anywhere else — see §5 R3.
5. **The service supervises.** If the kernel exits, the service restarts it and
   the kernel calls `Harness.open(...)` + `harness.resume()`, which picks up
   whatever the last process left unfinished ("Work interrupted by a crash or
   close stays pending. `resume()` starts the task scheduler").
6. **The WebView is disposable and untrusted.** It holds no durable state and
   never opens the SQLite file. It may be killed by the WebView renderer
   process death, rotation, or low memory; reconnect always starts from a
   fresh snapshot (§3.7).

### 1.9 The kernel↔UI contract

The UI must render committed state and nothing else. Pi Durable already has the
right primitives; the only question is which to expose.

**Available, from the source:**

| Primitive | Shape | Use |
|---|---|---|
| `conversation.viewState(context)` | `AttachedReplicatedState<ConversationView>`; `ConversationView = { conversation, entries, docs }` | Disposable read-only state; updates after every commit that touches it. |
| `conversation.watch(context)` | `ConversationWatch`; `watch.start(async (value, ops) => { await send(ops); })` | The README's own comment: *"for example to a remote client that applies them"*. `ops` are Chord `Op`s. |
| `watchEvents(harness, conversationId, context)` | `AgentEventStream`: a `snapshot` then batches of coding-agent-style events (`message_start`, `message_update`, `tool_execution_start`, …) | Derived from commits, one batch per commit; deltas for text/thinking/tool output. "When a consumer falls more than 100 batches behind, it receives a fresh `snapshot` event instead." |
| `harness.watchTaskGraph(context)` | `TaskGraphWatch` | The task tree: every live task with owner edge, status and owned conversations. |
| `conversation.entries(query, limit, cursor, context)` | `Page<EntryRecord, Cursor>` | Paged history. |
| `harness.inspect(context)` | `HarnessInspection` | Point-in-time: live tasks + unsettled submissions. |

**Chosen contract: a semantic event layer, not raw Chord ops.**

Chord's `Op` format is a small tuple language —

```ts
// packages/chord/src/delta/index.ts
export type Op =
  | readonly ["r", JsonValue] | readonly ["s", NonEmptyPath, JsonValue]
  | readonly ["d", NonEmptyPath] | readonly ["a", NonEmptyPath, string]
  | readonly ["t", NonEmptyPath, number] | readonly ["p", Path, number, number, JsonValue[]]
  | readonly ["m", Path, number[]];
```

— and the reference implementation (`apply-immutable-trusted.ts`) is portable.
You *could* port it to Kotlin and forward raw ops. I recommend against it for v1:
the Kotlin side would then re-implement Chord's semantics, and every divergence
is a rendering bug that looks like a durability bug. Instead the **kernel
translates** the committed state into a small, purpose-built, versioned event
schema, where the translation lives in JS next to the semantics it comes from.

```
WS  /v1/events          →  { t:"snapshot", … }  then  { t:"batch", … }
POST /v1/commands/…     →  submit | abort | compact | reset | resume
                            | retryTask | abortTask | fork | entries | steer
```

In development, the WebView may load a Vite/Webpack dev server over `adb
reverse` or a kernel-proxied dev endpoint so the web UI gets hot-module
replacement. In production, the kernel serves the built assets from the
APK/workspace at `GET /`. The event protocol is identical in both modes.

The event vocabulary (v1):

| Event | Payload | Derived from |
|---|---|---|
| `snapshot` | full `ConversationView` + task graph + agent + usage + inbox | `viewState()`, `taskGraph()` |
| `entry` | the `EntryRecord` | `watchEvents` |
| `doc` | a document patch (`pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`, extension docs) | `watchDoc` |
| `task` | a task-graph node | `watchTaskGraph` |
| `run` | `{ busy, generation?, tools[], compactions[] }` | `docs["pi.live"]` |
| `usage` | token/cost totals | `docs["pi.usage"]` |
| `reset` | "resync from a fresh snapshot" | emitted by the kernel on desync |

**Why a semantic layer and not raw ops:** the UI's needs are "append an entry",
"this tool call's output grew", "this task is now waiting on X". Those are
domain facts. Chord ops are a *storage* delta format. Translating in the kernel
means the Kotlin client has ~20 message types instead of a JSON-patch engine
plus Pi's document model, and the translation is unit-testable in JS against
the conformance suite.

**Snapshot + delta, always.** Every reconnect starts from a snapshot. The UI
can therefore be destroyed and rebuilt at any moment with zero loss, which is
the mechanical guarantee behind "the UI never owns progress" (§3.1). A `reset`
event tells the client to drop everything and take a new snapshot — the kernel
emits it whenever it detects the client fell more than 100 batches behind
(the same threshold `watchEvents` uses). The web client must treat a `reset`
event as "drop all local projection and refetch `/v1/snapshot`." It must never
reconcile local state against the kernel.

**Transport.** Loopback HTTP + WebSocket on `127.0.0.1`, with a per-launch
bearer token, exactly as `pocket-pi` does with its `127.0.0.1:9998` bridge.
Binding to `127.0.0.1` (not `0.0.0.0`) plus the token keeps other apps on the
device out; add `android:usesCleartextTraffic` scoped to loopback or use a
`NetworkSecurityConfig` that permits cleartext only for `127.0.0.1`.

### 1.10 Foreground service specifics

- **Type.** Android 14 (API 34) requires a `foregroundServiceType` and the
  matching permission. `dataSync` is the honest fit (the service is moving
  data for the agent) but it has a **6-hour-per-24h hard cap** on Android 15+.
  `specialUse` has no cap but requires a justification in the Play listing.
  For a sideloaded personal tool, `specialUse` is the pragmatic choice.
- **Notification.** A persistent, low-importance notification showing the run
  state ("Working…", "Waiting for you", "Idle"). It is also the only honest
  way to tell the user the agent is alive.
- **Wake lock.** A partial `WakeLock` only while the harness reports
  `wake().active`. The kernel already computes this: `Wake = { active: boolean;
  at?: number }`.
- **Sleeping tasks → AlarmManager.** Do **not** let Pi Durable arm its own
  timers for sleeps. Pass `HarnessOptions.onWake` and let the host arm the
  wakeup:

  ```ts
  // HarnessOptions.onWake?: (wake: Wake) => void   (src/harness/types.ts:648)
  // "With it, the Harness arms no timer for them: it calls onWake after open
  //  and whenever Harness.wake() changes, and the host arms its own wakeup …
  //  and calls resume() when it fires."
  ```

  Map `wake.at` to `AlarmManager.setExactAndAllowWhileIdle()` and
  `wake.active` to the wake lock. This is the same pattern the README shows
  for a Cloudflare Durable Object, and Android's foreground service is exactly
  the kind of evictable host it describes ("A host whose process can be
  evicted, such as a Cloudflare Durable Object, wakes it itself").
- **Storage location.** App-private internal storage
  (`/data/data/<pkg>/files/…`) — no permissions needed, excluded from backup
  by default, and gone on uninstall. If you want the transcript to survive a
  reinstall, opt in via `android:allowBackup` with an explicit
  `fullBackupContent` rule for `pi/session.sqlite`.

---

## 2. Extension porting strategy

### 2.1 The target vocabulary

Pi Durable's extension model has exactly five slots
(`Extension` in `src/harness/types.ts`):

| Slot | Durable API | Use it for |
|---|---|---|
| `tools` | `defineTool({name, description, parameters, execute, replay?, …})` | Anything the model calls. `parameters` is TypeBox in both worlds, so `Type.Object({…})` ports verbatim. |
| `sections` | `section(key, render, {tag?})` | Prompt content. This is where your **skills** go. |
| `hooks` | `hook(GenerationTask, {…})`, `hook(ToolTask, {…})`, `hook(CompactionTask, {…})` | Cross-cutting policy on the built-in tasks. |
| `wraps` | `wrapTool(tool, fn)`, `wrapSection(key, fn)` | Decorating a tool that another extension won. |
| `tasks` | `defineTask({name, version, initial, phases, abort})` | Multi-step work that must survive process death. |
| (state) | `defineDoc` / `defineDocFamily` | Your durable state: todos, goals, subagent registry, triage decisions. |

And the mapping from pi-coding-agent concepts:

| pi-coding-agent (this repo) | Pi Durable |
|---|---|
| `pi.registerTool({name, parameters, execute})` | `defineTool({name, parameters, execute, replay})` |
| `pi.registerCommand(name, handler)` | a tool the model may call **plus** a UI affordance that submits a canned input |
| `pi.registerShortcut(key, handler)` | gone — the Compose app has its own input surface |
| `pi.registerMessageRenderer(kind, fn)` + `pi.sendMessage({customType})` | `defineEntry({kind})` + `conversation.submit({type:"write", entry:{kind,data}})` |
| `renderCall` / `renderResult` | the `details` field of a tool result + the app's own renderer |
| `pi.getThinkingLevel()` | `conversation.configure({thinkingLevel})` |
| `ctx.cwd` | `agent.cwd` / `env.cwd` |
| `pi.registerFlag` / provider registration | `HarnessOptions.models` — a `Models` from `@earendil-works/pi-ai/models` |

Two structural wins fall out of this:

- **Custom entry kinds are first-class.** `defineEntry` + a `submit({type:"write"})`
  gives you an append-only, typed event stream in the transcript — exactly what
  `goal.ts` does today with "custom session entries".
- **Extension state stops being a file format.** `todos.ts` currently invents a
  JSON-front-matter-plus-markdown file format with lock files and a GC pass.
  In Durable it is a `defineDocFamily` — one document per todo, keyed by id,
  committed atomically with the entry that changed it. No locks, no GC, no
  parsing.

### 2.2 The replay policy rule

**The rule, quoted from `packages/durable/docs/spec.md:3601`:**

> On reopen, a tool reruns only when both its stored intent policy and the
> current declaration, resolved as at `call`, say `safe`. A current `unsafe`
> declaration may veto a stored-safe replay; a current-safe declaration never
> upgrades stored unsafe. A tool that no longer resolves is treated as
> `unsafe`.

And the implementation, `src/harness/tool.ts:185`:

```ts
// Recovery after intent: rerun only when the stored and the current policy both say `safe`.
execute: async (task, runtime, context) => {
  const { arguments: args, replay } = task.state.checkpoint;
  ...
  if (replay === "safe" && tool?.replay === "safe") { … rerun … }
  const message = `Tool ${call.name} was interrupted and may have partially run`;
  ...
}
```

The **stored** policy lives in the tool task's checkpoint, committed *before*
execution:

```ts
// ToolTaskCheckpoint
| { phase: "call" }
| { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe" };
```

Three consequences that drive the whole porting plan:

1. **`replay` is opt-in and the default is `unsafe`.** "Omitted `replay` is
   `unsafe`." And — verified against the source — **none of Pi Durable's own
   built-in tools declare it**: `read`, `write`, `edit`, `bash` and `powershell`
   in `src/tools/*.ts` contain no `replay` field. So *every* built-in tool is
   unsafe by default.
2. **An unsafe tool that was interrupted yields an `interrupted` error result
   to the model, carrying the durable partial output** — not a rerun, not a
   silent success. That is the correct behaviour for `bash` and `edit`, and it
   is what the UI must render.
3. **A declaration change cannot upgrade a stored-unsafe policy.** If you
   decide mid-flight that `read` should be safe, that only helps calls whose
   *stored* intent was already safe — i.e. the tool must have been declared
   safe *before* the call was admitted. Ship the declaration on day one.

### 2.3 Decision rule for `replay`

I used exactly this rule for every tool below:

> **`safe`** ⟺ (a) the tool has no side effect outside durable state it writes
> itself, **and** (b) repeating the call with the same arguments produces the
> same end state (idempotent), **and** (c) the arguments fully determine the
> effect (so a rerun needs no hidden state).
>
> **`unsafe`** otherwise — including anything that spends money, touches the
> network in a billable way, mutates a repo, sends a message, or runs a
> command.

Note the third clause's escape hatch, from the spec: "A replay-safe tool may
reconstruct a submission from those arguments when that transformation is
pure. Random values, timestamps, mutable document/configuration reads, or other
derived inputs that must remain stable are first captured in a durable memo,
checkpoint, or task input." So a tool that needs a timestamp or a random id
becomes safe by capturing that value in a `runtime.memo(...)` or a task input
first — `ToolExecutionApi.memo(name, candidate, context)`.

### 2.4 Per-extension plan

The table covers all 13 extensions and 6 skills in this repo.

| # | Extension | Durable form | Replay | Notes |
|---|---|---|---|---|
| 1 | **subagent** (`subagent`, `subagent_status`, `subagent_cancel`, `subagent_interrupt`, `subagent_resume`, `subagent_clean`) | `subagent` **tool** + `app.subagents` **doc family** + native task ownership | `subagent` **safe**; the five management tools **unsafe** | §2.5. This is the flagship port. |
| 2 | **review-triage** (`triage_change`) | `triage_change` **tool** + `app.triage.decisions` **doc** | **unsafe** | It runs `git` and pays for a classifier call. The *decision* is written to a doc in the same commit, so the audit trail is durable rather than a transcript artefact. |
| 3 | **goal** (`get_goal`, `create_goal`, `update_goal`) | three **tools** + `app.goal` **doc** (scope: conversation, `history: "rewindable"`) | `get_goal` **safe**; `create_goal`/`update_goal` **safe if** a stable `goalId` is in the arguments, else **unsafe** | Today's implementation reconstructs state from the active branch on reload. A `defineDoc` with `history: "rewindable"` gives that for free, plus `snapshotAsOf()`. |
| 4 | **todos** (`todo` with 9 verbs) | one **tool** + `app.todos` **doc family** (one doc per todo, keyed by id) | **safe** for all verbs | `create`/`append`/`update`/`claim` are upserts keyed by a caller-supplied id; `delete` is idempotent; `claim` is a compare-and-set inside one commit (claim-if-unclaimed), so a rerun returns "already claimed" rather than stealing. |
| 5 | **voice** (`/voice`) | **not an extension** — becomes an input path in the web client (MediaRecorder or a native bridge) | n/a | The phone *is* the microphone now. The app records, transcribes, and calls `conversation.submit({type:"input", content})`. The current implementation reaches the phone over ssh from a desktop; that inversion is the entire point of this project. |
| 6 | **answer** (`/answer`) | `answer_questions` **tool** (model call → structured JSON) + a web screen that collects the answers and submits them | **unsafe** | Paid model call. The interactive TUI becomes a web sheet. The compiled answers become one follow-up input. |
| 7 | **continue** (shortcut) | **gone** — a web button that submits `"continue"` | n/a | The shortcut was a TUI affordance. |
| 8 | **session-breakdown** | `session_stats` **tool** + a web stats screen | **safe** | It reads `~/.pi/agent/sessions/*.jsonl` today. In Durable the transcript *is* the database: read `harness.usage(context)` and scan entries. Strictly better. |
| 9 | **btw** (side-question panel) | `btw` **tool** + a **background anchor task** + a child conversation | **safe** | Exactly example 23's pattern (§2.5). "Without adding anything to the transcript" becomes "in a separate conversation", which is stronger. |
| 10 | **review** (`/review`) | `review_start` **tool** that creates an `app.review` **task** with phases `collect → plan → run` | **unsafe** (spawns git + child conversations) | The *review children* are owned conversations, so they survive process death. |
| 11 | **repo-explorer** | `repo_explore` **tool** (read-only git + file reads) | **safe** | Read-only subprocesses, no side effects → rerunning is harmless. **Requires a shell-capable env**: under Option B it returns `shell_unavailable`. |
| 12 | **native-web-search** (`web_search`) | `web_search` **tool** | **unsafe** | It spends money on a search provider. Prefer an in-process `fetch` implementation over spawning the Node script — then it needs no shell and works under Option B too. |
| 13 | **opencode-go-provider** | **kernel configuration**, not an extension | n/a | Durable gets models from `HarnessOptions.models`. Build the `Models` with the opencode-go provider registered at kernel start; no durable artifact. |
| 14 | **skills** (commit, github, librarian, native-web-search, tmux, update-changelog) | **sections** + the tools their scripts need | n/a | §2.7. |

**The built-in tools.** `read`, `write`, `edit`, `bash` ship unsafe. `read` is
the one worth upgrading: it is pure, and on a phone a process death mid-`read`
is common. Upgrade it by re-declaring it in a later extension (a same-named
tool replaces an earlier one where both are selected):

```ts
// kernel/extensions/safe-read.ts
import { createReadTool } from "@earendil-works/pi-durable/tools";
const read = createReadTool();
export const SafeRead = defineExtension({
  name: "safe-read",
  tools: [{ ...read, replay: "safe" }],   // same name → replaces the built-in where selected
});
```

`write`, `edit` and `bash` stay unsafe. `edit` is *nearly* idempotent (it
matches `oldText`), but a partially-applied edit that then died leaves the file
in a state where `oldText` no longer matches, so a rerun fails confusingly.
Keeping it unsafe means the model gets the `interrupted` diagnostic and
decides — which is the right trade.

### 2.5 Subagent: the native ownership model

Your current `subagent` tool spawns a **child `pi` process in a detached tmux
session**, persists run state to `runs.json`, and polls a `result.json` with a
timer. Every one of those mechanisms is a re-implementation of something Pi
Durable already has. The mapping:

| Today | Pi Durable |
|---|---|
| tmux session per run | a **child conversation** |
| `runs.json` on disk | an **`app.subagents` doc family** |
| `result.json` written by the child | the child's **own transcript** (its `AssistantEntry`) |
| polling timer + `result.json` watcher | the child's **submission settles**; a **reporter task** delivers the answer back |
| `subagent_cancel` → kill the tmux session | `harness.abortTask(childTaskId)` / `child.abort()` |
| `subagent_interrupt` → send Escape to tmux | `child.abort()` (ends the run, keeps the conversation) then steer |
| `subagent_resume` → re-attach to a live tmux pane | `child.submit({type:"input", …})` — always available, because the conversation *is* the state |
| `PI_SUBAGENT_MAX_CONCURRENT` | count live children in the doc / task graph before admitting |
| "the child is a separate process" | **ownership**: `ownership: { kind: "task", taskId: api.taskId }` |

The ownership model is the core of it, and Pi Durable's README already
contains the exact shape:

> A conversation can be **owned** by a task. A subagent tool creates its child
> inside `api.commit()` with `ownership: { kind: "task", taskId: api.taskId }`,
> then drives it through `api.conversation(id)`.

The types, from `src/types.ts`:

```ts
// src/types.ts:365
export type TaskOwnership = { readonly kind: "conversation" } | { readonly kind: "task"; readonly taskId: TaskId };
// src/types.ts:394
export type ConversationOwnership = { readonly kind: "ownerless" } | { readonly kind: "task"; readonly taskId: TaskId };
```

**What ownership buys you, and why it replaces tmux:**

- "Aborting the call aborts the child. So does the call failing: `execute()`
  throwing, or a crash that interrupts a call that is not replay-safe."
- "The parent is idle only once the child is."
- "A task created with `{ background: true }` is a boundary: work it owns
  survives the parent's abort and does not keep the parent busy."
- `root.abort(context, { background: true })` aborts background work too — so
  "stop everything" is one call.

**Foreground subagent** (the shape in the README, modelled on
`test/examples/22-subagent-foreground.ts`):

```ts
const subagent = defineTool({
  name: "subagent",
  description: "Delegate a self-contained task to a subagent and get its answer back.",
  parameters: Type.Object({ task: Type.String() }),
  replay: "safe",                      // a rerun after a crash finds the same child and submission
  execute: async (args, api, context) => {
    const child = await api.commit(async (tx) => {
      // The ownership index remembers the child, so a rerun reuses it.
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing !== undefined) return existing.id;
      const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
      await configure(tx, created.id, { model: haiku, extensions: { remove: [Subagent] } });
      return created.id;
    }, context);
    await api.details({ conversationId: child }, context);   // lets a UI attach to the child
    const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
    const settled = await (await (await api.conversation(child, context))!.submit(request, context)).wait(context);
    return { output: [{ type: "text", text: settled.status }] };
  },
});
```

Note the three load-bearing details, all of which your tmux implementation had
to reinvent:

- `replay: "safe"` — legal because the tool creates the child *inside a
  commit*, so the effect is idempotent by construction.
- `requestId: \`subagent:${api.taskId}\`` — a rerun finds the *same submission*
  instead of starting a second run. ("A retried submission with the same
  `requestId` returns the existing submission instead of submitting twice.")
- `api.details({ conversationId: child })` — **this is how the UI finds the
  child**. The Compose subagent view (§3.5) attaches a second event stream to
  that conversation id. No tmux target, no attach command, no pane scraping.

**Background subagent** (persistent, non-blocking — your current UX, modelled
on `test/examples/23-subagent-background.ts`):

The pattern there is a **background anchor task** owning the child, plus a
**reporter task** per message:

```ts
// A background task is a boundary: the main agent's Esc and idle waits stop there.
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "app.subagent-anchor", version: 1,
  initial: () => ({ phase: "done" }),
  phases: { done: (_a, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx) },
  abort: (_a, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
```

The reporter delivers a message to the child and reports the answer back to the
parent as a follow-up input, using `requestId` so a restart neither re-sends
the message nor re-reports the answer. That replaces your polling watcher
exactly, and it is durable: the reporter's phases are checkpoints.

**One extension of your current UX worth keeping.** Your `subagent` tool
returns immediately and you poll with `subagent_status`. The Durable-native
equivalent is: the tool creates the child and returns immediately, and the
*child's* answer is reported back by the reporter task as a follow-up input.
The model never polls. `subagent_status` becomes a cheap read of the doc
family + `harness.taskGraph()`.

**`subagent_interrupt` / `subagent_resume` get simpler.** Today they exist
because tmux panes have independent lifetimes. In Durable the child's
*conversation* is the persistent thing:

- interrupt → `child.abort()` — ends the current run, keeps every entry, and
  the child is immediately usable again.
- resume → `child.submit({type:"input", …})` — always legal; no "the child is
  really gone" precondition.

### 2.6 Hooks worth adding on a phone

Hooks are Pi Durable's cross-cutting lever, and a phone is exactly where you
want them.

| Hook | Task | Purpose |
|---|---|---|
| `beforeTool` guard | `ToolTask` | Block or rewrite dangerous commands on a phone: `rm -rf`, `git push --force`, anything touching paths outside the workspace. `{ block: "…" }` produces a `blocked` error result the model sees. **This is the single most valuable hook for the mobile port**, because the phone is where a stray `rm` is unrecoverable. |
| `beforeTool` rewriter | `ToolTask` | Rewrite `cwd`-relative paths into the app workspace, so the model cannot address the whole device. |
| `afterTool` redactor | `ToolTask` | Strip API keys / tokens from tool output before they enter the transcript. **Caveat from the README:** "An `afterTool` hook that redacts a schema tool's `output` must redact its `structuredOutput` too." |
| `afterTools` | `GenerationTask` | Emit a durable "turn complete" marker into a doc; the web status bar can then show "idle, last turn N". |
| `beforeCompact` | `CompactionTask` | Inject a phone-specific compaction instruction ("keep file paths and command names verbatim"). |
| `beforeRequest` | `GenerationTask` | Inject a device-state section (battery, network, foreground/background) — but note the README's warning: "A section that returns something different every time, such as the current time, defeats that [prompt caching]." Use a `section`, not a per-request hook, and keep it stable. |
| Phone-capability bridge | ToolTask | The web client cannot directly call every Android API. Expose a narrow native bridge for microphone, file picker, notifications and share intents only, and keep it outside the durable state path. The bridge is not a tool; it is an app-to-app IPC surface for the WebView. |

### 2.7 Skills become sections

Pi Durable has no skill loader. A skill becomes:

1. **A section** that renders the skill body — `section("skill:commit", () =>
   skillText, { tag: false })`. Sections are rendered before each request and
   "Only what changed is sent again, which keeps provider prompt caches warm."
   Put the body in the app's assets (or the workspace) and read it through the
   `ExecutionEnv`.
2. **Tools** for anything the skill's scripts do — `git`, `gh`, `tmux`. Under
   Option A these are `bash` calls; under Option C1 they are `bash` calls
   through `RemoteExecutionEnv`.
3. A **doc**, if the skill has state (`update-changelog` has a file to edit;
   `librarian` has a cache).

The `commit` skill becomes a section + `git_status`/`git_diff`/`git_commit`
tools with **`replay: "unsafe"`** (a commit is a non-idempotent side effect).
The `github` skill becomes a section + `gh_*` tools, also unsafe (a PR is
created). `tmux` becomes a section + bash (and is moot under Option B, where
there is no shell — flag this in the port: **`tmux` and `btw` are the two
extensions that hard-require Option A or C1**).

---

## 3. UI/UX plan (web client in a native host)

### 3.1 The invariant

> **The UI never owns progress.**

The mechanical statement: **every pixel the Compose UI shows is a projection of
committed state, and the projection is fully reconstructible from a snapshot.**

Consequences, each of which is testable:

1. **No local progress state.** Not "is the agent running?" — that comes from
   `docs["pi.live"].run`. Not "is this tool still going?" — that comes from the
   tool slot's `status` and `output`. Not "did my send succeed?" — that comes
   from the submission's state in `docs["pi.inbox"]` and the settled submission
   record.
2. **The Activity can be destroyed at any instant** and be rebuilt with zero
   loss, because a fresh Activity fetches `GET /v1/snapshot` and is immediately
   correct. Rotation, process death by the OS, "don't keep activities", a
   configuration change — all non-events.
3. **A button never implies an outcome.** "Stop" does not set a local
   "stopping" flag; it sends `POST /v1/commands/abort` and the UI changes when
   the abort's effects are committed. The button's enabled/disabled state comes
   from the committed run state, not from a local flag.
4. **The UI cannot be ahead of the kernel.** The kernel is the only writer of
   durable state; the UI is a subscriber. There is no path by which the UI
   writes state the kernel does not know about.

This is not an aspiration — it is how Pi Durable is built. "Everything a UI
needs is committed state." The `viewState()`/`watch()` pair exists precisely so
that a UI can be a passive consumer.

### 3.2 Minimum viable screen set

**S1 — Conversation (the transcript).**
A virtualized web list over `EntryRecord`s. Each entry renders by kind:
`pi.user`, `pi.assistant` (text + thinking + tool calls), `pi.tool-result`
(output +
`details`), `pi.system`, `pi.reset`, `pi.compaction`, and your custom kinds
(`defineEntry`). Tool calls render their `details` — which is where the
subagent's `conversationId` lives, so the subagent row is tappable from the
transcript.

**S2 — Composer.**
Text field + send. It carries a **busy-mode** selector, because Pi Durable
has three and they are not equivalent:

| Mode | Durable call | Behaviour |
|---|---|---|
| Steer | `submit({type:"input", content, whenBusy:"steer"})` | "Placed after the current tool round and join the running work." |
| Follow-up | `submit({type:"input", content, whenBusy:"followUp"})` | "Placed when the run answers, and start the next run." |
| Reject | `submit({type:"input", content, whenBusy:"reject"})` | Throws `ConversationBusy`; writes nothing. |
| (write) | `submit({type:"write", entry:{kind,data}})` | Appended at once, even mid-run; the model is not asked anything. |

A phone UI that cannot express "steer" is much less useful than one that can.
This is a Durable-native concept pi-coding-agent does not have.

**S3 — Status strip.**
Derived from `docs["pi.live"]`:

| Field | Meaning |
|---|---|
| `run` | present exactly while busy: `{ taskId, inputs }` |
| `generation.attempt` / `.message` / `.retry` / `.deferred` | the in-flight model turn, its partial, its backoff, a provider-side deferred response |
| `tools[]` | the current round's tool calls: `status`, `output`, `droppedBytes`, `details`, `diagnostics` |
| `nestedTools[]` | nested calls, with `parentTaskId` and `arguments` |
| `compactions[]` / `compactionFailure` | background compaction, and the last failure |

Rendered as: a spinner + "Working", the current tool name + a truncated output
tail, a retry countdown, a compaction notice. **Never** a local "thinking"
animation that is not backed by a field.

**S4 — Task panel.**
From `harness.watchTaskGraph(context)`:

```ts
export type TaskGraphState =
  | { status: "pending" | "running"; phase: string }
  | { status: "waiting"; phase: string; on: readonly TaskId[]; policy: JoinPolicy }
  | { status: "sleeping"; phase: string; until: number }
  | { status: "completing"; phase: string; outcome: TaskOutcome<JsonValue>["status"] };
export type TaskGraphNode = {
  id: TaskId; kind: string; conversationId: ConversationId;
  owner?: TaskId; background: boolean; abortRequested: boolean;
  state: TaskGraphState;
  blocked?: "missing_task" | "task_too_old" | "migration_failed" | "restart_limit";
  conversations: readonly ConversationId[];
};
```

The panel is a tree (owner edges), each node showing status, phase, and — for
blocked nodes — a **Retry** button calling `harness.retryTask(id, context)`.
"After a restart, tasks that were `running` show as `pending` until they run
again" — so a node that says `pending` right after a restart is *normal*, and
the UI should say so rather than showing an error.

**S5 — Subagent view.**
Opened by tapping a subagent tool call. It attaches a **second** event stream
to the child's conversation id (from the call's `details.conversationId`) and
shows the child's own transcript, plus the parent→child edge. Because the child
is a real conversation, it has its own history, its own compaction, and its own
fork — all of which the parent's tmux pane never had.

**S6 — Recovery sheet.**
Shown when the app reopens and finds work in flight. See §3.6.

**S7 — Usage sheet.**
`harness.usage(context)` / `docs["pi.usage"]`: per model and per tool, tokens
and cost. Cheap to build, and on a phone (metered connections, battery) it
matters.

### WebView/browser specifics.

The web client must treat reconnect, back-button navigation, and WebView
renderer death as normal events. It must not use local storage for durable
state. The only local state allowed is ephemeral UI state (scroll position,
draft text); draft text should be submitted as a durable input when the user
sends. The WebView must not receive the SQLite file path or unrestricted shell
access.

### 3.3 Paged loading

`Conversation.entries(query, limit, cursor, context)` returns
`Page<EntryRecord, Cursor>` — "Fork-aware history of this conversation, newest
first unless `query.order` is `ascending`".

The transcript screen pages with a windowed cursor over `entries`, keyed by the
newest entry id, and appends live entries from the event stream. Two details
that matter on a phone:

- **The initial load must not be the whole history.** A virtualized web list
  over a `Page` with a "load older" trigger at the top, backed by
  `entries(query, limit, cursor, context)`.
- **`viewState()` returns the whole active transcript.** That is fine for a
  transcript of tens of entries and wrong for thousands. The kernel should
  serve a *windowed* snapshot for the UI and let the event stream carry the
  tail. Design the snapshot endpoint with a `since`/`limit` parameter from day
  one, even if v1 always sends everything.

### 3.4 Task status indicators

One rule: **the indicator reads committed status; it never infers.**

| Indicator | Source | Notes |
|---|---|---|
| running / waiting / sleeping / completing | `TaskGraphNode.state.status` | The four committed statuses, plus `pending`. |
| blocked (missing definition / too old / migration failed / restart limit) | `TaskGraphNode.blocked` | `harness.inspect()` reports the same thing as `TaskInspection.state.kind === "blocked"`. |
| running tool call | `pi.live.tools[].status` (`pending`/`running`/`done`) | |
| retry backoff | `pi.live.generation.retry` (`{at, error}`) | Show the countdown from `at` — a *committed* deadline, not a local timer. |
| compaction | `pi.live.compactions[]`, `pi.live.compactionFailure` | |
| queued input | `pi.inbox` | `InboxDoc` / `InboxItem`. |
| parked | `onReport` `{type:"task_parked"}` → durable, shown in the task panel | See §5 R3. |

Note `TaskGraphState` has no "suspended" status — the closest is `sleeping`
(with `until`) and `waiting` (with `on` and `policy`). Your "running /
suspended / waiting" trichotomy maps to **running / sleeping / waiting**, plus
**blocked** as a fourth state that is *not* in the graph's status union but is
in `TaskGraphNode.blocked` and `TaskInspection`. Design the UI for four
states, not three.

### 3.5 Subagent visualization

The tree is `TaskGraphNode.owner` plus
`TaskGraphNode.conversations` ("Conversations this task owns, in ID order").
The README notes the subtlety: "The graph lists live tasks only: once a
subagent's owner task is terminal, a later task in its conversation is a
top-level node, and the conversation's `ConversationRecord.owner` (also in its
view's `conversation`) links it to its parent."

So the subagent tree must be built from **two** sources: the live task graph
(owner edges) *and* the conversation records (parent links). A subagent whose
tool call has finished is no longer a live task, but its conversation still
exists and still belongs to the parent. Render it from the conversation record,
and mark it "ended".

Concretely, the UI needs one query it does not have a primitive for:
"which conversations are children of conversation X". `scanConversations({
ownerTaskId })` exists on the transaction; the kernel should expose a
`GET /v1/conversations?parent=<id>` endpoint backed by it.

### 3.6 The Resume affordance

This is where the durability story becomes visible, so it deserves care.

**What the user sees.** On app start, the kernel runs
`harness.inspect(context)` and reports live tasks and unsettled submissions.
The UI shows a sheet:

```
Interrupted work found
  ▸ 2 tasks were running when the app stopped
  ▸ 1 subagent conversation has an unfinished answer
  [ Resume all ]   [ Review individually ]
```

**What "Resume" does.** `POST /v1/commands/resume` → the kernel calls
`harness.resume()`. That is all. `resume()` "Enable task scheduling. Idempotent;
throws after close… Work interrupted by a crash or close stays pending.
`resume()` starts the task scheduler."

**The subtlety: resume is not the same as "the thing that was running starts
again".** Per the spec:

- A task that was `running` when the process died is now `pending` — it will
  re-run its phase from the top.
- A tool call that was interrupted **reruns only if both policies are safe**;
  otherwise the model gets an `interrupted` error result. So a resumed run may
  show a tool call marked "interrupted — may have partially run". The UI must
  render that honestly, not as a retry.
- A task cut off `restartLimit` times is **parked** and will *not* resume; it
  needs `harness.retryTask(id)`. This is the "parked tasks" list, with a
  per-task Retry.

**Therefore the Recovery sheet has three buttons, not one:**

| Button | Command | When it appears |
|---|---|---|
| **Resume** | `harness.resume()` | Always, when there is pending work. |
| **Retry** | `harness.retryTask(id)` | Per task, when `blocked.reason === "restart_limit"`. |
| **Discard** | `harness.abortTask(id)` | Per task, for work the user no longer wants. |

**And a fourth state the UI must show honestly: "interrupted".** A tool call
whose stored policy is unsafe and which was cut off produces a `pi.tool-result`
entry with an `interrupted` diagnostic and the durable partial output. The
transcript should show it as an error row, not as a spinner that never
finishes.

The Recovery sheet is a web screen; Resume posts to `/v1/commands/resume`,
Retry posts to `/v1/commands/retryTask`, and Discard posts to
`/v1/commands/abortTask`. The web client never sets a local "stopping" flag;
it waits for the committed effects.

### 3.7 UI state rules

- **Reconnect = resnapshot.** On WebSocket reconnect, the client requests a
  fresh snapshot and replaces its projection. No local diffing, no
  reconciliation logic.
- **`reset` event = drop everything.** The kernel emits it when the client has
  fallen too far behind.
- **Optimistic UI is forbidden for durable state.** The "Send" button does not
  insert a bubble; the bubble appears when the `pi.user` entry is committed.
  (A submission is durably admitted before it is placed, so the delay is
  short — but it exists, and hiding it would be a lie.)
- **Errors are states, not toasts.** A failed submission settles as
  `unanswered` with a reason (`run_failed`, `stale`, `aborted`); the UI shows
  it in the transcript, not as a transient snackbar.
- **WebView renderer death = reconnect.** If the WebView renderer process is
  killed, the web client reconnects and resnapshots exactly as if the Activity
  had rotated. This is a normal event, not an error state.

---

## 4. The self-building loop

### 4.1 What "self-building" means here

The agent running inside the durable kernel writes the code of the app that
hosts the kernel. The circle closes because the kernel is durable and the
source lives in a workspace the kernel can write.

Two things must be separated, and this is the crux:

| Layer | Owned by | Lifetime |
|---|---|---|
| **The session** (conversation, tasks, in-flight run) | the **durable kernel** | survives Activity death, service restarts, process death |
| **The app binary** (web client assets, native host shell, kernel code) | the **build** | replaced by a rebuild |

The agent edits layer 2's *source*. The running session in layer 1 is
unaffected by that edit until the new code is actually loaded — at which point
the *next* phase or request uses it, and the running one finishes under the
code it started with.

### 4.2 Three reload paths, three different mechanisms

Pi Durable's "Reload" section is exactly this problem, already solved for
extensions:

> Installing an extension with an installed name replaces it in place, in one
> step: `registry.install(await loadCodingExtension());`
>
> **Work that already started keeps the code it took:** a running tool call
> finishes under its old implementation, and each task phase resolves hooks
> and the agent once, from the registry at the phase's start. The next phase,
> request, or call uses the new code. After a restart, install the same
> extensions again; pending tasks of an extension's `tasks` resume once it is
> installed.

So there are three distinct reload paths, and they are *not* the same event:

| Path | Mechanism | What it affects |
|---|---|---|
| **R1 — extension reload** | `registry.install(newExtension)` under the same name, in the running kernel | The next phase/request/call uses the new code. **No process restart. No session interruption.** This is the hot path. |
| **R2 — web UI hot reload / rebuild** | Vite/Webpack HMR in dev, or rebuild static assets and reload the WebView in production | UI changes without an APK reinstall. The session is untouched. |
| **R3 — kernel restart / APK rebuild** | `harness.close(ctx)` → process exit → `Harness.open(...)` → `harness.resume()`, or `gradlew installDebug` for native host shell changes | The session survives via SQLite; pending tasks resume. |

**R1 is the interesting one and it is fully native to Pi Durable.** If the
kernel can load an extension from a file at runtime — pi-coding-agent does
this with `jiti` — then the agent can write `workspace/extensions/foo.ts`,
call a `registry.install()` for it, and the change is live on the *next*
request, with zero downtime and zero risk to the running turn. R2 is what the
web client buys you. Because the UI is served as static assets, the agent can
edit web/src/..., trigger a Vite HMR update (or a rebuild + WebView reload),
and see the change without reinstalling the APK. This is the UI analogue of R1
and is the reason the UI is not Compose. So the loop is:

```
agent edits web/src/Screen.tsx
   → Vite HMR updates the WebView                    ← R2: no APK rebuild
agent edits workspace/extensions/foo.ts
   → kernel: registry.install(loadExtension("foo.ts")) ← R1: instant
agent edits app/src/main/java/.../Service.kt
   → ./gradlew installDebug                           ← R3: APK rebuild; session survives via SQLite
```

### 4.3 Restarting the worker is a normal event

The design commitment: **a kernel restart is an ordinary event, not an
incident.** Concretely, in the kernel:

```ts
// On start: pick up where the last process stopped.
const harness = await Harness.open(await openNodeSqliteStorage(dbPath), { models, registry, settings, env, onWake }, ctx);
const root = await harness.root(ctx);          // the same root as last time
harness.resume();                              // continue any run the last process left unfinished
```

and on a clean stop:

```ts
await harness.close(ctx);   // "Seal admission, settle admitted commits, then close storage."
```

The README is explicit that a close is *not* a crash:

> **Crash loops.** … Open counts each task a crash, eviction, or reset cut off;
> **a close is not counted**, and a new state the task commits starts the count
> over.

So: a graceful stop (SIGTERM → `close()`) leaves the restart counter alone; an
abrupt kill increments it. On Android, the difference between the two is under
your control (§5 R3), and it decides whether a task survives five app launches
or gets parked.

The second half of "normal event" is that the *user* never sees an error. The
app shows "Restored your session" and the task panel shows the pending tasks.
A parked task shows a Retry button, not a crash dialog.

### 4.4 The workflow

1. The workspace (`pi/workspace/`) holds a git clone of the app.
2. The agent is told: *"Read the app's README, then add a screen that shows
   the task graph as a tree."*
3. The agent reads files with `read`, edits with `edit`, and runs
   `./gradlew :app:assembleDebug` with `bash`.
4. The build fails → the agent reads the compiler output from the tool result
   and fixes it. (This is why Option B, with no shell, is not a coding agent.)
5. The agent commits the change (`git_commit` tool, unsafe) and pushes
   (`gh` tool, unsafe).
6. The agent edits the web UI source (`web/src/…`) and the WebView
   hot-reloads (R2); no APK rebuild is needed for UI changes.
7. The agent writes a new extension into `workspace/extensions/` and installs
   it (R1) to change *its own* behaviour mid-session.

**The self-referential part:** the agent can edit the app that hosts it — the
web UI via R2, the extensions via R1, and the native host shell via R3 — and
then the app it is running in is replaced underneath it. The session survives
because it lives in SQLite, not in the process. The agent comes back after the
reinstall, mid-task, with its context intact.

**The hard constraint:** the agent must not be able to break the kernel in a
way that loses the transcript. Two guards:
- The Pi database is in app-private storage, not in the workspace, so
  `git clean -fdx` in the workspace cannot touch it.
- The workspace is a separate directory from the Pi state directory, and the
  `beforeTool` guard (§2.6) blocks paths outside it.

### 4.5 Smallest possible first milestone

> **Milestone 0: foreground service + SQLite commit loop + one tool.**

Concretely, and this is deliberately *not* a UI milestone:

1. An Android app with a `ForegroundService` (type `specialUse`), a
   notification, and a `BroadcastReceiver` for `BOOT_COMPLETED` (optional).
2. The service starts the kernel (Node, per §1.3) with a JSON-RPC over a
   loopback socket.
3. The kernel opens `openNodeSqliteStorage("/data/data/<pkg>/pi/session.sqlite")`,
   calls `Harness.open(...)`, `harness.root(ctx)`, and registers **one** tool:
   `echo` (`replay: "safe"`).
4. The kernel exposes `POST /submit` and `GET /snapshot`.
5. **No web UI yet** — `curl` from `adb shell` is enough.

**Acceptance criteria for Milestone 0** (this is the whole point of the
milestone — it proves durability before anything else is built):

| # | Criterion | How it is checked |
|---|---|---|
| M0.1 | A submitted input produces a committed `pi.user` entry and a committed `pi.assistant` entry, visible in the snapshot | `curl` the snapshot; check the entries |
| M0.2 | `adb shell am kill <pkg>` (process death, no graceful close) followed by a service restart **resumes the pending work** and the transcript is byte-identical apart from the new entries | kill mid-tool-call; restart; diff the snapshot |
| M0.3 | A tool that was interrupted mid-flight and is declared `replay: "unsafe"` produces an `interrupted` result, **not** a rerun | register a `sleep`-then-throw tool; kill during it |
| M0.4 | The same tool declared `replay: "safe"` **does** rerun after the kill | flip the declaration |
| M0.5 | The SQLite file survives `adb shell am force-stop` and a reboot; `sqlite3` on the pulled file shows the entries | pull and inspect |
| M0.6 | Exactly one kernel process exists at a time; a second launch attempt is refused | assert on the lock |
| M0.7 | `harness.inspect()` after the kill reports the previously-running task as `pending`, and `harness.resume()` runs it | via the snapshot |
| M0.8 | The kernel serves a trivial `GET /` page and the WebView loads it over loopback with the bearer token | Load the WebView; check the page renders |

M0.2/M0.3/M0.4 are the three that actually prove the kernel is durable, and
they are cheap. Everything else in this plan is downstream of them.

---

## 5. Risks and decision points

Ordered by "how badly would this hurt if I got it wrong".

### R1 — A Node runtime on Android is the load-bearing unknown

**Unknown.** Can a Node ≥ 22.19 build with `node:sqlite` run inside an Android
foreground service, reliably, at acceptable speed, inside an APK?

Sub-questions, each with its own answer:
- Does the Termux Node build include `node:sqlite`? (Node 22.5+ has it as
  experimental; Termux's Node 24/25 should, but "should" is not a measurement.)
- Is a native bionic-linked Node enough, or is proot required? (proot is
  *slow*; a durable agent that spends its life in syscall translation will
  feel it.)
- How large is the resulting APK, and does the 15 MB Play Store limit matter?
  (Sideloading makes it irrelevant; Play does not.)
- Does the process survive Doze and OEM battery killers? (Does not matter for
  the *kernel's* correctness — that is what SQLite is for — but it matters for
  latency.)

**Spike S0.1 (2–3 days).** Build the smallest possible app: a `ForegroundService`
that launches a bundled Node, which opens a `node:sqlite` database, creates a
table, inserts 1 000 rows in a transaction, reads them back, and prints a
report over a loopback socket. Measure: APK size, cold-start time, `node:sqlite`
availability, behaviour across `am kill`, behaviour across Doze (`adb shell
dumpsys deviceidle force-idle`).

**Fallback.** Option B (Hermes + `android.database.sqlite` facade + no shell)
or Option C1 (remote execution). Both are one-line changes to the env factory
(§1.6) if the kernel, storage, IPC and UI are built as separable layers — which
is why the plan insists on that seam from day one.

### R2 — The SQLite facade (Option B) and SQLite under a foreground service

**Unknown.** Does a hand-written `SqliteDatabase` facade over
`android.database.sqlite` pass `registerStorageConformance`? And does SQLite
behave under Android's storage pressure (the OS will delete app caches, and
`SQLiteDatabase.deleteDatabase` can be called)?

Sub-questions:
- The framework SQLite API is not shaped like the facade: `exec` takes one
  statement (the facade's `exec` may take several), `run` has no positional
  binding (you interpolate — and the README warns: "adapters may cache
  prepared statements by SQL text, so callers pass values as bindings instead
  of interpolating them"). You need a real prepared-statement layer.
- `SQLiteDatabase` transactions are per-connection, not exclusive; the
  facade's contract ("Adapters must queue unrelated operations and other
  transactions until the transaction finishes") is a *Java-side* queue you
  implement.
- WAL: the framework enables WAL for `OpenHelper` databases only under
  conditions (not on low-RAM devices, and not across a `files/` path on some
  OEM builds). `node:sqlite` (Option A) has no such caveat.

**Spike S0.2 (2 days).** Implement the facade over `android.database.sqlite`
and run `registerStorageConformance` from `@earendil-works/pi-durable/testing`
against it. Then run the storage benchmarks (`STORAGE_WRITE_BENCHMARKS`,
`STORAGE_READ_BENCHMARKS`) on a low-end device to get real numbers.

**Fallback.** Option A's `openNodeSqliteStorage` (which needs no facade at
all), or `openNodeJsonlStorage` — which is portable and takes a `FileSystem`
from `@earendil-works/pi-durable/env`, but keeps the whole history in memory
(§1.7). Not recommended beyond a smoke test.

### R3 — OEM process killers will park your tasks

**This is the most likely thing to actually bite you, and it is specific to
Android.**

The mechanism, from `src/harness/scheduler.ts`:

- On open, every task that was `running` when the process died gets
  `restarts = (restarts ?? 0) + 1`.
- "a new state the task commits starts the count over" — progress resets it.
- `settings.restartLimit` defaults to `DEFAULT_RESTART_LIMIT = 5`. At the limit,
  the task is **parked**: "the task graph show it as blocked with reason
  `restart_limit`, `wake()` does not count it as active, and `onReport` gets it
  once as `task_parked`". A parked task **does not run** until
  `harness.retryTask(id)` is called.

Now count the ways a phone kills a background service: Samsung's and Xiaomi's
battery managers, "app hibernation" on Android 12+, memory pressure, the user
swiping the app from recents, `adb shell am kill`, and a Doze-adjacent
background restriction. Five of those in a row, before the task manages to
commit a *different* state, and your task is parked and silent.

Note that a **graceful** close does not count: "a close is not a crash: a task
it stopped is `pending` again, so the next open counts no restart for it."

**Mitigations, in order of preference:**

1. **`settings.restartLimit: Infinity`.** The README says "`Infinity` never
   parks". The crash-loop protection exists for tasks that deterministically
   crash their host (OOM, CPU spin) — an Android foreground service killed by
   the OEM is not that. You trade a runaway-task guard for OEM-killer
   tolerance.
2. **Graceful shutdown wherever you can.** `onDestroy` → `SIGTERM` → the
   kernel traps it → `harness.close(ctx)`. Android gives you a few seconds in
   `onDestroy` for a service; use them. But be honest: `am kill` and an OEM
   kill are `SIGKILL` and you get nothing.
3. **Host-driven recovery.** On every service start, scan
   `harness.inspect(context)` for tasks with
   `state.kind === "blocked"` and `reason === "restart_limit"` and call
   `harness.retryTask(id)` for each. This makes "parked" a visible, recoverable
   state instead of a silent stall — and it gives you the §3.6 Retry button.
4. **Persist progress often.** The restart counter resets when the task
   commits a *different* state. Durable's `api.output()` already commits
   running output at most every 100 ms (`settings.progress`), so a long tool
   call does make progress — but a task in a *phase* with no output does not.

**Spike S0.3 (1 day).** A loop that does `am kill` on the app 10 times during
a long tool call, then asserts (a) the task is still live and (b) it completes
on the next resume. Run it on the three OEM skins you actually own.

### R4 — `ExecutionEnv` compatibility is the whole product

**Unknown, and it is a product decision rather than a technical one.** Under
Option B there is no shell, so `git`, `gradle`, `npm test` and `tmux` are all
gone. That is not a degraded coding agent; it is a different product.

**Spike S0.4 (half a day, and it is just counting).** Take the 13 extensions
and mark each tool as *needs-exec* or *not*. My count from reading the source:
`repo-explorer` (git), `review` (git), `review-triage` (git diff), `btw`
(tmux), `native-web-search` (spawns a Node script), the `commit`/`github`/
`tmux`/`librarian` skills (git, gh, tmux, clone), `opencode-go-provider`
(network but no exec). That is **8 of 13 extensions plus 4 of 6 skills** —
i.e. roughly two thirds of your setup — that need a shell.

**Fallback / mitigation.** If the count is right (it is), Option B is not the
target. If you still want it: (a) reimplement `git` access as an in-process
library (jgit / isomorphic-git) rather than a subprocess, (b) reimplement
`web_search` in-process over `fetch` (easy, and it should be done anyway), and
(c) accept losing `tmux`/`btw` (which the Durable background-subagent pattern
replaces anyway). That gets you to maybe 9 of 13.

### R5 — Single-writer violations corrupt the store

**Unknown.** "One process owns a storage at a time; there is no cross-process
locking." Two kernels on one `.sqlite` file will not error politely.

**Mitigation.** A `FileLock` on `pi/kernel.lock`, held by the service, with the
pid recorded inside it. The kernel refuses to start if the lock is held by a
live pid. The service also refuses to start a second kernel. Belt and braces,
because the failure mode is silent corruption.

**Spike.** Part of Milestone 0 (M0.6).

### R6 — Foreground-service policy on modern Android

**Unknown.** `foregroundServiceType` is mandatory on API 34+; `dataSync` has a
6-hour/24h cap on Android 15+; `specialUse` requires a Play justification;
starting a foreground service from the background is restricted on API 31+;
exact alarms need `SCHEDULE_EXACT_ALARM` (and `USE_EXACT_ALARM` on API 33+,
which Play restricts to alarm-clock-like apps). The service must also host a
WebView (or the app must hand off to the device browser) without violating the
FGS type's contract. If the WebView is inside the service process, treat
WebView renderer death as a normal event and reconnect from a snapshot; if the
WebView is in the Activity, the service does not need to know the WebView
exists.

**Spike S0.5.** Install on API 30, 33, 34 and 35 emulators; start the service
from each allowed entry point; verify the notification, the type, and that
`AlarmManager.setExactAndAllowWhileIdle` fires while the screen is off.

**Mitigation.** For a sideloaded personal tool, `specialUse` + `USE_EXACT_ALARM`
is the pragmatic answer; for Play, `dataSync` with an honest usage description
and a mid-session restart.

### R7 — Pi Durable is explicitly experimental

**Known and permanent.** The package's own README opens with: "**Experimental.**
The API changes without notice between releases."

**Mitigation.** Pin `@earendil-works/pi-durable` and `@earendil-works/chord`
to an exact version (1.3.0). Keep every Durable-specific import behind one
adapter module (`kernel/durable-api.ts`) so a version bump is one file. Run
the package's own conformance suites (`registerStorageConformance`,
`registerEnvConformance`) against your Android implementations on every bump —
they exist precisely for this.

### R8 — Model transport, credentials, and cost on a phone

**Unknown.** Providers live in `@earendil-works/pi-ai`. The `opencode-go`
provider you use may need custom headers, a specific base URL, or an OAuth
flow that a phone browser can complete but a background service cannot.

**Spike.** Point the kernel at each provider you care about from the service
context (not the Activity) and check: streaming works, custom headers survive,
key storage (`EncryptedSharedPreferences` or a Keystore-backed file the kernel
reads at start) works, and a 401 refreshes the credential without a restart.

**Mitigation.** Credentials live in the Android Keystore; the kernel reads them
at start and on a 401. The app never holds the key in plain text on disk.

### R9 — The IPC boundary is a real failure surface

**Unknown.** The kernel is a separate process. If it dies, the UI must
reconnect and resnapshot; if the UI dies, nothing should happen to the kernel.

**Mitigation.** The reconnect path is "fetch a fresh snapshot" — no
reconciliation. Every client-visible invariant is therefore "reconstructible
from a snapshot", which is the same invariant §3.1 already demands. WebView
renderer death is also an IPC boundary event: the web client reconnects and
resnapshots exactly as a rotated Activity would.

### R10 — The self-build loop can destroy the workspace

**Unknown.** The agent has `bash`. It can `git clean -fdx` the app source, or
worse.

**Mitigation.** The `beforeTool` guard (§2.6) blocks paths outside the
workspace and a deny-list of destructive commands. The Pi state directory is
outside the workspace. A `pre-commit` hook in the workspace's git repo refuses
destructive ref operations.

### R11 — Loopback web server and WebView security

**Unknown.** The web client is served over `127.0.0.1` and loaded in a WebView
(or browser). If the server binds to `0.0.0.0`, if the bearer token leaks, or
if the WebView is given access to the SQLite file path or unrestricted shell
access, the durability story is undermined.

**Mitigation.** Bind only to `127.0.0.1`; issue a per-launch bearer token; use
a `NetworkSecurityConfig` that permits cleartext only for `127.0.0.1`; never
expose the dev HMR server beyond `adb reverse` unless you intentionally want
remote access; treat the WebView as untrusted and give it only the event
protocol and narrow bridge calls. Do not pass the SQLite path or shell access
to the web client.

---

## 6. Phased plan

Each phase lists its dependency, its deliverables, and its acceptance
criteria. The criteria are the point: they are what "done" means.

### Phase 0 — Decision spikes (no app code)

**Depends on:** nothing.

**Deliverables**

- S0.1 Node-on-Android spike (§5 R1) → a report: APK size, startup time,
  `node:sqlite` availability, kill/Doze behaviour.
- S0.2 Android `SqliteDatabase` facade + `registerStorageConformance` pass
  (§5 R2).
- S0.3 Env compatibility count (§5 R4) → the exec-needs table.
- S0.4 FGS/alarm behaviour on API 30/33/34/35 (§5 R6).
- S0.5 A **written decision record**: runtime, storage, env, IPC transport.

**Acceptance**

- [ ] S0.1 runs on a physical device, not only an emulator, and survives
      `am kill` with the SQLite file intact.
- [ ] S0.2's facade passes `registerStorageConformance` with zero failures,
      or the failure list is understood and accepted.
- [ ] The decision record names the runtime and the env, and §1.6's seam
      (`envFor(cwd)`) is fixed.

### Phase 1 — Durable kernel, no UI

**Depends on:** Phase 0.

**Deliverables**

- The Android app skeleton: `ForegroundService` + notification + supervisor.
- The kernel process: `Harness.open(openNodeSqliteStorage(db), {models, registry,
  settings, env, onWake, onReport}, ctx)`, `harness.root(ctx)`,
  `harness.resume()`.
- Loopback HTTP+WS server with the bearer token; `POST /v1/commands/*`.
- One tool: `echo`, `replay: "safe"`.
- `onReport` → the kernel's log *and* a durable record the UI can read (so
  `task_parked`, `task_faulted` and `session_failed` are not lost).
- `onWake` → `AlarmManager` + wake lock (§1.10).

**Acceptance** = Milestone 0's M0.1–M0.7 (§4.5), all seven.

### Phase 2 — Reactive web UI v0

**Depends on:** Phase 1.

**Deliverables**

- Web client screens S1 (transcript), S2 (composer with steer/follow-up),
  S3 (status strip), plus static asset serving from the kernel (`GET /`).
- `GET /v1/snapshot` + `WS /v1/events` with the §1.9 vocabulary.
- Paged `entries` loading (§3.3).

**Acceptance**

- [ ] Rotating the device, killing the WebView renderer, or `adb shell am kill`ing
      the Activity leaves the transcript, the run and the pending tools exactly
      as they were.
- [ ] A model turn streams into the transcript with no local "thinking"
      animation that is not backed by a committed field.
- [ ] A steer submitted during a run is visibly applied to the running turn
      (it lands after the current tool round).
- [ ] The UI can be force-stopped and relaunched mid-turn; the transcript
      continues from the same point.
- [ ] Editing the web UI source in dev mode hot-reloads the WebView without
      reinstalling the APK.

### Phase 3 — Task panel and subagents

**Depends on:** Phase 2.

**Deliverables**

- Screen S4 (task tree) and S5 (subagent view).
- The `subagent` extension ported per §2.5 (foreground + background patterns).
- `app.subagents` doc family; `subagent_status`/`cancel`/`interrupt`/
  `resume`/`clean` tools.
- `GET /v1/conversations?parent=<id>` for the parent→child tree.

**Acceptance**

- [ ] A subagent survives kernel process death: kill the app during the
      child's turn, relaunch, and the child continues from its checkpoint.
- [ ] Aborting the parent aborts the child (ownership cascade); aborting with
      `{background:true}` reaches a background child.
- [ ] The UI can open a child conversation and shows its own transcript.
- [ ] `subagent_interrupt` then `subagent_resume` continues the same
      conversation with its earlier entries intact.

### Phase 4 — Extension port

**Depends on:** Phase 3.

**Deliverables** — the remaining 12 extensions and 6 skills, per §2.4 and §2.7:
todos, goal, review-triage, review, repo-explorer, native-web-search, btw,
answer, session-breakdown, voice (as an input path), opencode-go-provider (as
kernel config), and the skills as sections.

**Acceptance**

- [ ] Every ported tool declares an explicit `replay` policy, and the table in
      §2.4 matches the implementation.
- [ ] The `interrupted` path is exercised on-device: a `replay:"unsafe"` tool
      killed mid-flight yields an `interrupted` result in the transcript, and a
      `replay:"safe"` tool reruns.
- [ ] Todos and goals live in documents, not files; a process kill preserves
      them.
- [ ] `triage_change`'s decision is in a durable doc and is visible in the
      task panel.
- [ ] Every skill's body is reachable as a section and its scripts as tools.

### Phase 5 — Self-building loop

**Depends on:** Phase 4.

**Deliverables**

- The workspace layout: `pi/workspace/app` (the app's git clone),
  `pi/workspace/extensions` (agent-writable extensions).
- `registry.install()` from a file at runtime (R1).
- The `gradlew` build tool.
- The guard hooks from §2.6.

**Acceptance**

- [ ] The agent, running inside the app, edits the web UI source and the WebView
      hot-reloads (R2); no APK rebuild is needed for UI changes.
- [ ] The agent edits the native host shell and `gradlew installDebug` replaces
      the APK; the session survives via SQLite and `resume()` (R3).
- [ ] The agent writes a new extension file, installs it, and the next request
      uses the new code **without a kernel restart**.
- [ ] A running tool call completes under the code it started with, even
      though the extension was replaced mid-flight.

### Phase 6 — Hardening

**Depends on:** Phase 5.

**Deliverables**

- `settings.restartLimit` policy (§5 R3) + the host-driven `retryTask` sweep.
- Single-writer enforcement (§5 R5).
- Credential storage in the Keystore (§5 R8).
- Backup rules; app size; battery behaviour; the OEM-kill soak test.

**Acceptance**

- [ ] The 10× kill loop (§5 R3) leaves no task parked, or parks it visibly
      with a working Retry.
- [ ] A second kernel launch attempt is refused, and the store is uncorrupted
      after the attempt.
- [ ] The app survives a reboot with the transcript and any in-flight task
      intact.

---

## Appendix A — Verified API surface

Everything below was read in the sources listed in §0 at
`@earendil-works/pi-durable@1.3.0` / `@earendil-works/chord@1.3.0`.

### Package entry points (`packages/durable/package.json` `exports`)

```
"."                          ".":  Harness, defineTask, defineExtension, defineTool,
                                     hook, section, wrapTool, wrapSection, createRegistry,
                                     defineDoc, defineDocFamily, defineEntry, MemoryStorage,
                                     watchEvents, AgentDoc, LiveDoc, InboxDoc, ProviderDoc,
                                     UsageDoc, ToolTask, GenerationTask, CompactionTask,
                                     NestedCallDoc, configure, ROOT_CONVERSATION_ID,
                                     DEFAULT_RESTART_LIMIT, DEFAULT_COMPACTION_POLICY,
                                     DEFAULT_PROGRESS_POLICY, DEFAULT_RETRY_POLICY,
                                     DURABLE_TELEMETRY_SCHEMA
"./env"                     ExecutionEnv, FileSystem, Shell, FileError, ExecutionError,
                                     Result/ok/err/getOrThrow, LineScanner
"./env/node"                NodeExecutionEnv
"./tools"                   createCodingTools, CodingTools, createReadTool, createWriteTool,
                                     createEditTool, createBashTool, createPowerShellTool
"./codemode"                createCodemodeExtension
"./tool-search"             createToolSearchExtension
"./storage/memory"          MemoryStorage
"./storage/jsonl"           JsonlStorage, JsonlCorruptionError, JsonlStoragePoisonedError
"./storage/jsonl/node"      openNodeJsonlStorage
"./storage/sqlite"          SqliteStorage, applySqliteMigrations, SQLITE_MIGRATIONS
"./storage/sqlite/node"     openNodeSqliteStorage, openNodeSqliteDatabase
"./storage/sqlite/cloudflare" openDurableObjectSqliteStorage
"./testing"                 registerStorageConformance, registerEnvConformance,
                                     createExpectAssertions, storage benchmarks
```

### Types that matter for this plan

```ts
// src/types.ts:365
export type TaskOwnership = { readonly kind: "conversation" } | { readonly kind: "task"; readonly taskId: TaskId };
// src/types.ts:394
export type ConversationOwnership = { readonly kind: "ownerless" } | { readonly kind: "task"; readonly taskId: TaskId };
// src/types.ts:371
export type TaskOptions = { trace?; links?; ownership: TaskOwnership; conversationId?;
                             background?; abandonOnRestart? };
// src/env/index.ts:374
export interface ExecutionEnv extends FileSystem, Shell {}
```

### The API calls this plan is built on

| Call | Where | Note |
|---|---|---|
| `Harness.open(storage, options, context)` | `src/harness/harness.ts:523` | Requires a registry containing the built-in tasks. |
| `harness.resume()` | `src/harness/types.ts` | "Enable task scheduling. Idempotent." |
| `harness.wake(): Wake` | | `{ active, at? }` |
| `harness.close(context)` / `harness.closed` | | "Seal admission, settle admitted commits, then close storage." |
| `harness.inspect(context): HarnessInspection` | | live tasks + unsettled submissions |
| `harness.taskGraph(context)` / `harness.watchTaskGraph(context)` | | task tree |
| `harness.abortTask(id, ctx)` / `harness.retryTask(id, ctx)` | | retry clears a parked task's restart count |
| `harness.waitForTask(id, ctx)` | | terminal receipt |
| `harness.usage(ctx)` | | session-wide totals |
| `harness.submission(id, ctx)` | | reacquire a submission after a restart |
| `conversation.submit(draft, ctx)` | | `whenBusy: "steer" \| "followUp" \| "reject"` |
| `conversation.entries(query, limit, cursor, ctx)` | | paged history |
| `conversation.viewState(ctx)` / `conversation.watch(ctx)` | | the UI's two views |
| `conversation.abort(ctx, {background?})` | | |
| `conversation.fork(at, options, ctx)` | | |
| `watchEvents(harness, conversationId, ctx)` | | snapshot + event batches |
| `api.executeTool(name, args, ctx, {key?, progress?})` | | nested calls |
| `api.createTask(task, input, options, ctx)` | | `options.ownership` required |
| `api.commit(fn, ctx)` / `api.memo(name, candidate, ctx)` | | durable side effects |
| `api.details(value, ctx)` | | how the UI finds a child conversation |
| `runtime.commit(fn, ctx)` | | returns `{status:"waiting", checkpoint, on, policy}` to wait |
| `runtime.sleepUntil(until, {phase}, ctx)` | | durable sleep |
| `runtime.outcomes(ids, ctx)` | | join results |

### The exact quotes this plan leans on

1. *"If the process dies mid-call, the tool reruns on reopen only when it is
   declared `replay: "safe"`; otherwise the model gets an `interrupted` error
   result with the output committed so far."* — README, Tools.
2. *"On reopen, a tool reruns only when both its stored intent policy and the
   current declaration, resolved as at `call`, say `safe`. A current `unsafe`
   declaration may veto a stored-safe replay; a current-safe declaration never
   upgrades stored unsafe. A tool that no longer resolves is treated as
   `unsafe`."* — `docs/spec.md:3601`.
3. *"Omitted `replay` is `unsafe`."* — `docs/spec.md:3152`.
4. *"One process owns a storage at a time; there is no cross-process locking."*
   — README, Storage.
5. *"Keeps the whole history in memory too, so memory grows with it; use SQLite
   for long-running agents."* — README, Storage.
6. *"Open counts each task a crash, eviction, or reset cut off; a close is not
   counted, and a new state the task commits starts the count over."* — README,
   Failures and Recovery.
7. *"a close is not a crash: a task it stopped is `pending` again, so the next
   open counts no restart for it."* — `src/harness/scheduler.ts:525`.
8. *"Work that already started keeps the code it took: a running tool call
   finishes under its old implementation, and each task phase resolves hooks
   and the agent once, from the registry at the phase's start."* — README,
   Reload.
9. *"Everything a UI needs is committed state."* — README, Watching a
   Conversation.
10. *"await send(ops); // for example to a remote client that applies them"* —
    README, Watching a Conversation.

---

## Appendix B — Open questions to answer before Phase 1

1. **Is the workspace the app's git clone, or a synced copy?** A clone means the
   agent can push; a copy means it cannot. Cloning means credentials on the
   device (§5 R8).
2. **Does the phone need to work with no network at all?** If yes, Option A
   (bundled Node + local `NodeExecutionEnv`) is mandatory, because a model
   provider needs the network but a *shell* does not. If no, Option C1 becomes
   materially cheaper.
3. **Do you need to run the agent on *other* people's phones, or only yours?**
   Sideloading, a 68 MB APK and Play Protect warnings are fine for yourself and
   a problem for distribution.
4. **How much of the existing setup must survive verbatim?** §2.4 says ~9 of
   13 extensions need a shell. If the answer is "all of them", Option A or C1
   is forced.
5. **Do you want the transcript to survive an uninstall?** App-private storage
   says no; a backup rule says yes. SQLite + WAL + backup is a bad combination
   (a restored WAL against a restored main DB can be inconsistent), so this
   needs a deliberate answer, not a default.
6. **Which phone capabilities need a native bridge?** Microphone, file picker,
   share intents, notifications, background location? Keep the bridge narrow
   and outside the durable state path.
7. **Dev HMR transport:** `adb reverse` to a host Vite server, or a
   kernel-proxied dev endpoint? Production always serves built assets from the
   kernel at `GET /`.
