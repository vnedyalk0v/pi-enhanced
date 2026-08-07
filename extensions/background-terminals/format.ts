import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { formatExit, UNTRUSTED_CONTENT_NOTICE } from "../shared/text.ts";
import { formatElapsed } from "../shared/time.ts";
import type { TerminalSnapshot } from "./manager.ts";

export function describeTerminal(snap: TerminalSnapshot) {
  const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
  const exit = formatExit(snap);
  const out = formatSize(snap.stdout.totalBytes);
  const err = formatSize(snap.stderr.totalBytes);
  const pid = snap.pid !== undefined ? ` pid=${snap.pid}` : "";
  return `${snap.id} [${snap.status}] "${snap.title}" (${exit}, ${elapsed}${pid}) cwd=${snap.cwd} stdout=${out} stderr=${err}`;
}

export function buildStartResult(snap: TerminalSnapshot) {
  const pid = snap.pid !== undefined ? `pid ${snap.pid}` : "no pid yet";
  return [
    `Started background terminal ${snap.id} "${snap.title}" (${pid}, ${snap.cwd}).`,
    "It runs in the background with no stdin. You'll get a message when it exits, or use",
    `bg_status(id: "${snap.id}") to peek, bg_kill to stop it, bg_list to see all.`,
  ].join("\n");
}

export function buildStatusResult(snap: TerminalSnapshot) {
  const lines = [
    describeTerminal(snap),
    UNTRUSTED_CONTENT_NOTICE,
    `command: ${snap.command}`,
  ];
  if (snap.errorText) {
    lines.push(`error: ${snap.errorText}`);
  }
  lines.push("", "--- stdout (tail) ---", formatStreamTail(snap.stdout));
  lines.push("", "--- stderr (tail) ---", formatStreamTail(snap.stderr));
  return lines.join("\n");
}

export function buildListResult(snaps: TerminalSnapshot[]) {
  if (snaps.length === 0) return "No background terminals.";
  return snaps.map(describeTerminal).join("\n");
}

export function buildKillResult(results: Array<{ id: string; snapshot: TerminalSnapshot; alreadySettled: boolean }>) {
  return results
    .map((r) => {
      const snap = r.snapshot;
      if (r.alreadySettled && snap.status !== "killed") {
        return `${snap.id} "${snap.title}" was already ${snap.status} (${formatExit(snap)}).`;
      }
      return `Killed ${snap.id} "${snap.title}" (${formatExit(snap)}).`;
    })
    .join("\n");
}

// Automatic completions stay metadata-only: child output must never enter
// model context unsolicited (see "keeps automatic completion metadata-only"
// tests). The model retrieves output explicitly via bg_status.
export function buildTerminalResultMessage(snap: TerminalSnapshot) {
  const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
  const exit = formatExit(snap);
  const header = `Background terminal ${snap.id} "${snap.title}" ${statusVerb(snap)} (${exit}) after ${elapsed}.`;
  const lines = [header];
  if (snap.errorText) lines.push("error: available");
  lines.push(`Use bg_status(id: "${snap.id}") to retrieve output.`);
  return lines.join("\n");
}

function statusVerb(snap: TerminalSnapshot) {
  switch (snap.status) {
    case "done":
      return "exited";
    case "failed":
      return "failed";
    case "killed":
      return "was stopped";
    default:
      return "settled";
  }
}

function formatStreamTail(stream: TerminalSnapshot["stdout"]) {
  if (stream.totalBytes === 0) return "(empty)";

  const truncation = truncateTail(stream.text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let text = truncation.content || "(empty)";
  if (truncation.truncated || stream.truncatedBytes > 0) {
    text +=
      `\n\n[truncated: showing last ${formatSize(truncation.outputBytes)} of ${formatSize(stream.totalBytes)}.` +
      " Older output is not retained; redirect the command to a file to keep it all]";
  }
  return text;
}
