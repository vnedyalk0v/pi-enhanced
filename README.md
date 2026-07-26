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

## Planned starter features

- Pi and Codex subagents with background execution and result delivery
- multi-phase workflows with parallel agents and structured handoffs
- managed background terminals for servers, watchers, and long-running commands
- first-class `fd` and `rg` tools
- structured multiple-choice questions
- Firecrawl search, scrape, and crawl tools with quota-aware fallback
- Git, model, context, and working-directory status in the TUI
- session copy and summary commands
- a GitHub Dark Default theme

## Status

Foundation complete on Pi `0.82.1`. Run `/pi-enhanced` in Pi to verify that the
starter extension loaded.

See [PLAN.md](PLAN.md) for the remaining implementation sequence and acceptance
criteria.

## Development

Requires Node.js `22.19.0` or newer. Extensions load as a Pi package via the
`pi` manifest in `package.json` (or convention directories).

```sh
npm install
npm run check
pi --extension ./extensions/foundation/index.ts
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
