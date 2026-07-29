import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import {
  ARCHIVE_MAX_BYTES,
  candidateNames,
  detectPlatform,
  downloadToFile,
  ensureBinary,
  expectedDigest,
  firstLocatorResult,
  locatorCommand,
  releaseUrl,
  verifyArchive,
  which,
} from "./binaries.ts";
import { buildFdArgs, buildRgArgs } from "./run.ts";

const execFileAsync = promisify(execFile);

async function createBinaryArchive(root: string, name: "fd" | "rg") {
  const sourceDir = join(root, "source");
  const archive = join(root, `${name}.tar.gz`);
  const contents = "#!/bin/sh\nexit 0\n";
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, name), contents);
  await execFileAsync("tar", ["-czf", archive, "-C", sourceDir, name]);
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  return { archive, contents, digest };
}

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

describe("which", () => {
  it("selects the platform locator", () => {
    for (const [platform, expected] of [
      ["win32", "where.exe"],
      ["darwin", "which"],
      ["linux", "which"],
    ] as const) {
      assert.equal(locatorCommand(platform), expected);
    }
  });

  it("returns the first non-empty locator result", () => {
    for (const [output, expected] of [
      ["\r\nC:\\Tools\\rg.exe\r\nD:\\Tools\\rg.exe\r\n", "C:\\Tools\\rg.exe"],
      ["\n/usr/local/bin/fd\n/usr/bin/fd\n", "/usr/local/bin/fd"],
      [" \r\n\t\r\n", null],
    ] as const) {
      assert.equal(firstLocatorResult(output), expected);
    }
  });

  it("returns null when the locator exits nonzero or errors", async () => {
    assert.equal(
      await which("rg", "win32", async (locator, command) => {
        assert.deepEqual([locator, command], ["where.exe", "rg"]);
        return { code: 1, output: "not found" };
      }),
      null,
    );
    assert.equal(
      await which("rg", "linux", async () => {
        throw new Error("spawn failed");
      }),
      null,
    );
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

describe("downloadToFile", () => {
  it("cancels a failed response body before preserving the HTTP error", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-binary-failed-response-"));
    let cancelled = false;
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 },
      );

    try {
      await assert.rejects(
        downloadToFile(
          "https://example.test/fd.tar.gz",
          join(root, "archive.tar.gz"),
          undefined,
          fetchImpl as typeof fetch,
        ),
        /Download failed \(503\): https:\/\/example\.test\/fd\.tar\.gz/,
      );
      assert.equal(cancelled, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ensureBinary", () => {
  it("rejects oversized downloads and removes the install attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-binary-oversized-"));
    try {
      const agentDir = join(root, "agent");
      const fetchImpl = async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(ARCHIVE_MAX_BYTES + 1));
              controller.close();
            },
          }),
        );

      await assert.rejects(
        ensureBinary(
          "fd",
          { agentDir, platform: { os: "darwin", arch: "arm64" } },
          {
            resolveExisting: async () => null,
            downloadToFile: (url, dest, signal) =>
              downloadToFile(url, dest, signal, fetchImpl as typeof fetch),
            expectedDigest: () => "unused",
          },
        ),
        new RegExp(`Download exceeded ${ARCHIVE_MAX_BYTES} bytes`),
      );
      assert.deepEqual(await readdir(join(agentDir, "bin")), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts stalled downloads and removes the install attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-binary-aborted-"));
    try {
      const agentDir = join(root, "agent");
      const controller = new AbortController();
      let streamCancelled = false;
      const fetchImpl = async () =>
        new Response(
          new ReadableStream({
            start(streamController) {
              streamController.enqueue(new Uint8Array([1]));
            },
            cancel() {
              streamCancelled = true;
            },
          }),
        );
      const install = ensureBinary(
        "fd",
        {
          agentDir,
          platform: { os: "darwin", arch: "arm64" },
          signal: controller.signal,
        },
        {
          resolveExisting: async () => null,
          downloadToFile: (url, dest, signal) =>
            downloadToFile(url, dest, signal, fetchImpl as typeof fetch),
          expectedDigest: () => "unused",
        },
      );
      setImmediate(() => controller.abort());

      await assert.rejects(install, { name: "AbortError" });
      assert.equal(streamCancelled, true);
      assert.deepEqual(await readdir(join(agentDir, "bin")), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes one complete executable across concurrent installs and cleans attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-binary-race-"));
    try {
      const agentDir = join(root, "agent");
      const fixture = await createBinaryArchive(root, "fd");
      let downloadCount = 0;
      let releaseDownloads = () => {};
      const downloadsReady = new Promise<void>((resolve) => {
        releaseDownloads = resolve;
      });
      const dependencies = {
        resolveExisting: async () => null,
        downloadToFile: async (_url: string, dest: string) => {
          await copyFile(fixture.archive, dest);
          downloadCount++;
          if (downloadCount === 2) releaseDownloads();
          await downloadsReady;
        },
        expectedDigest: () => fixture.digest,
      };

      const results = await Promise.all([
        ensureBinary("fd", { agentDir, platform: { os: "darwin", arch: "arm64" } }, dependencies),
        ensureBinary("fd", { agentDir, platform: { os: "darwin", arch: "arm64" } }, dependencies),
      ]);

      assert.equal(downloadCount, 2);
      assert.equal(results.filter(({ installed }) => installed).length, 1);
      assert.deepEqual(new Set(results.map(({ path }) => path)), new Set([join(agentDir, "bin", "fd")]));
      assert.equal(await readFile(results[0].path, "utf8"), fixture.contents);
      assert.notEqual((await stat(results[0].path)).mode & 0o111, 0);
      assert.deepEqual(await readdir(join(agentDir, "bin")), ["fd"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes safely when the filesystem does not support hard links", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-binary-no-links-"));
    try {
      const agentDir = join(root, "agent");
      const fixture = await createBinaryArchive(root, "fd");
      let downloadCount = 0;
      let releaseDownloads = () => {};
      const downloadsReady = new Promise<void>((resolve) => {
        releaseDownloads = resolve;
      });
      const dependencies = {
        resolveExisting: async () => null,
        downloadToFile: async (_url: string, dest: string) => {
          await copyFile(fixture.archive, dest);
          downloadCount++;
          if (downloadCount === 2) releaseDownloads();
          await downloadsReady;
        },
        expectedDigest: () => fixture.digest,
        linkPrepared: () => {
          throw Object.assign(new Error("hard links unsupported"), { code: "EOPNOTSUPP" });
        },
      };

      const results = await Promise.all([
        ensureBinary("fd", { agentDir, platform: { os: "darwin", arch: "arm64" } }, dependencies),
        ensureBinary("fd", { agentDir, platform: { os: "darwin", arch: "arm64" } }, dependencies),
      ]);

      assert.equal(results.filter(({ installed }) => installed).length, 1);
      assert.equal(await readFile(results[0].path, "utf8"), fixture.contents);
      assert.notEqual((await stat(results[0].path)).mode & 0o111, 0);
      assert.deepEqual(await readdir(join(agentDir, "bin")), ["fd"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an abandoned fallback publication lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-binary-stale-lock-"));
    try {
      const agentDir = join(root, "agent");
      const binDir = join(agentDir, "bin");
      const lockDir = join(binDir, "fd.install-lock");
      const fixture = await createBinaryArchive(root, "fd");
      await mkdir(lockDir, { recursive: true });
      const stale = new Date(Date.now() - 10_000);
      await utimes(lockDir, stale, stale);

      const result = await ensureBinary(
        "fd",
        { agentDir, platform: { os: "darwin", arch: "arm64" } },
        {
          resolveExisting: async () => null,
          downloadToFile: async (_url, dest) => copyFile(fixture.archive, dest),
          expectedDigest: () => fixture.digest,
          linkPrepared: () => {
            throw Object.assign(new Error("hard links unsupported"), { code: "EOPNOTSUPP" });
          },
        },
      );

      assert.equal(result.installed, true);
      assert.equal(await readFile(result.path, "utf8"), fixture.contents);
      assert.deepEqual(await readdir(binDir), ["fd"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an invalid destination created during installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-binary-invalid-"));
    try {
      const agentDir = join(root, "agent");
      const dest = join(agentDir, "bin", "fd");
      const fixture = await createBinaryArchive(root, "fd");
      const dependencies = {
        resolveExisting: async () => null,
        downloadToFile: async (_url: string, archive: string) => {
          await copyFile(fixture.archive, archive);
          await writeFile(dest, "keep me");
        },
        expectedDigest: () => fixture.digest,
      };

      await assert.rejects(
        ensureBinary("fd", { agentDir, platform: { os: "darwin", arch: "arm64" } }, dependencies),
        /Refusing to replace invalid binary destination/,
      );
      assert.equal(await readFile(dest, "utf8"), "keep me");
      assert.deepEqual(await readdir(join(agentDir, "bin")), ["fd"]);
    } finally {
      await rm(root, { recursive: true, force: true });
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
