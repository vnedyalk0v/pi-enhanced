# Plan 017: Declare the project license

> **Executor instructions**: This plan begins with a maintainer decision. Do not
> infer, copy, or manufacture license terms. After an explicit choice, add the
> canonical text and consistent package/docs metadata. Update the index when
> done.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- LICENSE package.json package-lock.json README.md`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: plan 016
- **Category**: direction / release
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

The repository has no `LICENSE` and no `package.json` license field. The README
correctly says the behavioral reference repository has no declared license, but
it does not grant rights for this project's original implementation. A release
or external contribution should not proceed with that ambiguity.

## Current state

- No `LICENSE`, `LICENSE.md`, or `COPYING` file exists.
- `package.json` has no `license` field.
- `README.md:87-93` describes the reference boundary but does not declare this
  project's license.
- The package is currently `"private": true` and version `0.0.0`.

The reference repository's missing license is not a license choice for this
repository. Do not copy reference source or use its name as the copyright
holder.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Inspect metadata | `npm pkg get license` | selected SPDX identifier |
| Update lock metadata | `npm install --package-lock-only --ignore-scripts` | lockfile consistent |
| Unified gate | `npm run verify` | exit 0 |
| Package check | `npm pack --dry-run --json` | license file included |

## Scope

**In scope**:

- `LICENSE` (new)
- `package.json`
- `package-lock.json`
- `README.md`

**Out of scope**:

- Choosing a license without maintainer authorization.
- Legal advice or compatibility guarantees.
- Relicensing third-party or reference code.
- Removing `"private": true`, publishing, versioning, or tagging.
- Contributor license agreements or copyright automation.

## Git workflow

- Branch: `advisor/017-declare-license`
- Commit: `docs: declare project license`

## Steps

### Step 1: Obtain the maintainer's explicit choice

Ask the maintainer which license and copyright holder/year to use. Present a
short neutral choice appropriate to their distribution intent, but do not
default silently. Record the exact SPDX identifier and approved holder.

**Verify**:

- The choice is explicit and attributable to the maintainer.
- The chosen license permits the intended package distribution.

If no choice is supplied, stop here. The correct result is an unresolved
release blocker, not a guessed license.

### Step 2: Add canonical license text and metadata

Obtain the canonical license text from the authoritative SPDX or license
publisher source. Add it as `LICENSE`, filling only fields allowed by that
license's canonical form.

Set `package.json` `license` to the exact SPDX identifier. Run npm's
package-lock-only update so the root lockfile metadata remains consistent; do
not hand-edit dependency entries.

**Verify**:

- `npm pkg get license` → exact selected SPDX identifier.
- `package.json`, package-lock root metadata, and `LICENSE` agree.
- No reference-repository author is named as holder unless explicitly and
  correctly required.

### Step 3: Clarify README licensing

Add a short project-license statement linking to `LICENSE`. Preserve the
existing reference-boundary explanation: behavior was referenced, source was
implemented independently, and the reference's absent license grants no right
to copy its source.

Do not add a badge unless the repository already uses badges.

**Verify**:

- README clearly distinguishes this project's license from the reference
  repository's licensing status.
- The relative link to `LICENSE` resolves.

### Step 4: Run release checks

**Verify**:

- `npm run verify` → exit 0.
- `npm pack --dry-run --json` → succeeds and lists `LICENSE`.
- `git diff --check` → clean.

## Test plan

This is metadata/documentation work. Validate SPDX consistency, canonical text,
README link resolution, npm lock metadata, the unified gate, and tarball
contents.

## Done criteria

- [ ] Maintainer explicitly selected the license and holder.
- [ ] Canonical `LICENSE` text is present.
- [ ] Manifest and lock metadata use the same SPDX identifier.
- [ ] README distinguishes project and reference licensing.
- [ ] Verification and package assembly pass.

## STOP conditions

- The maintainer has not selected a license, holder, or required year.
- The repository contains copied material whose licensing is uncertain.
- The intended distribution requires legal compatibility analysis.
- Canonical terms and requested metadata conflict.

## Maintenance notes

Revisit licensing only when ownership or distribution changes. Do not add CLA
or header automation without a concrete contributor-management requirement.
