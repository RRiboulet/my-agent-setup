# pocket — a durable gateway for driving this machine's agent from a phone

Working from a phone is not the same problem as working from a laptop, and the
difference is not screen size. On a laptop the agent runs where you sit: the
terminal is the session, closing the laptop closes the session, and that is fine.
From a phone the connection is the unreliable part — cellular handoff, a locked
screen, a phone that goes to sleep — while the work is still running. A setup
built for the desk breaks in three specific ways from a phone:

- the agent dies the moment the phone stops paying attention;
- the phone comes back to a blank screen, because everything it was showing
  lived in the connection;
- the one thing the agent needs from you — an answer to a question, an approval
  — arrives as a line of text you have to transcribe by hand.

`pocket` is this machine's answer to those three. It is a detached daemon that
owns one `pi --mode rpc` child per project session, a phone client that streams
what the agent is doing, a bounded replay journal so a reconnecting phone is
looked after, and enough authentication that it can be bound to something other
than loopback without becoming the reason to patch a house rule.

Zero npm dependencies, in line with the rest of this repository. Node's standard
library and pi's own extension API are the whole toolkit.

## The shape of it

```
phone ──HTTPS/HTTP──► daemon (detached, survives reboot via systemd or nohup)
                        │
                        ├─ SessionStore   sessions.json — names, cwds, models,
                        │                  the pi session file each child is on
                        ├─ SessionJournal <dataRoot>/journal/<id>.jsonl + .start
                        ├─ Auth           devices.json, hashed, pair codes
                        └─ Supervisor ──── one child per session
                                              pi --mode rpc <project cwd>
```

The daemon is the only long-lived process. Each project session costs one child,
spawned with the project directory as its working directory, pointed at its own
session file. A child is treated as expendable: if it dies for any reason other
than being asked to stop, the supervisor brings up a replacement that resumes the
recorded session file, and the conversation continues. The child holds no state
worth grieving; everything worth grieving is on disk.

Two things follow from that, and they are the reason the design is what it is.

**One session file, owned by pi.** pocket does not keep its own transcript. It
records the path of the file the child names (via `get_state`, because pi
prefixes its own timestamp) and passes it back as `--session <path>` when it
resumes. Unbounded, authoritative, and shared with a terminal `pi` on the same
machine. pocket's journal is deliberately *not* a transcript: it is a bounded ring
of framework-level records (child exits, respawns, dialogs, settle events) sized
for replay, capped per record, and trimmed from the front.

**One process per session, not one process per client.** A phone connecting,
disconnecting, or going behind a tunnel costs nothing. The daemon holds journal
listeners for live streaming and nothing else depends on a client being there.

## How reconnect works

A phone asks `GET /api/sessions/<id>/events?cursor=<n>` and gets a Server-Sent
Events stream. It keeps a cursor — the last journal sequence number it saw. On
reconnect it sends that cursor back:

- cursor behind the surviving records → those records, then live;
- cursor below the start of the surviving window → a reset event, carrying the
  current cursor, and then the records that remain;
- cursor ahead of the journal → a reset, because the journal cannot honour a
  sequence it never gave out (a restart, or a session that was removed and
  re-created with a name that collides).

The conversation itself is *not* replayed from the journal: it is fetched from
the session file through `get_messages`, which is the same call a terminal `pi`
resume makes. So a reconnecting phone gets the whole history and the recent
framework events, from two different stores, each used for what it is good at.

This cursor contract is pinned against a live daemon, not just in unit tests:
`?cursor=1` returns records 2 and 3 and leaves the cursor at 3 without a reset,
`?cursor=0` returns all three, `?cursor=99` returns a reset plus the current
cursor.

## Why not reuse one of the existing designs

Three projects already solve "drive my agent from a phone". They were read
rather than guessed at, and each got a different answer to the same question of
where the durable process lives:

