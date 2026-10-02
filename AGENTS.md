# Agent Notes

## Releases

1. Update `CHANGELOG.md` for the release.
2. Commit the release changes.
3. Tag with the version and push commits and tags.

Versions are git tags. This repository is not published to npm.

## Extensions

Pi extensions live in `./extensions` and skills in `./skills`. When working in
this repo, add or update them there.

You can consult pi for reference — the installed `@earendil-works/pi-coding-agent`
docs at `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/` are the
source of truth for the API this code targets — but do not modify pi itself.

## Tests

```bash
./extensions/subagent/test/setup-deps.sh                     # once: link pi's packages
node --test extensions/subagent/test/*.test.ts
```

Node runs the TypeScript directly; there is no build step. See
`extensions/subagent/test/README.md` for what is and is not covered.