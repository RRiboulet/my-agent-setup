# voice

Dictation with the phone as the microphone. `/voice` starts
`termux-microphone-record` on a phone reachable over ssh, the second `/voice`
stops it, fetches the m4a, POSTs it to an OpenAI-compatible
`/audio/transcriptions` endpoint, and pastes the transcript at the cursor — or
submits it as a prompt. The container never touches a microphone; everything
device-side happens on the phone over ssh.

**Ours, not vendored.** The configured shortcut(s) toggle the same cycle;
`/voice cancel` aborts any phase. The defaults are `ctrl+shift+r` and
`alt+r` (see below).

## Usage

```
/voice          start recording; press again to stop, fetch, transcribe, paste
/voice cancel   abort the current cycle at any phase
```

The status line moves `starting…` → `● rec m:ss` → `stopping…` → `fetching…` →
`transcribing…` and clears when the cycle ends; the footer key is `voice`.

The default shortcuts are two, because one key cannot serve both worlds:

- **`ctrl+shift+r`** is the desktop key. It is only distinct from `ctrl+r`
  under the Kitty keyboard protocol (or modifyOtherKeys), so on a legacy
  terminal it never fires — the terminal sends the same byte as `ctrl+r`, and
  pi cannot tell the two apart.
- **`alt+r`** is the phone key. A legacy terminal (including Termux on the
  phone) sends ESC + r for it, which needs no protocol negotiation, so it
  works on the soft keyboard and on every terminal that does not speak Kitty.
  Termux's extra-keys row has an `ALT` key for it.

Both are bound everywhere and neither shadows a built-in editor action, so the
shortcut keeps working whether or not the terminal negotiates Kitty. Rebind
either with `shortcut` (see Configuration) if a key suits your terminal
better; `ctrl+r` is the other natural choice, though it also triggers a
built-in-conflict warning and shadows `app.session.rename` in the main
editor (rename still works in the session selector).

Where the transcript goes:

- **Default:** pasted into the editor at the cursor. pi collapses a paste over
  10 lines or 1000 characters into a `[paste #n]` marker and expands it again
  on submit, so a long dictation is one editor line until you use it.
- **`autoSubmit: true`:** submitted directly — `sendUserMessage(text)` when the
  agent is idle, `{ deliverAs: "followUp" }` while it is streaming. Prompt
  templates are never expanded, so a transcript that starts with `/` is content
  on this path.
- **No editor** (non-interactive session): submitted, with the same
  idle/streaming routing as `autoSubmit`.

Cancel never pastes. Per phase it aborts, stops the phone best-effort when a
recording may be running, and drops the local and/or remote file: recording
phases delete the remote original and any local copy; fetching deletes the
remote original; transcribing aborts the upload — no cancel path deletes the
local file when `keepAudio` is set. From `starting` it first waits (up to a
few seconds) for the start command to settle: killing the ssh client does not
stop the remote shell, so a `-q` sent immediately can come back "No recording
to stop" and leave the recorder to launch and run until `-l`. When the start
settles within that wait the recorder exists before it is stopped; a start
that is still unsettled when the wait expires is aborted and gets the same
best-effort `-q` as before, so only a start slower than the budget can still be
orphaned. The whole cancel is bounded (settle, then stop and cleanup, each under
its own budget — worst case a few seconds), and while it runs the status still
shows the pre-cancel phase and start/stop are refused, so a `/voice` press in
that window is ignored (silently in `recording` or `error`, as a `busy (…)`
notice otherwise) until the status clears.
`session_shutdown` runs the same cleanup under its own short budget, because pi
awaits shutdown handlers with no timeout of its own.

## Phone prerequisites

Termux (the terminal app) plus the Termux:API app, on the same phone:

- `pkg install termux-api openssh` — `termux-microphone-record` comes from the
  termux-api package. The first recording triggers Android's RECORD_AUDIO
  permission prompt for Termux:API; a denied permission makes the recorder
  fail.
- `sshd` running in Termux, the devcontainer's key in `~/.ssh/authorized_keys`,
  and a host alias in `~/.ssh/config` — the default `sshTarget` is `phone`, and
  `ssh phone true` should succeed before `/voice` is tried.
