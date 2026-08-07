import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { abortPromise, formatElapsed, sleep, WaitAbortedError } from "./time.ts";

describe("formatElapsed", () => {
  it("renders seconds under a minute", () => {
    assert.equal(formatElapsed(0, 45_000), "45s");
    assert.equal(formatElapsed(0, 0), "0s");
    assert.equal(formatElapsed(0, 59_999), "59s");
  });

  it("renders minutes and seconds under an hour", () => {
    assert.equal(formatElapsed(0, 90_000), "1m30s");
    assert.equal(formatElapsed(0, 60_000), "1m0s");
    assert.equal(formatElapsed(0, 3_599_000), "59m59s");
  });

  it("renders hours and minutes", () => {
    assert.equal(formatElapsed(0, 3_600_000), "1h0m");
    assert.equal(formatElapsed(0, 3_900_000), "1h5m");
  });

  it("clamps a settledAt before createdAt to zero", () => {
    assert.equal(formatElapsed(10_000, 5_000), "0s");
  });

  it("falls back to now when settledAt is omitted", () => {
    assert.equal(formatElapsed(Date.now()), "0s");
  });
});

describe("abortPromise", () => {
  it("never settles without a signal", async () => {
    const result = await Promise.race([abortPromise(undefined, "x"), Promise.resolve("sentinel")]);
    assert.equal(result, "sentinel");
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(abortPromise(controller.signal, "boom"), (error) => {
      assert.ok(error instanceof WaitAbortedError);
      assert.equal(error.message, "boom");
      assert.equal(error.name, "WaitAbortedError");
      return true;
    });
  });

  it("rejects when the signal aborts later", async () => {
    const controller = new AbortController();
    const promise = abortPromise(controller.signal, "boom");
    controller.abort();
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof WaitAbortedError);
      assert.equal(error.message, "boom");
      assert.equal(error.name, "WaitAbortedError");
      return true;
    });
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    await sleep(5);
  });

  it("rejects when its signal aborts", async () => {
    const controller = new AbortController();
    const promise = sleep(10_000, controller.signal);
    controller.abort();
    await assert.rejects(promise);
  });
});
