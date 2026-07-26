import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  candidateNames,
  detectPlatform,
  releaseUrl,
} from "./binaries.ts";
import { buildFdArgs, buildRgArgs } from "./run.ts";

describe("detectPlatform", () => {
  it("accepts darwin/linux x64/arm64", () => {
    assert.deepEqual(detectPlatform("darwin", "arm64"), { os: "darwin", arch: "arm64" });
    assert.deepEqual(detectPlatform("linux", "x64"), { os: "linux", arch: "x64" });
  });

  it("rejects unsupported platforms", () => {
    assert.equal(detectPlatform("win32", "x64"), null);
    assert.equal(detectPlatform("darwin", "ia32"), null);
  });
});

describe("releaseUrl", () => {
  it("builds fd and rg release URLs", () => {
    const fd = releaseUrl("fd", { os: "darwin", arch: "arm64" });
    assert.match(fd, /sharkdp\/fd\/releases\/download\/v10\.2\.1\/fd-v10\.2\.1-aarch64-apple-darwin\.tar\.gz$/);
    const rg = releaseUrl("rg", { os: "linux", arch: "x64" });
    assert.match(
      rg,
      /BurntSushi\/ripgrep\/releases\/download\/14\.1\.1\/ripgrep-14\.1\.1-x86_64-unknown-linux-gnu\.tar\.gz$/,
    );
  });
});

describe("candidateNames", () => {
  it("includes fdfind on linux for fd", () => {
    if (process.platform === "linux") {
      assert.deepEqual(candidateNames("fd"), ["fd", "fdfind"]);
    } else {
      assert.deepEqual(candidateNames("fd"), ["fd"]);
    }
    assert.deepEqual(candidateNames("rg"), ["rg"]);
  });
});

describe("arg builders", () => {
  it("builds fd args", () => {
    assert.deepEqual(
      buildFdArgs({ pattern: "*.ts", path: "src", type: "f", extension: "ts", hidden: true, maxResults: 20 }),
      [
        "--color",
        "never",
        "--hidden",
        "--type",
        "f",
        "--extension",
        "ts",
        "--max-results",
        "20",
        "*.ts",
        "src",
      ],
    );
  });

  it("builds rg args with terminator before pattern", () => {
    assert.deepEqual(
      buildRgArgs({ pattern: "foo|bar", path: ".", glob: "*.ts", caseInsensitive: true, maxCount: 5 }),
      [
        "--line-number",
        "--color",
        "never",
        "--no-heading",
        "-i",
        "--glob",
        "*.ts",
        "--max-count",
        "5",
        "--",
        "foo|bar",
        ".",
      ],
    );
  });
});
