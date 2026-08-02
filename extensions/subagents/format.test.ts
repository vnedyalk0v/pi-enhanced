import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SubagentSnapshot } from "./domain.ts";
import { buildBtwAnswer, truncateAtWord } from "./format.ts";
import { modelPatternMatchesRegistry } from "./index.ts";

function snapshot(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
  return {
    id: "sa-1",
    title: "btw: question",
    prompt: "question",
    cwd: "/tmp/project",
    status: "done",
    createdAt: 0,
    settledAt: 1000,
    exitCode: 0,
    outputTail: "",
    ...overrides,
  };
}

describe("truncateAtWord", () => {
  it("keeps short strings untouched", () => {
    assert.equal(truncateAtWord("short question", 40), "short question");
  });

  it("cuts at a word boundary with an ellipsis", () => {
    const result = truncateAtWord("what is the capital of France? Answer in one word.", 40);
    assert.equal(result, "what is the capital of France? Answer…");
  });

  it("falls back to a hard cut when there is no usable space", () => {
    const result = truncateAtWord("a".repeat(60), 40);
    assert.equal(result, `${"a".repeat(40)}…`);
  });
});

describe("buildBtwAnswer", () => {
  it("leads with the answer under an untrusted banner", () => {
    const message = buildBtwAnswer(snapshot({ resultText: "Paris" }));
    const banner = message.indexOf("untrusted evidence");
    assert.ok(banner > 0);
    assert.ok(message.indexOf("Paris") > banner);
    assert.doesNotMatch(message, /sa_status/);
  });

  it("reports failures with the error text", () => {
    const message = buildBtwAnswer(
      snapshot({ status: "failed", exitCode: 1, errorText: "boom" }),
    );
    assert.match(message, /failed/);
    assert.ok(message.indexOf("boom") > message.indexOf("untrusted evidence"));
  });

  it("bounds oversized results", () => {
    const message = buildBtwAnswer(snapshot({ resultText: "x".repeat(100_000) }));
    assert.ok(message.length < 10_000);
    assert.match(message, /truncated/);
  });
});

describe("modelPatternMatchesRegistry", () => {
  const models = [
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  ];

  it("accepts exact and provider-qualified ids", () => {
    assert.ok(modelPatternMatchesRegistry("gpt-5.6-sol", models));
    assert.ok(modelPatternMatchesRegistry("openai-codex/gpt-5.6-sol", models));
  });

  it("accepts partial and name matches, case-insensitively", () => {
    assert.ok(modelPatternMatchesRegistry("sonnet", models));
    assert.ok(modelPatternMatchesRegistry("GPT-5.6", models));
  });

  it("accepts thinking-suffixed patterns", () => {
    assert.ok(modelPatternMatchesRegistry("claude-sonnet-5:high", models));
  });

  it("leaves globs and an empty registry for the child to resolve", () => {
    assert.ok(modelPatternMatchesRegistry("*sonnet*", models));
    assert.ok(modelPatternMatchesRegistry("anything", []));
  });

  it("accepts an unknown id under a known provider (pi builds a custom model)", () => {
    assert.ok(modelPatternMatchesRegistry("anthropic/brand-new-model", models));
  });

  it("rejects a pattern that matches nothing", () => {
    assert.ok(!modelPatternMatchesRegistry("not-a-real/model", models));
    assert.ok(!modelPatternMatchesRegistry("nonexistent-model-name", models));
  });
});
