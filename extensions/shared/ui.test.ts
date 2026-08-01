import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isUsable, withUI } from "./ui.ts";

describe("safe extension UI context", () => {
  it("rejects a missing context", () => {
    assert.equal(isUsable(undefined), false);
    assert.equal(withUI(undefined, () => assert.fail("should not run")), false);
  });

  it("runs a UI effect with a healthy context", () => {
    const ctx = { hasUI: true } as ExtensionContext;
    let called = false;

    assert.equal(isUsable(ctx), true);
    assert.equal(
      withUI(ctx, () => {
        called = true;
      }),
      true,
    );
    assert.equal(called, true);
  });

  it("swallows stale context access", () => {
    const ctx = {
      get hasUI() {
        throw new Error("stale");
      },
    } as unknown as ExtensionContext;

    assert.equal(isUsable(ctx), false);
    assert.equal(withUI(ctx, () => assert.fail("should not run")), false);
  });
});
