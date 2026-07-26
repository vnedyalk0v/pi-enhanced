import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { classifyThrown } from "./errors.ts";
import { duckDuckGoSearch } from "./fallback-search.ts";
import {
  firecrawlCrawl,
  firecrawlScrape,
  firecrawlSearch,
  resolveApiKey,
} from "./firecrawl.ts";
import { TOOL_LIMITS_NOTE } from "../shared/text.ts";
import {
  formatCrawlResult,
  formatProviderError,
  formatScrapeResult,
  formatSearchResult,
} from "./format.ts";

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  limit: Type.Optional(
    Type.Number({ description: "Max results (default 5, max 20 for Firecrawl)" }),
  ),
});

const ScrapeParams = Type.Object({
  url: Type.String({ description: "URL to scrape as markdown" }),
});

const CrawlParams = Type.Object({
  url: Type.String({ description: "Starting URL for the crawl" }),
  limit: Type.Optional(
    Type.Number({ description: "Max pages to crawl (default 10, max 50)" }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fc_search",
    label: "Firecrawl search",
    description: `Search the web. Primary provider: Firecrawl (FIRECRAWL_API_KEY). On Firecrawl quota exhaustion, falls back to no-key DuckDuckGo. Results include a provider field. Named fc_* to avoid clashing with other packages' web_search. ${TOOL_LIMITS_NOTE}`,
    promptSnippet: "Search the web via Firecrawl (DuckDuckGo fallback on quota)",
    promptGuidelines: [
      "Use fc_search for discovery; use fc_scrape when you need full page content from a known URL.",
      "fc_search results include provider (firecrawl or duckduckgo) — weigh quality accordingly.",
    ],
    parameters: SearchParams,
    async execute(_toolCallId, params, signal) {
      const limit = params.limit;
      const key = resolveApiKey();

      type SearchDetails = {
        provider: string;
        count: number;
        creditsUsed?: number;
        fallbackFrom?: string;
        firecrawlError?: string;
        noFirecrawlKey?: boolean;
      };

      if (key) {
        try {
          const result = await firecrawlSearch({
            apiKey: key,
            query: params.query,
            limit,
            signal,
          });
          const details: SearchDetails = {
            provider: result.provider,
            count: result.results.length,
            creditsUsed: result.creditsUsed,
          };
          return {
            content: [{ type: "text" as const, text: formatSearchResult(result) }],
            details,
          };
        } catch (error) {
          const classified = classifyThrown(error);
          if (classified.fallbackEligible || classified.kind === "quota") {
            try {
              const fallback = await duckDuckGoSearch(params.query, { limit, signal });
              const details: SearchDetails = {
                provider: fallback.provider,
                count: fallback.results.length,
                fallbackFrom: "firecrawl",
                firecrawlError: classified.kind,
              };
              return {
                content: [
                  {
                    type: "text" as const,
                    text: formatSearchResult(fallback),
                  },
                ],
                details,
              };
            } catch (fallbackError) {
              const fbMsg =
                fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
              throw new Error(
                formatProviderError(classified, "fc_search") +
                  `\nFallback also failed: ${fbMsg}`,
              );
            }
          }
          throw new Error(formatProviderError(classified, "fc_search"));
        }
      }

      // No Firecrawl key: go straight to no-key search.
      try {
        const fallback = await duckDuckGoSearch(params.query, { limit, signal });
        const details: SearchDetails = {
          provider: fallback.provider,
          count: fallback.results.length,
          noFirecrawlKey: true,
        };
        return {
          content: [{ type: "text" as const, text: formatSearchResult(fallback) }],
          details,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `fc_search failed (no FIRECRAWL_API_KEY and fallback failed): ${message}`,
        );
      }
    },
  });

  pi.registerTool({
    name: "fc_scrape",
    label: "Firecrawl scrape",
    description: `Scrape a URL to markdown via Firecrawl. Requires FIRECRAWL_API_KEY. No fallback on quota exhaustion. ${TOOL_LIMITS_NOTE}`,
    promptSnippet: "Scrape a URL to clean markdown (Firecrawl)",
    promptGuidelines: [
      "Use fc_scrape for a specific URL when you need page content, not for open-ended search.",
    ],
    parameters: ScrapeParams,
    async execute(_toolCallId, params, signal) {
      const key = requireKey();
      try {
        const result = await firecrawlScrape({ apiKey: key, url: params.url, signal });
        return {
          content: [{ type: "text" as const, text: formatScrapeResult(result) }],
          details: { provider: result.provider, url: result.url },
        };
      } catch (error) {
        throw new Error(formatProviderError(classifyThrown(error), "fc_scrape"));
      }
    },
  });

  pi.registerTool({
    name: "fc_crawl",
    label: "Firecrawl crawl",
    description: `Crawl a site starting at a URL via Firecrawl (bounded page limit). Requires FIRECRAWL_API_KEY. No fallback on quota exhaustion. ${TOOL_LIMITS_NOTE}`,
    promptSnippet: "Crawl multiple pages from a start URL (Firecrawl)",
    promptGuidelines: [
      "Use fc_crawl sparingly; prefer fc_scrape for a single page. Keep limit small.",
    ],
    parameters: CrawlParams,
    async execute(_toolCallId, params, signal) {
      const key = requireKey();
      try {
        const result = await firecrawlCrawl({
          apiKey: key,
          url: params.url,
          limit: params.limit,
          signal,
        });
        return {
          content: [{ type: "text" as const, text: formatCrawlResult(result) }],
          details: {
            provider: result.provider,
            pages: result.pages.length,
            status: result.status,
            creditsUsed: result.creditsUsed,
          },
        };
      } catch (error) {
        throw new Error(formatProviderError(classifyThrown(error), "fc_crawl"));
      }
    },
  });
}

function requireKey(): string {
  const key = resolveApiKey();
  if (!key) {
    throw new Error(
      "FIRECRAWL_API_KEY is not set. Add it to the environment (or ~/.pi/agent/.env) to use fc_scrape/fc_crawl. fc_search can still use the no-key fallback.",
    );
  }
  return key;
}
