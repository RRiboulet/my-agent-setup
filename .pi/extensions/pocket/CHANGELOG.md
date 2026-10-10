# pocket

Nothing here is released on its own — this file mirrors `CHANGELOG.md` at the
repository root and is kept so the directory can be read on its own. Versions are
git tags on `main`.

## Unreleased

Added:

- **pocket, a detached gateway for project sessions that outlives the phone.**
  Each project session is one `pi --mode rpc` child, spawned with the project
  directory as its cwd, pointed at its own session file, and treated as
  expendable: a child that dies for any reason other than being asked to stop is
  replaced by one that resumes the recorded file, so a cellular handoff, a locked
  screen or a reboot costs nothing. There is one long-lived daemon, no client
  dependency, and nothing in the design that asks a phone to stay connected.

  The session file belongs to pi, not to pocket: it is whatever path the child
  names through `get_state`, and it is what a respawn resumes. pocket keeps its
  own record alongside it — a bounded per-session journal of framework events
  (child exits, respawns, dialogs, settle notifications) — sized for replay,
  capped per record, trimmed from the front, with a sidecar carrying the sequence
  of the first surviving record so a restart knows where the survivors start.
  The conversation is never duplicated into that journal; it is read from the
  file, which is the same thing a terminal resume does.

  A phone reconnects by sending back the last sequence number it saw: behind the
  window means records then live, below the start of the survivors means a reset
  plus what is left, ahead of the journal means a reset because a sequence the
  journal never gave out cannot be replayed. The contract is verified against a
  running daemon rather than only in unit tests.

  Authentication exists because a non-loopback bind is allowed at all: without a
  token the daemon refuses to bind anything but loopback, an agent running as
  this user is not something to expose to a LAN unauthenticated, and with a token
  the pairing flow hands a phone a revocable device credential whose hash is the
  only thing on disk. Devices are revocable individually, pairing codes are
  one-time with a TTL, an attempt countdown and a per-address rate limit.

  The phone client is a small PWA served from the daemon: installable, offline
  manifest and service worker, SSE streaming with the cursor above, dialogs
  rendered as answerable blocks rather than text to transcribe, and a prompt path
  that is idempotent by key so a phone that lost the response does not tell the
  agent the same thing twice.

  Three projects were read before any of this was written — pi-web, collie and
  Codeman — and `README.md` records what was taken from each and what was left
  alone, with the reasons.

Fixed:

- **An empty token was a token.** `PI_POCKET_TOKEN=` satisfied the "is a token
  configured" check, so a bind that was supposed to be loopback-only got an empty
  credential, and a request sending an empty bearer could authenticate as the
  operator. `effectiveToken()` collapses an empty string to the absence of a
  token at the environment boundary, and every branch that asks whether one is
  set — the bind check, the request handler, the client's own header — asks it
  that way too, so a caller building a config object directly gets the same rule
  rather than a second place to get it wrong.
- **A write to a child that had already exited crashed the daemon.** The child's
  stdin pipe emits `EPIPE` both to the write's callback and to the stream as an
  unhandled `error` event; with no listener on that stream a phone's prompt to a
  just-died child took the gateway down rather than reporting a failure. The
  callback already rejected the request it belonged to; the listener now swallows
  the stream copy and keeps the tail that goes into the record.
- **A prompt that never reached the agent left no trace.** The failure was thrown
  to the caller and journaled nowhere, so a phone sat on a spinner forever and a
  reconnect had nothing to show. Every prompt failure is now recorded as a
  `prompt_failed` gateway event carrying the reason, which is what the phone's
  next reconnect reads instead.
- **A wildcard bind answered `421` to the address it was bound to serve.**
  `hostAllowed` compared the request's Host header against `PI_POCKET_HOST`, so a
  daemon started with `PI_POCKET_HOST=0.0.0.0` — the same-Wi-Fi path in the
  tutorial, and the only option behind a container or NAT — accepted only
  `localhost` and rejected `192.168.1.50`, `100.106.10.25` and every other
  address a phone could dial, with `unknown host: refusing to answer`. `0.0.0.0`
  names no single host, so there was nothing for a concrete Host to match. A
  wildcard bind now accepts any Host, which is what that bind already means:
  `checkAccessibleHost` refuses a non-loopback bind without a token, so
  authentication is still the gate, and the DNS rebinding this check exists to
  stop needs a loopback bind, which is never a wildcard. The same function
  mangled a bracketed IPv6 Host — `[::1]:8787` was read as `:`, because the
  trailing-`:port` strip ate the address's last group — so an IPv6 bind rejected
  its own clients; the bracket is now parsed before any port is removed.
- **The CLI sent no operator token after `serve` minted one.** The daemon
  authenticates against `PI_POCKET_TOKEN` when it is set and otherwise against
  the token `serve` mints into `daemon.token`; `gatewayInfo`, the function every
  CLI command uses to address the daemon, read only the environment. A pi
  session that never set `PI_POCKET_TOKEN` therefore had `serve` hand the minted
  token to the daemon and then send no `Authorization` header itself: `pair`,
  `devices`, `revoke` and `new` all got 401 from the gateway they had just
  started, and the minted file was never read back on the client side.
  `gatewayInfo` now falls back to the saved token, exactly as `serve` falls back
  to minting one, so the environment still wins when it is set and the file is
  the shared secret when it is not.

Maintenance:

- **Tests that pin process behaviour, against a real child.**
  `pocket-fake-pi.ts` is a subprocess that speaks the subset of the RPC protocol
  pocket uses: it writes its session file lazily on the first prompt exactly as
  pi does, restores a file it is resumed against, answers `get_state` and
  `get_messages`, and exits cleanly on SIGTERM. Exit codes, signals, pids and
  argv cannot be mocked, so the supervisor tests do not mock them: a child is
  SIGKILLed and the replacement is asserted to resume the same conversation, a
  session is parked and the next simulated boot is asserted to leave it down,
  and a binary that is not there is asserted to be reported as a spawn failure
  rather than respawned until the logs fill.

  Five bugs were found by writing them. Sequence numbers were assigned before
  appends were queued, so 25 concurrent appends all reported sequence 1. The
  per-record byte cap lived outside the journal, so records appended directly
  were unbounded, and it replaced the whole record, so a capped record lost the
  `kind` that says what it was. The record count was derived from surviving
  lines, so a restarted journal believed a trimmed buffer was the whole history.
  Journal recovery awaited a read on every miss, so concurrent appends each built
  a private serialization chain and the sequencing still interleaved. And the
  fake's own `--session-dir` default, which is the one argument the product
  correctly does not pass in resume mode, made every resumed child die on a
  missing directory — the test harness failing on the case it was written to
  cover.

  Each is pinned now, and the whole extension runs at 87 tests with no npm
  dependency and no build step.
- **The supervisor tests no longer leave a directory behind.** The fake pi child
  is reached through a shell wrapper written once per test file, and its temp
  directory was created and never removed, so each suite run added one to `/tmp`
  with nothing watching. The module-level `after` hook — the one that already
  shuts the supervisors down — remembers it and removes it, so a file that fails
  part-way through does not leave it either.
