import assert from "node:assert/strict";
import { it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import summaries, { registerSummaryCommand, SUMMARY_PROMPT_MAX_CHARS } from "./index.ts";

const model = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_384,
  maxTokens: 4_096,
} satisfies Model<"openai-completions">;

function summaryResponse(text = "Summary") {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

it("bounds the conversation before sending the summary prompt", async () => {
  assert.equal(summaries.length, 1);
  let handler: RegisteredCommand["handler"] | undefined;
  let prompt = "";
  const pi = {
    registerCommand(name, command) {
      assert.equal(name, "summary");
      handler = command.handler;
    },
  } satisfies Pick<ExtensionAPI, "registerCommand">;

  registerSummaryCommand(pi as ExtensionAPI, async (_model, context) => {
    const message = context.messages[0];
    assert.equal(message?.role, "user");
    assert.ok(message && Array.isArray(message.content));
    const content = message.content[0];
    assert.equal(content?.type, "text");
    if (content?.type === "text") prompt = content.text;

    return summaryResponse();
  });
  assert.ok(handler);

  const notices: string[] = [];
  const ctx = {
    mode: "print",
    hasUI: false,
    model,
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "toolCall", name: "read" },
              { type: "text", text: `early-goal-${"a".repeat(30_000)}` },
            ],
          },
        },
        {
          type: "message",
          message: { role: "assistant", content: `middle-${"m".repeat(30_000)}` },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: `${"z".repeat(30_000)}-recent-state` },
              { type: "toolCall", name: "write" },
            ],
          },
        },
      ],
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    ui: {
      notify: (message: string) => notices.push(message),
    },
  } as unknown as ExtensionCommandContext;

  await handler("", ctx);

  assert.equal(prompt.length, SUMMARY_PROMPT_MAX_CHARS);
  assert.ok(prompt.includes("[tool read]"));
  assert.ok(prompt.includes("[... conversation middle omitted ...]"));
  assert.ok(prompt.includes("[tool write]"));
  assert.deepEqual(notices, ["Summary"]);
});

async function runTuiSummary(
  key: string,
  copySummary: (text: string) => Promise<void>,
) {
  let handler: RegisteredCommand["handler"] | undefined;
  const pi = {
    registerCommand(_name, command) {
      handler = command.handler;
    },
  } satisfies Pick<ExtensionAPI, "registerCommand">;
  registerSummaryCommand(pi as ExtensionAPI, async () => summaryResponse(), copySummary);
  assert.ok(handler);

  const notices: Array<{ message: string; level: string }> = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    model,
    sessionManager: {
      getBranch: () => [{ type: "message", message: { role: "user", content: "summarize" } }],
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      custom: async (
        factory: (
          tui: unknown,
          theme: { fg: (_color: string, text: string) => string; bold: (text: string) => string },
          keybindings: unknown,
          done: (value: boolean) => void,
        ) => { handleInput?: (data: string) => void },
      ) =>
        new Promise<boolean>((resolve) => {
          const component = factory(
            {},
            { fg: (_color, text) => text, bold: (text) => text },
            {},
            resolve,
          );
          component.handleInput?.(key);
        }),
    },
  } as unknown as ExtensionCommandContext;

  await handler("", ctx);
  return notices;
}

it("closes the TUI summary without copying on Enter or Escape", async () => {
  for (const key of ["\r", "\x1b"]) {
    let copies = 0;
    const notices = await runTuiSummary(key, async () => {
      copies++;
    });
    assert.equal(copies, 0);
    assert.deepEqual(notices, [{ message: "Summarizing…", level: "info" }]);
  }
});

it("copies the TUI summary for lowercase and uppercase c", async () => {
  for (const key of ["c", "C"]) {
    const copied: string[] = [];
    const notices = await runTuiSummary(key, async (text) => {
      copied.push(text);
    });
    assert.deepEqual(copied, ["Summary"]);
    assert.deepEqual(notices.at(-1), {
      message: "Summary copied (7 chars)",
      level: "info",
    });
  }
});

it("reports clipboard failures from the TUI summary", async () => {
  const notices = await runTuiSummary("c", async () => {
    throw new Error("clipboard unavailable");
  });
  assert.deepEqual(notices.at(-1), {
    message: "Copy failed: clipboard unavailable",
    level: "error",
  });
});
