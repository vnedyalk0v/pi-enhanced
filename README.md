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

**Phase 3 (available now)**

- `/copy-all` — copy the full conversation branch to the clipboard
- `ask_user` — structured multiple-choice questions (optional free text)
- `fd` / `rg` tools — system binaries, or auto-install into `~/.pi/agent/bin/`
- Git + model/context status in the footer
- Enhanced footer (`/footer-enhanced`) and GitHub Dark Default theme
- `/summary` — summarize the session with the active model
- Background terminals — `bg_start` / `bg_status` / `bg_list` / `bg_kill`, `/ps`,
  auto completion message, skill guidance for long-running commands

**Planned**

- Pi and Codex subagents with background execution and result delivery
- multi-phase workflows with parallel agents and structured handoffs
- Firecrawl search, scrape, and crawl tools with quota-aware fallback

## Status

Phases 1–3 on Pi `0.82.1`. Install the package (or `pi -e ./`), then try
`/copy-all`, `ask_user`, `fd`/`rg`, `/summary`, and `bg_start` + `/ps`.

Set the theme in settings if you want it always:

```json
{ "theme": "github-dark-default" }
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
