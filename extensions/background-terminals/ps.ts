import { formatSize, type Theme } from "@earendil-works/pi-coding-agent";
import type { JobsOverlayConfig } from "../shared/jobs-overlay.ts";
import { stripTerminalControlStrings, terminalText } from "../shared/terminal-text.ts";
import { formatExit } from "../shared/text.ts";
import { formatElapsed } from "../shared/time.ts";
import type { TerminalManager, TerminalSnapshot } from "./manager.ts";

const STREAMS = ["stdout", "stderr"] as const;

function streamOf(snap: TerminalSnapshot, mode: string) {
  return mode === "stderr" ? snap.stderr : snap.stdout;
}

function streamSizeNote(stream: TerminalSnapshot["stdout"]) {
  const spill = stream.spillPath
    ? `${stream.spillTruncatedBytes > 0 ? "partial" : "full"}: ${terminalText(stream.spillPath)}`
    : stream.spillTruncatedBytes > 0
      ? "partial spill unavailable"
      : "spill unavailable";
  if (stream.truncatedBytes > 0) {
    return ` (viewing tail; ${formatSize(stream.truncatedBytes)} dropped; ${spill})`;
  }
  if (stream.spillTruncatedBytes > 0) {
    return ` (${formatSize(stream.totalBytes)}; ${spill})`;
  }
  return ` (${formatSize(stream.totalBytes)})`;
}

/**
 * `/ps` viewer config. Detail snapshots come from `manager.get` because
 * `manager.list` omits stream text — materializing two retained tails per row
 * on every refresh costs far more than the list needs.
 */
export function terminalOverlayConfig(
  manager: TerminalManager,
  onKillRequested?: (snap: TerminalSnapshot) => void,
): JobsOverlayConfig<TerminalSnapshot> {
  return {
    title: "Background terminals",
    list: () => manager.list(),
    getDetail: (id) => manager.get(id),
    subscribe: (listener) => manager.subscribe(listener),
    renderRow: (snap, th) => {
      const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
      // Settled rows show the exit reason; running rows would repeat "running".
      const detail = snap.status === "running" ? elapsed : `${formatExit(snap)}, ${elapsed}`;
      return `${snap.id} ${statusColor(th, snap)} "${terminalText(snap.title)}" ${th.fg("dim", `(${detail})`)}`;
    },
    detailTitle: (snap) => ` "${terminalText(snap.title)}"`,
    detailModes: STREAMS,
    detailHeader: (snap, th, mode) => {
      const lines = [
        `${statusColor(th, snap)}` +
          (snap.status === "running" ? "" : `  ${formatExit(snap)}`) +
          `  ${formatElapsed(snap.createdAt, snap.settledAt)}` +
          (snap.pid !== undefined ? `  pid ${snap.pid}` : ""),
        th.fg("dim", terminalText(snap.command)),
        th.fg("dim", terminalText(snap.cwd)),
      ];
      if (snap.errorText) lines.push(th.fg("error", terminalText(snap.errorText)));
      lines.push("");
      lines.push(
        th.fg("accent", mode.toUpperCase()) +
          th.fg("dim", streamSizeNote(streamOf(snap, mode))),
      );
      return lines;
    },
    // Terminal output is already laid out in columns; truncate, never rewrap.
    detailBody: (snap, mode) => stripTerminalControlStrings(streamOf(snap, mode).text || "(empty)"),
    wrapBody: false,
    canCancel: (snap) => snap.status === "running",
    cancelLabel: "kill",
    onCancelRequested: onKillRequested,
    cancel: (id) => manager.kill([id]),
  };
}

function statusColor(th: Theme, snap: TerminalSnapshot) {
  switch (snap.status) {
    case "running":
      return th.fg("success", "running");
    case "done":
      return th.fg("muted", "done");
    case "failed":
      return th.fg("error", "failed");
    case "killed":
      return th.fg("warning", "killed");
  }
}
