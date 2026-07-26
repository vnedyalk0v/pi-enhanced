---
name: subagents
description: Delegate work to Pi or Codex subagents via sa_* tools. Use for parallel research, long coding tasks, or isolated context. Prefer sa_spawn with backend pi or codex; use /btw for a quick side question.
---

# Subagents (Pi and Codex only)

## Tools

Named `sa_*` so they do not clash with packages that register `subagent` / `subagent_wait`.

- `sa_spawn` — start a background worker (`backend`: `pi` | `codex`)
- `sa_status` / `sa_list` — inspect
- `sa_wait` — block until finished (returns result; skips async completion message)
- `sa_cancel` — stop workers

## When to use which backend

| Backend | Prefer when |
|--------|-------------|
| **pi** | Same model/stack as the parent; light research; quick exploration; consistency with parent tools |
| **codex** | Heavy implementation/refactor; high reasoning coding; Codex-configured coding model |

Defaults:

- **Pi**: parent model + parent thinking level (overridable via `model` / `thinking`)
- **Codex**: config default model (or `CODEX_DEFAULT_MODEL`) + **high** reasoning (`thinking` maps to `model_reasoning_effort`)

## Prompting children

Always pass a **self-contained** prompt. Children do not see the parent transcript.

After spawn, keep working. A completion message arrives when the child finishes unless you already collected it with `sa_wait` or `sa_cancel`.

## Side questions

`/btw <question>` starts a Pi subagent for a short side inquiry without blocking the main chat.

## Limits

- Only **pi** and **codex** backends (no Claude).
- Bounded concurrency (4 running by default).
- Session shutdown cancels remaining children.
