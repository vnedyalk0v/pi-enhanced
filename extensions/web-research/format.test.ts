import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import {
  formatCrawlResult,
  formatScrapeResult,
  formatSearchResult,
} from "./format.ts";
import type { CrawlPage, CrawlResult } from "./normalize.ts";

describe("web research formatting", () => {
  it("preserves crawl metadata and page order below the limits", () => {
    const result: CrawlResult = {
      provider: "firecrawl",
      url: "https://root.example",
      status: "completed",
      completed: 2,
      total: 3,
      creditsUsed: 4,
      warning: "partial",
      pages: [
        {
          title: "Alpha",
          url: "https://a.example",
          markdown: "first\nsecond\n",
        },
        {
          url: "https://b.example",
          markdown: "",
        },
      ],
    };

    assert.equal(
      formatCrawlResult(result),
      [
        "provider: firecrawl",
        "url: https://root.example",
        "status: completed",
        "pages: 2/3",
        "creditsUsed: 4",
        "warning: partial",
        "",
        "## Alpha",
        "https://a.example",
        "",
        "first",
        "second",
        "",
        "",
        "## https://b.example",
        "https://b.example",
        "",
        "(empty)",
      ].join("\n"),
    );
  });

  it("bounds oversized UTF-8 crawl output and preserves the standard notice", () => {
    const output = formatCrawlResult({
      provider: "firecrawl",
      url: "https://root.example",
      status: "completed",
      pages: [{
        title: "Large",
        url: "https://large.example",
        markdown: Array.from({ length: 400 }, () => "é".repeat(100)).join("\n"),
      }],
    });

    assert.match(output, /^provider: firecrawl\nurl: https:\/\/root\.example\nstatus: completed/);
    assert.match(output, /\n\n\[truncated: first .+ of .+\]$/);
    assert.ok(Buffer.byteLength(output) < DEFAULT_MAX_BYTES + 100);
    assert.ok(!output.includes("\uFFFD"));
  });

  it("preserves a UTF-8-safe prefix of an oversized crawl line", () => {
    const output = formatCrawlResult({
      provider: "firecrawl",
      url: "https://root.example",
      status: "completed",
      pages: [{
        title: "Large",
        url: "https://large.example",
        markdown: "é".repeat(DEFAULT_MAX_BYTES),
      }],
    });
    const noticeAt = output.lastIndexOf("\n\n[truncated:");
    const content = output.slice(0, noticeAt);

    assert.ok(content.endsWith("é"));
    assert.ok(Buffer.byteLength(content) >= DEFAULT_MAX_BYTES - 1);
    assert.ok(Buffer.byteLength(content) <= DEFAULT_MAX_BYTES);
    assert.ok(!output.includes("\uFFFD"));
  });

  it("counts embedded newlines in crawl fields against the line ceiling", () => {
    const output = formatCrawlResult({
      provider: "firecrawl",
      url: "https://root.example",
      status: "completed",
      pages: [{
        title: Array.from({ length: DEFAULT_MAX_LINES }, () => "line").join("\n"),
        url: "https://large.example",
        markdown: "unreachable",
      }],
    });
    const noticeAt = output.lastIndexOf("\n\n[truncated:");
    const content = output.slice(0, noticeAt);

    assert.notEqual(noticeAt, -1);
    assert.equal(content.split("\n").length, DEFAULT_MAX_LINES);
    assert.ok(!content.includes("unreachable"));
  });

  it("does not consume pages after the bounded head is full", () => {
    let laterMarkdownReads = 0;
    const laterPage = {
      title: "Later",
      url: "https://later.example",
      get markdown() {
        laterMarkdownReads++;
        return "x".repeat(DEFAULT_MAX_BYTES * 100);
      },
    };
    const pages: CrawlPage[] = [
      {
        title: "Large",
        url: "https://large.example",
        markdown: Array.from({ length: DEFAULT_MAX_LINES }, () => "line").join("\n"),
      },
      laterPage,
    ];

    const output = formatCrawlResult({
      provider: "firecrawl",
      url: "https://root.example",
      status: "completed",
      pages,
    });
    const marker = "\n\n[truncated:";
    const noticeAt = output.lastIndexOf(marker);
    const content = output.slice(0, noticeAt);
    const consumedBytes = Buffer.byteLength(content);
    const minimumBytes = consumedBytes + Buffer.byteLength("\nline");
    assert.equal(
      output.slice(noticeAt + 2),
      `[truncated: first ${formatSize(consumedBytes)} of at least ${formatSize(minimumBytes)}]`,
    );
    assert.equal(laterMarkdownReads, 0);
  });

  it("honors exact line and multibyte byte ceilings", () => {
    const base = {
      provider: "firecrawl",
      url: "https://root.example",
      status: "completed",
    } as const;
    const exactLines = Array.from({ length: DEFAULT_MAX_LINES - 7 }, () => "é").join("\n");
    const lineBounded = formatCrawlResult({
      ...base,
      pages: [{ title: "Exact", url: "https://page.example", markdown: exactLines }],
    });
    assert.equal(lineBounded.split("\n").length, DEFAULT_MAX_LINES);
    assert.doesNotMatch(lineBounded, /\[truncated:/);

    const prefix = formatCrawlResult({
      ...base,
      pages: [{ title: "Exact", url: "https://page.example", markdown: "" }],
    }).replace("(empty)", "");
    const remaining = DEFAULT_MAX_BYTES - Buffer.byteLength(prefix);
    const exactBytes = `${"é".repeat(Math.floor(remaining / 2))}${remaining % 2 ? "x" : ""}`;
    const byteBounded = formatCrawlResult({
      ...base,
      pages: [{ title: "Exact", url: "https://page.example", markdown: exactBytes }],
    });
    assert.equal(Buffer.byteLength(byteBounded), DEFAULT_MAX_BYTES);
    assert.doesNotMatch(byteBounded, /\[truncated:/);
    assert.ok(!byteBounded.includes("\uFFFD"));
  });

  it("leaves search and scrape formatting unchanged", () => {
    assert.equal(
      formatSearchResult({
        provider: "firecrawl",
        query: "q",
        creditsUsed: 1,
        warning: "w",
        results: [{ title: "T", url: "https://example.com", description: "D" }],
      }),
      [
        "provider: firecrawl",
        "query: q",
        "creditsUsed: 1",
        "warning: w",
        "",
        "1. T",
        "   https://example.com",
        "   D",
      ].join("\n"),
    );
    assert.equal(
      formatScrapeResult({
        provider: "firecrawl",
        url: "https://example.com",
        title: "T",
        warning: "w",
        markdown: "body",
      }),
      [
        "provider: firecrawl",
        "url: https://example.com",
        "title: T",
        "warning: w",
        "",
        "body",
      ].join("\n"),
    );
  });
});
