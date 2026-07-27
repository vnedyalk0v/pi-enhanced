import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { throwClassified } from "./errors.ts";
import { runFcSearch, type FcSearchDeps } from "./index.ts";
import type { SearchResult } from "./normalize.ts";

const firecrawlResult: SearchResult = {
  provider: "firecrawl",
  query: "q",
  results: [{ title: "t", url: "https://example.com", description: "s" }],
  creditsUsed: 1,
};

const fallbackResult: SearchResult = {
  provider: "duckduckgo",
  query: "q",
  results: [{ title: "t2", url: "https://example.org", description: "s2" }],
};

function deps(overrides: Partial<FcSearchDeps>): FcSearchDeps {
  return {
    resolveApiKey: () => "fc-key",
    firecrawlSearch: async () => firecrawlResult,
    duckDuckGoSearch: async () => fallbackResult,
    ...overrides,
  };
}

describe("runFcSearch fallback contract", () => {
  it("uses Firecrawl directly on success, never touching the fallback", async () => {
    let fallbackCalls = 0;
    const result = await runFcSearch(
      { query: "q" },
      undefined,
      deps({
        duckDuckGoSearch: async () => {
          fallbackCalls++;
          return fallbackResult;
        },
      }),
    );
    assert.equal(fallbackCalls, 0);
    assert.equal((result.details as { provider: string }).provider, "firecrawl");
  });

  it("falls back to DuckDuckGo on quota exhaustion", async () => {
    let fallbackCalls = 0;
    const result = await runFcSearch(
      { query: "q" },
      undefined,
      deps({
        firecrawlSearch: async () => {
          throwClassified({ kind: "quota", message: "out of credits", fallbackEligible: true });
        },
        duckDuckGoSearch: async () => {
          fallbackCalls++;
          return fallbackResult;
        },
      }),
    );
    assert.equal(fallbackCalls, 1);
    assert.equal((result.details as { provider: string }).provider, "duckduckgo");
  });

  it("falls back when there is no Firecrawl key at all", async () => {
    let fallbackCalls = 0;
    const result = await runFcSearch(
      { query: "q" },
      undefined,
      deps({
        resolveApiKey: () => undefined,
        duckDuckGoSearch: async () => {
          fallbackCalls++;
          return fallbackResult;
        },
      }),
    );
    assert.equal(fallbackCalls, 1);
    assert.equal((result.details as { noFirecrawlKey?: boolean }).noFirecrawlKey, true);
  });

  for (const kind of ["auth", "rate_limit", "bad_request", "transient"] as const) {
    it(`does NOT fall back on ${kind}`, async () => {
      let fallbackCalls = 0;
      await assert.rejects(
        runFcSearch(
          { query: "q" },
          undefined,
          deps({
            firecrawlSearch: async () => {
              throwClassified({ kind, message: `${kind} error`, fallbackEligible: false });
            },
            duckDuckGoSearch: async () => {
              fallbackCalls++;
              return fallbackResult;
            },
          }),
        ),
      );
      assert.equal(fallbackCalls, 0);
    });
  }
});
