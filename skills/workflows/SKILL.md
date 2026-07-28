---
name: workflows
description: Multi-phase workflows (recon → implement → review → synthesis) via wf_* tools. Use for multi-step repository work needing structured handoffs and on-disk artifacts. Prefer sa_spawn for a single worker.
---

# Workflows

## Tools

Named `wf_*` so they do not clash with other packages.

- `wf_start` — reconnaissance → implementation → review → synthesis (fixed pipeline)
- `wf_status` / `wf_list` — compact status; `wf_status` reports the private
  OS-temp artifact directory
- `wf_wait` — block until finished (returns synthesis; skips async completion message)
- `wf_cancel` — stop a running workflow and its child subagents

Command: `/workflow <goal>` starts the same pipeline.

## When to use

| Need | Prefer |
|------|--------|
| One isolated worker | `sa_spawn` |
| Phased handoffs, parallel scouts, preserved artifacts | `wf_start` |
| Long shell command | `bg_start` |

## Behavior

- Each phase may run **parallel** agent tasks; phases run **in order**.
- Child workers are pi's own native subagents (same lifecycle as `sa_*`); no second runner.
- Validated task outputs are stored under the workflow **artifacts directory** (outside the model prompt). Later phases receive compact structured handoffs plus artifact paths.
- If some agents fail, later phases (including **synthesis**) still run when possible. Status is `partial` when synthesis succeeds after earlier failures; a fallback synthesis is written if the synthesis agent itself fails.

## Prompting

Pass a **self-contained goal**. Children do not see the parent transcript.

After `wf_start`, keep working. A completion message arrives when the workflow finishes unless you already collected it with `wf_wait` or `wf_cancel`.

## Limits

- Fixed pipeline only (no template param).
- Completed artifacts are preserved after the session, but OS-temp storage is
  not a durable or cross-machine archive.
- Interactive dashboard deferred; use `wf_status` and its reported artifact
  directory.
- Session shutdown cancels remaining workflows.
