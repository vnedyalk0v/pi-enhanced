# Plan 005: Reserve concurrency slots before asynchronous startup

> **Executor instructions**: Execute each step and verification gate. Keep the
> fix to slot accounting; do not redesign either manager. Update the index when
> done.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- extensions/background-terminals/manager.ts extensions/background-terminals/manager.test.ts extensions/subagents/manager.ts extensions/subagents/manager.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

Both managers check the number of registered running entries and then await
startup work before registering the new entry. Parallel tool calls can all see
the same spare capacity and exceed the advertised limit. A synchronous
reservation counter is sufficient; no queue or semaphore is needed.

## Current state

Terminal startup checks at `extensions/background-terminals/manager.ts:151-159`,
then awaits spill setup at line 175 and registers at line 269.

Subagent startup checks at `extensions/subagents/manager.ts:125-131`, then awaits
the backend starter at lines 175-193 and registers at line 201.

Existing single-start tests:

- `extensions/background-terminals/manager.test.ts:102-109`
- `extensions/subagents/manager.test.ts:119-131`

Both managers use simple private counters and maps; match that style.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Terminal tests | `node --test --experimental-strip-types extensions/background-terminals/manager.test.ts` | all pass |
| Subagent tests | `node --test --experimental-strip-types extensions/subagents/manager.test.ts` | all pass |
| Gates | `npm run check && npm test` | exit 0 |

## Scope

**In scope**:

- `extensions/background-terminals/manager.ts`
- `extensions/background-terminals/manager.test.ts`
- `extensions/subagents/manager.ts`
- `extensions/subagents/manager.test.ts`

**Out of scope**:

- Queuing excess starts.
- Sharing limits across workflows; Plan 008 handles workflow count.
- New public options or tool parameters.
- Changing settled-entry pruning.

## Git workflow

- Branch: `advisor/005-reserve-concurrency-slots`
- Commit: `fix: reserve process startup slots`

## Steps

### Step 1: Add deterministic concurrent-start tests

For `SubagentManager`, inject a starter blocked on a promise. Begin the first
`spawn()` without releasing the starter, then attempt a second with
`maxRunning: 1`; assert it rejects with `Concurrency limit`. Release the first
starter and let cleanup finish.

For `TerminalManager`, issue several starts concurrently with `maxRunning: 1`
using a long-lived command. Assert exactly one start succeeds and every other
result rejects with `Concurrency limit`; kill the successful terminal. Keep the
test POSIX-compatible with existing commands and skip only if the existing
suite already skips that platform.

Add a subagent case where a starter throws, then verify a later spawn can use
the released slot.

**Verify before the fix**: targeted tests demonstrate more than one concurrent
start enters startup or otherwise fail the new assertions.

### Step 2: Reserve and release terminal startup slots

Add one private numeric `startingCount`. Include it in the limit check, then
increment synchronously after input/cwd validation and before the first startup
await. Decrement exactly once:

- after the entry becomes registered;
- or in a `finally` path when spill setup or `spawn()` fails.

Do not count registered entries twice. Keep the existing `runningCount()`.

**Verify**:
`node --test --experimental-strip-types extensions/background-terminals/manager.test.ts`
→ all tests pass.

### Step 3: Reserve and release subagent startup slots

Apply the same minimal counter pattern around the awaited Pi/Codex starter.
Failed starters must release the reservation before the wrapped start error is
thrown.

**Verify**:
`node --test --experimental-strip-types extensions/subagents/manager.test.ts`
→ all tests pass, including failed-start release.

### Step 4: Run full gates

**Verify**:

- `npm run check` → exit 0.
- `npm test` → all tests pass.
- `git diff --check` → clean.

## Test plan

- Existing sequential limit tests remain green.
- Parallel starts cannot oversubscribe a limit of one.
- A failed asynchronous starter releases its slot.
- Cleanup leaves no child process running.

## Done criteria

- [ ] Limit checks include registered and starting jobs.
- [ ] All success and failure paths release reservations exactly once.
- [ ] No queue/semaphore abstraction was added.
- [ ] Full gates pass.
- [ ] Only in-scope files and the index are modified.

## STOP conditions

- Parallel Pi tool execution is disabled upstream and cannot exercise the race;
  still report rather than deleting the regression.
- Deterministic terminal coverage requires a new production injection API.
- Correct accounting requires changing public snapshots or IDs.

## Maintenance notes

Future startup awaits must remain inside the reservation lifetime. Reviewers
should inspect every throw path between reservation and map insertion.
