import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyHttpError, classifyThrown } from "./errors.ts";

describe("classifyHttpError", () => {
  it("detects 402 as quota", () => {
    const c = classifyHttpError(402, JSON.stringify({ error: "Payment required" }));
    assert.equal(c.kind, "quota");
    assert.equal(c.fallbackEligible, true);
  });

  it("detects insufficient credits in body as quota", () => {
    const c = classifyHttpError(403, JSON.stringify({ error: "Insufficient credits" }));
    assert.equal(c.kind, "quota");
    assert.equal(c.fallbackEligible, true);
  });

  it("detects 401 as auth", () => {
    const c = classifyHttpError(401, JSON.stringify({ error: "Unauthorized" }));
    assert.equal(c.kind, "auth");
    assert.equal(c.fallbackEligible, false);
  });

  it("detects 429 as rate_limit (not quota)", () => {
    const c = classifyHttpError(429, JSON.stringify({ error: "Too many requests" }));
    assert.equal(c.kind, "rate_limit");
    assert.equal(c.fallbackEligible, false);
  });

  it("keeps a 429 with quota wording as rate_limit (no fallback)", () => {
    const c = classifyHttpError(
      429,
      JSON.stringify({ error: "Rate limit exceeded. Please upgrade your plan." }),
    );
    assert.equal(c.kind, "rate_limit");
    assert.equal(c.fallbackEligible, false);
  });

  it("detects 400 as bad_request", () => {
    const c = classifyHttpError(400, JSON.stringify({ error: "Invalid query" }));
    assert.equal(c.kind, "bad_request");
    assert.equal(c.fallbackEligible, false);
  });

  it("detects 500 as transient", () => {
    const c = classifyHttpError(500, JSON.stringify({ error: "boom" }));
    assert.equal(c.kind, "transient");
    assert.equal(c.fallbackEligible, false);
  });
});

describe("classifyThrown", () => {
  it("matches quota phrasing", () => {
    const c = classifyThrown(new Error("You are out of credits on free plan"));
    assert.equal(c.kind, "quota");
    assert.equal(c.fallbackEligible, true);
  });
});
