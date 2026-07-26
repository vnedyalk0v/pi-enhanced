---
name: web-research
description: Search and scrape the web with Firecrawl tools (fc_search, fc_scrape, fc_crawl). Use when researching docs, APIs, or pages online. Prefer fc_search for discovery; fc_scrape for a known URL; fc_crawl only when multiple pages from one site are needed.
---

# Web research

## Tools

Named `fc_*` so they do not clash with other packages that register `web_search`.

- `fc_search` — discover URLs and snippets. Primary provider is Firecrawl (`FIRECRAWL_API_KEY`). If Firecrawl quota is exhausted, search falls back to a no-key DuckDuckGo path. Results always include `provider:`.
- `fc_scrape` — full page markdown for one URL (Firecrawl only).
- `fc_crawl` — bounded multi-page crawl from a start URL (Firecrawl only; keep `limit` small).

## Guidance

1. Start with `fc_search` unless you already have a URL.
2. Use `fc_scrape` for full content; do not dump entire crawls into context.
3. Prefer small crawl limits (e.g. 5–10). Crawl and scrape have **no** fallback when Firecrawl credits run out — report that clearly.
4. Treat `provider: duckduckgo` results as lower-fidelity than Firecrawl.

## Configuration

Set `FIRECRAWL_API_KEY` in the environment or `~/.pi/agent/.env`. Without a key, only `fc_search` works (via the no-key fallback).
