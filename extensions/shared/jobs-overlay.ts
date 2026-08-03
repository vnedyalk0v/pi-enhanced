import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { terminalText } from "./terminal-text.ts";

/**
 * Visible slice of `count` rows that keeps `selected` on screen: the list can
 * hold far more jobs (32 tracked) than a terminal has rows, and selection
 * moves through all of them. Returns the slice bounds plus hidden counts so
 * the caller can show "N more" affordances.
 */
export function windowAround(count: number, selected: number, maxRows: number) {
  if (count <= maxRows) return { start: 0, end: count, before: 0, after: 0 };
  const half = Math.floor(maxRows / 2);
  const start = Math.min(Math.max(0, selected - half), count - maxRows);
  const end = start + maxRows;
  return { start, end, before: start, after: count - end };
}

export type JobsOverlayConfig<S extends { id: string }> = {
  /** Overlay title, e.g. "Subagents". */
  title: string;
  list: () => S[];
  /** Subscribe to manager changes; returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** One-line list row body (already themed); overlay adds marker and truncation. */
  renderRow: (snap: S, theme: Theme) => string;
  /** Themed header lines for the detail view (status, ids, paths, ...). */
  detailHeader: (snap: S, theme: Theme) => string[];
  /** Scrollable plain-text detail body (result, output, phase tree, ...). */
  detailBody: (snap: S) => string;
  canCancel: (snap: S) => boolean;
  /** Called synchronously once cancellation is accepted, before termination waits. */
  onCancelRequested?: (snap: S) => void;
  cancel: (id: string) => Promise<unknown>;
};

type Mode = { kind: "list" } | { kind: "detail"; id: string; scroll: number };

const MIN_BODY_LINES = 5;
const MIN_LIST_ROWS = 3;
const FALLBACK_ROWS = 30;

/**
 * Generic list/detail overlay for job managers (subagents, workflows):
 * up/down select, enter opens detail, x cancels, esc goes back/closes.
 */
export class JobsOverlay<S extends { id: string }> {
  private mode: Mode = { kind: "list" };
  private selected = 0;
  private snapshots: S[] = [];
  private unsub?: () => void;
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: string[];
  private wrappedBodyCache?: { id: string; width: number; lines: string[] };
  private cancelling = new Set<string>();
  private disposed = false;
  private config: JobsOverlayConfig<S>;
  private theme: Theme;
  private onClose: () => void;
  private requestRender: () => void;
  private getRows?: () => number;

  constructor(
    config: JobsOverlayConfig<S>,
    theme: Theme,
    onClose: () => void,
    requestRender: () => void,
    /** Current terminal height in rows; used to size the detail body. */
    getRows?: () => number,
  ) {
    this.config = config;
    this.theme = theme;
    this.onClose = onClose;
    this.requestRender = requestRender;
    this.getRows = getRows;
    this.refresh();
    this.unsub = config.subscribe(() => {
      this.refresh();
      this.invalidate();
      this.requestRender();
    });
  }

  dispose() {
    this.disposed = true;
    this.cancelling.clear();
    this.wrappedBodyCache = undefined;
    // Both the Esc path and TUI teardown call this; unsubscribe exactly once.
    const unsub = this.unsub;
    this.unsub = undefined;
    unsub?.();
  }

  private refresh() {
    this.snapshots = this.config.list();
    this.wrappedBodyCache = undefined;
    if (this.mode.kind === "list") {
      if (this.selected < 0 || this.selected >= this.snapshots.length) {
        this.selected = Math.max(0, this.snapshots.length - 1);
      }
      return;
    }
    const detailId = this.mode.id;
    if (!this.snapshots.some((s) => s.id === detailId)) {
      this.mode = { kind: "list" };
    }
  }

