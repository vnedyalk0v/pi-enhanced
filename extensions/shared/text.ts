import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

export function formatTokens(n: number) {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function truncateOneLine(s: string, max: number) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

export function truncateForModel(text: string) {
  const truncation = truncateTail(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return truncation.content || "(empty)";
  return (
    truncation.content +
    `\n\n[truncated: last ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}]`
  );
}

export function tailText(s: string, n: number) {
  return s.length <= n ? s : s.slice(s.length - n);
}

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
};

export function extractConversationText(
  entries: Array<{ type: string; message?: { role?: string; content?: unknown } }>,
  options?: { includeToolCalls?: boolean },
) {
  const sections: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const body = extractBlocks(entry.message.content, options?.includeToolCalls).join("\n").trim();
    if (!body) continue;
    sections.push(`${role === "user" ? "User" : "Assistant"}:\n${body}`);
  }
  return sections.join("\n\n");
}

function extractBlocks(content: unknown, includeToolCalls?: boolean) {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as ContentBlock;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text);
    }
    if (includeToolCalls && block.type === "toolCall" && typeof block.name === "string") {
      parts.push(`[tool ${block.name}]`);
    }
  }
  return parts;
}
