# Plan 010: Preserve large Pi final messages outside the log tail

> **Executor instructions**: Keep diagnostic output bounded while preserving the
> complete latest assistant message. Do not redesign the Codex backend. Update
> the index after all gates pass.
>
> **Drift check (run first)**:
> `git diff --stat 8be9260..HEAD -- extensions/subagents/run.ts extensions/subagents/run.test.ts extensions/subagents/backends/pi.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/009-wait-for-subprocess-streams.md
- **Category**: bug
- **Planned at**: commit `8be9260`, 2026-07-26 (reconciled after plans 001 and 009)

## Why this matters

Pi stdout is JSONL, but the backend first truncates it to an 80,000-character
tail and parses only after process exit. A final assistant event larger than
that loses its opening JSON bytes, so a valid successful worker becomes
`(no final message)`. Parse complete JSONL records as they arrive and retain the
latest assistant text separately from the bounded diagnostic tail.

## Current state

`extensions/subagents/backends/pi.ts:61-82` appends stdout and stderr into the
same bounded `output`, then calls `extractPiLastAssistantText(output)`.

`extensions/subagents/run.ts:114-137` truncates arbitrary characters and later
parses newline-separated JSON. Plan 009's close-based process wait is now in
place above it. Existing parser tests are in `extensions/subagents/run.test.ts`.

Pi event shape currently used:

```ts
{
  type: "message_end",
  message: { role: "assistant", content: [...] }
}
```

Keep `output` bounded for status/error diagnostics.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Target tests | `node --test --experimental-strip-types extensions/subagents/run.test.ts` | all pass |
| Gates | `npm run check && npm test` | exit 0 |

## Scope

**In scope**:

- `extensions/subagents/run.ts`
- `extensions/subagents/run.test.ts`
- `extensions/subagents/backends/pi.ts`

**Out of scope**:

- Codex output parsing.
- Limiting the final result text itself.
- Changing Pi CLI arguments or session isolation.
- A generic JSON streaming library.

## Git workflow

- Branch: `advisor/010-preserve-large-pi-results`
- Commit: `fix(subagents): preserve large Pi results`

## Steps

### Step 1: Add chunked large-record tests

Add tests for a minimal incremental Pi JSONL collector:

- two complete events across arbitrary chunk boundaries return the last;
- a final assistant text longer than 100,000 characters is preserved exactly;
- malformed/non-JSON lines are ignored;
- a final record without a trailing newline is handled on finish;
- partial records do not appear as results.

Use generated text, not a large checked-in fixture.

**Verify before the fix**: the current bounded-tail pipeline cannot satisfy the
large-record case.

### Step 2: Add the smallest incremental collector

In `run.ts`, add a small testable helper that owns:

- one incomplete-line remainder;
- the latest successfully parsed assistant text;
- `push(chunk)` for complete newline-delimited records;
- `finish()` for the final unterminated record.

Reuse the existing Pi event parsing and `contentToText`; do not add a class
hierarchy or dependency. Keep `extractPiLastAssistantText()` working for
existing callers/tests, preferably by reusing the same single-record parser.

**Verify**:
`node --test --experimental-strip-types extensions/subagents/run.test.ts`
→ all incremental and existing parser tests pass.

### Step 3: Use it in the Pi backend

Create one collector in `startPiBackend()`. Feed stdout chunks to both:

- the collector, for result extraction;
- the existing bounded output tail, for diagnostics.

Feed stderr only to diagnostics. After `handle.wait`, finish the collector and
use its latest assistant text. Do not reconstruct the result from bounded
output.

**Verify**:
`node --test --experimental-strip-types extensions/subagents/run.test.ts`
→ all pass.

### Step 4: Run full gates

**Verify**:

- `npm run check` → exit 0.
- `npm test` → all tests pass.
- `rg -n 'extractPiLastAssistantText\\(output\\)' extensions/subagents/backends/pi.ts`
  → no matches.
- `git diff --check` → clean.

## Test plan

Tests cover normal, chunked, malformed, unterminated, and >100k final events.
No real Pi process or model call is required.

## Done criteria

- [ ] Result extraction does not depend on the bounded diagnostic tail.
- [ ] A >100k final event is preserved exactly.
- [ ] Diagnostic output remains bounded.
- [ ] Full gates pass.

## STOP conditions

- Pi 0.82.1 uses a different final event shape than the current parser/tests.
- Plan 009 has not landed and process wait may still precede final stdout.
- Correctness requires retaining all JSONL events rather than only a remainder
  and latest result.

## Maintenance notes

If Pi changes JSON event shapes, update the single-record parser and its tests.
Do not increase the diagnostic tail to mask parser regressions.
