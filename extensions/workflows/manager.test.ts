import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { BackendJob } from "../subagents/backend.ts";
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
  const timer = setTimeout(() => resolveWait({ exitCode: result.exitCode }), delay);

  return {
    handle: {
      pid: 99_001,
      kill: () => {
        clearTimeout(timer);
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

/** Scripted backend: fail recon "relevant", succeed everything else. */
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
      if (prompt.includes("task key: implement")) {
        return fakeJob({
          exitCode: 0,
          resultText: "Implemented: added cache layer in src/cache.ts.",
          delayMs: 25,
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
  it("isolates workflow artifacts across managers sharing a root", async () => {
    const artifactsRoot = await mkdtemp(join(tmpdir(), "wf-shared-test-"));
    tempDirs.push(artifactsRoot);
    const starters = {
      pi: async () => fakeJob({ exitCode: 0, resultText: "ok", delayMs: 10 }),
    };
    const firstManager = new WorkflowManager({
      artifactsRoot,
      subagentOptions: { starters },
    });
    const secondManager = new WorkflowManager({
      artifactsRoot,
      subagentOptions: { starters },
    });
    managers.push(firstManager, secondManager);

    const [first, second] = await Promise.all([
      firstManager.start({ goal: "first workflow", cwd: process.cwd() }),
      secondManager.start({ goal: "second workflow", cwd: process.cwd() }),
    ]);

    assert.equal(first.id, "wf-1");
    assert.equal(second.id, "wf-1");
    assert.notEqual(first.artifactsDir, second.artifactsDir);
    for (const snapshot of [first, second]) {
      const child = relative(artifactsRoot, snapshot.artifactsDir);
      assert.ok(child && !child.startsWith("..") && !isAbsolute(child));
    }
    assert.equal(await readFile(join(first.artifactsDir, "goal.txt"), "utf8"), "first workflow\n");
    assert.equal(
      await readFile(join(second.artifactsDir, "goal.txt"), "utf8"),
      "second workflow\n",
    );

    if (process.platform !== "win32") {
      for (const snapshot of [first, second]) {
        for (const path of [
          snapshot.artifactsDir,
          join(snapshot.artifactsDir, "goal.txt"),
          join(snapshot.artifactsDir, "meta.json"),
        ]) {
          assert.equal((await stat(path)).mode & 0o077, 0, path);
        }
      }
    }
  });

  it("rejects starts at capacity and releases capacity after settlement", async () => {
    const { m } = await createManager({
      maxRunning: 1,
      maxTracked: 1,
      subagentOptions: {
        starters: {
          pi: async () =>
            fakeJob({ exitCode: 0, resultText: "ok scout/review/synth", delayMs: 30 }),
        },
      },
    });

    const firstStart = m.start({ goal: "first workflow", cwd: process.cwd() });
    await assert.rejects(
      () => m.start({ goal: "second workflow", cwd: process.cwd() }),
      /Concurrency limit/,
    );

    const first = await firstStart;
    await m.wait([first.id]);
    const later = await m.start({ goal: "later workflow", cwd: process.cwd() });
    await m.wait([later.id]);

    for (let i = 0; i < 20 && m.get(first.id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(m.get(first.id), undefined);
    assert.equal(m.get(later.id)?.status, "done");
  });

  it("rolls back artifacts when startup aborts before registration", async () => {
    const controller = new AbortController();
    const nativeThrow = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    Object.defineProperty(controller.signal, "throwIfAborted", {
      value: () => {
        checks += 1;
        if (checks === 4) controller.abort();
        nativeThrow();
      },
    });
    const { m, artifactsRoot } = await createManager();

    await assert.rejects(
      () =>
        m.start({
          goal: "abort after writing the first artifact",
          cwd: process.cwd(),
          signal: controller.signal,
        }),
      /aborted/i,
    );

    assert.deepEqual(await readdir(artifactsRoot), []);
    assert.deepEqual(m.list(), []);
  });

  it("rejects a startup that overlaps disposal without retaining artifacts", async () => {
    const { m, artifactsRoot } = await createManager();
    const starting = m.start({ goal: "dispose during startup", cwd: process.cwd() });

    await m.disposeAll();

    await assert.rejects(starting, /Workflow manager is disposed/);
    assert.deepEqual(await readdir(artifactsRoot), []);
    assert.deepEqual(m.list(), []);
  });

  it("does not allocate artifacts for an already-aborted start", async () => {
    const controller = new AbortController();
    controller.abort();
    const { m, artifactsRoot } = await createManager();

    await assert.rejects(
      () => m.start({ goal: "never starts", cwd: process.cwd(), signal: controller.signal }),
      /aborted/i,
    );

    assert.deepEqual(await readdir(artifactsRoot), []);
    assert.deepEqual(m.list(), []);
  });

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
        },
      },
      onSettled: ({ consumed }) => settled.push(consumed),
    });

    const snap = await m.start({
      goal: "trivial",
      cwd: process.cwd(),
    });

    // finish() sets entry.status synchronously but awaits subagent disposal and
    // artifact persistence before invoking onSettled, so poll for the callback
    // itself rather than inferring it from status (which can flip first).
    for (let i = 0; i < 100 && settled.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 30));
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

  it("persists killed tasks when cancelled before the first phase starts", async () => {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let starts = 0;
    const { m } = await createManager({
      onSettled: resolveSettled,
      subagentOptions: {
        starters: {
          pi: async () => {
            starts += 1;
            return fakeJob({ exitCode: 0, resultText: "unexpected" });
          },
        },
      },
    });

    const snap = await m.start({ goal: "cancel immediately", cwd: process.cwd() });
    const [cancelled] = await m.cancel([snap.id]);
    await settled;

    assert.equal(starts, 0);
    assert.equal(cancelled?.status, "cancelled");
    const tasks = cancelled?.phases[0]?.tasks ?? [];
    assert.ok(tasks.length > 0);
    for (const task of tasks) {
      assert.equal(task.status, "killed");
      assert.equal(task.error, "cancelled before start");
      assert.ok(task.artifactPath);
      const artifact = await readFile(task.artifactPath, "utf8");
      assert.match(artifact, /- status: killed/);
      assert.match(artifact, /- error: cancelled before start/);
    }

    const persisted = JSON.parse(
      await readFile(join(snap.artifactsDir, "status.json"), "utf8"),
    ) as typeof cancelled;
    assert.deepEqual(persisted, JSON.parse(JSON.stringify(cancelled)));
    const outputs = JSON.parse(
      await readFile(join(snap.artifactsDir, "phases", "01-reconnaissance", "outputs.json"), "utf8"),
    ) as Array<{ status: string }>;
    assert.equal(outputs.length, tasks.length);
    assert.ok(outputs.every((output) => output.status === "killed"));
  });

  it(
    "records a delayed subagent start interrupted by shutdown as killed",
    { timeout: 1000 },
    async () => {
      let starterEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        starterEntered = resolve;
      });
      let releaseStarter!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseStarter = resolve;
      });
      let jobKilled!: () => void;
      const killed = new Promise<void>((resolve) => {
        jobKilled = resolve;
      });
      const { m } = await createManager({
        subagentOptions: {
          starters: {
            pi: async () => {
              starterEntered();
              await release;
              return {
                handle: {
                  pid: 99_003,
                  kill: jobKilled,
                  wait: Promise.resolve({ exitCode: 1 }),
                },
                collect: async () => ({ exitCode: 1, resultText: "", output: "" }),
              };
            },
          },
        },
      });

      const snap = await m.start({ goal: "shutdown during startup", cwd: process.cwd() });
      await entered;
      const disposing = m.disposeAll();
      releaseStarter();

      await killed;
      await disposing;
      const persisted = JSON.parse(
        await readFile(join(snap.artifactsDir, "status.json"), "utf8"),
      ) as {
        status: string;
        failedTaskCount: number;
        phases: Array<{ tasks: Array<{ status: string }> }>;
      };
      assert.equal(persisted.status, "cancelled");
      assert.equal(persisted.failedTaskCount, 0);
      assert.ok(persisted.phases[0]?.tasks.every((task) => task.status === "killed"));
      const outputs = JSON.parse(
        await readFile(join(snap.artifactsDir, "phases", "01-reconnaissance", "outputs.json"), "utf8"),
      ) as Array<{ status: string }>;
      assert.equal(outputs.length, 2);
      assert.ok(outputs.every((output) => output.status === "killed"));
    },
  );

  it(
    "cancels a subagent that finishes starting after workflow cancellation",
    { timeout: 1000 },
    async () => {
      let starterEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        starterEntered = resolve;
      });
      let releaseStarter!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseStarter = resolve;
      });
      let jobKilled!: () => void;
      const killed = new Promise<void>((resolve) => {
        jobKilled = resolve;
      });
      let finishJob!: () => void;
      const wait = new Promise<{ exitCode: number }>((resolve) => {
        finishJob = () => resolve({ exitCode: 1 });
      });
      const { m } = await createManager({
        subagentOptions: {
          starters: {
            pi: async () => {
              starterEntered();
              await release;
              return {
                handle: {
                  pid: 99_002,
                  kill: () => {
                    jobKilled();
                    finishJob();
                  },
                  wait,
                },
                collect: async () => {
                  const result = await wait;
                  return { ...result, resultText: "", output: "" };
                },
              };
            },
          },
        },
      });

      const snap = await m.start({ goal: "cancel during startup", cwd: process.cwd() });
      await entered;
      const cancelling = m.cancel([snap.id]);
      releaseStarter();

      await killed;
      const [cancelled] = await cancelling;
      assert.equal(cancelled?.status, "cancelled");
      const tasks = cancelled?.phases[0]?.tasks ?? [];
      assert.equal(tasks.length, 2);
      assert.ok(tasks.every((task) => task.status === "killed"));
      for (const task of tasks) {
        assert.ok(task.artifactPath);
        assert.match(await readFile(task.artifactPath, "utf8"), /- status: killed/);
      }
      const outputs = JSON.parse(
        await readFile(join(snap.artifactsDir, "phases", "01-reconnaissance", "outputs.json"), "utf8"),
      ) as Array<{ status: string }>;
      assert.equal(outputs.length, 2);
      assert.ok(outputs.every((output) => output.status === "killed"));
    },
  );

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
