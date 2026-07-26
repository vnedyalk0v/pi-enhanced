import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { BackendJob } from "../subagents/backends/pi.ts";
import { WorkflowManager } from "./manager.ts";

const managers: WorkflowManager[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (managers.length) {
    await managers.pop()!.disposeAll();
  }
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

function fakeJob(result: {
  exitCode: number;
  resultText?: string;
  errorText?: string;
  delayMs?: number;
}): BackendJob {
  let resolveWait!: (v: { exitCode: number }) => void;
  const wait = new Promise<{ exitCode: number }>((r) => {
    resolveWait = r;
  });
  const delay = result.delayMs ?? 15;
  setTimeout(() => resolveWait({ exitCode: result.exitCode }), delay).unref?.();

  return {
    handle: {
      pid: 99_001,
      kill: () => {
        resolveWait({ exitCode: 1 });
      },
      wait,
    },
    collect: async () => {
      const w = await wait;
      return {
        exitCode: w.exitCode,
        resultText: result.resultText ?? "",
        errorText: result.errorText,
        output: result.resultText ?? result.errorText ?? "",
      };
    },
  };
}

/** Scripted backends: fail recon "relevant", succeed everything else. */
function partialFailureStarters() {
  let piCalls = 0;
  return {
    pi: async (opts: { prompt: string; title?: string }) => {
      piCalls += 1;
      const prompt = opts.prompt;
      // relevant scout
      if (prompt.includes("task key: relevant")) {
        return fakeJob({
          exitCode: 1,
          errorText: "scout crashed",
          resultText: "",
          delayMs: 20,
        });
      }
      if (prompt.includes("task key: structure")) {
        return fakeJob({
          exitCode: 0,
          resultText: "Structure: src/, tests/, package.json entry at src/index.ts.",
          delayMs: 20,
        });
      }
      if (prompt.includes("task key: review")) {
        return fakeJob({
          exitCode: 0,
          resultText: "Review: looks good; add one unit test for edge case.",
          delayMs: 20,
        });
      }
      if (prompt.includes("task key: synthesize")) {
        return fakeJob({
          exitCode: 0,
          resultText:
            "Final: implemented caching. One recon scout failed; used structure brief. Review requested a test.",
          delayMs: 20,
        });
      }
      return fakeJob({
        exitCode: 0,
        resultText: `pi ok #${piCalls}`,
        delayMs: 10,
      });
    },
    codex: async (opts: { prompt: string }) => {
      if (opts.prompt.includes("task key: implement")) {
        return fakeJob({
          exitCode: 0,
          resultText: "Implemented: added cache layer in src/cache.ts.",
          delayMs: 25,
        });
      }
      return fakeJob({ exitCode: 0, resultText: "codex ok", delayMs: 10 });
    },
  };
}

async function createManager(
  opts: ConstructorParameters<typeof WorkflowManager>[0] = {},
) {
  const artifactsRoot = await mkdtemp(join(tmpdir(), "wf-test-"));
  tempDirs.push(artifactsRoot);
  const m = new WorkflowManager({
    artifactsRoot,
    ...opts,
  });
  managers.push(m);
  return { m, artifactsRoot };
}

describe("WorkflowManager", () => {
  it("runs four phases, preserves artifacts, synthesizes after partial failure", async () => {
    const settled: Array<{ status: string; consumed: boolean }> = [];
    const { m, artifactsRoot } = await createManager({
      subagentOptions: {
        starters: partialFailureStarters(),
        maxRunning: 4,
      },
      onSettled: ({ snapshot, consumed }) => {
        settled.push({ status: snapshot.status, consumed });
      },
    });

    const snap = await m.start({
      goal: "Add caching to the session store",
      title: "cache workflow",
      cwd: process.cwd(),
    });
    assert.equal(snap.status, "running");
    assert.match(snap.id, /^wf-\d+$/);
    assert.ok(snap.artifactsDir.startsWith(artifactsRoot));

    const [done] = await m.wait([snap.id]);
    assert.ok(done);
    // partial because recon relevant failed
    assert.equal(done.status, "partial");
    assert.ok(done.failedTaskCount >= 1);
    assert.ok(done.finalArtifactPath);
    assert.ok(done.finalSummary);
    assert.match(done.finalSummary!, /caching|implemented|Final/i);

    // All four phases present
    assert.equal(done.phases.length, 4);
    assert.deepEqual(
      done.phases.map((p) => p.name),
      ["reconnaissance", "implementation", "review", "synthesis"],
    );

    // Recon had a failure; later phases still ran
    const recon = done.phases[0]!;
    assert.equal(recon.status, "failed");
    const relevant = recon.tasks.find((t) => t.key === "relevant");
    assert.equal(relevant?.status, "failed");

    const impl = done.phases[1]!;
    assert.equal(impl.status, "done");
    assert.equal(impl.tasks[0]?.status, "done");

    const synth = done.phases[3]!;
    assert.equal(synth.status, "done");

    // Artifacts on disk
    const finalBody = await readFile(done.finalArtifactPath!, "utf8");
    assert.match(finalBody, /caching|implemented|Final/i);

    const goal = await readFile(join(done.artifactsDir, "goal.txt"), "utf8");
    assert.match(goal, /session store/);

    const statusJson = await readFile(join(done.artifactsDir, "status.json"), "utf8");
    const parsed = JSON.parse(statusJson) as { status: string; failedTaskCount: number };
    assert.equal(parsed.status, "partial");
    assert.ok(parsed.failedTaskCount >= 1);

    // wait consumes async delivery
    assert.equal(settled.at(-1)?.consumed, true);
  });

  it("async completion is not consumed when not waiting", async () => {
    const settled: boolean[] = [];
    const { m } = await createManager({
      subagentOptions: {
        starters: {
          pi: async () =>
            fakeJob({ exitCode: 0, resultText: "ok scout/review/synth", delayMs: 10 }),
          codex: async () =>
            fakeJob({ exitCode: 0, resultText: "ok implement", delayMs: 10 }),
        },
      },
      onSettled: ({ consumed }) => settled.push(consumed),
    });

    const snap = await m.start({
      goal: "trivial",
      cwd: process.cwd(),
    });

    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 30));
      if (m.get(snap.id)?.status !== "running") break;
    }
    const after = m.get(snap.id)!;
    assert.ok(after.status === "done" || after.status === "partial");
    assert.equal(settled.at(-1), false);
  });

  it("cancel stops a running workflow", async () => {
    const { m } = await createManager({
      subagentOptions: {
        starters: {
          pi: async () => fakeJob({ exitCode: 0, resultText: "slow", delayMs: 30_000 }),
          codex: async () => fakeJob({ exitCode: 0, resultText: "slow", delayMs: 30_000 }),
        },
      },
    });

    const snap = await m.start({
      goal: "long running",
      cwd: process.cwd(),
    });
    // let first phase spawn
    await new Promise((r) => setTimeout(r, 40));
    const cancelled = await m.cancel([snap.id]);
    assert.equal(cancelled[0]?.status, "cancelled");
  });

  it("rejects empty goal", async () => {
    const { m } = await createManager({
      subagentOptions: {
        starters: {
          pi: async () => fakeJob({ exitCode: 0, resultText: "x", delayMs: 5 }),
        },
      },
    });
    await assert.rejects(
      () => m.start({ goal: "  ", cwd: process.cwd() }),
      /goal must not be empty/,
    );
  });

  it("fallback synthesis when synthesis agent fails", async () => {
    const { m } = await createManager({
      subagentOptions: {
        starters: {
          pi: async (opts: { prompt: string }) => {
            if (opts.prompt.includes("task key: synthesize")) {
              return fakeJob({ exitCode: 1, errorText: "synth boom", delayMs: 10 });
            }
            return fakeJob({
              exitCode: 0,
              resultText: "phase ok detail for handoff",
              delayMs: 10,
            });
          },
          codex: async () =>
            fakeJob({ exitCode: 0, resultText: "implemented something", delayMs: 10 }),
        },
      },
    });

    const snap = await m.start({ goal: "do work", cwd: process.cwd() });
    const [done] = await m.wait([snap.id]);
    assert.ok(done);
    assert.ok(done.status === "partial" || done.status === "failed");
    assert.ok(done.finalArtifactPath);
    const body = await readFile(done.finalArtifactPath!, "utf8");
    assert.match(body, /fallback|Phase outputs/i);
    assert.match(body, /do work/);
  });
});
