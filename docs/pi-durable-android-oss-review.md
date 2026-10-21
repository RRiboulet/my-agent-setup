# Open-source landscape review for "Pi Durable Android"

> **This copy is not canonical.** The plan now lives with the app it
> describes, in **https://github.com/RRiboulet/pi-termux-mobile** —
> `docs/pi-durable-android-plan.md` — together with `docs/plan-revision.md`,
> which says what changed and why. This branch is kept for the review
> history, as the plan's own provenance note says. Work on the copy in the
> app repository.

**Question asked:** which existing projects solve the same problems (Android
foreground service + Node runtime + WebView + durable SQLite storage), and
what is the fastest path to an MVP?

**Method.** Eight repositories cloned and read at source level (not READMEs):
`picassio/pi-phone`, `TannerMidd/pi-pocket`, `petrroll/pocket-pi`,
`heikeyangle-code/pi-android`, `NJS98-UI/haiou`,
`YOYOFeelings/DeepSeek-Harness-Android`, `pht88888888/DSHAPP`, and
`MaliNamNam/pi-phone`; plus web research on `imtaqin/andropi`,
`AidanPark/openclaw-android`, `HakaI963/kuro`, the Node and Android platform
documentation, and the Vite / `better-sqlite3` / `vite-capacitor` package
registries. Citations are `repo/path:line`. This document is a
companion to [`pi-durable-android-plan.md`](pi-durable-android-plan.md); where
the two disagree, **this document wins on facts** and the plan needs
updating.

**Verdict in one line:** the ecosystem already solved the hard Android half
(proot-free runtime packaging, foreground-service supervision, WebView
hardening) and the hard kernel half (`Harness.open` + `subscribeCommits` +
committed-state-only projection) — but every working implementation is pinned
to **Pi Durable 1.3.0**, and the plan's wake/sleep and restart-parking design
does not exist there.

---

## Table of contents

