# Plan 002: Isolate workflow artifacts in private unique directories

> **Executor instructions**: Follow every step and verification gate. Stop on
> any STOP condition rather than expanding scope. Update `plans/README.md` when
> complete unless a reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- extensions/workflows/manager.ts extensions/workflows/artifacts.ts extensions/workflows/manager.test.ts`
> Compare the excerpts below if any path changed.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

Every `WorkflowManager` starts its counter at zero and writes `wf-1` beneath
the same OS-temp root. Concurrent or restarted Pi sessions can overwrite each
other's goals, status, and agent output; default file modes may also expose
repository content to other local users. Artifact paths are already returned
dynamically, so unique private directories do not break a stable path API.

## Current state

`extensions/workflows/manager.ts:70-83`:

```ts
private counter = 0;
private readonly artifactsRoot: string;
// ...
this.artifactsRoot = options.artifactsRoot ?? join(tmpdir(), "pi-enhanced-workflows");
```

`extensions/workflows/manager.ts:108-116`:

```ts
this.counter += 1;
const id = `wf-${this.counter}`;
const artifactsDir = join(this.artifactsRoot, id);
await mkdir(artifactsDir, { recursive: true });
await writeFile(join(artifactsDir, "goal.txt"), `${goal.trim()}\n`, "utf8");
```

`extensions/workflows/artifacts.ts:18-39` creates task and final files with
default modes. Existing tests use `createManager()` and injected fake backends
in `extensions/workflows/manager.test.ts:112-123`; reuse those patterns.

Design constraint from `PLAN.md`: artifacts stay outside the prompt and remain
preserved for inspection. Do not delete them at workflow settlement.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Target tests | `node --test --experimental-strip-types extensions/workflows/manager.test.ts` | all pass |
| Typecheck | `npm run check` | exit 0 |
| Full tests | `npm test` | all pass |

## Scope

**In scope**:

- `extensions/workflows/manager.ts`
- `extensions/workflows/artifacts.ts`
- `extensions/workflows/manager.test.ts`

**Out of scope**:

- Artifact history or resume support.
- Changing workflow IDs shown to users.
- Retention or cleanup policy.
- Moving artifacts into the repository.

## Git workflow

- Branch: `advisor/002-private-workflow-artifacts`
- Commit: `fix(workflows): isolate artifact directories`
- Stage explicit in-scope paths only.

## Steps

### Step 1: Add collision and permission regressions

Using the existing fake starters, create two `WorkflowManager` instances with
the same `artifactsRoot`. Start one workflow in each and assert:

- both user-facing IDs may remain `wf-1`;
- `artifactsDir` values differ;
- both paths are descendants of the configured root;
- each contains its own `goal.txt` content.

On non-Windows platforms, use `stat` to assert each per-workflow directory has
no group/other permission bits. Also assert representative files such as
`goal.txt` and `meta.json` have no group/other bits. Register both managers and
the shared root with existing cleanup arrays.

**Verify before the fix**:
`node --test --experimental-strip-types extensions/workflows/manager.test.ts`
→ the new distinct-directory assertion fails.

### Step 2: Create unique private workflow directories

Create the configured root if needed, then allocate each workflow directory
exclusively with Node's `mkdtemp`, using the readable workflow ID as the prefix.
Keep `WorkflowSnapshot.id` unchanged. Do not generate UUIDs or add a dependency.

Write newly created workflow files with mode `0o600`. Apply the same mode to
task artifacts, `outputs.json`, `status.json`, and `final.md`. Keep directory
creation recursive only for known descendants inside the unique workflow
directory.

**Verify**:
`node --test --experimental-strip-types extensions/workflows/manager.test.ts`
→ collision and permission tests pass.

### Step 3: Run repository gates

**Verify**:

- `npm run check` → exit 0.
- `npm test` → all tests pass.
- `git diff --check` → no whitespace errors.

## Test plan

- Two managers sharing one root cannot collide.
- Goals remain isolated.
- POSIX directory and representative file modes are private.
- Existing partial-failure, cancellation, synthesis, and persistence tests pass.

## Done criteria

- [ ] No workflow directory is derived solely from a manager-local counter.
- [ ] Two sessions can both create `wf-1` without sharing files.
- [ ] Workflow directories are private and created files use `0600`.
- [ ] `npm run check` and `npm test` pass.
- [ ] Only in-scope files and the index are modified.

## STOP conditions

- A consumer depends on `artifactsDir` ending exactly in `/wf-N`.
- Unique creation requires deleting or migrating existing artifacts.
- Tests reveal Windows permission assertions cannot be cleanly skipped.
- The change starts implementing workflow history or retention.

## Maintenance notes

Plan 016 must document the resulting artifact-root and retention behavior.
Read-only workflow history is deliberately deferred until unique identity is
stable. Review every `writeFile` in `extensions/workflows/` for explicit modes.
