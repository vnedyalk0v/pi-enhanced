import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { JobsOverlay, windowAround, type JobsOverlayConfig } from "./jobs-overlay.ts";

type Snap = { id: string; label: string; running: boolean };

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function makeHarness(options?: { snapshots?: Snap[]; rows?: number; requestThrows?: boolean }) {
  let snapshots = options?.snapshots ?? [{ id: "j-1", label: "first", running: true }];
  let rows = options?.rows ?? 30;
  const listeners = new Set<() => void>();
  let unsubscribeCalls = 0;
  let renderRequests = 0;
  let closes = 0;
  let detailBodyCalls = 0;
  const events: string[] = [];
  const cancelled: string[] = [];
  let resolveCancel: (() => void) | undefined;

  const config: JobsOverlayConfig<Snap> = {
    title: "Jobs",
    list: () => snapshots,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        unsubscribeCalls++;
        listeners.delete(listener);
      };
    },
    renderRow: (snap) => `${snap.id} ${snap.label}`,
    detailHeader: (snap) => [`${snap.id} header`],
    detailBody: (snap) => {
      detailBodyCalls++;
      return snap.label;
    },
    canCancel: (snap) => snap.running,
    onCancelRequested: (snap) => {
      events.push(`requested:${snap.id}`);
      if (options?.requestThrows) throw new Error("stale notification context");
    },
    cancel: (id) => {
      events.push(`cancel:${id}`);
      cancelled.push(id);
      return new Promise<void>((resolve) => {
        resolveCancel = resolve;
      });
    },
  };

  const overlay = new JobsOverlay<Snap>(
    config,
    theme,
    () => closes++,
    () => renderRequests++,
    () => rows,
  );

  return {
    overlay,
    get listenerCount() {
      return listeners.size;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    get renderRequests() {
      return renderRequests;
    },
    get closes() {
      return closes;
    },
    get detailBodyCalls() {
      return detailBodyCalls;
    },
    events,
    cancelled,
    notify: () => {
      for (const listener of [...listeners]) listener();
    },
    finishCancel: async () => {
      resolveCancel?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    setSnapshots: (next: Snap[]) => {
      snapshots = next;
    },
    setRows: (next: number) => {
      rows = next;
    },
  };
}

const ESC = "\x1b";

describe("windowAround", () => {
  it("returns everything when it fits", () => {
    assert.deepEqual(windowAround(3, 0, 10), { start: 0, end: 3, before: 0, after: 0 });
  });

  it("keeps the selection visible near the start, middle, and end", () => {
    assert.deepEqual(windowAround(32, 0, 6), { start: 0, end: 6, before: 0, after: 26 });

    const middle = windowAround(32, 16, 6);
    assert.ok(middle.start <= 16 && 16 < middle.end);
    assert.equal(middle.end - middle.start, 6);

    const last = windowAround(32, 31, 6);
    assert.deepEqual(last, { start: 26, end: 32, before: 26, after: 0 });
  });
});

describe("JobsOverlay lifecycle", () => {
  it("unsubscribes exactly once on close and ignores repeated disposal", () => {
    const h = makeHarness();
    assert.equal(h.listenerCount, 1);

    h.overlay.handleInput(ESC);
    assert.equal(h.closes, 1);
    assert.equal(h.unsubscribeCalls, 1);
    assert.equal(h.listenerCount, 0);

    // TUI teardown calls dispose() after the close path already ran.
    h.overlay.dispose();
    assert.equal(h.unsubscribeCalls, 1);
  });

  it("stops requesting renders once disposed", () => {
    const h = makeHarness();
    h.notify();
    const afterLive = h.renderRequests;
    assert.ok(afterLive > 0);

    h.overlay.dispose();
    h.notify();
    assert.equal(h.renderRequests, afterLive);
  });

  it("records cancellation before a late cancel settles after close", async () => {
    const h = makeHarness();
    h.overlay.handleInput("x");
    assert.deepEqual(h.events, ["cancel:j-1", "requested:j-1"]);
    assert.deepEqual(h.cancelled, ["j-1"]);

    h.overlay.handleInput(ESC);
    const afterClose = h.renderRequests;
    h.overlay.handleInput("x");
    h.overlay.handleInput("j");
    assert.deepEqual(h.events, ["cancel:j-1", "requested:j-1"]);
    assert.equal(h.renderRequests, afterClose);
    await h.finishCancel();
    assert.equal(h.renderRequests, afterClose);
  });

  it("deduplicates cancellation while termination is pending", async () => {
    const h = makeHarness();
    h.overlay.handleInput("x");
    h.overlay.handleInput("x");
    assert.deepEqual(h.events, ["cancel:j-1", "requested:j-1"]);
    assert.deepEqual(h.cancelled, ["j-1"]);
    await h.finishCancel();
  });

  it("still cancels when the request notification throws", () => {
    const h = makeHarness({ requestThrows: true });
    h.overlay.handleInput("x");
    assert.deepEqual(h.cancelled, ["j-1"]);
  });

  it("only cancels jobs the config allows", () => {
    const h = makeHarness({ snapshots: [{ id: "j-1", label: "done", running: false }] });
    h.overlay.handleInput("x");
    assert.deepEqual(h.cancelled, []);
  });

  it("keeps selection at zero when a job appears after an empty-list Down", () => {
    const h = makeHarness({ snapshots: [] });
    h.overlay.handleInput("j");
    h.setSnapshots([{ id: "j-1", label: "first", running: true }]);
    h.notify();

    assert.match(h.overlay.render(60).join("\n"), /› j-1 first/);
    h.overlay.handleInput("\r");
    assert.match(h.overlay.render(60).join("\n"), /j-1 header/);
  });

  it("falls back to the list when the detailed job disappears", () => {
    const h = makeHarness();
    h.overlay.handleInput("\r");
    assert.match(h.overlay.render(60).join("\n"), /j-1 header/);

    h.setSnapshots([]);
    h.notify();
    const rendered = h.overlay.render(60).join("\n");
    assert.match(rendered, /No jobs\./);
    assert.doesNotMatch(rendered, /j-1 header/);
  });
});

describe("JobsOverlay rendering", () => {
  it("invalidates the viewport cache when terminal height changes", () => {
    const snapshots = Array.from({ length: 32 }, (_, i) => ({
      id: `j-${i}`,
      label: `job ${i}`,
      running: true,
    }));
    const h = makeHarness({ snapshots, rows: 30 });

    const tall = h.overlay.render(60);
    h.setRows(12);
    const short = h.overlay.render(60);

    assert.ok(short.length < tall.length);
    assert.ok(short.length <= 12, `rendered ${short.length} lines into 12 rows`);
  });

  it("windows a long list and marks the hidden rows", () => {
    const snapshots = Array.from({ length: 32 }, (_, i) => ({
      id: `j-${i}`,
      label: `job ${i}`,
      running: true,
    }));
    const h = makeHarness({ snapshots, rows: 24 });

    const rendered = h.overlay.render(60);
    const body = rendered.join("\n");
    assert.ok(rendered.length <= 24, `rendered ${rendered.length} lines into 24 rows`);
    assert.match(body, /› j-0 job 0/);
    assert.match(body, /↓ \d+ more/);
  });

  it("sanitizes terminal controls in detail body lines", () => {
    const h = makeHarness({
      snapshots: [{ id: "j-1", label: "visible\n\x1b[31mred\x1b[0m", running: false }],
    });
    h.overlay.handleInput("\r");

    const rendered = h.overlay.render(60).join("\n");
    assert.doesNotMatch(rendered, /\x1b\[31m/);
    assert.match(rendered, /visible/);
    assert.match(rendered, /red/);
  });

  it("wraps long prose instead of cutting it at the right edge", () => {
    const paragraph = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const h = makeHarness({
      snapshots: [{ id: "j-1", label: paragraph, running: false }],
      rows: 40,
    });
    h.overlay.handleInput("\r");

    const body = h.overlay.render(40).join("\n");
    assert.match(body, /word0/);
    // The tail of the paragraph survives on a wrapped row rather than being cut.
    assert.match(body, /word39/);
  });

  it("caches wrapped detail rows across scrolling", () => {
    const paragraph = Array.from({ length: 2_000 }, (_, i) => `word${i}`).join(" ");
    const h = makeHarness({
      snapshots: [{ id: "j-1", label: paragraph, running: false }],
      rows: 20,
    });
    h.overlay.handleInput("\r");

    h.overlay.render(40);
    for (let i = 0; i < 20; i++) {
      h.overlay.handleInput("j");
      h.overlay.render(40);
    }
    assert.equal(h.detailBodyCalls, 1);

    h.overlay.render(50);
    assert.equal(h.detailBodyCalls, 2);
    h.notify();
    h.overlay.render(50);
    assert.equal(h.detailBodyCalls, 3);
  });

  it("scrolls wrapped content instead of losing it", () => {
    const paragraph = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const h = makeHarness({
      snapshots: [{ id: "j-1", label: paragraph, running: false }],
      rows: 20,
    });
    h.overlay.handleInput("\r");

    const first = h.overlay.render(40).join("\n");
    assert.doesNotMatch(first, /word199/);

    for (let i = 0; i < 100; i++) h.overlay.handleInput("j");
    assert.match(h.overlay.render(40).join("\n"), /word199/);
  });
});
