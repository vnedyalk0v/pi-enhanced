import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
    const binDir = await mkdtemp(join(tmpdir(), "pi-file-search-late-bin-"));
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
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
    try {
      const execution = tools
        .get("rg")!
        .execute("test", { pattern: "." }, undefined, undefined, {
          cwd: tmpdir(),
          hasUI: false,
        }) as Promise<{ details: { fullOutputPath?: string } }>;

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
      const fullOutputPath = result.details.fullOutputPath;
      assert.ok(fullOutputPath);
      await assert.rejects(stat(fullOutputPath), { code: "ENOENT" });
    } finally {
      process.env.PATH = originalPath;
      await handlers.get("session_shutdown")!({});
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
