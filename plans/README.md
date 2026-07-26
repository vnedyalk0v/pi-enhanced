# Improvement plans

Read-only deep audit of `pi-enhanced`, planned at commit `9035686` on
2026-07-26. Source was not modified while preparing these plans.

Each plan is self-contained. Executors must run its drift check first, use the
named branch and focused commit, update this index after completion, and stop
when a listed STOP condition applies.

## Recommended order

| Plan | Priority | Effort | Risk | Depends on | Status |
|---|---:|---:|---:|---|---|
| [001 Effective subagent kill escalation](001-effective-subagent-kill-escalation.md) | P0 | S | HIGH | — | DONE (`c220aa4`) |
| [002 Private workflow artifacts](002-private-workflow-artifacts.md) | P0 | M | HIGH | — | DONE (`1387221`) |
| [003 Terminate fd options](003-terminate-fd-options.md) | P1 | S | MED | — | DONE (`256317c`) |
| [004 Verified file-search downloads](004-verified-file-search-downloads.md) | P1 | M | MED | — | DONE (`efd6185`) |
| [005 Reserve concurrency slots](005-reserve-concurrency-slots.md) | P1 | M | MED | — | DONE (`2d61914`) |
| [006 Untrusted workflow handoffs](006-untrusted-workflow-handoffs.md) | P1 | M | MED | — | DONE (`0e04fd5`) |
| [007 Stream file-search output](007-stream-file-search-output.md) | P1 | M | MED | 003 | DONE (`bbfc7a4`, includes `256317c`) |
| [008 Cap concurrent workflows](008-cap-concurrent-workflows.md) | P1 | M | MED | 005 | TODO |
| [009 Wait for subprocess streams](009-wait-for-subprocess-streams.md) | P1 | M | MED | 001 | TODO |
| [010 Preserve large Pi results](010-preserve-large-pi-results.md) | P1 | M | MED | 009 | TODO |
| [011 Bound background output](011-bound-background-output.md) | P1 | M | MED | 005, 009 | TODO |
| [012 Cancel Firecrawl jobs](012-cancel-firecrawl-jobs.md) | P2 | S | MED | — | TODO |
| [013 Add release verification gate](013-add-release-verification-gate.md) | P1 | M | MED | — | TODO |
| [014 Collapse git footer queries](014-collapse-git-footer-queries.md) | P2 | S | LOW | 013 | TODO |
| [015 Disambiguate ask_user choices](015-disambiguate-ask-user-choices.md) | P2 | S | LOW | 013 | TODO |
| [016 Document runtime and operational boundaries](016-document-runtime-and-operational-boundaries.md) | P2 | M | LOW | 002, 004, 006–008, 011–013 | TODO |
| [017 Declare project license](017-declare-project-license.md) | P2 | S | MED | 016 | TODO |

The numbering is the default serial execution order. Plan 013 has no technical
dependency and may land earlier to strengthen all subsequent gates. Plans 014
and 015 deliberately wait for its test type-checking. Plan 016 must describe
landed behavior rather than planned behavior; plan 017 remains blocked until the
maintainer explicitly chooses a license.

## Audit coverage

The selected set covers correctness, security, lifecycle reliability,
performance, release engineering, user experience, documentation, and project
direction. During plan preparation, the pinned `fd` release `10.2.1` was found
not to exist; that root cause is folded into plan 004 alongside asset checksum
verification rather than split into a redundant plan.

## Considered and rejected

- **Environment-variable allowlisting for child agents** — not planned. This is
  a same-user development harness, and a generic allowlist would break
  legitimate credentials. Plan 016 documents environment inheritance and the
  trust boundary instead.
- **Independent TypeBox upgrade** — not planned. The installed version matches
  the pinned Pi package family; moving it alone adds compatibility risk without
  a demonstrated defect.
- **Formatter/linter introduction** — not planned. TypeScript and tests already
  provide the relevant gate, and repository-wide style churn would not address
  an observed problem.
- **Tarball pruning** — not planned. The dry-run package is about 58 KB; exclude
  rules add maintenance for no material delivery benefit.
- **Workflow history/dashboard now** — deferred. Private collision-proof
  artifacts and operational docs come first; add history only after real usage
  shows that preserved temp artifacts are insufficient.
- **Subagent completion-delivery redesign** — not planned without a reproducible
  loss or duplication case. Existing one-shot delivery is covered by lifecycle
  tests; plans 001, 005, and 009 address the demonstrated failure paths.

## Updating this index

After executing a plan, replace its `TODO` status with:

- `DONE` and the landing commit;
- `BLOCKED` and the exact STOP condition; or
- `SUPERSEDED` and the replacement plan/commit.

Do not renumber remaining plans. New findings take the next monotonic number.
