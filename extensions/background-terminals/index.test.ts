import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import backgroundTerminals from "./index.ts";
import { projectConfigPath } from "../shared/package-config.ts";

type Handler = (...args: unknown[]) => Promise<unknown>;
type Tool = { execute: Handler };
type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};

function captureExtension() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const messages: Array<Record<string, unknown>> = [];
  const registrations = {
    registerTool<TParams extends TSchema, TDetails, TState>(
      tool: ToolDefinition<TParams, TDetails, TState>,
    ) {
      tools.set(tool.name, {
        execute: async (...args) => Reflect.apply(tool.execute, undefined, args),
      });
    },
  } satisfies Pick<ExtensionAPI, "registerTool">;
  backgroundTerminals({
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    ...registrations,
    registerCommand: () => {},
    sendMessage: (message: Record<string, unknown>) => {
      messages.push(message);
    },
  } as unknown as ExtensionAPI);
  return { handlers, tools, messages };
}

function assertToolResult(value: unknown): asserts value is ToolResult {
  assert.ok(value && typeof value === "object");
  assert.ok("content" in value && Array.isArray(value.content));
  assert.ok("details" in value && value.details && typeof value.details === "object");
}

const ctx = {
  cwd: process.cwd(),
  model: undefined,
  thinkingLevel: undefined,
};

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("background-terminals extension lifecycle", () => {
  it("refuses to start a terminal after shutdown", async () => {
    const { handlers, tools } = captureExtension();
    await handlers.get("session_shutdown")!({});

    await assert.rejects(
      () =>
        tools
          .get("bg_start")!
          .execute("test", { command: "true", title: "late start" }, undefined, undefined, ctx),
      /Background terminal manager is shutting down/,
    );
  });

  it("rejects an unknown terminal id", async () => {
    const { handlers, tools } = captureExtension();
    try {
      await assert.rejects(
        () =>
          tools.get("bg_status")!.execute("test", { id: "bt-999" }, undefined, undefined, ctx),
        /Unknown terminal id: bt-999/,
      );
    } finally {
      await handlers.get("session_shutdown")!({});
    }
  });

  it("rejects an empty kill list", async () => {
    const { handlers, tools } = captureExtension();
    try {
      await assert.rejects(
        () => tools.get("bg_kill")!.execute("test", { ids: [] }, undefined, undefined, ctx),
        /ids must not be empty/,
      );
    } finally {
      await handlers.get("session_shutdown")!({});
    }
  });

  it("starts a terminal, reports its output, and kills it", async () => {
    const { handlers, tools } = captureExtension();
    try {
      const started = await tools
        .get("bg_start")!
        .execute(
          "test",
          { command: "echo ready; sleep 30", title: "round trip" },
          undefined,
          undefined,
          ctx,
        );
      assertToolResult(started);
      const id = started.details.id;
      assert.match(String(id), /^bt-\d+$/);
      assert.equal(started.details.status, "running");

      let statusText = "";
      for (let i = 0; i < 200; i++) {
        const status = await tools
          .get("bg_status")!
          .execute("status", { id }, undefined, undefined, ctx);
        assertToolResult(status);
        statusText = status.content[0]!.text;
        if (statusText.includes("ready")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.match(statusText, /ready/);

      const killed = await tools
        .get("bg_kill")!
        .execute("kill", { ids: [id] }, undefined, undefined, ctx);
      assertToolResult(killed);
      const results = killed.details.results as Array<Record<string, unknown>>;
      assert.equal(results[0]!.alreadySettled, false);
      assert.equal(results[0]!.status, "killed");
    } finally {
      await handlers.get("session_shutdown")!({});
    }
  });

  it("delivers a completion message when a terminal exits on its own", async () => {
    const { handlers, tools, messages } = captureExtension();
    try {
      const started = await tools
        .get("bg_start")!
        .execute("test", { command: "true", title: "quick" }, undefined, undefined, ctx);
      assertToolResult(started);
      const id = started.details.id;

      let completion: Record<string, unknown> | undefined;
      for (let i = 0; i < 200; i++) {
        completion = messages.find((m) => m.customType === "background-terminal-result");
        if (completion) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(completion, "expected a background-terminal-result message");
      const details = completion!.details as Record<string, unknown>;
      assert.equal(details.id, id);
      assert.equal(details.status, "done");
      assert.equal(details.exitCode, 0);
    } finally {
      await handlers.get("session_shutdown")!({});
    }
  });

  it("applies the project concurrency limit from package config", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-bt-project-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-bt-agent-"));
    tempRoots.push(projectDir, agentDir);

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const configPath = projectConfigPath(projectDir);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ backgroundTerminals: { maxRunning: 1 } }));

    const projectCtx = {
      cwd: projectDir,
      isProjectTrusted: () => true,
      hasUI: false,
    };

    const { handlers, tools } = captureExtension();
    let firstId: unknown;
    try {
      const first = await tools
        .get("bg_start")!
        .execute("first", { command: "sleep 30", title: "first" }, undefined, undefined, projectCtx);
      assertToolResult(first);
      firstId = first.details.id;

      await assert.rejects(
        () =>
          tools
            .get("bg_start")!
            .execute(
              "second",
              { command: "true", title: "second" },
              undefined,
              undefined,
              projectCtx,
            ),
        /at most 1 background terminals may run at once/,
      );
    } finally {
      if (firstId !== undefined) {
        await tools
          .get("bg_kill")!
          .execute("cleanup", { ids: [firstId] }, undefined, undefined, projectCtx);
      }
      await handlers.get("session_shutdown")!({});
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
