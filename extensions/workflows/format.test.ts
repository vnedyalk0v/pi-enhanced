import assert from "node:assert/strict";
import { it } from "node:test";
import type { TaskRunSnapshot, WorkflowSnapshot } from "./domain.ts";
import { buildPhaseTree } from "./format.ts";

function makeSnapshot(task: TaskRunSnapshot) {
  return {
    id: "wf-1",
    title: "Review workflow",
    goal: "Review the code",
    status: task.status === "failed" ? "failed" : "done",
    cwd: "/repo",
    artifactsDir: "/repo/artifacts",
    createdAt: 1,
    failedTaskCount: task.status === "failed" ? 1 : 0,
    phases: [
      {
        name: "review",
        status: task.status === "failed" ? "failed" : "done",
        tasks: [task],
      },
    ],
  } satisfies WorkflowSnapshot;
}

it("keeps task errors on a bounded single phase-tree line", () => {
  const snap = makeSnapshot({
    key: "review-code",
    title: "Review code",
    status: "failed",
    error: `first line\n${"x".repeat(200)}`,
  });

  const lines = buildPhaseTree(snap);
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /first line/);
  assert.doesNotMatch(lines[1]!, /\n/);
  assert.ok(lines[1]!.length < 140);
  assert.match(lines[1]!, /…$/);
});

it("uses a bounded single-line task summary when no error is present", () => {
  const snap = makeSnapshot({
    key: "review-code",
    title: "Review code",
    status: "done",
    summary: `summary first line\n${"y".repeat(200)}`,
  });

  const lines = buildPhaseTree(snap);
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, / — summary first line /);
  assert.doesNotMatch(lines[1]!, /\n/);
  assert.ok(lines[1]!.length < 140);
  assert.match(lines[1]!, /…$/);
});
