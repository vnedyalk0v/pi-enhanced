import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { CrawlResult, ScrapeResult, SearchResult } from "./normalize.ts";
import type { ClassifiedError } from "./errors.ts";

export function formatSearchResult(result: SearchResult): string {
  const lines = [
    `provider: ${result.provider}`,
    `query: ${result.query}`,
  ];
  if (result.creditsUsed !== undefined) {
    lines.push(`creditsUsed: ${result.creditsUsed}`);
  }
  if (result.warning) lines.push(`warning: ${result.warning}`);
  lines.push("");

  if (result.results.length === 0) {
    lines.push("No results.");
    return lines.join("\n");
  }

  result.results.forEach((hit, i) => {
    lines.push(`${i + 1}. ${hit.title}`);
    lines.push(`   ${hit.url}`);
    if (hit.description) lines.push(`   ${hit.description}`);
    lines.push("");
  });

  return truncateForModel(lines.join("\n").trimEnd());
}

export function formatScrapeResult(result: ScrapeResult): string {
  const lines = [
    `provider: ${result.provider}`,
    `url: ${result.url}`,
  ];
  if (result.title) lines.push(`title: ${result.title}`);
  if (result.warning) lines.push(`warning: ${result.warning}`);
  lines.push("", result.markdown || "(empty)");
  return truncateForModel(lines.join("\n"));
}

export function formatCrawlResult(result: CrawlResult): string {
  const lines = [
    `provider: ${result.provider}`,
    `url: ${result.url}`,
    `status: ${result.status}`,
  ];
  if (result.completed !== undefined || result.total !== undefined) {
    lines.push(`pages: ${result.completed ?? result.pages.length}/${result.total ?? "?"}`);
  }
  if (result.creditsUsed !== undefined) lines.push(`creditsUsed: ${result.creditsUsed}`);
  if (result.warning) lines.push(`warning: ${result.warning}`);
  lines.push("");

  for (const page of result.pages) {
    lines.push(`## ${page.title || page.url}`);
    lines.push(page.url);
    lines.push("");
    lines.push(page.markdown || "(empty)");
    lines.push("");
  }

  return truncateForModel(lines.join("\n").trimEnd());
}

export function formatProviderError(err: ClassifiedError, tool: string): string {
  const lines = [
    `Error (${err.kind}) from ${tool}`,
    err.message,
  ];
  if (err.status !== undefined) lines.push(`HTTP status: ${err.status}`);
  if (err.kind === "quota") {
    if (tool === "fc_search") {
      lines.push("Search will attempt a no-key fallback when Firecrawl quota is exhausted.");
    } else {
      lines.push(
        "Scrape/crawl have no fallback yet. Wait for credits, upgrade Firecrawl, or use fc_search for discovery only.",
      );
    }
  }
  return lines.join("\n");
}

function truncateForModel(text: string): string {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return truncation.content;
  return (
    truncation.content +
    `\n\n[truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines` +
    ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`
  );
}

export const TOOL_LIMITS_NOTE =
  `Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`;
