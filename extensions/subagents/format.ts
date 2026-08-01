import { formatElapsed } from "../shared/time.ts";
import {
  formatExit,
  truncateForModel,
  truncateOneLine,
  UNTRUSTED_CONTENT_NOTICE,
} from "../shared/text.ts";
import type { SubagentSnapshot } from "./domain.ts";

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
