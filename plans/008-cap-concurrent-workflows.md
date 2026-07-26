# Plan 008: Cap concurrent workflows at the manager boundary

> **Executor instructions**: Add only a manager-level rejection limit. Do not
> build a queue or shared scheduler. Run every gate and update the index.
>
> **Drift check (run first)**:
> `git diff --stat c617b27..HEAD -- extensions/workflows/manager.ts extensions/workflows/manager.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/005-reserve-concurrency-slots.md
- **Category**: perf
- **Planned at**: commit `c617b27`, 2026-07-26 (reconciled after plans 002 and 005)

## Why this matters

Every workflow creates its own `SubagentManager`, so the four-worker subagent
limit is per workflow rather than package-wide. Repeated `wf_start` calls can
multiply subprocesses and model spend without bound. The current fixed
five-task workflow is already substantial; one running workflow by default is
the lazy safe limit.

## Current state

`extensions/workflows/manager.ts:21` defines only `DEFAULT_MAX_TRACKED`.
`WorkflowManagerOptions` at lines 59-67 has no running limit. `start()` at
lines 97-106 validates goal/cwd but not capacity. Plan 002's artifact directory
creation now starts at line 114, and a fresh subagent manager is created at
lines 157-160.

Existing manager tests and fake jobs are in
`extensions/workflows/manager.test.ts:22-123`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Target tests | `node --test --experimental-strip-types extensions/workflows/manager.test.ts` | all pass |
| Gates | `npm run check && npm test` | exit 0 |

## Scope

**In scope**:

- `extensions/workflows/manager.ts`
- `extensions/workflows/manager.test.ts`

**Out of scope**:

- A shared subagent semaphore.
- Queuing workflows.
- New `wf_start` parameters or configuration files.
- Changing phase-level parallelism.

## Git workflow

- Branch: `advisor/008-cap-concurrent-workflows`
- Commit: `fix(workflows): cap concurrent runs`

## Steps

### Step 1: Add capacity tests

Extend the existing test helper so a manager can receive `maxRunning`. With a
delayed fake starter and `maxRunning: 1`:

1. start the first workflow;
2. assert a second start rejects with a clear `Concurrency limit` message;
3. wait for the first workflow to settle;
4. assert a later workflow can start.

Also confirm settled workflows still count only toward `maxTracked`.

**Verify before the fix**:
`node --test --experimental-strip-types extensions/workflows/manager.test.ts`
→ the second start is accepted and the new test fails.

### Step 2: Add the minimal running limit

Add `maxRunning?: number` to `WorkflowManagerOptions`, a private field, and a
`runningCount()` matching the simple loops in the terminal/subagent managers.
Default to `1`. Check capacity at the beginning of `start()` before creating
artifact directories.

Reject excess starts; do not queue them. Use a message naming the configured
limit.

**Verify**:
`node --test --experimental-strip-types extensions/workflows/manager.test.ts`
→ all tests pass.

### Step 3: Run full gates

**Verify**:

- `npm run check` → exit 0.
- `npm test` → all tests pass.
- `git diff --check` → clean.

## Test plan

- One running workflow blocks another.
- Capacity returns after settlement.
- Historical settled entries do not consume running capacity.
- Existing partial/cancel/fallback behavior remains green.

## Done criteria

- [ ] Default aggregate workflow concurrency is one.
- [ ] Excess starts fail before artifacts or subagents are created.
- [ ] Capacity is released on every settled status.
- [ ] No queue or global scheduler was added.
- [ ] Full gates pass.

## STOP conditions

- Product requirements explicitly require concurrent workflows by default.
- Limit enforcement needs changes to `SubagentManager`.
- Plan 005 has not landed and process startup slots remain racy.

## Maintenance notes

Raise the default only with real usage evidence. If multiple concurrent
workflows become necessary, a shared subagent budget is a separate design task.
