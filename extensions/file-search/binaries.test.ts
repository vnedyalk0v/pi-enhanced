import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  candidateNames,
  detectPlatform,
  expectedDigest,
  releaseUrl,
  verifyArchive,
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
  it("builds official URLs for every supported target", () => {
    const targets = [
      { target: { os: "darwin", arch: "arm64" }, triple: "aarch64-apple-darwin" },
      { target: { os: "darwin", arch: "x64" }, triple: "x86_64-apple-darwin" },
      { target: { os: "linux", arch: "arm64" }, triple: "aarch64-unknown-linux-gnu" },
      { target: { os: "linux", arch: "x64" }, triple: "x86_64-unknown-linux-gnu" },
    ] as const;

    for (const { target, triple } of targets) {
      assert.equal(
        releaseUrl("fd", target),
        `https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-${triple}.tar.gz`,
      );
      const rgTriple =
        target.os === "linux" && target.arch === "x64"
          ? "x86_64-unknown-linux-musl"
          : triple;
      assert.equal(
        releaseUrl("rg", target),
        `https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-${rgTriple}.tar.gz`,
      );
    }
  });
});

describe("expectedDigest", () => {
  it("covers every supported binary and target", () => {
    for (const name of ["fd", "rg"] as const) {
      for (const os of ["darwin", "linux"] as const) {
        for (const arch of ["x64", "arm64"] as const) {
          assert.match(expectedDigest(name, { os, arch }) ?? "", /^[a-f0-9]{64}$/);
        }
      }
    }
    assert.equal(expectedDigest("fd", { os: "win32", arch: "x64" }), null);
  });
});

describe("verifyArchive", () => {
  it("accepts matching bytes and rejects changed bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-binary-digest-"));
    const archive = join(dir, "archive.tar.gz");
    try {
      await writeFile(archive, "official archive");
      await verifyArchive(
        archive,
        "764884ced8d4b07eac08febddb267116e3422a66ce76eb6dddb016e36d7cd286",
        "fd 10.2.0 on darwin/arm64",
      );
      await writeFile(archive, "changed archive");
      await assert.rejects(
        verifyArchive(
          archive,
          "764884ced8d4b07eac08febddb267116e3422a66ce76eb6dddb016e36d7cd286",
          "fd 10.2.0 on darwin/arm64",
        ),
        /Digest mismatch for fd 10\.2\.0 on darwin\/arm64/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
  it("builds fd args with --glob by default so *.ts works", () => {
    assert.deepEqual(
      buildFdArgs({ pattern: "*.ts", path: "src", type: "f", extension: "ts", hidden: true, maxResults: 20 }),
      [
        "--color",
        "never",
        "--glob",
        "--hidden",
        "--type",
        "f",
        "--extension",
        "ts",
        "--max-results",
        "20",
        "--",
        "*.ts",
        "src",
      ],
    );
  });

  it("builds fd args without --glob when regex=true", () => {
    assert.deepEqual(buildFdArgs({ pattern: ".*\\.ts$", path: "extensions", regex: true }), [
      "--color",
      "never",
      "--",
      ".*\\.ts$",
      "extensions",
    ]);
  });

  it("builds fd args with terminator before option-like patterns", () => {
    assert.deepEqual(buildFdArgs({ pattern: "--exec", path: "src" }), [
      "--color",
      "never",
      "--glob",
      "--",
      "--exec",
      "src",
    ]);
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
