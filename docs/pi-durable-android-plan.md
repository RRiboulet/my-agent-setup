# A phone-native durable coding agent on Android

> **This copy is not canonical.** The plan now lives with the app it
> describes, in **https://github.com/RRiboulet/pi-termux-mobile** —
> `docs/pi-durable-android-plan.md` — together with `docs/plan-revision.md`,
> which says what changed and why. This branch is kept for the review
> history, as the plan's own provenance note says. Work on the copy in the
> app repository.

**Pi Durable as the kernel, a web client as the passive UI, a foreground service owning SQLite.**

Status: plan, not implementation. Everything below was checked against the
sources listed in [§0](#0-sources-checked) at **`main` commit `fdce48e`
(2026-10-20)**, which is post-`v1.3.0`; anything I could not verify is marked as
an assumption or as a spike. §0.1 records what is main-only and what changes if
you pin the `v1.3.0` tag instead — do not mix the two.

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
  - [0.1 Version and API drift](#01-version-and-api-drift)
- [1. Kernel architecture on Android](#1-kernel-architecture-on-android)
  - [1.1 Four premises to correct first](#11-four-premises-to-correct-first)
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
  - [2.5 Subagent: implement the owned-child pattern](#25-subagent-implement-the-owned-child-pattern)
  - [2.6 Hooks worth adding on a phone](#26-hooks-worth-adding-on-a-phone)
  - [2.7 Skills become sections](#27-skills-become-sections)
  - [2.8 Security model](#28-security-model)
- [3. UI/UX plan (web client in a native host)](#3-uiux-plan-web-client-in-a-native-host)
  - [3.1 The invariant](#31-the-invariant)
  - [3.2 Minimum viable screen set](#32-minimum-viable-screen-set)
  - [3.3 WebView/browser specifics](#33-webviewbrowser-specifics)
  - [3.4 Paged loading](#34-paged-loading)
  - [3.5 Task status indicators](#35-task-status-indicators)
  - [3.6 Subagent visualization](#36-subagent-visualization)
  - [3.7 The Resume affordance](#37-the-resume-affordance)
  - [3.8 UI state rules](#38-ui-state-rules)
- [4. The self-building loop](#4-the-self-building-loop)
  - [4.1 What "self-building" means here](#41-what-self-building-means-here)
  - [4.2 Three reload paths, three different mechanisms](#42-three-reload-paths-three-different-mechanisms)
  - [4.3 Restarting the worker is a normal event](#43-restarting-the-worker-is-a-normal-event)
  - [4.4 The workflow](#44-the-workflow)
  - [4.5 Smallest possible first milestone](#45-smallest-possible-first-milestone)
- [5. Risks and decision points](#5-risks-and-decision-points)
- [6. Phased plan](#6-phased-plan)
- [Appendix A — Verified API surface](#appendix-a--verified-api-surface)
- [Appendix B — Decisions taken, and what is still open](#appendix-b--decisions-taken-and-what-is-still-open)

---

## 0. Sources checked

| Source | What was read | Why it matters |
|---|---|---|
| `earendil-works/pi` monorepo, `packages/durable` @ `fdce48e` (main, 2026-10-20) | `README.md` (869 lines), `docs/spec.md` (5618 lines), and the source of `src/index.ts`, `src/types.ts`, `src/tasks.ts`, `src/env/index.ts`, `src/harness/{harness,tool,types,define,registry,view,live,task-graph,events,agent,scheduler,telemetry}.ts`, `src/storage/{sqlite,node,jsonl,memory}/*`, `src/tools/*`, `src/testing/*` | Primary reference. Line citations below are `packages/durable/…` at commit `fdce48e`, not at the `v1.3.0` tag. |
| `earendil-works/pi` monorepo, `packages/chord` @ `fdce48e` | `src/sqlite/database.ts` (`SqliteDatabase`, `SqliteExecutor`), `src/sqlite/node.ts`, `src/delta/index.ts` (`Op`, `WireOp`), `src/node.ts` + `src/manager.ts` (`processLock`), `package.json` `exports` | The portable seams: an async SQLite facade and a tuple-based delta format. The `./sqlite` subpaths are post-1.3.0; at the tag the facade lives in `packages/durable/src/storage/sqlite/database.ts`. |
| npm `@earendil-works/pi-durable@1.3.0` | `package.json` `exports` map, `dependencies` | The last *released* version. It does **not** contain the main-only APIs this plan uses; see §0.1. |
| `sugarforever/pi-durable-expo-env` @ `0.1.0` | `README.md`, `src/core.ts` (the whole `ExecutionEnv` implementation), `src/index.ts` (the Expo backend), `package.json` | The only existing mobile `ExecutionEnv`. It answers "can Pi Durable run without Node?" — yes, with no shell. It does **not** solve storage. |
| `earendil-works/pi` monorepo, `packages/env` | `README.md` | `RemoteExecutionEnv` / `LocalExecutionEnv` over a Rust daemon — the supported remote-execution option, and it lists Android (Termux) as a supported *remote* system. |
| `RRiboulet/my-agent-setup` (this repo) | The 13 extensions and 6 skills (5 of the 6 skills survive the port, §2.7), plus `AGENTS.md` | The migration surface; §2.4 says which of them survive the port. |
| `MaliNamNam/pi-phone`, `petrroll/pocket-pi`, `heikeyangle-code/pi-android`, `TannerMidd/pi-pocket` | READMEs | Precedents for the runtime question. `pi-phone` is the one most often mis-cited as a runtime; see §1.1. |
| Web search: "Pi Durable Android foreground service SQLite storage" | — | Suggests **no** public project currently runs a Pi Durable harness inside an Android foreground service. A search cannot prove a negative; treat the service layer as unproven territory, which §5 does. |

### 0.1 Version and API drift

The plan was first written against `main` but labelled `v1.3.0`. That is a real
difference, not a citation nit: `main` at `fdce48e` is five days past the
`v1.3.0` tag (2026-10-15), its changelog is still `[Unreleased]`, and the
package version is still `1.3.0`. **The target is `main` at `fdce48e`.** Pin
that commit, not the version string.

| What this plan uses | At the `v1.3.0` tag | At `fdce48e` (target) |
|---|---|---|
| `README.md` / `docs/spec.md` | 768 / 5352 lines | 869 / 5618 lines |
| Replay rule | `docs/spec.md:3376` | `docs/spec.md:3601` |
| "Omitted `replay` is `unsafe`" | `docs/spec.md:2927` | `docs/spec.md:3152` |
| `HarnessOptions.onWake`, `Harness.wake()`, `Wake` | absent | present |
| `settings.restartLimit` (default 5, `Infinity`), `harness.retryTask()` | absent | present |
| `TaskGraphState.sleeping`, `TaskGraphNode.blocked` | absent | present |
| `TaskRuntime.sleepUntil()`, `ToolExecutionApi.now()` | absent | present |
| `@earendil-works/chord/sqlite` | absent | present |
| `DURABLE_TELEMETRY_SCHEMA`, `DEFAULT_RESTART_LIMIT` exports | absent | present |
| `defineDoc` / `defineDocFamily` `checkpointWhen` | optional | required |
| `Harness.open` | `src/harness/harness.ts` is 470 lines | line 525 |
| `openNodeSqliteStorage` | `src/storage/sqlite/node.ts:209` | `:15` |
| `test/examples/22`, `23` | present (22 byte-identical; 23 lacks the required `checkpointWhen`) | present |

Consequences:

- **If you pin `v1.3.0`,** you must remove or defer §1.10's wake/sleep/AlarmManager
  design, §3.5/§3.7's `sleeping`/`blocked`/`restart_limit`/`task_parked`/
  `retryTask` states, §4.3's restart counter, §5 R3, §6 Phase 6's restart policy,
  and the main-only names in Appendix A. The storage facade is
  `packages/durable/src/storage/sqlite/database.ts`, not `packages/chord/…`.
- **If you pin `fdce48e`,** you are on an unreleased commit whose API may change
  without notice. Pin every package (`pi-durable`, `chord`, `pi-ai`,
  `pi-codemode`, `pi-env`, `typebox`) and record the commit in the lockfile.
  The SQLite schema migrates to version 2, and **a migrated database cannot be
  opened by 1.3.0 or earlier** — a one-way upgrade for the app's data.
- `main` is the only source of the sleep/wake and restart-parking behaviour this
  plan relies on. Do not present the plan as implementable on the released
  tarball.

Platform statements in this plan (backup defaults, exact alarms, package
replacement, loopback sharing, WAL behaviour, `FileLock`) come from Android
documentation and the platform's semantics, not from the Pi Durable sources.
They are not citations; verify them against the target SDK in Phase 0.

---

## 1. Kernel architecture on Android

### 1.1 Four premises to correct first

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
Your six skills — five of which survive the port (§2.7) — therefore have to
become sections (plus tools for their scripts).

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
committed state". React Native *can* run headless JS in a `Service`, but it is
built for short tasks and is not a supported long-lived host for open
WebSockets and streaming model responses; a durable agent needs a runtime that
outlives the Activity and can be restarted underneath it. So the RN shape
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

**Shape.** The APK targets **API 35** and ships `libproot.so` under
`jniLibs/arm64-v8a` with **`useLegacyPackaging="true"`** (or
`android:extractNativeLibs="true"`), so the package manager extracts a real
executable file into `ApplicationInfo.nativeLibraryDir` and the service can
`execve` it. That setting is not optional: on `targetSdk 35`,
`android:extractNativeLibs` defaults to `false`, native libraries are then
loaded straight out of the APK, and `nativeLibraryDir` may hold only symlinks
— nothing executable. Android 10+ blocks `execve()` of files in the app home
for apps targeting API 29+, so a Termux prefix copied into `files/` is not
runnable; a native library is.

**The mechanism, because it is what S0.1 has to prove.** The process that is
executed is **proot's own binary in `nativeLibraryDir`**; proot then runs the
rootfs binaries out of `files/` through its path translation. The API-29 exec
ban does not bite, because the ban is on executing files *in the app home* —
the exec'd file is the native library, and the rootfs binaries are reached
through proot, not exec'd directly. The service runs `proot` against a rootfs
extracted under `files/`, and the rootfs carries Node, git, gh and the build
tools. **The Node process inside the rootfs is the kernel.** A custom bionic
Node (shipped as `libnode.so` and exec'd from `nativeLibraryDir`) is the later
optimization, not the v1 target.

**What you get, from the source:**

- `openNodeSqliteStorage(path)` from `@earendil-works/pi-durable/storage/sqlite/node`
  (`src/storage/sqlite/node.ts`) — which is `openNodeSqliteDatabase(path)` from
  `@earendil-works/chord/sqlite/node` at `fdce48e`, which is `DatabaseSync`
  from `node:sqlite`. WAL mode, `synchronous = NORMAL`.
- `NodeExecutionEnv` from `@earendil-works/pi-durable/env/node` — a **complete
  shell and filesystem** *interface*. It provides `exec`; `bash`, `git`, `gh`
  and `gradle` are external binaries that must be provisioned in the rootfs.
  With them present, the git-dependent workflows — `review`,
  `review-triage`, the commit, github and librarian skills, and the git viewer
  — work.
- Your extensions run on the same Node runtime, but they target a different
  API. Most keep their logic and change their registration, state shape and
  result rendering; §2.4 is the per-extension ledger. "No rewrite" is too
  strong.

**What it costs.**

- APK size: a proot rootfs plus Node, git and the build tools is large — plan
  for 100 MB+ and sideload. `pocket-pi` ships 68 MB for a smaller runtime.
- `node:sqlite` must exist in the rootfs Node. It landed in Node 22.5 as
  experimental; a Node 24/25 build should have it, but **this must be verified,
  not assumed** (spike S0.1).
- Proot is path translation, not a security boundary: syscall translation costs
  real time on every file operation. Measure it; a custom bionic Node is the
  later optimization if the cost is unacceptable.
- The native library path changes on every APK install/update (`nativeLibraryDir`
  is per-install). The rootfs path under `files/` is stable, but the launcher
  must resolve the new library path and re-verify exec after an update.
- arm64 only, in practice.
- Play Protect warnings on sideload; sideloading is fine for a personal tool.

**Verdict: the only option that keeps the shell local, which is what the
offline requirement demands.** It also has the closest prior art for the
APK/service/bridge shape (`pocket-pi`) and for proot on Android (`pi-android`).

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
`npm test`. The git-dependent workflows — `review`, `review-triage` (evidence
collection runs `git diff`), the commit, github and librarian skills, and the
git viewer — all become non-functional. A coding agent that cannot run the
tests is a chat bot.

**Verdict: not the target.** It buys a smaller APK and Play eligibility, at the
cost of the agent's core competence. It stays in the document because a
reimplementation path exists — build the git viewer on `isomorphic-git` and
rebuild review-triage on top of it — but that path costs you review, commit,
github and librarian, which defeats the point of a self-building dev
environment. For a learning project, stay on A.

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

**Verdict: C1 is out as a target.** The shell and the durability layer must
work with no network at all, and a remote execution plane is online by
definition. It stays in the document as the fallback for a failed
bundled-runtime spike (§5 R1), and that fallback is weaker than it looks: it
trades the offline requirement for a Tailscale dependency on a machine that
may be asleep.

Note what stays cheap: the IPC layer, the storage layer, the UI and the
durability model are identical between A and C1; only the `ExecutionEnv`
implementation changes. That keeps the *factory* swap to one line. It does not
keep the product identical: under C1 the shell, the workspace and the on-device
build loop live on the box, so the self-building loop in §4 is no longer
on-device. C1 is a fallback for durability, not for the phone-native build
story.

### 1.6 Decision

**Target: Option A** — Kotlin Android host shell, Pi Durable kernel in a
foreground service on a bundled Node runtime, a web client served over loopback
and hosted in a WebView, `NodeExecutionEnv` (decorated with an Android bridge
for phone capabilities), SQLite owned by the kernel process.

The runtime is a **proot rootfs** launched from `nativeLibraryDir` under
`targetSdk 35`; a custom bionic Node is a later optimization. On-device Gradle
is a Phase 5 experiment with a host fallback, not a v1 requirement.

**If S0.1's proot path fails**, try the custom bionic Node first. **Ship C1 only if
the runtime cannot work at all** (proot and a custom Node both fail), and accept
what that costs: the offline requirement goes with it, the shell and the
workspace move to the box, and the on-device build loop in §4 becomes a remote
build. The IPC, storage, UI and durability model are unchanged; the
`ExecutionEnv` factory is the one-line seam:

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

`HarnessOptions.env` is a factory, not an `ExecutionEnv`: pass
`env: (target, context) => envFor(target.cwd ?? defaultWorkspace)`. `envFor` must
set `ExecutionEnv.cwd` (required by `FileSystem`), which `NodeExecutionEnv` does
from its constructor.

**Escalation order, and why:** Option A is chosen because the review, commit,
github, librarian and update-changelog workflows and the git viewer need `git`,
and because the shell and the durability layer must work with no network at
all. Option C1 is out as a target: its shell lives on another machine, so it
cannot satisfy the offline requirement. Option B is out for the same reason the
shell matters — a git-less environment would cost review, commit, github,
librarian and update-changelog, which *is* the self-building dev environment.
Reimplementing the git viewer on `isomorphic-git` and rebuilding review-triage
on top of it would technically get you there, and would not be worth it for a
learning project. Stay on A.

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
// src/storage/sqlite/storage.ts imports no Node APIs; its non-local imports are from @earendil-works/chord.
```

and the facade contract is small (`packages/chord/src/sqlite/database.ts` at
`fdce48e`; at the 1.3.0 tag the same interface is
`packages/durable/src/storage/sqlite/database.ts`):

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
it also de-risks Option B for free. **S0.2 runs only if Option B is still
live** (§5 R2, §6 Phase 0): on the Option A target this facade is not on the
path, so do not plan a spike for it.

**One more storage rule you must internalize:** "One process owns a storage at a
time; there is no cross-process locking." Only the kernel process opens the Pi
database. The web client never touches the `.sqlite` file — it reads through
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

1. **Exactly one kernel process at a time.** The service starts exactly one
   child; the child takes `processLock("pi-durable:<pkg>")` from
   `@earendil-works/chord/node` at startup (on Android it is an abstract socket, so
   it vanishes with the process and leaves no stale file). A second kernel that
   cannot take it refuses to start. S0.1 verifies the abstract-socket behavior
   on the target device; if it does not behave, fall back to a child-owned
   `FileLock` on `pi/kernel.lock` with a pid + start-time record. The service
   never hands a Java `FileLock` to the child. This is the enforcement of "one
   process owns a storage at a time".
2. **The kernel owns the database.** The Activity never opens it.
3. **The Activity is disposable; the app process is not.** Rotation, config
   change, "don't keep activities" and WebView renderer death destroy the
   Activity without touching the kernel. **Low memory can kill the whole app
   process**, taking the service and its Node child with it; that is a kernel
   restart, not an Activity event, and SQLite + `resume()` handle it. If you
   want app-process isolation, put the service in a separate
   `android:process=":kernel"`; that isolates processes, **not uids** — the
   shell still runs as the app uid and can reach `pi/`. `am force-stop <pkg>`
   kills every process of the package (and suppresses restart), while `am kill`
   only kills processes the system deems safe.
4. **Graceful stop is best-effort.** `onDestroy` sends `SIGTERM` and the kernel
   traps it and calls `harness.close(context)`, but Android does not guarantee
   `onDestroy` on a system kill. Use an explicit stop action and
   `stopService`/`stopSelf` for the graceful path, and treat `SIGKILL` (OEM
   killer, an explicit `kill -9`, low memory) as the normal crash path — see §5 R3.
5. **The service supervises.** If the kernel exits, the service restarts it and
   the kernel calls `Harness.open(...)` + `harness.resume()`, which picks up
   whatever the last process left unfinished ("Work interrupted by a crash or
   close stays pending. `resume()` starts the task scheduler").
6. **The WebView is disposable and untrusted.** It holds no durable state and
   never opens the SQLite file. It may be killed by the WebView renderer
   process death, rotation, or low memory; reconnect always starts from a
   fresh snapshot (§3.8).

### 1.9 The kernel↔UI contract

The UI must render committed state and nothing else. The contract is a
**projection folded from one commit stream**, not a merge of independent
watches.

**Source of truth: `harness.subscribeCommits(listener)`.** The listener runs
synchronously on the Session line with `{ seq, changes }` and must not block or
call Session APIs (`docs/spec.md:1702`). The kernel folds `changes` into
semantic events and enqueues `{ seq, events }`; a separate pump writes to the
WebSocket. `seq` is a watermark — strictly increasing, gaps permitted — not a
resume token.

**Snapshot: subscribe, buffer, then a no-write commit barrier.** Subscribe first
so no commit is missed; buffer publications. Then run
`harness.commit(async (tx) => { ... })` with no writes. A no-write commit
returns without publishing (`writes.length === 0`), so the snapshot's watermark
is the **last buffered publication's `seq`**, not the barrier's. Read on that
line through `tx`: the scoped conversation's record, its active entry range
(`latestHeadMarker` + `scanEntries`), the task records (`scanTasks`), the
conversation edges (`scanConversations`), and the known singleton docs
(`AgentDoc`, `LiveDoc`, `InboxDoc`, `UsageDoc`, `ProviderDoc`, `app.*`). The
live task graph is read with `harness.taskGraph()` after the barrier and
included in the snapshot; it is the same committed state, one read later. Drop
buffered publications with `seq <= snapshotSeq`; replay the rest. Commits are
serialized and the listener runs in `#publish`, so every commit up to the last
buffered seq is included.

**Snapshot scope: one conversation per subscription, plus a child index.**
A snapshot is scoped to a conversation, and the scope is decided at attach:
the default scope is the root conversation, and a client that opens a child
view (§3.6) attaches a **second subscription** to the same kernel —
`WS /v1/events?conversation=<id>`. The kernel holds **one**
`harness.subscribeCommits` listener and fans the folded events out to every
connection; each connection keeps only what its scope covers — entries by
`EntryRecord.conversationId`, conversation-scoped docs by their
`conversationId`, and every global document. The fan-out is **enqueue-only**:
the listener enqueues onto each connection's own queue and returns, and a
separate pump writes to that connection's socket. A slow client therefore
cannot stall the commit line — it can only fill its own queue and lose its
own events. What a scoped snapshot carries:

- the scoped conversation's record and its **active entry range**;
- a **child index** — for every conversation it owns, the id, the creator edge
  (`ConversationRecord.owner`) and the fork edge (`ConversationRecord.parent`),
  **metadata only, no transcripts**;
- the live task graph (global: every node carries its `conversationId`);
- the singleton docs — the ones scoped to this conversation (`AgentDoc`,
  `LiveDoc`, `InboxDoc`, and the `app.*` docs that carry a conversation scope)
  plus the global ones (`UsageDoc`, `ProviderDoc`) — plus usage and the
  submissions.

**No snapshot ever carries more than one conversation's transcript.** The
alternative — every conversation's active transcript in one payload — is
unbounded, and the memory argument in §1.7 applies to transcripts just as it
does to JSONL. And the child transcript is **not** paged in from
`GET /v1/entries` either: paging goes *behind* the active window (§3.4), so a
paged seed would not be the active transcript, and §3.1's invariant — "the
projection is fully reconstructible from a snapshot" — would not hold for the
child view. The child view therefore gets its own scoped snapshot, and paging
then works for it exactly as it does for the root: behind that scope's own
active window. `btw` panels (§2.5) are the same shape — their own
conversation, their own scoped subscription, their own snapshot.

**Singleton app docs, not doc families.** `Tx` has no `scanDocuments`, so a
family cannot be enumerated in the snapshot barrier. The app-state docs are
therefore singletons: `app.todos` is a map of id → todo, and `app.goal`,
`app.triage.decisions` are singletons. This is the long-term answer for
phone-scale state, not a v1 shortcut: one doc is atomic, readable in the
barrier, and has no key-enumeration problem. Revisit families only if a single
doc becomes too large, and then add an index doc updated in the same commit.

**Event vocabulary (v1).** All events carry the publication `seq`:

| Event | Payload | Derived from |
|---|---|---|
| `snapshot` | the scope's conversation + active entries + child index + docs + live task graph + usage + submissions, with `seq` | the no-write barrier + the known singleton docs + `taskGraph()` |
| `entry` | `EntryRecord` (append only; carries its `conversationId`) | `entry` changes |
| `doc` | `{ kind, key?, value, ops?, conversationId? }` | `document.create` / `change` / `retire`. `conversationId` is present for conversation-scoped docs (`pi.live`, `pi.inbox`, `app.*`), so a scoped subscription can route it; a document with no scope is global and goes to every subscription. |
| `taskgraph` | the live `TaskGraph` (small) | a full-state message sent after a publication that touched tasks; it carries the last publication `seq` for correlation but is **applied unconditionally**, never dropped on an older seq. It reflects committed state at fetch time and is never used to infer progress |
| `submission` | `SubmissionRecord` (carries its `conversationId`) | submission changes; routed by `conversationId`, like `entry` and conversation-scoped `doc`s |
| `snapshot` on overflow | the scope's full projection again | when the kernel's bounded queue overflows |

No separate `run`/`usage` events: `pi.live` and `pi.usage` arrive as `doc`
changes. Streaming is the `pi.live` doc: it commits `generation.message`,
`tools[].output`, `retry` and `compactions` at most every 100 ms
(`DEFAULT_PROGRESS_POLICY`), and the final `entry` arrives when the generation
settles. That is committed streaming; do not also forward `watchEvents` deltas,
which would give the client two sources for one projection.

**Head writes.** `pi.reset`, handoff and a compaction summary append an entry
carrying `head`, which shrinks the active transcript; no append-only event can
express that. Emit a full `snapshot` on any publication containing an entry with
`head` — **for the scope that conversation belongs to** (a head write in a child
conversation does not disturb the root's snapshot, and the root's snapshot does
not contain the child's transcript anyway). Reset and compaction are rare;
optimize to `entries_replaced` later if the snapshot is too large.

**One snapshot path.** The WS `snapshot` at attach is the only client path.
`GET /v1/snapshot` remains a `curl`/debug endpoint; the client never uses it.
The scope travels in the attach URL (`?conversation=<id>`), not in a second
endpoint, so a child view is the same path with a different scope.

**Paging.** The snapshot is the active transcript **of the scope**.
`GET /v1/entries?conversation=<id>&before=<id>&limit=N` uses
`conversation.entries({ maxEntryId, order: "descending" }, limit, cursor)`;
"load older" pages behind the oldest snapshot entry, and past-head entries
render only below the head marker.

**Backpressure.** Each connection's queue is bounded, **per connection** — a
slow child view must not force a resnapshot of the root. When one overflows,
drop that connection's queue and send that connection a fresh `snapshot`;
never `await` the socket in the commit listener. The client keeps the last
applied `seq` and ignores older envelopes; a `doc` event carries its
publication `seq`, so a stale doc does not overwrite a newer snapshot value.
`taskgraph` is the one exception: it is full-state, not seq-ordered, so it is
applied unconditionally (see the event table) and never dropped on an older
`seq`.

**Available, but not the WS stream:**

| Primitive | Use |
|---|---|
| `harness.subscribeCommits(listener)` | the stream's only source; `{seq, changes}` |
| `conversation.viewState(context)` / `.watch(context)` | single-conversation debugging and the CLI; no `seq` |
| `watchEvents(harness, conversationId, context)` | coding-agent-style stream for one conversation; not the WS contract |
| `harness.watchTaskGraph(context)` | the graph watcher; the WS sends a full `taskgraph` event instead |
| `conversation.entries(query, limit, cursor, context)` | paging behind the snapshot |
| `harness.inspect(context)` | the reconnection/Recovery sheet |

**Why a semantic layer and not raw Chord ops:** the UI's needs are "append an
entry", "this tool call's output grew", "this task is now waiting on X". Those
are domain facts. Chord ops are a *storage* delta format. Translating in the
kernel means the web client has ~20 message types instead of a JSON-patch engine
plus Pi's document model, and the translation is unit-testable in JS against
the conformance suite.

**Transport.** Loopback HTTP + WebSocket on `127.0.0.1`, with a per-launch
bearer token, exactly as `pocket-pi` does with its `127.0.0.1:9998` bridge.
Binding to `127.0.0.1` (not `0.0.0.0`) keeps the server off the network, but
**it does not keep other apps out**: loopback is shared across apps on the
device. The bearer token is the access control. A browser WebSocket cannot set
an `Authorization` header, so carry the token in a subprotocol or a one-time
ticket, never in a query string. Use a `NetworkSecurityConfig` with a
`domain-config` for `127.0.0.1`; `android:usesCleartextTraffic` is app-wide and
cannot be scoped to loopback. Even loopback needs the `INTERNET` permission.

```
WS  /v1/events?conversation=<id>
                     →  { t:"snapshot", seq, … }  then  { t:"batch", seq, events:[…] }
                        (omit ?conversation for the root scope)
POST /v1/commands/…     →  submit | abort | compact | resume | retryTask
                            | abortTask | fork
GET  /v1/entries?conversation=<id>&before=<id>&limit=N
                     →  paged history for that scope
GET  /v1/usage          →  session-wide totals (not atomic; documented)
```

`steer` is not a separate command: it is `submit` with `whenBusy: "steer"`.

In development, the kernel runs the web build's dev server **on the phone** —
Vite inside the same Node runtime, bound to loopback — so the WebView gets
hot-module replacement with no host machine and no USB port. In production, the
kernel serves the built assets from the APK/workspace at `GET /`. The event
protocol is identical in both modes.

### 1.10 Foreground service specifics

- **Type.** Android 14 (API 34) requires a `foregroundServiceType` and the
  matching permission. `dataSync` is the honest fit (the service is moving
  data for the agent) but it has a **6-hour-per-24h hard cap** on Android 15+.
  `specialUse` has no cap but requires a justification in the Play listing.
  For a sideloaded personal tool, `specialUse` is the pragmatic choice.
- **Notification.** A persistent, low-importance notification showing the run
  state ("Working…", "Waiting for you", "Idle"). It is also the only honest
  way to tell the user the agent is alive.
- **Version note.** The wake/sleep API below is post-1.3.0 (`main` @ `fdce48e`);
  `Harness.wake()`, `Wake`, `onWake` and durable sleeps do not exist at the
  `v1.3.0` tag. On 1.3.0 this section must be replaced by `TaskRuntime.sleep()`
  and host timers.
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
  evicted, such as a Cloudflare Durable Object, wakes it itself"). Check
  `canScheduleExactAlarms()` first: on Android 14+ `SCHEDULE_EXACT_ALARM` is
  denied by default for most apps, so fall back to `setAndAllowWhileIdle()`.
  `setExactAndAllowWhileIdle` is rate-limited to roughly one firing per nine
  minutes per app in Doze, so a `wake.at` closer than that fires late. Use
  AlarmManager for sleeps/backoffs longer than the limit; keep short retry
  backoffs in-process while the service is alive. Re-arm alarms from the
  persisted DB on every service start: force-stop and reboot clear them, and
  `wake()` needs an open Harness. Document the measured latency. The
  `specialUse` type also needs the
  `android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE` manifest property.
- **WebView lifecycle.** Renderer death cannot be recovered by reloading the
  same `WebView`: remove it, destroy it, drop references and create a new one;
  `onRenderProcessGone` must return `true` or the app crashes. Use
  `WebViewAssetLoader` with an `https://appassets` origin for the shell, a
  strict CSP, and a `NetworkSecurityConfig` `domain-config` for `127.0.0.1`.
  Treat model/tool output as untrusted HTML; sanitize before rendering.
- **Storage location.** App-private internal storage (`Context.filesDir`, i.e.
  `/data/user/<n>/<pkg>/files/…`) — no permissions needed, and gone on
  uninstall. It is **not** excluded from backup by default: `android:allowBackup`
  defaults to `true`, and Auto Backup includes internal files and databases.
  Set `android:allowBackup="false"` **and** a `dataExtractionRules` exclusion
  for `pi/` covering both `<cloud-backup>` and `<device-transfer>`; the
  attribute alone is not enough on Android 12+. The app gains an explicit
  export/import instead, whose format is still open (Appendix B). Do not rely
  on a WAL/main pair restored from different backups; the reason to exclude
  the database is restore semantics and size, not the WAL format itself.

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
| (state tokens) | `defineDoc` (singleton); `defineDocFamily` deferred (§1.9) | Your durable state: todos, goals, subagent registry, triage decisions. These are conversation/session/task tokens, not an `Extension` slot. |

And the mapping from pi-coding-agent concepts:

| pi-coding-agent (this repo) | Pi Durable |
|---|---|
| `pi.registerTool({name, parameters, execute})` | `defineTool({name, parameters, execute, replay})` |
| `pi.registerCommand(name, handler)` | a tool the model may call **plus** a UI affordance that submits a canned input |
| `pi.registerShortcut(key, handler)` | gone — replace it with an explicit UI affordance (e.g. `continue` gets a **Continue** button in S2) |
| `pi.registerMessageRenderer(kind, fn)` + `pi.sendMessage({customType})` | `defineEntry(kind)` + `conversation.submit({type:"write", entry:{kind,data}})` |
| `renderCall` / `renderResult` | the `details` field of a tool result + the app's own renderer |
| `pi.getThinkingLevel()` | `conversation.configure({thinkingLevel})` |
| `ctx.cwd` | `agent.cwd`; `ExecutionEnv.cwd: string` is required by `FileSystem`, so the `env` factory must supply it (from `EnvTarget.cwd` or a default workspace) |
| `pi.registerFlag` / provider registration | `HarnessOptions.models` — a `Models` from `@earendil-works/pi-ai/models` |

Two structural wins fall out of this:

- **Custom entry kinds are first-class.** `defineEntry` + a `submit({type:"write"})`
  gives you an append-only, typed event stream in the transcript — exactly what
  `goal.ts` does today with "custom session entries".
- **Extension state stops being a file format.** `todos.ts` currently invents a
  JSON-front-matter-plus-markdown file format with lock files and a GC pass.
  In Durable it is one `app.todos` singleton doc: a map of id → todo, committed
  atomically with the entry that changed it. No locks, no GC, no parsing. One
  doc is also what the snapshot barrier can read; §1.9 explains why not a
  family.

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
   `unsafe`." The four coding tools in `src/tools/*.ts` — `read`, `write`,
   `edit`, `bash` (and `powershell`) — declare no `replay`, so they are unsafe
   by default. **They are not the only built-in tools:** the shipped `codemode`
   (`src/codemode/codemode.ts:245`) and `tool-search`
   (`src/tool-search/tool-search.ts:62`) extensions do declare
   `replay: "safe"`. "Every built-in tool is unsafe" is false; the safe/unsafe
   split is per tool.
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

**The hard case is `read`.** A file is mutable external state: the arguments do
not determine the bytes, and a rerun after a crash can read a different file.
That is fine if you accept "read the file as it is now" as the tool's semantics,
but it is not the spec's "pure transformation". `read` is also only pure when
the app does not configure an `ImageProcessor`: `createReadTool({ images })`
can make a paid image-model call. The `SafeRead` declaration below uses
`createReadTool()` with no image processor; do not reuse it on an image path.
If you need the exact bytes the first attempt saw, capture them in a memo or
mark the call unsafe.

### 2.4 Per-extension plan

The table covers the extensions and skills that survive the port, the new git
viewer, and the one shortcut that becomes a UI affordance.

| # | Extension | Durable form | Replay | Notes |
|---|---|---|---|---|
| 1 | **review-triage** (`triage_change`) | `triage_change` **tool** + `app.triage.decisions` **doc** | **unsafe** | It runs `git` and pays for a classifier call. The *decision* is written to a doc in the same commit, so the audit trail is durable rather than a transcript artefact. |
| 2 | **goal** (`get_goal`, `create_goal`, `update_goal`) | three **tools** + `app.goal` **doc** (scope: conversation, `history: "rewindable"`) | `get_goal` **safe**; `create_goal`/`update_goal` **safe if** a stable `goalId` is in the arguments, else **unsafe** | Today's implementation reconstructs state from the active branch on reload. A `defineDoc` with `history: "rewindable"` gives that for free, plus `snapshotAsOf()`. |
| 3 | **todos** (`todo` with 9 verbs) | one **tool** + `app.todos` **singleton doc** (a map of id → todo) | **safe only with an idempotency key** — `create` and `append` are **unsafe** as they stand | Today's `create` ignores the optional `id` argument and generates `crypto.randomBytes(4)` + `created_at`; a rerun would create a second todo. `append` appends text, so a rerun appends it twice. The port must take a caller id / idempotency key and memoize `created_at`, and give `append` a per-call key, or leave both unsafe. `update`/`delete` are idempotent by id (same values); `claim` must return success on a same-call rerun, not "already claimed". One doc is the long-term phone-scale answer: `Tx` has no `scanDocuments`, so a family cannot be enumerated in the snapshot barrier (§1.9). |
| 4 | **voice** (`/voice`) | **not an extension** — becomes an input path in the web client (MediaRecorder or a native bridge) | n/a | The phone *is* the microphone now. The app records, transcribes, and calls `conversation.submit({type:"input", content})`. The current implementation reaches the phone over ssh from a desktop; that inversion is the entire point of this project. |
| 5 | **answer** (`/answer`) | `answer_questions` **tool** (model call → structured JSON) + a web screen that collects the answers and submits them | **unsafe** | Paid model call. The interactive TUI becomes a web sheet. The compiled answers become one follow-up input. |
| 6 | **session-breakdown** | `session_stats` **tool** + a web stats screen | **safe** | It reads `~/.pi/agent/sessions/*.jsonl` today. In Durable the transcript *is* the database: read `harness.usage(context)` and scan entries. Strictly better. |
| 7 | **btw** (side-question panel) | `btw` **tool** + a **background anchor task** + a child conversation | **safe only with the §2.5 idempotency pattern**, otherwise **unsafe** | The panel becomes its own conversation, so it adds nothing to the parent transcript — and the anchor task is durable, so the answer survives process death. A rerun must find the existing child and submission (`scanConversations({ ownerTaskId })`, `requestId`), not create a second panel. Same pattern as §2.5. |
| 8 | **review** (`/review`) | `review_start` **tool** that creates an `app.review` **task** with phases `collect → plan → run` | **unsafe** (spawns git + child conversations) | The *review children* are owned conversations, so they survive process death. |
| 9 | **native-web-search** (`web_search`) | `web_search` **tool** | **unsafe** | It spends money on a search provider. Prefer an in-process call over spawning the Node script where the provider SDK allows it; it still needs network and the provider's native-search request shape, so this is a port, not a `fetch` one-liner. |
| 10 | **opencode-go-provider** | **kernel configuration**, not an extension | n/a | Durable gets models from `HarnessOptions.models`. Build the `Models` with the opencode-go provider registered at kernel start; no durable artifact. |
| 11 | **git viewer** (new; supersedes `repo-explorer`) | a **web screen** + dedicated read-only `git_*` **tools** over the `ExecutionEnv`: list branches, browse a tree, read a file | **safe only for non-mutating commands** (`show`, `ls-tree`, `cat-file`); **unsafe** if it goes through `bash` | The screen itself has no replay policy; the tools do. `git status` can refresh and write `.git/index`, so keep it out of the safe set. The tool-vs-`bash` choice is still open (Appendix B #9). It replaces `repo-explorer` rather than porting it. **Needs git** — under Option B it cannot be built at all (§5 R4). |
| 12 | **skills** (commit, github, librarian, native-web-search, update-changelog) | **sections** + the tools their scripts need | n/a for sections; the `git_*`/`gh_*` tools are **unsafe** | §2.7. `update-changelog` needs `git describe`/`git log`; `native-web-search` is a Node script over pi-ai, not a git workflow. The `tmux` skill is dropped as a product decision (no interactive Python/gdb/psql targets on the phone), not because durable ownership removes tmux sessions. |
| 13 | **continue** (shortcut) | **not an extension** — a **Continue** button in S2 that submits a literal "continue" input only when the conversation is idle | n/a | The shortcut's only behavior is `sendUserMessage("continue")` when `isIdle()`. No durable artifact, no tool. |

On `main` @ `fdce48e`, every `defineDoc` / `defineDocFamily` also requires a
`checkpointWhen` predicate (the tag made it optional). Use `() => false` for
ordinary delta-only documents, or a periodic base policy for long-lived state.

**The built-in tools.** `read`, `write`, `edit`, `bash` ship unsafe. `read` is
the one worth upgrading *when no image processor is configured*: with plain
text it only reads, and on a phone a process death mid-`read` is common.
Upgrade it by re-declaring it in a later extension (a same-named tool replaces
an earlier one where both are selected; install `safe-read` after
`coding-tools`). `codemode` and `tool-search` are already `safe`; they are not
part of this override.

```ts
// kernel/extensions/safe-read.ts
import { createReadTool } from "@earendil-works/pi-durable/tools";
const read = createReadTool();
export const SafeRead = defineExtension({
  name: "safe-read",
  tools: [{ ...read, replay: "safe" }],   // same name → replaces the built-in where selected
});
```

`createReadTool()` has no image processor. If the app uses
`createCodingTools({ images })`, a re-declared `createReadTool()` drops image
processing; pass the same options or keep the image path unsafe.

`write`, `edit` and `bash` stay unsafe. `edit` is *nearly* idempotent (it
matches `oldText`), but a partially-applied edit that then died leaves the file
in a state where `oldText` no longer matches, so a rerun fails confusingly.
Keeping it unsafe means the model gets the `interrupted` diagnostic and
decides — which is the right trade.

### 2.5 Subagent: implement the owned-child pattern

**Do not port the tmux-based `subagent` extension.** Its tmux sessions, its
`runs.json` state, its polling watcher and its five management tools are all
re-implementations of the **ownership primitives** Pi Durable provides — child
conversations, `ownership: { kind: "task" }`, `scanConversations`, and
`requestId`. **There is no shipped subagent task to switch to:**
`BUILTIN_TASKS` is `[GenerationTask, ToolTask, CompactionTask]`. Pi Durable
documents an *owned-child-conversation pattern*; the app writes the tool and,
for persistent subagents, the anchor task. The examples exist at both
`v1.3.0` and `main`: `test/examples/22-subagent-foreground.ts`
is byte-identical, and `23-subagent-background.ts` differs only by the
now-required `checkpointWhen` predicate. Example 23's combined spawn/send/stop
tool is `replay: "unsafe"`; only the foreground tool (22) is safe.

The pattern, in one sentence: the foreground subagent tool (example 22) is
`replay: "safe"`; it creates its child conversation inside `api.commit()` with
`ownership: { kind: "task", taskId: api.taskId }`, reuses an existing child by
`scanConversations({ ownerTaskId })`, then drives it through
`api.conversation(id)` with a request id derived from `api.taskId`. The
replay/idempotency half is not optional: without it, a process death after the
child is created either spawns a second child or abandons the first. The
persistent combined tool (example 23) is `replay: "unsafe"` because a rerun of
`stop` could stop newer work; split `stop`/`send` out of the safe spawn tool if
you port it.

The ownership types, from `src/types.ts`:

```ts
// src/types.ts:365
export type TaskOwnership = { readonly kind: "conversation" } | { readonly kind: "task"; readonly taskId: TaskId };
// src/types.ts:394
export type ConversationOwnership = { readonly kind: "ownerless" } | { readonly kind: "task"; readonly taskId: TaskId };
```

The durable recipe, from the README:

- `replay: "safe"` on the tool.
- In the creating commit, `scanConversations({ ownerTaskId: api.taskId }, 1)`
  first; only create if it returns nothing.
- `api.details({ conversationId })` from the running call, so the UI can attach.
- Submit with `requestId` set to `subagent:${api.taskId}`; a rerun keeps it and
  does not send twice.
- For persistent subagents, an anchor task per child and a background reporter
  task per message, so the parent's abort and idle wait do not reach them
  (`test/examples/23-subagent-background.ts` on `main`).

What ownership buys, in one line: aborting the call aborts the child, the
parent is idle only once the child is, and an owning task created with
`{ background: true }` survives the parent's abort. The flag is on
`TaskOptions` (the owning task), not on the conversation record.

What the UI needs from it is the child's conversation id, which the tool
reports through `api.details({ conversationId: child })`. That is how the
subagent view (§3.2's S5, §3.6) opens a second view over the same commit
stream, filtered to the child — no tmux
target, no attach command, no pane scraping.

### 2.6 Hooks worth adding on a phone

Hooks are Pi Durable's cross-cutting lever, and a phone is exactly where you
want them.

| Hook | Task | Purpose |
|---|---|---|
| `beforeTool` guard | `ToolTask` | Block or rewrite dangerous commands on a phone: `rm -rf`, `git push --force`, anything touching paths outside the workspace. `{ block: "…" }` produces a `blocked` error result the model sees. **This is the single most valuable hook for the mobile port**, because the phone is where a stray `rm` is unrecoverable — as a guardrail, not a boundary (§2.8). |
| `beforeTool` rewriter | `ToolTask` | Rewrite `cwd`-relative paths into the app workspace. This is convenience, not containment: absolute paths, `sh -c`, and interpreters still bypass it (see the sandbox note below). |
| `afterTool` redactor | `ToolTask` | Strip API keys / tokens from tool output before they enter the transcript. **Caveat from the README:** "An `afterTool` hook that redacts a schema tool's `output` must redact its `structuredOutput` too." |
| `afterTools` | `GenerationTask` | Emit a durable "turn complete" marker into a doc; the web status bar can then show "idle, last turn N". |
| `beforeCompact` | `CompactionTask` | Inject a phone-specific compaction instruction ("keep file paths and command names verbatim"). |
| `beforeRequest` | `GenerationTask` | **Not for volatile device state.** The README warns: "A section that returns something different every time, such as the current time, defeats that [prompt caching]." Put battery/network/foreground state in a stable `section` (updated only on a meaningful change), not a per-request hook. |
| Phone-capability bridge | — (not a hook) | The web client cannot directly call every Android API. Expose a narrow native bridge for microphone, file picker, notifications and share intents only, and keep it outside the durable state path. The bridge is not a tool; it is an app-to-app IPC surface for the WebView. |

**The guard is not a sandbox.** `beforeTool` can rewrite arguments and block a
call, but it sees the command string, not the syscalls. A same-uid `bash` can
reach `pi/session.sqlite` and the credentials; `android:process=":kernel"` is
process isolation, not a uid boundary. Treat the hook as an accident guardrail,
not the boundary; §2.8 states the threat model and the controls (no secrets in
env, user-confirmed extension installs, curated exec, SAF export). §4.4 and §5
R10 apply it.

### 2.7 Skills become sections

Pi Durable has no skill loader. A skill becomes:

1. **A section** that renders the skill body — `section("skill:commit", () =>
   skillText, { tag: false })`. Sections are rendered before each request and
   "Only what changed is sent again, which keeps provider prompt caches warm."
   Put the body in the app's assets (or the workspace) and read it through the
   `ExecutionEnv`.
2. **Tools** for anything the skill's scripts do — `git`, `gh`. Under
   Option A these are `bash` calls; under Option C1 they are `bash` calls
   through `RemoteExecutionEnv`.
3. A **doc**, if the skill has state (`update-changelog` has a file to edit;
   `librarian` has a cache).

The `commit` skill becomes a section + `git_status`/`git_diff`/`git_commit`
tools with **`replay: "unsafe"`** (a commit is a non-idempotent side effect).
The `github` skill becomes a section + `gh_*` tools, also unsafe (a PR is
created). `update-changelog` needs `git describe`/`git log`; `librarian` needs
`git clone` and the network; `native-web-search` is a Node script over pi-ai,
not a git workflow. The `tmux` skill is **not** ported as a product decision:
the phone has no interactive Python/gdb/psql targets, and the subagent
extension's tmux use is separately replaced by task ownership. Do not justify
the drop with "no tmux sessions left" — the skill is for interactive CLIs, not
for subagent sessions.

### 2.8 Security model

**The threat model is explicit.** The agent is trusted code. The durable
kernel, the agent's shell and the SQLite file share one Android uid. A
`beforeTool` hook sees command strings, not syscalls; `node -e`, `python -c`,
`find -delete`, absolute paths and symlinks bypass a deny-list.
`android:process=":kernel"` is process isolation, **not a uid boundary**;
`sharedUserId` is the same uid; proot is path translation, not a security
boundary. Do not claim the agent "cannot break the kernel." The guard is an
**accident guardrail**; the recovery path is a scheduled export.

**Secrets never live in the kernel environment.** The host decrypts the model
key from the Keystore and passes it once over a pipe/fd; the kernel holds it in
memory. Every `exec` runs with `inheritEnv: false`, and that is a **per-call**
option on `ShellExecOptions` (`src/env/index.ts:303`), **not** a constructor
flag: `NodeExecutionEnv`'s constructor takes a base `shellEnv` and no
`inheritEnv`, and `getShellEnv` merges `process.env` unless the call says
otherwise (`src/env/node.ts:270-281`). So the scrub is enforced by wrapping the
env once and passing `inheritEnv: false` on every call. `git`/`gh` get
credentials per command (`env: { GH_TOKEN }` on that one spawn), never in
`process.env` and never in `.git/config`.

**Agent-written extensions are user-confirmed installs.** The agent writes
`workspace/extensions/foo.ts`; the kernel shows the file, hash and diff; the
user taps **Install**; then `registry.install()`. This is the v1 default. A
**trusted session** upgrade path exists: the user can pre-authorize a pinned
key/hash (or an "auto-install signed extensions" mode) so a long self-building
session does not ask on every iteration. Default off. An agent-written
extension is kernel code, not sandboxed code.

**Curated exec by default; raw shell is gated.** The default toolset is
`git_*`, `gh_*` and `build` with an argv allow-list and workspace path
validation. A `shell` tool exists but is `replay: "unsafe"` and asks for
confirmation outside the allow-list. `build`/`gradle` still executes repository
code, so this is a guardrail, not a boundary. It reduces accidents; it does not
contain a malicious agent.

**Recovery: scheduled SAF export.** After a turn (or on a timer), the kernel
writes a redacted JSON/Markdown projection to a user-picked SAF directory. The
export excludes secrets. The SQLite file stays private. If the agent corrupts
the store, the user restores from the export; that is the durability backstop,
not the `beforeTool` hook.

**A real boundary is a separate spike.** A second app package with its own uid
(a worker APK) that owns the workspace and runs `bash`/gradle, with AIDL
copy-in/copy-out and no access to `pi/` or credentials, is the only real
boundary. It is a separate spike/decision, not v1. Do not use `sharedUserId`
(same uid, deprecated), `:kernel` (same uid), or proot (not a boundary) as if
they were one.

**Phase order.** Secrets, the SAF export and `processLock` land in Phase 1.
Curated exec and user-confirmed extension install are Phase 4/5, before the
self-building loop. Phase 5 depends on them: install gate, boot reinstall, and a
recoverable store.

---

## 3. UI/UX plan (web client in a native host)

### 3.1 The invariant

> **The UI never owns progress.**

The mechanical statement: **every pixel the web client shows is a projection of
committed state, and the projection is fully reconstructible from a snapshot.**
Each open view — the root transcript or a child conversation (§3.6) — is
scoped to one conversation, and each is reconstructible from *that scope's*
snapshot (§1.9).

Consequences, each of which is testable:

1. **No local progress state.** Not "is the agent running?" — that comes from
   `docs["pi.live"].run`. Not "is this tool still going?" — that comes from the
   tool slot's `status` and `output`. Not "did my send succeed?" — that comes
   from the `SubmissionRecord` (`submission` events / `harness.submission`).
2. **The Activity can be destroyed at any instant** and be rebuilt with zero
   loss, because a fresh Activity attaches to `WS /v1/events` — with the scope
   it is showing — and receives a fresh `snapshot`. Rotation, process death by
   the OS, "don't keep activities", a configuration change — all non-events.
3. **A button never implies an outcome.** "Stop" does not set a local
   "stopping" flag; it sends `POST /v1/commands/abort` and the UI changes when
   the abort's effects are committed. The button's enabled/disabled state comes
   from the committed run state (`TaskGraphNode.abortRequested`), not from a
   local flag.
4. **The UI cannot be ahead of the kernel.** The kernel is the only writer of
   durable state; the UI is a subscriber. There is no path by which the UI
   writes state the kernel does not know about.
5. **Streaming is committed too.** The partial answer and tool output come from
   `pi.live` doc commits (at most every 100 ms); the final `entry` arrives when
   the generation settles. There is no separate volatile token stream.

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

The **Continue** affordance from the `continue` extension is a button that
submits `"continue"` only when the committed run state is idle; it must not
steer or queue a mid-run turn.

**S3 — Status strip.**
Derived from `docs["pi.live"]`:

| Field | Meaning |
|---|---|
| `run` | present exactly while busy: `{ taskId, inputs }` |
| `generation.attempt` / `.message` / `.retry` / `.deferred` | the in-flight model turn, its partial, its backoff, a provider-side deferred response |
| `tools[]` | the current round's tool calls: `status`, `output`, `droppedBytes`, `details`, `diagnostics` |
| `nestedTools[]` | nested calls, with `parentTaskId` and `arguments` |
| `compactions[]` / `compactionFailure` | background compaction, and the last failure |
| `abortRequested` | a committed stop request (`TaskGraphNode.abortRequested`); show "Stopping…" until the task terminalizes |

Rendered as: a spinner + "Working", the current tool name + a truncated output
tail, a retry countdown, a compaction notice. **Never** a local "thinking"
animation that is not backed by a field.

**S4 — Task panel.**
From the `taskgraph` event (the same data as `harness.watchTaskGraph`):

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

`TaskGraphNode.blocked` and the `sleeping` state are post-1.3.0 (`main` @
`fdce48e`); at the `v1.3.0` tag the graph has no `sleeping` status and no
`blocked` field. See §0.1.

The panel is a tree (owner edges), each node showing status, phase, and — for
blocked nodes — a **Retry** button calling `harness.retryTask(id, context)`.
"After a restart, tasks that were `running` show as `pending` until they run
again" — so a node that says `pending` right after a restart is *normal*, and
the UI should say so rather than showing an error.

**S5 — Subagent view.**
Opened by tapping a subagent tool call. It opens a **second view** over the
same commit stream, filtered to the child's conversation id (from the call's
`details.conversationId`), and shows the child's own transcript, plus the
parent→child edge. Mechanically: the client attaches a **second subscription**
scoped to the child (`WS /v1/events?conversation=<childId>`) and the kernel
sends that scope its own snapshot — the child's active transcript, its child
index, the task graph and the docs (§1.9). The parent's snapshot is not
enlarged to carry the child's transcript, and the child's transcript is not
paged in as a substitute. Because the child is a real conversation, it has
its own history, its own compaction, and its own fork — all of which a
tmux-backed child never had.

**S6 — Recovery sheet.**
Shown when the app reopens and finds work in flight. See §3.7.

**S7 — Usage sheet.**
`harness.usage(context)` / `docs["pi.usage"]`: per model and per tool, tokens
and cost. Cheap to build, and on a phone (metered connections, battery) it
matters.

**S8 — Git viewer.**
Browse the workspace clone from the phone: pick a branch, walk the tree, read
a file. It replaces the `repo-explorer` extension (§2.4) and is the reason the
app needs `git` (§5 R4). The screen is a web view over dedicated `git_*`
tools, not a tool itself; the tools are `replay: "safe"` only for
non-mutating commands (`show`, `ls-tree`, `cat-file`). `git status` can refresh
and write `.git/index`, and `bash git …` is unsafe. The tool-vs-`bash` choice
is still open (Appendix B #9).

### 3.3 WebView/browser specifics

The web client must treat reconnect, back-button navigation, and WebView
renderer death as normal events. It must not use local storage for durable
state. The only local state allowed is ephemeral UI state (scroll position,
draft text); draft text should be submitted as a durable input when the user
sends. The WebView must not receive the SQLite file path or unrestricted shell
access.

### 3.4 Paged loading

`Conversation.entries(query, limit, cursor, context)` returns
`Page<EntryRecord, Cursor>` — "Fork-aware history of this conversation, newest
first unless `query.order` is `ascending`".

The transcript screen pages with a windowed cursor over `entries`, keyed by the
newest entry id, and appends live entries from the event stream. Two details
that matter on a phone:

- **The initial load must not be the whole history.** A virtualized web list
  over a `Page` with a "load older" trigger at the top, backed by
  `entries(query, limit, cursor, context)`.
- **The snapshot is the active transcript of its scope.** v1 serves it whole;
  do not also promise a windowed snapshot. If it grows too large, add a v2
  windowed snapshot later.
- **Paging goes behind the snapshot, and it is scoped.** "Load older" uses
  `entries({ maxEntryId: oldestLoaded, order: "descending" }, limit, cursor)`
  on the scope's conversation handle — over the wire that is
  `GET /v1/entries?conversation=<id>&before=<id>&limit=N` (§1.9), so the
  conversation is never implicit. Past-head entries render only below the head
  marker. The snapshot already contains the active window, so the first page
  must not re-append it.

### 3.5 Task status indicators

One rule: **the indicator reads committed status; it never infers.**

| Indicator | Source | Notes |
|---|---|---|
| running / waiting / sleeping / completing | `TaskGraphNode.state.status` | The four committed statuses, plus `pending`. |
| blocked (missing definition / too old / migration failed / restart limit) | `TaskGraphNode.blocked` | `harness.inspect()` reports the same thing as `TaskInspection.state.kind === "blocked"`. |
| running tool call | `pi.live.tools[].status` (`pending`/`running`/`done`) | |
| retry backoff | `pi.live.generation.retry` (`{at, error}`) | Show the countdown from `at` — a *committed* deadline, not a local timer. |
| compaction | `pi.live.compactions[]`, `pi.live.compactionFailure` | |
| queued input | `pi.inbox` | `InboxDoc` / `InboxItem`. The **queue**: what is waiting for a boundary. The inbox item's `id` is the `SubmissionId`. |
| submission outcome | `SubmissionRecord` (`submission` events / `harness.submission`) | The **receipt**: what happened to the thing you sent. Not an alternative to the inbox row — a queued input has both. |
| abort requested | `TaskGraphNode.abortRequested` | Show "Stopping…" until the task terminalizes. |
| parked | `onReport` `{type:"task_parked"}` → durable, shown in the task panel | See §5 R3. |

**Two different things, not two answers to one question.** `pi.inbox` is the
**queue** — the input is waiting for a boundary — and the `SubmissionRecord` is
the **receipt** — the input was admitted, and what became of it. §3.1's "did
my send succeed?" is answered by the receipt; the queue is what the composer
shows as "queued".

The `sleeping` status and `TaskGraphNode.blocked` are post-1.3.0 (`main` @
`fdce48e`); at the `v1.3.0` tag the graph has no `sleeping` status and no
`blocked` field, and `restart_limit` does not exist. See §0.1.

Note `TaskGraphState` has no "suspended" status — the closest is `sleeping`
(with `until`) and `waiting` (with `on` and `policy`). Your "running /
suspended / waiting" trichotomy maps to **running / sleeping / waiting**, plus
**blocked** as a fourth state that is *not* in the graph's status union but is
in `TaskGraphNode.blocked` and `TaskInspection`. Design the UI for four
states, not three.

### 3.6 Subagent visualization

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

Concretely, the UI needs one query: "which conversations were created by
conversation X". `scanConversations` supports both filters:
`ownerConversationId` answers exactly that question, while `ownerTaskId`
answers "children of this task". The kernel should expose a
`GET /v1/conversations?owner=<id>` endpoint backed by `ownerConversationId`.
A fork's parent is `ConversationRecord.parent`, a separate edge; this endpoint
does not cover it. The same edges are in the snapshot's **child index**
(§1.9), so the tree is reconstructible from the snapshot alone; the endpoint
is for on-demand queries, not for the first paint.

### 3.7 The Resume affordance

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
  per-task Retry. (`restartLimit` and parking are post-1.3.0, `main` @
  `fdce48e`; at the tag there is no parking, only the interrupted-task path.)

**Therefore the Recovery sheet has three buttons, not one:**

| Button | Command | When it appears |
|---|---|---|
| **Resume** | `harness.resume()` | When there is pending work that is not parked. |
| **Retry** | `harness.retryTask(id)` | Per task, when `TaskGraphNode.blocked === "restart_limit"` (or `TaskInspection.state.kind === "blocked"` with `reason`) |
| **Discard** | `harness.abortTask(id, context)` | Per task, for work the user no longer wants. |

`retryTask()` clears the restart count and enables scheduling; it does **not**
run the task. `abortTask()` commits the abort mark and schedules the abort
phase, which can append entries and settle a task `orphaned`; "Discard" is not
a local row removal.

**And a fourth state the UI must show honestly: "interrupted".** A tool call
whose stored policy is unsafe and which was cut off produces a `pi.tool-result`
entry with an `interrupted` diagnostic and the durable partial output. The
transcript should show it as an error row, not as a spinner that never
finishes.

The Recovery sheet is a web screen; Resume posts to `/v1/commands/resume`,
Retry posts to `/v1/commands/retryTask`, and Discard posts to
`/v1/commands/abortTask`. The web client never sets a local "stopping" flag;
it waits for the committed effects.

### 3.8 UI state rules

- **Reconnect = resnapshot.** On WebSocket reconnect, the client re-attaches to
  `WS /v1/events` **with the same scope** and receives a fresh `snapshot` for
  that scope; it replaces its projection. No local diffing, no reconciliation
  logic.
- **`snapshot` event = drop everything.** The kernel sends it on attach, on
  bounded-queue overflow, and on any publication containing an entry with
  `head` (reset, handoff, compaction) — each for the scope that conversation
  belongs to. There is no separate `reset` event.
- **One snapshot path.** The WS `snapshot` is the client's only path;
  `GET /v1/snapshot` is debug-only.
- **Optimistic UI is forbidden for durable state.** The "Send" button does not
  insert a bubble; the bubble appears when the `pi.user` entry is committed.
  (A submission is durably admitted before it is placed, so the delay is
  short — but it exists, and hiding it would be a lie.)
- **Errors are states, not toasts.** A failed submission settles as
  `unanswered` with a reason (`run_failed`, `stale`, `aborted`); the UI shows
  it in the transcript, not as a transient snackbar. `run_failed` is a
  post-1.3.0 `afterFailedRun` reason; do not hard-code it as the only value.
- **WebView renderer death = new WebView + reconnect.** The renderer cannot be
  reused: destroy and recreate the `WebView`, then attach to `WS /v1/events`
  and resnapshot exactly as if the Activity had rotated. This is a normal
  event, not an error state.

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
the *next* phase or request uses it. Under an extension reload (R1) the running
call finishes under the code it started with; a kernel restart (R3) cuts the
phase off and reruns it from the top under the new code.

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
| **R2 — web UI hot reload / rebuild** | Vite HMR, with the dev server running **on the phone** inside the kernel, or rebuild static assets and reload the WebView in production | UI changes without an APK reinstall. The session is untouched. |
| **R3 — kernel restart / APK rebuild** | `harness.close(ctx)` → process exit → `Harness.open(...)` → `harness.resume()`, or `gradlew assembleDebug` plus an explicit install (wireless debugging, cloud download + PackageInstaller, or on-device self-update) for native host shell changes | The session survives via SQLite; pending tasks resume when the app is relaunched. A package replacement force-stops the app, so nothing resumes until the user opens it again. |

**R1 is the interesting one and it is fully native to Pi Durable.** Durable
does not ship a file loader; pi-coding-agent uses `jiti`. The app must add one
(`jiti` or `esbuild`) and resolve `@earendil-works/pi-durable`, TypeBox and the
extension's other imports from the kernel's `node_modules`. With that in place,
the agent can write `workspace/extensions/foo.ts`, but installation is
**user-confirmed** (§2.8): the UI shows the diff/hash, the user taps Install,
and `registry.install()` runs. A trusted session can pre-authorize a pinned
key/hash for a long self-build. On every `Harness.open`, re-install the
approved extension files before `harness.resume()`, so a kernel restart does
not leave their tasks `missing_task`. The change is live on the *next* request,
with zero downtime and zero risk to the running turn. R2 is what the web client
buys you. Because the UI is served as static assets, the agent can edit
web/src/..., trigger a Vite HMR update (or a rebuild + WebView reload), and see
the change without reinstalling the APK. This is the UI analogue of R1 and is
the reason the UI is not Compose. The loader is a dependency and a memory cost,
not a free property. So the loop is:

```
agent edits web/src/Screen.tsx
   → Vite HMR updates the WebView                    ← R2: no APK rebuild
agent edits workspace/extensions/foo.ts
   → user confirms diff/hash; kernel installs it       ← R1: instant after approval
agent edits app/src/main/java/.../Service.kt
   → assembleDebug, then install (wireless debugging, cloud download,
     or PackageInstaller self-update)                  ← R3: APK rebuild; session survives via SQLite
```

### 4.3 Restarting the worker is a normal event

The design commitment: **a kernel restart is an ordinary event, not an
incident.** Concretely, in the kernel:

```ts
// On start: pick up where the last process stopped.
const harness = await Harness.open(await openNodeSqliteStorage(dbPath), {
  models, registry, settings,
  env: (target) => envFor(target.cwd ?? defaultWorkspace),
  onWake,
}, ctx);
const root = await harness.root(ctx, { agent: { model } }); // models is the catalog; pi.agent.model selects
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
abrupt kill increments it. On Android, the difference between the two is only
partly under your control: `onDestroy` is best-effort and an explicit or OEM
SIGKILL is the normal path (§5 R3). The counter and parking are post-1.3.0 (`main` @
`fdce48e`); at the `v1.3.0` tag there is no `restartLimit`.

The second half of "normal event" is that the *user* never sees an error. The
app shows "Restored your session" and the task panel shows the pending tasks.
A parked task shows a Retry button, not a crash dialog.

### 4.4 The workflow

1. The workspace (`pi/workspace/`) holds a git clone of the app.
2. The agent is told: *"Read the app's README, then add a screen that shows
   the task graph as a tree."*
3. The agent reads files with `read`, edits with `edit`, and runs
   `./gradlew :app:assembleDebug` with `bash`. The JDK/SDK live in the proot
   rootfs if S0.7 passes; otherwise the build runs on the host and the phone
   only installs the artifact. This is not a Phase 1 requirement.
4. The build fails → the agent reads the compiler output from the tool result
   and fixes it. (This is why Option B, with no shell, is not a coding agent.)
5. The agent commits the change (`git_commit` tool, unsafe) and pushes
   (`gh` tool, unsafe). The workspace's git credential and `GH_CONFIG_DIR` are
   per-command app credentials, separate from the model key (R8); they are not
   in the kernel environment.
6. The agent edits the web UI source (`web/src/…`) and the WebView
   hot-reloads (R2); no APK rebuild is needed for UI changes.
7. The agent writes a new extension into `workspace/extensions/` as a
   **proposal**; the user confirms the diff/hash; the kernel installs it through
   the runtime loader (R1) to change *its own* behaviour mid-session.

**The self-referential part:** the agent can edit the app that hosts it — the
web UI via R2, the extensions via R1, and the native host shell via R3 — and
then the app it is running in is replaced underneath it. The session survives
because it lives in SQLite, not in the process. When the user relaunches the
app after the reinstall, the agent comes back mid-task with its context intact;
a package replacement force-stops it, so it does not resume by itself.

**The hard constraint:** the agent is trusted code (§2.8). The Pi database is in
app-private storage, not in the workspace, so `git clean -fdx` cannot touch it.
The workspace is a separate directory, the `beforeTool` guard and curated exec
reduce accidents, and the scheduled SAF export is the recovery path. A same-uid
shell can still reach the DB; a real uid boundary is the separate worker-package
spike, not v1. `android:process=":kernel"` is process isolation, not a uid
boundary. A `pre-commit` hook cannot stop `git reset --hard`/`clean -fdx`; use
`pre-push` for force-push and treat hooks as advisory.

### 4.5 Smallest possible first milestone

> **Milestone 0: foreground service + SQLite commit loop + one tool.**

Concretely, and this is deliberately *not* a UI milestone:

1. An Android app with a `ForegroundService` (type `specialUse`), a
   notification, and a `BroadcastReceiver` for `BOOT_COMPLETED` (optional).
2. The service starts the kernel (Node, per §1.3) with the HTTP+WS server from
   §1.9 on loopback, with the bearer token.
3. The kernel opens `openNodeSqliteStorage(join(filesDir, "pi/session.sqlite"))`,
   calls `Harness.open(...)`, `harness.root(ctx, { agent: { model } })`, and
   registers three fixtures: `echo` (`replay: "safe"`), `sleep`
   (`replay: "safe"`), and `sleep-then-throw` (`replay: "unsafe"`). `filesDir`
   is `Context.filesDir`; do not hardcode `/data/data/<pkg>`.
4. The kernel exposes `POST /v1/commands/submit` and `GET /v1/snapshot`.
5. **No web UI yet** — `curl` from `adb shell` is enough.

**Acceptance criteria for Milestone 0** (this is the whole point of the
milestone — it proves durability before anything else is built):

| # | Criterion | How it is checked |
|---|---|---|
| M0.1 | With `pi.agent.model` configured from the `models` catalog, a submitted input produces a committed `pi.user` entry and a committed `pi.assistant` entry, visible in the snapshot | `curl` the snapshot; check the entries |
| M0.2 | The kernel is killed explicitly with `SIGKILL` after a tool call commits its `execute` checkpoint, and a service restart **resumes the pending work**; every pre-kill entry is present and unchanged, and new entries are appended. `am kill` is not used: it may not kill a foreground-service process. | record the kernel pid at startup; `run-as <pkg> kill -9 <pid>` (debug build — `run-as` needs a debuggable build) or, in a release build, the debug-only IPC kill command, which is the release-mode equivalent; assert `pidof` shows the pid absent and a monotonic `boots` counter incremented; compare the snapshot prefix |
| M0.3 | The `sleep-then-throw` fixture (`replay: "unsafe"`), interrupted after its `execute` checkpoint is committed, produces an `interrupted` result, **not** a rerun | read the committed `ToolTaskCheckpoint` with `phase: "execute"` in SQLite; then SIGKILL the kernel; assert the interrupted diagnostic |
| M0.4 | The `sleep` fixture (`replay: "safe"`), interrupted at the same point, **does** rerun after the kill | same build as M0.3 — no declaration flip or rebuild between runs |
| M0.5 | The SQLite file survives `adb shell am force-stop` and a reboot; `sqlite3` on the pulled file shows the entries | pull `session.sqlite`, `-wal` and `-shm` together (or run `PRAGMA wal_checkpoint(TRUNCATE)` first), then inspect |
| M0.6 | The service starts exactly one kernel child; a second kernel that cannot take `processLock` (or the S0.1 fallback) refuses to start | assert the second launch exits nonzero and the first pid is unchanged |
| M0.7 | `harness.inspect()` after the kill reports the previously-running task with `TaskInspection.record.state.status === "pending"` (the derived `state.kind` is `"ready"`), and `harness.resume()` runs it | via the snapshot; assert the record field, not `state.kind` |
| M0.8 | The kernel serves a trivial `GET /` page and the WebView loads it over loopback with the bearer token | Load the WebView; check the page renders |

M0.2/M0.3/M0.4 are the three that actually prove the kernel is durable, and
they are cheap. They must kill the *kernel* explicitly: a test that only kills
the Activity can pass without exercising recovery. Everything else in this plan
is downstream of them.

---

## 5. Risks and decision points

Ordered by "how badly would this hurt if I got it wrong".

### R1 — A Node runtime on Android is the load-bearing unknown

**Unknown.** Can a **proot rootfs** with Node ≥ 22.19 and `node:sqlite` run from
`nativeLibraryDir` inside an Android foreground service, reliably, at
acceptable speed, under `targetSdk 35`?

Sub-questions, each with its own answer:
- Does the rootfs Node include `node:sqlite`? (Node 22.5+ has it as
  experimental; a Node 24/25 build should, but "should" is not a measurement.)
- Is the proot syscall-translation cost acceptable for a coding agent, or is a
  custom bionic Node (the later optimization) required?
- Does `execve` of the shipped native libs work from `nativeLibraryDir`, and
  does it still work after an APK update (the path changes)?
- Does the rootfs path under `files/` survive an APK update?
- Does `processLock("pi-durable:<pkg>")` use an abstract socket and release on
  process death on the target device?
- APK size, cold start, Doze/OEM kills. (Committed state survives — that is
  what SQLite is for — but progress does not: a kill can interrupt a task and,
  on main, count toward `restartLimit`; see R3.)

**Spike S0.1 (3–4 days).** Build the smallest app: `targetSdk 35`,
`libproot.so` + a rootfs under `files/`, a `ForegroundService` that launches
it, opens `node:sqlite`, inserts and reads 1,000 rows, and prints over
loopback. **Ship `libproot.so` with `useLegacyPackaging="true"` (or
`android:extractNativeLibs="true"`)**, so `nativeLibraryDir` contains a real
executable and not just symlinks. The spike must prove the *mechanism*, not
just that a process starts: the exec'd file is proot's own binary in
`nativeLibraryDir`, and the rootfs binaries run out of `files/` through proot's
path translation — which is why the API-29 exec ban does not apply. Measure:
APK size, cold start, file I/O under proot, `node:sqlite`, exec before and
after an APK update, rootfs relocation, `processLock` behavior, explicit
kernel SIGKILL, and Doze (`adb shell dumpsys deviceidle force-idle`). If
`processLock` does not behave, record the fallback (child-owned `FileLock` +
pid/start time).

**Fallback.** A custom bionic Node built for the app's prefix is the first
optimization if proot is too slow. If the runtime cannot work at all, fall back
to Option B (Hermes + `android.database.sqlite` facade + no shell) or Option C1
(remote execution). The *factory* swap is one line (§1.6) if the kernel,
storage, IPC and UI are built as separable layers; the product consequences are
not. B loses the shell and the git-dependent workflows; C1 moves the shell,
workspace and build loop to the box. Neither keeps the on-device
self-building loop intact.

### R2 — The SQLite facade (Option B) and SQLite under a foreground service

**Status: the facade half is conditional, the storage half is not.** Option A
is the target and it uses `openNodeSqliteStorage` — Node's own SQLite — so the
facade question only bites if the plan falls back to Option B, which the
offline-shell requirement rules out (§1.6). Spike S0.2 is therefore scheduled
conditionally (§6, Phase 0). If S0.1 fails and Option B becomes the fallback,
S0.2 must run before the fallback is chosen; skipping it and then falling back
leaves the fallback unmeasured. The storage-pressure question stays live either
way: the user can clear app storage, an uninstall deletes it, and the disk can
fill. Android does not garbage-collect `files/` the way it clears `cache/`;
`SQLiteDatabase.deleteDatabase` is an app call, not an OS cleanup.

**Unknown.** Does a hand-written `SqliteDatabase` facade over
`android.database.sqlite` pass `registerStorageConformance`? And does SQLite
behave when the disk fills or the user clears app data?

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

**Spike S0.2 (2 days, conditional).** Implement the facade over
`android.database.sqlite` and run `registerStorageConformance` from
`@earendil-works/pi-durable/testing` against it. Then run the storage
benchmarks (`STORAGE_WRITE_BENCHMARKS`, `STORAGE_READ_BENCHMARKS`) on a
low-end device to get real numbers. Skip it unless Option B is still live;
the benchmark half is worth doing anyway, because it measures the Node
adapter's behaviour on the same device.

**Fallback.** Option A's `openNodeSqliteStorage` (which needs no facade at
all), or `openNodeJsonlStorage` — which is portable and takes a `FileSystem`
from `@earendil-works/pi-durable/env`, but keeps the whole history in memory
(§1.7). Not recommended beyond a smoke test.

### R3 — OEM process killers will park your tasks

**This is the most likely thing to actually bite you, and it is specific to
Android.** It is also a post-1.3.0 behaviour: `settings.restartLimit`, the
`restarts` counter and parking exist at `main` @ `fdce48e`, not at the `v1.3.0`
tag. On 1.3.0 a kill still interrupts the task, but there is no parking and no
`retryTask`.

The mechanism, from `src/harness/scheduler.ts`:

- On open, every task that was `running` when the process died gets
  `restarts = (restarts ?? 0) + 1`.
- "a new state the task commits starts the count over" — progress resets it.
- `settings.restartLimit` defaults to `DEFAULT_RESTART_LIMIT = 5`. At the limit,
  the task is **parked**: "the task graph shows it as blocked with reason
  `restart_limit`, `wake()` does not count it as active, and `onReport` gets it
  once as `task_parked`". A parked task **does not run** until
  `harness.retryTask(id)` is called.

Now count the ways a phone kills a background service: Samsung's and Xiaomi's
battery managers, "app hibernation" on Android 12+, memory pressure, the user
swiping the app from recents, an explicit `run-as` SIGKILL, and a Doze-adjacent
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
2. **Graceful shutdown wherever you can.** An explicit stop action →
   `stopService`/`stopSelf` → `SIGTERM` → the kernel traps it →
   `harness.close(ctx)`. Do not rely on `onDestroy`: Android does not guarantee
   it on a system kill, and an explicit/OEM SIGKILL is the normal path.
3. **Host-driven recovery.** On every service start, scan
   `harness.inspect(context)` for tasks with
   `state.kind === "blocked"` and `reason === "restart_limit"` and call
   `harness.retryTask(id)` for each. This makes "parked" a visible, recoverable
   state instead of a silent stall — and it gives you the §3.7 Retry button.
4. **Persist progress often.** The restart counter resets when the task
   commits a *different* state. Durable's `api.output()` already commits
   running output at most every 100 ms (`settings.progress`), so a long tool
   call does make progress — but a task in a *phase* with no output does not.

**Spike S0.3 (1 day).** A loop that SIGKILLs the kernel pid 10 times during
a long tool call, then asserts (a) the task is still live and (b) it completes
on the next resume. Run it on the three OEM skins you actually own.

### R4 — `ExecutionEnv` compatibility is the whole product

**Unknown, and it is a product decision rather than a technical one.** Under
Option B there is no shell, so `git`, `gradle` and `npm test` are all gone.
That is not a degraded coding agent; it is a different product.

**Spike S0.4 (half a day, and it is just counting).** Take the surviving
extensions and skills (§2.4) and mark each as *needs-exec* or *not*. The
extension/skill table is not the whole count: `review` (git), `review-triage`
(git diff), the commit, github, librarian and update-changelog skills (git,
gh, clone, `git describe`/`git log`), the git viewer (git), and the app's own
build loop (`gradlew`, JDK, Android SDK) all need exec. `btw` no longer counts
(its tmux panel becomes a durable conversation), and the dropped extensions do
not count at all. "The count is closed" was true only for the extension table,
not for the product.

**Fallback / mitigation.** Option B is not the target: it would cost review,
commit, github and librarian, which *is* the self-building dev environment.
The reimplementation path exists — build the git viewer on `isomorphic-git`
and rebuild review-triage on top of it — and `web_search` can move in-process
from the Node script where the provider SDK allows it, though it still needs
the provider's native-search request shape. Even with both done, the loss is
the review, commit and github workflows. For a learning project, stay on A.

### R5 — Single-writer violations corrupt the store

**Unknown.** "One process owns a storage at a time; there is no cross-process
locking." Two kernels on one `.sqlite` file will not error politely.

**Mitigation.** The child takes `processLock("pi-durable:<pkg>")` from
`@earendil-works/chord/node` at startup; on Android it is an abstract socket, so it
vanishes with the process and leaves no stale file. S0.1 verifies the behavior
on the target device; if it does not behave, fall back to a child-owned
`FileLock` on `pi/kernel.lock` with a pid + start-time record. The service
starts exactly one child and refuses a second; the SQLite open is the backstop.
Belt and braces, because the failure mode is silent corruption.

**Spike.** Part of Milestone 0 (M0.6) and S0.1.

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
`AlarmManager.setExactAndAllowWhileIdle` fires while the screen is off. Check
`canScheduleExactAlarms()` at runtime and fall back to
`setAndAllowWhileIdle()`; `SCHEDULE_EXACT_ALARM` is denied by default on
Android 14+ for most apps. Add the
`android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE` manifest property, and test
whether `BOOT_COMPLETED` may start the service on API 31+ rather than assuming
it can. Exercise a sleep shorter than the nine-minute Doze rate limit and
record the late-fire behavior; re-arm alarms from the persisted DB on every
service start. On renderer death, destroy and recreate the WebView;
`onRenderProcessGone` returns `true`.

**Mitigation.** The app is for your phone only, so this is a sideload and not a
listing: `specialUse` + `USE_EXACT_ALARM` is the answer, and the Play
constraints — the `specialUse` justification, the `dataSync` cap, the
exact-alarm policy, the APK size limit — do not bind. If it ever ships on
Play, `dataSync` with an honest usage description and a mid-session restart
is the alternative.

### R7 — Pi Durable is explicitly experimental

**Known and permanent.** The package's own README opens with: "**Experimental.**
The API changes without notice between releases."

**Mitigation.** Pin the `main` commit `fdce48e`, not the string `1.3.0`, and
pin every package the kernel imports (`@earendil-works/pi-durable`, `chord`,
`pi-ai`, `pi-codemode`, `pi-env`, `typebox`) in the lockfile. Keep every
Durable-specific import behind one adapter module (`kernel/durable-api.ts`) so
a version bump is one file. Run the package's own conformance suites
(`registerStorageConformance`, `registerEnvConformance`) against your Android
implementations on every bump — they exist precisely for this. Note that the
main schema migrates to version 2 and **cannot be opened by 1.3.0 or earlier**;
keep the lockfile with the data so a downgrade is not attempted.

### R8 — Model transport, credentials, and cost on a phone

**Unknown.** Providers live in `@earendil-works/pi-ai`. The `opencode-go`
provider you use may need custom headers or a specific base URL; other providers
may need an OAuth flow that a phone browser can complete but a background
service cannot.

**Spike.** Point the kernel at each provider you care about from the service
context (not the Activity) and check: streaming works, custom headers survive,
key passing works, and a 401 refreshes the credential without a restart. The
opencode-go extension uses an API key and a fixed base URL, not an OAuth flow;
the OAuth risk is for other providers.

**Mitigation.** The model key, the workspace's git credential and `GH_CONFIG_DIR`
are three separate secrets. The Android Keystore can hold them, but the Node
kernel cannot read the Keystore: the host decrypts and passes each secret once
over a pipe/fd; the kernel holds it in memory. Every `exec` through
`NodeExecutionEnv` passes `inheritEnv: false` (a per-call option, default
`true`), so `bash -c env` cannot print the key. `git`/`gh` get credentials per
command (`env: { GH_TOKEN }` on that one spawn), never in `process.env` and
never in `.git/config`. A backup/export must not include the secrets. The
kernel is the process that must live for days, so the mitigation is the
per-call environment, not a shorter lifetime.

### R9 — The IPC boundary is a real failure surface

**Unknown.** The kernel is a separate process. If it dies, the UI must
reconnect and resnapshot; if the UI dies, nothing should happen to the kernel.

**Mitigation.** The reconnect path is "fetch a fresh snapshot" — no
reconciliation. Every client-visible invariant is therefore "reconstructible
from a snapshot", which is the same invariant §3.1 already demands. WebView
renderer death is also an IPC boundary event: the web client reconnects and
resnapshots exactly as a rotated Activity would.

### R10 — The self-build loop is trusted code

**Unknown, and now decided.** The agent has `bash`. It can `git clean -fdx` the
app source, or worse: it can reach `pi/session.sqlite` and the credentials,
because the kernel and the shell share a uid. `android:process=":kernel"` is
process isolation, not a uid boundary. The v1 decision is **trusted agent +
accident guardrails + recoverable store** (§2.8), not containment.

**Mitigation.** The DB is outside the workspace, so `git clean -fdx` cannot
touch it; the `beforeTool` guard and curated exec reduce accidents; the
scheduled SAF export is the recovery path. Agent-written extensions are
user-confirmed installs (with an optional trusted-session upgrade), so the
agent cannot silently become kernel code. A `pre-commit` hook cannot stop
`git reset --hard`, `git clean -fdx` or force-push; use `pre-push` for the last
one and treat hooks as advisory. A real uid boundary is the separate worker
package spike, not v1.

### R11 — Loopback web server and WebView security

**Unknown.** The web client is served over `127.0.0.1` and loaded in a WebView
(or browser). If the server binds to `0.0.0.0`, if the bearer token leaks, or
if the WebView is given access to the SQLite file path or unrestricted shell
access, the durability story is undermined.

**Mitigation.** Bind only to `127.0.0.1`; issue a per-launch bearer token and
require it on every request (HTTP header and a WS subprotocol/ticket — browsers
cannot set an `Authorization` header on a WebSocket); use a
`NetworkSecurityConfig` `domain-config` for `127.0.0.1`; keep the dev server
inside the kernel and on loopback — there is no `adb reverse` to expose,
because the Vite server runs on the phone (§5 R12); treat the WebView as
untrusted and give it only the event protocol and narrow bridge calls. Do not
pass the SQLite path or shell access to the web client. Loopback is shared
across apps, so the token is the boundary, not the bind address.

### R12 — A dev server on the phone

**Unknown.** The HMR loop assumes a Vite dev server runs inside the kernel's
Node runtime, on the phone, watching the web sources and pushing updates over
a loopback WebSocket. Nothing in this plan has run a bundler on a phone: the
watcher has to see the workspace files, `esbuild` has to run under the same
Node build that carries the kernel, and the dev server has to coexist with
the kernel's own event loop and its memory ceiling. The runtime extension
loader (`jiti`/`esbuild`) is the same class of cost.

**Spike S0.6 (2 days).** Run Vite in the kernel's Node runtime against a
scratch web project, edit a file, and confirm the WebView hot-reloads without
a restart. Measure the dev server's idle memory and CPU while the agent runs
a tool call — a phone will not give a bundler and a model stream much room
at once.

**Fallback.** Build the static assets on the device with a one-shot
`tsc`/esbuild step and reload the WebView instead of hot-reloading. Slower to
iterate, still no APK reinstall and no host machine.

### R13 — The on-device build and install toolchain

**Unknown.** The self-building loop in §4 needs more than Node: `gradlew`
needs a JDK and an Android SDK/build-tools, and installing the result needs a
path that works without USB. **adb-over-USB is unavailable on this device**, so
the candidates are wireless debugging (adb over TCP), a cloud download plus a
`PackageInstaller` session, or a `PackageInstaller` self-update from an
on-device artifact. A normal app cannot silently replace itself; a package
replacement force-stops it, and nothing resumes until the user relaunches.
Option A's APK budget currently counts only the proot rootfs.

Also: Android 12+ silently SIGKILLs app-forked children beyond ~32 (the
phantom-process killer), and Node + Gradle + Kotlin + R8 + esbuild + Vite plus
the agent's `bash` is exactly that profile. Prefer no Gradle/Kotlin daemons
(`org.gradle.daemon=false`, in-process Kotlin), and document the one-time adb
`settings put global settings_enable_monitor_phantom_procs false` step. The
Android SDK's `aapt2`/`zipalign` are x86_64 by default; a community aarch64
`aapt2` or a host build is required.

**Spike S0.7 (3–4 days).** On the target phone, install a JDK + Android SDK +
Gradle in the proot rootfs, build a trivial APK, and measure size, cold-build
time, memory, battery, and child-process kills. Then install it through **one
chosen no-USB path**: wireless debugging, a cloud download + `PackageInstaller`,
or an on-device self-update. Record what happens to the running service and how
the app is relaunched. Acceptance names the chosen path and confirms it works
on the target phone; if it does not, the host-build fallback is recorded.

**Fallback.** Use a separate build host (a laptop or a small server) for native
changes and keep only the web UI / extension loop on-device. That keeps the
durable session on the phone but gives up the fully on-device self-build; say
so in §4.4 rather than implying `installDebug` works from inside the app.

---

## 6. Phased plan

Each phase lists its dependency, its deliverables, and its acceptance
criteria. The criteria are the point: they are what "done" means.

### Phase 0 — Decision spikes (no app code)

**Depends on:** ordered, not flat. S0.1 is the go/no-go and comes first; S0.4
and S0.5 run in parallel with it; S0.3, S0.6 and S0.7 need S0.1's runtime; S0.2
is conditional on Option B and must run before that fallback is chosen; S0.8 is
last. S0.9 can run in parallel from day one.

**This is two weeks of spikes, not a weekend.** S0.1 (3–4 d) + S0.7 (3–4 d) +
S0.6 (2 d) + S0.3 (1 d) alone are ~9–11 working days, and they are partly
serial (S0.3, S0.6 and S0.7 all need S0.1's runtime). Add S0.4, S0.5, S0.8 and
S0.9 and Phase 1 starts two to three weeks in, not in parallel with the
spikes. Budget for that before promising Phase 1 dates.

**Deliverables**

- S0.1 Proot-on-Android spike (§5 R1) → a report: `targetSdk`, APK size,
  cold start, `node:sqlite`, legacy packaging (a real executable in
  `nativeLibraryDir`), exec from `nativeLibraryDir` before/after an APK
  update, rootfs relocation, `processLock`, kill/Doze behaviour.
- S0.2 Android `SqliteDatabase` facade + `registerStorageConformance` pass
  (§5 R2) — **only if the plan falls back to Option B**; run it before choosing
  that fallback, not after.
- S0.3 The 10× kernel-SIGKILL loop (§5 R3) → task survives, or parks visibly
  with a working retry.
- S0.4 Env compatibility count (§5 R4) → the exec-needs table.
- S0.5 FGS/alarm behaviour on API 30/33/34/35 (§5 R6).
- S0.6 A dev server on the phone (§5 R12) → does Vite run inside the kernel's
  Node runtime, and what does it cost the agent's memory?
- S0.7 The on-device build/install toolchain (§5 R13) → JDK, SDK, Gradle,
  **no-USB install path**, phantom-killer behaviour, relaunch.
- S0.8 A **written decision record**: runtime, storage, env, IPC transport,
  security boundary.
- S0.9 A **commit-fold protocol prototype** in Node against `MemoryStorage`:
  subscribe, no-write barrier, head-write snapshot, overflow, singleton docs,
  and a second scope (a child conversation) with its own snapshot.

**Acceptance**

- [ ] S0.1 runs on a physical device, not only an emulator; records the
      `targetSdk`; ships `libproot.so` with `useLegacyPackaging="true"` (or
      `android:extractNativeLibs="true"`) and proves `nativeLibraryDir` holds
      a real executable; proves that the exec'd process is proot's own binary
      and that the rootfs binaries run out of `files/` through it; proves exec
      from `nativeLibraryDir` before and after an APK update; proves
      `processLock` (abstract socket, released on death) or records the
      child-owned `FileLock` fallback; and survives an explicit kernel SIGKILL
      with the SQLite file intact.
- [ ] S0.2's facade passes `registerStorageConformance` with zero failures,
      or the failure list is understood and accepted — *only if Option B is
      still live*.
- [ ] S0.3's 10× kill loop leaves the task live or visibly parked with a
      working Retry; no silent stall.
- [ ] S0.6 shows a WebView hot-reloading a changed component with no
      reinstall, and a measured memory cost the agent can afford.
- [ ] S0.7 builds a trivial APK and installs it through **one named no-USB
      path** (wireless debugging, cloud download + PackageInstaller, or
      on-device self-update) on the target phone; records child-process kills;
      or records the host-build fallback.
- [ ] S0.8 names the runtime, the env, the IPC transport and the security
      boundary, and §1.6's `env` factory seam is fixed.
- [ ] S0.9 passes: a snapshot taken during a commit burst, a head write, a
      queue overflow, and a stale-doc event all converge on the same state;
      and a second scope (a child conversation) receives its own snapshot and
      its own events, with neither scope's snapshot carrying the other
      conversation's transcript and each bounded by its own active window.

### Phase 1 — Durable kernel, no UI

**Depends on:** Phase 0.

**Deliverables**

- The Android app skeleton: `ForegroundService` + notification + supervisor.
- The kernel process: `Harness.open(await openNodeSqliteStorage(db), {models,
  registry: createRegistry(), settings, env: (target) => envFor(target.cwd ??
  defaultWorkspace), onWake, onReport}, ctx)`,
  `harness.root(ctx, { agent: { model } })`, `harness.resume()`. `onWake` and
  `onReport`'s `info` argument are post-1.3.0.
- `processLock("pi-durable:<pkg>")` owned by the child, with the S0.1 fallback
  if the abstract socket does not behave.
- Secrets via a one-time fd/pipe; every `exec` through `NodeExecutionEnv` with
  `inheritEnv: false`; no secret in the kernel's `process.env`.
- A redacted SAF export skeleton, written on stop and at a turn boundary.
- Loopback HTTP+WS server with the bearer token; `POST /v1/commands/*`.
- Three fixtures: `echo` (`replay: "safe"`), `sleep` (`replay: "safe"`), and
  `sleep-then-throw` (`replay: "unsafe"`), all in one build.
- A test provider (`fauxProvider` from `@earendil-works/pi-ai/providers/faux`)
  so M0.1 does not depend on network or credentials; real provider transport is
  R8's separate gate.
- `onReport` → `task_parked` and `task_faulted` to a durable doc the UI can read
  (`task_parked` is post-1.3.0); `session_failed` to the kernel log/file, because
  a storage-failure report cannot be committed to the storage that just failed.
- `onWake` → `AlarmManager` + wake lock (§1.10).

**Acceptance** = Milestone 0's M0.1–M0.7 (§4.5), all seven, with the model
configured and the three fixtures in one build. M0.8 (the WebView loads `GET /`)
belongs to Phase 2, where the web client exists.

### Phase 2 — Reactive web UI v0

**Depends on:** Phase 1.

**Deliverables**

- Web client screens S1 (transcript), S2 (composer with steer/follow-up),
  S3 (status strip), plus static asset serving from the kernel (`GET /`).
- `WS /v1/events` folded from `harness.subscribeCommits`: `snapshot` on attach,
  one `batch` per publication, `snapshot` on a head write or queue overflow —
  each scoped to the conversation the subscription is for (§1.9).
  `GET /v1/snapshot` is debug-only; the client never uses it.
- Streaming from the `pi.live` doc (partial answer and tool output); the final
  `entry` on completion.
- `abortRequested` in the status strip; `taskgraph` events for the live tree.
- Paged `entries` loading behind the snapshot (§3.4).

**Acceptance**

- [ ] Rotating the device, killing the WebView renderer, or force-stopping and
      relaunching the app leaves the transcript, the run and the pending tools
      exactly as they were.
- [ ] A model turn streams into the transcript with no local "thinking"
      animation that is not backed by a committed field; `SIGSTOP` the kernel and
      assert no progressing element changes state for 60 s.
- [ ] A steer submitted during a run is visibly applied to the running turn
      (it lands after the current tool round); assert the `pi.user` entry is
      placed after the last tool result and before the next generation's first
      entry.
- [ ] A `pi.reset`/compaction head write produces a fresh `snapshot`; the client
      drops the old projection.
- [ ] The client has exactly one snapshot path (the WS `snapshot`); an
      unauthenticated `GET /v1/snapshot` is refused.
- [ ] A snapshot carries **one** conversation's transcript: the root snapshot
      has no child transcript in it, and the child's transcript is not paged in
      as a substitute.
- [ ] The UI can be force-stopped and relaunched mid-turn; the transcript
      continues from the same point.
- [ ] Editing the web UI source in dev mode hot-reloads the WebView without
      reinstalling the APK — or the S0.6 fallback (rebuild + WebView reload)
      is in place and the acceptance is worded for it.

### Phase 3 — Task panel and subagent view

**Depends on:** Phase 2.

**Deliverables**

- Screen S4 (task tree) and S5 (subagent view).
- The owned-child subagent tool (no shipped subagent task exists) wired to the
  UI per §2.5 — the foreground tool is `replay: "safe"` with
  `scanConversations`, `requestId` and `api.details`; the persistent combined
  tool (example 23) is `replay: "unsafe"` unless `stop`/`send` are split out.
- The child's conversation id, surfaced through `api.details({ conversationId
  })`, so the UI can open a second view over the same commit stream for it —
  a second scoped subscription, `WS /v1/events?conversation=<childId>`, which
  gets the child its own scoped snapshot (§1.9).
- `GET /v1/conversations?owner=<id>` for the creator-edge tree, backed by
  `scanConversations({ ownerConversationId })`; fork parents are
  `ConversationRecord.parent`, a separate edge.

**Acceptance**

- [ ] A subagent survives kernel process death: kill the app during the
      child's turn, relaunch, and the child continues from its checkpoint.
- [ ] Aborting the parent aborts the child (ownership cascade); aborting with
      `{background:true}` reaches a background child.
- [ ] The UI can open a child conversation and shows its own transcript,
      from that scope's own snapshot — not from the root snapshot and not from
      a paged substitute.
- [ ] Aborting a child's run keeps its conversation and its entries; a
      follow-up input continues the same conversation.

### Phase 4 — Extension port

**Depends on:** Phase 2 for 4a, Phase 3 for 4b.

**Deliverables**

- **4a — app state and inputs** (can start after Phase 2): review-triage, goal,
  todos (singleton docs), voice, answer, session-breakdown, continue,
  native-web-search, opencode-go-provider, the git viewer, the curated exec
  contract (`git_*`, `gh_*`, `build`) with a gated raw shell, and the skills as
  sections.
- **4b — owned-child extensions** (after Phase 3): btw, review, and the subagent
  tool with the anchor/reporter pattern.

**Acceptance** (items marked **4a** close with 4a; **4b** items close with 4b)

- [ ] **4a + 4b** Every ported tool declares an explicit `replay` policy, and
      the table in §2.4 matches the implementation.
- [ ] **4a + 4b** The `interrupted` path is exercised on-device: a
      `replay:"unsafe"` tool killed mid-flight yields an `interrupted` result in
      the transcript, and a `replay:"safe"` tool reruns.
- [ ] **4a + 4b** A `replay:"safe"` tool killed after its `execute` checkpoint
      and rerun produces its durable effect **exactly once**.
- [ ] **4a** Todos and goals live in singleton docs, not files; a process kill
      preserves them.
- [ ] **4a** `triage_change`'s decision is in a durable doc and is visible in
      the transcript or a docs read, not the task panel (the task panel renders
      the task graph, and a doc is not a task).
- [ ] **4a** Every skill's body is reachable as a section and its scripts as
      tools.
- [ ] **4b** The owned-child pattern is idempotent: a rerun of the
      `replay: "safe"` subagent tool finds the existing child
      (`scanConversations({ ownerTaskId })`) and does not spawn a second one,
      and a rerun of a `btw` tool finds its existing child and submission
      (`requestId`) instead of opening a second panel.
- [ ] **4b** A `btw` panel and a `review` child are owned conversations: they
      survive kernel process death, and aborting the parent aborts them.

### Phase 5 — Self-building loop

**Depends on:** Phase 4.

**Deliverables**

- The workspace layout: `pi/workspace/app` (the app's git clone),
  `pi/workspace/extensions` (agent-writable extensions).
- A runtime extension loader (`jiti`/`esbuild`), a user-confirmed install flow
  (diff/hash + Install), a trusted-session upgrade path, and boot-time reinstall
  of approved extensions before `resume()`.
- The JDK + Android SDK + Gradle toolchain **if S0.7 passes**; otherwise a host
  build with the phone only installing the artifact. The no-USB install path
  (wireless debugging, cloud download, or PackageInstaller self-update) chosen
  in S0.7.
- The guardrails from §2.8: no secrets in env, curated exec + gated raw shell,
  scheduled SAF export.

**Acceptance**

- [ ] The agent edits the web UI source and the WebView hot-reloads (R2) or
      rebuilds + reloads without an APK reinstall; no APK rebuild is needed for
      UI changes.
- [ ] The agent writes an extension; the UI shows diff/hash; the user confirms;
      the next request uses the new code **without a kernel restart**.
- [ ] After a kernel restart, approved extensions are re-installed before
      `resume()`, and their pending tasks are not `missing_task`.
- [ ] A trusted session pre-authorizes a pinned extension, and the agent can
      install it without a per-iteration prompt.
- [ ] The agent edits the native host shell; the build runs on-device if S0.7
      passed (or on the host), the chosen no-USB install path replaces the APK,
      and a relaunch resumes the session from SQLite (R3).
- [ ] A running tool call completes under the code it started with, even
      though the extension was replaced mid-flight.

### Phase 6 — Hardening

**Depends on:** Phase 5.

**Deliverables**

- `settings.restartLimit` policy (post-1.3.0, §5 R3) + the host-driven
  `retryTask` sweep.
- Single-writer enforcement via `processLock`, with the S0.1 fallback (§5 R5).
- Credential passing from the Keystore over a pipe/fd, plus per-command git/gh
  credentials; no secret in `process.env` (§5 R8).
- The trusted-agent controls from §2.8, exercised: user-confirmed install,
  curated exec, SAF export/restore.
- `android:allowBackup="false"` + `dataExtractionRules` for `pi/`; the
  export/import path; the second-package/uid worker spike; app size; battery;
  phantom-killer, exact-alarm and WebView soak tests.

**Acceptance**

- [ ] The 10× kill loop (§5 R3) leaves no task parked, or parks it visibly
      with a working Retry.
- [ ] After a refused second launch, the store is uncorrupted and the first
      kernel still serves.
- [ ] The app survives a reboot with the transcript and any in-flight task
      intact.
- [ ] After an agent corrupts `pi/session.sqlite`, the SAF export restores the
      transcript and the app opens it.
- [ ] `bash -c env` and the transcript contain no model key or git/gh token.
- [ ] The separate worker-package/uid spike has a go/no-go answer (not a v1
      assumption).

---

## Appendix A — Verified API surface

Everything below was read at `main` commit `fdce48e`
(`@earendil-works/pi-durable` and `@earendil-works/chord`, package version
still `1.3.0`). The `v1.3.0` tag differs: see §0.1. Names marked
"post-1.3.0" below do not exist at the tag.

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

`DEFAULT_RESTART_LIMIT` and `DURABLE_TELEMETRY_SCHEMA` are post-1.3.0; the
released tarball does not have them. The exports map also includes `./images`,
`./images/node` and `./images/cloudflare`, omitted here.

### Package entry points (`packages/chord/package.json` `exports`)

```
"."                          src/index.ts
"./context"                  src/context/index.ts
"./output"                   src/output.ts
"./delta"                    src/delta/index.ts
"./node"                     src/node.ts          <- processLock
"./telemetry-sqlite"         src/telemetry-sqlite/index.ts
"./sqlite"                   src/sqlite/index.ts
"./sqlite/node"              src/sqlite/node.ts   <- openNodeSqliteDatabase
"./sqlite/cloudflare"        src/sqlite/cloudflare.ts
"./package.json"
```

`processLock` is re-exported by `src/node.ts:15` and defined at
`src/manager.ts:82` as
`processLock(name: string): Promise<() => Promise<void>>` — the returned
function releases it. The source comment states the platform behavior this plan
relies on: "an abstract socket (Linux, Android) or a named pipe (Windows)
vanishes with its process, so there is no stale state to take over and no race
between two would-be owners". The Android path is the abstract socket
(`\0chord2-<hash>`). S0.1 still verifies it on the target device, because the
claim is about the *device*, not the source.

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
| `harness.subscribeCommits(listener)` | `src/types.ts:1083` | the WS stream's only source; `{seq, changes}`. **Declared on `Session`**, which `Harness` extends (`export interface Harness extends Session`, `src/harness/types.ts:775`), so `harness.subscribeCommits(...)` is the same call. The listener runs on the Session line and must not block or call Session APIs. |
| `harness.commit(fn, ctx)` | | no-write read barrier for the snapshot; a no-write commit does not publish |
| `Tx.conversation/scanEntries/scanTasks/scanConversations/doc` | | snapshot reads on the commit line |
| `processLock(name)` | `@earendil-works/chord/node` → `packages/chord/src/node.ts:15` → `src/manager.ts:82` | abstract socket on Android; child-owned; returns a release function; S0.1 verifies the behavior on the device |
| `Harness.open(storage, options, context)` | `src/harness/harness.ts:525` | Requires a registry containing the built-in tasks; `env` is a factory, not an `ExecutionEnv`. |
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
| `conversation.viewState(ctx)` / `conversation.watch(ctx)` | | single-conversation debug/CLI; no `seq` |
| `conversation.abort(ctx, {background?})` | | |
| `conversation.fork(at, options, ctx)` | | |
| `watchEvents(harness, conversationId, ctx)` | | coding-agent-style stream for one conversation; not the WS contract |
| `api.executeTool(name, args, ctx, {key?, progress?})` | | nested calls |
| `api.createTask(task, input, options, ctx)` | | `options.ownership` required |
| `api.commit(fn, ctx)` / `api.memo(name, candidate, ctx)` | | durable side effects |
| `api.details(value, ctx)` | | how the UI finds a child conversation |
| `env.exec(command, options, ctx)` | `src/env/index.ts:365` | `Shell.exec`; a string runs through the env's shell, an array runs `command[0]` directly |
| `options.env` / `options.inheritEnv` on an exec | `src/env/index.ts:302-303` | `ShellExecOptions.env` is the **per-call** environment (`env: { GH_TOKEN }` for one spawn); `inheritEnv` defaults to `true` (merge `process.env`), `false` gives only the per-call vars. `getShellEnv` implements it (`src/env/node.ts:270-281`); `NodeExecutionEnv`'s constructor has a base `shellEnv` and **no** `inheritEnv` flag, so the scrub is per call. |
| `runtime.commit(fn, ctx)` | | returns `void`; the callback returns `{status:"waiting", checkpoint, on, policy}` to wait |
| `runtime.sleepUntil(until, {phase}, ctx)` | | durable sleep |
| `runtime.outcomes(ids, ctx)` | | join results |

The `harness.wake()`, `harness.retryTask()` and `runtime.sleepUntil()` rows are
post-1.3.0; the tag has none of them.

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

Line numbers are for `fdce48e`. At `v1.3.0`, quotes 2 and 3 are at
`docs/spec.md:3376` and `:2927`; quote 7 is main-only (the tag's restart
handling is `abandonOnRestart`, not the close/crash counter).

---

## Appendix B — Decisions taken, and what is still open

The seven questions that used to block Phase 1 are answered. They are recorded
here because each one closes a branch of the plan, and the reasoning is worth
keeping next to the decision.

**Target version (added after review).** The plan targets `main` at `fdce48e`
(post-1.3.0, unreleased), because the sleep/wake and restart-parking design
needs it. Pin the commit and every package, not the string `1.3.0`; the schema
migrates to version 2 and cannot be opened by 1.3.0 or earlier. If you pin the
`v1.3.0` tag instead, the deferred list in §0.1 applies.

**Confirmed for v1 (commit 2).**

- **Security:** trusted agent + accident guardrails + scheduled SAF export.
  `android:process=":kernel"` is process isolation, not a uid boundary; the
  `beforeTool` guard is not a sandbox. Agent-written extensions are
  user-confirmed installs by default, with a trusted-session upgrade path. A
  second package/uid worker is a separate spike, not v1.
- **Runtime:** proot rootfs launched from `nativeLibraryDir` under `targetSdk
  35`; a custom bionic Node is a later optimization; on-device Gradle is a
  Phase 5 experiment with a host fallback.
- **Events:** `subscribeCommits` fold, no-write commit barrier, singleton app
  docs (the long-term phone-scale answer, not a v1 shortcut), `pi.live`
  streaming, snapshot on head writes, one WS snapshot path, entries paging,
  and **scoped snapshots**: a snapshot carries one conversation's transcript
  plus a child index (ids and owner edges, no transcripts); a child view is a
  second scoped subscription on the same commit stream, not a bigger snapshot
  and not a paged substitute (§1.9).
- **Spikes:** S0.1 verifies `processLock` on the target device (fallback:
  child-owned `FileLock`); S0.7 names and proves a no-USB install path.

1. **The workspace is a git clone, not a synced copy.** The agent can commit
   and push from the phone; a copy could not. The price is credentials on the
   device (§5 R8) and a guard that is not a sandbox (§2.6, §4.4), because a
   clone is exactly what `git clean -fdx` and `git reset --hard` operate on.
   The Pi state directory stays outside the workspace.
2. **The network is required for model inference; the shell and the durability
   layer must work offline.** This forces Option A: a local shell is the only
   one that works with no network at all. Option C1 is out as a target for the
   same reason (§1.5, §1.6).
3. **Only your own phone.** Sideloading, `specialUse`, Play Protect warnings
   and a large APK are all acceptable costs, and the Play Store's constraints
   do not bind (§1.3, §5 R6).
4. **Option A is the target.** The justification is narrower than "most of the
   setup needs a shell": it is that the review, commit, github, librarian and
   update-changelog workflows and the git viewer need `git`, and the
   self-building loop also needs a native build toolchain (on-device if S0.7
   passes, otherwise a host). A reimplementation path
   exists — the git viewer on `isomorphic-git`, review-triage rebuilt on top of
   it — but it would cost review, commit, github, librarian and
   update-changelog, which defeats the point of a self-building dev
   environment. For a learning project, stay on A (§5 R4, R13).
5. **The transcript is recoverable, not backup-managed.** Set
   `android:allowBackup="false"` **and** a `dataExtractionRules` exclusion for
   `pi/` covering cloud backup and device transfer; the scheduled SAF export is
   the recovery path. The export format is still open (#8).
6. **The native bridge is microphone, file picker, share intents and
   notifications — nothing else.** It stays outside the durable state path:
   an app-to-app IPC surface for the WebView, not a tool (§2.6).
7. **Vite runs on the phone, inside the kernel.** The HMR loop needs no host
   machine, no USB port and no `adb`: the dev server is part of the kernel and
   binds to loopback. This is a new unknown and has its own spike (§5 R12).

Still open:

8. **What is the export format?** A JSON dump of the conversation's entries
   and documents, a Markdown transcript, or the SQLite file itself? The
   mechanism is decided (scheduled, redacted, SAF); the format is not. A
   Markdown transcript plus a machine-readable sidecar is the likely shape.
9. **Does the git viewer read git through the `bash` tool, or through a
   dedicated read-only tool?** A dedicated `git_*` tool with a narrow schema is
   easier to guard and easier to give a replay policy; `bash` is one call away
   from anything. The guard question decides it (§2.6). Until it is decided,
   §2.4 and §3.2 treat only the non-mutating `git_*` commands as `safe` and
   `bash git …` as unsafe.
10. **How much memory does the in-kernel dev server cost, and does it starve
    the agent?** A phone running a bundler, a model stream and a tool call at
    once is the tightest case in the plan; §5 R12's spike measures it, and its
    answer decides whether HMR stays a dev convenience or becomes the only
    build path.
11. **Is the second package/uid worker worth it?** It is the only real security
    boundary (a worker APK that owns the workspace and runs `bash`/gradle, with
    AIDL copy-in/copy-out and no access to `pi/`). It means two APKs and an IPC
    protocol; evaluate it as a separate spike, not a v1 assumption.
