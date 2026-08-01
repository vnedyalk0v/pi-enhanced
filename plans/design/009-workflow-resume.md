# Workflow resume contract

## Decision

Add `wf_resume(id)`, not `wf_retry(id, phase)`. Resume continues the fixed
pipeline from its first incomplete phase and re-runs every later phase so that
downstream evidence cannot silently refer to an older attempt. It never
re-runs an implementation attempt. There is no acknowledgement flag that
overrides that rule.

This is a same-session, tracked-workflow feature. It does not import an
arbitrary artifacts directory, survive a manager/process restart, or promise
cross-machine or post-reboot recovery. Workflow artifacts are OS-temporary and
the manager currently forgets all entries at session shutdown.

## Phase policy

| Phase | Resume policy | Reason and guard |
| --- | --- | --- |
| reconnaissance | Re-runnable | Its role says not to modify files and the manager supplies only read/search tools. Re-run only when it is the first incomplete phase, the workspace fingerprint still matches, and implementation has no start marker. |
| implementation | Never re-runnable | It edits the user's working tree and is not idempotent. A second attempt could layer edits on partial work or double-apply them. If its durable start marker exists, `wf_resume` must refuse without spawning a child. No user acknowledgement bypasses this in v1. |
| review | Re-runnable after the read-only-review prerequisite below | It is not safe today: `extensions/workflows/template.ts` gives it no tool allowlist and permits a trivial fix. Before resume ships, review must receive read/search-only tools and its role must forbid edits. Then it may be re-run against an unchanged workspace. |
| synthesis | Re-runnable | It already receives only `read`, writes no repository files, and derives a report from existing handoffs. It still requires artifact and workspace validation. |

An implementation phase with no start marker may be started once by resume if
the workflow stopped before spawning it. The eventual runner must atomically
publish that marker before starting the implementation child. A crash after
publishing the marker but before spawning the child blocks resume; this
fail-closed false negative is preferable to a possible second edit pass.

## Tool contract

```ts
const ResumeParams = Type.Object({
  id: Type.String({ description: 'Tracked workflow id, e.g. "wf-1"' }),
}, { additionalProperties: false });

pi.registerTool({
  name: "wf_resume",
  label: "Workflow resume",
  parameters: ResumeParams,
  // execute resumes the first incomplete phase and every phase after it.
});
```

The schema deliberately has no `phase`, `force`, or acknowledgement parameter.
The operation must:

1. Reject an unknown, running, evicted, or artifact-version-incompatible id.
2. Atomically acquire the normal workflow concurrency slot. A concurrent
   `wf_start` or `wf_resume` must see the reservation.
3. Validate the on-disk manifests and workspace fingerprint before spawning
   any child.
4. Select the first phase whose latest attempt is not successful. If all phase
   attempts are successful but the final artifact is missing or invalid,
   select synthesis.
5. Reject if the selected phase is implementation and its start marker exists.
   If it does not exist, publish the marker durably before its first spawn.
6. Mark later phase attempts superseded and execute the selected phase through
   synthesis in fresh attempt directories. Do not delete or overwrite older
   evidence.

`partial`, `failed`, and `cancelled` workflows are eligible when these checks
pass. A completed `done` workflow is not resumable.

## Artifact trust and attempts

Disk is authoritative at resume time; the in-memory snapshot is only a cache.
The original attempt keeps the current directory, for example
`phases/03-review/`. Later attempts use append-only siblings such as
`phases/03-review-attempt-02/`. A resumed synthesis writes its `final.md` inside
its new attempt directory. `WorkflowSnapshot.finalArtifactPath` and task
`artifactPath` values point to the selected latest attempt, while status output
also reports its attempt number and directory.

`outputs.json` is the completion manifest. A phase attempt is complete only
when all of these are true:

- `outputs.json` parses and contains exactly one unique record for every fixed
  task key in that phase, with matching `phase`, `taskKey`, and `artifactPath`;
