import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isWithin } from "./index.ts";

describe("isWithin", () => {
  it("is true for the same directory", () => {
    assert.equal(isWithin("/repo", "/repo"), true);
  });

  it("is true for a nested subdirectory", () => {
    assert.equal(isWithin("/repo", join("/repo", "src", "nested")), true);
  });

  it("is false for a sibling directory with a shared prefix", () => {
    assert.equal(isWithin("/repo", "/repo-other"), false);
  });

  it("is false for a parent or unrelated directory", () => {
    assert.equal(isWithin("/repo/src", "/repo"), false);
    assert.equal(isWithin("/repo", "/elsewhere"), false);
  });
});
