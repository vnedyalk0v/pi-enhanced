import { truncateTail } from "@earendil-works/pi-coding-agent";
import { formatElapsed } from "../shared/time.ts";
import {
  contentToText,
  formatExit,
  formatTruncationNotice,
  truncateForModel,
  truncateOneLine,
  UNTRUSTED_CONTENT_NOTICE,
} from "../shared/text.ts";
import type { SubagentSnapshot } from "./domain.ts";

const BTW_TAIL_MAX_BYTES = 2048;
const BTW_TAIL_MAX_LINES = 24;

/**
 * Small bounded tail for the /btw answer: enough to act on without a
 * follow-up status call, small enough to inject freely.
 */
function completionTail(text: string) {
  const truncation = truncateTail(text, {
    maxLines: BTW_TAIL_MAX_LINES,
    maxBytes: BTW_TAIL_MAX_BYTES,
  });
  if (!truncation.truncated) return truncation.content || "(empty)";
  return (
    truncation.content +
    `\n${formatTruncationNotice("tail", truncation.outputBytes, truncation.totalBytes)}`
  );
}

/**
 * Readable progress from a running worker's raw output tail. The child speaks
 * `--mode json` JSONL, so the tail is protocol noise; pull out the assistant
 * text and tool activity a human watching /sa actually wants. The leading
 * line is usually a partial record (the tail is cut from the front) and just
 * fails to parse.
 */
export function summarizeOutputTail(tail: string) {
  const lines: string[] = [];
  for (const raw of tail.split("\n")) {
    if (!raw.trim()) continue;
    let event: { type?: string; toolName?: string; message?: { role?: string; content?: unknown } };
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
      lines.push(`[${event.toolName}]`);
      continue;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = contentToText(event.message.content);
      if (text) lines.push(text);
    }
  }
  return lines.join("\n");
}

export function describeSubagent(snap: SubagentSnapshot) {
  const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
  const exit = formatExit(snap);
  const agent = snap.agent ? ` agent=${snap.agent}` : "";
  const model = snap.model ? ` model=${snap.model}` : "";
  const think = snap.thinking ? ` thinking=${snap.thinking}` : "";
  const pid = snap.pid !== undefined ? ` pid=${snap.pid}` : "";
  return `${snap.id} [${snap.status}] "${snap.title}" (${exit}, ${elapsed}${pid})${agent}${model}${think}`;
}

export function buildSpawnResult(snap: SubagentSnapshot) {
  return [
    `Started subagent ${snap.id}${snap.agent ? ` (${snap.agent})` : ""} "${snap.title}".`,
    `cwd: ${snap.cwd}`,
    snap.model ? `model: ${snap.model}` : undefined,
    snap.thinking ? `thinking/effort: ${snap.thinking}` : undefined,
    "It runs in the background. You'll get a message when it finishes, or use",
    `sa_status / sa_wait / sa_cancel with id "${snap.id}".`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildStatusResult(snap: SubagentSnapshot) {
  const lines = [
    describeSubagent(snap),
    UNTRUSTED_CONTENT_NOTICE,
    `prompt: ${truncateOneLine(snap.prompt, 200)}`,
    `cwd: ${snap.cwd}`,
  ];
  if (snap.errorText) lines.push(`error: ${snap.errorText}`);
  if (snap.resultText) {
    lines.push("", "--- result ---", truncateForModel(snap.resultText));
  } else if (snap.outputTail) {
    lines.push("", "--- output tail ---", truncateForModel(snap.outputTail));
  }
  return lines.join("\n");
}

export function buildListResult(snaps: SubagentSnapshot[]) {
  if (snaps.length === 0) return "No subagents.";
  return snaps.map(describeSubagent).join("\n");
}

export function buildWaitResult(snaps: SubagentSnapshot[]) {
  return snaps
    .map((s) => {
      const lines = [describeSubagent(s)];
      if (s.errorText || s.resultText) lines.push(UNTRUSTED_CONTENT_NOTICE);
      if (s.errorText) lines.push(`error: ${s.errorText}`);
      if (s.resultText) lines.push(truncateForModel(s.resultText));
      return lines.join("\n");
    })
    .join("\n\n");
}

export function buildCancelResult(snaps: SubagentSnapshot[]) {
  return snaps
    .map((s) => {
      if (s.status === "killed") return `Cancelled ${s.id} "${s.title}".`;
      return `${s.id} "${s.title}" was already ${s.status} (${formatExit(s)}).`;
    })
    .join("\n");
}

/**
 * /btw completions go straight to the user, so lead with the answer instead
 * of retrieval instructions. Deliberate exception to the metadata-only rule
 * for automatic completions: the user explicitly solicited this answer, and
 * the host delivers it only while the agent is idle (held during streaming),
 * so it never starts or steers a model turn; the model reads it, banner
 * first, on the next turn the user starts.
 */
export function buildBtwAnswer(snap: SubagentSnapshot) {
  const failed = snap.status !== "done";
  const header = failed
    ? `Side task ${snap.id} "${snap.title}" ${snap.status === "killed" ? "was cancelled" : "failed"} (${formatExit(snap)}).`
    : `Side task ${snap.id} "${snap.title}":`;
  const body = snap.resultText || snap.errorText || snap.outputTail;
  return [header, UNTRUSTED_CONTENT_NOTICE, completionTail(body || "(no output)")].join("\n");
}

// Automatic completions stay metadata-only: child output must never enter
// model context unsolicited (see "keeps automatic completion metadata-only"
// tests). /btw is the one exception — see buildBtwAnswer.
export function buildCompletionMessage(snap: SubagentSnapshot) {
  const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
  const exit = formatExit(snap);
  const verb =
    snap.status === "done" ? "finished" : snap.status === "killed" ? "was cancelled" : "failed";
  const lines = [
    `Subagent ${snap.id}${snap.agent ? ` (${snap.agent})` : ""} "${snap.title}" ${verb} (${exit}) after ${elapsed}.`,
    `Use sa_status(id: "${snap.id}") or sa_wait(ids: ["${snap.id}"]) to retrieve result/output.`,
  ];
  if (snap.errorText) lines.splice(1, 0, "error: available");
  return lines.join("\n");
}
