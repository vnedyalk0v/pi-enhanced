import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDuckDuckGoHtml } from "./fallback-search.ts";

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
});
