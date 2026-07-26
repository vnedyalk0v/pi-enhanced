import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTaskPrompt,
  extractSummary,
  formatPriorForPrompt,
  validateStructuredOutput,
} from "./handoff.ts";

describe("validateStructuredOutput", () => {
  it("accepts non-empty done results", () => {
    const out = validateStructuredOutput({
      phase: "reconnaissance",
      taskKey: "structure",
      title: "Map structure",
      subagentStatus: "done",
      resultText: "Repo is a monorepo with packages/a and packages/b.",
      artifactPath: "/tmp/a.md",
      subagentId: "sa-1",
    });
    assert.equal(out.status, "ok");
    assert.match(out.summary, /monorepo/);
    assert.equal(out.subagentId, "sa-1");
  });

  it("rejects empty done results", () => {
    const out = validateStructuredOutput({
      phase: "implementation",
      taskKey: "implement",
      title: "Implement",
      subagentStatus: "done",
      resultText: "   ",
      artifactPath: "/tmp/b.md",
    });
    assert.equal(out.status, "failed");
    assert.match(out.error ?? "", /empty result/);
  });

  it("maps failed and killed statuses", () => {
    const failed = validateStructuredOutput({
      phase: "review",
      taskKey: "review",
      title: "Review",
      subagentStatus: "failed",
      errorText: "exit 1",
      artifactPath: "/tmp/c.md",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "exit 1");

    const killed = validateStructuredOutput({
      phase: "review",
      taskKey: "review",
      title: "Review",
      subagentStatus: "killed",
      artifactPath: "/tmp/d.md",
    });
    assert.equal(killed.status, "killed");
  });
});

describe("handoff prompt", () => {
  it("includes goal, artifacts, and prior failures", () => {
    const prompt = buildTaskPrompt({
      goal: "Add caching",
      task: {
        key: "implement",
        title: "Implement",
        backend: "codex",
        role: "Implement the goal.",
      },
      artifactsDir: "/tmp/wf-1",
      prior: [
        {
          phase: "reconnaissance",
          taskKey: "structure",
          title: "Map",
          status: "ok",
          summary: "Found src/cache.ts",
          artifactPath: "/tmp/wf-1/phases/01/structure.md",
        },
        {
          phase: "reconnaissance",
          taskKey: "relevant",
          title: "Find",
          status: "failed",
          summary: "",
          artifactPath: "/tmp/wf-1/phases/01/relevant.md",
          error: "empty result (validation failed)",
        },
      ],
    });
    assert.match(prompt, /Add caching/);
    assert.match(prompt, /Found src\/cache\.ts/);
    assert.match(prompt, /failed/);
    assert.match(prompt, /\/tmp\/wf-1/);
  });

  it("extractSummary skips headings", () => {
    assert.equal(extractSummary("# Title\n\nBody line here."), "Body line here.");
  });

  it("formatPriorForPrompt handles empty", () => {
    assert.match(formatPriorForPrompt([]), /first phase/);
  });
});
