import { formatSize, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { windowAround } from "../shared/jobs-overlay.ts";
import { stripTerminalControlStrings, terminalText } from "../shared/terminal-text.ts";
import { formatExit } from "../shared/text.ts";
import { formatElapsed } from "../shared/time.ts";
import type { TerminalManager, TerminalSnapshot } from "./manager.ts";

type Mode = { kind: "list" } | { kind: "detail"; id: string; scroll: number; stream: "stdout" | "stderr" };

/**
 * Interactive /ps overlay: list terminals, open detail, kill running ones.
 */
export class PsOverlay {
  private mode: Mode = { kind: "list" };
  private selected = 0;
  private snapshots: TerminalSnapshot[] = [];
  private unsub?: () => void;
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: string[];
  private streamLinesCache?: { id: string; stream: "stdout" | "stderr"; lines: string[] };
  private terminating = new Set<string>();
  private disposed = false;
  private manager: TerminalManager;
  private theme: Theme;
  private onClose: () => void;
  private requestRender: () => void;
  private getRows?: () => number;
  private onKillRequested?: (snap: TerminalSnapshot) => void;

  constructor(
    manager: TerminalManager,
    theme: Theme,
    onClose: () => void,
    requestRender: () => void,
    options?: {
      /** Current terminal height in rows; used to size the detail body. */
      getRows?: () => number;
      /** Called synchronously when the user requests a kill, before termination waits. */
      onKillRequested?: (snap: TerminalSnapshot) => void;
    },
  ) {
    this.manager = manager;
    this.theme = theme;
    this.onClose = onClose;
    this.requestRender = requestRender;
    this.getRows = options?.getRows;
    this.onKillRequested = options?.onKillRequested;
    this.refresh();
    this.unsub = manager.subscribe(() => {
      this.refresh();
      this.invalidate();
      this.requestRender();
    });
  }

  dispose() {
    this.disposed = true;
    this.terminating.clear();
    this.streamLinesCache = undefined;
    // Both the Esc path and TUI teardown call this; unsubscribe exactly once.
    const unsub = this.unsub;
    this.unsub = undefined;
    unsub?.();
  }

  private refresh() {
    this.snapshots = this.manager.list();
    this.streamLinesCache = undefined;
    if (this.mode.kind === "list") {
      if (this.selected < 0 || this.selected >= this.snapshots.length) {
        this.selected = Math.max(0, this.snapshots.length - 1);
      }
      return;
    }
    const detailId = this.mode.id;
    const still = this.snapshots.some((s) => s.id === detailId);
    if (!still) {
      this.mode = { kind: "list" };
    }
  }

  private invalidate() {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  private killTerminal(id: string) {
    const snap = this.manager.get(id);
    if (!snap || snap.status !== "running" || this.terminating.has(id)) return;
    this.terminating.add(id);
    let termination: ReturnType<TerminalManager["kill"]>;
    try {
      termination = this.manager.kill([id]);
    } catch {
      this.terminating.delete(id);
      return;
    }
    try {
      this.onKillRequested?.(snap);
    } catch {
      // A stale model-notification callback must not block termination.
    }
    void termination
      .then(() => {
        // Termination can settle after the overlay closed.
        if (this.disposed) return;
        this.refresh();
        this.invalidate();
        this.requestRender();
      })
      .catch(() => {
        // Manager disposed mid-shutdown; the overlay is going away anyway.
      })
      .finally(() => this.terminating.delete(id));
  }

  handleInput(data: string) {
    if (this.disposed) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.mode.kind === "detail") {
        this.mode = { kind: "list" };
        this.streamLinesCache = undefined;
        this.invalidate();
        this.requestRender();
        return;
      }
      this.dispose();
      this.onClose();
      return;
    }

    if (this.mode.kind === "list") {
      this.handleListInput(data);
    } else {
      this.handleDetailInput(data);
    }
  }

  private handleListInput(data: string) {
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.selected = Math.max(0, this.selected - 1);
      this.invalidate();
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.selected = Math.min(Math.max(0, this.snapshots.length - 1), this.selected + 1);
      this.invalidate();
      this.requestRender();
      return;
    }
    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const snap = this.snapshots[this.selected];
      if (!snap) return;
      this.mode = { kind: "detail", id: snap.id, scroll: 0, stream: "stdout" };
      this.invalidate();
      this.requestRender();
      return;
    }
    if (data === "x" || data === "X") {
      const snap = this.snapshots[this.selected];
      if (snap) this.killTerminal(snap.id);
    }
  }

  private handleDetailInput(data: string) {
    if (this.mode.kind !== "detail") return;
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.mode = { ...this.mode, scroll: Math.max(0, this.mode.scroll - 1) };
      this.invalidate();
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.mode = { ...this.mode, scroll: this.mode.scroll + 1 };
      this.invalidate();
      this.requestRender();
      return;
    }
    if (data === "t" || data === "T") {
      this.mode = {
        ...this.mode,
        stream: this.mode.stream === "stdout" ? "stderr" : "stdout",
        scroll: 0,
      };
      this.invalidate();
      this.requestRender();
      return;
    }
    if (data === "x" || data === "X") {
      this.killTerminal(this.mode.id);
    }
  }

  render(width: number): string[] {
    const rows = this.getRows?.() ?? 30;
    if (this.cachedLines && this.cachedWidth === width && this.cachedRows === rows) {
      return this.cachedLines;
    }
    const lines =
      this.mode.kind === "list" ? this.renderList(width, rows) : this.renderDetail(width, rows);
    this.cachedWidth = width;
    this.cachedRows = rows;
    this.cachedLines = lines;
    return lines;
  }

  private renderList(width: number, rows: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    lines.push("");
    const titleText = " Background terminals ";
    const title = th.fg("accent", titleText);
    lines.push(
      truncateToWidth(
        th.fg("borderMuted", "─".repeat(3)) +
          title +
          // Rule length uses the plain text, not the ANSI-styled string.
          th.fg("borderMuted", "─".repeat(Math.max(0, width - 3 - titleText.length))),
        width,
      ),
    );
    lines.push("");

    if (this.snapshots.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No background terminals.")}`, width));
    } else {
      // Up to 32 terminals are tracked; keep the selected row on screen.
      const win = windowAround(this.snapshots.length, this.selected, Math.max(3, rows - 8));
      if (win.before > 0) {
        lines.push(truncateToWidth(`  ${th.fg("dim", `↑ ${win.before} more`)}`, width));
      }
      for (let i = win.start; i < win.end; i++) {
        const snap = this.snapshots[i]!;
        const marker = i === this.selected ? th.fg("accent", "›") : " ";
        const status = statusColor(th, snap);
        const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
        // Settled rows show the exit reason; running rows would repeat "running".
        const detail = snap.status === "running" ? elapsed : `${formatExit(snap)}, ${elapsed}`;
        const body = `${snap.id} ${status} "${terminalText(snap.title)}" ${th.fg("dim", `(${detail})`)}`;
        lines.push(truncateToWidth(`  ${marker} ${body}`, width));
      }
      if (win.after > 0) {
        lines.push(truncateToWidth(`  ${th.fg("dim", `↓ ${win.after} more`)}`, width));
      }
    }

    lines.push("");
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", "↑/↓ select  Enter detail  x kill  Esc close")}`,
        width,
      ),
    );
    lines.push("");
    return lines;
  }

  private renderDetail(width: number, rows: number): string[] {
    const th = this.theme;
    if (this.mode.kind !== "detail") return [];
    const snap = this.manager.get(this.mode.id);
    if (!snap) return [th.fg("dim", "  Terminal gone.")];

    const stream = this.mode.stream === "stdout" ? snap.stdout : snap.stderr;
    const lines: string[] = [];
    lines.push("");
    const titleText = ` ${snap.id} "${terminalText(snap.title)}" `;
    const title = th.fg("accent", titleText);
    lines.push(
      truncateToWidth(
        th.fg("borderMuted", "─".repeat(3)) +
          title +
          // Rule length uses the plain text, not the ANSI-styled string.
          th.fg("borderMuted", "─".repeat(Math.max(0, width - 3 - titleText.length))),
        width,
      ),
    );
    lines.push(
      truncateToWidth(
        `  ${statusColor(th, snap)}` +
          // Settled terminals show the exit reason; running would repeat "running".
          (snap.status === "running" ? "" : `  ${formatExit(snap)}`) +
          `  ${formatElapsed(snap.createdAt, snap.settledAt)}` +
          (snap.pid !== undefined ? `  pid ${snap.pid}` : ""),
        width,
      ),
    );
    lines.push(truncateToWidth(`  ${th.fg("dim", terminalText(snap.command))}`, width));
    lines.push(truncateToWidth(`  ${th.fg("dim", terminalText(snap.cwd))}`, width));
    if (snap.errorText) {
      lines.push(truncateToWidth(`  ${th.fg("error", terminalText(snap.errorText))}`, width));
    }

    const streamLabel = this.mode.stream.toUpperCase();
    const spill = stream.spillPath
      ? `${stream.spillTruncatedBytes > 0 ? "partial" : "full"}: ${terminalText(stream.spillPath)}`
      : stream.spillTruncatedBytes > 0
        ? "partial spill unavailable"
        : "spill unavailable";
    const sizeNote =
      stream.truncatedBytes > 0
        ? ` (viewing tail; ${formatSize(stream.truncatedBytes)} dropped; ${spill})`
        : stream.spillTruncatedBytes > 0
          ? ` (${formatSize(stream.totalBytes)}; ${spill})`
          : ` (${formatSize(stream.totalBytes)})`;
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("accent", streamLabel)}${th.fg("dim", sizeNote)}`, width));
    lines.push(th.fg("borderMuted", "─".repeat(Math.min(width, 40))));

    let contentLines =
      this.streamLinesCache?.id === snap.id && this.streamLinesCache.stream === this.mode.stream
        ? this.streamLinesCache.lines
        : undefined;
    if (!contentLines) {
      contentLines = stripTerminalControlStrings(stream.text || "(empty)").split("\n");
      this.streamLinesCache = { id: snap.id, stream: this.mode.stream, lines: contentLines };
    }
    // Header lines already emitted plus the footer hint block below.
    const headerLines = lines.length + 3;
    const maxBody = Math.max(5, rows - headerLines);
    const maxScroll = Math.max(0, contentLines.length - maxBody);
    const scroll = Math.min(this.mode.scroll, maxScroll);
    if (scroll !== this.mode.scroll) {
      this.mode = { ...this.mode, scroll };
    }
    const slice = contentLines.slice(scroll, scroll + maxBody);
    for (const line of slice) {
      lines.push(truncateToWidth(`  ${terminalText(line)}`, width));
    }

    lines.push("");
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", "↑/↓ scroll  t toggle stdout/stderr  x kill  Esc back")}`,
        width,
      ),
    );
    lines.push("");
    return lines;
  }
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
