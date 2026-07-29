import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractConversationText } from "./text.ts";

describe("extractConversationText", () => {
  it("leaves short and empty conversations unchanged", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "hello" } },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ];
    const expected = "User:\nhello\n\nAssistant:\nhi";

    assert.equal(extractConversationText(entries), expected);
    assert.equal(extractConversationText(entries, { maxChars: expected.length }), expected);
    assert.equal(extractConversationText([], { maxChars: 100 }), "");
  });

  it("retains early and larger recent context within the requested limit", () => {
    const maxChars = 180;
    const text = extractConversationText(
      [
        {
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "toolCall", name: "read" },
              { type: "text", text: `early-goal-${"a".repeat(100)}` },
            ],
          },
        },
        {
          type: "message",
          message: { role: "assistant", content: `middle-${"m".repeat(300)}` },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: `${"z".repeat(100)}-recent-state` },
              { type: "toolCall", name: "write" },
            ],
          },
        },
      ],
      { includeToolCalls: true, maxChars },
    );

    assert.equal(text.length, maxChars);
    assert.ok(text.startsWith("User:\n[tool read]\nearly-goal-"));
    assert.ok(text.includes("[... conversation middle omitted ...]"));
    assert.ok(text.endsWith("-recent-state\n[tool write]"));
    const [head, tail] = text.split("\n\n[... conversation middle omitted ...]\n\n");
    assert.ok(head);
    assert.ok(tail);
    assert.ok(tail.length > head.length);
  });
});