- [1. Executive summary](#1-executive-summary)
- [2. Premise corrections](#2-premise-corrections-things-in-the-brief-that-are-wrong)
- [3. What each project actually is](#3-what-each-project-actually-is)
- [4. The fork recommendation](#4-the-fork-recommendation)
- [5. Component reuse map](#5-component-reuse-map)
- [6. Gap analysis](#6-gap-analysis-what-we-must-build-ourselves)
- [7. Revised MVP roadmap](#7-revised-mvp-roadmap)
- [8. Two plan changes this review forces](#8-two-plan-changes-this-review-forces)
- [9. Research appendix](#9-research-appendix)
  - [9.1 Repository inventory](#91-repository-inventory)
  - [9.2 Storage, tooling and platform policy](#92-storage-tooling-and-platform-policy--the-four-questions-asked)
  - [9.3 Claims that are folklore, not fact](#93-claims-that-are-folklore-not-fact)
  - [9.4 What the local plan gets wrong](#94-what-the-local-plan-gets-wrong-for-a-follow-up-edit)
- [10. What if we forked `badlogic/pi-termux-mobile` instead?](#10-what-if-we-forked-badlogicpi-termux-mobile-instead)
- [11. The PoC question: `jeamy/pi-termux-mobile`](#11-the-poc-question-jeamypi-termux-mobile-as-the-starting-point)

---

## 1. Executive summary

**Fork `TannerMidd/pi-pocket` (server + web app) and lift `picassio/pi-phone`'s
Android shell + rootfs packaging as a template — do not fork pi-phone itself,
and do not use proot.** pi-phone's `android/` (2,155 lines of Java) plus
`scripts/package-rootfs.ts` is the only runtime packaging in this ecosystem
that is SHA-verified, version-stamped, atomically swappable and *proven on a
real phone*; pi-pocket's server is the only implementation of the
"one `subscribeCommits` listener → per-conversation projection → passive
client" model the plan's §1.9 describes. But pi-phone is pi-pocket *plus a
product* (multiplayer, wiki, teams, terminal, browser, themes) pinned to Pi
Durable **1.3.0**, so forking it buys the wrong half of the stack and an API
generation we must leave anyway.

**A third source changes the shape of the answer.** `badlogic/pi-termux-mobile`
— written by the Termux maintainer and pi's own author, and the project
pi-phone's Android shell was derived from — runs **Pi Durable on the phone**
behind a **587-line** `runtime/server.mjs`, with the plan's §2.5 owned-child
subagent recipe already written. Its *kernel* is a better template than
pi-pocket's 100+ modules; its *shell* is a strict subset of pi-phone's. So the
recommendation is a three-way synthesis, not a single fork (§10).

**The single most consequential finding:** `NJS98-UI/haiou` measured, on a
OnePlus running **Android 16**, that the kernel refuses to `execve` a
**non-bionic** ELF out of the app-data directory *at any targetSdk*
(`AGENTS.md` pitfall 84: `proot error: execve("/usr/bin/bash"): Permission
denied`), which puts the plan's §1.3 proot-from-`nativeLibraryDir` route in
real doubt on current devices — while `picassio/pi-phone` runs the same class
of workload on a Galaxy Z Fold 8 by staying on **targetSdk 28** and a **bionic
Termux prefix**, with no proot at all.

---

## 2. Premise corrections (things in the brief that are wrong)

The brief was written from memory and contains four material errors. Each one
changes a decision, so they are corrected first.

### 2.1 `picassio/pi-phone` is not React Native, and it is not a remote UI

The brief describes it as "a React Native app with a bundled Linux userland".
It is a **native Java app** (`android/app/src/main/java/io/piphone/*.java`,
2,155 lines across 7 files) whose UI is a **plain-JavaScript Preact + htm**
web app (`web/`, 49 modules, **no build step**) rendered in a `WebView`. The
server (`src/server/`, 184 modules) runs **inside the app's own Node
process**, on loopback, in the foreground service.

It is, in other words, **the architecture the plan already chose**, shipped and
working. That is the opposite of "the thing you are replacing".

### 2.2 The plan's §1.1 dismissal of "pi-phone" is about a *different repo*

`docs/pi-durable-android-plan.md` §1.1 says "`pi-phone` is not a runtime you
can bundle" and cites `MaliNamNam/pi-phone`. That repo exists and is what the
plan describes — a phone-first *remote* UI for a Pi session. It is **not**
`picassio/pi-phone`, which is a different project by a different author with
the same name and the opposite architecture.

The plan's §1.1 table also describes `picassio/pi-phone` as
`MaliNamNam/pi-phone` in the same row. **§1.1 and the §0 sources table must be
corrected before any implementation starts**, because §1.1 is currently the
plan's justification for building the runtime from scratch.

### 2.3 `TannerMidd/pi-pocket` is pi-phone's *upstream*, not an alternative to it

`picassio/pi-phone/UPSTREAM.md`:

> pi-pocket: https://github.com/TannerMidd/pi-pocket at `e5456a8…` (MIT).
> `src/server/`, `web/`, `test/`, `types/` started from this commit, then cut
> down (DESIGN.md section 3).

So pi-phone is a **fork of pi-pocket** with an Android shell bolted on and
features removed. There is no "pi-pocket frontend vs pi-phone frontend"
choice: pi-phone's `web/` *is* pi-pocket's `web/`, trimmed. Both are
**Preact + htm as plain ES modules**, `package.json` devDependency
`preact`, `htm`, no bundler.

### 2.4 The "5-second watchdog" is not in pi-phone at all

The brief lists the watchdog under the "Harness Shell" projects. It belongs to
`NJS98-UI/haiou` (`EngineService.kt` + `WatchdogV2.kt`), not to pi-phone.
pi-phone's supervision is simpler: the service supervises the Node child and
restarts it when it exits with code 75 (`PiService.java:34`, `:141`).
Both are documented below.

---

## 3. What each project actually is

| Project | Runtime | Storage | Engine | UI | Maturity |
|---|---|---|---|---|---|
| **`picassio/pi-phone`** | Termux **bionic** prefix in `files/usr`, `targetSdk 28`, **no proot** | `node:sqlite` (one `pocket.sqlite`) | **Pi Durable 1.3.0**, in-process | Preact+htm, no build step, in a `WebView` | 242 commits, 105 test files, real device (Galaxy Z Fold 8 / Android 17), updated 2026-10-21 |
| **`TannerMidd/pi-pocket`** | whatever host it runs on (Termux OK) | `node:sqlite` | Pi Durable 1.3.0 | Preact+htm, no build step | 0.19.0, upstream of pi-phone |
| **`heikeyangle-code/pi-android`** | **proot** + Ubuntu 24.04 glibc + Node 24.19 | JSONL sessions (pi CLI) | pi **coding agent** 1.1.0 over RPC | Compose + WebView | 263 `.kt`, SHA-pinned runtime, `pi-contract.mjs` CI gate |
| **`NJS98-UI/haiou`** | Termux snapshot, `targetSdk 34`, xattr + termux-exec + linker64 fallback | engine's own | DeepSeek Harness | WebView + injected bridge | 9,670 LoC Kotlin, **92 documented pitfalls** |
| **`YOYOFeelings/DeepSeek-Harness-Android`** | **downloads** A's snapshot at runtime | — | DeepSeek Harness | Compose | skeleton; **ships no runtime** |
| **`pht88888888/DSHAPP`** | Termux prefix, ELF rewritten in place | engine's own | cordis-based DSH | WebView + `DSHAndroid` bridge | 215 commits, 40.6k LoC Kotlin, **zero unit tests** |
| **`petrroll/pocket-pi`** | Termux bootstrap zip, `applicationId = "com.termux"` (**hack**) | — | pi **coding agent** (older) | Compose | 68 MB APK, prototype |
| **`badlogic/pi-termux-mobile`** | Termux bionic prefix, `targetSdk 28`, **no prefix rewrite** | `node:sqlite` (`harness.sqlite`) | **Pi Durable 1.0.2**, in-process | vanilla-JS pages in a `WebView` | 14 commits, by the Termux maintainer; *"quick & dirty version 0"* |
| **`MaliNamNam/pi-phone`** | none (needs a host) | remote | pi coding agent | mobile web | remote UI — the thing being replaced |

### 3.1 The one that matters: `picassio/pi-phone`

Its Android layer, in full:

```
android/app/src/main/java/io/piphone/
  PiService.java        328  ForegroundService: owns the Node child
  MainActivity.java     625  WebView host + JS bridge
  RuntimeInstaller.java 145  versioned rootfs/runtime extraction + swap
  Updater.java          166  release manifest, SHA-256, PackageInstaller
  Renderer.java         409  screenshots for the agent
  PiBrowser.java        296  the agent's own browser, separate WebView profile
  Dictation.java        186  SpeechRecognizer bridge
```

`PiService.java:89` — the whole supervision story:

```java
startForeground(1, notification());
...
return START_STICKY;
```

`PiService.java:170-186` — the launch:

```java
ProcessBuilder builder = new ProcessBuilder(
        new File(prefix, "bin/node").getAbsolutePath(),
        new File(files, "runtime/src/server/main.ts").getAbsolutePath(),
        "--host", "127.0.0.1", "--port", String.valueOf(PORT),
        "--cwd", new File(home, "work").getAbsolutePath());
env.put("HOME", home.getAbsolutePath());
env.put("PREFIX", prefix.getAbsolutePath());
env.put("PATH", prefix.getAbsolutePath() + "/bin:/system/bin");
env.put("LD_PRELOAD", new File(prefix, "lib/libtermux-exec-ld-preload.so").getAbsolutePath());
env.put("SHELL", new File(prefix, "bin/bash").getAbsolutePath());
```

The runtime is a **Termux aarch64 prefix**, rewritten in place at build time:

`scripts/package-rootfs.ts:1-14`:

> Resolves PACKAGES and their dependencies from the aarch64 Termux index,
> downloads each .deb, checks its SHA-256 against the index, extracts it
> without maintainer scripts, and rewrites the prefix `/data/data/com.termux`
> to `/data/data/io.piphone` in every file and symlink. **Both are ten
> characters, so ELF binaries keep their layout.**

That equal-length trick is the quiet reason this project works at all: the
Termux binaries keep their baked-in paths, so no relinking is needed. The
APK size cost is the whole Termux userland (node, npm, bash, git, gh, ssh,
rg, fd, python, tmux, make, jq, vim, htop, sqlite).

`scripts/package-rootfs.ts:44-73` — the package list. `scripts/package-runtime.ts`
tars `src/`, `web/`, `package.json` and `node_modules` into `runtime.bin`.
`RuntimeInstaller.java:78-113` extracts each part to a staging dir, verifies a
sentinel (`usr/bin/node`, `runtime/src/server/main.ts`), renames the old part
aside, renames staging in, deletes the old.

### 3.2 The kernel layer: pi-phone already implements the plan's §1.9

`src/server/app.ts:885-913` — this is the plan's §1.6/§1.8/§1.9, working:

```ts
const storage = await openNodeSqliteStorage(join(this.dataDir, "pocket.sqlite"));

this.harness = await Harness.open(
    storage,
    {
        models: this.models,
        registry,
        settings: this.#harnessSettings(),
        env: ({ cwd }) => this.secrets.guard(this.places.env(cwd ?? this.defaultCwd)),
        conversationCreated: async (tx, conversation) => { /* per-conversation docs */ },
        onReport: (error) => this.notice("warning", describe(error)),
    },
    context,
);
...
this.#unsubscribeCommits = this.harness.subscribeCommits((publication) =>
    this.#committed(publication),
);
...
this.harness.resume();
```

Four structural matches with the plan, worth naming explicitly:

1. **One `subscribeCommits` listener, fanned out to per-conversation rooms.**
   `src/server/room.ts:1-4`: *"One conversation's shared live view: the
   committed Pi Durable view plus Pi Pocket's own documents, projected into
   small updates for every browser tab attached to it."* That is the plan's
   §1.9 fan-out, already written.
2. **A semantic projection layer, not raw storage ops.**
   `src/server/projection.ts:1-4`: *"What browsers get: compact, display-ready
   JSON derived from the committed conversation view."* 790 lines producing
   `ClientEntry` / `ClientLive` / `ClientToolSlot`. This is the plan's §1.9
   "why a semantic layer and not raw Chord ops", already implemented.
3. **Committed state only.** pi-pocket's README: *"Browsers render only
   committed state. Each session's Pi Durable view is coalesced and sent as
   small updates over server-sent events, so a device that reconnects or joins
   late sees exactly what everyone else sees."* Identical to the plan's §3.1.
4. **A slow client is cut off, not allowed to stall the commit line.**
   `src/server/http/events.ts:23-26`: `BEHIND_BYTES = 8 MB`,
   `STALLED_MS = 30_000`, `MAX_BEHIND_BYTES = 128 MB`; a client that stops
   draining is disconnected and *"connects again, and gets a full view."*
   That is the plan's §1.9 bounded-queue-overflow → resnapshot rule, already
   implemented — over SSE rather than WS.

### 3.3 The self-building loop: R1 already exists, and it is better than planned

`src/server/reload.ts:1-8`:

> Live editing. Extension modules are imported again when they change and
> installed under the same names, which replaces them in one step: a tool call
> already running finishes on the old code, the next one uses the new code.

The loader is **native `import()` with a cache-busting query**
(`reload.ts:673-677`):

```ts
const url = pathToFileURL(join(module.directory, file)).href +
    (cacheBust ? `?v=${Date.now()}-${++imports}` : "");
const loaded = (await this.#within(import(url), deadline, file)) as ExtensionModule;
```

with a load deadline (`LOAD_LIMIT_MS = 30_000`, `reload.ts:45`), a generation
counter so a stale load cannot clobber a newer one, and
`registry.install(extension)` for in-place replacement (`reload.ts:804`).

**This removes a cost line from the plan.** The plan's §4.2 says:

> The app must add one (`jiti` or `esbuild`) and resolve
> `@earendil-works/pi-durable`, TypeBox and the extension's other imports from
> the kernel's `node_modules`.

**No loader is needed.** Node ≥ 22.19 strips TypeScript types natively, and
pi-phone imports `.ts` extension files directly — `jiti` is in
`package.json` but appears **nowhere** in `src/`. The only real constraint is
that extension source must be *erasable-syntax-only* TypeScript, which is
exactly the constraint this repo's own `AGENTS.md` already documents for
`todos.ts`.

### 3.4 The three-way "steer or queue" implementation

Server side, `TannerMidd/pi-pocket/src/server/commands.ts:813`:

```ts
whenBusy: request.mode === "steer" ? "steer" : "followUp",
```

with `interrupt` handled separately at `commands.ts:801-809` (abort the run
*before* submitting, with a `submissionByRequest` idempotency check so a
retried request cannot stop the run the first one started).

Client side, `pi-pocket/web/composer.js:122-124`:

```js
["steer", "Steer", "Pi reads it now, between steps"],
["followUp", "Queue", "Pi reads it when this run ends"],
["interrupt", "Interrupt", "Stops the run right now (also its tool call), then sends it"],
```

and a queue dock rendering `pi.inbox`-style queued messages
(`composer.js:128-146`, `:1073-1099`).

**The plan's §3.2 S2 composer is already built.** Note one divergence worth
copying deliberately: the plan proposes Steer / Follow-up / **Reject**;
pi-pocket ships Steer / Queue / **Interrupt**, and "Interrupt" is strictly
better on a phone than "Reject" (it stops the run *and* sends). Adopt
Interrupt.

### 3.5 `NJS98-UI/haiou` — the supervision and SAF reference

**The watchdog** (`EngineService.kt:96-181`, `WatchdogV2.kt`) is a 5-second
`scheduleWithFixedDelay` running a **three-signal** deep probe
(`WatchdogV2.kt:94-129`):

1. an **authenticated** HTTP probe of the engine (per-process launch token
   parsed from the engine's log banner, `EngineProbe.kt:53-121`);
2. an **incremental engine-log delta scan** for
   `UncaughtException` / `plugin tree failed to load`, with a byte-offset
   cursor — the previous fixed-4 KB-tail scan caused "it keeps restarting
   itself when it has been up a while";
3. an **internal plugin-tree probe** (`GET /api/android/file-incoming`) — a 404
   means the plugin that injects `workspaceRegistry` never activated, i.e.
   *HTTP is healthy but the engine is dead inside*. Deliberately **not** folded
   into the healthy boolean, so the circuit breaker cannot stall the
   escalation.

Escalation (`WatchdogV2.kt:28-76`, `EngineRepair.kt:61-124`):

| Consecutive failures | Action |
|---|---|
| 1 | log only (HTTP jitter protection) |
| ≥ 2 | kill + respawn the engine |
| ≥ 12 | **circuit breaker**: watchdog pauses |
| breaker open > 5 min | **half-open**: one probe through |
| between attempts | backoff 5 s → 80 s cap |

and the state is **durable** — `files/.engine-repair.json` with
`MAX_ACTIONS_PER_DAY = 4`, `RESTARTS_PER_EPISODE = 2`, `EPISODE_MS = 30 min`,
written tmp+rename, with an escalation ladder that reaches *runtime rebuild*
and *user-data quarantine* (rename to `<name>-stale-<ts>`, never delete).

`EngineManager.kt:1605-1630` keeps an append-only
`files/engine-start-ledger.txt` of every start decision, created because
`engine.log` is the engine's own stdout and does not exist when the engine
never spawned.

**The SAF directory bridge** is a three-hop round trip, not a Binder:

1. page → engine: poll `/api/android/dir-pick/poll`
   (`dsh-host-web-compat/lib/index.js:152-160`);
2. page → native: `window.androidBridge.pickDirectory(callbackId)` →
   `registerForActivityResult(OpenDocumentTree())` (`MainActivity.kt:194-217`);
3. native → page → engine: the picked URI is mapped to a real path and
   POSTed back (`MainActivity.kt:202-205`, `lib/index.js:120-130`).

The mapping itself (`AndroidBridge.kt:255-285`) handles removable volumes
(`<volume-uuid>:rel`), the `raw:/storage/…` form some ROMs emit, and rejects
`..` segments. Authorisation uses a **per-process pick token** delivered to
the engine as `DSH_PICK_TOKEN` and echoed back in an `x-dsh-pick-token`
header. Slot hygiene: **one pending pick, 5-minute TTL**, second pick rejected.

**Online runtime updates** are split in two, and only one works:

- the in-APK snapshot refresh (`EngineManager.kt:127-190`) is
  *in-place re-extract → sentinel check → restore user data → write the
  fingerprint last*. It **deliberately does not** use rename-aside staging,
  and the reason is measured, not theoretical (`AGENTS.md` pitfall 79 ④):

  > 真机两轮实测证明「先把老树 rename 走再解压」不能自动化：让位之后设备在整整
  > 一轮解压里**没有任何可用运行时**（用户视角=「都启动不了了」）… 解压被杀进程/重启/
  > 空间不足打断时，唯一可用基线已被自己移走，回滚无从回滚。

  The fingerprint is a sha256 of the snapshot; `snapshotFresh()` checks both
  the sentinel paths and the fingerprint, so *"半树不会被固化成「新鲜」"*.
- the *tool-asset* path (`EngineManager.kt:456-528`) is the clean one:
  staging → per-asset sha256 verify → promote → **stamp only on success**, so
  a failed extraction never leaves a half-tree frozen as "current".

### 3.6 `pht88888888/DSHAPP` — the degradation ladder

The brief says "four-level". It is **five tiers**
(`RescueBoot.kt:111-133`):

| Tier | Meaning | Trigger | Auto? |
|---|---|---|---|
| `NORMAL` | nothing degraded | — | — |
| `ISOLATED` | suspect third-party bundles removed by **bisection** | ≥ 2 consecutive failures **and** the failure looks plugin-shaped | yes |
| `QUARANTINED` | one specific plugin entry disabled via overlay | L1 located a suspect, final verification failed | yes |
| `RESCUE` | engine runs `--profile rescue`, a **separately generated profile** with a hardcoded core-bundle list | L1 exhausted, or the engine came up but its gateway died | yes |
| `SAFE_MODE` | profile overlay + third-party bundles + third-party `node_modules` + `engine/.stamp` + Node runtime re-unpack | ≥ 3 consecutive failures **and** tier == RESCUE, or the user taps the button | both |

The L1 algorithm is a real bisection with **real engine starts** as probes
(`EngineManager.kt:5879-…`): remove all third-party bundles → if it starts,
it is a plugin problem → split the candidate set, remove half, retry →
converge on one culprit → confirm. Budget `ISOLATION_BUDGET_MS = 3 min`,
`PROBE_TIMEOUT_MS = 60 s` per probe.

**The design decision worth stealing** is that rescue is a *second, independently
generated profile directory* (`EngineManager.kt:4465-4495`), with a
hardcoded core-bundle list, **not** a mutation of the user's profile. The
plan doc's own reasoning: *"不要读用户的 `web/package.json` —— 那个文件可能正是
坏的."* The user's configuration is left byte-identical and the switch back is
`rm -rf` one directory.

**Two findings that should change our design:**

1. **The ladder is trigger-blind to runtime failures.** The project's own
   post-mortem (`EngineManager.kt:2029-2050`) records that a plugin throwing in
   a runtime callback exits the engine, which takes the "engine exited → restart"
   branch, **not** the "startup failed" branch — so `RescueBoot.recordFailure`
   is never called and *all four gates fail to hold*. Our risk is precisely
   "an agent-written extension breaks the running kernel", i.e. a **runtime**
   failure. DSHAPP's ladder would not catch it.
2. **The `.stamp` short-circuit makes corruption permanent.**
   `EngineManager.kt:280-286`: if the version stamp matches, extraction is
   skipped — *"改坏的是 `engine/` 下的文件时，永远不会被还原，因为版本戳没
   变."* This is why SAFE_MODE deletes the stamp. Our runtime installer must
   either verify content hashes on every start or expose the same escape hatch.

**The best idea in the whole repository** is `RescueCommandBridge.kt`: a
**file mailbox** that lets the agent test its own change without killing
itself.

```
AI writes  $DSH_HOME/rescue-cmd.json     (integer id, action)
App polls  every 200 ms
App runs   the action                    (e.g. try-boot with a bundle filter)
App writes $DSH_HOME/rescue-result.json  (atomically, tmp+rename)
AI reads   the result
```

Its four invariants (`RescueCommandBridge.kt:38-62`) are a good spec for any
agent↔host mailbox we build: the id **must** be an integer and the max
handled id **must** be persisted (idempotency); **write the receipt before
deleting the request**; a corrupt request file is not an error (retry next
tick); and the expensive action has a **quota** (`PROBE_QUOTA = 20`, persisted
to `rescue/probe-count.json`).

**Also worth lifting wholesale:** `MainActivity.onRendererGone()`
(`MainActivity.kt:428-530`). It window-counts renderer deaths
(`RENDERER_RESTART_WINDOW_MS`), applies backoff, caps restarts
(`MAX_RENDERER_RESTARTS`), and — critically — **reloads with a fresh launch
token**, because a plain `reload()` replays a stale token and 401s forever.
The repo's note on why this matters: *"用户遇到的「App 突然自己退了/闪退」，很
可能根本不是 App 的 bug，而是这个回调没被覆写"*. The plan's §1.10 says
`onRenderProcessGone` must return `true`; DSHAPP shows what a real
implementation looks like.

And `CrashRecorder.installUncaughtHandler()` (`CrashRecorder.kt:188-230`)
insists on three things: **`tryLock`, not `lock`** (a crash can happen on the
thread holding the log lock; hard-waiting deadlocks the crash handler, which
is worse than the crash), a **separate file and handle** for the scene write,
and **handing the exception back to the default handler** (otherwise the
process swallows the crash and ANRs instead of exiting).

### 3.7 `heikeyangle-code/pi-android` — the proot reference, and its warning

This is the project that proves the proot route *can* work — Ubuntu 24.04
(glibc 2.39) + official Node 24.19 + `proot` (Termux build) + `git`/`rg`/`fd`,
every artifact SHA-256 pinned in `runtime.lock.json` with a `"why"` field.

Its most important contribution is a **targetSdk capability switch**
(`app/build.gradle.kts:21-43`):

> targetSdk is a *runtime capability switch*, not a style choice.
> Android 10 (API 29) stopped letting an app execve() files in its own data
> directory. pi's whole runtime lives there (the Ubuntu rootfs, Node, every
> tool), so the choice is:
> - **28** the pre-W^X sandbox. Termux pins 28 for exactly this reason… Known
>   good. Play-incompatible.
> - **36** Play-viable: proot's loader is exec'd from nativeLibraryDir and
>   maps the guest binaries itself. **Reported working on API 35/36, but not
>   proven on this device yet.**
>
> Default is 28 so a sideloaded build is known-good; CI also produces the 36
> variant (`-Ppi.targetSdk=36`) so the modern path can be validated on
> hardware instead of guessed at.

Read that next to haiou's Android 16 measurement and the picture is clear:
**the 28 path is known-good; the 36 path is reported but not proven, and one
project has measured a failure in that family.** `heikeyangle-code/pi-android`
also keeps a **contract gate in CI** (`tools/pi-contract.mjs`): every upstream
fact the app depends on is checked against the pinned version and *the build
fails* if upstream renamed or changed something. That is the right answer to
the plan's §5 R7 ("Pi Durable is explicitly experimental").

Its `GuestRecipe.kt` is also the best surviving documentation of proot bind
semantics, including the traps: `/dev/shm` must be the **last** system bind
(else the guest's `/dev/random` is the host's urandom, major:minor 1:9), and a
bind whose **host source** is app-private breaks `scandir(3)`/`mkstemp(3)` for
the whole subtree — which is why `/tmp` is not bound any more.

### 3.8 `petrroll/pocket-pi` — a cautionary tale about the Termux approach

Its `android/app/build.gradle.kts` has the same targetSdk-28 reasoning, but
it also does this:

```kotlin
// TEMP for emulator validation. The upstream Termux bootstrap zip ships
// compiled binaries … with the path /data/data/com.termux/files/usr baked in.
// Until we rebuild a custom bootstrap pinned to our real prefix, run as
// com.termux so that Android's chosen filesDir matches what the binaries expect.
applicationId = "com.termux"
```

It impersonates `com.termux` to make a stock bootstrap work. pi-phone's
**equal-length prefix rewrite** is the correct version of this idea: it keeps
the binaries' baked paths valid without pretending to be another package.

### 3.9 `badlogic/pi-termux-mobile` — the upstream, and the best *kernel* template

This one deserves its own section because it is **not** a peer of the others:
it is written by **Mario Zechner (`badlogic`) — the Termux maintainer and the
author of pi itself** — and it is the project `picassio/pi-phone`'s Android
shell was *derived from* (`UPSTREAM.md`: *"`android/`,
`scripts/package-rootfs.ts` (ported from `package-rootfs.py`) and the APK
workflow started from it"*).

14 commits, HEAD `a36765b` (2026-10-04), and it runs **Pi Durable on the
phone** — the only project in this ecosystem that does. It is the
**grandparent** of pi-phone's shell (this landed 2026-10-04; pi-phone's
Android shell landed 2026-10-17), and it has **no LICENSE file** and no
third-party notices for the GPL Termux debs it redistributes:

> Minimal Android app that embeds Termux-built binaries (Node.js 26.4.0, bash,
> coreutils, git, ripgrep, fd, openssh, npm …) plus a **pi-durable** harness
> (`@earendil-works/pi-durable` 1.0.2 …) behind a tiny HTTP/SSE/WebSocket
> bridge (`runtime/server.mjs`). UI is a local WebView on `http://127.0.0.1:<port>`.

**`runtime/server.mjs` is 587 lines and is the closest existing thing to the
plan's §1.9 kernel contract.** Compare pi-pocket: `app.ts` alone is 3,000
lines with 100+ modules. This one file contains:

- `openNodeSqliteStorage` → `harness.sqlite`, `Harness.open(storage, { models, registry, env: envFor })`, `harness.root(...)`, `harness.resume()` — the plan's §1.6/§1.7/§1.8, working;
- **the plan's §2.5 owned-child subagent recipe, verbatim, in 30 lines** —
  `tx.scanConversations({ ownerTaskId: api.taskId }, 1)` to reuse an existing
  child, `tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })`,
  `requestId: 'subagent:${api.taskId}'`, `replay: 'safe'`, `api.details({ conversationId })`;
- the `envFor(cwd)` **one-line seam** the plan's §1.6 specifies, with
  `RemoteExecutionEnv` selected by a `remote:<name>:/path` cwd — the plan's
  §1.5 C1, implemented;
- SSE at `/api/events` with `x-token` / `?token=` auth, plus a `/pty`
  WebSocket for xterm.js;
- a file-backed credential store over `~/.pi/agent/auth.json` (the plan's §2.8/R8).

**Its `ANALYSE.md` is the most valuable document in this entire ecosystem** —
a platform analysis by the Termux maintainer, with evidence tiers
(`[实测]` / `[文件]` / `[推断]`). It is the source of the exec-path rules this
review relies on, and it settles two questions the plan had open (§8.1,
§8.2).

**Its Android shell, by contrast, is a strict subset of pi-phone's** — and
that is the important asymmetry:

| | `pi-termux-mobile` | `picassio/pi-phone` |
|---|---|---|
| Prefix rewrite | **none** — `PREFIX = "/data/data/com.termux/files/usr"` is used only to relativize symlinks (`package-rootfs.py:14`, `:83`); the README concedes *"Termux scripts inside the bundle have `com.termux` shebangs and will fail"* | **equal-length in-place rewrite** `com.termux` → `io.piphone` (both 10 chars) — shebangs work |
| Version stamp | `RUNTIME_VERSION = 38`, a **manual integer** bumped by hand (`RuntimeInstaller.java:19`) | `sha256` of the packaging script (`versions.ts:34-36`) |
| Install | extract straight into `filesDir`; **no staging, no atomic swap** (`RuntimeInstaller.java:42-70`) | staging → sentinel check → rename-aside → rename-in |
| Online updates | **none** | manifest + SHA-256 + runtime-only swap + `PackageInstaller` |
| JS bridge | **none** — no `addJavascriptInterface` at all | `PiPhoneApp`, 13 methods |
| Renderer death | **not handled** — no `onRenderProcessGone` | also not handled (both need DSHAPP's pattern) |
| FGS type | `dataSync` declared (`AndroidManifest.xml:18`) — which on Android 15+ carries the 6 h/24 h cap | none needed at targetSdk 28 |
| `linker64` fallback | **implemented** (`PiService.java:96-103`) | not implemented |

**Conclusion: fork pi-phone for the shell, borrow pi-termux-mobile for the
kernel, and read `ANALYSE.md` before touching either.**

---

## 4. The fork recommendation

### 4.1 Fork `TannerMidd/pi-pocket`, not `picassio/pi-phone`

| | Fork pi-pocket | Fork pi-phone |
|---|---|---|
| Server code | pi-pocket's, 112 modules | pi-pocket's, 184 modules, **already cut down once** |
| Pi Durable version | 1.3.0 | 1.3.0 |
| Product surface | everything (collab, wiki, browser, terminal, spend, launcher, themes) | most of it removed, but the rest is still there (multiplayer, teams, wiki, browser, terminal) |
| Android shell | none | **the thing we want** |
| UI | Preact+htm, no build step | Preact+htm, no build step (same files) |
| Upgrade to Pi Durable `main` | required either way | required either way |
| Verdict | **fork this** | fork the *shell* only |

The decision is driven by one fact: **the plan's design requires Pi Durable
`main@fdce48e`, not 1.3.0.** `HarnessOptions.onWake`, `Harness.wake()`,
`settings.restartLimit`, `harness.retryTask()`, `TaskGraphState.sleeping` and
`TaskGraphNode.blocked` are all main-only (plan §0.1). Both projects pin
`"@earendil-works/pi-durable": "1.3.0"`. So **every line of server code we
keep must be re-validated against `main` anyway**, and the cheapest thing to
re-validate is the smallest thing.

### 4.2 What we keep, file by file

**From `picassio/pi-phone` — the Android shell and packaging (copy, then port to Kotlin):**

| Path | Lines | Keep | Change |
|---|---|---|---|
| `android/app/build.gradle` | 80 | the `targetSdk 28` decision + its comment | port to Kotlin DSL; add `-Ppi.targetSdk` switch (pi-android pattern) |
| `android/app/src/main/AndroidManifest.xml` | 40 | permission set, `allowBackup="false"` | add `dataExtractionRules`, `networkSecurityConfig` |
| `android/app/src/main/java/io/piphone/PiService.java` | 328 | **all**: FGS, wake lock, `ProcessBuilder`, env, log redirect, restart-on-75 | Kotlin; conditional wake lock (plan §1.10) instead of unconditional |
| `android/app/src/main/java/io/piphone/RuntimeInstaller.java` | 145 | **all**: two versioned parts, staging + sentinel + rename swap | add hash verification of the installed tree (DSHAPP's `.stamp` lesson) |
| `android/app/src/main/java/io/piphone/Updater.java` | 166 | **all**: manifest, sha256, runtime-only update, `PackageInstaller` | sign the manifest (see §6.4) |
| `android/app/src/main/java/io/piphone/MainActivity.java` | 625 | the WebView host, the `PiPhoneApp` bridge shape, the 503-wait-for-server | Kotlin; **add `onRenderProcessGone`** (DSHAPP pattern) |
| `scripts/package-rootfs.ts` | ~300 | **all** — the single most valuable file in the ecosystem | pin package versions (see §6.5) |
| `scripts/package-runtime.ts`, `scripts/versions.ts` | ~250 | **all** | — |
| `scripts/sqlite-vec.ts` | 60 | optional (vector search) | — |

**From `TannerMidd/pi-pocket` — the kernel and the UI:**

| Path | Lines | Keep | Change |
|---|---|---|---|
| `src/server/lock.ts` | 55 | **all** — single-writer pid lock | keep as the S0.1 fallback; prefer `processLock` |
| `src/server/projection.ts` | 855 | **all** — the semantic projection layer | re-validate against `main` |
| `src/server/room.ts` | 993 | the shape: per-conversation live view | add the plan's scoped snapshot + child index |
| `src/server/http/events.ts` | 393 | **all** — SSE + long-poll + backpressure cut-off | add `seq`, add explicit `snapshot` on attach (plan §1.9) |
| `src/server/reload.ts` | 1075 | **all** — native `import()` loader, deadline, generation counter, `registry.install()` | **add the user-confirmation gate** (see §6.2) |
| `src/server/secrets.ts` | 387 | **all** — per-command secret injection + redaction | — |
| `src/server/commands.ts` | 2054 | the steer/queue/interrupt path (`commands.ts:801-813`) | — |
| `web/` | 14 modules | **all** — Preact+htm, mobile-first, no build step | adapt to our screen set (§3.2 S1-S8) |

**What we drop from pi-pocket's server:** `browser/`, `terminal.ts`,
`collab.ts`, `spend.ts`, `push.ts`, `alerts.ts`, `para*`, `gallery/`,
`machines.ts`, `forwards.ts`, `tailnet.ts`, `omarchy.ts`, `watches.ts`,
`pip*`, `triggers` and every multiplayer doc. pi-phone's `DESIGN.md` §3 is a
worked example of this trim; reuse its list.

### 4.3 What we replace rather than reuse

| Plan requirement | pi-pocket/pi-phone equivalent | Why we replace it |
|---|---|---|
| §1.9 `WS /v1/events` with `seq`, scoped snapshots, `snapshot` on overflow | SSE `/api/events` + `/api/poll` | Keep SSE — it needs no WS handshake, works in a `WebView` via `EventSource`, and pi-pocket's backpressure semantics already match the plan. **Add**: an explicit `seq` watermark and a `snapshot` message on attach/overflow/head-write, so the client's "reconstruct from a snapshot" rule is explicit rather than emergent. |
| §2.2 replay policy | `replay: "safe"` on ~19 tools, no policy layer | The *vocabulary* is there; the **declaration discipline** is not. See §6.1. |
| §1.10 `onWake` → AlarmManager | none (pi-pocket has `schedules.ts` with its own timers) | Implement fresh against `main`. |
| §5 R3 `restartLimit: Infinity` | none (1.3.0 has no `restartLimit`) | Implement fresh against `main`. **Highest-value single line of code in the project**: it converts OEM kills from silent stalls into recoverable restarts. |
| §2.8 user-confirmed extension installs | `reload.ts` installs drop-ins silently | Add a confirmation gate. See §6.2. |
| §3.2 S4-S8 (task tree, subagent view, recovery sheet, usage sheet, git viewer) | partial (subagents board, files/changes) | Build fresh against `main`'s `taskGraph` / `blocked` / `sleeping` states. |
| §3.2 Vite HMR on the phone | **no build step at all** — reload | **Drop Vite.** See §8.2. |

---

## 5. Component reuse map

| Plan § | Requirement | Source to copy / adapt | Confidence |
|---|---|---|---|
| §1.3 | Runtime packaged in the APK, SHA-verified | `picassio/pi-phone/scripts/package-rootfs.ts` (+ `package-runtime.ts`, `versions.ts`) | **High** — proven on device |
| §1.3 | Runtime extracted, versioned, atomically swapped | `picassio/pi-phone/RuntimeInstaller.java:78-113`; harden with `haiou/EngineManager.kt:456-528` (verify-then-stamp) | High |
| §1.3 | Node launched with the right env | `picassio/pi-phone/PiService.java:175-186` (HOME/PREFIX/PATH/LD_PRELOAD/TMPDIR/SHELL) | High |
| §1.3 | `nativeLibraryDir` route (targetSdk-36 variant) | `imtaqin/andropi` `tool/bundle_runtime.py` (Termux binaries → `lib*.so` in jniLibs); `heikeyangle-code/pi-android/runtime.lock.json` + `PROOT_LOADER` | Medium — precedented, **not proven on Android 16** |
| §1.3 | Termux-prefix path rewrite | `picassio/pi-phone/scripts/package-rootfs.ts` (equal-length, `com.termux` → `io.piphone`) | High |
| §1.3 | **Decision: no proot** | `picassio/pi-phone` (bionic prefix, targetSdk 28) vs `NJS98-UI/haiou` pitfall 84 (Android 16 refuses non-bionic app-data ELF) | **High — this reverses plan §1.3** |
| §1.4 | Hermes fallback | `sugarforever/pi-durable-expo-env` (not re-reviewed here) | Medium |
| §1.6 | `envFor(cwd)` one-line seam | `pi-phone/src/server/app.ts:887` (`env: ({cwd}) => …`) — same shape as the plan | High |
| §1.7 | SQLite via `node:sqlite` | `pi-phone/src/server/app.ts:885`; **no `better-sqlite3`** (pi-phone prunes it from `node_modules` in `Dockerfile:25`) | High |
| §1.8 | One kernel process | `pi-pocket/src/server/lock.ts` (pid lock + `/proc/<pid>/cmdline` check) | High |
| §1.8 | Kernel survives Activity death | `pi-phone/PiService.java` (FGS owns the child; Activity is disposable) | High |
| §1.9 | `subscribeCommits` fold → fan-out | `pi-phone/src/server/app.ts:911` → `room.ts` (919 lines) | High |
| §1.9 | Semantic projection, not raw ops | `pi-pocket/src/server/projection.ts` (855 lines) | High |
| §1.9 | Bounded queue → resnapshot | `pi-phone/src/server/http/events.ts:23-26` (BEHIND_BYTES / STALLED_MS) | High |
| §1.9 | Scoped subscription (`?conversation=`) | `pi-pocket/src/server/http/events.ts:56` (`url.searchParams.get("c")`) — the mechanism exists | High |
| §1.10 | Foreground service + notification | `pi-phone/PiService.java:89` (startForeground), `:119` (START_STICKY) | High |
| §1.10 | WebView bridge | `pi-phone/MainActivity.java:84-192` (`addJavascriptInterface(…, "PiPhoneApp")`) | High |
| §1.10 | **Renderer death** | `pht88888888/DSHAPP/MainActivity.kt:428-530` (windowed counter, backoff, fresh-token reload) | High |
| §1.10 | Exact alarms / `onWake` | — (main-only API) | **Gap** |
| §2.2 | `replay` vocabulary | `pi-phone/src/server/extensions/*.ts` (19 `replay:` declarations) | High |
| §2.2 | **Replay policy layer** | — | **Gap** (§6.1) |
| §1.6 | `envFor(cwd)` one-line seam | `pi-termux-mobile/runtime/server.mjs:119-135` (local **and** `remote:<name>:/path`) | **High** |
| §1.9 | Minimal kernel skeleton (587 lines) | `pi-termux-mobile/runtime/server.mjs` — SSE `/api/events`, `/pty` WS, `watchEvents` + snapshot | **High** |
| §2.5 | Subagent / owned-child | **`pi-termux-mobile/runtime/server.mjs:69-107`** — the recipe verbatim: `scanConversations({ ownerTaskId })` reuse, `ownership: { kind: 'task' }`, `requestId: subagent:${api.taskId}`, `replay: 'safe'` | **High** |
| §1.5 C1 | `RemoteExecutionEnv` fallback | `pi-termux-mobile/runtime/remote-env.mjs` + `env-server.mjs` (136 + 119 lines) — **working**, not a plan | **High** |
| §2.8 / R8 | Model key out of the kernel env | `pi-termux-mobile/runtime/server.mjs:54-67` (file-backed `auth.json` credential store) | High |
| §3.2 | Terminal pane (xterm.js over WS) | `pi-termux-mobile/runtime/public/terminal.js` + `server.mjs` `/pty` | Medium |
| — | **Platform rules** (exec path, WebView, packaging) | **`badlogic/pi-termux-mobile/ANALYSE.md`** — by the Termux maintainer, with evidence tiers | **High — read it first** |
| — | `linker64` escape hatch to a higher targetSdk | `badlogic/pi-termux-mobile/PiService.java:96-103`; also `haiou` and `DeepSeek-Harness-Android` | **High** |
| §2.6 | Phone-capability bridge | `picassio/pi-phone` `Dictation.java` + `web/android-speech.js`; `heikeyangle-code/pi-android/app/src/main/kotlin/app/pi/bridge/*` (capability-gated) | Medium |
| §2.7 | Skills → sections | `pi-pocket/src/server/prompts.ts`, `skills.ts` | Medium |
| §2.8 | Secrets never in the kernel env | `pi-pocket/src/server/secrets.ts` (per-command `env: {…}`, redaction of output) | High |
| §2.8 | **User-confirmed extension install** | — | **Gap** (§6.2) |
| §3.2 S1-S3 | Transcript, composer (steer/queue), status strip | `pi-pocket/web/` (`composer.js:122-124`, `turns.js`, `calls.js`, `projection.ts`) | High |
| §3.2 S5 | Subagent view | `pi-pocket/web/subagents-board.js`, `session-tree.js` | Medium |
| §3.3 | WebView as untrusted client | `pi-phone/MainActivity.java`; `NJS98-UI/haiou/MainActivity.kt:1535-1543` (**origin policy**: only the engine's origin stays in the WebView, everything else → system browser) | High |
| §3.4 | Paged loading | `pi-pocket/src/server/transcripts.ts` | Medium |
| §3.7 | Recovery sheet (Resume / Retry / Discard) | — (main-only `retryTask`) | **Gap** |
| §3.8 | Reconnect = resnapshot | `pi-phone/src/server/http/events.ts` (cut off → reconnect → full view) | High |
| §4.1 R1 | Extension hot-reload | `pi-phone/src/server/reload.ts` (**native `import()` — no jiti/esbuild needed**) | **High** |
| §4.1 R1 | **Install gate** | — | **Gap** (§6.2) |
| §4.1 R2 | Web UI reload | `pi-pocket/src/server/http/assets.ts:277` — *"The app is edited live, so the browser asks each time whether its copy is still the newest (`no-cache`)"* | **High — replaces Vite** |
| §4.1 R3 | Runtime update without an APK | `picassio/pi-phone/Updater.java` + `PiService.swapInPending` | High |
| §4.3 | Restart as a normal event | `pi-phone/src/server/app.ts:961` (`harness.resume()`) | High |
| §4.4 | Agent edits the app that hosts it | `picassio/pi-phone/HANDOVER.md` — the repo is developed **from inside the app**; CI builds and releases; the app updates itself. **This loop already closes.** | High |
| §5 R1 | Runtime viability | `picassio/pi-phone` (bionic, proven) / `heikeyangle-code/pi-android` (proot, `PROOT_LOADER`) | High |
| §5 R3 | Survive OEM kills | `NJS98-UI/haiou/WatchdogV2.kt` (3-signal probe, circuit breaker, durable repair state) + `restartLimit: Infinity` | High |
| §5 R6 | FGS policy | `heikeyangle-code/pi-android/app/src/main/AndroidManifest.xml` (`foregroundServiceType="dataSync|specialUse"` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`) — **not needed at targetSdk 28** | High |
| §5 R7 | Pi Durable is experimental | `heikeyangle-code/pi-android/tools/pi-contract.mjs` (CI contract gate against a pinned version) | **High — adopt** |
| §5 R9 | IPC is a failure surface | `pht88888888/DSHAPP/CrashRecorder.kt` + `MainActivity.kt:428-530` | High |
| §5 R10 | Self-build loop is trusted code | `pht88888888/DSHAPP/RescueBoot.kt` (5 tiers) — **shape only**; its trigger model is wrong for us (§6.3) | Medium |
| §5 R12 | A dev server on the phone | **drop** — use the no-build-step frontend + reload (§8.2) | High |
| — | Self-update of the runtime | `picassio/pi-phone/Updater.java` (manifest + sha256 + `PackageInstaller`) | High |

---

## 6. Gap analysis — what we must build ourselves

### 6.1 The replay policy (§2.2) — a *declaration discipline*, not a library

All three projects use `replay: "safe" | "unsafe"`; none implements the
plan's rule. The rule itself lives in Pi Durable
(`src/harness/tool.ts:185`): *a tool reruns only when both its stored policy
and its current declaration say `safe`*.

What we must write:

1. **A policy table** — one row per tool: `safe` ⟺ (a) no side effect outside
   durable state the tool writes itself, **and** (b) repeating the call with
   the same arguments produces the same end state, **and** (c) the arguments
   fully determine the effect.
2. **The shipped coding tools are unsafe by default.** `read`, `write`,
   `edit`, `bash` declare no `replay`. The plan's §2.4 wants `read` upgraded
   to `safe` via a later extension that re-declares it (`createReadTool()` with
   no image processor) — worth doing, because on a phone a process death
   mid-`read` is *routine*, and every unsafe `read` becomes an
   `interrupted` diagnostic the user has to read.
3. **Idempotency keys.** `todos.create` generates a random id; a rerun creates
   a second todo. `todos.append` appends twice. Neither is `safe` without a
   caller-supplied id and a memoized `created_at`. This is not a Pi Durable
   concern — it is *our* extension's concern, and it is the same work pi-pocket
   does for its scheduled messages (`schedules.ts:149`, `requestId`).
4. **A fixture suite**, because the rule is untestable by inspection:
   `echo` (safe), `sleep` (safe), `sleep-then-throw` (unsafe) — the plan's
   Milestone 0 fixtures (M0.3/M0.4) are exactly right and should be built
   first.

**Do not** port pi-pocket's `replay:` declarations wholesale: they were
chosen for *pi-pocket's* tools (sessions, browser, web, schedules), not for
ours, and a wrong `safe` is a correctness bug, not a style bug.

### 6.2 The self-building loop: the install gate

`reload.ts` gives us the hard half for free — native `import()` with a
cache-bust, a 30 s load deadline, a generation counter, and
`registry.install()` replacing in place. What it does **not** give us is the
*gate*: it installs a drop-in the moment the file changes.

We must add, in the plan's §2.8 terms:

- the agent writes `workspace/extensions/foo.ts`;
- the kernel computes a **hash** and a **diff** of the file;
- the UI shows both and asks;
- the user taps **Install**;
- only then `registry.install()` runs.

pi-pocket already has the UI machinery for exactly this shape — its
**approval cards** (the README's "approval card with Deny and Allow" screenshot)
and its `approvals` service — so the *presentation* is reusable even though the
*policy* is ours.

Three more requirements the plan states and pi-phone does not:

- **On every `Harness.open`, re-install the approved extensions before
  `harness.resume()`**, so a kernel restart does not leave their tasks
  `missing_task`. pi-phone's loader runs at server start (`app.ts:883`
  `await this.loader.loadAll()`), so the hook exists.
- **A trusted-session mode** (pre-authorised key/hash) so a long build does
  not prompt on every iteration. Default off.
- **A quarantine path** for an extension that installs and then breaks the
  kernel — see §6.3.

### 6.3 A degradation ladder for the *runtime* failure mode

DSHAPP's ladder (§3.6) is a fine architecture with the wrong trigger. Our
failure is not "the app will not boot" — it is "the agent installed an
extension and the kernel died". So we need:

| Our tier | Trigger | Action |
|---|---|---|
| **T0 normal** | — | — |
| **T1 suspect** | a kernel exit whose log names an extension entrypoint, or a restart counter increment | disable that one extension; restart; resume |
| **T2 quarantined** | T1 did not restore a healthy kernel | disable **all** agent-written extensions; keep the built-in ones; restart; resume |
| **T3 clean** | T2 failed, or the user asked | boot with **no** agent-written extensions and a minimal extension set; surface the log and a "re-enable" button |

The mechanics to borrow: a **separate profile/directory** for the degraded
set (DSHAPP's `ensureRescueProfile`), a **hardcoded safe list** rather than a
read of the (possibly broken) user list, a **durable** tier + reason file
(`rescue/state.json` shape), and **budgeted** actions (DSHAPP's
`MAX_ACTIONS_PER_DAY = 4`).

The two DSHAPP findings to design *against*:

- a `.stamp`/version short-circuit makes a corrupted payload **permanent** —
  so our installer must verify content hashes, not just a version marker;
- the ladder must be reachable from a **runtime** failure, not only from
  startup — i.e. the trigger must be "the kernel exited", not "the kernel
  failed to start".

And one mechanism to add that DSHAPP only gestures at: **verify an extension
in a throwaway kernel instance before admitting it.** DSHAPP's `try-boot`
mailbox action is the primitive; we would run a *second* kernel process
against a scratch copy of the registry, load the candidate, confirm it loads
and registers, then install it for real. That is the cheapest real answer to
"an agent-written extension could brick the app" (the plan's §4 risk).

### 6.4 Security boundaries (§2.8)

Mostly reusable; three gaps.

**Reusable:** `pi-pocket/src/server/secrets.ts` implements the plan's
requirement precisely — a secret's *name* is an env var name, the *value* is
never given to the model, a `bash` command naming `$NAME` runs with it in its
environment, and any output containing a value is replaced with
`[secret NAME]` (streamed bash output, every tool result via an `afterTool`
hook, and the user's own message). That is §2.8's "secrets never live in the
kernel environment" done correctly.

**Gap 1 — the runtime update channel is unsigned.** `pi-phone/Updater.java:99`
verifies the payload's SHA-256 against a `manifest.json` fetched over HTTPS
from GitHub Releases. A compromised mirror can authorise a hostile payload.
DSHAPP's `RuntimeUpdater` has the same hole, explicitly. We should sign the
manifest (minisign/ed25519) with a key pinned in the APK.

**Gap 2 — the runtime tree is a `bash` target.** The agent's shell shares the
uid with the runtime; `rm -rf $PREFIX` destroys the app's ability to start.
DSHAPP hits the same wall and answers with `storages`/`sessions` renamed to
`<name>-stale-<ts>` (never deleted). Our equivalent: keep the runtime under a
versioned directory and keep the *active* runtime pointer in a small file, so
"reinstall the runtime" is a pointer swap, and a hostile `rm -rf` costs a
re-download rather than the app.

**Gap 3 — the bridge surface.** The plan's §2.6 says the native bridge is
microphone, file picker, share intents and notifications, nothing else. The
reference implementations are wider: pi-phone's `PiPhoneApp` exposes
`runUnrestricted()`, `download()`, `openNotificationSettings()`;
`haiou`'s `androidBridge` exposes file picking and All-Files-Access. Adopt
haiou's **origin policy** (`MainActivity.kt:1535-1543`): only the engine's own
scheme+host+port may stay in the WebView; everything else is handed to the
system browser, so a hostile page cannot reach the privileged bridge.

### 6.5 Packaging and reproducibility gaps

- **The `applicationId` must be exactly 10 characters.** This is a hard
  constraint inherited from pi-phone's prefix rewrite and it is easy to trip
  over. `package-rootfs.ts:98-100`:

  ```ts
  if (TERMUX.length !== APP.length) {
      throw new Error("the app prefix must be as long as the Termux prefix");
  }
  ```

  `/data/data/com.termux` and `/data/data/io.piphone` are both 21 characters,
  so the package id must be exactly 10 (`com.termux`, `io.piphone`). The
  rewrite is an **in-place byte patch** of the prefix inside every ELF, so the
  lengths *must* match or the binaries' baked paths break. pi-termux-mobile's
  `org.pimobile.app` (15) is incompatible with this scheme — which is exactly
  why it does not rewrite the prefix and instead ships the residue
  (`OPENSSL_CONF`/`SSL_CERT_FILE` workarounds) and tells users to invoke
  binaries by absolute path. **Pick the applicationId before writing any
  build code.** (Alternatives if 10 characters is too tight: recompile
  `termux-exec` with our own prefix — Apache-2.0, but a build to maintain;
  or drop the rewrite and accept the shebang breakage.)

- **The Termux package set is not version-pinned.** `package-rootfs.ts`
  resolves `nodejs`, `npm`, `bash`, `git`, `gh`, `python`, `vim`… from the
  *current* aarch64 index at build time. Two builds a month apart ship
  different Node versions. The CI workflow mitigates this by *reusing* the
  previous release's `rootfs.bin` when `package-rootfs.ts` is unchanged — which
  means the rootfs only ever changes when the *script* changes. That is a
  reasonable policy but it is implicit; make it explicit and write the
  resolved package versions into `termux-packages.json` (pi-phone already
  ships that file) and assert on it.
- **The rootfs version is the hash of the script, not of the contents**
  (`versions.ts:34-36`: `sha256(readFileSync("scripts/package-rootfs.ts"))`).
  Two different resolves of the same script produce the same "version" — so
  the updater would skip a genuine rootfs change. Hash the *package manifest*
  instead.
- **pi-android's `runtime.lock.json` is the model to copy**: every artifact
  pinned by URL + SHA-256 with a `"why"` field, and the build **fails** if a
  hash changes.

---

## 7. Revised MVP roadmap

Three steps, targeting a working prototype on a phone in 10 working days.
The plan's original Phase 0 (nine spikes, 2-3 weeks) is largely **obsolete**:
the runtime question is answered by existing code, and the SQLite, event
protocol, extension loader and supervisor questions are all answered by
existing code too.

> **Step 0 (½ day) — settle the one open decision.**
> Build **two** APKs from one source tree: `targetSdk 28` (default) and
> `targetSdk 36` (`-Ppi.targetSdk=36`, the `heikeyangle-code/pi-android`
> pattern). Install both on the target phone; run one Node process from a
> Termux prefix under 28. This costs half a day and permanently settles §1.3,
> §1.10 and §5 R6 — the plan's three largest risks. If the 36 variant is
> built, remember: `useLegacyPackaging = true` **and**
> `android:extractNativeLibs="true"`, and a **static** proot.
>
> **Step 1 (4 days) — the durable kernel, no UI.**
> Start from **`badlogic/pi-termux-mobile/runtime/server.mjs`** (587 lines)
> rather than pi-pocket's 100+ modules: it is already a minimal Pi Durable
> bridge with `Harness.open` + `openNodeSqliteStorage` + `resume()`, the
> `envFor` seam, the owned-child subagent recipe, SSE, and a credential
> store. Port `@earendil-works/*` from `1.0.2` to `main@fdce48e` and fix what
> breaks — this is the bulk of the work, and the work that has to happen on
> any path. Then add the plan's §1.9 on top: `subscribeCommits` as the source
> of truth (replacing `watchEvents`), a `seq` watermark, a scoped snapshot per
> conversation, and a bounded per-connection queue that overflows into a
> resnapshot. Add `settings: { restartLimit: Infinity }`, `onWake`, and the
> three replay fixtures (`echo`/`sleep`/`sleep-then-throw`). Serve SSE on
> `127.0.0.1:<port>` with a per-launch bearer token.
> *Fallback if the 1.0.2 → `main` port proves larger than expected: fork
> pi-pocket instead and cut it down — the API is richer, so the `web/` in
> Step 3 comes free.*
> **Exit criterion:** `curl` the SSE stream; submit an input; see a committed
> `pi.user` entry and a committed `pi.assistant` entry; `kill -9` the kernel;
> restart; see the pending task resume and the interrupted tool call report
> `interrupted` rather than rerunning (plan M0.2/M0.3/M0.4).
>
> **Step 2 (3 days) — the Android shell.**
> Port `PiService.java`, `RuntimeInstaller.java`, `Updater.java` and
> `MainActivity.java` to Kotlin. Copy `scripts/package-rootfs.ts` and
> `package-runtime.ts` **verbatim** first — they are the hard-won part. Add
> `onRenderProcessGone` (DSHAPP's pattern). Build the APK, sideload, and
> watch the kernel come up.
> **Exit criterion:** the app starts, the runtime extracts, the server
> answers, the WebView loads the transcript, and `adb shell am force-stop`
> followed by a relaunch restores the session from SQLite.
>
> **Step 3 (2-3 days) — the UI and the self-building loop.**
> Bring in pi-pocket's `web/` (Preact+htm, no build step). Wire the three
> composer modes to the `steer`/`followUp`/`interrupt` commands. Add the
> reload-with-no-cache mechanism (already in pi-pocket's `assets.ts:277`) so
> editing `web/*.js` and reloading the page is the iteration loop. Add the
> extension install gate: hash + diff + user confirmation before
> `registry.install()`. Add the three-tier extension quarantine (§6.3).
> **Exit criterion:** the agent writes an extension into
> `workspace/extensions/`, the app shows its diff, the user approves, and the
> **next** tool call uses the new code — without restarting the app. Then
> deliberately write a *broken* extension and watch the quarantine tier catch
> it.

**Timeline:** ½ + 4 + 3 + 2-3 = **10-11 working days** to a phone with a
durable kernel, a working transcript, and a hot-reloading agent-written
extension.

**What this drops from the plan, deliberately:** the Vite dev server on the
phone (R12/S0.6), the on-device Gradle build (R13/S0.7), the
`android.database.sqlite` facade (R2/S0.2, which only mattered under the
Hermes fallback), and the custom-bionic-Node optimization. All four are
Phase-5 experiments in the plan; none is needed for an MVP, and three of them
are the plan's largest, least-understood risks.

---

## 8. Two plan changes this review forces

### 8.1 §1.3 — drop proot, adopt the bionic Termux prefix, and stay on targetSdk 28

The plan's §1.3 chose "proot rootfs launched from `nativeLibraryDir` under
`targetSdk 35`". The evidence now points the other way:

| | proot + glibc rootfs | bionic Termux prefix |
|---|---|---|
| Device evidence | `heikeyangle-code/pi-android`: *"Reported working on API 35/36, but not proven on this device yet."* `NJS98-UI/haiou`: **measured failure** on Android 16 — the kernel refuses to exec a non-bionic ELF from app-data *at any targetSdk* (pitfall 84: *"PIE 假设证伪…重编 loader 救不了"*) | `picassio/pi-phone`: **in production** on a Galaxy Z Fold 8 / Android 17, 242 commits, 105 test files, updated yesterday; independently, `AidanPark/openclaw-android` (MIT, 1.8k★) runs a targetSdk-28 Kotlin shell with **no** `foregroundServiceType` at all |
| `node:sqlite` | must be verified under proot | **works** — pi-phone's whole storage layer is `node:sqlite` on a Termux Node |
| `os.networkInterfaces()` | **throws EACCES** — glibc's `getifaddrs` sends `RTM_GETLINK`, which AOSP SELinux denies to every untrusted app (`nlmsg_readpriv`); bionic's skips it for apps | **works** — bionic build |
| Cost | `nativeLibraryDir` + `useLegacyPackaging` + `PROOT_LOADER` + a glibc rootfs + proot's syscall tax | a Termux prefix, rewritten in place |
| APK size | 100 MB+ (pi-android's tree is ~1.19 GB unpacked) | the Termux userland |

**The `getifaddrs` finding is the strongest single argument for the bionic
route**, and it is not folklore: bionic's `getifaddrs()`
(`libc/bionic/ifaddrs.cpp`) sends `RTM_GETLINK` *only* when
`getuid() < FIRST_APPLICATION_UID` — *"SELinux policy only allows RTM_GETLINK
messages to be sent by system apps"* — while glibc's sends it unconditionally
and returns −1 on failure, with no `/proc` fallback. AOSP's
`private/net.te` denies `nlmsg_readpriv` to `untrusted_app_all`, i.e. to
**every** untrusted-app domain on **every** targetSdk. So: **a glibc Node on
Android always throws `ERR_SYSTEM_ERROR` (errno 13) from
`os.networkInterfaces()`; a bionic Node does not.** The discriminator is
bionic-vs-glibc, not targetSdk.

**Recommendation:** make the **targetSdk-28 bionic prefix the v1 target**
(direct `execve`, no linker indirection), with the **`linker64` fallback
implemented from day one** so that raising targetSdk is a manifest change
rather than a re-architecture. Keep the plan's proot route as a
**targetSdk-36 build variant** that CI also produces, and let a device
decide. The cost of targetSdk 28 is that it is
Play-incompatible forever — acceptable for a sideloaded personal tool, which
the plan already accepts (§5 R6, Appendix B #3) — and that
`foregroundServiceType`, `SCHEDULE_EXACT_ALARM` and `POST_NOTIFICATIONS`
behave under legacy rules. Those legacy rules are, in fact, **simpler**:
no FGS type is required, exact alarms need no permission, and the API-31
background-FGS-start restriction does not apply.

The one thing targetSdk 28 does *not* give us is anything about the
`dataSync` 6-hour cap or the `specialUse` Play justification — those are
targetSdk-34+ policies and simply do not apply. **§1.10 and §5 R6 shrink by
half.**

**Three corrections to the plan's §1.3 if the 36-variant is built:**

1. **`android:extractNativeLibs="true"` alone is not enough with AGP 8.**
   `useLegacyPackaging = false` (the default) silently overrides it and the
   `.so` is never written to disk, so the exec fails with `ENOENT`. Both
   settings are required (`packaging { jniLibs { useLegacyPackaging = true } }`).
2. **The proot binary must be statically linked.** A dynamically-linked proot
   has an absolute `PT_INTERP` baked in that must resolve *inside the app's
   data dir* — where exec is banned. `HakaI963/kuro#13` ships **Alpine static
   proot** as `libkuro-proot.so` and explicitly rejects any `PT_INTERP`; it
   also re-validates the ELF and smoke-tests it *from the final path*.
3. **Use Termux's patched proot, not upstream.** Upstream proot lacks
   Termux's netlink emulation and `SIOCGIFINDEX` fixes, which is exactly what
   breaks `os.networkInterfaces()` and DNS inside the rootfs
   (`termux/proot-distro#696`: *"only official Termux proot package will work
   correctly with proot-distro"*).

**But you probably do not need proot at all — and this is a correction to
what this review said earlier.** `badlogic/pi-termux-mobile` implements the
**`linker64` escape hatch**, and so do `NJS98-UI/haiou` and
`YOYOFeelings/DeepSeek-Harness-Android`:

```java
// badlogic/pi-termux-mobile, PiService.java:96-103
try {
    nodeProcess = spawn(cmd, env, home);
} catch (IOException directFailed) {
    // targetSdk >= 29 on Android 10+: exec of app-private files is
    // blocked -> run the ELF through the system dynamic linker.
    cmd.set(0, "/system/bin/linker64");
    cmd.add(1, node);
    nodeProcess = spawn(cmd, env, home);
}
```

`/system/bin/linker64` **is** executable, so it can load an ELF that lives in
the app's data dir. That means **you can raise targetSdk to 34/35/36 and
still exec the Termux binaries in place** — no proot, no `nativeLibraryDir`,
no static-build requirement, and the binaries stay **bionic** (so the
`getifaddrs` problem never appears). The Termux maintainer's own analysis
(`ANALYSE.md` §4) states it as the recommended path for a Play-viable build:

> targetSdk ≥ 29 (Pflicht für Play): Binaries **über den system_linker_exec-
> Trick starten**: `ProcessBuilder("/system/bin/linker64",
> "/data/data/<pkg>/files/usr/bin/node", …)`. Genau das macht `termux-exec`
> intern; für einzelne bekannte Binaries reicht der direkte Linker-Aufruf
> ohne LD_PRELOAD.

**The three costs of the linker64 path**, all documented in the field:

1. **It must cover every child process, not just `node`.** This is the flaw
   in `badlogic/pi-termux-mobile`'s implementation: the fallback is applied
   only to the `node` argv (`PiService.java:96-103`), so at targetSdk ≥ 29
   every child `node` spawns — `bash`, `git`, `rg` — is still a raw
   `execve()` of an app-private ELF and is still SELinux-blocked. Its README
   claim that *"targetSdk can be raised"* is therefore wrong as written. The
   fix is pi-phone's: ship `usr/lib/libtermux-exec-ld-preload.so` and set
   `LD_PRELOAD` (`PiService.java:186`), so `termux-exec` rewrites *every*
   exec through the system linker. pi-phone's `package-rootfs.ts:95` even
   lists that file in `REQUIRED` — a missing preload means every child exec
   fails, and pi-phone fails loudly rather than starting degraded.
2. It **pollutes `process.execPath`** inside Node (it points at `ld.so`, not
   the binary). haiou had to patch its loader to use `TERMUX__PREFIX/bin/node`
   instead of `process.execPath`, because the pollution broke its marketplace
   installer.
3. `termux-exec` must be **recompiled with our own prefix**, or its
   `/bin|/usr/bin` shebang rewriting is not enough — it does not rewrite
   `com.termux` paths (`ANALYSE.md` §4, open point 4). pi-phone's
   **equal-length prefix rewrite** sidesteps this entirely, and is the better
   answer — at the cost of the 10-character `applicationId` (§6.5).

**Revised recommendation.** Make the **targetSdk-28 bionic prefix the v1
target** (direct `execve`, no linker indirection, no `process.execPath`
pollution, no FGS type, full BOOT_COMPLETED exemption), and implement the
**`linker64` fallback** in the same `ProcessBuilder` call so that raising
targetSdk later is a **one-line manifest change**, not a re-architecture.
That is strictly better than the proot route the plan currently specifies,
and it is what the Termux maintainer himself recommends.

**A fourth option the brief did not mention, worth knowing:**
`AidanPark/openclaw-android` runs an **official glibc Node on Android with
no proot and no rootfs at all**, by installing only the glibc dynamic
linker and exec'ing `ld.so --library-path … node.real`. Its own README: *"The
standard approach to running OpenClaw on Android requires installing
proot-distro with Linux, adding 700MB-1GB of overhead… This project
eliminates this by installing just the glibc dynamic linker (ld.so)"* —
~200 MB instead of 700 MB–1 GB, and a measured **~5–9× faster** for agent
workloads. It keeps targetSdk 28, so it dodges the exec ban, and it is
Kotlin — closer to our plan than any other project here. It carries the
glibc-Node caveats above (`os.networkInterfaces()` EACCES, `os.cpus()` broken
by SELinux on `/proc/stat`, `patchelf` segfaults on Android, `process.execPath`
points at `ld.so`). It is a **Phase-5 candidate**, not an MVP one, but it is
the most promising route to an official glibc Node later.

**A licensing note on `proroot`:** `heikeyangle-code/pi-android` supports it,
but proroot is **closed source** — Termux closed the request explicitly
(*"Closing since proroot is not opensource, so it can not be used in termux"*,
`termux/termux-app#5245`). Any use of it needs a licence review.

### 8.2 §4.2 R2 / §5 R12 — drop Vite on the phone; use reload-with-no-cache

The plan wants a Vite dev server inside the kernel so the WebView gets HMR.
The two working implementations in this ecosystem use the opposite approach:
**Preact + htm as plain ES modules with no build step**, served with caching
disabled so that *a reload always gets the newest files* (pi-pocket
`http/assets.ts:277`).

That already delivers the property the plan wants — *the agent edits the UI
source and the change is live without an APK reinstall* — without a bundler
on the phone. What it costs is component-level HMR (you get a full page
reload) and the loss of TypeScript in the UI. What it saves is **S0.6/R12
entirely**: no esbuild under proot (whose `execve` interception is a known weak
spot), no dev-server memory competing with the agent, no
`uv_interface_addresses` question at all, and one fewer unknown in a plan
whose spikes are its critical path.

If HMR is later judged necessary, add it as a Phase-5 experiment *on top of*
this baseline, not as an MVP dependency.

**One correction to this section, in the other direction.** The Termux
maintainer's `ANALYSE.md` §4 says Vite on the phone is *not* blocked:

> `http://localhost`/`127.0.0.1` gilt als secure context (Clipboard-API,
> crypto.subtle ok); WS auf localhost ok; **Vite-HMR über ws://localhost ok**,
> solange die Seite selbst via http (kein mixed content) …

So the plan's R2 is feasible, and the `uv_interface_addresses` question does
not apply to a loopback-bound dev server (§9.2: `resolveHostname()` uses
`dns.lookup`, and `os.networkInterfaces()` is only reached for a wildcard or
explicit non-loopback host). The recommendation to **not** run Vite in v1
therefore stands on *cost*, not on impossibility: the no-build-step frontend
plus a reload is simpler, cheaper on memory, and already implemented in
pi-pocket. HMR is a Phase-5 convenience, not a blocker.

---

## 9. Research appendix

### 9.1 Repository inventory

| Repo | License | HEAD | Notes |
|---|---|---|---|
| `picassio/pi-phone` | MIT (+ MIT for pi-pocket) | `2a30a21`, 2026-10-21 | `UPSTREAM.md` names both upstreams and their pinned commits |
| `TannerMidd/pi-pocket` | MIT | `d2a3280`, 2026-10-20 | v0.19.0 |
| `heikeyangle-code/pi-android` | — | — | 263 `.kt`; `docs/agent-runtime-comparison.md` is a source-level comparison of four agent runtimes |
| `NJS98-UI/haiou` | — | — | `AGENTS.md` is 332 KB / 92 numbered pitfalls — the single best device-facts corpus in this ecosystem |
| `YOYOFeelings/DeepSeek-Harness-Android` | — | — | ships **no runtime**; `ensureExtracted` is a skeleton that would report OK without extracting |
| `pht88888888/DSHAPP` | MIT | 2026-10-21 | 215 commits, 40.6k LoC, **no JVM unit tests**, CI does not build the APK |
| `petrroll/pocket-pi` | — | 2026-05-14 | prototype; `applicationId = "com.termux"` hack |
| `imtaqin/andropi` | — | — | the **precedent** for the plan's §1.3 `nativeLibraryDir` mechanism: Termux binaries (incl. proot) repackaged as `lib*.so` in jniLibs by `tool/bundle_runtime.py`; plus a long write-up of what fought back |
| `AidanPark/openclaw-android` | MIT | 2026-10 | **the closest analogue to our targetSdk-28 plan**: Kotlin, `targetSdk 28`, **no** `foregroundServiceType`, an **official glibc Node** run via `ld.so` with **no proot and no rootfs** (~200 MB, ~5–9× faster); the best Phase-5 candidate |
| `HakaI963/kuro` | — | 2026-10 | documents the `nativeLibraryDir` + **static** proot pattern, incl. the `useLegacyPackaging` trap and "any `PT_INTERP` rejects" |
| `MaliNamNam/pi-phone` | — | — | the remote UI the plan is replacing — **not** `picassio/pi-phone` |

### 9.2 Storage, tooling and platform policy — the four questions asked

**Q: Does our proot Node environment need `better-sqlite3-termux`, or does
`node:sqlite` work?**

**`node:sqlite` works. Do not add `better-sqlite3`.**

- `node:sqlite` (`DatabaseSync`, `StatementSync`, `Session`, `backup`) is
  **unflagged** in Node ≥ **22.13.0 / 23.4.0** — the Node docs' own history
  line reads *"SQLite is no longer behind `--experimental-sqlite` but still
  experimental"*, and the change PR is *"allows the `node:sqlite` module to
  be used without starting Node with a CLI flag"*. Verified locally on Node
  **v24.22.0**: `require('node:sqlite')` succeeds with no flag and no
  warning. **The folklore that it "needs a flag on Node 24" is wrong.** What
  *is* true: on Node 22 it is labelled *experimental* (stability 1.1); on
  Node 24+ it is *release candidate* (1.2), not stable. Our floor of 22.19
  is above 22.13, so no flag — and it is exactly `@earendil-works/chord`'s
  own floor (`engines.node >= 22.19.0`).
- **Structurally, `node:sqlite` is not a native addon.** Node's `node.gyp`
  builds it into the binary (`node_use_sqlite=true`,
  `node_sqlite_sources`, `HAVE_SQLITE=1`) — there is no `dlopen()` of a
  shared object, so **the bionic-vs-glibc ABI trap that kills
  `better-sqlite3` does not apply to it**.
- The plan's §1.3 sub-question ("*a Node 24/25 build should have it, but
  'should' is not a measurement*") is therefore answered, on the desktop
  build, and on Android by three independent projects:
  - `picassio/pi-phone` runs its **entire** storage layer on `node:sqlite`
    (`src/server/app.ts:885`) in a Termux Node on a Galaxy Z Fold 8;
  - `NJS98-UI/haiou` ships **no** SQLite addon of its own and notes that
    Termux's `node` links `libsqlite` 3.53.4, i.e. the built-in module is
    present;
  - `pht88888888/DSHAPP` lists `libsqlite3.so` among node's `DT_NEEDED`
    libraries and builds no SQLite addon.
- `@boruto_vk7/better-sqlite3-termux` is **not the answer, and not for the
  reason usually given.** It exists (npm 1.0.14, 2026-07-25) but it ships
  **no prebuilt `.node` binaries at all** — its `postinstall` *compiles*
  better-sqlite3 from source into `~/.sqlite3_engines/<projectId>/` at
  install time, installing `clang make python pkg-config libsqlite` on
  Termux on demand. So the "prebuilt bionic binary cannot load in a glibc
  rootfs" objection is the wrong objection: the real problem is that a
  source build in the wrong rootfs produces the wrong ABI, and in any case
  `node:sqlite` already provides the feature with **zero** native
  dependencies.
- **If we ever do want `better-sqlite3` inside a glibc rootfs** (it is not
  needed for this plan): use **`better-sqlite3@12.x`**, which ships glibc
  `linux-arm64` prebuilts for Node ABI 127 (Node 22) and 137 (Node 24) via
  `prebuild-install`. **Do not use v13** — its published `package.json` has
  no `install` script and the v13.0.3 release has **zero assets**, so v13
  always compiles from source. A known-good source build needs
  `python3 make g++` in the rootfs, and Termux-native builds are documented
  as broken (`WiseLibs/better-sqlite3#1330`).
- The general lesson, stated bluntly by `haiou`: native addons on Android are
  a swamp. It had to ship a **pure-JS replacement** for
  `@deepseek-ai/node-addon-system` (the `flock` binding) and a shim for
  `node-addon-require-builtin`, because no prebuilt Android addon existed.
  `pi-phone` goes further and prunes `better-sqlite3` from its `node_modules`
  at build time (`Dockerfile:25`).
- **WAL on Android — the requirement is documented, the outcome is inferred.**
  SQLite's WAL needs a **mmappable shared-memory file** (the `-shm`
  wal-index) plus POSIX advisory locks (`fcntl F_SETLK`). ext4 and f2fs —
  Android's internal-storage filesystems — satisfy both, so **WAL should
  work on Android internal storage**. The *consequence* is a design rule:
  **keep the database in `filesDir`/`noBackupFilesDir`, never on shared or
  external storage**, which is FUSE-backed and commonly lacks the VFS
  shared-memory methods (`xShmMap`) that WAL needs. With
  `synchronous=NORMAL`, WAL is consistent but may lose the last
  transactions on a power cut — exactly the exposure the plan's §1.7
  already accepts.
- **Two residual risks to carry into the spike:** `node:sqlite` in WAL mode
  must still be *measured* on the device; and if we ever fall back to a
  **proot** rootfs, `node:sqlite`'s use of `fcntl` locks and `mmap` has to
  be re-verified *under proot's syscall translation*. Under the recommended
  bionic-prefix route, none of that applies. There is **no report** of
  `node:sqlite` failing under proot or on Android, and the structural
  argument (compiled-in, no `dlopen`, no `preadv2`, no io_uring, no `/proc`
  reads in the DB path) is strong — but it is inference, not measurement.

**Q: Is running a Vite dev server inside the kernel viable? What about the
`uv_interface_addresses` crash?**

**The mechanism is real, the folklore about it is wrong in three places, and
we no longer need to care — because the recommendation is not to run Vite at
all (§8.2).**

- **What actually happens:** it is **not** a native crash or abort and **not**
  an infinite loop. `os.networkInterfaces()` throws a JS `SystemError`
  (`code: 'ERR_SYSTEM_ERROR'`) with the message `uv_interface_addresses
  returned Unknown system error 13` (errno 13 = EACCES). Uncaught, the
  process dies. The one true segfault in this area
  (`nodejs/node#4272`, `uv_interface_addresses` returning `UV_ENOSYS`) was
  observed with **uClibc**, not Android.
- **What causes it (verified from AOSP, not folklore):** bionic's
  `getifaddrs()` sends `RTM_GETLINK` only when `getuid() < FIRST_APPLICATION_UID`
  — *"SELinux policy only allows RTM_GETLINK messages to be sent by system
  apps"* — while glibc's sends it unconditionally and returns −1 on failure
  with no `/proc` fallback. AOSP's `private/net.te` denies `nlmsg_readpriv`
  to `untrusted_app_all`, i.e. to **every** untrusted-app domain on every
  targetSdk. ⇒ **the discriminator is bionic vs glibc, not targetSdk.**
- **Does binding to 127.0.0.1 avoid it? Yes — and so does the default.**
  Vite's `resolveHostname()` uses `dns.lookup`, *not*
  `os.networkInterfaces()`. The `os.networkInterfaces()` call lives in
  `resolveServerUrls()` (the banner printer) and is reached **only** for a
  wildcard/undefined host or an explicit non-loopback host. So
  `vite --host 127.0.0.1` (and the default) never calls it. The folklore
  that "Vite's `server.host` resolution calls `os.networkInterfaces()`" is
  **wrong**; the folklore that `dns.setDefaultResultOrder('verbatim')` fixes
  it is **also wrong** (unrelated code path).
- **It is not fixable upstream** — it is an intentional AOSP platform
  restriction. What *was* fixed is a different bug: a cross-built Node with
  `HAVE_IFADDRS_H` undefined hit libuv's fallback and returned `UV_ENOSYS`
  (fixed in libuv 1.44.1). A bionic Termux Node is fine.
- **The real reports:** `termux/termux-packages#10868` (open since 2022 —
  and note its own conclusion, *"the Android Termux App has targetSDK 28,
  that's why the `os.networkInterfaces()` call works"*, which is a
  **bionic**-vs-**glibc** observation wearing a targetSdk hat);
  `termux/proot-distro#696` (2026 — the cause was the **Debian** `proot`
  package; the maintainer's answer: *"only official Termux proot package will
  work correctly with proot-distro"*, because Termux's build carries netlink
  emulation);
  `can1357/oh-my-pi#16127` (Android 15 / Bun 1.4.2, errno 13; fix = try/catch).
- **`vite-capacitor` is a dead end.** npm latest 0.0.5, repo
  `YanChenBai/vite-capacitor` — created 2026-01-19, last commit 2026-01-20,
  **1 star, 0 forks, no license**. It does *not* touch `server.host` (so it
  does not bind 0.0.0.0 — the 0.0.0.0 binding comes from running bare
  `vite --host`), and it calls `os.networkInterfaces()` **unguarded**, so it
  would throw the same EACCES.
- **The bundler cost is real anyway:** Vite 7+ uses native Rollup bindings —
  on Termux the right package is `@rollup/rollup-android-arm64`, which Vite
  does not install automatically ([vitejs/vite#20766]) — and rolldown's
  `@rolldown/binding-android-arm64` has crashed with *"Illegal Instruction"*
  on a Snapdragon 680 under Termux ([vitejs/vite#22726]). Inside a **glibc**
  rootfs, `process.platform === 'linux'` resolves the glibc binding, which
  loads correctly.
- **We avoid the question entirely.** pi-pocket's frontend is Preact + htm as
  plain ES modules with **no build step**, served with caching disabled
  (`http/assets.ts:277`: *"The app is edited live, so the browser asks each
  time whether its copy is still the newest (`no-cache`)"*). Editing
  `web/*.js` and reloading the page is already the iteration loop — no
  bundler, no esbuild-under-proot, no dev-server memory competing with the
  agent, and no `uv_interface_addresses` in the picture.

**Q: What does the current Android foreground-service policy say (for a
sideloaded personal tool)?**

Verified against developer.android.com:

- **`foregroundServiceType` is required only for apps targeting Android 14
  (API 34)+.** *"If your app targets Android 14, it must specify appropriate
  foreground service types… the system will raise
  `MissingForegroundServiceTypeException`."* ⇒ **a targetSdk 28 app needs
  none at all** — no type attribute, no `FOREGROUND_SERVICE_*` permission, no
  `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`. Confirmed in the wild by
  `AidanPark/openclaw-android`, which declares a service with **no**
  `android:foregroundServiceType` and only `FOREGROUND_SERVICE`,
  `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK` and
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
- **`dataSync` is a hard 6-hours-per-24-hours cap** on Android 15+, shared
  across the app's dataSync FGS; when the budget is exhausted, starting
  another throws `ForegroundServiceStartNotAllowedException`. A 24/7 agent
  kernel on `dataSync` would be killed ~4× per day. **`specialUse` has no
  timeout, no cap and no runtime prerequisites** — it is the right type if
  we ever ship at targetSdk ≥ 34.
- **BOOT_COMPLETED can still start a foreground service on API 31+** — it is
  an explicit exemption. On Android 15+ (targeting 35+), a BOOT_COMPLETED
  receiver may **not** start `dataSync`, `camera`, `mediaPlayback`,
  `phoneCall`, `mediaProjection` or `microphone` FGS; **`specialUse` is not
  on that list**, so a `specialUse` kernel can still boot with the phone.
- **The folklore that "apps that were already running" are exempt is wrong.**
  The exemption is *"your app transitions from a user-visible state, such as
  an activity."* Being alive in the background is not an exemption.
- At targetSdk 28 none of the API 34/35 type rules bind, and the full
  BOOT_COMPLETED exemption is retained.

**Q: How does the AndroPI write-up handle repackaging Termux packages into
jniLibs, and targetSdk constraints for `execve`?**

It is **the precedent for the plan's §1.3 mechanism**, and it validates the
`nativeLibraryDir` trick as a real, shipped pattern rather than an invention:

- AndroPI's runtime bundler pulls **node, git, ssh, rsync, curl and proot**
  from the Termux repository and **repackages them as jniLibs** via
  `tool/bundle_runtime.py`; the write-up shows the mapping from each
  package's binary (`bin/proot`) to a `lib*.so` name inside the APK
  ([dev.to/abdulm](https://dev.to/abdulm/i-put-an-ai-coding-agent-inside-an-android-app-heres-everything-that-fought-back-lpk)).
  The rationale is the Termux wiki's: on Android 10+, executable code must
  ship inside the APK, so Termux's own `.deb`s are converted to APK form by
  placing them in the JNI lib directory.
- `heikeyangle-code/pi-android` does the same thing with a pinned
  `proot` + `libtalloc` + `libandroidShmem` closure in `runtime.lock.json`,
  and launches via `PROOT_LOADER` from `nativeLibraryDir`.
- **What neither source states is a `targetSdk` value for AndroPI**, so the
  execve constraint there is inferred from the surrounding projects rather
  than declared. Our own conclusion stands unchanged: the `nativeLibraryDir`
  route is *precedented* (AndroPI, pi-android) but *not proven on Android 16*
  (haiou's measurement), which is exactly why §8.1 makes it the **36-variant**
  and puts the proven bionic path on 28.

### 9.3 Claims that are folklore, not fact

- **"`pi-phone` is a React Native app"** — false; native Java + plain-JS Preact.
- **"targetSdk 28 is a sign of a sloppy/old project"** — false; it is the
  *correct* engineering choice for a runtime that lives in `files/`, and two
  independent projects (`pi-phone`, `pocket-pi`) plus Termux itself pin 28 for
  exactly this reason.
- **"`pi-phone` cannot be forked because targetSdk 28"** — false. The APK
  installs and runs on current Android; it is Play-incompatible, which only
  matters if you want to publish.
- **"Pi Durable needs `better-sqlite3` on Android"** — false. `node:sqlite` is
  unflagged in Node ≥ **22.13.0/23.4.0** (verified on Node v24.22.0) and is
  **compiled into the Node binary** (no `dlopen`, so no bionic/glibc ABI
  trap); it is compiled into Termux's Node too (`libsqlite3.so` in its
  `DT_NEEDED`, confirmed by three projects), and pi-phone's entire storage
  layer depends on it.
- **"`@boruto_vk7/better-sqlite3-termux` ships prebuilt bionic `.node`
  binaries"** — false twice over: it ships **no prebuilds at all** (it
  *compiles* from source at `postinstall` into `~/.sqlite3_engines/<id>/`),
  and `node:sqlite` already covers the use case. If `better-sqlite3` is ever
  wanted inside a glibc rootfs, use **12.x** (glibc prebuilts for Node ABI
  127/137) — **v13 dropped prebuilds and always compiles**.
- **"node:sqlite needs `--experimental-sqlite` on Node 24"** — false;
  unflagged since 22.13.0 / 23.4.0.
- **"The `uv_interface_addresses` crash blocks Vite on Android"** — the
  *mechanism* is real (`os.networkInterfaces()` throws
  `ERR_SYSTEM_ERROR`, errno 13 = EACCES) and the *root cause* is now
  verified from AOSP: glibc's `getifaddrs` sends `RTM_GETLINK`, which SELinux
  denies to every untrusted app; bionic's does not. But the Vite-specific
  link is **wrong**: `resolveHostname()` uses `dns.lookup`, and
  `os.networkInterfaces()` is only reached for a wildcard/explicit
  non-loopback host — so `--host 127.0.0.1` (and the default) never calls
  it. We avoid the question by not running Vite at all (§8.2).
- **"The `uv_interface_addresses` crash blocks Vite on Android"** — the
  *mechanism* is real and documented (`os.networkInterfaces()` → EACCES,
  `nodejs/help#4058`; Android 11+ blocks the netlink socket `getifaddrs`
  uses). The *Vite-specific* link is inferred, not confirmed. We avoid the
  question by not running Vite (§8.2).
- **"DSHAPP's Rescue Mode is a four-level ladder with runtime coverage"** —
  both halves false: it is five tiers, and the project's own post-mortem
  documents that the runtime-crash path bypasses every gate.

### 9.4 What the local plan gets wrong (for a follow-up edit)

| Plan location | Problem | Fix |
|---|---|---|
| §0 sources table | cites `MaliNamNam/pi-phone` as "the one most often mis-cited as a runtime" | add `picassio/pi-phone` to §0 and §1.1; they are different projects |
| §1.1 | "pi-phone is not a runtime you can bundle" | wrong for `picassio/pi-phone`; it *is* one, and the best one |
| §1.3 | proot + `targetSdk 35` + `nativeLibraryDir` as the v1 target | demote to the targetSdk-36 variant; make targetSdk-28 bionic the v1 target (§8.1) |
| §1.3 | *"`useLegacyPackaging="true"` (or `android:extractNativeLibs="true"`)"* — written as alternatives | **both are required** with AGP 8; `useLegacyPackaging=false` silently overrides `extractNativeLibs` and the `.so` never lands on disk |
| §1.3 | no mention of the **10-character `applicationId` constraint** | pi-phone's equal-length prefix rewrite hard-asserts it (`package-rootfs.ts:98-100`); pick the package id before writing build code (§6.5) |
| §1.3 | no mention of a *static* proot | a dynamically-linked proot's `PT_INTERP` must resolve inside app-data, where exec is banned; ship **static** proot (or Termux's byte-identical bionic build + `libtalloc`) |
| §1.7 | "the runtime package is Node-only (`node:sqlite`)" — true but stated as an open risk | now answered: `node:sqlite` is unflagged since Node 22.13, compiled into the Node binary, and proven on Android |
| §1.7 | no storage-location rule | **keep the `.sqlite` in `filesDir`/`noBackupFilesDir`**, never on external/FUSE storage (WAL needs an mmappable `-shm`) |
| §1.9 | WS `/v1/events` | SSE works and is already implemented with the right backpressure semantics; keep SSE, add `seq` + an explicit `snapshot` |
| §1.10 | `specialUse` FGS type + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` + `SCHEDULE_EXACT_ALARM` | not required at targetSdk 28; keep them for the 36 variant. `dataSync` is a hard 6 h/24 h cap — never use it for a 24/7 kernel |
| §1.10 | no `onRenderProcessGone` implementation | borrow DSHAPP's: windowed restart counter, backoff, fresh-token reload |
| §4.2 | "The app must add one (`jiti` or `esbuild`)" | **unnecessary** — Node ≥ 22.19 strips types natively; pi-phone imports `.ts` directly |
| §4.2 / §1.9 R2 | Vite dev server on the phone (R12/S0.6) | drop; use reload-with-no-cache (§8.2) |
| §5 R1 | "A Node runtime on Android is the load-bearing unknown" | resolved: two working implementations exist; the question is now 28-vs-36, a half-day experiment |
| §5 R2 | the `android.database.sqlite` facade spike (S0.2) | conditional on the Hermes fallback, which is not the target — deprioritise |
| §5 R11 | "a bearer token in a WS subprotocol (browsers cannot set an Authorization header on a WebSocket)" | still true for SSE: `EventSource` cannot set headers either, so use a one-time ticket in the query string, exactly as pi-pocket does |
| §2.8 | no third-party licence handling for the bundled Termux debs | ship the GPL texts (bash/coreutils GPLv3, git GPLv2) and keep a `third_party/` manifest, as pi-phone does |
| §5 R13 | the phantom-process killer is mentioned once | it SIGKILLs app-forked children beyond ~32 on Android 12+; `openclaw-android` documents the mitigation (`settings put global settings_enable_monitor_phantom_procs false`) |
| §6 Phase 0 | nine spikes, "two to three weeks" | three experiments (§7), two of them half-days |

---

## 10. "What if we forked `badlogic/pi-termux-mobile` instead?"

**Short answer: don't replace pi-phone with it — add it as a third source.
It is the best *kernel* template in the ecosystem and the authoritative
*platform analysis*, but its Android shell is a strict subset of pi-phone's
and its Pi Durable version (1.0.2) is the oldest of the three.**

### 10.1 Why it changes the recommendation

`pi-termux-mobile` is the one project here that runs **Pi Durable on the
phone** and was written by the **Termux maintainer and pi's own author**. It
inverts the "fork pi-pocket and cut it down" instruction of §4.1, because its
kernel is not a product — it is a **587-line bridge** that happens to be
exactly the plan's §1.9 contract:

| Plan § | Needed | `pi-termux-mobile` | `picassio/pi-phone` |
|---|---|---|---|
| §1.6 | `envFor(cwd)` one-line env seam | ✅ `server.mjs:119-135` (local **and** `remote:`) | ✅ but embedded in a 3,000-line `app.ts` |
| §1.7 | `node:sqlite` storage | ✅ `harness.sqlite` | ✅ `pocket.sqlite` |
| §1.8 | `Harness.open` + `resume()` | ✅ `server.mjs:169-192` | ✅ `app.ts:887`, `:961` |
| §1.9 | event stream to a passive client | ✅ SSE `/api/events` + `/pty` WS | ✅ SSE + long-poll, richer |
| §2.5 | **owned-child subagent** | ✅ **the recipe, verbatim** (`server.mjs:69-107`) | partial (`extensions/subagents.ts`) |
| §1.5 C1 | `RemoteExecutionEnv` fallback | ✅ **complete** (`remote-env.mjs` + `env-server.mjs`) | ✅ (`places.ts`, `machines.ts`) |
| §2.8 / R8 | credentials not in the kernel env | ✅ file-backed `auth.json` store | ✅ `secrets.ts` (better) |
| — | **UI** | ⚠️ vanilla-JS chat page (190 lines), xterm terminal, sessions/keys/remote | ✅ **Preact+htm, mobile-first, steer/queue composer** |
| — | **shell** | ⚠️ no prefix rewrite, manual `RUNTIME_VERSION = 38`, no online updates, no JS bridge, no `onRenderProcessGone`, `dataSync` FGS type | ✅ **all of it, hardened** |

The kernel half of the plan is therefore **not** the risky part, and it has
two working precedents of very different size. Writing the §1.9 contract
against `main@fdce48e` on top of `server.mjs`'s skeleton is a *smaller* job
than trimming pi-pocket's 100+ modules across a breaking API bump — provided
we are willing to rewrite pi-pocket's `web/` against our own API, or to keep
pi-pocket's API and keep its server.

**But be honest about what `server.mjs` is: a thin bridge, not a base.** It
has **one global root conversation** (swapped in place by `watchConversation`,
`server.mjs:160-167`), so there is no per-session isolation and no scoped
subscription — precisely the two things the plan's §1.9 and §3.6 need. It
uses `watchEvents` (a coalesced view of one conversation) rather than
`subscribeCommits` (the plan's source of truth). It has **no extension
reload at all** — the one `defineExtension` is compiled into `server.mjs`, and
`node_modules` is pre-bundled with no runtime npm. It selects a model by
silently taking `avail[0]` (`server.mjs:138-149`), which is not a policy. So:
take its **shape** and its **Pi Durable idioms**, write the rest.

### 10.2 The three-way synthesis (the actual recommendation)

| Layer | Fork / copy from | Why |
|---|---|---|
| **Kernel** | `badlogic/pi-termux-mobile/runtime/server.mjs` (587 lines) as the *skeleton*; port to `main@fdce48e`; add the plan's §1.9 `subscribeCommits` + `seq` + scoped snapshots | It is the only minimal, Pi-Durable-native bridge in the ecosystem, and it already contains the §2.5 subagent recipe and the §1.6 env seam |
| **Shell + packaging** | `picassio/pi-phone`'s `android/` + `scripts/package-rootfs.ts` + `scripts/versions.ts` | Strictly harder: equal-length prefix rewrite, SHA-256 version stamps, staging + atomic swap, manifest-based online updates, a JS bridge |
| **UI** | `TannerMidd/pi-pocket`'s `web/` (Preact+htm, no build step) | Mobile-first, has the steer/queue/interrupt composer and a session tree; pi-termux-mobile's chat page is a *minimal* reference, not a product |
| **Platform rules** | `badlogic/pi-termux-mobile/ANALYSE.md` | Written by the Termux maintainer with evidence tiers; it is the source of the exec-path, WebView and packaging rules this review relies on |
| **Remote execution (C1)** | `badlogic/pi-termux-mobile/runtime/remote-env.mjs` + `env-server.mjs` | The plan's §1.5 C1 fallback, *working* — lift it rather than reimplement it |
| **Terminal** | `badlogic/pi-termux-mobile/runtime/public/terminal.js` (xterm.js over WS → `script` PTY) | A good pattern if we want a terminal pane; not needed for the plan's S1–S8 |
| **Extension install** | `picassio/pi-phone/src/server/reload.ts` | Native `import()` loader with a deadline and a generation counter; add our install gate on top |

### 10.3 What forking pi-termux-mobile *instead* would cost

1. **Pi Durable 1.0.2** — the oldest of the three (pi-phone is on 1.3.0; our
   target is `main@fdce48e`). 1.0.2 predates `subscribeCommits` conveniences,
   `onWake`, `restartLimit`, `retryTask` and the schema-v2 migration; the
   jump is larger.
2. **No prefix rewrite** — Termux scripts and shebangs still point at
   `com.termux` and fail (the README says so). pi-phone's equal-length
   rewrite fixes this; `ANALYSE.md` §4's alternative is to *recompile
   termux-exec with our own prefix* (Apache-2.0, but a build to maintain).
3. **No online runtime updates, no atomic install, no JS bridge, no renderer-
   death handling** — all of which the plan needs (§1.10, §4.1 R3) and all
   of which pi-phone has.
4. **14 commits, "Quick & dirty version 0"**, self-described as *"a personal
   prototype … may still change or fail on individual devices"*, one test file
   (`test-remote-client.mjs`), no release tags, no licence file.
5. **A `dataSync` foreground service** — which on Android 15+ carries the hard
   6 h/24 h cap. pi-phone declares no type at all (targetSdk 28).
6. **No LICENSE file, and no third-party notices** for the redistributed
   Termux debs — bash (GPLv3), coreutils (GPLv3), git (GPLv2). Shipping GPL
   binaries inside an APK is "mere aggregation" only if nothing is linked
   against them, and the GPL *text* must still ship. `ANALYSE.md:124-127`
   discusses the licences in prose; nothing is actually shipped. pi-phone
   gets this right (`LICENSE`, `LICENSE-pi-pocket`, `third_party/`).
   **This is a real risk item, not a formality.**
7. **CI produces uninstallable-over-previous APKs** — the workflow signs with
   the *ephemeral CI debug keystore*, so every run has a different key and
   the app cannot be upgraded in place. pi-phone fixed this with a committed
   keystore + GitHub secrets.
8. **No process supervision** — `START_STICKY` restarts the *service*, but if
   `node` dies nothing restarts it and no state is reported. pi-phone runs a
   supervisor loop with exit-code-75 restart semantics.
9. **A 2-day spike, not a codebase** — 14 commits, all on one day, 0 tags,
   0 releases, one manual test script, no CI test job. Three of the commits
   are literally named *"remote glitch"*. The README is honest about it:
   *"a personal prototype … may still change or fail on individual devices"*.

### 10.4 What forking it would *save*

1. **The §1.9 kernel skeleton** — 587 lines instead of pi-pocket's ~12,000
   (server + web). This is the single biggest saving, and it is real.
2. **The §2.5 owned-child subagent, already written** (`server.mjs:69-107`),
   with `replay: 'safe'`, the `scanConversations({ ownerTaskId })` reuse
   check, `ownership: { kind: 'task' }` and the `subagent:${api.taskId}`
   request id. The plan's §2.5 gap closes outright.
3. **Option C1 (remote execution), working** — `remote:<name>:/path` cwd
   syntax, SSH tunnelling, an env-server. The plan treats C1 as a fallback it
   would have to build; here it is 136 + 119 lines.
4. **A credential store that keeps the model key out of the kernel env.**
5. **`ANALYSE.md`**, which is the best platform document in the ecosystem and
   should be read before any Android work, whichever base we pick.

### 10.5 The net effect on the roadmap

Nothing in §7 changes except one line: **Step 1's "fork pi-pocket and cut
the server down" becomes "start from `server.mjs` and add the plan's §1.9
contract", with pi-pocket's `web/` re-pointed at it.** That is a smaller job
than the trim, and it lets the `web/` choice be deferred to Step 3.


---

## 11. The PoC question: `jeamy/pi-termux-mobile` as the starting point

**Verdict: yes — `jeamy/pi-termux-mobile` is the right base for a PoC, and
it is the *best* base of the four. But it is not a clone-and-build repo: it
dropped the two things that make the build reproducible, and putting them
back is exactly the "add our own ideas on top" work you described.**

`jeamy/pi-termux-mobile` (52 commits, all Jeamy) is a fork of
`badlogic/pi-termux-mobile` (14 commits, 3 of them badlogic's) — and the
author split is the whole story: Jeamy took badlogic's 2-day spike and built
a real product on it, the way `picassio/pi-phone` did with a different one.

### 11.1 What Jeamy fixed (all of it PoC-relevant)

| | badlogic's | jeamy's |
|---|---|---|
| **Licence** | **none** — legally a dead end to fork | **MIT (© 2026 Jeamy)** |
| **Process supervision** | none: if `node` dies, nothing restarts it and no state is reported | `PiService.java:34-36, 61, 67-101` — a supervisor thread with backoff, plus `terminateOrphanServer()` and `destroyForcibly()` |
| **Runtime identity** | `RUNTIME_VERSION = 38`, a hand-bumped integer | a **content fingerprint**: `sha256(rootfs.bin ‖ runtime.bin)` → `payload.sha256` (`prepare-runtime.py:88`) |
| **Conversations** | one global root, swapped in place | sessions list/new/**fork**/select/rename/delete; `watchEvents(harness, conversationId, ctx)` **per client** (`server.mjs:224`) |
| **Cleartext** | `android:usesCleartextTraffic="true"` app-wide | a **scoped `network_security_config.xml`**: `base-config cleartextTrafficPermitted="false"`, cleartext only for `127.0.0.1` / `localhost` |
| **Tests** | one manual `console.log` script | `node --test` over 3 runtime suites + `test/spaces-mobile.test.mjs` + an Android instrumentation test (`android/app/test-support/`) |
| **API surface** | chat, keys, sessions, clients, remote, terminal | + OAuth start/status/respond, providers, usage, compact, model select, `pi-version`/`pi-update` |
| **Shared core** | one 587-line `server.mjs` | `common.mjs` (389 lines) split out: `openHarness`, `Subagent`, `acquireOwnerLock`, `createCredentialStore`, `createModelCatalog`, `HARNESS_SETTINGS`, `SessionRegistry`, `createEventHub`, `writeFileAtomic`, `withFileLock` |
| **Pi Durable** | 1.0.2 | 1.0.3 |

**And `common.mjs:303-353` (`createEventHub`) is, remarkably, the plan's §1.9
already implemented**: a per-conversation hub, a **bounded ring buffer**
(`ringSize = 2000`), a monotonic **`seq`**, an **`epoch`** that changes when
the buffer is re-created ("after a daemon restart or an idle sweep the
numbering starts over and the client must reload"), a **`reset` flag** when
the client falls behind the ring, and a long-poll `poll(conversationId, after,
{epoch, waitMs})`. The plan's hardest kernel-side requirement — scoped
subscriptions, a `seq` watermark, bounded queue → resnapshot — has a working
precedent here, in 50 lines.

### 11.2 What Jeamy dropped (the blockers)

1. **The rootfs builder is gone.** badlogic's `scripts/package-rootfs.py` was
   removed. `scripts/prepare-runtime.py` only packages the *runtime* and
   **requires** `rootfs.bin` to already exist:
   ```python
   if not (ASSETS / 'rootfs.bin').is_file():
       raise SystemExit('Termux rootfs.bin is missing; prepare the rootfs asset first')
   ```
   and the README's build step is a **manual** `tar czf` from a `debs/` tree
   that is gitignored. **A clean clone cannot build the APK.**
2. **No CI** — there is no `.github/` directory at all, so there is no
   downloadable APK artifact either (badlogic had one, debug-signed, 14-day
   retention).
3. **`runtime/pi-spaces.mjs` is 13,555 lines** — 74% of the repo — and it is
   a *vendored esbuild bundle* of a separate `pi-spaces` repository that is
   **not in this repo**. `prepare-runtime.py` warns and continues when the
   sibling checkout is missing.

### 11.3 The PoC plan — three days

**Day 1 — make it buildable.** Two additions, both small:

1. **Restore a rootfs builder.** Donor: **`picassio/pi-phone/scripts/package-rootfs.ts`**
   (not badlogic's `.py`) — it also does the **equal-length prefix rewrite**,
   which fixes the `com.termux` path residue that jeamy's fork still has
   (its `prepare-runtime.py` touches only symlinks, and the README still
   warns that *"Termux scripts inside the bundle have `com.termux` shebangs
   and will fail"*). It also handles dangling symlinks and hardlinks, both of
   which break toybox `tar` on-device.
   > **Consequence: the `applicationId` must be exactly 10 characters.**
   > `package-rootfs.ts:98-100` hard-asserts
   > `if (TERMUX.length !== APP.length) throw`. `/data/data/com.termux` and
   > `/data/data/<pkg>` must be the same length, so the package id must be
   > exactly 10. jeamy's `org.pimobile.app` (15) is incompatible — this is
   > why it never rewrote the prefix. **Pick the id before you build
   > anything** (e.g. `io.pidurbl`).
2. **Add the `LD_PRELOAD` of `libtermux-exec-ld-preload.so`** to
   `PiService`'s environment (pi-phone's `PiService.java:186`). Neither
   fork sets it, and without it every child `execve` of `bash`/`git`/`rg`
   is a raw app-private exec. Make the file a hard requirement at startup
   (pi-phone lists it in `REQUIRED` and fails loudly if it is missing).

**Day 2 — cut it down to what a PoC owns.** The "spaces" subsystem is
pure scope creep for a local PoC, and the coupling is trivial: **4 lines in
`server.mjs`** — the import at `:8`, the instantiation at `:36`, the route
block at `:339-342` — plus one re-export in `common.mjs:236`. Delete
`pi-spaces.mjs` (13,555), `spaces-mobile.mjs`, `space-keystore.mjs`,
`SpaceKeyStore.java`, `runtime/public/spaces.*`, `steuerung.*`,
`authprompt.js`. That takes the repo from 18,226 runtime lines to **~4,700**
— about 1,500 lines you actually own, plus the 13.5k you deleted.

*Keep* `remote-env.mjs` + `env-server.mjs` (322 lines): they are the plan's
§1.5 C1 fallback and they only need `PI_REMOTES`. *Drop* the Remote page
(`remote-client.mjs`, `remote-provision.mjs`, `remote-state.mjs`,
`pi-serverd.mjs`, `public/remote.*`, `public/clients.*`) for the PoC.

**Day 3 — prove the three things that matter.**

1. A prompt produces a committed `pi.user` and a committed `pi.assistant`
   entry in `harness.sqlite`.
2. `kill -9` the `node` process → the **supervisor restarts it** →
   `harness.resume()` continues the interrupted run. (This is the PoC's
   whole point, and jeamy's supervisor makes it automatic.)
3. The SQLite file survives `am force-stop` and a reboot.

**Then the first "our own idea"** — the cheapest thing that proves the
self-building loop: write a `.mjs` file into the runtime directory and
`import()` it with a cache-busting query, then `registry.install()` it.
jeamy's `common.mjs` already has `openHarness({ extensions: [...] })` and
`registry.install(Subagent)` to copy.

### 11.4 Ranking the four candidates as a **PoC** base

| | Buildable from a clean clone? | Licence | Code you must understand | Supervision | Event protocol | Verdict |
|---|---|---|---|---|---|---|
| **`jeamy/pi-termux-mobile`** | ❌ (needs a rootfs script + CI restored) | **MIT** | ~1,500 lines after trimming | ✅ | ✅ `seq`/`epoch`/`reset`/bounded ring | **1 — use this** |
| `badlogic/pi-termux-mobile` | ✅ (scripted rootfs + CI artifact) | ❌ none | ~2,240 runtime + 700 java | ❌ | ❌ single global root | 2 — use as the *donor* for the missing build scripts |
| `picassio/pi-phone` | ✅ (scripted + signed CI + releases) | MIT | ~12,000 (product surface) | ✅ (restart-on-75) | ✅ (SSE + backpressure) | 3 — best *product*, worst PoC |
| `heikeyangle-code/pi-android` | ✅ | — | 263 `.kt` + a proot rootfs | ✅ | n/a (pi CLI over RPC) | 4 — different engine, no Pi Durable |

**The synthesis for a PoC is therefore: jeamy's fork as the base, badlogic's
and pi-phone's as donors for the two missing build scripts, and the plan's
§2.8/§1.10 pieces added as we need them.** jeamy's `SpaceKeyStore.java` is
also worth keeping in mind even if the spaces feature goes: it is a
**UID-checked local signer whose private keys never leave the Android
Keystore**, exposed over a `LocalServerSocket` with **no WebView signing
interface** — which is almost exactly the plan's §2.8/R8 "host decrypts the
key and passes it once over a pipe/fd" design.


---

*Research performed 2026-10-21. All repository claims are at the HEADs listed
in §9.1; `pi-phone` and `pi-pocket` move fast, so re-verify the citations
before relying on line numbers.*