- every referenced task artifact exists inside that attempt directory;
- every output `status` is a settled value: `ok`, `failed`, or `killed`; and
- the persisted phase status and attempt number agree with the manifest.

The eventual build must publish `outputs.json` with write-to-private-temp plus
atomic rename after all task artifacts are closed. A missing, malformed,
truncated, mismatched, or extra-record manifest is incomplete; individual task
Markdown files from it are untrusted and are not fed downstream.

Success is separate from completeness. A complete attempt is successful only
when every output has `status: "ok"`. This reuses the current oversized-result
behavior: an oversized synthesis has a complete output record with
`status: "failed"`, and its fallback `final.md` is evidence, not a successful
synthesis. The existence of `final.md` alone never marks synthesis successful.

Before each child spawn, an atomically published `attempt-start.json` records
the phase, attempt number, and pre-attempt workspace fingerprint. Its presence
means implementation may have produced effects even if `outputs.json` is
absent. Old runs created before these markers and the artifact schema version
exist are not resumable; do not infer safety from their files.

## Workspace drift rule

Resume v1 supports Git working trees only. Record the repository root and a
workspace fingerprint at workflow start and after every complete phase. Reject
resume if Git is unavailable, the working directory is outside that same root,
or the recomputed fingerprint differs from the `workspaceAfter` value of the
latest complete upstream attempt (the start fingerprint when there is none).

The fingerprint is SHA-256 over NUL-framed bytes containing:

1. `git rev-parse --show-toplevel` and `git rev-parse --verify HEAD`;
2. `git status --porcelain=v2 -z --untracked-files=all`;
3. `git diff --binary --full-index --no-ext-diff --no-textconv HEAD --`; and
4. the byte-sorted output of `git ls-files --others --exclude-standard -z`,
   followed for each path by its `lstat` type/mode and either its content hash
   or, for a symlink, its link-target bytes without following the link.

The exact check is `recomputeWorkspaceFingerprint(cwd) === recordedWorkspaceAfter`.
This catches a moved `HEAD` plus staged, unstaged, mode, and untracked-content
changes. V1 rejects dirty submodules rather than pretending their internal
working trees are covered. Ignored files are deliberately excluded. Read-only
phases record the same fingerprint again; only implementation is expected to
change it. Implementation records `workspaceAfter` only after its complete
manifest is durably published; a partial implementation has no trusted
post-state and is never resumed.

## Artifact-directory and concurrency behavior

Reuse the workflow's artifact root but fork each resumed phase into a new,
append-only attempt directory. This preserves the audit trail without adding a
second workflow id or making `wf_status` switch roots. Older attempts remain
inspectable; only the latest successful-or-current attempt feeds later phases.

A failed-and-resumable workflow does not hold the single running slot. Resume
uses the same `maxRunning` reservation as start, so it fails with the normal
concurrency error while another workflow is starting or running and may be
called again after that workflow settles. Existing retention still applies: a
resumable workflow can be evicted after newer results exceed `maxTracked`, at
which point its id cannot resume and its artifacts may be removed.

## Prerequisite work items

1. **Represent phase cancellation.** Add `"cancelled"` to
   `PhaseRunStatus` and persist it when cancellation kills or skips a phase.
   Resume must never mistake a deliberate cancellation for an ordinary failed
   result.
2. **Make review genuinely read-only.** Give the review task a read/search-only
   tool allowlist and remove the role text permitting trivial fixes. Until this
   lands, review is not resumable.
3. **Add a fail-closed attempt protocol.** Version the artifact schema; write
   `attempt-start.json` before spawning; atomically publish complete
   `outputs.json`; record attempt number/directory in status; and keep prior
   attempts append-only.
4. **Stop swallowing resume-critical persistence failures.** A failed write of
   a start marker, manifest, or workspace fingerprint must abort before child
   execution or leave the attempt non-resumable. The current best-effort
   `persist()` behavior is insufficient for safety decisions.