- **Use the absolute recorder path.** The non-interactive ssh `PATH` does not
  include Termux's `usr/bin`, so a bare `termux-microphone-record` fails there.
  The default, verified on 2026-10-15, is
  `/data/data/com.termux/files/usr/bin/termux-microphone-record`; set
  `recorderPath` if your install lives elsewhere. The path must be absolute and
  shell-safe (letters, digits, `/`, `_`, `.`, `-`); anything else is ignored
  with a warning and the default is used.

Recorder state on the phone is **device-global**: a second start fails with
`Recording already in progress!`, and *any* `-q` stops whatever is recording.
The extension sends `-q` only to stop its own cycle (and best-effort on cancel)
— never as a "fix" for an unexpected state, because that would kill a recording
it does not own. `maxSeconds` is passed to the phone as `-l`; the local timer
fires a few seconds later, so the phone's own limit wins. The cap is clamped to
1–900 seconds and 0 is never sent (`-l <= 0` means "unlimited" to the
recorder).

## Container rebuilds

The extension lives in this repo, so a container rebuild costs nothing on
its own. Three container-side pieces of the `/voice` setup do not survive a
rebuild — the ssh config under `~/.ssh`, the `netcat-openbsd` package the
ssh proxy command needs, and the `tailscaled` process that tunnels to the
phone — and one command puts them all back:

```
bash /workspace/.devcontainer/restore-post-rebuild.sh
```

The devcontainer's post-create hook runs it automatically on container
creation. What the container-side setup is (ssh key, tailscale tunnel, ssh
config, `voice.json`) and how to redo it from scratch if the pi-config volume
is ever wiped is documented in `.devcontainer/voice-container.md`, with the
phone-side steps in the prerequisites above.

## Configuration

`~/.pi/agent/voice.json`, all fields optional, every field also overridable
with a `PI_VOICE_*` environment variable. A missing file is the normal first
run; a malformed one warns once and is ignored, because `/voice` must stay
registered even when the config cannot be read.

| Field | Default | Env | Notes |
|---|---|---|---|
| `sshTarget` | `phone` | `PI_VOICE_SSH_TARGET` | ssh alias (or `user@host`); a leading `-` is ignored |
| `recorderPath` | absolute Termux path | `PI_VOICE_RECORDER_PATH` | absolute, shell-safe path on the phone |
| `maxSeconds` | `120` | `PI_VOICE_MAX_SECONDS` | clamped 1–900; passed as `-l`, never 0 |
| `bitrateKbps` | unset | `PI_VOICE_BITRATE_KBPS` | optional `-b` encoder bitrate |
| `keepAudio` | `false` | `PI_VOICE_KEEP_AUDIO` | keep the local m4a after success |
| `autoSubmit` | `false` | `PI_VOICE_AUTO_SUBMIT` | submit instead of pasting |
| `baseUrl` | `https://api.openai.com/v1` | `PI_VOICE_BASE_URL` | OpenAI-compatible root; trailing slashes stripped |
| `model` | `gpt-4o-transcribe` | `PI_VOICE_MODEL` | must accept `response_format` |
| `apiKey` | unset | `PI_VOICE_API_KEY` | explicit key, see below |
| `language` | unset | `PI_VOICE_LANGUAGE` | optional hint (`gpt-4o-mini-transcribe` rejects it) |
| `prompt` | unset | `PI_VOICE_PROMPT` | optional vocabulary/style hint (same caveat) |
| `timeoutMs` | `60000` | `PI_VOICE_TIMEOUT_MS` | upload timeout, clamped 5000–300000 |
| `shortcut` | `["ctrl+shift+r", "alt+r"]` | `PI_VOICE_SHORTCUT` | pi key id(s) that toggle the recorder; a string, a comma-separated string, or an array. `[]`/`""` disables it |

Booleans accept `1/true/yes/on` and `0/false/no/off`; an unrecognised value is
ignored rather than guessed.

## Transcription and keys

- **Key routing.** An explicit `apiKey` (file or `PI_VOICE_API_KEY`) wins.
  `OPENAI_API_KEY` and the model registry's OpenAI key are consulted only when
  `baseUrl` is the OpenAI default, so one provider's credential is never sent
  to another endpoint. A custom endpoint without an explicit key is called
  **unauthenticated** — self-hosted servers commonly need none, and a cloud one
  answers 401 in plain words.
