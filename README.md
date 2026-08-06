# pi-enhanced

`pi-enhanced` is an opinionated [Pi coding agent](https://pi.dev/) package for
repository work. It adds focused tools, background execution, web research,
native pi subagents, structured workflows, skills, and a GitHub-inspired theme
while keeping every extension independently disableable.

The package follows three boundaries:

- subagents are pi's own worker processes only — no third-party agent CLI (no Codex, no Claude);
- Firecrawl is the primary research provider, with a no-key search fallback;
- implementations are original and use Pi's public extension primitives.

## Requirements

| Dependency | Requirement |
| --- | --- |
| Pi | `0.83.0` |
| Node.js | `24.12.0` or newer |
| npm and Git | Available on `PATH` |

Node `24.12.0` is the minimum because its built-in TypeScript type stripping is
stable. The package does not need a TypeScript runtime dependency.

## Install

Install the latest tagged release globally:

```sh
pi install git:github.com/vnedyalk0v/pi-enhanced@v0.1.0
```

For a project-local installation:

```sh
pi install -l git:github.com/vnedyalk0v/pi-enhanced@v0.1.0
```

Try the package for one run without changing Pi settings:

```sh
pi -e git:github.com/vnedyalk0v/pi-enhanced@v0.1.0
```

To load a local checkout:

```sh
pi -e ./
```

Pi packages execute with the user's system permissions. Review the source
before installation and use it only in trusted working directories.

## Features

| Area | Interfaces | What it adds |
| --- | --- | --- |
| Conversation | `ask_user`, `/copy-all`, `/summary` | Structured choices, clipboard export, and model-generated session summaries |
| File search | `fd`, `rg` | Fast filename and content search with bounded model output |
| Git and UI | `/git-info`, `github-dark-default` | Footer branch status and an automatically selected GitHub-style theme |
| Background terminals | `bg_start`, `bg_status`, `bg_list`, `bg_kill`, `/ps` | Long-running non-interactive commands with completion delivery and a bounded output tail |
| Web research | `fc_search`, `fc_scrape`, `fc_crawl` | Firecrawl search/scrape/crawl with DuckDuckGo fallback for no-key or quota-exhausted search |
| Subagents | `sa_spawn`, `sa_agents`, `sa_status`, `sa_list`, `sa_wait`, `sa_cancel`, `/sa`, `/btw` | Isolated native pi workers (ad-hoc or named agent definitions) with bounded concurrency |
| Workflows | `wf_start`, `wf_status`, `wf_list`, `wf_wait`, `wf_cancel`, `/wf`, `/workflow` | Reconnaissance, implementation, review, and synthesis with validated handoffs and artifacts |

The package also provides on-demand skills for background terminals,
subagents, web research, and workflows.

## Configure

Run `pi config` to enable or disable individual extensions, skills, and themes.
Press Tab to switch between global and project-local settings, or start directly
in project-local mode:

```sh
pi config -l
```

Package filters can narrow what is loaded. Omitted resource types continue to
load in full:

```json
{
  "packages": [
    {
      "source": "git:github.com/vnedyalk0v/pi-enhanced@v0.1.0",
      "extensions": ["!extensions/file-search/**"]
    }
  ]
}
```

### Theme

When Pi is using its default dark or light theme, `pi-enhanced` selects
`github-dark-default` automatically. Set it explicitly to keep it selected:

```json
{
  "theme": "github-dark-default"
}
```

### Firecrawl

`FIRECRAWL_API_KEY` is optional. Export it in your shell or add it to
`~/.pi/agent/.env`:

```sh
export FIRECRAWL_API_KEY=fc-your-key-here
```

With a key, all `fc_*` tools use Firecrawl. Without one, or when Firecrawl quota
is exhausted, `fc_search` falls back to no-key DuckDuckGo HTML search.
`fc_scrape` and `fc_crawl` require Firecrawl. Authentication, rate-limit,
bad-request, and transient provider errors do not trigger fallback.

### `fd` and `rg`

The file-search extension resolves `fd` and `rg` from `PATH` first (`fdfind` is
also accepted on Linux), then from `~/.pi/agent/bin/`.

Both must be installed with your platform package manager
(`brew install fd ripgrep`, `apt install fd-find ripgrep`, or the upstream
release pages). When one is missing, the corresponding tool reports the install
command instead of running.

## Operational limits

| Resource | Running limit | Retained results |
| --- | ---: | ---: |
| Background terminals | 8 | 32 |
| Standalone subagents | 4 | 32 |
| Workflows | 1 | 16 |

Each workflow owns a separate four-child subagent pool. Starting jobs reserve
capacity immediately.

Automatic completion messages stay metadata-only; the model retrieves child
output explicitly via `bg_status`, `sa_status`, or `wf_status`. The `/ps`,
`/sa`, and `/wf` commands open interactive viewers for terminals, subagents,
and workflows. `/btw` answers are delivered directly to the user, marked as
untrusted content; delivery waits until the agent is idle so the answer never
starts or steers a model turn.

Background streams retain a 2 MiB in-memory tail per stream; older output is
dropped and is not recoverable, so redirect a command to a file when you need
its complete log. Truncated `fd`/`rg` results spill full output to a private
temporary file with a 16 MiB cap; larger spills are labeled partial and all
spill files are removed at Pi session shutdown. Native subagent JSON
result records have a 4 MiB UTF-8 ceiling. An oversized record fails the worker
instead of returning a truncated successful result. Subagents (standalone and
workflow children) are force-killed after 30 minutes of runtime.
Workflow artifacts use private OS-temporary directories reported by
`wf_status`; completed artifacts survive the session but are not durable or
cross-machine storage.

Background commands and child agents inherit the Pi process environment and
run in the requested working directory. Subagent sandboxing is whatever the
`pi` CLI itself provides; this is a guardrail, not a security boundary. Treat
repository contents, agent output, workflow handoffs, and artifacts as
untrusted evidence. Project-local agent definitions (`.pi/agents/*.md`) are
repo-controlled prompts — they only load for trusted projects, and `sa_spawn`
confirms before running one interactively.

## Troubleshooting

- `pi` not found: install the CLI and confirm it is on `PATH`.
- `fd` or `rg` not found: install it with your package manager and confirm it is
  on `PATH` (the tool error names the install command).
- Firecrawl fails: set `FIRECRAWL_API_KEY` for scrape/crawl. Only missing-key or
  quota-exhausted search uses the fallback.
- Concurrency limit reached: wait for or cancel an existing `bt-*`, `sa-*`, or
  `wf-*` job.
- Missing output: inspect `bg_status` for the retained tail, `wf_status` for
  workflow artifacts, or the full-output path returned by truncated `fd`/`rg`
  results.

## Development

```sh
npm install
npm run verify
npm pack --dry-run --json
```

`npm run verify` runs TypeScript type-checking, the Node test suite, and an
aggregate-package smoke load. CI runs the same gate on Node 24.12.0 and the
latest Node 24 release.

## Acknowledgments

The package takes behavioral inspiration from
[`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup).
Implementations in this repository are original.

## License

Licensed under the [MIT License](LICENSE).