| Project | Where the agent lives | Reconnect | Auth |
|---|---|---|---|
| [CompN3rd/pi-web](https://github.com/CompN3rd/pi-web) | a privileged `sessiond` behind a private Unix socket, so the web process may restart freely | WS to the socket for events; history re-fetched from pi's own JSONL | none, by design |
| [AltanS/collie](https://github.com/AltanS/collie) | in a multiplexer; the bridge is a stateless systemd user service | poll + catch-up, a declared freshness promise; history read off the agent's transcript | pairing tokens, hashed, revocable, non-loopback refused |
| [Ark0N/Codeman](https://github.com/Ark0N/Codeman) | in tmux on a private socket; the web server is only a viewer | WS with `(clientId, seq)` reliable delivery and ACKs; full-history capture on join | Basic → session cookie, plus a single-use QR token |

What pocket takes from them, and what it deliberately leaves:

- **From pi-web**, the daemon-with-a-private-transport split and the insight
  that history is pi's own JSONL, not something the gateway should re-emit.
  pocket does not adopt the project/workspace/worktree model: a single-user
  phone setup has one project at a time, and the extra level buys nothing.
- **From collie**, reading history from the agent's own transcript rather than a
  screen, and a revocable per-device credential with the hash on the server.
  pocket does not adopt poll-only reconnect: a phone on cellular benefits from a
  stream that does not cost a request per interval, and the journal already gives
  a resync path.
- **From Codeman**, the server-side registry of pending prompts with a stable
  id, which is what makes a notification's button and a reconnected phone land
  on the *same* question rather than a ghost. pocket implements this as the
  dialog map on each live session, journaled so a phone that reconnects
  mid-question can still answer it, with the answer routed to the request id the
  child is blocking on. pocket does not adopt the respawn controller with
  circuit breakers and health scoring: a bounded respawn budget and an explicit
  "giving up" message is the honest amount of engineering for one machine.

The one-line summary, taken from all three: supervise the agent separately from
the client, put its state on disk, make reconnect a resync, and give the phone a
token, a pending item to act on, and a notification that names the work.

## Configuration

Everything is environment variables, read at daemon start. Nothing is read from
the project directory, so the daemon's behaviour cannot be changed by the
project it is serving.

| Variable | Default | Meaning |
|---|---|---|
| `PI_POCKET_HOST` | `127.0.0.1` | bind address. Non-loopback requires a token |
| `PI_POCKET_PORT` | `8787` | bind port |
| `PI_POCKET_TOKEN` | unset | operator token. Empty means unset |
| `PI_POCKET_JOURNAL_MAX` | `2000` | records kept per session |
| `PI_POCKET_RESPAWN_MAX` | `3` | consecutive respawns before giving up |
| `PI_POCKET_REQUEST_TIMEOUT_MS` | `120000` | timeout on one RPC round trip |
| `PI_POCKET_PI_BIN` | `pi` | which pi the children run as |
| `PI_POCKET_NTFY_TOPIC` | unset | ntfy.sh topic for push notifications |
| `PI_POCKET_NTFY_SERVER` | `https://ntfy.sh` | push server |
| `PI_CODING_AGENT_DIR` | as pi resolves it | where the data root lives |

The empty-token rule is worth stating plainly: `PI_POCKET_TOKEN=` counts as no
token. An operator who comments out a token by emptying it gets the loopback-only
behaviour, not a credential that the empty string satisfies.

The bind rule is one assertion in `checkAccessibleHost`: a non-loopback bind
without a token is refused at start-up. An agent running as this user has that
user's credentials, its home directory, and its SSH agent; exposing that to a LAN
with no credential is not a configuration pocket is willing to be started in.

## Authentication

Three kinds of caller, and the difference matters:

- **local** — no token configured, loopback bind. A request that arrived is local
  by definition. No pairing needed.
- **master** — the operator token from `PI_POCKET_TOKEN`, or the one minted on
  first `serve` and written to the data root with mode `0600`.
- **device** — a token issued by `/api/pair` from a one-time code, stored only as
  a hash on the server, revocable individually, with an attempt countdown and a
  per-address rate limit.

`GET /api/config` is the one unauthenticated route that reports anything: it says
whether a token is required, whether push is configured, and where the agent
directory is. That is enough for the client's login screen and nothing else.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /api/health` | liveness, unauthenticated |
| `GET /api/config` | bind facts, token required?, push configured |
| `POST /api/pair` | exchange a one-time code for a device token |
| `GET`/`POST /api/pairing` | inspect and re-issue the one-time code |
| `GET /api/devices`, `DELETE /api/devices/<id>` | list and revoke devices |
| `GET /api/state` | everything the client needs on one shot |
| `GET`/`POST /api/sessions` | list, or create one (name + cwd) |
| `GET`/`DELETE /api/sessions/<id>` | status: live, pid, respawns, last error |
| `POST /api/sessions/<id>/prompt` | send a message, optionally idempotent |
| `POST /api/sessions/<id>/steer`, `/follow-up`, `/abort` | mid-run control |
| `POST /api/sessions/<id>/start`, `/stop` | attach or stop its child |
| `POST /api/sessions/<id>/rename`, `/model` | rename, change model or thinking |
| `POST /api/sessions/<id>/answer/<requestId>` | answer a pending dialog |
| `GET /api/sessions/<id>/messages` | the conversation, from the session file |
| `GET /api/sessions/<id>/events?cursor=<n>` | SSE live stream |

Every path that carries a session id validates it first: it becomes a URL path
segment and a directory name, so `/api/sessions/..` has to be impossible rather
than merely unfashionable.

Prompt delivery is idempotent by key. A phone that sent a prompt, lost the
connection before the response, and retries sends the same key; the daemon
answers from the record of what it already did rather than telling the agent the
same thing twice. A prompt that could not be delivered at all is journaled as a
`prompt_failed` gateway event, so the phone's next reconnect can show it instead
of spinning forever.

## The phone client

A small PWA in `client/`, served from the daemon, installable, with a service
worker and a manifest. It holds the token in `localStorage`, uses
`?cursor=<n>` for reconnect, and renders dialogs as answerable blocks rather
than text to transcribe — the shape collie arrived at and Codeman's approvals
inbox both needed, because a phone has no reliable way to type `3` into an agent
that asked a numbered question.

## Running it

```bash
/pocket serve          # start the daemon detached, print its URL and token
/pocket pair           # mint the one-time pairing code a phone needs
/pocket sessions       # what exists, and what is running
/pocket new <project directory> [name...] [-m provider/model]   # start a session
/pocket attach <id>    # start its child; /pocket detach <id> stops it
/pocket url            # where the client is
/pocket status         # what is running
/pocket devices        # paired phones; /pocket revoke <id> removes one
```

The name is optional and defaults to the directory's basename; the flags come
after the positionals, because a name may contain spaces and a flag never does.

Or start the daemon directly, which is what a systemd unit or a test does:

```bash
PI_CODING_AGENT_DIR=/tmp/pocket-smoke/agent PI_POCKET_TOKEN=smoke-token \
  node --experimental-strip-types .pi/extensions/pocket/daemon.ts
```

The data root is `<PI_CODING_AGENT_DIR>/pocket`, so pocket's state travels with
the agent directory it belongs to rather than living in `/tmp`.

The daemon is meant to be run under something that survives logout — a systemd
user unit with `Restart=on-failure` and `loginctl enable-linger` is what all
three reference projects use, and pi-web's installation writes exactly that.
Even without it, `reviveAll()` at start-up brings back every session that wanted
to be running, so a machine that comes back from a reboot resumes its work where
it stopped.

## Tests

```bash
node --test .pi/extensions/subagent/test/pocket-*.test.ts
```

What the suite pins, and why those things rather than others:

- **framing** — the LF-only line split of the RPC stream, including U+2028 and
  U+2029 inside JSON strings, CRLF, a lone CR, and byte-at-a-time arrival. These
  are the failures that make a child look like it stopped answering.
- **spawn-args** — that `--session-id` and `--session` are never both passed,
  which against the installed pi exits code 1 with "cannot be combined". Two
  modes, chosen by whether a session file exists.
- **journal** — sequence numbers assigned inside the queue rather than before it,
  per-record byte caps that keep the record's identity, and a restart that knows
  where its trimmed survivors start.
- **auth** — that the token is never on disk in the clear, that a pairing code is
  consumed once, that a rate limit and a TTL exist, and that masking by shape
  works on bearer tokens, PEM blocks and `sk-` keys.
- **store** — concurrent creates, an atomic registry, directory containment, and
  that a rejected traversal leaves the file byte-identical.
- **supervisor** — behaviour, against a real subprocess.
  `pocket-fake-pi.ts` is a stand-in `pi --mode rpc` child: it writes its session
  file lazily on the first prompt, exactly like pi, restores a file it is pointed
  at, and exits cleanly on a signal. Process facts — an exit code, a signal, a
  pid changing, argv — cannot be mocked, so they are not: the test kills a child
  with SIGKILL and asserts the replacement resumed the same conversation, that a
  parked session stays down across a simulated daemon restart, and that a child
  which never starts is reported rather than respawned forever.

Bugs the tests found during development, each now pinned: sequences assigned
before the queue (25 concurrent appends all numbered 1); the byte cap living
outside the journal so directly appended records were unbounded, and replacing
the whole record so a capped record lost its `kind`; a count derived from line
numbers so a trimmed journal believed it held three records when ten had passed
through; recovery of a journal memoized per call so concurrent appends built
private chains; `PI_POCKET_TOKEN=` counting as a token; a write to a dead child's
stdin raising an unhandled `EPIPE` that would have taken the daemon down; and the
fake's own `--session-dir` default, which is the resume-mode case the product
correctly does not pass.

## What it does not do

- No edits of local files beyond what the agent does. The phone is a window and a
  keyboard, not an IDE.
- No multi-user, no tenancy, no per-device authorization scopes. One machine,
  one operator, a few phones.
- No history in the journal. If the journal is lost, history is re-read from the
  session file, which is the point of not duplicating it.
- No sandbox. The agent has the operator's credentials and can use them; pocket's
  job is to make sure only the operator's phones can ask it to.
