import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

function extractText(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as ContentBlock;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text);
    }
    if (block.type === "toolCall" && typeof block.name === "string") {
      parts.push(`[tool ${block.name}]`);
    }
  }
  return parts;
}

function buildConversationText(
  entries: Array<{ type: string; message?: { role?: string; content?: unknown } }>,
): string {
  const sections: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const body = extractText(entry.message.content).join("\n").trim();
    if (!body) continue;
    sections.push(`${role === "user" ? "User" : "Assistant"}:\n${body}`);
  }
  return sections.join("\n\n");
}

function buildPrompt(conversationText: string): string {
  return [
    "Summarize this coding-agent conversation so it can be resumed later.",
    "Include: goal, key decisions, progress, open questions, next steps.",
    "Use short markdown headings. Be concise.",
    "",
    "<conversation>",
    conversationText,
    "</conversation>",
  ].join("\n");
}

async function showSummary(summary: string, ctx: ExtensionCommandContext) {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(summary.slice(0, 200) + (summary.length > 200 ? "…" : ""), "info");
    return;
  }

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const mdTheme = getMarkdownTheme();
    container.addChild(border);
    container.addChild(new Text(theme.fg("accent", theme.bold("Session summary")), 1, 0));
    container.addChild(new Markdown(summary, 1, 1, mdTheme));
    container.addChild(new Text(theme.fg("dim", "Enter or Esc to close"), 1, 0));
    container.addChild(border);
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("summary", {
    description: "Summarize the current conversation with the active model",
    handler: async (_args, ctx) => {
      const conversationText = buildConversationText(ctx.sessionManager.getBranch());
      if (!conversationText.trim()) {
        if (ctx.hasUI) ctx.ui.notify("No conversation to summarize", "warning");
        return;
      }

      const model = ctx.model;
      if (!model) {
        if (ctx.hasUI) ctx.ui.notify("No model selected", "error");
        return;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        if (ctx.hasUI) {
          ctx.ui.notify(auth.ok ? "No API key for current model" : auth.error, "error");
        }
        return;
      }

      if (ctx.hasUI) ctx.ui.notify("Summarizing…", "info");

      try {
        const response = await complete(
          model,
          {
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: buildPrompt(conversationText) }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            cacheRetention: "none",
            sessionId: uuidv7(),
          },
        );

        const summary = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
          .trim();

        if (!summary) {
          if (ctx.hasUI) ctx.ui.notify("Empty summary response", "warning");
          return;
        }

        await showSummary(summary, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`Summary failed: ${message}`, "error");
      }
    },
  });
}
