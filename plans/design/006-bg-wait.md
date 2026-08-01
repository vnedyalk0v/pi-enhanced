# Design spike: `bg_wait`

This document designs a blocking wait for background terminals. The accompanying
manager method and two focused tests are a throwaway proof of concept; this spike
does not register a public tool.

## 1. Tool signature

The eventual tool should accept one or more terminal IDs and an optional bounded
wait:

```ts
const WaitParams = Type.Object({
  ids: Type.Array(Type.String(), {
    description: 'Terminal ids to wait for, e.g. ["bt-1"]',
  }),
  timeout_ms: Type.Optional(
    Type.Integer({
      minimum: 100,
      maximum: 300_000,
      description: "Maximum time to wait in milliseconds (default: 30000)",
    }),
  ),
});
```

The tool executor should reject an empty `ids` array, matching `bg_kill`, and
call `manager.wait(params.ids, params.timeout_ms ?? 30_000, signal)`. The manager
returns `Promise<TerminalSnapshot[]>` in input order; the future tool result can
derive `timedOut` with `snapshots.some((snapshot) => snapshot.status === "running")`.

## 2. Never-exits decision

| Option | Assessment |
|---|---|
| Required timeout | Honest, but makes every call noisier and breaks the simple `sa_wait`/`wf_wait` shape. |
| Optional timeout with a default ceiling | Bounds every call while keeping the common call to `bg_wait({ ids })` small. |
| No timeout; caller abort only | Matches sibling tools, but an unattended dev server can occupy the turn forever. |
| Refuse after N seconds without output | Activity is not completion: quiet builds are valid and noisy watchers can still run forever. |

**Recommendation:** Use an optional `timeout_ms`, defaulting to 30 seconds and
capped at 5 minutes. This preserves a compact default call while making an
indefinite terminal safe. Longer observation belongs in another explicit wait.

## 3. Return shape on timeout

Timeout is a successful bounded observation, not an exceptional failure. Return
the requested snapshots, including `status: "running"` for terminals that did
not settle; the future formatter must say that the wait timed out so the model
does not mistake a running snapshot for completion. Abort and unknown IDs still
throw.

## 4. Deduplication

`TerminalManager.wait()` must call `InterestTracker.add(id)` for every validated
ID before its first `await`. `settle()` already reads the same tracker before it
resolves `settlePromise`, so `onSettled({ consumed: true })` suppresses async
delivery for terminals collected by the active wait. In a `finally` block,
release every ID and call `pruneAfterInterestRelease()`, matching the release
pattern in `kill()`; a timeout or abort releases interest immediately so a later
settlement can be delivered normally.

`ResultDelivery.consume()` is not part of this guarantee. `onSettled` currently
enqueues and synchronously drains delivery, so the `consumed` flag from
`InterestTracker` is the only live suppression path.

## 5. Abort path

If the surrounding tool signal aborts, reject with `Wait aborted; terminals
continue in the background.` No process is signaled or otherwise changed;
interest is released in `finally`, and terminals that settle later produce their
normal async completion message. A terminal that settled before the abort was
consumed while the waiter was active, matching current `sa_wait` and `wf_wait`
semantics.

## 6. Extraction sketch

For the production implementation, extract a private helper from the wait-only
parts of `kill()`:

```ts
private async awaitSettled(
  ids: readonly string[],
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  abortMessage: string,
): Promise<TerminalSnapshot[]>
```

The helper owns the current unknown-ID check (`manager.ts:404-407`), interest
registration and `settlePromise` collection (`manager.ts:409-425,429`), the
`Promise.race`/disposal check/snapshot refresh (`manager.ts:439-452`), and the
release/prune `finally` block (`manager.ts:453-468`). Rename `killInterest` to
`settleInterest` when both callers use it.

`kill()` keeps `KillResult`, `alreadySettled`, `killSignaled`,
`terminateChild()`, and the abort rule that retains interest until termination
settles. `wait()` adds only the timeout race and never mutates the child. The PoC
intentionally duplicates the small wait sequence rather than refactoring
`kill()` before the public behavior is approved.

## 7. Test list for the eventual build

- Wait on an already-settled terminal; return its final snapshot immediately in
  the requested position.
- Wait on two terminals where one settles first; do not resolve until both have
  settled, preserve input order, and report `consumed: true` for each completion.
- Timeout while a terminal remains active; return a `running` snapshot, then
  verify its later completion has `consumed: false`.
- Abort mid-wait; reject with the documented message, leave the child running,
  and allow a later completion notification.
- Complete a wait and verify no second async completion is delivered
  (`onSettled` receives `consumed: true`).
- Reject unknown IDs before registering any interest.
- Dispose during a wait; reject with a disposal error rather than reading entries
  after `disposeAll()` clears them.

The PoC implements the two load-bearing combined cases: multi-terminal ordering
plus completed-wait dedup, and timeout plus later-delivery behavior.

## 8. Open questions

- The 30-second default and 5-minute ceiling are product choices, not values the
  code can prove; the maintainer should confirm them before shipping.
- An abort after one of several terminals settles suppresses that terminal's
  completion even though the wait returns no snapshots. This matches sibling
  waits, but the maintainer may prefer future partial-result delivery across all
  three job families.
- If this timeout policy works well, should `sa_wait` and `wf_wait` adopt the same
  optional bound? That is a separate compatibility change.

## Production follow-up

If the tool ships, register and format `bg_wait`, update the background-terminal
skill and README, and include it in package smoke coverage. Do not fix the
`ResultDelivery.consume()` no-op as part of that feature unless it is separately
planned.
