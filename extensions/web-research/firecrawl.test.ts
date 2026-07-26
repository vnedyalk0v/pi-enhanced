import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderError } from "./errors.ts";
import { FirecrawlClient } from "./firecrawl.ts";

function mockFetch(handlers: Array<(url: string, init?: RequestInit) => Promise<Response> | Response>) {
  let i = 0;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const handler = handlers[i++];
    if (!handler) throw new Error(`Unexpected fetch: ${url}`);
    return handler(url, init);
  };
}

describe("FirecrawlClient", () => {
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
    const client = new FirecrawlClient({
      apiKey: "fc-test",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await client.search("pi");
    assert.equal(result.provider, "firecrawl");
    assert.equal(result.results[0]?.url, "https://pi.dev/");
  });

  it("throws ProviderError with quota on 402", async () => {
    const fetchImpl = mockFetch([
      () =>
        new Response(JSON.stringify({ error: "Payment required to access this resource." }), {
          status: 402,
        }),
    ]);
    const client = new FirecrawlClient({
      apiKey: "fc-test",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await assert.rejects(
      () => client.search("q"),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.kind, "quota");
        assert.equal(err.fallbackEligible, true);
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
    const client = new FirecrawlClient({
      apiKey: "fc-test",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await client.scrape("https://x.test");
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
    const client = new FirecrawlClient({
      apiKey: "fc-test",
      fetchImpl: fetchImpl as typeof fetch,
    });
    // Patch sleep via maxWait and fast path: crawl uses 1500ms sleep — use fake short by completing second poll
    // Override: temporarily shorten by using completed on second get only — first get scraping still waits 1.5s
    const result = await client.crawl("https://example.com", { limit: 1, maxWaitMs: 10_000 });
    assert.equal(result.status, "completed");
    assert.equal(result.pages.length, 1);
  });
});
