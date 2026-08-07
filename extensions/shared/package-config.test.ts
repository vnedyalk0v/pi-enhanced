import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_PACKAGE_CONFIG,
  formatPackageConfigSummary,
  globalConfigPath,
  loadPackageConfig,
  mergeConfigFiles,
  parsePackageConfigFile,
  patchConfigFile,
  projectConfigPath,
  readConfigFile,
  resolvePackageConfig,
  writeConfigFile,
  type PackageConfigFile,
} from "./package-config.ts";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "pe-config-"));
  temps.push(dir);
  return dir;
}

describe("parsePackageConfigFile", () => {
  it("drops invalid fields and keeps valid overrides", () => {
    const parsed = parsePackageConfigFile({
      subagents: {
        defaultModel: "  anthropic/claude-haiku-4-5  ",
        defaultThinking: "high",
        maxRunning: 8,
        maxRuntimeMinutes: 60,
        junk: true,
      },
      backgroundTerminals: { maxRunning: 0 },
      workflows: { maxRunning: 2, childMaxRunning: 99 },
      extra: 1,
    });
    assert.deepEqual(parsed, {
      subagents: {
        defaultModel: "anthropic/claude-haiku-4-5",
        defaultThinking: "high",
        maxRunning: 8,
        maxRuntimeMinutes: 60,
      },
      workflows: { maxRunning: 2 },
    });
  });

  it("rejects bad thinking levels and empty model", () => {
    const parsed = parsePackageConfigFile({
      subagents: { defaultModel: "   ", defaultThinking: "ultra" },
    });
    assert.deepEqual(parsed, {});
  });

  it("returns empty for non-objects", () => {
    assert.deepEqual(parsePackageConfigFile(null), {});
    assert.deepEqual(parsePackageConfigFile("x"), {});
    assert.deepEqual(parsePackageConfigFile([]), {});
  });
});

describe("merge and resolve", () => {
  it("lets project override global and applies defaults", () => {
    const globalFile: PackageConfigFile = {
      subagents: { maxRunning: 8, defaultModel: "a/b" },
      backgroundTerminals: { maxRunning: 16 },
    };
    const projectFile: PackageConfigFile = {
      subagents: { defaultThinking: "low", maxRunning: 2 },
    };
    const merged = mergeConfigFiles(globalFile, projectFile);
    assert.equal(merged.subagents?.defaultModel, "a/b");
    assert.equal(merged.subagents?.defaultThinking, "low");
    assert.equal(merged.subagents?.maxRunning, 2);

    const resolved = resolvePackageConfig(merged);
    assert.equal(resolved.subagents.maxRunning, 2);
    assert.equal(resolved.subagents.defaultModel, "a/b");
    assert.equal(resolved.subagents.defaultThinking, "low");
    assert.equal(resolved.subagents.maxRuntimeMs, 30 * 60_000);
    assert.equal(resolved.backgroundTerminals.maxRunning, 16);
    assert.equal(resolved.workflows.maxRunning, DEFAULT_PACKAGE_CONFIG.workflows.maxRunning);
  });

  it("uses package defaults for an empty file", () => {
    assert.deepEqual(resolvePackageConfig({}), {
      subagents: {
        defaultModel: undefined,
        defaultThinking: undefined,
        maxRunning: 4,
        maxRuntimeMinutes: 30,
        maxRuntimeMs: 30 * 60_000,
      },
      backgroundTerminals: { maxRunning: 8 },
      workflows: { maxRunning: 1, childMaxRunning: 4 },
    });
  });
});

describe("read/write", () => {
  it("round-trips a config file", () => {
    const dir = tempDir();
    const path = join(dir, "pi-enhanced.json");
    writeConfigFile(path, {
      subagents: { maxRunning: 6, defaultThinking: "medium" },
    });
    const raw = readFileSync(path, "utf8");
    assert.ok(raw.includes('"maxRunning": 6'));
    assert.deepEqual(readConfigFile(path), {
      subagents: { maxRunning: 6, defaultThinking: "medium" },
    });
  });

  it("returns empty for missing or corrupt files", () => {
    const dir = tempDir();
    assert.deepEqual(readConfigFile(join(dir, "missing.json")), {});
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json", "utf8");
    assert.deepEqual(readConfigFile(bad), {});
  });

  it("creates parent directories when writing", () => {
    const dir = tempDir();
    const path = join(dir, "nested", "a", "pi-enhanced.json");
    writeConfigFile(path, { workflows: { maxRunning: 1 } });
    assert.ok(readFileSync(path, "utf8").includes("workflows"));
  });
});

describe("patchConfigFile (project scope)", () => {
  it("writes, patches, and clears overrides under project cwd", () => {
    const cwd = tempDir();
    patchConfigFile("project", cwd, {
      subagents: {
        defaultModel: "provider/model",
        defaultThinking: "high",
        maxRunning: 8,
        maxRuntimeMinutes: 45,
      },
      backgroundTerminals: { maxRunning: 4 },
      workflows: { maxRunning: 2, childMaxRunning: 6 },
    });

    const path = projectConfigPath(cwd);
    assert.deepEqual(readConfigFile(path), {
      subagents: {
        defaultModel: "provider/model",
        defaultThinking: "high",
        maxRunning: 8,
        maxRuntimeMinutes: 45,
      },
      backgroundTerminals: { maxRunning: 4 },
      workflows: { maxRunning: 2, childMaxRunning: 6 },
    });

    patchConfigFile("project", cwd, {
      subagents: { defaultModel: null, defaultThinking: null, maxRunning: 2 },
    });
    assert.deepEqual(readConfigFile(path), {
      subagents: { maxRunning: 2, maxRuntimeMinutes: 45 },
      backgroundTerminals: { maxRunning: 4 },
      workflows: { maxRunning: 2, childMaxRunning: 6 },
    });
  });
});

describe("loadPackageConfig trust gate", () => {
  it("ignores project file when project is untrusted", () => {
    const cwd = tempDir();
    // Distinct from package default (4) so trust gating is observable.
    patchConfigFile("project", cwd, { subagents: { maxRunning: 7 } });
    const trusted = loadPackageConfig({ cwd, projectTrusted: true });
    const untrusted = loadPackageConfig({ cwd, projectTrusted: false });
    assert.equal(trusted.subagents.maxRunning, 7);
    // Untrusted = global file only + defaults (ignore project).
    const globalOnly = resolvePackageConfig(readConfigFile(globalConfigPath()));
    assert.equal(untrusted.subagents.maxRunning, globalOnly.subagents.maxRunning);
  });
});

describe("formatPackageConfigSummary", () => {
  it("renders inherit placeholders", () => {
    const text = formatPackageConfigSummary(DEFAULT_PACKAGE_CONFIG);
    assert.ok(text.includes("inherit from Pi session"));
    assert.ok(text.includes("maxRunning=4"));
  });
});
