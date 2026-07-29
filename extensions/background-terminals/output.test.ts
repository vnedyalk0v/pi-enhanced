import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createSpillDir,
  MAX_RETAINED_BYTES,
  openSpillStreams,
  OutputBuffer,
} from "./output.ts";

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

  it("creates distinct private spill directories and files", async () => {
    const firstDir = await createSpillDir();
    const secondDir = await createSpillDir();
    try {
      assert.notEqual(firstDir, secondDir);
      const spill = await openSpillStreams(firstDir, "bt-1");
      const stdout = new OutputBuffer(8, spill.stdout);
      const stderr = new OutputBuffer(8, spill.stderr);
      stdout.push("out");
      stderr.push("err");
      await Promise.all([stdout.close(), stderr.close()]);

      if (process.platform !== "win32") {
        assert.equal((await stat(firstDir)).mode & 0o077, 0);
        assert.equal((await stat(spill.stdout.path)).mode & 0o077, 0);
        assert.equal((await stat(spill.stderr.path)).mode & 0o077, 0);
      }
    } finally {
      await Promise.all([
        rm(firstDir, { recursive: true, force: true }),
        rm(secondDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("refuses to replace a preclaimed spill file", async () => {
    const dir = await createSpillDir();
    const stdoutPath = join(dir, "bt-1.stdout.log");
    const stderrPath = join(dir, "bt-1.stderr.log");
    try {
      await writeFile(stderrPath, "claimed", { mode: 0o600 });

      await assert.rejects(
        () => openSpillStreams(dir, "bt-1"),
        (error: NodeJS.ErrnoException) => error.code === "EEXIST",
      );
      await assert.rejects(() => access(stdoutPath));
      assert.equal(await readFile(stderrPath, "utf8"), "claimed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
