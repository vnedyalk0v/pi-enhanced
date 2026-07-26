import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { formatElapsed, formatExit, type SubagentSnapshot } from "./domain.ts";

export function describeSubagent(snap: SubagentSnapshot) {
  const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
  const exit = formatExit(snap);
  const model = snap.model ? ` model=${snap.model}` : "";
  const think = snap.thinking ? ` thinking=${snap.thinking}` : "";
  const pid = snap.pid !== undefined ? ` pid=${snap.pid}` : "";
  return `${snap.id} [${snap.status}] ${snap.backend} "${snap.title}" (${exit}, ${elapsed}${pid})${model}${think}`;
}

export function buildSpawnResult(snap: SubagentSnapshot) {
  return [
    `Started subagent ${snap.id} (${snap.backend}) "${snap.title}".`,
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
      const head = describeSubagent(s);
      if (s.resultText) return `${head}\n${truncateForModel(s.resultText)}`;
      if (s.errorText) return `${head}\nerror: ${s.errorText}`;
      return head;
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

export function buildCompletionMessage(snap: SubagentSnapshot) {
  const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
  const exit = formatExit(snap);
  const verb =
    snap.status === "done" ? "finished" : snap.status === "killed" ? "was cancelled" : "failed";
  const lines = [
    `Subagent ${snap.id} (${snap.backend}) "${snap.title}" ${verb} (${exit}) after ${elapsed}.`,
    `prompt: ${truncateOneLine(snap.prompt, 200)}`,
  ];
  if (snap.errorText) lines.push(`error: ${snap.errorText}`);
  if (snap.resultText) {
    lines.push("", "--- result ---", truncateForModel(snap.resultText));
  }
  return lines.join("\n");
}

function truncateOneLine(s: string, max: number) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

function truncateForModel(text: string) {
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

export const TOOL_LIMITS_NOTE =
  `Results truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`;
