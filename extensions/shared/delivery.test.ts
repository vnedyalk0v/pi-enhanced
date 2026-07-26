import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ResultDelivery } from "./delivery.ts";

describe("ResultDelivery", () => {
  it("enqueues, consumes, and drains once", () => {
    const d = new ResultDelivery<string>();
    d.enqueue("a", "one");
    d.enqueue("b", "two");
    d.consume(["b"]);
    const all = d.drainAll();
    assert.deepEqual(all, [{ id: "a", value: "one" }]);
    assert.equal(d.drainAll().length, 0);
  });

  it("clear drops pending", () => {
    const d = new ResultDelivery<number>();
    d.enqueue("x", 1);
    d.clear();
    assert.equal(d.drainAll().length, 0);
  });
});
