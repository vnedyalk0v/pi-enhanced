import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { StringDecoder } from "node:string_decoder";
import {
  formatTruncationNotice,
  truncateForModel,
  UNTRUSTED_CONTENT_NOTICE,
} from "../shared/text.ts";
import type { ClassifiedError } from "./errors.ts";
import type { CrawlResult, ScrapeResult, SearchResult } from "./normalize.ts";

export function formatSearchResult(result: SearchResult): string {
  const lines = [
    `provider: ${result.provider}`,
    `query: ${result.query}`,
  ];
  if (result.creditsUsed !== undefined) {
    lines.push(`creditsUsed: ${result.creditsUsed}`);
  }
  if (result.warning) lines.push(`warning: ${result.warning}`);

  if (result.results.length === 0) {
    lines.push("", "No results.");
    return lines.join("\n");
  }

  lines.push(UNTRUSTED_CONTENT_NOTICE);
  lines.push("");

  result.results.forEach((hit, i) => {
    lines.push(`${i + 1}. ${hit.title}`);
    lines.push(`   ${hit.url}`);
    if (hit.description) lines.push(`   ${hit.description}`);
    lines.push("");
  });

  return truncateForModel(lines.join("\n").trimEnd(), { mode: "head" });
}

export function formatScrapeResult(result: ScrapeResult): string {
  const lines = [`provider: ${result.provider}`, UNTRUSTED_CONTENT_NOTICE];
  lines.push(`url: ${result.url}`);
  if (result.title) lines.push(`title: ${result.title}`);
  if (result.warning) lines.push(`warning: ${result.warning}`);
  lines.push("", result.markdown || "(empty)");
  return truncateForModel(lines.join("\n"), { mode: "head" });
}

export function formatCrawlResult(result: CrawlResult): string {
  const state = {
    lines: [] as string[],
    bytes: 0,
    truncatedTotalBytes: 0,
  };
  const appendLine = (line: string) => {
    const separatorBytes = state.lines.length === 0 ? 0 : 1;
    const remainingBytes = DEFAULT_MAX_BYTES - state.bytes - separatorBytes;
    const lineBytes = Buffer.byteLength(line);
    if (state.lines.length >= DEFAULT_MAX_LINES) {
      state.truncatedTotalBytes = state.bytes + separatorBytes + lineBytes;
      return false;
    }
    if (lineBytes > remainingBytes) {
      state.truncatedTotalBytes = state.bytes + separatorBytes + lineBytes;
      if (remainingBytes > 0) {
        const decoder = new StringDecoder("utf8");
        const prefix = decoder.write(Buffer.from(line).subarray(0, remainingBytes));
        if (prefix) {
          state.lines.push(prefix);
          state.bytes += separatorBytes + Buffer.byteLength(prefix);
        }
      }
      return false;
    }
    state.lines.push(line);
    state.bytes += separatorBytes + lineBytes;
    return true;
  };
  const append = (text: string, start = 0, end = text.length) => {
    const value = text.slice(start, end);
    let lineStart = 0;
    while (true) {
      const newline = value.indexOf("\n", lineStart);
      if (newline === -1) return appendLine(value.slice(lineStart));
      if (!appendLine(value.slice(lineStart, newline))) return false;
      lineStart = newline + 1;
    }
  };

  const metadata = [
    `provider: ${result.provider}`,
    `url: ${result.url}`,
    `status: ${result.status}`,
  ];
  if (result.completed !== undefined || result.total !== undefined) {
    metadata.push(`pages: ${result.completed ?? result.pages.length}/${result.total ?? "?"}`);
  }
  if (result.creditsUsed !== undefined) metadata.push(`creditsUsed: ${result.creditsUsed}`);
  if (result.warning) metadata.push(`warning: ${result.warning}`);
  metadata.push(UNTRUSTED_CONTENT_NOTICE);
  metadata.push("");
  for (const line of metadata) {
    if (!append(line)) break;
  }

  for (let index = 0; index < result.pages.length && !state.truncatedTotalBytes; index++) {
    const page = result.pages[index];
    if (!append(`## ${page.title || page.url}`) || !append(page.url) || !append("")) break;

    const markdown = page.markdown || "(empty)";
    let end = markdown.length;
    if (index === result.pages.length - 1) {
      while (end > 0 && markdown[end - 1].trim() === "") end--;
    }
    let start = 0;
    while (start < end && !state.truncatedTotalBytes) {
      const newline = markdown.indexOf("\n", start);
      if (newline === -1 || newline >= end) {
        append(markdown, start, end);
        break;
      }
      if (!append(markdown, start, newline)) break;
      start = newline + 1;
    }
    if (
      !state.truncatedTotalBytes &&
      index < result.pages.length - 1 &&
      end > 0 &&
      markdown[end - 1] === "\n"
    ) {
      append("");
    }
    if (!state.truncatedTotalBytes && index < result.pages.length - 1) append("");
  }

  const content = state.lines.join("\n");
  if (!state.truncatedTotalBytes) return content.trimEnd();
  return (
    content +
    `\n\n${formatTruncationNotice("head", state.bytes, state.truncatedTotalBytes, true)}`
  );
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
