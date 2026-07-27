# AGENTS.md

Rules for humans and agents working on this repository.

## What this is

A Pi package (`keywords: ["pi-package"]`) of optional extensions, skills, and themes that turn minimal Pi into a multi-agent harness. Behavioral reference: `davis7dotsh/my-pi-setup`. Implementations are original. Subagents are **native pi only** (a separate `pi` process per worker) — no third-party agent CLI. Web search: Firecrawl primary, no-key fallback on quota exhaustion.

Supported Pi version: pin exact `@earendil-works/pi-*` in `devDependencies`. Target documented in README.

## Before you write code

1. Read the relevant official docs under `node_modules/@earendil-works/pi-coding-agent/docs/` (especially `extensions.md`, `packages.md`, `skills.md`, `tui.md`).
2. Read matching files under `node_modules/@earendil-works/pi-coding-agent/examples/extensions/`. Prefer their APIs and patterns over inventing new ones.
3. Check types in `node_modules`; do not guess ExtensionAPI shapes.
4. Do not copy source from the reference repo. Reimplement from behavior and Pi primitives.

## Layout

```
extensions/<name>/index.ts   # one extension per directory; default export factory
skills/<name>/SKILL.md       # only when a skill is needed
themes/*.json                # only when a theme is needed
```

- Do **not** create empty `skills/`, `themes/`, `prompts/`, or `extensions/shared/` until something real needs them.
- Shared helpers live under `extensions/shared/` only after a **second** call site exists. One call site stays local.
- Each extension must load independently and remain disableable via package filters / `pi config`.
- Prefer top-level `extensions/<name>.ts` only for trivial single-file extensions. Multi-file features use a directory + `index.ts`.

## Extension rules

- Export `export default function (pi: ExtensionAPI) { ... }` (or `async` only when startup work is required).
- Register tools with `pi.registerTool` / `defineTool`. Parameters: `Type.*` from `typebox`. Enums for Google compatibility: `StringEnum` from `@earendil-works/pi-ai`.
- Truncate tool output with Pi helpers (`truncateHead`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`). Never dump unbounded stdout into the model context.
- Guard TUI-only paths with `ctx.mode !== "tui"`.
- Use `node:` built-ins. Prefer Node + Pi APIs over new dependencies.
- Runtime third-party packages go in `dependencies`. Bundled Pi packages go in `peerDependencies` with `"*"`: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.
- Top-level imports only. No dynamic/inline imports.
- No speculative abstractions, config layers, or plugin frameworks. Solve only
  the current user-requested scope (YAGNI).
- Do not add a Claude (or other) subagent backend.

## Style

- TypeScript ESM. Match existing file indentation (2 spaces in this repo).
- Keep modules small and focused. Delete dead code; do not leave stubs "for later".
- Comments only when behavior is non-obvious. No narrative comments.
- No emojis in code, commits, or docs unless the user asks.
- Avoid explicit return types unless absolutely needed.
- `as any` is an absolute last resort. Always use real type safety. Lean on type
  inference instead of manually writing new types over and over again.

## Commands

```sh
npm run check          # required after code changes
npm test               # run when tests exist for the touched area
```

- When you finish a change, run the project's check/format/lint commands. If they
  do not exist for the project you are in, suggest adding them.
- Add a focused `node:test` (or package-local test) for every non-trivial lifecycle, parser, or fallback path.
- Do not run full interactive Pi sessions or install packages globally unless the user asks.
- Local smoke load: `pi --extension ./extensions/<name>/index.ts` or install this package path.

## Git

- Commit only when asked.
- Stage explicit paths; never `git add -A`.
- Never use `--no-verify`, `--no-gpg-sign`, or otherwise skip hooks/signing unless explicitly told to.
- Create new commits; do not `--amend` unless explicitly told to (an amend after a hook rejection rewrites the wrong commit).

### Branching

`main` is release-only. `dev` is the integration branch.

- Never commit directly on `main`, and never open a PR targeting `main`.
- Before starting new work, make sure `dev` is current (`git fetch origin && git checkout dev && git pull`), then branch from it: `git checkout -b <branch> dev`. Never branch from a stale local `dev` or from `main`.
- Every PR targets `dev` (`gh pr create --base dev ...`). Only a human maintainer cuts `dev` → `main` releases.
- If you're already on `dev` or `main` with work to commit, stop and create a feature branch first instead of committing in place.

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, scope optional.

- Types actually used in this repo's history: `feat`, `fix`, `docs`, `chore`, `ci`, `build`, `perf`, `refactor`, `test`. Add a scope (e.g. `fix(workflows): ...`) only when the change is confined to one extension/module; omit it for cross-cutting changes.
- Subject: imperative mood ("add", not "added"/"adds"), lowercase after the colon, no trailing period, ideally ≤72 chars.
- Body: blank line after the subject, wrapped ~78 cols. Explain *why*, not a narration of the diff — but when a change touches multiple files/areas, a `path: what changed and why` bullet per area (as in this repo's history) is preferred over prose.
- Trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` on any commit you author.
- Trivial commits (a single obvious change) need no body — subject line only.

### Pull requests

- PR title follows the **same Conventional Commits format** as commit subjects — this repo has squash-merge enabled, so the title becomes the final commit message.
- PR body: a `## Summary` bullet list (what changed and why) and a `## Test plan` checklist (commands run, manual checks). Call out breaking changes and migration steps in their own bullet or section when a change removes or renames anything public (tool params, exported types, config keys).
- Never push or open a PR without the user explicitly asking first.

## Conflicts

If instructions conflict with this file, ask before overriding.
