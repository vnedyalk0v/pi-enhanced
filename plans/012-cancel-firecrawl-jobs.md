# Plan 012: Cancel Firecrawl crawl jobs after local abandonment

> **Executor instructions**: Implement best-effort remote cleanup without
> masking the original abort, timeout, or polling error. Use the existing fetch
> path and mocked tests. Update the index when done.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- extensions/web-research/firecrawl.ts extensions/web-research/firecrawl.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

After `POST /crawl` returns an ID, local abort or timeout throws without
stopping the remote job. Firecrawl v2 provides `DELETE /crawl/{id}` specifically
for cancellation. A best-effort delete prevents abandoned work while retaining
the original tool error if cleanup itself fails.

## Current state

`extensions/web-research/firecrawl.ts:64-83` starts a job and records its ID.
The polling loop at lines 88-114 throws on abort, failure, or timeout but has no
cleanup.

`requestJson()` at lines 122-155 currently accepts only `"GET" | "POST"`.

Official API reference:
`https://docs.firecrawl.dev/api-reference/v2-endpoint/crawl-delete`

Existing fetch mocks and crawl tests are in
`extensions/web-research/firecrawl.test.ts:16-125`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Target tests | `node --test --experimental-strip-types extensions/web-research/firecrawl.test.ts` | all pass |
| Gates | `npm run check && npm test` | exit 0 |

## Scope

**In scope**:

- `extensions/web-research/firecrawl.ts`
- `extensions/web-research/firecrawl.test.ts`

**Out of scope**:

- Changing search/scrape fallback policy.
- Retry/backoff infrastructure.
- Surfacing a new public cancel tool.
- Live Firecrawl calls in tests.

## Git workflow

- Branch: `advisor/012-cancel-firecrawl-jobs`
- Commit: `fix(web-research): cancel abandoned crawls`

## Steps

### Step 1: Add mocked cancellation tests

Extend the fetch mock to record method and URL. Cover:

- local timeout after a job ID causes one `DELETE /v2/crawl/{id}`;
- an aborted poll causes the same delete;
- completed jobs are not deleted;
- provider-reported cancelled/failed terminal states are not redundantly
  deleted;
- a failed delete does not replace the original timeout/abort error.

Use very small `maxWaitMs` and mocked responses; do not wait real seconds.

**Verify before the fix**:
`node --test --experimental-strip-types extensions/web-research/firecrawl.test.ts`
→ delete assertions fail.

### Step 2: Add best-effort cancellation

Allow `"DELETE"` in the private request helper. After a crawl ID exists, track
whether the provider reached a terminal status. If local code abandons a
nonterminal job for any thrown reason, attempt `DELETE /crawl/{encoded id}`.

Catch cleanup failure and rethrow the original error unchanged. Do not classify
or expose the cleanup error unless existing diagnostics can include it without
changing the primary error.

**Verify**:
`node --test --experimental-strip-types extensions/web-research/firecrawl.test.ts`
→ all tests pass.

### Step 3: Run full gates

**Verify**:

- `npm run check` → exit 0.
- `npm test` → all tests pass.
- `git diff --check` → clean.

## Test plan

All tests use injected `fetchImpl`. They cover timeout, abort, completion,
provider failure/cancel, and cleanup failure. No credential or live request is
allowed.

## Done criteria

- [ ] Nonterminal abandoned crawls receive a best-effort DELETE.
- [ ] Completed/terminal jobs are not deleted.
- [ ] Cleanup failure never masks the original error.
- [ ] Full gates pass.

## STOP conditions

- Firecrawl's current v2 cancel endpoint no longer matches the cited reference.
- Cancellation needs new credentials or permissions beyond the existing API
  key.
- Correctness requires changing public tool error formats.

## Maintenance notes

If Firecrawl later adds batch or search jobs, do not generalize this helper
until a second asynchronous cancellation call site exists.
