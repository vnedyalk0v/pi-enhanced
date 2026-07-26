# Plan 014: Collapse git footer queries into one status read

> **Executor instructions**: Replace repeated git subprocesses with one
> porcelain-v2 status command and one focused parser test. Preserve the current
> footer text and manual refresh command. Update the index when done.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- extensions/git-info/index.ts extensions/git-info/index.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 013
- **Category**: performance
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

Every refresh currently starts three to four git processes, and refreshes are
registered on both `turn_end` and `agent_end`. A single
`git status --porcelain=v2 --branch` contains branch, dirty, upstream,
ahead/behind, and detached-head data. Using the settled lifecycle event avoids
duplicated work after one agent run.

## Current state

`extensions/git-info/index.ts:26-49` calls:

- `git rev-parse --is-inside-work-tree`;
- `git branch --show-current` and sometimes `git rev-parse --short HEAD`;
- `git status --porcelain`;
- `git rev-list --left-right --count @{upstream}...HEAD`.

Lines 79-87 refresh on `session_start`, `turn_end`, and `agent_end`.

Pi's current event docs define `agent_settled` as the point where retry,
compaction retry, and queued continuation work is finished.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Target tests | `node --test --experimental-strip-types extensions/git-info/index.test.ts` | all pass |
| Gates | `npm run verify` | exit 0 |

## Scope

**In scope**:

- `extensions/git-info/index.ts`
- `extensions/git-info/index.test.ts` (new)

**Out of scope**:

- Polling or filesystem watchers.
- Caching git state across events.
- New footer fields.
- A shared subprocess abstraction.

## Git workflow

- Branch: `advisor/014-collapse-git-footer-queries`
- Commit: `perf(git-info): collapse footer status queries`

## Steps

### Step 1: Add one porcelain-v2 parser test

Extract only the pure parser needed by production. Add table-driven cases for:

- clean branch with upstream and `+0 -0`;
- dirty tracked and untracked entries;
- ahead and behind counts from `# branch.ab +N -N`;
- no upstream;
- detached head using the short `branch.oid`;
- malformed or missing headers returning safe defaults.

Keep the parser local to this extension; do not create a shared git module.

**Verify before the fix**:
`node --test --experimental-strip-types extensions/git-info/index.test.ts`
→ parser cases fail or cannot compile.

### Step 2: Replace the subprocess sequence

Make `readGit()` call only:

```sh
git status --porcelain=v2 --branch
```

Parse its headers and record lines into the existing `GitSnapshot`. A failed
command still returns `null`; no upstream still yields zero counts; detached
HEAD displays a short object ID, falling back to `"detached"` only when absent.

Retain the existing timeout, max buffer, UI guard, formatting, stale-context
catch, and `/git-info` command.

**Verify**:

- Target parser tests pass.
- In a temporary repository, compare clean, dirty, ahead, behind, and detached
  displays against the old behavior.
- Instrument or stub `execFile` in a focused check and confirm one git process
  per refresh.

### Step 3: Refresh only after settled work

Keep `session_start`. Replace `turn_end` and `agent_end` listeners with one
`agent_settled` listener. The manual command remains unchanged.

**Verify**:

- TypeScript accepts the event name from Pi's installed types.
- One completed agent run causes one post-run refresh.
- `npm run verify` → exit 0.
- `git diff --check` → clean.

## Test plan

One pure parser test covers porcelain variants. A temporary repository or
injected subprocess check proves the one-call behavior without relying on the
developer's working tree.

## Done criteria

- [ ] A normal refresh starts exactly one git subprocess.
- [ ] Footer output preserves branch, dirty, ahead, and behind semantics.
- [ ] Detached and no-upstream repositories are handled.
- [ ] Refresh runs on session start and agent settled, not duplicate end events.
- [ ] Full verification passes.

## STOP conditions

- Installed Git lacks porcelain v2 branch headers.
- `agent_settled` is absent from the pinned Pi API.
- Preserving an existing footer state requires extra subprocesses; document the
  missing field before expanding scope.

## Maintenance notes

Do not add caching until one git status call is measured as material. The
settled event and single porcelain read are the intended ceiling.
