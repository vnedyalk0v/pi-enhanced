import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildBaseArgs, startPiBackend } from "./backend.ts";

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
