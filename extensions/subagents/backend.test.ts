import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildBaseArgs, startPiBackend, type BackendJob } from "./backend.ts";

describe("buildBaseArgs", () => {
  it("omits --tools when no allowlist is given", () => {
    const args = buildBaseArgs({});
    assert.equal(args.includes("--tools"), false);
  });

  it("passes an explicit empty allowlist as --tools '' (zero tools), not omitted", () => {
    const args = buildBaseArgs({ tools: [] });
    const idx = args.indexOf("--tools");
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], "");
  });

  it("joins a non-empty allowlist", () => {
    const args = buildBaseArgs({ tools: ["read", "grep"] });
    const idx = args.indexOf("--tools");
    assert.equal(args[idx + 1], "read,grep");
  });

  it("includes model and thinking when given", () => {
    const args = buildBaseArgs({ model: "anthropic/claude-haiku-4-5", thinking: "low" });
    assert.deepEqual(
      args,
      ["--mode", "json", "-p", "--no-session", "--model", "anthropic/claude-haiku-4-5", "--thinking", "low"],
    );
  });
});

describe("named agent prompt failure", () => {
  let previousTmpdir: string | undefined;

  beforeEach(() => {
    previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = "/nonexistent-dir-for-pi-enhanced-tests";
  });

  afterEach(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  });

  it(
    "fails the spawn rather than silently dropping a named agent's prompt",
    { skip: process.platform === "win32" },
    async () => {
      // Forces mkdtemp to fail (TMPDIR points nowhere) before any process is spawned.
      await assert.rejects(
        () =>
          startPiBackend({
            prompt: "task",
            cwd: process.cwd(),
            systemPromptAppend: "You are a specialized scout agent.",
          }),
        /Failed to write agent prompt file/,
      );
    },
  );
});

it(
  "runs the native Pi argv and prompt contract through a hermetic executable",
  { skip: process.platform === "win32" },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-backend-contract-")));
    const binDir = join(root, "bin");
    const cwd = join(root, "project");
    const capturePath = join(root, "capture.json");
    await Promise.all([mkdir(binDir, { recursive: true }), mkdir(cwd, { recursive: true })]);

    const shimPath = join(binDir, "pi");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const promptIndex = args.indexOf("--append-system-prompt");
const promptFile = args[promptIndex + 1];
fs.writeFileSync(process.env.PI_ENHANCED_BACKEND_CAPTURE, JSON.stringify({
  args,
  cwd: process.cwd(),
  promptFile,
  promptFileExists: fs.existsSync(promptFile),
  systemPrompt: fs.readFileSync(promptFile, "utf8"),
}));
process.stderr.write("x".repeat(90000));
const first = JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "first answer" }] },
}) + "\\n";
const last = JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "final answer" }] },
}) + "\\n";
process.stdout.write(first.slice(0, 19));
setTimeout(() => {
  process.stdout.write(first.slice(19) + last.slice(0, 31));
  setTimeout(() => process.stdout.end(last.slice(31)), 10);
}, 10);
`,
    );
    await chmod(shimPath, 0o755);

    const previousPath = process.env.PATH;
    const previousCapture = process.env.PI_ENHANCED_BACKEND_CAPTURE;
    process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
    process.env.PI_ENHANCED_BACKEND_CAPTURE = capturePath;

    let job: BackendJob | undefined;
    try {
      job = await startPiBackend({
        prompt: "complete this task",
        cwd,
        model: "provider/model",
        thinking: "high",
        tools: ["read", "grep"],
        systemPromptAppend: "SPECIALIZED BACKEND PROMPT",
      });
      const capture = await waitForCapture(capturePath);
      assert.equal(capture.promptFileExists, true);
      assert.equal(await realpath(capture.cwd), await realpath(cwd));
      assert.deepEqual(capture.args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
      assert.deepEqual(capture.args.slice(capture.args.indexOf("--model"), capture.args.indexOf("--model") + 2), [
        "--model",
        "provider/model",
      ]);
      assert.deepEqual(
        capture.args.slice(capture.args.indexOf("--thinking"), capture.args.indexOf("--thinking") + 2),
        ["--thinking", "high"],
      );
      assert.deepEqual(capture.args.slice(capture.args.indexOf("--tools"), capture.args.indexOf("--tools") + 2), [
        "--tools",
        "read,grep",
      ]);
      assert.equal(capture.args.at(-1), "complete this task");
      assert.match(capture.systemPrompt, /You are a subagent worker in an isolated Pi session/);
      assert.equal(capture.systemPrompt.match(/SPECIALIZED BACKEND PROMPT/g)?.length, 1);

      const result = await job.collect();
      assert.equal(result.exitCode, 0);
      assert.equal(result.resultText, "final answer");
      assert.ok(result.output.length <= 80_000);
      await assert.rejects(stat(dirname(capture.promptFile)), { code: "ENOENT" });
    } finally {
      await job?.collect().catch(() => {});
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCapture === undefined) delete process.env.PI_ENHANCED_BACKEND_CAPTURE;
      else process.env.PI_ENHANCED_BACKEND_CAPTURE = previousCapture;
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function waitForCapture(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as {
        args: string[];
        cwd: string;
        promptFile: string;
        promptFileExists: boolean;
        systemPrompt: string;
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Pi shim did not capture its invocation");
}
