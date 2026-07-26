# Plan 009: Wait for subprocess streams before settling

> **Executor instructions**: Follow each step and preserve exit/signal semantics.
> This plan changes event timing, not public result shapes. Update the index when
> complete.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- extensions/subagents/run.ts extensions/subagents/run.test.ts extensions/background-terminals/manager.ts extensions/background-terminals/manager.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-effective-subagent-kill-escalation.md
- **Category**: bug
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

Node may emit a child process's `exit` event while stdout or stderr is still
open. Both lifecycle implementations settle from `exit`; the terminal manager
then closes its output buffers. A trailing agent JSON event or log line can
therefore disappear even though the process itself succeeded.

## Current state

`extensions/subagents/run.ts:47-57` resolves `wait` from `error` or `exit` while
data listeners remain attached at lines 40-45.

`extensions/background-terminals/manager.ts:231-267` pushes stream data but
starts `settle()` from `child.once("exit")`. `settle()` closes both buffers at
lines 292-293, and `OutputBuffer.push()` ignores later chunks once closed.

Plan 001 will have adjusted signal/settlement bookkeeping in `run.ts`. Preserve
that behavior and build on it rather than recreating a second settled flag.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Subprocess tests | `node --test --experimental-strip-types extensions/subagents/run.test.ts` | all pass |
| Terminal tests | `node --test --experimental-strip-types extensions/background-terminals/manager.test.ts` | all pass |
| Gates | `npm run check && npm test` | exit 0 |

## Scope

**In scope**:

- `extensions/subagents/run.ts`
- `extensions/subagents/run.test.ts`
- `extensions/background-terminals/manager.ts`
- `extensions/background-terminals/manager.test.ts`

**Out of scope**:

- Output backpressure and TUI throttling; Plan 011 handles those.
- Parser behavior; Plan 010 handles large Pi JSONL.
- Changing exit codes, statuses, or snapshots.

## Git workflow

- Branch: `advisor/009-wait-for-subprocess-streams`
- Commit: `fix: settle subprocesses after stream close`

## Steps

### Step 1: Add trailing-stream regressions

Add POSIX-focused tests where an immediate child exits but a short-lived
grandchild inherits stdout and writes a unique `tail-after-parent-exit` marker
after a delay. This makes the process `exit` precede pipe closure without
depending on output volume.

- In `run.test.ts`, collect `onStdout`, await `handle.wait`, and assert the tail
  marker is already present.
- In `manager.test.ts`, start an equivalent background command, wait for the
  terminal to settle, and assert its snapshot contains the marker.
- Bound every wait and ensure grandchild cleanup.

**Verify before the fix**: at least one new test observes settlement before the
tail marker and fails.

### Step 2: Resolve `runProcess.wait` from close

Capture exit code/signal from the child lifecycle but resolve the public wait
only from `close`, which occurs after stdio closes. Keep the spawn-error path
settling exactly once. Integrate with Plan 001's stronger-signal state.

Do not await arbitrary timers or poll streams.

**Verify**:
`node --test --experimental-strip-types extensions/subagents/run.test.ts`
→ all tests pass.

### Step 3: Settle background terminals from close

Move normal done/failed/killed classification from `exit` to `close`. Preserve
the `spawnFailed` guard and error-event behavior. Ensure buffers close after
the final stream data has been handled.

**Verify**:
`node --test --experimental-strip-types extensions/background-terminals/manager.test.ts`
→ all tests pass.

### Step 4: Run full gates

**Verify**:

- `npm run check` → exit 0.
- `npm test` → all tests pass.
- `rg -n 'once\\(\"exit\"' extensions/subagents/run.ts extensions/background-terminals/manager.ts`
  → no settlement logic remains on `exit`; recording-only use is acceptable if
  clearly needed.
- `git diff --check` → clean.

## Test plan

- Trailing output held by an inherited pipe is present before wait/settlement.
- Exit 0, nonzero exit, killed, and spawn error existing tests stay green.
- Plan 001's stubborn-child test remains green.

## Done criteria

- [ ] Public waits settle only after relevant stdio closes.
- [ ] Terminal buffers are not closed before their last data event.
- [ ] Exit/status semantics are unchanged.
- [ ] Full gates pass.

## STOP conditions

- Plan 001 has not landed or its signal state conflicts with a close-based wait.
- The regression requires a permanent child or unbounded timeout.
- Node's `close` behavior differs on a supported platform in a way that changes
  statuses.

## Maintenance notes

Any future stream consumer must attach listeners before process completion and
settle on `close`. Review spawn-error paths for double resolution.
