import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MAX_RETAINED_BYTES, OutputBuffer } from "./output.ts";

describe("OutputBuffer", () => {
  it("retains small output fully", () => {
    const buf = new OutputBuffer(64);
    assert.equal(buf.push("hello "), true);
    assert.equal(buf.push("world"), true);
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

  it("spills full stream to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bt-out-"));
    const path = join(dir, "out.log");
    const stream = createWriteStream(path, { flags: "a", mode: 0o600, highWaterMark: 1 });
    const buf = new OutputBuffer(8, { path, stream });
    assert.equal(buf.push("abcdefgh"), false);
    await buf.waitForDrain();
    assert.equal(buf.push("ijkl"), false);
    await buf.waitForDrain();
    await buf.close();
    const disk = await readFile(path, "utf8");
    assert.equal(disk, "abcdefghijkl");
    const view = buf.view();
    assert.equal(view.text, "ijkl");
    assert.equal(view.totalBytes, 12);
    assert.equal(view.truncatedBytes, 8);
    assert.equal(view.spillPath, path);
    await rm(dir, { recursive: true, force: true });
  });

  it("stops advertising a failed spill file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bt-out-"));
    const path = join(dir, "missing", "out.log");
    const stream = createWriteStream(path, { highWaterMark: 1 });
    const buf = new OutputBuffer(8, { path, stream });

    assert.equal(buf.push("data"), false);
    await buf.waitForDrain();
    assert.equal(buf.view().spillPath, undefined);
    await buf.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("uses default max retained size", () => {
    assert.equal(MAX_RETAINED_BYTES, 2 * 1024 * 1024);
  });
});
