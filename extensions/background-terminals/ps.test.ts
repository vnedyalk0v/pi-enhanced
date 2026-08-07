import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { JobsOverlay } from "../shared/jobs-overlay.ts";
import type { TerminalManager, TerminalSnapshot } from "./manager.ts";
import { terminalOverlayConfig } from "./ps.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function snapshot(index: number, onTextRead: () => void): TerminalSnapshot {
  const output = {
    get text() {
      onTextRead();
      return "first\nsecond\nthird";
    },
    totalBytes: 18,
    truncatedBytes: 0,
    spillTruncatedBytes: 0,
  };
  return {
    id: `bt-${index}`,
    command: "sleep 10",
    title: `terminal ${index}`,
    cwd: process.cwd(),
    status: "running",
    createdAt: Date.now(),
    stdout: output,
    stderr: output,
  };
}

function makeHarness(count = 1, initialRows = 30, requestThrows = false) {
  let streamTextReads = 0;
  const snapshots = Array.from({ length: count }, (_, index) =>
    snapshot(index + 1, () => streamTextReads++),
  );
  let rows = initialRows;
  let renders = 0;
  let closes = 0;
  const events: string[] = [];
  let finishKill!: () => void;
  const kill = new Promise<void>((resolve) => {
    finishKill = resolve;
  });
  const manager = {
    list: () => snapshots,
    get: (id: string) => snapshots.find((snap) => snap.id === id),
    subscribe: () => () => {},
    kill: async (ids: string[]) => {
      events.push(`kill:${ids.join(",")}`);
      await kill;
      return [];
    },
  } as unknown as TerminalManager;
  const overlay = new JobsOverlay<TerminalSnapshot>(
    terminalOverlayConfig(manager, (snap) => {
      events.push(`requested:${snap.id}`);
      if (requestThrows) throw new Error("stale notification context");
    }),
    theme,
    () => closes++,
    () => renders++,
    () => rows,
  );

  return {
    overlay,
    events,
    finishKill,
    setRows: (next: number) => {
      rows = next;
    },
    get renders() {
      return renders;
    },
    get closes() {
      return closes;
    },
    get streamTextReads() {
      return streamTextReads;
    },
  };
}

describe("terminal overlay (/ps)", () => {
  it("invalidates the viewport cache when terminal height changes", () => {
    const h = makeHarness(32, 30);
    const tall = h.overlay.render(60);
    h.setRows(12);
    const short = h.overlay.render(60);

    assert.ok(short.length < tall.length);
    assert.ok(short.length <= 12, `rendered ${short.length} lines into 12 rows`);
  });

  it("caches processed stream lines across scrolling", () => {
    const h = makeHarness();
    h.overlay.handleInput("\r");
    h.overlay.render(60);
    for (let i = 0; i < 10; i++) {
      h.overlay.handleInput("j");
      h.overlay.render(60);
    }
    assert.equal(h.streamTextReads, 1);

    h.overlay.handleInput("t");
    h.overlay.render(60);
    assert.equal(h.streamTextReads, 2);
  });

  it("still starts termination when the request notification throws", () => {
    const h = makeHarness(1, 30, true);
    h.overlay.handleInput("x");
    assert.deepEqual(h.events, ["kill:bt-1", "requested:bt-1"]);
  });

  it("deduplicates a kill request before termination settles after close", async () => {
    const h = makeHarness();
    h.overlay.handleInput("x");
    h.overlay.handleInput("x");
    assert.deepEqual(h.events, ["kill:bt-1", "requested:bt-1"]);

    h.overlay.handleInput("\x1b");
    assert.equal(h.closes, 1);
    const afterClose = h.renders;
    h.overlay.handleInput("x");
    h.overlay.handleInput("j");
    assert.deepEqual(h.events, ["kill:bt-1", "requested:bt-1"]);
    assert.equal(h.renders, afterClose);
    h.finishKill();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.renders, afterClose);
  });
});
