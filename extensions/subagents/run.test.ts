import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendBounded,
  extractCodexLastMessage,
  extractPiLastAssistantText,
} from "./run.ts";

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
