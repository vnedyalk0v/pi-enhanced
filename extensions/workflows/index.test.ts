import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import workflows from "./index.ts";
import { WorkflowManager } from "./manager.ts";
import { projectConfigPath } from "../shared/package-config.ts";

type Handler = (...args: unknown[]) => unknown;
type Tool = { execute: Handler };
type Command = { handler: Handler };

function captureExtension() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
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
    registerCommand: (name: string, command: { handler: Handler }) => {
      commands.set(name, command);
    },
    sendMessage: () => {},
  } as unknown as ExtensionAPI);
  return { handlers, tools, commands };
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

describe("/workflow package config", () => {
  it("applies package config defaults for model and thinking", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-wf-project-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-wf-agent-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const configFilePath = projectConfigPath(projectDir);
    await mkdir(dirname(configFilePath), { recursive: true });
    await writeFile(
      configFilePath,
      JSON.stringify({
        subagents: { defaultModel: "test-provider/test-model", defaultThinking: "low" },
      }),
    );

    const originalStart = WorkflowManager.prototype.start;
    let started: { model?: string; thinking?: string } | undefined;
    WorkflowManager.prototype.start = async function (params: {
      model?: string;
      thinking?: string;
    }) {
      started = { model: params.model, thinking: params.thinking };
      return { id: "wf-1", artifactsDir: "/tmp/wf-1" } as unknown as ReturnType<
        typeof originalStart
      >;
    };

    const { handlers, commands } = captureExtension();
    try {
      await commands.get("workflow")!.handler("build the thing", {
        cwd: projectDir,
        hasUI: false,
        model: undefined,
        thinkingLevel: undefined,
        isProjectTrusted: () => true,
      });

      assert.equal(started?.model, "test-provider/test-model");
      assert.equal(started?.thinking, "low");
    } finally {
      WorkflowManager.prototype.start = originalStart;
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      await handlers.get("session_shutdown")!({});
      await Promise.all([
        rm(projectDir, { recursive: true, force: true }),
        rm(agentDir, { recursive: true, force: true }),
      ]);
    }
  });
});
