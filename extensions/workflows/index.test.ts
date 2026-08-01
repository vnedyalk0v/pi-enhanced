import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import workflows from "./index.ts";
import { WorkflowManager } from "./manager.ts";

type Handler = (...args: unknown[]) => unknown;
type Tool = { execute: Handler };

function captureExtension() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  workflows({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    getAllTools: () => [],
    registerTool<TParams extends TSchema, TDetails, TState>(
      tool: ToolDefinition<TParams, TDetails, TState>,
    ) {
      tools.set(tool.name, {
        execute: (...args) => Reflect.apply(tool.execute, undefined, args),
      });
    },
    registerCommand: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI);
  return { handlers, tools };
}

function staleContext(onAccess = () => {}) {
  return {
    cwd: process.cwd(),
    model: undefined,
    thinkingLevel: undefined,
    get hasUI() {
      onAccess();
      throw new Error("stale");
    },
  } as unknown as ExtensionContext;
}

describe("workflow widget lifecycle", () => {
  it("widget update survives a stale context", async () => {
    const { handlers, tools } = captureExtension();
    const originalList = WorkflowManager.prototype.list;
    let triggered = false;
    // Trigger onChange without starting a real Pi workflow.
    WorkflowManager.prototype.list = function () {
      if (!triggered) {
        triggered = true;
        const onChange = Reflect.get(this, "onChange");
        if (typeof onChange === "function") onChange();
      }
      return originalList.call(this);
    };

    try {
      await handlers.get("session_start")!({}, staleContext());
      await assert.doesNotReject(async () => {
        await tools.get("wf_list")!.execute("test", {});
      });
      assert.equal(triggered, true);
      await tools.get("wf_list")!.execute("test", {});
    } finally {
      WorkflowManager.prototype.list = originalList;
      await handlers.get("session_shutdown")!({});
    }
  });

  it("session_shutdown survives a stale context", async () => {
    const { handlers } = captureExtension();
    let accesses = 0;
    await handlers.get("session_start")!({}, staleContext(() => accesses++));

    await assert.doesNotReject(async () => {
      await handlers.get("session_shutdown")!({});
    });
    assert.equal(accesses, 1);
  });
});
