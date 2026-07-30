import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import fileSearch from "./index.ts";

type Handler = (...args: unknown[]) => Promise<unknown>;
type Tool = { execute: Handler };

function captureExtension() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerTool<TParams extends TSchema, TDetails, TState>(
      tool: ToolDefinition<TParams, TDetails, TState>,
    ) {
      tools.set(tool.name, {
        execute: async (...args) => Reflect.apply(tool.execute, undefined, args),
      });
    },
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  fileSearch(pi as unknown as ExtensionAPI);
  return { handlers, tools };
}

describe("file-search lifecycle", () => {
  it("passes tool cancellation through first-time binary installation", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-file-search-agent-"));
    const pathDir = await mkdtemp(join(tmpdir(), "pi-file-search-path-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalPath = process.env.PATH;
    const originalFetch = globalThis.fetch;
    let downloadAborted = false;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PATH = pathDir;
    globalThis.fetch = (async (_input, init) => {
      downloadAborted = init?.signal?.aborted ?? false;
      throw init?.signal?.reason ?? new Error("download was not aborted");
    }) as typeof fetch;

    try {
      const controller = new AbortController();
      controller.abort(new Error("tool cancelled"));
      const { tools } = captureExtension();
      const result = (await tools
        .get("fd")!
        .execute("test", { pattern: "*" }, controller.signal, undefined, {
          cwd: tmpdir(),
          hasUI: false,
        })) as { content: Array<{ text: string }> };

      assert.equal(downloadAborted, true);
      assert.match(result.content[0]?.text ?? "", /tool cancelled/);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await Promise.all([
        rm(agentDir, { recursive: true, force: true }),
        rm(pathDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("keeps truncated output until session shutdown", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "pi-file-search-bin-"));
    const binary = join(binDir, "fd");
    await writeFile(
      binary,
      `#!${process.execPath}\nfor (let i = 0; i < ${DEFAULT_MAX_LINES + 100}; i++) console.log(i)\n`,
    );
    await chmod(binary, 0o755);

    const { handlers, tools } = captureExtension();
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
    try {
      const result = (await tools
        .get("fd")!
        .execute("test", { pattern: "*" }, undefined, undefined, {
          cwd: tmpdir(),
          hasUI: false,
        })) as { details: { fullOutputPath?: string } };
      const fullOutputPath = result.details.fullOutputPath;

      assert.ok(fullOutputPath);
      assert.equal((await stat(fullOutputPath)).isFile(), true);
      await handlers.get("session_shutdown")!({});
      await assert.rejects(stat(fullOutputPath), { code: "ENOENT" });
      await handlers.get("session_shutdown")!({});
    } finally {
      process.env.PATH = originalPath;
      await handlers.get("session_shutdown")!({});
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("removes spill output created after shutdown begins", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-file-search-late-"));
    const binDir = join(root, "bin");
    const spillRoot = join(root, "tmp");
    await Promise.all([mkdir(binDir), mkdir(spillRoot)]);
    const binary = join(binDir, "rg");
    const readyPath = join(binDir, "ready");
    const releasePath = join(binDir, "release");
    await writeFile(
      binary,
      `#!${process.execPath}
const { existsSync, writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(readyPath)}, "");
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(releasePath)})) return;
  clearInterval(timer);
  for (let i = 0; i < ${DEFAULT_MAX_LINES + 100}; i++) console.log(i);
}, 5);
`,
    );
    await chmod(binary, 0o755);

    const { handlers, tools } = captureExtension();
    const originalPath = process.env.PATH;
    const originalTmpdir = process.env.TMPDIR;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
    process.env.TMPDIR = spillRoot;
    try {
      const execution = tools
        .get("rg")!
        .execute("test", { pattern: "." }, undefined, undefined, {
          cwd: tmpdir(),
          hasUI: false,
        }) as Promise<{
          content: Array<{ type: string; text: string }>;
          details: { fullOutputPath?: string };
        }>;

      for (let i = 0; i < 100; i++) {
        try {
          await stat(readyPath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      await stat(readyPath);
      await handlers.get("session_shutdown")!({});
      await writeFile(releasePath, "");

      const result = await execution;
      assert.equal(result.details.fullOutputPath, undefined);
      assert.doesNotMatch(result.content[0]?.text ?? "", /Full output:/);
      assert.deepEqual(await readdir(spillRoot), []);
    } finally {
      process.env.PATH = originalPath;
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      await handlers.get("session_shutdown")!({});
      await rm(root, { recursive: true, force: true });
    }
  });
});
