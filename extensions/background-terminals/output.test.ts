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

  it("spills full stream to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bt-out-"));
    const path = join(dir, "out.log");
    const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
    const buf = new OutputBuffer(8, { path, stream });
    buf.push("abcdefgh");
    buf.push("ijkl");
    await buf.close();
    const disk = await readFile(path, "utf8");
    assert.equal(disk, "abcdefghijkl");
    const view = buf.view();
    assert.equal(view.spillPath, path);
    assert.ok(view.truncatedBytes > 0);
    await rm(dir, { recursive: true, force: true });
  });

  it("uses default max retained size", () => {
    assert.equal(MAX_RETAINED_BYTES, 2 * 1024 * 1024);
  });
});
