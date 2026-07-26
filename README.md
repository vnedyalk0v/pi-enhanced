# pi-enhanced

An opinionated set of extensions and skills that turns the minimal
[Pi coding agent](https://pi.dev/) into a practical multi-agent development
harness.

The project starts from the ideas demonstrated in
[davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup), with two
intentional differences:

- subagents use only the Pi and Codex harnesses;
- Firecrawl is the primary web-search provider, with a normal-search fallback
  when the free-plan quota is exhausted.

## Features

**Phase 6 (available now)**

- `/copy-all` — copy the full conversation branch to the clipboard
- `ask_user` — structured multiple-choice questions (optional free text)
- `fd` / `rg` tools — default file discovery (preferred over built-in find/grep);
  system binaries, or auto-install into `~/.pi/agent/bin/`
- Git dirty/ahead/behind status in Pi's built-in footer
- GitHub Dark Default theme
- `/summary` — summarize the session with the active model
- Background terminals — `bg_start` / `bg_status` / `bg_list` / `bg_kill`, `/ps`,
  auto completion message, skill guidance for long-running commands
- Web research — `fc_search` / `fc_scrape` / `fc_crawl` (Firecrawl primary;
  DuckDuckGo no-key fallback for search on quota exhaustion; `fc_*` names avoid
  clashing with packages that register `web_search`)
- Subagents — `sa_spawn` (pi|codex), `sa_status` / `sa_list` / `sa_wait` /
  `sa_cancel`, `/btw`, completion delivery, routing skill (`sa_*` names avoid
  clashing with packages that register `subagent` / `subagent_wait`)
- Workflows — `wf_start` / `wf_status` / `wf_list` / `wf_wait` / `wf_cancel`,
  `/workflow` for recon → implement → review → synthesis; on-disk artifacts and
  structured handoffs reusing the subagent lifecycle (`wf_*` names)

**Planned**

- Subagent follow-up messages and interactive takeover
- Interactive workflow dashboard (after more real-session use)

## Install

Requirements: Pi `0.82.1`, Node.js `22.19.0` or newer, and npm. The `pi`
executable must be on `PATH`; `codex` is required only for Codex subagents and
the workflow implementation phase.

```sh
pi install git:github.com/vnedyalk0v/pi-enhanced@v0.1.0
```

To load a checkout for one run without changing Pi settings:

```sh
pi -e ./
```

Pi packages execute with the user's system permissions. Review the package
before installing it and use it only in trusted working directories.

## Configure

Run `pi config` to enable or disable individual extensions, skills, and themes.
Package filters can also narrow one installation; omitted resource types still
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

Set the theme in Pi settings if you want it always:

```json
{ "theme": "github-dark-default" }
```

`FIRECRAWL_API_KEY` is optional. Export it or put it in
`~/.pi/agent/.env` to enable `fc_scrape`, `fc_crawl`, and preferred
`fc_search` results. Without a key, or when Firecrawl quota is exhausted,
`fc_search` uses the no-key DuckDuckGo fallback; authentication, rate-limit,
bad-request, and transient errors do not trigger fallback.

`fd` and `rg` are resolved from `PATH` first (`fdfind` is also accepted for
`fd` on Linux), then from `~/.pi/agent/bin/`. Missing binaries are downloaded
there only on macOS and Linux, for x64 and arm64, and verified against pinned
SHA-256 digests. On Windows or another unsupported target, install `fd` and
`rg` with the platform package manager and make them available on `PATH`.

## Operations

- Background terminals allow 8 running jobs and retain 32 settled jobs. Each
  stream keeps a 2 MiB in-memory tail; full logs live in a private OS-temp
  session directory and are removed at Pi session shutdown.
- Standalone subagents allow 4 running children and retain 32 settled children.
  A workflow allows 1 running workflow, retains 16 settled workflows, and has
  its own 4-child pool; its two reconnaissance tasks are the widest parallel
  phase. Jobs still starting reserve capacity in each limit.
- `bg_kill`, `sa_cancel`, and `wf_cancel` terminate process trees; shutdown
  cancels remaining jobs. Firecrawl also makes a best-effort request to cancel
  a crawl abandoned by timeout, error, or caller abort.
- `wf_status` reports each workflow's collision-proof private OS-temp artifact
  directory. Completed artifacts are preserved after the session, but OS-temp
  storage is not a durable or cross-machine archive.
- Truncated `fd`/`rg` output reports a full-output OS-temp path. Untruncated
  temporary output is deleted immediately; truncated spill files are left for
  operating-system temp cleanup.

Background commands and Pi/Codex children inherit the Pi process environment
and run in the requested working directory. Codex children use its
`workspace-write` sandbox with approvals disabled, but that is a guardrail, not
a security boundary. Pass self-contained prompts, restrict children to trusted
directories, and treat repository contents, workflow handoffs, and artifacts
as untrusted evidence.

### Troubleshooting

- `pi` or `codex` not found: install the CLI and confirm it is on `PATH`;
  `codex` is unnecessary when using only Pi workers.
- `fd` or `rg` installation fails: install the binary manually on unsupported
  platforms; on supported targets, check HTTPS access, `tar`, directory
  permissions, and the reported digest error.
- Firecrawl fails: set `FIRECRAWL_API_KEY` for scrape/crawl; quota exhaustion
  falls back only for search. Other provider errors are returned directly.
- Concurrency limit: wait for or cancel an existing `bg-*`, `sa-*`, or `wf-*`
  job. Starting jobs already consume their reserved slot.
- Missing output: use `bg_status` for spill-log paths, `wf_status` for workflow
  artifact paths, or the full-output path printed by a truncated `fd`/`rg`
  result. Background logs disappear at shutdown; workflow and file-search
  paths may later disappear when OS temp is cleaned.

## Development

```sh
npm install
npm run verify
```

`npm run verify` runs type-checking, tests, and the non-interactive aggregate
package smoke check. See [PLAN.md](PLAN.md) for release readiness.

## License

This project is licensed under the [MIT License](LICENSE).

## Reference boundary

The reference repository currently has no declared license. This project will
use it as a product and behavior reference, but implementations will be written
independently unless compatible licensing is added or explicit permission is
obtained.
