import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InterestTracker, pruneSettled } from "./lifecycle.ts";

describe("InterestTracker", () => {
  it("tracks overlapping interest by refcount", () => {
    const t = new InterestTracker();
    assert.equal(t.has("a"), false);
    t.add("a");
    t.add("a");
    assert.equal(t.has("a"), true);
    t.release("a");
    assert.equal(t.has("a"), true);
    t.release("a");
    assert.equal(t.has("a"), false);
  });

  it("release never goes negative", () => {
    const t = new InterestTracker();
    t.release("a");
    t.add("a");
    assert.equal(t.has("a"), true);
  });

  it("clear drops all interest", () => {
    const t = new InterestTracker();
    t.add("a");
    t.add("b");
    t.clear();
    assert.equal(t.has("a"), false);
    assert.equal(t.has("b"), false);
  });
});

describe("pruneSettled", () => {
  type E = { id: string; status: string; settledAt?: number };

  it("evicts the oldest settled entries beyond maxTracked", () => {
    const entries = new Map<string, E>([
      ["a", { id: "a", status: "done", settledAt: 1 }],
      ["b", { id: "b", status: "done", settledAt: 2 }],
      ["c", { id: "c", status: "done", settledAt: 3 }],
    ]);
    pruneSettled(entries, 2, (e) => e.status === "running");
    assert.deepEqual([...entries.keys()], ["b", "c"]);
  });

  it("never evicts running entries even past the cap", () => {
    const entries = new Map<string, E>([
      ["a", { id: "a", status: "running" }],
      ["b", { id: "b", status: "running" }],
      ["c", { id: "c", status: "done", settledAt: 1 }],
    ]);
    pruneSettled(entries, 0, (e) => e.status === "running");
    assert.deepEqual([...entries.keys()].sort(), ["a", "b"]);
  });

  it("calls onEvict for each removed entry", () => {
    const entries = new Map<string, E>([
      ["a", { id: "a", status: "done", settledAt: 1 }],
      ["b", { id: "b", status: "done", settledAt: 2 }],
    ]);
    const evicted: string[] = [];
    pruneSettled(entries, 1, (e) => e.status === "running", (e) => evicted.push(e.id));
    assert.deepEqual(evicted, ["a"]);
  });
});
