import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createSpillDir,
  MAX_RETAINED_BYTES,
  MAX_SESSION_SPILL_BYTES,
  MAX_SPILL_BYTES,
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
      spillTruncatedBytes: 0,
      spillPath: undefined,
    });

    assert.equal(buf.view().text, "hello");
    assert.equal(joined, true);
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
    assert.equal(view.spillTruncatedBytes, 0);
    assert.equal(view.spillPath, path);
    await rm(dir, { recursive: true, force: true });
  });

  it("stops advertising a failed spill file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bt-out-"));
    const path = join(dir, "missing", "out.log");
    const stream = createWriteStream(path, { highWaterMark: 1 });
    const buf = new OutputBuffer(8, { path, stream, maxBytes: 2 });

    assert.equal(buf.push("data"), false);
    await buf.waitForDrain();
    assert.equal(buf.view().spillPath, undefined);
    assert.equal(buf.view().spillTruncatedBytes, 2);
    await buf.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("uses default max retained size", () => {
    assert.equal(MAX_RETAINED_BYTES, 2 * 1024 * 1024);
    assert.equal(MAX_SPILL_BYTES, 16 * 1024 * 1024);
    assert.equal(MAX_SESSION_SPILL_BYTES, 64 * 1024 * 1024);
  });

  it("stops spilling at per-stream and shared session quotas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bt-quota-"));
    const budget = { remainingBytes: 7 };
    const firstPath = join(dir, "first.log");
    const secondPath = join(dir, "second.log");
    const first = new OutputBuffer(8, {
      path: firstPath,
      stream: createWriteStream(firstPath, { mode: 0o600 }),
      budget,
      maxBytes: 4,
    });
    const second = new OutputBuffer(8, {
      path: secondPath,
      stream: createWriteStream(secondPath, { mode: 0o600 }),
      budget,
      maxBytes: 8,
    });

    try {
      first.push("abcdef");
      first.push("g");
      second.push("éxy");
      await Promise.all([first.close(), second.close()]);

      assert.equal(await readFile(firstPath, "utf8"), "abcd");
      assert.equal(await readFile(secondPath, "utf8"), "éx");
      assert.equal(first.view().spillTruncatedBytes, 3);
      assert.equal(second.view().spillTruncatedBytes, 1);
      assert.equal(first.view().text, "abcdefg");
      assert.equal(second.view().text, "éxy");
      assert.equal(budget.remainingBytes, 0);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await rm(dir, { recursive: true, force: true });
    }
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
