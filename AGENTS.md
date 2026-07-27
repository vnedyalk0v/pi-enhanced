# AGENTS.md

Rules for humans and agents working on this repository.

## What this is

A Pi package (`keywords: ["pi-package"]`) of optional extensions, skills, and themes that turn minimal Pi into a multi-agent harness. Behavioral reference: `davis7dotsh/my-pi-setup`. Implementations are original. Subagents are **native pi only** (a separate `pi` process per worker) — no third-party agent CLI. Web search: Firecrawl primary, no-key fallback on quota exhaustion.

Supported Pi version: pin exact `@earendil-works/pi-*` in `devDependencies` (target documented in README).

## Before you write code

1. Read relevant docs under `node_modules/@earendil-works/pi-coding-agent/docs/` (`extensions.md`, `packages.md`, `skills.md`, `tui.md`) and matching files under `.../examples/extensions/`; prefer their APIs/patterns over inventing new ones.
2. Check types in `node_modules`; do not guess ExtensionAPI shapes.
3. Do not copy source from the reference repo — reimplement from behavior and Pi primitives.

## Layout

```
extensions/<name>/index.ts   # one extension per directory; default export factory
skills/<name>/SKILL.md       # only when a skill is needed
themes/*.json                # only when a theme is needed
```

- Do **not** create empty `skills/`, `themes/`, `prompts/`, or `extensions/shared/` until something real needs them.
- Shared helpers move to `extensions/shared/` only after a **second** call site exists; one call site stays local.
- Each extension must load independently and remain disableable via package filters / `pi config`.
- Prefer top-level `extensions/<name>.ts` only for trivial single-file extensions; multi-file features use a directory + `index.ts`.

## Extension rules

- Export `export default function (pi: ExtensionAPI) { ... }` (`async` only when startup work is required).
- Register tools with `pi.registerTool`/`defineTool`; parameters via `Type.*` (typebox), enums via `StringEnum` from `@earendil-works/pi-ai` (Google compatibility).
- Truncate tool output with Pi helpers (`truncateHead`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`) — never dump unbounded stdout into model context.
- Guard TUI-only paths with `ctx.mode !== "tui"`.
- Use `node:` built-ins; prefer Node/Pi APIs over new dependencies.
- Runtime deps go in `dependencies`; bundled Pi packages go in `peerDependencies` with `"*"`: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.
- Top-level imports only; no dynamic/inline imports.
- No speculative abstractions, config layers, or plugin frameworks — solve only the current user-requested scope (YAGNI).
- Do not add a Claude (or other) subagent backend.

## Style

- TypeScript ESM; match existing indentation (2 spaces).
- Keep modules small and focused; delete dead code, no stubs "for later".
- Comments only for non-obvious behavior — no narrative comments.
- No emojis in code, commits, or docs unless the user asks.
- Avoid explicit return types unless absolutely needed.
- `as any` is a last resort — use real type safety and lean on inference over hand-written types.

## Commands

```sh
npm run check          # required after code changes
npm test               # run when tests exist for the touched area
```

- If check/test commands don't exist for the project, suggest adding them.
- Add a focused `node:test` (or package-local test) for every non-trivial lifecycle, parser, or fallback path.
- Do not run full interactive Pi sessions or install packages globally unless the user asks.
- Local smoke load: `pi --extension ./extensions/<name>/index.ts` or install this package path.

## Git

- Commit only when asked.
- Stage explicit paths; never `git add -A`.
- Never skip hooks/signing (`--no-verify`, `--no-gpg-sign`) unless told to.
- Create new commits; do not `--amend` unless told to (amend after a hook rejection rewrites the wrong commit).

### Branching

`main` is release-only (human-cut `dev` → `main`); `dev` is the integration branch.

- Never commit or open a PR on `main`.
- New work: `git fetch origin && git checkout -B <branch> origin/dev` — never branch from a stale local `dev` or from `main`.
- Every PR targets `dev` (`gh pr create --base dev`).
- Already sitting on `dev`/`main` with uncommitted work? Branch first, then commit.

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`. Types used here: `feat fix docs chore ci build perf refactor test`; add scope only for single-area changes.

- Subject: imperative, lowercase after the colon, no trailing period, ≤72 chars.
- Body (skip for trivial commits): blank line, wrap ~78 cols, explain *why*; for multi-area changes prefer `path: what/why` bullets over prose.
- Trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

### Pull requests

- Title: same Conventional Commits format as commits (squash-merge makes it the final message).
- Body: `## Summary` bullets + `## Test plan` checklist; call out breaking changes/migration when a public surface (tool params, exported types, config keys) changes.
- Never push or open a PR unless asked.

## Conflicts

If instructions conflict with this file, ask before overriding.
