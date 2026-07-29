import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents from "./index.ts";
import workflows from "../workflows/index.ts";

type Handler = (...args: unknown[]) => Promise<unknown>;
type Tool = { execute: Handler };

function captureExtension(extension: (pi: ExtensionAPI) => void) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  extension({
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    registerTool: (tool: { name: string; execute: Handler }) => {
      tools.set(tool.name, tool);
    },
    registerCommand: () => {},
  } as unknown as ExtensionAPI);
  return { handlers, tools };
}

const ctx = {
  cwd: process.cwd(),
  model: undefined,
  thinkingLevel: undefined,
};

describe("background extension shutdown boundaries", () => {
  it("refuses to create a subagent manager after shutdown", async () => {
    const { handlers, tools } = captureExtension(subagents);
    await handlers.get("session_shutdown")!({});

    await assert.rejects(
      () =>
        tools
          .get("sa_spawn")!
          .execute("test", { prompt: "late start" }, undefined, undefined, ctx),
      /Subagent manager is shutting down/,
    );
  });

  it("refuses to create a workflow manager after shutdown", async () => {
    const { handlers, tools } = captureExtension(workflows);
    await handlers.get("session_shutdown")!({});

    await assert.rejects(
      () =>
        tools
          .get("wf_start")!
          .execute("test", { goal: "late start" }, undefined, undefined, ctx),
      /Workflow manager is shutting down/,
    );
  });
});
