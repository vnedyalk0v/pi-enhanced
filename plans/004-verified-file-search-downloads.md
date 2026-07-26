# Plan 004: Pin valid file-search assets and verify their integrity

> **Executor instructions**: Follow every step. Do not invent digest values,
> trust a mirror, or silently drop a supported platform. Update the plan index
> when complete.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- extensions/file-search/binaries.ts extensions/file-search/binaries.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

The extension downloads release archives, extracts a named file, marks it
executable, and runs it without authenticating the bytes. Plan preparation
also discovered that `FD_VERSION = "10.2.1"` points to a nonexistent upstream
release, so clean auto-install currently fails when `fd` is absent. This plan
restores a valid pinned asset matrix and makes later delivery tampering fail
closed.

## Current state

`extensions/file-search/binaries.ts:26-27`:

```ts
const FD_VERSION = "10.2.1";
const RG_VERSION = "14.1.1";
```

`extensions/file-search/binaries.ts:89-99` downloads over HTTPS but performs no
digest check. `ensureBinary()` then extracts and chmods it at lines 167-177.

Verified upstream facts as of 2026-07-26:

- `sharkdp/fd` has no `v10.2.1`; `v10.2.0` contains all four currently
  supported macOS/Linux x64/arm64 assets.
- `BurntSushi/ripgrep` `14.1.1` contains matching `.sha256` files.
- fd `v10.2.0` does not publish checksum sidecars, so its pinned digests must be
  computed once from the official GitHub release assets and reviewed in the
  change.

Existing URL assertions are in
`extensions/file-search/binaries.test.ts:22-31`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Inspect fd assets | `gh api repos/sharkdp/fd/releases/tags/v10.2.0 --jq '.assets[].name'` | four target archives are listed |
| Inspect rg assets | `gh api repos/BurntSushi/ripgrep/releases/tags/14.1.1 --jq '.assets[].name'` | target archives and `.sha256` sidecars are listed |
| Target tests | `node --test --experimental-strip-types extensions/file-search/binaries.test.ts` | all pass |
| Gates | `npm run check && npm test` | exit 0 |

## Scope

**In scope**:

- `extensions/file-search/binaries.ts`
- `extensions/file-search/binaries.test.ts`

**Out of scope**:

- Adding a download or archive dependency.
- Expanding the OS/architecture matrix.
- Auto-updating versions or digests at runtime.
- Trusting a digest downloaded beside the archive during installation; that
  does not protect against a compromised release.
- File-search output streaming.

## Git workflow

- Branch: `advisor/004-verified-file-search-downloads`
- Commit: `fix(file-search): verify downloaded binaries`

## Steps

### Step 1: Restore a valid pinned fd release

Change fd to the smallest compatible correction, `10.2.0`, rather than mixing
in a broad upgrade. Update URL tests for all four supported targets, not only
one fd and one rg example. Confirm every generated URL corresponds to an
official release asset using the GitHub API commands above.

**Verify**:
`node --test --experimental-strip-types extensions/file-search/binaries.test.ts`
→ URL tests pass and contain no `10.2.1`.

### Step 2: Create a complete pinned digest table

For each binary and each supported `{os, arch}` pair, obtain the official
archive once in a fresh temporary directory:

- For ripgrep, compare the downloaded archive with its published `.sha256`
  sidecar before copying the digest into source.
- For fd, download only from the exact official `v10.2.0` GitHub asset URL,
  compute SHA-256 locally, and include the resulting values in the review
  description because upstream provides no sidecars.

Represent the eight expected digests in a small typed constant keyed by binary
and target. Do not add configuration or a generic manifest framework.

Add tests asserting every supported binary/target has a 64-hex-character
digest and unsupported targets cannot retrieve one.

**Verify**:
`node --test --experimental-strip-types extensions/file-search/binaries.test.ts`
→ digest-matrix tests pass.

### Step 3: Verify before extraction

Use `node:crypto` streaming hash support or `createHash` plus a read stream to
calculate the downloaded archive's SHA-256. Compare it to the pinned value
before calling `extractBinary()`. On mismatch:

- delete the archive through the existing `finally`;
- do not create or replace the destination executable;
- throw a bounded error naming the binary/version/target, never secret data.

Export only the smallest helper needed for a unit test. Add a temp-file test
covering match and mismatch without network access.

**Verify**:
`node --test --experimental-strip-types extensions/file-search/binaries.test.ts`
→ valid bytes pass and changed bytes fail with a digest-mismatch error.

### Step 4: Run full gates

**Verify**:

- `npm run check` → exit 0.
- `npm test` → all tests pass.
- `rg -n '10\\.2\\.1' extensions/file-search` → no matches.
- `git diff --check` → clean.

## Test plan

- URL generation for both binaries across four targets.
- Complete digest matrix.
- Local deterministic hash match and mismatch.
- No network in the automated test suite.
- Existing platform detection and candidate-name tests remain green.

## Done criteria

- [ ] Every generated release URL exists upstream.
- [ ] Every supported asset has a pinned SHA-256 digest.
- [ ] Verification runs before extraction/chmod.
- [ ] Mismatch leaves no installed executable.
- [ ] Full gates pass.
- [ ] Only in-scope files and the index are modified.

## STOP conditions

- Any supported target has no official release asset.
- A digest cannot be independently established for an asset.
- The implementation would download and trust the checksum at runtime.
- Restoring fd requires dropping macOS x64 or another currently supported
  target.

## Maintenance notes

Every future version bump must update URLs and all eight digests in one atomic
change. Reviewers should independently verify the digest table, especially fd
values because that release lacks checksum sidecars.
