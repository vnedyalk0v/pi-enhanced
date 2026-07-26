# AGENTS.md

Rules for humans and agents working on this repository.

## What this is

A Pi package (`keywords: ["pi-package"]`) of optional extensions, skills, and themes that turn minimal Pi into a multi-agent harness. Behavioral reference: `davis7dotsh/my-pi-setup`. Implementations are original. Subagent backends: **Pi and Codex only**. Web search: Firecrawl primary, no-key fallback on quota exhaustion.

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
- No `any` unless unavoidable. Prefer inference; avoid redundant explicit return types.
- No speculative abstractions, config layers, or plugin frameworks. Solve the current phase in PLAN.md only (YAGNI).
- Do not add a Claude (or other) subagent backend.

## Style

- TypeScript ESM. Match existing file indentation (2 spaces in this repo).
- Keep modules small and focused. Delete dead code; do not leave stubs "for later".
- Comments only when behavior is non-obvious. No narrative comments.
- No emojis in code, commits, or docs unless the user asks.

## Commands

```sh
npm run check          # required after code changes
```

- Add a focused `node:test` (or package-local test) for every non-trivial lifecycle, parser, or fallback path.
- Do not run full interactive Pi sessions or install packages globally unless the user asks.
- Local smoke load: `pi --extension ./extensions/<name>/index.ts` or install this package path.

## Git

- Commit only when asked.
- Stage explicit paths; never `git add -A`.
- Message: short imperative subject. Body only if the why is non-obvious.

## Conflicts

If instructions conflict with this file, ask before overriding.
