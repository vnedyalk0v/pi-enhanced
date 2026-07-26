import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { formatSize } from "@earendil-works/pi-coding-agent";
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
  private cachedLines?: string[];

  constructor(
    private manager: TerminalManager,
    private theme: Theme,
    private onClose: () => void,
    private requestRender: () => void,
  ) {
    this.refresh();
    this.unsub = manager.subscribe(() => {
      this.refresh();
      this.invalidate();
      this.requestRender();
    });
  }

  dispose() {
    this.unsub?.();
  }

  private refresh() {
    this.snapshots = this.manager.list();
    if (this.mode.kind === "list") {
      if (this.selected >= this.snapshots.length) {
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
    this.cachedLines = undefined;
  }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.mode.kind === "detail") {
        this.mode = { kind: "list" };
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
      this.selected = Math.min(this.snapshots.length - 1, this.selected + 1);
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
      if (!snap || snap.status !== "running") return;
      void this.manager.kill([snap.id]).then(() => {
        this.refresh();
        this.invalidate();
        this.requestRender();
      });
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
      const id = this.mode.id;
      const snap = this.manager.get(id);
      if (!snap || snap.status !== "running") return;
      void this.manager.kill([id]).then(() => {
        this.refresh();
        this.invalidate();
        this.requestRender();
      });
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const lines =
      this.mode.kind === "list" ? this.renderList(width) : this.renderDetail(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderList(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    lines.push("");
    const title = th.fg("accent", " Background terminals ");
    lines.push(
      truncateToWidth(
        th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 28))),
        width,
      ),
    );
    lines.push("");

    if (this.snapshots.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No background terminals.")}`, width));
    } else {
      this.snapshots.forEach((snap, i) => {
        const marker = i === this.selected ? th.fg("accent", "›") : " ";
        const status = statusColor(th, snap);
        const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
        const exit = formatExit(snap);
        const body = `${snap.id} ${status} "${snap.title}" ${th.fg("dim", `(${exit}, ${elapsed})`)}`;
        lines.push(truncateToWidth(`  ${marker} ${body}`, width));
      });
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

  private renderDetail(width: number): string[] {
    const th = this.theme;
    if (this.mode.kind !== "detail") return [];
    const snap = this.manager.get(this.mode.id);
    if (!snap) return [th.fg("dim", "  Terminal gone.")];

    const stream = this.mode.stream === "stdout" ? snap.stdout : snap.stderr;
    const lines: string[] = [];
    lines.push("");
    const title = th.fg("accent", ` ${snap.id} "${snap.title}" `);
    lines.push(
      truncateToWidth(
        th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - title.length))),
        width,
      ),
    );
    lines.push(
      truncateToWidth(
        `  ${statusColor(th, snap)}  ${formatExit(snap)}  ${formatElapsed(snap.createdAt, snap.settledAt)}` +
          (snap.pid !== undefined ? `  pid ${snap.pid}` : ""),
        width,
      ),
    );
    lines.push(truncateToWidth(`  ${th.fg("dim", snap.command)}`, width));
    lines.push(truncateToWidth(`  ${th.fg("dim", snap.cwd)}`, width));
    if (snap.errorText) {
      lines.push(truncateToWidth(`  ${th.fg("error", snap.errorText)}`, width));
    }

    const streamLabel = this.mode.stream.toUpperCase();
    const sizeNote =
      stream.truncatedBytes > 0
        ? ` (viewing tail; ${formatSize(stream.truncatedBytes)} dropped; full: ${stream.spillPath ?? "n/a"})`
        : ` (${formatSize(stream.totalBytes)})`;
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("accent", streamLabel)}${th.fg("dim", sizeNote)}`, width));
    lines.push(th.fg("borderMuted", "─".repeat(Math.min(width, 40))));

    const content = stream.text || "(empty)";
    const contentLines = content.split("\n");
    const headerLines = 10;
    const maxBody = Math.max(5, 30 - headerLines);
    const maxScroll = Math.max(0, contentLines.length - maxBody);
    const scroll = Math.min(this.mode.scroll, maxScroll);
    if (scroll !== this.mode.scroll) {
      this.mode = { ...this.mode, scroll };
    }
    const slice = contentLines.slice(scroll, scroll + maxBody);
    for (const line of slice) {
      lines.push(truncateToWidth(`  ${line}`, width));
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
