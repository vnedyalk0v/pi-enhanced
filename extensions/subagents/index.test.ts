import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import subagents from "./index.ts";
import workflows from "../workflows/index.ts";

type Handler = (...args: unknown[]) => Promise<unknown>;
type Tool = { execute: Handler };
type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};

function captureExtension(extension: (pi: ExtensionAPI) => void) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const registrations = {
    registerTool<TParams extends TSchema, TDetails, TState>(
      tool: ToolDefinition<TParams, TDetails, TState>,
    ) {
      tools.set(tool.name, {
        execute: async (...args) => Reflect.apply(tool.execute, undefined, args),
      });
    },
  } satisfies Pick<ExtensionAPI, "registerTool">;
  extension({
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    ...registrations,
    registerCommand: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI);
  return { handlers, tools };
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

it(
  "enforces discovery, confirmation, precedence, and native Pi forwarding at the sa_spawn boundary",
  { skip: process.platform === "win32" },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-contract-")));
    tempRoots.push(root);
    const project = join(root, "project");
    const nested = join(project, "packages", "worker");
    const outside = join(root, "outside");
    const escapedWorkingDir = join(project, "escaped");
    const agentDir = join(root, "agent-dir");
    const binDir = join(root, "bin");
    const capturePath = join(root, "spawn.json");
    await Promise.all([
      mkdir(join(project, ".git"), { recursive: true }),
      mkdir(join(project, ".pi", "agents"), { recursive: true }),
      mkdir(join(agentDir, "agents"), { recursive: true }),
      mkdir(join(outside, ".pi", "agents"), { recursive: true }),
      mkdir(nested, { recursive: true }),
      mkdir(binDir, { recursive: true }),
    ]);
    await symlink(outside, escapedWorkingDir);

    await writeFile(
      join(agentDir, "agents", "scout.md"),
      [
        "---",
        "name: scout",
        "description: user scout",
        "tools: bash",
        "model: user/model",
        "thinking: minimal",
        "---",
        "USER SCOUT PROMPT",
      ].join("\n"),
    );
    await writeFile(
      join(project, ".pi", "agents", "scout.md"),
      [
        "---",
        "name: scout",
        "description: project scout",
        "tools: read, grep",
        "model: project/model",
        "thinking: medium",
        "---",
        "PROJECT SCOUT PROMPT",
      ].join("\n"),
    );
    await writeFile(
      join(outside, ".pi", "agents", "escaped.md"),
      "---\nname: escaped\ndescription: must stay untrusted\n---\nESCAPED PROMPT",
    );

    const shimPath = join(binDir, "pi");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const promptIndex = args.indexOf("--append-system-prompt");
const promptFile = promptIndex === -1 ? undefined : args[promptIndex + 1];
fs.writeFileSync(process.env.PI_ENHANCED_CAPTURE, JSON.stringify({
  args,
  cwd: process.cwd(),
  promptFile,
  systemPrompt: promptFile ? fs.readFileSync(promptFile, "utf8") : undefined,
}));
const line = JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "shim complete" }] },
}) + "\\n";
process.stdout.write(line.slice(0, 23));
setTimeout(() => process.stdout.end(line.slice(23)), 20);
`,
    );
    await chmod(shimPath, 0o755);

    const previousPath = process.env.PATH;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousCapture = process.env.PI_ENHANCED_CAPTURE;
    process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_ENHANCED_CAPTURE = capturePath;

    const confirmations: Array<{ title: string; message: string; timeout?: number }> = [];
    const confirmationAnswers = [false, true];
    const extensionCtx = {
      cwd: project,
      mode: "tui",
      hasUI: true,
      model: { provider: "parent", id: "parent-model" },
      thinkingLevel: "low",
      isProjectTrusted: () => true,
      ui: {
        confirm: async (title: string, message: string, options?: { timeout?: number }) => {
          confirmations.push({ title, message, timeout: options?.timeout });
          return confirmationAnswers.shift() ?? false;
        },
        setWidget: () => {},
      },
    };

    let shutdown: Handler | undefined;
    try {
      const { handlers, tools } = captureExtension(subagents);
      shutdown = handlers.get("session_shutdown");
      await handlers.get("session_start")?.({}, extensionCtx);

      const listed = await tools
        .get("sa_agents")!
        .execute("list", { working_dir: nested }, undefined, undefined, extensionCtx);
      assertToolResult(listed);
      assert.deepEqual(listed.details.agents, ["scout"]);
      assert.match(listed.content[0]!.text, /project scout/);
      assert.doesNotMatch(listed.content[0]!.text, /user scout/);

      const escaped = await tools
        .get("sa_agents")!
        .execute("escaped", { working_dir: escapedWorkingDir }, undefined, undefined, extensionCtx);
      assertToolResult(escaped);
      assert.deepEqual(escaped.details.agents, ["scout"]);
      assert.doesNotMatch(escaped.content[0]!.text, /must stay untrusted/);

      const declined = await tools
        .get("sa_spawn")!
        .execute(
          "decline",
          { agent: "scout", prompt: "do not start", working_dir: nested },
          undefined,
          undefined,
          extensionCtx,
        );
      assertToolResult(declined);
      assert.deepEqual(declined.details, { cancelled: true });
      await assert.rejects(readFile(capturePath), { code: "ENOENT" });

      const spawned = await tools
        .get("sa_spawn")!
        .execute(
          "approve",
          {
            agent: "scout",
            prompt: "inspect the project",
            working_dir: nested,
            model: "override/model",
            thinking: "high",
          },
          undefined,
          undefined,
          extensionCtx,
        );
      assertToolResult(spawned);
      assert.equal(spawned.details.agent, "scout");
      assert.equal(spawned.details.status, "running");
      const id = spawned.details.id;
      assert.equal(typeof id, "string");

      const waited = await tools
        .get("sa_wait")!
        .execute("wait", { ids: [id] }, undefined, undefined, extensionCtx);
      assertToolResult(waited);
      assert.deepEqual(waited.details.results, [{ id, status: "done", agent: "scout" }]);

      const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
        args: string[];
        cwd: string;
        systemPrompt: string;
      };
      assert.equal(await realpath(capture.cwd), await realpath(nested));
      assert.deepEqual(capture.args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
      assert.deepEqual(capture.args.slice(capture.args.indexOf("--model"), capture.args.indexOf("--model") + 2), [
        "--model",
        "override/model",
      ]);
      assert.deepEqual(
        capture.args.slice(capture.args.indexOf("--thinking"), capture.args.indexOf("--thinking") + 2),
        ["--thinking", "high"],
      );
      assert.deepEqual(capture.args.slice(capture.args.indexOf("--tools"), capture.args.indexOf("--tools") + 2), [
        "--tools",
        "read,grep",
      ]);
      assert.equal(capture.args.at(-1), "inspect the project");
      assert.equal(capture.systemPrompt.match(/PROJECT SCOUT PROMPT/g)?.length, 1);
      assert.doesNotMatch(capture.systemPrompt, /USER SCOUT PROMPT/);
      assert.equal(confirmations.length, 2);
      assert.deepEqual(confirmations.map((entry) => entry.title), [
        "Run project-local subagent?",
        "Run project-local subagent?",
      ]);
      assert.ok(confirmations.every((entry) => entry.timeout === 30_000));
    } finally {
      await shutdown?.({});
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousCapture === undefined) delete process.env.PI_ENHANCED_CAPTURE;
      else process.env.PI_ENHANCED_CAPTURE = previousCapture;
    }
  },
);
