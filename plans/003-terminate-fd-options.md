# Plan 003: Terminate fd option parsing before search positionals

> **Executor instructions**: Follow this plan exactly and update the index when
> complete. Stop rather than touching unrelated file-search behavior.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- extensions/file-search/run.ts extensions/file-search/binaries.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

`buildFdArgs()` appends an unrestricted model-supplied pattern without an
option terminator. A pattern such as `--exec` is interpreted as an `fd` option,
crossing the file-search tool boundary into unintended behavior. `rg` already
uses the correct `--` pattern.

## Current state

`extensions/file-search/run.ts:30-42` currently ends with:

```ts
if (params.maxResults && params.maxResults > 0) {
  args.push("--max-results", String(params.maxResults));
}
args.push(params.pattern);
args.push(params.path || ".");
```

Correct exemplar in `buildRgArgs()` at `extensions/file-search/run.ts:52-60`:

```ts
args.push("--", params.pattern);
args.push(params.path || ".");
```

Argument-builder tests live in
`extensions/file-search/binaries.test.ts:45-93`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Target tests | `node --test --experimental-strip-types extensions/file-search/binaries.test.ts` | all pass |
| Typecheck | `npm run check` | exit 0 |
| Full tests | `npm test` | all pass |

## Scope

**In scope**:

- `extensions/file-search/run.ts`
- `extensions/file-search/binaries.test.ts`

**Out of scope**:

- File-search streaming; that is Plan 007.
- Binary downloads or version changes.
- Parameter-schema redesign.
- Shelling out or escaping strings manually.

## Git workflow

- Branch: `advisor/003-terminate-fd-options`
- Commit: `fix(file-search): terminate fd options`

## Steps

### Step 1: Lock the safe argument shape

Update both existing `fd` expected arrays to contain `"--"` immediately before
the pattern. Add a case with `pattern: "--exec"` and a path value; assert both
remain after the terminator as positional data.

**Verify before the fix**:
`node --test --experimental-strip-types extensions/file-search/binaries.test.ts`
→ the updated/new fd tests fail while rg tests pass.

### Step 2: Add the option terminator

In `buildFdArgs()`, append `"--"` after all trusted options and before
`params.pattern`. Do not quote or transform either positional; `spawn()` already
passes an argument array without a shell.

**Verify**:
`node --test --experimental-strip-types extensions/file-search/binaries.test.ts`
→ all tests pass.

### Step 3: Run repository gates

**Verify**:

- `npm run check` → exit 0.
- `npm test` → all tests pass.
- `git diff --check` → clean.

## Test plan

- Existing glob and regex fd shapes include the terminator.
- A leading-hyphen pattern remains positional.
- Existing rg terminator test remains unchanged.

## Done criteria

- [ ] Every fd positional is after `--`.
- [ ] No manual shell escaping or validation list was added.
- [ ] Target and full gates pass.
- [ ] Only in-scope files and the index are modified.

## STOP conditions

- The installed fd version rejects `--` between options and pattern.
- Fixing the behavior appears to require shell execution.
- Plan 007 has already substantially replaced `buildFdArgs`.

## Maintenance notes

Any future model-controlled fd positional must remain after the terminator.
Execute this before Plan 007 to keep the streaming refactor focused.
