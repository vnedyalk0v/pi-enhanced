import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import askUser from "./index.ts";

type FakeUi = Pick<ExtensionContext["ui"], "select" | "input">;
type FakeContext = { hasUI: boolean; ui: FakeUi };
type RegisteredTool = { execute: (...args: unknown[]) => unknown };
type ToolResult = { content: Array<{ type: string; text: string }>; details: unknown };

function register() {
  let tool: RegisteredTool | undefined;
  const pi = {
    registerTool<TParams extends TSchema, TDetails, TState>(
      registered: ToolDefinition<TParams, TDetails, TState>,
    ) {
      tool = {
        execute: (...args) => Reflect.apply(registered.execute, undefined, args),
      };
    },
  } satisfies Pick<ExtensionAPI, "registerTool">;
  askUser(pi as ExtensionAPI);
  assert.ok(tool);
  return tool;
}

async function run(
  tool: RegisteredTool,
  ui: FakeUi,
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ label: string; description?: string }>;
    allowOther?: boolean;
  }>,
) {
  const ctx = { hasUI: true, ui } satisfies FakeContext;
  const result = await tool.execute("test", { questions }, undefined, undefined, ctx);
  assertResult(result);
  return result;
}

function assertResult(result: unknown): asserts result is ToolResult {
  assert.ok(result && typeof result === "object");
  assert.ok("content" in result && Array.isArray(result.content));
  assert.ok("details" in result);
}

describe("ask_user", () => {
  it("maps duplicate labels to the selected original option", async () => {
    const displayed: string[][] = [];
    const result = await run(
      register(),
      {
        select: async (_title, options) => {
          displayed.push(options);
          return options[1];
        },
        input: async () => undefined,
      },
      [
        {
          id: "deployment",
          prompt: "Choose a target",
          options: [{ label: "Production" }, { label: "Production" }],
          allowOther: false,
        },
      ],
    );

    assert.deepEqual(displayed, [["1. Production", "2. Production"]]);
    assert.deepEqual(result.details, {
      answers: [{ id: "deployment", answer: "Production", wasCustom: false }],
      cancelled: false,
    });
  });

  it("keeps duplicate label and description rows distinguishable", async () => {
    const displayed: string[][] = [];
    const result = await run(
      register(),
      {
        select: async (_title, options) => {
          displayed.push(options);
          return options[1];
        },
        input: async () => undefined,
      },
      [
        {
          id: "region",
          prompt: "Choose a region",
          options: [
            { label: "Europe", description: "Low latency" },
            { label: "Europe", description: "Low latency" },
          ],
          allowOther: false,
        },
      ],
    );

    assert.deepEqual(displayed, [["1. Europe — Low latency", "2. Europe — Low latency"]]);
    assert.deepEqual(result.details, {
      answers: [{ id: "region", answer: "Europe", wasCustom: false }],
      cancelled: false,
    });
  });

  it("treats a real Other label as a normal answer", async () => {
    const result = await run(
      register(),
      {
        select: async (_title, options) => options[0],
        input: async () => {
          throw new Error("input should not open");
        },
      },
      [
        {
          id: "answer",
          prompt: "Choose an answer",
          options: [{ label: "Other (type answer)" }],
        },
      ],
    );

    assert.deepEqual(result.details, {
      answers: [{ id: "answer", answer: "Other (type answer)", wasCustom: false }],
      cancelled: false,
    });
  });

  it("opens free-text input only for the generated row", async () => {
    const result = await run(
      register(),
      {
        select: async (_title, options) => options[1],
        input: async () => "  custom answer  ",
      },
      [
        {
          id: "answer",
          prompt: "Choose an answer",
          options: [{ label: "Known answer" }],
        },
      ],
    );

    assert.deepEqual(result.details, {
      answers: [{ id: "answer", answer: "custom answer", wasCustom: true }],
      cancelled: false,
    });
  });

  it("preserves cancellation details and multi-question titles", async () => {
    const titles: string[] = [];
    const result = await run(
      register(),
      {
        select: async (title, options) => {
          titles.push(title);
          return titles.length === 1 ? options[0] : undefined;
        },
        input: async () => undefined,
      },
      [
        { id: "first", prompt: "First", options: [{ label: "A" }] },
        { id: "second", prompt: "Second", options: [{ label: "B" }] },
      ],
    );

    // User-facing titles show progress, not the model-facing question ids.
    assert.deepEqual(titles, ["(1/2) First", "(2/2) Second"]);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.text, "User cancelled");
    assert.deepEqual(result.details, {
      answers: [{ id: "first", answer: "A", wasCustom: false }],
      cancelled: true,
    });
  });
});
