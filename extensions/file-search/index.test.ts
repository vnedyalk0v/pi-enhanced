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

function captureExtension(initialTools: string[] = []) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  let activeTools = [...initialTools];
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
    getActiveTools: () => [...activeTools],
    setActiveTools: (next: string[]) => {
      activeTools = [...next];
    },
  };
  fileSearch(pi as unknown as ExtensionAPI);
  return { handlers, tools, activeTools: () => activeTools };
}

describe("file-search lifecycle", () => {
  it("reports an install hint when the binary is missing", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-file-search-agent-"));
    const pathDir = await mkdtemp(join(tmpdir(), "pi-file-search-path-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalPath = process.env.PATH;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PATH = pathDir;

    try {
      const { tools } = captureExtension();
      const result = (await tools
        .get("fd")!
        .execute("test", { pattern: "*" }, undefined, undefined, {
          cwd: tmpdir(),
          hasUI: false,
        })) as { content: Array<{ text: string }>; details: { exitCode: number } };

      assert.match(result.content[0]?.text ?? "", /fd was not found on PATH/);
      assert.match(result.content[0]?.text ?? "", /brew install fd/);
      assert.equal(result.details.exitCode, 1);
    } finally {
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

async function withStubs(names: Array<"fd" | "rg">, run: () => Promise<void>) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-file-search-agent-"));
  const pathDir = await mkdtemp(join(tmpdir(), "pi-file-search-path-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PATH = pathDir;
  try {
    // Resolution shells out to `which`, which itself must be found on PATH.
    // Stub it too so resolution is fully isolated from the host's real PATH
    // (which may have real fd/rg installed) instead of depending on it.
    const whichStub = join(pathDir, "which");
    await writeFile(
      whichStub,
      `#!${process.execPath}
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const candidate = join(${JSON.stringify(pathDir)}, process.argv[2]);
if (existsSync(candidate)) {
  console.log(candidate);
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(whichStub, 0o755);
    for (const name of names) {
      const binary = join(pathDir, name);
      await writeFile(binary, `#!${process.execPath}\n`);
      await chmod(binary, 0o755);
    }
    await run();
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await Promise.all([
      rm(agentDir, { recursive: true, force: true }),
      rm(pathDir, { recursive: true, force: true }),
    ]);
  }
}

describe("file-search built-in retirement", () => {
  it("retires find and grep when both binaries resolve", async () => {
    await withStubs(["fd", "rg"], async () => {
      const { handlers, activeTools } = captureExtension(["read", "find", "grep", "bash"]);
      await handlers.get("session_start")!({});
      const active = activeTools();
      assert.ok(active.includes("read"));
      assert.ok(active.includes("bash"));
      assert.ok(active.includes("fd"));
      assert.ok(active.includes("rg"));
      assert.equal(active.includes("find"), false);
      assert.equal(active.includes("grep"), false);
    });
  });

  it("keeps find and grep when neither binary resolves", async () => {
    await withStubs([], async () => {
      const { handlers, activeTools } = captureExtension(["read", "find", "grep", "bash"]);
      await handlers.get("session_start")!({});
      const active = activeTools();
      assert.ok(active.includes("find"));
      assert.ok(active.includes("grep"));
      assert.ok(active.includes("fd"));
      assert.ok(active.includes("rg"));
    });
  });

  it("retires only the built-in whose replacement resolved", async () => {
    await withStubs(["fd"], async () => {
      const { handlers, activeTools } = captureExtension(["read", "find", "grep", "bash"]);
      await handlers.get("session_start")!({});
      const active = activeTools();
      assert.equal(active.includes("find"), false);
      assert.ok(active.includes("grep"));
      assert.ok(active.includes("fd"));
      assert.ok(active.includes("rg"));
    });
  });
});
