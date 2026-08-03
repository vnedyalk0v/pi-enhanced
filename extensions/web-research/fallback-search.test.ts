import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DUCKDUCKGO_MAX_RESPONSE_BYTES,
  duckDuckGoSearch,
  parseDuckDuckGoHtml,
} from "./fallback-search.ts";
import { readResponseText, withResponseTimeout } from "./response.ts";

describe("parseDuckDuckGoHtml", () => {
  it("extracts result__a links and snippets", () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Site</a>
        <a class="result__snippet">A short description.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://other.test/docs">Other Docs</a>
        <a class="result__snippet">More text.</a>
      </div>
    `;
    const hits = parseDuckDuckGoHtml(html, 5);
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.title, "Example Site");
    assert.equal(hits[0]?.url, "https://example.com/page");
    assert.match(hits[0]?.description ?? "", /short description/);
    assert.equal(hits[1]?.url, "https://other.test/docs");
  });

  it("decodes entities in one pass without double-decoding", () => {
    const html =
      '<a class="result__a" href="https://example.com/">' +
      "Tom &amp; Jerry &amp;lt;div&amp;gt; &#128512; &#x27;quoted&#x27;</a>";
    const hits = parseDuckDuckGoHtml(html, 5);
    // "&amp;lt;" is literal "&lt;" text, not a tag to strip; astral numeric
    // refs must decode as full code points, not lone surrogates.
    assert.equal(hits[0]?.title, "Tom & Jerry &lt;div&gt; \u{1F600} 'quoted'");
  });

  it("leaves surrogate and out-of-range numeric references untouched", () => {
    const html =
      '<a class="result__a" href="https://example.com/">' +
      "surrogates &#55296; &#xDFFF; big &#1114112; ref</a>";
    const hits = parseDuckDuckGoHtml(html, 5);
    assert.equal(hits[0]?.title, "surrogates &#55296; &#xDFFF; big &#1114112; ref");
  });
});

describe("duckDuckGoSearch", () => {
  it("reads a below-limit response", async () => {
    const fetchImpl = async () =>
      new Response(
        '<a class="result__a" href="https://example.com/">Example</a>' +
          '<a class="result__snippet">Description</a>',
      );
    const result = await duckDuckGoSearch("pi", { fetchImpl: fetchImpl as typeof fetch });

    assert.equal(result.provider, "duckduckgo");
    assert.equal(result.results[0]?.url, "https://example.com/");
  });

  it("cancels a non-OK response body before throwing", async () => {
    let cancelled = false;
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500 },
      );

    await assert.rejects(
      () => duckDuckGoSearch("pi", { fetchImpl: fetchImpl as typeof fetch }),
      /DuckDuckGo search failed: HTTP 500/,
    );
    assert.equal(cancelled, true);
  });

  it("rejects oversized responses before buffering them", async () => {
    const fetchImpl = async () =>
      new Response(new Uint8Array(DUCKDUCKGO_MAX_RESPONSE_BYTES + 1));

    await assert.rejects(
      () => duckDuckGoSearch("pi", { fetchImpl: fetchImpl as typeof fetch }),
      new RegExp(`DuckDuckGo response exceeded ${DUCKDUCKGO_MAX_RESPONSE_BYTES} bytes`),
    );
  });

  it("honors caller abort while reading a stalled response", async () => {
    const controller = new AbortController();
    let streamCancelled = false;
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            streamCancelled = true;
          },
        }),
      );
    const search = duckDuckGoSearch("pi", {
      signal: controller.signal,
      fetchImpl: fetchImpl as typeof fetch,
    });
    setImmediate(() => controller.abort());

    await assert.rejects(search, { name: "AbortError" });
    assert.equal(streamCancelled, true);
  });

  it("times out while reading a stalled response", async () => {
    const response = new Response(new ReadableStream());

    await assert.rejects(
      () => readResponseText(response, 1, "test", withResponseTimeout(undefined, 10)),
      { name: "TimeoutError" },
    );
  });

  it("cancels the response body when already aborted", async () => {
    const reason = new Error("already aborted");
    const controller = new AbortController();
    controller.abort(reason);
    let cancelledWith: unknown;
    const response = new Response(
      new ReadableStream({
        cancel(value) {
          cancelledWith = value;
        },
      }),
    );

    await assert.rejects(
      () => readResponseText(response, 1, "test", controller.signal),
      (error) => error === reason,
    );
    assert.equal(cancelledWith, reason);
  });
});
