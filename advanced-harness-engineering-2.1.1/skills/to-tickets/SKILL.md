---
name: to-tickets
description: "User-invoked /to-tickets (pi: /skill:to-tickets): break a spec or plan into vertical-slice tickets with blocked-by edges."
disable-model-invocation: true
---

# To tickets

Break the work into **tickets**: tracer-bullet vertical slices, each declaring which tickets block it. The result is a task graph, not a list of steps.

Worth it when there are three or more units of work, real dependency edges, parallel agents, or work that will not fit one context window. For less, say so and suggest `/implement` instead.

## Process

### 1. Gather

Work from the conversation. If the user names a spec, issue, or URL, read all of it, including comments. Read the code the work touches and use the repository's own vocabulary and recorded decisions.

Look for prefactoring that makes the change easy: "make the change easy, then make the easy change". For changes that cross module or service boundaries, load the `blast-radius` skill so the slices and their edges reflect what actually depends on what.

### 2. Draft vertical slices

- Each slice cuts a narrow but complete path through every layer it needs (schema, API, UI, tests), not one horizontal layer.
- Each slice is demoable or verifiable on its own and leaves the build green.
- Each slice fits one fresh context window.
- Prefactoring comes first, as its own tickets.

Give each ticket its **blocked-by** edges: only the tickets that genuinely gate it. A ticket with no blockers can start immediately.

**Wide refactors are the exception.** When one mechanical change (rename a column, retype a shared symbol) breaks call sites across the codebase, no vertical slice can land green. Sequence it as **expand–contract** instead:

1. **Expand:** add the new form beside the old so nothing breaks.
2. **Migrate:** move call sites in batches sized by blast radius (per package or directory), one ticket per batch, each blocked by the expand. The old form keeps every batch green.
3. **Contract:** delete the old form in a ticket blocked by every migrate batch.

If even the batches cannot stay green alone, keep the sequence on a shared integration branch and add a final integrate-and-verify ticket blocked by all of them; green is promised only there.

### 3. Quiz the user

Present the breakdown as a numbered list: title, blocked by, and the end-to-end behavior each delivers. Ask whether the granularity is right, whether the edges are correct, and whether any tickets should merge or split. Iterate until the user approves.

### 4. Publish

- **Default:** one file per ticket, numbered from `01` in dependency order (blockers first). Put them next to the spec in a `tickets/` folder if a spec file exists, else in `docs/tickets/<feature-slug>/`, or wherever the user or repository convention says. Never combine tickets into one file. Do not commit unless asked.
- **Frontmatter is the machine contract.** Open every ticket file with the template's YAML frontmatter — `status: ready`, `blocked-by: []`, and optional `tier-override` only where a ticket should be pinned to a fixed complexity tier instead of classified. Both Copilot CLI's `/tickets` extension (`tickets_create`, `tickets_list`, `tickets_frontier`, `tickets_update`) and pi's `/orchestrate` wave engine read these fields rather than prose. Keep the `**Blocked by:**` and `**Status:**` lines beside them for human readers, and update both when status changes.
- **Issue tracker:** only if the user names one. Create issues in dependency order so edges can cite real identifiers, use the tracker's native blocking links where they exist, and link each to the parent issue if there is one. Never close or edit the parent.

## Ticket template

```markdown
---
status: ready
blocked-by: []
# tier-override: 2
---

# <NN>: <Title: the outcome, not the activity>

**Blocked by:** <ticket numbers or titles, or "None (can start immediately)">
**Status:** ready

## What to build
The end-to-end behavior this ticket makes work, from the user's or caller's
perspective, not a layer-by-layer task list.

## Scope
The components or behaviors it touches, and what it leaves for later tickets.

## Acceptance criteria
- [ ] Observable, checkable criterion

## Validation
The test or check that proves it, and which spec behaviors it covers.
```

The frontmatter between the `---` lines is what a parser reads: `status`, `blocked-by` (the blocker tickets' ids), and optional `tier-override` (the complexity tier an orchestrator should dispatch the ticket at). Quote the ids — `blocked-by: ["01"]`, not `[01]` — so a zero-padded id stays a string matching the ticket's filename. Write `blocked-by: []` when nothing gates the ticket, leave `tier-override` out unless the ticket is pinned, and treat a missing `status` as `ready`; the defaults are the machine reading of "None (can start immediately)".

Keep file paths and code snippets out; they go stale. The exception is a snippet from a prototype that pins a decision more precisely than prose: include only the decision-rich part and say where it came from.

Work proceeds along the **frontier**: any ticket whose blockers are all done. Tell the user to run `/implement` (or `/implement-spec` / pi's `/orchestrate`) with a ticket or the ticket folder.
