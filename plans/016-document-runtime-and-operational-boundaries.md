# Plan 016: Document runtime and operational boundaries

> **Executor instructions**: Update user-facing documentation after the
> prerequisite behavior plans land. State verified facts and known ceilings;
> do not claim unperformed platform or release validation. Update the index
> when done.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- README.md PLAN.md skills/workflows/SKILL.md`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans 002, 004, 006, 007, 008, 011, 012, and 013
- **Category**: docs / release
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

The README explains installation but omits runtime tools, backend credentials,
platform limits, per-extension filtering, artifact locations, trust boundaries,
and common failures. `PLAN.md` also claims a stale `/pi-enhanced` foundation
command that does not exist. These gaps make release readiness and safe
operation depend on repository knowledge rather than documented behavior.

## Current state

`README.md:44-85` documents Node, npm commands, package install, and a Firecrawl
key. It does not explain:

- that Pi 0.82.1 is the supported package API;
- when the `codex` executable is required;
- file-search auto-install platforms and verification;
- where workflow artifacts, background logs, and truncated outputs live;
- concurrency limits and cancellation;
- that child agents inherit the parent environment and working tree access;
- how to enable or disable individual package resources;
- clean-install verification or troubleshooting.

`PLAN.md:30-31` says `/pi-enhanced` confirms the extension in a real TUI, but no
such command is registered.

`skills/workflows/SKILL.md:13` says full output lives under `artifacts/`, while
the implementation uses an OS-temporary per-workflow directory.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Unified gate | `npm run verify` | exit 0 |
| Find stale claims | `rg -n '/pi-enhanced|under .artifacts/|live under .artifacts/' README.md PLAN.md skills` | no stale matches |
| Package check | `npm pack --dry-run --json` | succeeds |
| Diff check | `git diff --check` | clean |

## Scope

**In scope**:

- `README.md`
- `PLAN.md`
- `skills/workflows/SKILL.md`

**Out of scope**:

- Changing runtime behavior.
- Adding a changelog, generated docs site, or support matrix automation.
- Declaring the project license; plan 017 owns that decision.
- Tagging or publishing `v0.1.0`.
- Claiming Windows or untested platform support.

## Git workflow

- Branch: `advisor/016-runtime-operations-docs`
- Commit: `docs: define runtime and operational boundaries`

## Steps

### Step 1: Correct existing claims

Remove the nonexistent `/pi-enhanced` claim from `PLAN.md`. Replace it with
the real verification evidence introduced by plan 013: the unified local gate
and noninteractive package-load smoke.

Correct the workflow skill to say that `wf_status` reports the artifact
directory and that artifacts live under a private OS-temporary directory by
default. Explain that completed artifacts are preserved for inspection but are
not a durable cross-machine store.

**Verify**:

- `rg -n '/pi-enhanced|live under .artifacts/' README.md PLAN.md skills` → no
  stale claims.
- Every named command/tool in edited docs exists in source.

### Step 2: Add concise setup and configuration guidance

Expand README development/installation guidance with:

- supported Pi `0.82.1`, Node `>=22.19.0`, and npm;
- `pi` as the host CLI and `codex` only for Codex-backed subagents/workflows;
- `FIRECRAWL_API_KEY` as optional for Firecrawl quality/scrape/crawl, with
  no-key search fallback behavior;
- `fd`/`rg` lookup order, supported auto-download platforms after plan 004,
  checksum verification, and manual-install guidance for unsupported systems;
- `npm run verify` as the release gate.

Use Pi's current `docs/packages.md` syntax for package filters and show the
smallest example for enabling/disabling one extension or skill. Do not invent
configuration keys.

**Verify**:

- Copy every command/config example into a temporary shell or parser where
  practical.
- Compare filter syntax against the pinned Pi docs.
- `npm run verify` → exit 0.

### Step 3: Document storage, limits, trust, and troubleshooting

Add one compact operational section covering:

- subagent cap and workflow cap/reservation after plans 005 and 008;
- cancellation semantics, including Firecrawl remote cleanup after plan 012;
- workflow artifact directory ownership/mode and name collision behavior after
  plan 002;
- file-search spill output and background log retention/bounds after plans 007
  and 011;
- session shutdown behavior;
- Pi/Codex children inherit the parent process environment and can modify the
  supplied working directory;
- Codex `workspace-write` is a guardrail, not a security boundary;
- workflow handoffs are untrusted data and are framed accordingly after plan
  006;
- common errors: missing `pi`, missing `codex`, unsupported/missing `fd` or
  `rg`, missing Firecrawl key, quota fallback, concurrency full, and locating
  artifacts/logs.

Keep security wording factual. Do not promise sandbox isolation from arbitrary
child code.

**Verify**:

- Trace each documented behavior to the landed implementation.
- Ask a clean reader to follow install, disable one extension, run the gate,
  and locate artifacts using only README.
- `npm pack --dry-run --json` → succeeds.
- `git diff --check` → clean.

### Step 4: Update release phase honestly

Mark only documentation/gate tasks actually completed in Phase 7. Leave clean
Pi configuration tests and real-session/platform checks open unless they were
performed and recorded during execution. Keep the `v0.1.0` tag blocked on those
checks and the license decision in plan 017.

**Verify**:

- Phase 7 distinguishes automated verification from unperformed manual checks.
- No release/tag statement exceeds current evidence.

## Test plan

Run the unified gate and npm pack check. Validate every copied configuration
snippet against pinned Pi docs and every operational claim against the landed
code. Perform clean-install/manual checks only on surfaces actually available,
and record skipped platforms explicitly.

## Done criteria

- [ ] Setup, prerequisites, credentials, filters, and verification are usable.
- [ ] Supported auto-install platforms and manual fallback are explicit.
- [ ] Storage, concurrency, cancellation, and retention behavior are accurate.
- [ ] Child-process trust boundaries are stated without implying isolation.
- [ ] Stale command and artifact-location claims are removed.
- [ ] Phase 7 reflects verified and still-pending work honestly.

## STOP conditions

- Any prerequisite behavior plan is not landed or its final behavior differs
  from this plan.
- Pi package filter syntax differs from the pinned docs.
- A platform claim cannot be backed by code plus an available test.
- Documentation would require exposing secrets, private paths, or internal
  credentials.

## Maintenance notes

Keep operational limits beside installation rather than creating a docs site.
Split documentation only when README navigation becomes materially difficult.
