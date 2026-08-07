import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
  configPathForScope,
  patchConfigFile,
  projectConfigPath,
  readConfigFile,
} from "../shared/package-config.ts";
import {
  INHERIT,
  applyChange,
  buildItems,
  createSettingsItems,
  modelItems,
  modelsForCurrentProvider,
  resolveModel,
  thinkingItems,
  thinkingLevelsFor,
  type SessionModelCtx,
} from "./index.ts";

type TestModel = Model<"openai-responses">;

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "pe-settings-"));
  temps.push(dir);
  return dir;
}

function fakeModel(
  provider: string,
  id: string,
  options?: { reasoning?: boolean; thinkingLevelMap?: TestModel["thinkingLevelMap"] },
): TestModel {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: "https://example.invalid",
    reasoning: options?.reasoning ?? true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    thinkingLevelMap: options?.thinkingLevelMap,
  } satisfies TestModel;
}

function sessionCtx(overrides?: Partial<SessionModelCtx>): SessionModelCtx {
  const openaiA = fakeModel("openai", "gpt-5.6-luna");
  const openaiB = fakeModel("openai", "gpt-4.1", { reasoning: false });
  const anthropic = fakeModel("anthropic", "claude-sonnet-4", {
    thinkingLevelMap: { xhigh: null, max: null },
  });
  const models = [openaiA, openaiB, anthropic];
  return {
    model: openaiA,
    thinkingLevel: "high",
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => models,
      getAll: () => models,
    } as never,
    ...overrides,
  };
}

describe("applyChange", () => {
  it("writes discrete overrides and clears inherit/default values", () => {
    const cwd = tempDir();
    const scope = applyChange("project", cwd, "scope", "project", {
      projectTrusted: true,
    }).scope;
    assert.equal(scope, "project");

    applyChange(scope, cwd, "subagents.defaultModel", "openai/gpt-test", {
      projectTrusted: true,
    });
    applyChange(scope, cwd, "subagents.defaultThinking", "high", { projectTrusted: true });
    applyChange(scope, cwd, "subagents.maxRunning", "8", { projectTrusted: true });

    applyChange(scope, cwd, "subagents.defaultModel", INHERIT, { projectTrusted: true });
    applyChange(scope, cwd, "subagents.defaultThinking", `${INHERIT} → high`, {
      projectTrusted: true,
    });
    applyChange(scope, cwd, "subagents.maxRunning", "(default)", { projectTrusted: true });

    const file = readConfigFile(projectConfigPath(cwd));
    assert.equal(file.subagents?.defaultModel, undefined);
    assert.equal(file.subagents?.defaultThinking, undefined);
    assert.equal(file.subagents?.maxRunning, undefined);
  });

  it("refuses project writes when projectTrusted is false", () => {
    const cwd = tempDir();
    const result = applyChange("project", cwd, "subagents.maxRunning", "8", {
      projectTrusted: false,
    });
    assert.equal(result.scope, "global");
    assert.ok(result.error);
    assert.deepEqual(readConfigFile(projectConfigPath(cwd)), {});
  });
});

describe("Pi session model / thinking helpers", () => {
  it("lists only models from the active Pi provider", () => {
    const ctx = sessionCtx();
    const models = modelsForCurrentProvider(ctx);
    assert.equal(models.length, 2);
    assert.ok(models.every((m) => m.provider === "openai"));
  });

  it("modelItems puts inherit-from-Pi first and only current-provider models", () => {
    const ctx = sessionCtx();
    const items = modelItems(ctx, undefined);
    assert.equal(items[0]?.value, INHERIT);
    assert.ok(items[0]?.description?.includes("gpt-5.6-luna"));
    const values = items.map((i) => i.value);
    assert.ok(values.includes("openai/gpt-5.6-luna"));
    assert.ok(values.includes("openai/gpt-4.1"));
    assert.ok(!values.some((v) => v.startsWith("anthropic/")));
  });

  it("thinkingLevelsFor follows the override model capabilities", () => {
    const ctx = sessionCtx();
    // Non-reasoning model → only off
    assert.deepEqual(thinkingLevelsFor(ctx, "openai/gpt-4.1"), ["off"]);
    // Inherit Pi model (reasoning) → extended set without requiring xhigh/max maps
    const inherited = thinkingLevelsFor(ctx, undefined);
    assert.ok(inherited.includes("off"));
    assert.ok(inherited.includes("high"));
    assert.ok(!inherited.includes("xhigh")); // no map entry → hidden
  });

  it("resolveModel prefers exact provider/id then falls back to Pi model", () => {
    const ctx = sessionCtx();
    assert.equal(resolveModel(ctx, "openai/gpt-4.1")?.id, "gpt-4.1");
    assert.equal(resolveModel(ctx, undefined)?.id, "gpt-5.6-luna");
    assert.equal(resolveModel(ctx, "missing/model")?.id, "gpt-5.6-luna");
  });

  it("thinkingItems offers inherit plus model-supported levels", () => {
    const ctx = sessionCtx();
    const items = thinkingItems(ctx, undefined, undefined);
    assert.equal(items[0]?.value, INHERIT);
    assert.ok(items.some((i) => i.value === "high"));
  });
});

describe("buildItems / createSettingsItems", () => {
  it("shows inherit-from-Pi with live session labels when unset", () => {
    const cwd = tempDir();
    const ctx = sessionCtx();
    const file = readConfigFile(configPathForScope("project", cwd));
    const items = buildItems("project", file, ctx);
    const model = items.find((i) => i.id === "subagents.defaultModel");
    const thinking = items.find((i) => i.id === "subagents.defaultThinking");
    assert.ok(model?.currentValue.includes("gpt-5.6-luna"));
    assert.ok(thinking?.currentValue.includes("high"));
    assert.equal(items.find((i) => i.id === "subagents.maxRunning")?.currentValue, "(default)");
  });

  it("wires model and thinking submenus", () => {
    const cwd = tempDir();
    patchConfigFile("project", cwd, { subagents: { maxRunning: 2, defaultModel: "openai/gpt-4.1" } });
    const file = readConfigFile(configPathForScope("project", cwd));
    const ctx = sessionCtx();
    const withMenu = createSettingsItems("project", file, ctx);
    assert.ok(withMenu.find((i) => i.id === "subagents.defaultModel")?.submenu);
    assert.ok(withMenu.find((i) => i.id === "subagents.defaultThinking")?.submenu);
    assert.equal(
      withMenu.find((i) => i.id === "subagents.defaultModel")?.currentValue,
      "openai/gpt-4.1",
    );
  });
});
