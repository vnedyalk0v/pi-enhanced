import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_RETAINED_BYTES, OutputBuffer } from "./output.ts";

describe("OutputBuffer", () => {
  it("retains small output fully", () => {
    const buf = new OutputBuffer(64);
    buf.push("hello ");
    buf.push("world");
    const view = buf.view();
    assert.equal(view.text, "hello world");
    assert.equal(view.totalBytes, Buffer.byteLength("hello world"));
    assert.equal(view.truncatedBytes, 0);
  });

  it("drops head when over max retained bytes", () => {
    const buf = new OutputBuffer(10);
    buf.push("abcdefghij"); // 10
    buf.push("XYZ"); // forces drop
    const view = buf.view();
    assert.equal(view.text, "XYZ");
    assert.equal(view.totalBytes, 13);
    assert.equal(view.truncatedBytes, 10);
  });

  it("keeps newest tail when single chunk exceeds cap", () => {
    const buf = new OutputBuffer(5);
    buf.push("0123456789");
    const view = buf.view();
    assert.equal(view.text, "56789");
    assert.equal(view.totalBytes, 10);
    assert.equal(view.truncatedBytes, 5);
  });

  it("keeps a valid character boundary when the cap splits a multi-byte char", () => {
    const buf = new OutputBuffer(10);
    buf.push("\u{1F600}\u{1F600}\u{1F600}");
    const view = buf.view();
    const retainedBytes = Buffer.byteLength(view.text, "utf8");
    assert.equal(view.text.includes("�"), false);
    assert.equal(retainedBytes <= 10, true);
    assert.equal(view.truncatedBytes, view.totalBytes - retainedBytes);
  });

  it("never reports negative truncation", () => {
    const buf = new OutputBuffer(10);
    buf.push("\u{1F600}\u{1F600}\u{1F600}");
    assert.equal(buf.view().truncatedBytes >= 0, true);
  });

  it("retains the whole chunk when it lands exactly on the cap", () => {
    const buf = new OutputBuffer(6);
    buf.push("a\u{1F600}b");
    const view = buf.view();
    assert.equal(view.text, "a\u{1F600}b");
    assert.equal(view.truncatedBytes, 0);
  });

  it("handles a cap smaller than one character", () => {
    const buf = new OutputBuffer(2);
    buf.push("\u{1F600}");
    const view = buf.view();
    assert.equal(view.text, "");
    assert.equal(view.text.includes("�"), false);
    assert.equal(view.truncatedBytes >= 0, true);
  });

  it("returns metadata without joining retained text", () => {
    const buf = new OutputBuffer(64);
    buf.push("hello");
    const chunks = (buf as unknown as { chunks: string[] }).chunks;
    const join = chunks.join.bind(chunks);
    let joined = false;
    chunks.join = (separator) => {
      joined = true;
      return join(separator);
    };

    const metadata = buf.view(false);
    assert.equal(joined, false);
    assert.deepEqual(metadata, {
      text: "",
      totalBytes: 5,
      truncatedBytes: 0,
    });

    assert.equal(buf.view().text, "hello");
    assert.equal(joined, true);
  });

  it("uses default max retained size", () => {
    assert.equal(MAX_RETAINED_BYTES, 2 * 1024 * 1024);
  });
});
