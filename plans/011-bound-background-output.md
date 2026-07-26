# Plan 011: Bound background-terminal output end to end

> **Executor instructions**: Use Node stream backpressure and one small render
> throttle. Preserve complete spill logs and responsive lifecycle updates. Do
> not add configuration or dependencies. Update the index when done.
>
> **Drift check (run first)**:
> `git diff --stat 8be9260..HEAD -- extensions/background-terminals/output.ts extensions/background-terminals/output.test.ts extensions/background-terminals/manager.ts extensions/background-terminals/manager.test.ts extensions/background-terminals/index.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/005-reserve-concurrency-slots.md, plans/009-wait-for-subprocess-streams.md
- **Category**: perf
- **Planned at**: commit `8be9260`, 2026-07-26 (reconciled after plans 005 and 009)

## Why this matters

`OutputBuffer` ignores a spill stream's `false` write result, allowing Node's
internal writable queue to grow with noisy commands. Every chunk also rebuilds
snapshots and the widget, joining up to 2 MiB per stream. Pi can therefore lag
or consume unbounded queued memory despite its nominal retained-output cap.

## Current state

`extensions/background-terminals/output.ts:52-54`:

```ts
if (this.spillStream && !this.spillError) {
  this.spillStream.write(chunk);
}
```

`extensions/background-terminals/manager.ts:236-243` calls `notify()` for every
stdout/stderr chunk. Plan 009 now settles from `close` at lines 245-278.
`extensions/background-terminals/index.ts:58-60` turns
every notification into `updateWidget()`, whose current implementation calls
`manager.list()` and materializes full snapshots.

`OutputBuffer` tests live in `output.test.ts`; lifecycle tests live in
`manager.test.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Target tests | `node --test --experimental-strip-types extensions/background-terminals/output.test.ts extensions/background-terminals/manager.test.ts` | all pass |
| Gates | `npm run check && npm test` | exit 0 |

## Scope

**In scope**:

- `extensions/background-terminals/output.ts`
- `extensions/background-terminals/output.test.ts`
- `extensions/background-terminals/manager.ts`
- `extensions/background-terminals/manager.test.ts`
- `extensions/background-terminals/index.ts`

**Out of scope**:

- Changing the 2 MiB retained-output ceiling.
- Removing complete spill logs.
- Rebuilding `/ps`.
- User-configurable throttle settings.
- Sharing file-search collector code.

## Git workflow

- Branch: `advisor/011-bound-background-output`
- Commit: `perf(background): honor output backpressure`

## Steps

### Step 1: Add backpressure behavior to OutputBuffer tests

Use a real writable stream with a deliberately tiny `highWaterMark` in a temp
directory. Assert:

- `push()` reports backpressure when the spill cannot accept more;
- a drain wait resolves;
- all bytes reach the file in order after `close()`;
- retained tail and byte counters remain correct;
- spill errors still remove the advertised spill path.

Keep the production constructor compatible with existing `openSpillStreams()`.

**Verify before the fix**: the current void `push()` cannot expose or await
backpressure.

### Step 2: Expose minimal drain coordination

Make `OutputBuffer.push()` return whether the spill accepted the write. Add one
small method that resolves on `drain` or immediately when no healthy stream is
present. Do not expose the underlying `WriteStream`.

**Verify**:
`node --test --experimental-strip-types extensions/background-terminals/output.test.ts`
→ all tests pass.

### Step 3: Pause and resume child readable streams

In stdout/stderr data handlers, if `push()` reports backpressure:

1. pause that specific child readable;
2. wait for the matching spill buffer to drain;
3. resume only if the entry is still running.

Avoid multiple concurrent drain waits for the same stream. Preserve Plan 009's
close-based settlement.

**Verify**:
`node --test --experimental-strip-types extensions/background-terminals/manager.test.ts`
→ complete output and lifecycle tests pass.

### Step 4: Throttle output-only notifications

Keep immediate `notify()` for starts, exits, kills, and state changes. Replace
per-chunk notification with one pending timer at a fixed short interval
(approximately 100 ms). Clear it during disposal.

Expose a cheap `getRunningCount()` that loops entries without snapshots and use
it in `index.ts` for the widget. `/ps` may still refresh on throttled output.
Do not add a general event bus.

Add a noisy-process test asserting output is captured while `onChange` calls
are substantially fewer than emitted chunks. Avoid exact timing counts.

**Verify**:
target tests pass and no process/timer remains after cleanup.

### Step 5: Run full gates

**Verify**:

- `npm run check` → exit 0.
- `npm test` → all tests pass.
- `git diff --check` → clean.

## Test plan

- Real backpressure preserves every spill byte.
- In-memory tail remains bounded.
- Noisy output yields coalesced notifications.
- Start and settle notifications remain immediate.
- Disposal clears timers and processes.

## Done criteria

- [ ] Spill backpressure pauses the matching readable stream.
- [ ] Complete logs remain byte-complete.
- [ ] Output notifications are coalesced.
- [ ] Widget count no longer materializes snapshots.
- [ ] Full gates pass.

## STOP conditions

- Plan 009 has not landed and streams still settle from `exit`.
- Backpressure support would require dropping full logs.
- Throttling makes lifecycle state changes delayed.
- Tests require a new external dependency or global timer mocking.

## Maintenance notes

Reviewers should stress noisy stdout and stderr independently. The fixed
throttle is deliberate; add configuration only if measured real-session needs
differ.
