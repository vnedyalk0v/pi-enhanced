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

## Status

Phases 1–6 on Pi `0.82.1`. Install the package (or `pi -e ./`), then try
`/copy-all`, `ask_user`, `fd`/`rg`, `/summary`, `bg_start` + `/ps`,
`fc_search`, `sa_spawn`, and `wf_start` / `/workflow`.

Set the theme in settings if you want it always:

```json
{ "theme": "github-dark-default" }
```

For Firecrawl scrape/crawl (and preferred search quality):

```sh
export FIRECRAWL_API_KEY=fc-...
# or put it in ~/.pi/agent/.env
```

See [PLAN.md](PLAN.md) for the remaining implementation sequence.

## Development

Requires Node.js `22.19.0` or newer. Extensions load as a Pi package via the
`pi` manifest in `package.json` (or convention directories).

```sh
npm install
npm run check
npm test
pi -e ./
```

For a normal installation from GitHub:

```sh
pi install git:github.com/vnedyalk0v/pi-enhanced
```

To try without installing into `~/.pi/agent`:

```sh
pi -e ./
```

## Reference boundary

The reference repository currently has no declared license. This project will
use it as a product and behavior reference, but implementations will be written
independently unless compatible licensing is added or explicit permission is
obtained.
