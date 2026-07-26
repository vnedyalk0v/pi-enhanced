import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyThrown } from "./errors.ts";
import { firecrawlCrawl, firecrawlScrape, firecrawlSearch } from "./firecrawl.ts";

function mockFetch(handlers: Array<(url: string, init?: RequestInit) => Promise<Response> | Response>) {
  let i = 0;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const handler = handlers[i++];
    if (!handler) throw new Error(`Unexpected fetch: ${url}`);
    return handler(url, init);
  };
}

describe("firecrawl", () => {
  it("search returns normalized firecrawl results", async () => {
    const fetchImpl = mockFetch([
      () =>
        new Response(
          JSON.stringify({
            success: true,
            creditsUsed: 2,
            data: {
              web: [{ title: "Pi", url: "https://pi.dev/", description: "agent" }],
            },
          }),
          { status: 200 },
        ),
    ]);
    const result = await firecrawlSearch({
      apiKey: "fc-test",
      query: "pi",
      fetchImpl: fetchImpl as typeof fetch,
    });
    assert.equal(result.provider, "firecrawl");
    assert.equal(result.results[0]?.url, "https://pi.dev/");
  });

  it("throws classified quota on 402", async () => {
    const fetchImpl = mockFetch([
      () =>
        new Response(JSON.stringify({ error: "Payment required to access this resource." }), {
          status: 402,
        }),
    ]);
    await assert.rejects(
      () =>
        firecrawlSearch({
          apiKey: "fc-test",
          query: "q",
          fetchImpl: fetchImpl as typeof fetch,
        }),
      (err: unknown) => {
        const c = classifyThrown(err);
        assert.equal(c.kind, "quota");
        assert.equal(c.fallbackEligible, true);
        return true;
      },
    );
  });

  it("scrape posts markdown format", async () => {
    let body = "";
    const fetchImpl = mockFetch([
      (_url, init) => {
        body = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            success: true,
            data: { markdown: "# Hi", metadata: { title: "Hi", sourceURL: "https://x.test" } },
          }),
          { status: 200 },
        );
      },
    ]);
    const result = await firecrawlScrape({
      apiKey: "fc-test",
      url: "https://x.test",
      fetchImpl: fetchImpl as typeof fetch,
    });
    assert.match(body, /markdown/);
    assert.equal(result.markdown, "# Hi");
  });

  it("crawl polls until completed", async () => {
    const fetchImpl = mockFetch([
      () => new Response(JSON.stringify({ success: true, id: "job-1" }), { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            status: "scraping",
            total: 1,
            completed: 0,
            data: [],
          }),
          { status: 200 },
        ),
      () =>
        new Response(
          JSON.stringify({
            status: "completed",
            total: 1,
            completed: 1,
            data: [
              {
                markdown: "page",
                metadata: { title: "Home", sourceURL: "https://example.com/" },
              },
            ],
          }),
          { status: 200 },
        ),
    ]);
    const result = await firecrawlCrawl({
      apiKey: "fc-test",
      url: "https://example.com",
      limit: 1,
      maxWaitMs: 10_000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.pages.length, 1);
  });
});
