import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { JobsOverlay, windowAround, type JobsOverlayConfig } from "./jobs-overlay.ts";

type Snap = { id: string; label: string; running: boolean };

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function makeHarness(options?: { snapshots?: Snap[]; rows?: number }) {
  let snapshots = options?.snapshots ?? [{ id: "j-1", label: "first", running: true }];
  const listeners = new Set<() => void>();
  let unsubscribeCalls = 0;
  let renderRequests = 0;
  let closes = 0;
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
    detailBody: (snap) => snap.label,
    canCancel: (snap) => snap.running,
    cancel: (id) => {
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
    () => options?.rows ?? 30,
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

  it("does not render after a late cancel settles post-disposal", async () => {
    const h = makeHarness();
    h.overlay.handleInput("x");
    assert.deepEqual(h.cancelled, ["j-1"]);

    h.overlay.dispose();
    const afterDispose = h.renderRequests;
    await h.finishCancel();
    assert.equal(h.renderRequests, afterDispose);
  });

  it("only cancels jobs the config allows", () => {
    const h = makeHarness({ snapshots: [{ id: "j-1", label: "done", running: false }] });
    h.overlay.handleInput("x");
    assert.deepEqual(h.cancelled, []);
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
