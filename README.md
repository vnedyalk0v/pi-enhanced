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
| Background terminals | `bg_start`, `bg_status`, `bg_list`, `bg_kill`, `/ps` | Long-running non-interactive commands with completion delivery and bounded spill logs |
| Web research | `fc_search`, `fc_scrape`, `fc_crawl` | Firecrawl search/scrape/crawl with DuckDuckGo fallback for no-key or quota-exhausted search |
| Subagents | `sa_spawn`, `sa_agents`, `sa_status`, `sa_list`, `sa_wait`, `sa_cancel`, `/btw` | Isolated native pi workers (ad-hoc or named agent definitions) with bounded concurrency |
| Workflows | `wf_start`, `wf_status`, `wf_list`, `wf_wait`, `wf_cancel`, `/workflow` | Reconnaissance, implementation, review, and synthesis with validated handoffs and artifacts |

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

When missing, pinned binaries are downloaded on macOS and Linux for x64 and
arm64, verified with SHA-256, and installed into that directory. On Windows or
another unsupported target, install `fd` and `rg` with the platform package
manager and expose them on `PATH`.

## Operational limits

| Resource | Running limit | Retained results |
| --- | ---: | ---: |
| Background terminals | 8 | 32 |
| Standalone subagents | 4 | 32 |
| Workflows | 1 | 16 |

Each workflow owns a separate four-child subagent pool. Starting jobs reserve
capacity immediately.

Background streams retain a 2 MiB in-memory tail and spill up to 16 MiB per
stream, capped at 64 MiB per Pi session, to a private OS-temporary directory.
Partial spill logs are labeled, and all logs are removed at Pi session shutdown.
Native subagent JSON result records have a 4 MiB UTF-8 ceiling. An oversized
record fails the worker instead of returning a truncated successful result.
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
- `fd` or `rg` installation fails: check HTTPS access, `tar`, directory
  permissions, and the reported digest; install manually on unsupported
  platforms.
- Firecrawl fails: set `FIRECRAWL_API_KEY` for scrape/crawl. Only missing-key or
  quota-exhausted search uses the fallback.
- Concurrency limit reached: wait for or cancel an existing `bg-*`, `sa-*`, or
  `wf-*` job.
- Missing output: inspect `bg_status` for spill logs, `wf_status` for workflow
  artifacts, or the full-output path returned by truncated `fd`/`rg` results.

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
