import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeCodexModelId } from "./backends/codex.ts";
import {
  appendBounded,
  extractCodexLastMessage,
  extractPiLastAssistantText,
  runProcess,
} from "./run.ts";

function timeout(message: string) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(message)), 2_000).unref();
  });
}

it(
  "escalates SIGTERM to SIGKILL",
  { skip: process.platform === "win32" },
  async () => {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const handle = runProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1_000);',
      ],
      cwd: process.cwd(),
      onStdout: (chunk) => {
        if (chunk.includes("ready")) markReady();
      },
    });

    try {
      await Promise.race([ready, timeout("child did not become ready")]);
      handle.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 50));
      handle.kill("SIGKILL");
      const result = await Promise.race([handle.wait, timeout("child did not exit")]);
      assert.equal(result.signal, "SIGKILL");
    } finally {
      if (handle.pid !== undefined) {
        try {
          process.kill(-handle.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await handle.wait;
    }
  },
);

it(
  "waits for inherited stdout to close after the child exits",
  { skip: process.platform === "win32" },
  async () => {
    const marker = "tail-after-parent-exit";
    const grandchildScript = `setTimeout(() => process.stdout.write("${marker}"), 200);`;
    const parentScript = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: ["ignore", 1, 2] }).unref();`;
    let stdout = "";
    const handle = runProcess({
      command: process.execPath,
      args: ["-e", parentScript],
      cwd: process.cwd(),
      onStdout: (chunk) => {
        stdout += chunk;
      },
    });

    try {
      await Promise.race([handle.wait, timeout("child streams did not close")]);
      assert.match(stdout, new RegExp(marker));
    } finally {
      if (handle.pid !== undefined) {
        try {
          process.kill(-handle.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  },
);

describe("appendBounded", () => {
  it("keeps a tail when over max", () => {
    const out = appendBounded("abcdef", "ghij", 8);
    assert.equal(out.length, 8);
    assert.equal(out, "cdefghij");
  });
});

describe("extractPiLastAssistantText", () => {
  it("reads last assistant text from jsonl", () => {
    const stdout = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
        },
      }),
    ].join("\n");
    assert.equal(extractPiLastAssistantText(stdout), "final answer");
  });
});

describe("extractCodexLastMessage", () => {
  it("prefers last-message file contents", () => {
    assert.equal(extractCodexLastMessage("", "from file"), "from file");
  });

  it("parses last_agent_message from jsonl", () => {
    const stdout = JSON.stringify({ type: "turn.completed", last_agent_message: "done" });
    assert.equal(extractCodexLastMessage(stdout), "done");
  });
});

describe("normalizeCodexModelId", () => {
  it("strips openai-codex provider prefix", () => {
    assert.equal(normalizeCodexModelId("openai-codex/gpt-5.6-sol"), "gpt-5.6-sol");
  });

  it("leaves bare model ids unchanged", () => {
    assert.equal(normalizeCodexModelId("gpt-5.6-sol"), "gpt-5.6-sol");
  });

  it("returns undefined for empty", () => {
    assert.equal(normalizeCodexModelId(undefined), undefined);
    assert.equal(normalizeCodexModelId("  "), undefined);
  });
});
