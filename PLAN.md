# Build plan

## Goal

Ship a maintainable starter configuration for Pi that restores the useful
features intentionally absent from its minimal core, while keeping each
extension optional and independently testable.

## Principles

- Reuse Pi's extension, skill, command, and TUI primitives.
- Prefer built-in Node.js and Pi APIs over new dependencies.
- Keep Pi and Codex behind one small subagent contract; do not add a Claude
  backend.
- Add one focused runnable check for every non-trivial lifecycle or parser.
- Treat `davis7dotsh/my-pi-setup` as a behavioral reference, not a source-code
  dependency.

## Phase 1 — Foundation ✅

- Confirm the supported Pi version and extension API against current
  documentation.
- Add the minimal TypeScript project, formatting, type-checking, and Node test
  commands.
- Establish `extensions/`, `skills/`, `themes/`, and shared utilities only when
  a second extension needs them.
- Document installation into `~/.pi/agent` without overwriting existing user
  configuration.

**Completed:** Pi `0.82.1` loads the foundation extension, `/pi-enhanced`
confirms it in the real TUI, and `npm run check` runs the repository gate.

## Phase 2 — Small first-class tools ✅

Implement the low-risk extensions first:

1. `copy-all` — `/copy-all` copies the full conversation branch
2. `ask-user` — `ask_user` multiple-choice tool (optional free text)
3. `file-search` — `fd` / `rg` tools with PATH + `~/.pi/agent/bin` + HTTPS install
4. `git-info` — branch/dirty/ahead/behind status in the footer
5. `model-info` — model, thinking level, context usage status
6. `ui-customization` + `themes/github-dark-default.json`
7. `summaries` — `/summary` via the active session model

**Completed:** extensions and theme land in-tree; `npm run check` and
`npm test` (file-search unit tests) pass. Real-session smoke still recommended
before calling Phase 2 fully done in a release sense.

## Phase 3 — Background terminals ✅

- Add start, list, status, and stop tools for long-lived non-interactive
  commands.
- Capture bounded output while preserving full logs outside model context.
- Deliver one completion event to the parent session.
- Add `/ps` for interactive inspection.
- Add a skill that directs long-running commands to background terminals and
  keeps quick commands in the normal shell tool.

**Completed:** `bg_start` / `bg_status` / `bg_list` / `bg_kill`, one-shot
completion via `sendMessage` (followUp + triggerTurn), spill-file full logs
with truncated model tails, `/ps` list+detail UI, running-count widget, and
`skills/background-terminals`. Manager unit tests cover start/settle/kill/
concurrency/dispose; `npm run check` and `npm test` pass.

## Phase 4 — Web research with graceful quota fallback ✅

- Add Firecrawl search, scrape, and crawl tools using `FIRECRAWL_API_KEY`.
- Normalize provider results before exposing them to the model.
- Detect explicit quota exhaustion separately from authentication, malformed
  requests, and transient failures.
- On quota exhaustion, route `search` to a no-key normal web-search provider
  selected after checking Pi's current native/package capabilities.
- Keep the first fallback deliberately narrow: search must continue; scrape and
  crawl may report a clear quota error until a reliable native alternative is
  proven.
- Surface which provider answered so the model can judge result quality.

**Completed:** `fc_search` / `fc_scrape` / `fc_crawl` (Firecrawl v2 via
`fetch`, no SDK; `fc_*` names avoid clashing with packages that own
`web_search`). Error classifier separates quota (402 / credit messages)
from auth, rate limit, bad request, and transient. Search falls back to
no-key DuckDuckGo HTML when Firecrawl is missing or quota-exhausted; scrape
and crawl return clear quota errors. Results always include `provider`.
Skill `web-research`. Tests cover classification, normalize, fallback parse,
and Firecrawl client mocks.

## Phase 5 — Pi and Codex subagents ✅

- Define one backend contract with only `pi` and `codex` implementations.
- Support spawn, check, list, wait, cancel, completion delivery, and bounded
  concurrency.
- Give every child an isolated context and a self-contained prompt.
- Default Pi children to the parent model and reasoning level.
- Default Codex children to the configured coding model and high reasoning,
  while allowing explicit overrides.
- Add transcript viewing, follow-up messages, and interactive takeover after
  the lifecycle is stable.
- Add a `/btw` side task that can research a question without interrupting the
  main agent.
- Add a routing skill explaining when Pi or Codex is the better worker.

**Completed (lifecycle v1):** `sa_spawn` / `sa_status` / `sa_list` / `sa_wait` /
`sa_cancel` with backends `pi` and `codex` only (`sa_*` names avoid clashing
with packages that own `subagent` / `subagent_wait`); isolated `--no-session`
Pi / `codex exec --ephemeral`; one-shot completion via followUp; concurrency
cap 4; `/btw` Pi side task; routing skill. Status shows result/output tail
(basic transcript). Follow-up messages and interactive takeover deferred until
needed. Manager tests use injected backends; `npm run check` / `npm test` pass.

## Phase 6 — Workflows

- Represent a workflow as ordered phases containing parallel agent tasks.
- Pass validated structured outputs into later phases.
- Start with reconnaissance, implementation, review, and synthesis.
- Reuse the subagent lifecycle instead of creating a second runner.
- Store workflow artifacts outside the prompt and expose a compact status view.
- Add an interactive dashboard only after headless execution is reliable.

**Done when:** a sample repository task completes all four phases, preserves
artifacts, and returns one synthesized result after partial-agent failure.

## Phase 7 — Release and adoption

- Add setup, configuration, environment-variable, and troubleshooting docs.
- Test installation in a clean Pi configuration.
- Document how to enable extensions individually.
- Record supported platforms and known ceilings.
- Tag `v0.1.0` only after the real-session checks for every starter feature pass.

## Initial delivery order

`foundation → small tools → background terminals → web fallback → subagents → workflows → release`

This order proves Pi integration early and leaves the two stateful systems,
subagents and workflows, until their shared primitives are understood.