5. **Capture workspace fingerprints.** Implement the read-only Git fingerprint
   above at start and after complete phases. Do not use stash, branch, commit,
   `git write-tree`, or any other command that mutates the user's repository.
6. **Hydrate and validate tracked entries from disk.** Reconstruct prior
   outputs only from complete manifests, reject old schema versions, point
   snapshots at the latest attempt, and invalidate all downstream attempts
   when resuming an earlier phase.
7. **Reserve concurrency and test retention.** Share the existing start
   reservation path with resume, and document that normal `maxTracked`
   eviction ends resumability.

The stale-context crash-chain fix at commit `5bae0a8` is already present and
keeps workflow settlement from being stranded by throwing UI callbacks.

## Accepted failure modes

- A crash after an implementation start marker but before the child actually
  starts permanently blocks automatic resume for that workflow.
- Any workspace mismatch, including a benign manual edit, blocks resume. The
  user must inspect artifacts and start a new workflow after deciding what to
  keep.
- Ignored files are not fingerprinted; tools whose behavior depends on changed
  ignored build output or local configuration can still produce different
  results.
- Re-running a safe phase can cost more tokens and produce different prose even
  against identical inputs.
- Pre-contract runs, evicted ids, process/session restarts, OS-temp cleanup,
  machine restarts, and cross-machine moves are not recoverable by
  `wf_resume` v1.
- There is no automatic rollback or cleanup for a partial implementation. The
  contract reports the block and preserves evidence.

## Eventual build tests

1. `wf_resume` exposes only the `id` parameter and rejects `phase`, `force`, and
   acknowledgement inputs.
2. A failed reconnaissance attempt with a complete manifest resumes recon,
   then runs each later phase once in order.
3. A missing, truncated, malformed, task-mismatched, or out-of-directory
   `outputs.json` is rejected as incomplete evidence.
4. A crash after the implementation start marker but before child spawn blocks
   resume without spawning another child.
5. A partially completed implementation that edits a sentinel file and then
   fails cannot be resumed: the implementation spawn count stays one and the
   sentinel edit appears once, never twice.
6. A complete implementation followed by failed review resumes review and
   synthesis only; the implementation spawn count remains one.
7. The review child receives read/search-only tools, and its role contains no
   permission to fix files.
8. An oversized synthesis output remains a complete failed attempt; its
   fallback `final.md` is not trusted as success, and resume runs synthesis
   only.
9. Changed `HEAD`, staged content, unstaged content, file mode, untracked
   content, or repository root each causes a pre-spawn fingerprint rejection.
10. Unchanged workspace state produces the same fingerprint and permits a safe
    resume.
11. A resumed attempt uses a new directory, keeps old evidence byte-for-byte,
    and updates snapshot paths and attempt metadata to the new attempt.
12. `cancelled` is persisted distinctly; cancelled recon/review/synthesis may
    resume when otherwise safe, while cancelled implementation cannot.
13. A resumable workflow consumes no running slot; resume while another start
    holds the slot is rejected, then succeeds after settlement.
14. Eviction removes resumability and returns `Unknown workflow id` rather than
    loading an arbitrary path.
15. Startup marker or manifest persistence failure aborts safely and never
    starts the child whose safety record could not be written.

The most important test is item 5: retry after a partially completed
implementation must not silently double-apply repository edits.

## Open questions for the maintainer

1. Should a later version add an explicit, user-selected artifact import path
   for same-machine session recovery? That needs separate path-validation and
   ownership rules; it is not part of v1.
2. Should selected ignored files be included in the workspace fingerprint for
   projects whose generated or local configuration affects review? The default
   remains Git-visible plus untracked files only.
3. Should resumable workflows be pinned beyond the current 16-result retention
   limit, or is bounded, same-session recovery preferable to an explicit
   abandon/cleanup lifecycle?
4. Should implementation recovery ever exist? If considered later, it requires
   a separate maintainer-approved design for repository ownership/checkpoints;
   this contract intentionally provides no override.
