import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { startPiBackend } from "./backend.ts";

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
