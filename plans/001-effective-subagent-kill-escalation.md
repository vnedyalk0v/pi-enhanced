# Plan 001: Make subagent kill escalation effective

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report; do not improvise. When done, update
> this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- extensions/subagents/run.ts extensions/subagents/run.test.ts`
> If either file changed, compare the excerpts below with live code before
> proceeding. A behavioral mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

`RunHandle.kill()` permanently ignores every call after the first signal. The
manager promises SIGTERM followed by SIGKILL, but a worker that ignores SIGTERM
never receives SIGKILL and can continue editing files after cancellation or
session shutdown. The audit reproduced this: a SIGTERM-ignoring child exited
naturally after 1.5 seconds even though `kill("SIGKILL")` was called.

## Current state

- `extensions/subagents/run.ts` owns real Pi/Codex subprocess creation and
  process-group termination.
- `extensions/subagents/run.test.ts` contains focused parser/helper tests and is
  the correct location for one real process-lifecycle regression test.
- `extensions/subagents/manager.ts:337-341` already performs the intended
  SIGTERM-then-SIGKILL sequence; do not duplicate escalation there.

Current lockout in `extensions/subagents/run.ts:59-62`:

```ts
const kill = (signal: NodeJS.Signals = "SIGTERM") => {
  if (killed) return;
  killed = true;
```

Abort escalation in `extensions/subagents/run.ts:86-90`:

```ts
const onAbort = () => {
  kill("SIGTERM");
  setTimeout(() => kill("SIGKILL"), 2000).unref?.();
};
```

Repository convention: lifecycle logic gets one focused `node:test`; model new
tests after `extensions/background-terminals/manager.test.ts:72-90`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Target test | `node --test --experimental-strip-types extensions/subagents/run.test.ts` | all tests pass |
| Typecheck | `npm run check` | exit 0, no errors |
| Full tests | `npm test` | all tests pass |

## Scope

**In scope**:

- `extensions/subagents/run.ts`
- `extensions/subagents/run.test.ts`

**Out of scope**:

- `extensions/subagents/manager.ts` — its escalation sequence is already right.
- `extensions/background-terminals/manager.ts` — it has a separate working
  termination implementation.
- Redesigning Windows process-tree semantics.
- Adding a process-management dependency.

## Git workflow

- Branch: `advisor/001-effective-subagent-kill-escalation`
- Commit: `fix(subagents): allow SIGKILL escalation`
- Stage only the two in-scope files. Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a process-level regression test

Import `runProcess` into `extensions/subagents/run.test.ts`. Add one POSIX-only
test that starts `process.execPath` with a small inline script which:

1. installs a no-op `SIGTERM` handler;
2. prints a ready marker;
3. stays alive with an interval.

Wait for the ready marker, call `handle.kill("SIGTERM")`, then
`handle.kill("SIGKILL")` after a short delay. Assert `handle.wait` settles
quickly and reports `SIGKILL`. Skip on Windows because the current backend uses
`taskkill` rather than POSIX signals. Ensure failure cleanup force-kills the
child so a failing test cannot leak it.

**Verify before the fix**:
`node --test --experimental-strip-types extensions/subagents/run.test.ts`
→ the new regression test fails or times out at its bounded deadline while the
existing tests still pass.

### Step 2: Permit stronger later signals

Replace the one-shot `killed` boolean with the minimum state needed to:

- ignore signals after the child has settled;
- avoid repeating the same signal unnecessarily;
- allow `SIGKILL` after `SIGTERM`;
- retain process-group kill with child fallback on POSIX;
- preserve current `taskkill` behavior on Windows.

Mark the process settled from both `error` and `exit` paths. Do not introduce a
new class or signal-state abstraction.

**Verify**:
`node --test --experimental-strip-types extensions/subagents/run.test.ts`
→ the new stubborn-child test and all existing tests pass.

### Step 3: Run repository gates

**Verify**:

- `npm run check` → exit 0.
- `npm test` → all tests pass.
- `git diff --check` → no whitespace errors.

## Test plan

- Existing parser and truncation tests remain unchanged.
- New test proves SIGTERM can be escalated to SIGKILL.
- New test has bounded cleanup and skips only on Windows.
- Use the real `runProcess`; a fake handle would reproduce the manager contract,
  not the bug.

## Done criteria

- [ ] `RunHandle.kill("SIGKILL")` is not blocked by an earlier SIGTERM.
- [ ] A SIGTERM-ignoring child is reaped by the regression test.
- [ ] `npm run check` exits 0.
- [ ] `npm test` passes.
- [ ] Only the two in-scope files and `plans/README.md` are modified.
- [ ] The index row is updated.

## STOP conditions

- The current manager no longer performs SIGTERM followed by SIGKILL.
- Correctness requires changing public `RunHandle` fields or backend APIs.
- The POSIX test cannot be made deterministic with a ready marker and bounded
  cleanup.
- Windows behavior must be redesigned to make the POSIX fix work.

## Maintenance notes

Reviewers should scrutinize duplicate-signal handling, process-group fallback,
and test cleanup. Plan 009 later changes when `wait` settles; re-run this
process test after that plan.
