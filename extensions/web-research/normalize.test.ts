import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeFirecrawlCrawl,
  normalizeFirecrawlScrape,
  normalizeFirecrawlSearch,
  normalizeFallbackSearch,
} from "./normalize.ts";

describe("normalizeFirecrawlSearch", () => {
  it("maps v2 web results and provider", () => {
    const result = normalizeFirecrawlSearch(
      "pi agent",
      {
        success: true,
        creditsUsed: 2,
        data: {
          web: [
            {
              title: "Pi",
              url: "https://pi.dev/",
              description: "Coding agent",
            },
          ],
        },
      },
      2,
    );
    assert.equal(result.provider, "firecrawl");
    assert.equal(result.query, "pi agent");
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.url, "https://pi.dev/");
    assert.equal(result.creditsUsed, 2);
  });
});

describe("normalizeFirecrawlScrape", () => {
  it("extracts markdown and title", () => {
    const result = normalizeFirecrawlScrape("https://example.com", {
      success: true,
      data: {
        markdown: "# Hello",
        metadata: { title: "Example", sourceURL: "https://example.com" },
      },
    });
    assert.equal(result.provider, "firecrawl");
    assert.equal(result.markdown, "# Hello");
    assert.equal(result.title, "Example");
  });
});

describe("normalizeFirecrawlCrawl", () => {
  it("maps pages", () => {
    const result = normalizeFirecrawlCrawl("https://example.com", {
      status: "completed",
      total: 1,
      completed: 1,
      data: [
        {
          markdown: "page",
          metadata: { title: "Home", sourceURL: "https://example.com/" },
        },
      ],
    });
    assert.equal(result.provider, "firecrawl");
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0]?.title, "Home");
  });
});

describe("normalizeFallbackSearch", () => {
  it("labels duckduckgo provider", () => {
    const result = normalizeFallbackSearch("q", [
      { title: "T", url: "https://x.test", description: "d" },
    ]);
    assert.equal(result.provider, "duckduckgo");
    assert.match(result.warning ?? "", /fallback/i);
  });
});
