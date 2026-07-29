import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyThrown } from "./errors.ts";
import { firecrawlCrawl, firecrawlScrape, firecrawlSearch } from "./firecrawl.ts";

type RequestRecord = { method: string; url: string };

function mockFetch(
  handlers: Array<(url: string, init?: RequestInit) => Promise<Response> | Response>,
  requests: RequestRecord[] = [],
) {
  let i = 0;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: init?.method ?? "GET", url });
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
    const requests: RequestRecord[] = [];
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
    ], requests);
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      const result = await firecrawlCrawl({
        apiKey: "fc-test",
        url: "https://example.com",
        limit: 1,
        maxWaitMs: 10_000,
        fetchImpl: fetchImpl as typeof fetch,
      });
      assert.equal(result.status, "completed");
      assert.equal(result.pages.length, 1);
      assert.deepEqual(
        requests.map(({ method, url }) => [method, url]),
        [
          ["POST", "https://api.firecrawl.dev/v2/crawl"],
          ["GET", "https://api.firecrawl.dev/v2/crawl/job-1"],
          ["GET", "https://api.firecrawl.dev/v2/crawl/job-1"],
        ],
      );
    } finally {
      clearInterval(keepAlive);
    }
  });

  it("cancels a crawl that times out without masking cleanup failure", async () => {
    const requests: RequestRecord[] = [];
    const fetchImpl = mockFetch(
      [
        () => new Response(JSON.stringify({ success: true, id: "job/1" }), { status: 200 }),
        () => new Response(JSON.stringify({ error: "cleanup failed" }), { status: 500 }),
      ],
      requests,
    );

    await assert.rejects(
      () =>
        firecrawlCrawl({
          apiKey: "fc-test",
          url: "https://example.com",
          maxWaitMs: 0,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      /Firecrawl crawl timed out after 0ms \(job job\/1\)/,
    );
    assert.deepEqual(
      requests.map(({ method, url }) => [method, url]),
      [
        ["POST", "https://api.firecrawl.dev/v2/crawl"],
        ["DELETE", "https://api.firecrawl.dev/v2/crawl/job%2F1"],
      ],
    );
  });

  it("cancels an aborted crawl without masking cleanup failure", async () => {
    const controller = new AbortController();
    const requests: RequestRecord[] = [];
    const fetchImpl = mockFetch(
      [
        () => new Response(JSON.stringify({ success: true, id: "job-1" }), { status: 200 }),
        () => {
          controller.abort();
          return new Response(JSON.stringify({ status: "scraping" }), { status: 200 });
        },
        () => {
          throw new Error("cleanup failed");
        },
      ],
      requests,
    );

    await assert.rejects(
      () =>
        firecrawlCrawl({
          apiKey: "fc-test",
          url: "https://example.com",
          maxWaitMs: 1,
          signal: controller.signal,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      { name: "AbortError" },
    );
    assert.deepEqual(
      requests.map(({ method, url }) => [method, url]),
      [
        ["POST", "https://api.firecrawl.dev/v2/crawl"],
        ["GET", "https://api.firecrawl.dev/v2/crawl/job-1"],
        ["DELETE", "https://api.firecrawl.dev/v2/crawl/job-1"],
      ],
    );
  });

  it("bounds stalled cleanup without masking the polling error", { timeout: 2_000 }, async () => {
    const pollingError = new Error("polling failed");
    const requests: RequestRecord[] = [];
    let cleanupAborted = false;
    const fetchImpl = mockFetch(
      [
        () => new Response(JSON.stringify({ success: true, id: "job/1" }), { status: 200 }),
        () => {
          throw pollingError;
        },
        (_url, init) =>
          new Promise((_resolve, reject) => {
            assert.equal(init?.signal?.aborted, false);
            init?.signal?.addEventListener(
              "abort",
              () => {
                cleanupAborted = true;
                reject(init.signal?.reason);
              },
              { once: true },
            );
          }),
      ],
      requests,
    );

    await assert.rejects(
      () =>
        firecrawlCrawl({
          apiKey: "fc-test",
          url: "https://example.com",
          maxWaitMs: 1_000,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      (error) => {
        assert.equal(error, pollingError);
        assert.equal((error as Error).message, "polling failed");
        return true;
      },
    );
    assert.equal(cleanupAborted, true);
    assert.deepEqual(
      requests.map(({ method, url }) => [method, url]),
      [
        ["POST", "https://api.firecrawl.dev/v2/crawl"],
        ["GET", "https://api.firecrawl.dev/v2/crawl/job%2F1"],
        ["DELETE", "https://api.firecrawl.dev/v2/crawl/job%2F1"],
      ],
    );
  });

  it("does not cancel provider-terminal crawls", async () => {
    for (const status of ["failed", "cancelled"]) {
      const requests: RequestRecord[] = [];
      const fetchImpl = mockFetch(
        [
          () => new Response(JSON.stringify({ success: true, id: "job-1" }), { status: 200 }),
          () => new Response(JSON.stringify({ status }), { status: 200 }),
        ],
        requests,
      );

      await assert.rejects(
        () =>
          firecrawlCrawl({
            apiKey: "fc-test",
            url: "https://example.com",
            maxWaitMs: 1,
            fetchImpl: fetchImpl as typeof fetch,
          }),
        new RegExp(`Firecrawl crawl ${status}`),
      );
      assert.deepEqual(
        requests.map(({ method, url }) => [method, url]),
        [
          ["POST", "https://api.firecrawl.dev/v2/crawl"],
          ["GET", "https://api.firecrawl.dev/v2/crawl/job-1"],
        ],
      );
    }
  });
});
