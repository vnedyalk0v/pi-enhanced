---
name: subagents
description: Delegate work to pi's native subagents via sa_* tools. Use for parallel research, long coding tasks, or isolated context. Prefer sa_spawn (optionally with a named agent); use /btw for a quick side question.
---

# Subagents (pi-native)

Subagents are pi's own worker processes — no third-party CLI dependency (no Codex, no Claude).

## Tools

Named `sa_*` so they do not clash with packages that register `subagent` / `subagent_wait`.

- `sa_spawn` — start a background worker; optionally named via `agent`
- `sa_agents` — list discovered named agent definitions
- `sa_status` / `sa_list` — inspect
- `sa_wait` — block until finished (returns result; skips async completion message)
- `sa_cancel` — stop workers

## Named agents vs ad-hoc

Omit `agent` for an ad-hoc worker with full default tools and package/parent model/thinking
(see `/pe-settings`).

Pass `agent: "<name>"` to use a discovered agent definition instead — a markdown file with
frontmatter that pins tools, model, and/or thinking for that role:

```markdown
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5
---
Find things quickly. Do not modify files.
```

**Locations:**
- `~/.pi/agent/agents/*.md` — user-level, always loaded
- `.pi/agents/*.md` — project-level, only loaded for **trusted** projects; repo-controlled,
  so pi confirms before running one interactively

Project agents override user agents with the same name. Use `sa_agents` to see what's
discoverable before picking a name.

## Defaults

- **Model/thinking**: explicit `sa_spawn` params win, then the agent definition's
  `model`/`thinking`, then package overrides from `/pe-settings` (or
  `pi-enhanced.json`), then the **active Pi session** model/thinking. Package
  defaults inherit Pi until you set an override; the model picker is limited to
  the current Pi provider, and thinking choices follow that model's supported levels.
- **Tools**: the agent definition's `tools` list if set; otherwise pi's full default set.
- **Runtime / concurrency**: package defaults via `/pe-settings` (default max 4
  concurrent; force-kill after 30 minutes). Split longer work into smaller tasks.

## Prompting children

Always pass a **self-contained** prompt. Children do not see the parent transcript.

After spawn, keep working. A completion message arrives when the child finishes unless you
already collected it with `sa_wait` or `sa_cancel`; retrieve the result with `sa_status`.

Tell the user they can open `/sa` to inspect and cancel subagents interactively.

## Side questions

`/btw <question>` starts an ad-hoc subagent for a short side inquiry without blocking the
main chat. Its answer is shown directly to the user when the side task settles.

## Limits

- Bounded concurrency (4 running by default).
- Session shutdown cancels remaining children.
