# Plan 007: Bound file-search output while it is produced

> **Executor instructions**: Follow each gate and preserve the current tool
> result contract. Prefer Node streams and existing Pi truncation constants; do
> not add a dependency. Update the index when done.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- extensions/file-search/run.ts extensions/file-search/index.ts extensions/file-search/run.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/003-terminate-fd-options.md
- **Category**: perf
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

`runBinary()` concatenates all stdout and stderr before applying Pi's 50 KiB /
2,000-line model limit. A broad search can exhaust the parent process and then
copy the same output again into a spill file. The collector must bound memory
while preserving a readable head, exact exit behavior, match count, and full
output path when truncated.

## Current state

`extensions/file-search/run.ts:69-86`:

```ts
let stdout = "";
let stderr = "";
child.stdout.on("data", (c: Buffer) => {
  stdout += c.toString("utf8");
});
child.stderr.on("data", (c: Buffer) => {
  stderr += c.toString("utf8");
});
```

`truncateToolOutput()` at lines 90-120 runs only after exit and writes the
already-buffered string to a temp file.

`extensions/file-search/index.ts:110-125` and `:159-180` consume
`stdout`, `stderr`, `exitCode`, line count, truncation state, and optional full
path. Preserve those tool-visible semantics.

Repository convention: full output may live in an OS-temp file and model output
uses Pi's `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, and `truncateHead`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Target tests | `node --test --experimental-strip-types extensions/file-search/run.test.ts extensions/file-search/binaries.test.ts` | all pass |
| Gates | `npm run check && npm test` | exit 0 |

## Scope

**In scope**:

- `extensions/file-search/run.ts`
- `extensions/file-search/index.ts`
- `extensions/file-search/run.test.ts` (create)

**Out of scope**:

- Binary installation and checksums.
- Changing fd/rg schemas or command names.
- A reusable stream framework or shared abstraction.
- Cleanup/retention policy beyond removing temporary files for untruncated
  results.

## Git workflow

- Branch: `advisor/007-stream-file-search-output`
- Commit: `perf(file-search): stream bounded output`

## Steps

### Step 1: Define the preserved result contract in tests

Create `run.test.ts` using `node:test`, `process.execPath`, and temporary paths.
Cover:

- small stdout: exact text, correct line count, not truncated, no full path;
- no-match/nonzero exit: exit code and bounded stderr preserved;
- output exceeding both byte and line limits: returned text is the head,
  `truncated` is true, and `fullOutputPath` contains the complete bytes;
- multibyte UTF-8 near a byte boundary remains valid text;
- temporary resources are cleaned by the test.

Do not assert private helper shapes.

**Verify before the fix**: the new tests cannot pass without the new streaming
result contract or demonstrate the current whole-buffer behavior.

### Step 2: Stream stdout to a bounded head plus spill

Refactor `runBinary()` and `truncateToolOutput()` into the minimum API that
returns:

- bounded/formatted stdout text;
- exit code;
- bounded stderr;
- total non-empty line count;
- truncation flag;
- optional full-output path.

Create a temp spill stream while running, write stdout chunks as they arrive,
and retain only enough decoded head to satisfy the Pi byte/line limits. Honor
writable backpressure by pausing stdout until `drain`. On completion:

- keep the file and surface its path only when output was truncated;
- close and delete the temporary directory when the complete result fits;
- wait for child and stream closure before returning;
- bound stderr in memory because it has no full-output contract.

Do not store the complete stdout string at any point.

**Verify**:
`node --test --experimental-strip-types extensions/file-search/run.test.ts`
→ all collector tests pass.

### Step 3: Adapt fd and rg tools

Update both tool execute paths to consume the new result directly. Preserve:

- rg exit 1 with empty output means “No matches found”;
- other errors prefer bounded stderr;
- details fields and names remain stable;
- the truncation notice still reports counts and the readable spill path.

**Verify**:
`node --test --experimental-strip-types extensions/file-search/run.test.ts extensions/file-search/binaries.test.ts`
→ all pass.

### Step 4: Run full gates and static checks

**Verify**:

- `npm run check` → exit 0.
- `npm test` → all tests pass.
- `rg -n 'stdout \\+=|stderr \\+=' extensions/file-search/run.ts` → no matches.
- `git diff --check` → clean.

## Test plan

One focused new test file covers small, large, error, UTF-8, and spill behavior.
Existing arg-builder tests remain the pattern for straightforward assertions.
No real fd/rg installation or network call is allowed.

## Done criteria

- [ ] File-search memory no longer scales with complete stdout.
- [ ] Complete output remains readable when truncated.
- [ ] Small results leave no spill directory.
- [ ] Existing tool result details and exit semantics remain stable.
- [ ] Full gates pass.

## STOP conditions

- Pi truncation helpers cannot be applied incrementally without changing
  visible head semantics.
- Correctness requires dropping the full-output path contract.
- Plan 003 has not landed and fd arguments still lack `--`.
- The implementation starts sharing background-terminal internals.

## Maintenance notes

Future output fields must remain incrementally computable. Reviewers should
check backpressure, stream closure, abort cleanup, and UTF-8 boundaries.
