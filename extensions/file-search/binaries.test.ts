import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  candidateNames,
  firstLocatorResult,
  locatorCommand,
  resolveBinary,
  resolveExisting,
  which,
} from "./binaries.ts";
import { buildFdArgs, buildRgArgs } from "./run.ts";

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

describe("resolveBinary", () => {
  async function withEmptyPath<T>(run: () => Promise<T>) {
    const previous = process.env.PATH;
    // No locator and no binaries reachable: resolution must fall through to
    // the Pi bin directory and then fail with an install hint.
    process.env.PATH = "";
    try {
      return await run();
    } finally {
      process.env.PATH = previous;
    }
  }

  it("names a package-manager install path when the binary is missing", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-binaries-missing-"));
    try {
      await withEmptyPath(async () => {
        assert.equal(await resolveExisting("fd", agentDir), null);
        await assert.rejects(resolveBinary("fd", agentDir), (error: Error) => {
          assert.match(error.message, /fd was not found on PATH/);
          assert.match(error.message, /brew install fd/);
          return true;
        });
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("uses a binary previously installed into the Pi bin directory", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-binaries-local-"));
    try {
      const binDir = join(agentDir, "bin");
      await mkdir(binDir, { recursive: true });
      const local = join(binDir, "rg");
      await writeFile(local, "#!/bin/sh\nexit 0\n");
      chmodSync(local, 0o755);
      await withEmptyPath(async () => {
        assert.equal(await resolveBinary("rg", agentDir), local);
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
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
