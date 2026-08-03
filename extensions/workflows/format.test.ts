import assert from "node:assert/strict";
import { it } from "node:test";
import type { WorkflowSnapshot } from "./domain.ts";
import { buildPhaseTree } from "./format.ts";

it("keeps task errors on a bounded single phase-tree line", () => {
  const snap = {
    phases: [
      {
        name: "review",
        status: "failed",
        tasks: [
          {
            key: "review-code",
            status: "failed",
            error: `first line\n${"x".repeat(200)}`,
          },
        ],
      },
    ],
  } as WorkflowSnapshot;

  const lines = buildPhaseTree(snap);
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines[1]!, /\n/);
  assert.ok(lines[1]!.length < 140);
  assert.match(lines[1]!, /…$/);
});
