import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { terminalText } from "./terminal-text.ts";

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
  cancel: (id: string) => Promise<unknown>;
};

type Mode = { kind: "list" } | { kind: "detail"; id: string; scroll: number };

const MIN_BODY_LINES = 5;
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
  private cachedLines?: string[];
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
    this.unsub?.();
  }

  private refresh() {
    this.snapshots = this.config.list();
    if (this.mode.kind === "list") {
      if (this.selected >= this.snapshots.length) {
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
    this.cachedLines = undefined;
  }

  private rerender() {
    this.invalidate();
    this.requestRender();
  }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.mode.kind === "detail") {
        this.mode = { kind: "list" };
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
    if (!snap || !this.config.canCancel(snap)) return;
    void this.config
      .cancel(id)
      .then(() => {
        this.refresh();
        this.rerender();
      })
      .catch(() => {
        // Manager disposed mid-shutdown; the overlay is going away anyway.
      });
  }

  private handleListInput(data: string) {
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.selected = Math.max(0, this.selected - 1);
      this.rerender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.selected = Math.min(this.snapshots.length - 1, this.selected + 1);
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
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines = this.mode.kind === "list" ? this.renderList(width) : this.renderDetail(width);
    this.cachedWidth = width;
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

  private renderList(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [""];
    lines.push(this.titleRule(width, this.config.title));
    lines.push("");

    if (this.snapshots.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", `No ${this.config.title.toLowerCase()}.`)}`, width));
    } else {
      this.snapshots.forEach((snap, i) => {
        const marker = i === this.selected ? th.fg("accent", "›") : " ";
        lines.push(truncateToWidth(`  ${marker} ${this.config.renderRow(snap, th)}`, width));
      });
    }

    lines.push("");
    lines.push(
      truncateToWidth(`  ${th.fg("dim", "↑/↓ select  Enter detail  x cancel  Esc close")}`, width),
    );
    lines.push("");
    return lines;
  }

  private renderDetail(width: number): string[] {
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

    const contentLines = this.config.detailBody(snap).split("\n");
    const headerLines = lines.length + 3;
    const rows = this.getRows?.() ?? FALLBACK_ROWS;
    const maxBody = Math.max(MIN_BODY_LINES, rows - headerLines);
    const maxScroll = Math.max(0, contentLines.length - maxBody);
    const scroll = Math.min(mode.scroll, maxScroll);
    if (scroll !== mode.scroll) this.mode = { ...mode, scroll };
    for (const line of contentLines.slice(scroll, scroll + maxBody)) {
      lines.push(truncateToWidth(`  ${terminalText(line)}`, width));
    }

    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "↑/↓ scroll  x cancel  Esc back")}`, width));
    lines.push("");
    return lines;
  }
}
