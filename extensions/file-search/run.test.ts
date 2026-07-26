import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { runBinary } from "./run.ts";

function prefix() {
  return `pi-file-search-test-${randomUUID()}`;
}

async function spillPaths(name: string) {
  return (await readdir(tmpdir()))
    .filter((entry) => entry.startsWith(`${name}-`))
    .map((entry) => `${tmpdir()}/${entry}`);
}

describe("runBinary", () => {
  it("returns small output exactly and removes its temporary file", async () => {
    const name = prefix();
    const result = await runBinary(
      process.execPath,
      ["-e", 'process.stdout.write("one\\ntwo\\n")'],
      tmpdir(),
      name,
    );

    assert.equal(result.text, "one\ntwo\n");
    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, 0);
    assert.equal(result.lineCount, 2);
    assert.equal(result.hasOutput, true);
    assert.equal(result.truncated, false);
    assert.equal(result.fullOutputPath, undefined);
    assert.deepEqual(await spillPaths(name), []);
  });

  it("preserves a nonzero exit and bounds stderr", async () => {
    const name = prefix();
    const result = await runBinary(
      process.execPath,
      [
        "-e",
        `for (let i = 0; i < ${DEFAULT_MAX_LINES + 10}; i++) process.stderr.write("error-" + i + "\\n"); process.exitCode = 1`,
      ],
      tmpdir(),
      name,
    );

    assert.equal(result.text, "(no output)");
    assert.equal(result.exitCode, 1);
    assert.equal(result.lineCount, 0);
    assert.equal(result.hasOutput, false);
    assert.ok(Buffer.byteLength(result.stderr) <= DEFAULT_MAX_BYTES);
    assert.ok(result.stderr.split("\n").length <= DEFAULT_MAX_LINES);
    assert.deepEqual(await spillPaths(name), []);
  });

  it("keeps a bounded head and complete spill file for large output", async () => {
    const name = prefix();
    const lines = Array.from(
      { length: DEFAULT_MAX_LINES + 100 },
      (_, index) => `${String(index).padStart(4, "0")}-${"x".repeat(40)}`,
    );
    const expected = `${lines.join("\n")}\n`;
    const result = await runBinary(
      process.execPath,
      [
        "-e",
        `for (let i = 0; i < ${lines.length}; i++) process.stdout.write(String(i).padStart(4, "0") + "-" + "x".repeat(40) + "\\n")`,
      ],
      tmpdir(),
      name,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.lineCount, lines.length);
    assert.equal(result.hasOutput, true);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.text) < DEFAULT_MAX_BYTES + 1024);
    assert.match(result.text, new RegExp(`showing \\d+ of ${lines.length} lines`));
    assert.ok(result.fullOutputPath);
    assert.equal((await readFile(result.fullOutputPath, "utf8")), expected);

    await rm(dirname(result.fullOutputPath), { recursive: true });
  });

  it("decodes UTF-8 characters split across writes without replacement characters", async () => {
    const name = prefix();
    const result = await runBinary(
      process.execPath,
      [
        "-e",
        "process.stdout.write(Buffer.from([0xe2, 0x82])); setImmediate(() => process.stdout.write(Buffer.from([0xac, 0x0a])))",
      ],
      tmpdir(),
      name,
    );

    assert.equal(result.text, "€\n");
    assert.equal(result.lineCount, 1);
    assert.equal(result.truncated, false);
    assert.ok(!result.text.includes("\uFFFD"));
    assert.deepEqual(await spillPaths(name), []);
  });

  it("removes its temporary file when aborted", async () => {
    const name = prefix();

    await assert.rejects(
      runBinary(
        process.execPath,
        ["-e", 'setInterval(() => process.stdout.write("still running\\n"), 5)'],
        tmpdir(),
        name,
        AbortSignal.timeout(20),
      ),
      { name: "AbortError" },
    );
    assert.deepEqual(await spillPaths(name), []);
  });
});
