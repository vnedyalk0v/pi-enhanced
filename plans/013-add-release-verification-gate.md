# Plan 013: Add a release verification gate

> **Executor instructions**: Make one repeatable local/CI gate that type-checks
> tests, runs them on the supported Node line, and proves the package loads
> without invoking a model. Read Pi's package and RPC docs before editing.
> Update the index when done.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- package.json package-lock.json tsconfig.json .github/workflows/verify.yml scripts/package-smoke.mjs`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 018
- **Category**: test / release
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

`npm run check` excludes every test file, the installed Node declarations target
Node 26 while the package promises Node 22.19+, and there is no CI or package
load probe. The existing 63 tests pass locally, but the release claim is not
continuously checked on the documented runtime or through Pi's package loader.

Execution on 2026-07-26 exposed a prerequisite: Node 22.22.2 cancelled 18
async tests because test-owned completion timers did not keep the event loop
alive. Plan 018 owns that focused compatibility fix; resume this plan only
after it lands.

## Current state

`package.json:12-15` has only:

```json
"check": "tsc --noEmit",
"test": "node --test --experimental-strip-types extensions/**/*.test.ts"
```

`tsconfig.json:17-22` includes all extension TypeScript and then excludes
`extensions/**/*.test.ts`.

`package.json:39-41` declares Node `>=22.19.0`, while
`devDependencies["@types/node"]` is `26.1.1`.

There is no `.github/` directory. Baseline at the planned commit:

- `npm run check` passes;
- `npm test` passes 63 tests;
- `npm pack --dry-run --json` succeeds with 59 files;
- local Node is 24.14.1, so Node 22 compatibility was not exercised.

Read before implementation:

- `node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- the package-loading examples linked by those docs

RPC supports `get_commands`, so a smoke probe can prove that package commands
and skills loaded without sending a prompt or calling a model.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install matching Node types | `npm install --save-dev @types/node@22` | manifest and lockfile updated |
| Type-check | `npm run check` | exit 0, including tests |
| Tests | `npm test` | all pass |
| Package smoke | `npm run smoke:package` | expected commands/skills found |
| Unified gate | `npm run verify` | exit 0 |
| Package contents | `npm pack --dry-run --json` | valid package manifest |

## Scope

**In scope**:

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `scripts/package-smoke.mjs` (new)
- `.github/workflows/verify.yml` (new)

**Out of scope**:

- Publishing or tagging a release.
- An interactive TUI session.
- Live model, Firecrawl, Codex, or network calls in the smoke test.
- A Node version matrix beyond the documented minimum.
- Adding a formatter, linter, test framework, or dependency.

## Git workflow

- Branch: `advisor/013-release-verification-gate`
- Commit: `ci: add package verification gate`

## Steps

### Step 1: Align types and type-check tests

Install the latest compatible `@types/node` 22.x release with npm so both
manifest and lockfile change together. Remove the test exclusion from
`tsconfig.json`; the existing include already covers the tests.

Do not add a second tsconfig unless the single config demonstrably cannot cover
runtime and tests.

**Verify**:

- `npm run check` → exit 0 with test files included.
- `npm test` → all existing tests pass.
- `npm ls @types/node` → a 22.x version is installed.

### Step 2: Add a noninteractive package-load smoke

Create `scripts/package-smoke.mjs` using only Node built-ins. It must:

1. create a temporary Pi home and temporary `bin` directory;
2. place minimal executable `fd` and `rg` stubs there so extension startup
   cannot auto-download binaries;
3. spawn the local Pi CLI in RPC mode with `--no-session`, `--offline`,
   `--approve`, and `-e ./`, with the temporary directories in its environment;
4. send only `{"id":"smoke","type":"get_commands"}` over stdin;
5. parse JSONL by LF, as required by `docs/rpc.md` (do not use
   `node:readline`);
6. assert that representative package commands and skills are present:
   `copy-all`, `summary`, `ps`, `btw`, `workflow`, `skill:subagents`,
   `skill:background-terminals`, `skill:web-research`, and
   `skill:workflows`;
7. fail on `extension_error`, malformed JSON, nonzero exit, missing resources,
   or a short fixed timeout;
8. terminate the child and remove temporary files in `finally`.

Use the package-local CLI from `node_modules/.bin`; do not depend on a global
`pi`. Do not send `prompt`, so no provider key or model request is possible.

Add `"smoke:package"` and a `"verify"` script that runs check, tests, and this
smoke in sequence.

**Verify**:

- Run with provider/API keys unset: `npm run smoke:package` → exit 0.
- Temporarily change one expected command name in the script and rerun → exits
  nonzero; restore it immediately.
- `npm run verify` → exit 0.

### Step 3: Add minimum-runtime CI

Create a single GitHub Actions workflow for pushes and pull requests. Use:

- `actions/checkout`;
- `actions/setup-node` with Node `22.19.0` and npm cache;
- `npm ci`;
- `npm run verify`;
- `npm pack --dry-run --json`.

Pin stable action major versions used by the repository's current policy. Do
not add a matrix or release job.

**Verify**:

- Validate the YAML syntax with the editor or an available local YAML parser.
- Push the branch and confirm the workflow passes on Node 22.19.0.
- `git diff --check` → clean.

## Test plan

The unified gate must cover TypeScript source and tests, all existing node:test
files, a no-network/no-model Pi RPC package load, and npm package assembly. CI
runs the same commands as local verification on the supported minimum Node.

## Done criteria

- [ ] Test files participate in `npm run check`.
- [ ] Node declarations match the supported Node 22 line.
- [ ] `npm run smoke:package` proves representative extensions and skills load.
- [ ] The smoke cannot call a model or download file-search binaries.
- [ ] `npm run verify` is the documented single gate.
- [ ] CI passes on Node 22.19.0.
- [ ] `npm pack --dry-run --json` still succeeds.

## STOP conditions

- Current Pi RPC/package APIs cannot load the package without provider or
  network access.
- The package smoke triggers real background work after fake binaries and a
  temporary Pi home are supplied.
- Node 22 type declarations expose a real unsupported API use; stop and plan
  the compatibility fix instead of weakening the gate.
- Repository policy requires a different CI provider or action pinning scheme.

## Maintenance notes

Keep one minimum-runtime job until another supported runtime has a concrete
compatibility risk. Add a matrix only when it catches a distinct supported
surface.
