import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";

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
  }
  return parts;
}

function formatBranch(entries: Array<{ type: string; message?: { role?: string; content?: unknown } }>): string {
  const sections: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(entry.message.content).join("\n").trim();
    if (!text) continue;
    sections.push(`${role === "user" ? "User" : "Assistant"}:\n${text}`);
  }
  return sections.join("\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-all", {
    description: "Copy the full conversation branch to the clipboard",
    handler: async (_args, ctx) => {
      const text = formatBranch(ctx.sessionManager.getBranch());
      if (!text.trim()) {
        if (ctx.hasUI) ctx.ui.notify("Nothing to copy", "warning");
        return;
      }
      try {
        await copyToClipboard(text);
        if (ctx.hasUI) {
          const chars = text.length;
          ctx.ui.notify(`Copied conversation (${chars} chars)`, "info");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`Copy failed: ${message}`, "error");
      }
    },
  });
}
