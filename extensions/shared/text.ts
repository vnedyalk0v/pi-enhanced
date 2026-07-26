import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

export const TOOL_LIMITS_NOTE =
  `Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`;

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

export function truncateForModel(text: string, options?: { mode?: "head" | "tail" }) {
  const mode = options?.mode ?? "tail";
  const truncation =
    mode === "head"
      ? truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
      : truncateTail(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!truncation.truncated) return truncation.content || "(empty)";
  const where = mode === "head" ? "first" : "last";
  return (
    truncation.content +
    `\n\n[truncated: ${where} ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}]`
  );
}

export function tailText(s: string, n: number) {
  return s.length <= n ? s : s.slice(s.length - n);
}

export function formatExit(snap: {
  status: string;
  signal?: string;
  exitCode?: number;
  errorText?: string;
}) {
  if (snap.status === "running") return "running";
  if (snap.signal) return snap.signal;
  if (snap.exitCode !== undefined) return `exit ${snap.exitCode}`;
  if (snap.errorText) return "error";
  return snap.status;
}

/** Flatten message content blocks (string or text parts) to a single string. */
export function contentToText(content: unknown): string {
  return extractBlocks(content).join("\n").trim();
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