  private invalidate() {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  private rerender() {
    if (this.disposed) return;
    this.invalidate();
    this.requestRender();
  }

  handleInput(data: string) {
    if (this.disposed) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.mode.kind === "detail") {
        this.mode = { kind: "list" };
        this.wrappedBodyCache = undefined;
        this.rerender();
        return;
      }
      this.dispose();
      this.onClose();
      return;
    }
    if (this.mode.kind === "list") this.handleListInput(data);
    else this.handleDetailInput(data);
  }

  private cancelJob(id: string) {
    const snap = this.snapshots.find((s) => s.id === id);
    if (!snap || !this.config.canCancel(snap) || this.cancelling.has(id)) return;
    this.cancelling.add(id);
    let cancellation: Promise<unknown>;
    try {
      cancellation = this.config.cancel(id);
    } catch {
      this.cancelling.delete(id);
      return;
    }
    try {
      this.config.onCancelRequested?.(snap);
    } catch {
      // A stale model-notification callback must not block cancellation.
    }
    void cancellation
      .then(() => {
        // Cancellation can settle after the overlay closed.
        if (this.disposed) return;
        this.refresh();
        this.rerender();
      })
      .catch(() => {
        // Manager disposed mid-shutdown; the overlay is going away anyway.
      })
      .finally(() => this.cancelling.delete(id));
  }

  private handleListInput(data: string) {
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.selected = Math.max(0, this.selected - 1);
      this.rerender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.selected = Math.min(Math.max(0, this.snapshots.length - 1), this.selected + 1);
      this.rerender();
      return;
    }
    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const snap = this.snapshots[this.selected];
      if (!snap) return;
      this.mode = { kind: "detail", id: snap.id, scroll: 0 };
      this.rerender();
      return;
    }
    if (data === "x" || data === "X") {
      const snap = this.snapshots[this.selected];
      if (snap) this.cancelJob(snap.id);
    }
  }

  private handleDetailInput(data: string) {
    if (this.mode.kind !== "detail") return;
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.mode = { ...this.mode, scroll: Math.max(0, this.mode.scroll - 1) };
      this.rerender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.mode = { ...this.mode, scroll: this.mode.scroll + 1 };
      this.rerender();
      return;
    }
    if (data === "x" || data === "X") {
      this.cancelJob(this.mode.id);
    }
  }

  render(width: number): string[] {
    const rows = this.getRows?.() ?? FALLBACK_ROWS;
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

  private titleRule(width: number, text: string) {
    const th = this.theme;
    const titleText = ` ${text} `;
    return truncateToWidth(
      th.fg("borderMuted", "─".repeat(3)) +
        th.fg("accent", titleText) +
        // Rule length uses the plain text, not the ANSI-styled string.
        th.fg("borderMuted", "─".repeat(Math.max(0, width - 3 - titleText.length))),
      width,
    );
  }

  private renderList(width: number, rows: number): string[] {
    const th = this.theme;
    const lines: string[] = [""];
    lines.push(this.titleRule(width, this.config.title));
    lines.push("");

    if (this.snapshots.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", `No ${this.config.title.toLowerCase()}.`)}`, width));
    } else {
      // Chrome: blank, rule, blank above; blank, hint, blank below, plus the
      // two "N more" markers the window itself may add.
      const maxRows = Math.max(MIN_LIST_ROWS, rows - 8);
      const win = windowAround(this.snapshots.length, this.selected, maxRows);
      if (win.before > 0) {
        lines.push(truncateToWidth(`  ${th.fg("dim", `↑ ${win.before} more`)}`, width));
      }
      for (let i = win.start; i < win.end; i++) {
        const snap = this.snapshots[i]!;
        const marker = i === this.selected ? th.fg("accent", "›") : " ";
        lines.push(truncateToWidth(`  ${marker} ${this.config.renderRow(snap, th)}`, width));
      }
      if (win.after > 0) {
        lines.push(truncateToWidth(`  ${th.fg("dim", `↓ ${win.after} more`)}`, width));
      }
    }

    lines.push("");
    lines.push(
      truncateToWidth(`  ${th.fg("dim", "↑/↓ select  Enter detail  x cancel  Esc close")}`, width),
    );
    lines.push("");
    return lines;
  }

  private renderDetail(width: number, rows: number): string[] {
    const th = this.theme;
    const mode = this.mode;
    if (mode.kind !== "detail") return [];
    const snap = this.snapshots.find((s) => s.id === mode.id);
    if (!snap) return [th.fg("dim", "  Job gone.")];

    const lines: string[] = [""];
    lines.push(this.titleRule(width, snap.id));
    for (const header of this.config.detailHeader(snap, th)) {
      lines.push(truncateToWidth(`  ${header}`, width));
    }
    lines.push(th.fg("borderMuted", "─".repeat(Math.min(width, 40))));

    // Results are prose: a long paragraph is one logical line, so wrap to the
    // body width instead of truncating everything past the right edge away.
    // Keep the wrapped rows across scroll renders; manager refreshes clear the
    // cache when the underlying snapshot can have changed.
    const bodyWidth = Math.max(1, width - 2);
    const cachedBody = this.wrappedBodyCache;
    let contentLines =
      cachedBody?.id === snap.id && cachedBody.width === bodyWidth
        ? cachedBody.lines
        : undefined;
    if (!contentLines) {
      contentLines = [];
      for (const raw of this.config.detailBody(snap).split("\n")) {
        const line = terminalText(raw);
        if (!line) {
          contentLines.push("");
          continue;
        }
        contentLines.push(...wrapTextWithAnsi(line, bodyWidth));
      }
      this.wrappedBodyCache = { id: snap.id, width: bodyWidth, lines: contentLines };
    }

    const headerLines = lines.length + 3;
    const maxBody = Math.max(MIN_BODY_LINES, rows - headerLines);
    const maxScroll = Math.max(0, contentLines.length - maxBody);
    const scroll = Math.min(mode.scroll, maxScroll);
    if (scroll !== mode.scroll) this.mode = { ...mode, scroll };
    for (const line of contentLines.slice(scroll, scroll + maxBody)) {
      lines.push(truncateToWidth(`  ${line}`, width));
    }

    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "↑/↓ scroll  x cancel  Esc back")}`, width));
    lines.push("");
    return lines;
  }
}
