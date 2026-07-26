# Plan 018: Keep async test drivers alive on Node 22

> **Executor instructions**: Fix only the test harness timers that let Node 22
> exit while async assertions are still pending. Preserve production timer
> semantics. Update the index when done.
>
> **Drift check (run first)**:
> `git diff --stat 872a5cb..HEAD -- extensions/subagents/manager.test.ts extensions/workflows/manager.test.ts extensions/web-research/firecrawl.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: test / release
- **Planned at**: commit `872a5cb`, 2026-07-26

## Why this matters

Plan 013's release gate passes on Node 24.14.1 but the existing suite cancels
18 tests on Node 22.22.2 with:

```text
Promise resolution is still pending but the event loop has already resolved
```

The first failures are driven by test-only unreferenced timers. This blocks the
documented Node 22 release line before CI can be made authoritative.

## Current state

`extensions/subagents/manager.test.ts:25` and
`extensions/workflows/manager.test.ts:33` call `.unref()` on the timers that
resolve fake backend jobs. The tests then await those jobs; on Node 22 the
pending promises alone do not keep the test process alive.

`extensions/web-research/firecrawl.test.ts:92-139` intentionally exercises a
second crawl poll. Production polling uses the shared unreferenced `sleep()`,
so that test also needs a test-owned referenced handle until its awaited poll
finishes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Node 22 target files | `fnm exec --using 22.22.2 -- node --test --experimental-strip-types extensions/subagents/manager.test.ts extensions/workflows/manager.test.ts extensions/web-research/firecrawl.test.ts` | all target tests pass, none cancelled |
| Node 22 full suite | `fnm exec --using 22.22.2 -- npm test` | all 92 tests pass |
| Current runtime gate | `npm run check && npm test` | exit 0 |
| Diff check | `git diff --check` | clean |

## Scope

**In scope**:

- `extensions/subagents/manager.test.ts`
- `extensions/workflows/manager.test.ts`
- `extensions/web-research/firecrawl.test.ts`

**Out of scope**:

- Production lifecycle, timer, polling, or cancellation behavior.
- New dependencies, test frameworks, shared helpers, or configuration.
- Plan 013's manifest, smoke script, or CI files.

## Git workflow

- Branch: `advisor/018-node-22-async-test-drivers`
- Commit: `test: keep async drivers alive on Node 22`

## Steps

### Step 1: Keep fake backend completion timers referenced

Remove `.unref()` only from the two test-local `fakeJob()` timers. These timers
are the fixtures' completion mechanism and must keep the runner alive until the
awaited fake job settles.

**Verify**:

- The subagent and workflow manager target tests pass on Node 22.22.2.
- Kill/cancel tests still settle without leaving referenced timers behind.

### Step 2: Keep the Firecrawl polling test alive

In only the test that requires a second poll, hold one referenced test timer or
interval for the duration of the awaited crawl and clear it in `finally`.
Do not change `extensions/shared/time.ts` or production Firecrawl code.

**Verify**:

- The crawl test still performs two GET requests and asserts the completed
  response.
- The Firecrawl test file passes on Node 22.22.2 without cancelled tests or
  leaked-handle delay.

### Step 3: Run both runtime gates

Run the target tests and full suite on Node 22.22.2, then run the repository
type-check and tests on the current host runtime.

## Test plan

This plan changes only test lifetimes. Existing assertions remain the
characterization tests; the regression signal is zero cancelled tests on Node
22 plus unchanged pass results on the current runtime.

## Done criteria

- [ ] Node 22.22.2 reports all 92 tests passing and zero cancelled.
- [ ] Existing async lifecycle assertions are unchanged.
- [ ] Production code is untouched.
- [ ] Current-runtime type-check and tests pass.
- [ ] `git diff --check` is clean.

## STOP conditions

- Removing test-only `.unref()` exposes a production lifecycle failure.
- Passing Node 22 requires changing production timer semantics.
- Any test remains cancelled after the three scoped fixture changes.
- Referenced test handles leak after successful assertions.

## Maintenance notes

Test fixtures that resolve awaited work must keep their completion drivers
referenced. Production timers may remain unreferenced when they should not keep
the Pi host alive.