- **Request.** multipart `file` (the m4a), `model`, `response_format: json`,
  plus `language`/`prompt` only when set. `response_format` is `json` or
  `text`; `verbose_json` is never used.
- **Exactly one retry.** A 400 whose body names `response_format` is retried
  once with `text` (some compatible servers reject `json`). The retry
  re-uploads the audio and can be billed twice, which is why nothing else is
  retried.
- **25 MB.** The local file is checked before it is read and the buffer before
  the POST; the API's documented cap is *at most* 25 MB, so exactly 25 MB is
  still sent.
- **Failures** are typed (non-2xx / network / empty body / too large) and carry
  a one-line message; a timeout is 60 s by default.

## Privacy and retention

The audio exists in three places, briefly:

- **On the phone:** `$HOME/.pi-voice/<id>.m4a`, deleted once the fetch has
  succeeded (and by any cancel). It deliberately survives a fetch failure or an
  empty recording — nothing was collected, so it is all that is left — and
  nothing sweeps a file left behind by a crash mid-cycle; the live smoke test
  checks for leftovers before a sweeper earns its keep.
- **Locally:** `<tmpdir>/pi-voice-<id>.m4a`, mode `0600`, deleted after a
  successful transcription unless `keepAudio` says otherwise. When a file is
  kept, the notice names its path — on a transcription failure, and on a cancel
  that keeps the file with `keepAudio` set.
- **At the API:** the one POST to `baseUrl` — the OpenAI default, or your own
  server if you point it there. Nothing else leaves the machine.

The transcript becomes part of the session log like any other input.

## Two cautions

- **A failed transcription keeps the recording.** The notice names the path
  (`handling the recording failed: … — audio kept at <path>`) so it can be
  retried by hand; this is not governed by `keepAudio`. `/voice cancel` from
  that error phase removes the file unless `keepAudio: true`.
- **A pasted transcript is submitted by you, not by the extension.** On the
  paste path, pressing Enter is a normal editor submission: a transcript that
  begins with `/` (a registered command) or `!` executes as that command or
  shell line. Reword it first if the dictation happens to start that way.
  `autoSubmit` does not have this caveat — it never expands prompt templates.

## Manual checklist

What the unit suite cannot prove — it needs the real phone and an STT key:

1. First `/voice`: grant Android's RECORD_AUDIO permission to Termux:API, speak,
   `/voice` again — the transcript lands at the cursor.
2. The shortcut: `alt+r` starts a recording and `alt+r` again stops it, with no
   `/voice` typed, and `ctrl+shift+r` does the same on a Kitty terminal. A
   `shortcut` override in `voice.json` is picked up after `/reload`.
3. `/voice cancel` in each phase (starting / recording / fetching /
   transcribing): no paste, `$HOME/.pi-voice/` on the phone and the local temp
   dir both empty.
4. `maxSeconds` expiry with a short cap: the phone stops itself; the later `-q`
   may answer `No recording to stop`, which the stop path tolerates on that
   output alone — the fetch step is what still has to prove audio arrived (exit
   0, non-empty stdout).
5. A second pi session running `/voice` while the phone records: the
   already-in-progress hint, and nothing on the phone is killed.
6. Quit pi while recording: shutdown stays bounded and the phone stops.
7. `bitrateKbps`: `-b` acceptance on your device.
8. A transcript over 10 lines: the `[paste #n]` marker in the editor and
   expansion on submit.
9. Key resolution with no `PI_VOICE_*` vars set, and the airplane-mode failure
   path.

## Files

| File | Role |
|---|---|
| `index.ts` | registration, `/voice`, the configured shortcuts, status rendering, deliver (read → transcribe → present) |
| `shortcut.ts` | pi key-id grammar: normalise and validate a configured shortcut |
| `config.ts` | defaults, `voice.json` + `PI_VOICE_*` merge, malformed-file warning |
| `recorder.ts` | command builders and the recorder state machine (start / stop / cancel / shutdown) |
| `transcribe.ts` | multipart POST, key routing, typed failures, the single `response_format` retry |
