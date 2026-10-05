# Agent Notes

## Branches

**Do not work on `main`.** Every change gets its own branch off `main`, and
`main` only ever moves to take a release (see "Releases"). Branch names name the
change, not the session: `session-breakdown-coverage`, `subagent-test-closure`.

The reason is that `CHANGELOG.md`'s `Unreleased` section is shared ground. Two
changes in flight both add a `Maintenance` bullet there, so parallel branches
conflict on merge even when their code does not. A branch keeps one change's
tests, files and changelog entry together, and makes each one independently
verifiable: check it out in a worktree and run the suite before assuming it
stands alone.

When two branches are ready at once, merge or rebase in an order you choose
yourself — `main` is not a priority queue, and neither branch is urgent over
the other.

## Pull requests

Branches reach GitHub through `gh`, which is baked into the devcontainer image
(`.devcontainer/Dockerfile`) rather than installed at runtime, so a rebuild does
not silently drop it. The token lives in the `pi-agent-config` volume via
`GH_CONFIG_DIR=/home/vscode/.pi/gh`, which is what makes one `gh auth login` last
across rebuilds — `/home/vscode` itself is container-local and is discarded.

One-time setup, run by the human (it needs a browser):

```bash
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git        # teaches git to use gh as its credential helper
```

`gh auth setup-git` is the part that matters for everything else: after it,
plain `git push` works without any credential in `.git/config`.

**The one gotcha:** `GH_CONFIG_DIR` from the Dockerfile only applies to
containers built *after* that change. In a container that predates it, `gh auth
login` writes to `~/.config/gh/`, which is ephemeral — so a rebuild silently
loses the token and `gh auth status` starts failing again. If you authenticate
and later rebuild, either copy the config into the volume
(`cp ~/.config/gh/*.yml "$GH_CONFIG_DIR"/`) or export `GH_CONFIG_DIR` before
logging in. Check *where* `gh auth status` says the token lives: it prints the
path, and that path is the thing that decides whether the login survives.

The workflow, once that is done:

1. Work on a branch (see "Branches"), committing as the `commit` skill directs.
2. `git push -u origin <branch>`
3. `gh pr create --fill` — `--fill` uses the commits for title and body, which
   this repo's long commit subjects suit. Always say in the body what a reviewer
   should check and what you verified.
4. `gh pr merge --squash` (or `--merge` to keep the branch's own commits).
5. Bring `main` up to date and delete the branch:
   `git checkout main && git pull --ff-only && git branch -d <branch>`.

Tags are cut from `main`, never from a feature branch.

Never put a token in `.git/config`, in the Dockerfile, or in a file in the repo.
If authentication is needed mid-session, stop and ask rather than improvising.

## Releases

1. Update `CHANGELOG.md` for the release.
2. Commit the release changes.
3. Tag with the version and push commits and tags.

Versions are git tags. This repository is not published to npm — it is
`private` and consumes no npm packages, but it IS consumable as a pi package:
`package.json` carries a `pi` manifest listing the extension entry points and
skills, which is what makes `pi install git:github.com/RRiboulet/my-agent-setup`
work in another project.

## Extensions

Pi extensions live in `./.pi/extensions` and skills in `./.pi/skills`. When
working in this repo, add or update them there.

Adding a new extension or skill means adding it to the `pi` manifest in
`package.json` as well: it lives in a dot-prefixed directory, which package
discovery will not glob, so an unlisted extension installs nowhere.
`test/package-manifest.test.ts` fails if the manifest and the tree disagree.

You can consult pi for reference — the installed `@earendil-works/pi-coding-agent`
docs at `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/` are the
source of truth for the API this code targets — but do not modify pi itself.

## Subagent tools

The five management tools — `subagent_status`, `subagent_cancel`,
`subagent_interrupt`, `subagent_resume`, `subagent_clean` — are **not declared**
in this repo's sessions: `defaultTools: ["+tool_search"]` in
`~/.pi/agent/settings.json` puts them behind `tool_search` so their descriptions
and schemas stop riding along on every request (measured: ~890 tokens a
request). `subagent` itself stays declared.

So reach them in two steps:

1. `tool_search` for the tool you want.
2. Then call it, e.g. `subagent_status({ id })`.

There is no blocking wait, so collecting a result means polling
`subagent_status` — `subagent_status({ compact: true })` is the cheap
one-line-per-run form, and the single-run path is the one that returns output.

## Tests

```bash
bash .pi/extensions/subagent/test/setup-deps.sh              # once: link pi's packages
node --test .pi/extensions/subagent/test/*.test.ts
```

Run it with `bash` (or `sh`), not as `./setup-deps.sh` — see "Line endings"
below. Node runs the TypeScript directly; there is no build step. See
`.pi/extensions/subagent/test/README.md` for what is and is not covered.

## Line endings

`.gitattributes` sets `* text=auto eol=lf`, so git *normalizes* CRLF away on
comparison. Two consequences that `git status` cannot surface:

- A file whose blob is LF may still be **CRLF in your working tree** if it was
  checked out before `.gitattributes` existed. It shows as clean, yet bash
  fails on it (`$'\r': command not found`, `set: pipefail: invalid option`).
- `git add` does not fix an already-CRLF blob retroactively for files the
  attribute did not apply to when they were first committed.

If a shell script fails inexplicably, check it before trusting `git status`:

```bash
grep -qU $'\r' <file> && echo "CRLF in working tree"
```

Repair the whole tree with:

```bash
git add --renormalize .
git ls-files -z | xargs -0 rm -f && git checkout-index -a -f   # re-checkout applies eol=lf
```

Keep shell files LF. The devcontainer bakes them in verbatim, and a trailing
`\r` ends up inside sourced paths (`~/.aliases.zsh^M`).