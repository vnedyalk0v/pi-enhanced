import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { BackendJob } from "../subagents/backend.ts";
import { PiResultRecordTooLargeError } from "../subagents/run.ts";
import { selectReconTools, WorkflowManager } from "./manager.ts";

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
function partialFailureStarter() {
  let piCalls = 0;
  return async (opts: { prompt: string; title?: string }) => {
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

async function waitForMissing(path: string) {
  for (let i = 0; i < 100; i++) {
    try {
      await access(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`path was not removed: ${path}`);
}

describe("WorkflowManager", () => {
  it("creates distinct private default directories that survive disposal", async () => {
    const starter = async () => fakeJob({ exitCode: 0, resultText: "ok", delayMs: 10 });
    const firstManager = new WorkflowManager({ subagentOptions: { starter } });
    const secondManager = new WorkflowManager({ subagentOptions: { starter } });
    managers.push(firstManager, secondManager);

    const [first, second] = await Promise.all([
      firstManager.start({ goal: "first default workflow", cwd: process.cwd() }),
      secondManager.start({ goal: "second default workflow", cwd: process.cwd() }),
    ]);
    tempDirs.push(first.artifactsDir, second.artifactsDir);
    await Promise.all([firstManager.wait([first.id]), secondManager.wait([second.id])]);

    assert.notEqual(first.artifactsDir, second.artifactsDir);
    assert.equal(dirname(first.artifactsDir), tmpdir());
    assert.equal(dirname(second.artifactsDir), tmpdir());
    if (process.platform !== "win32") {
      assert.equal((await stat(first.artifactsDir)).mode & 0o077, 0);
      assert.equal((await stat(second.artifactsDir)).mode & 0o077, 0);
    }

    await Promise.all([firstManager.disposeAll(), secondManager.disposeAll()]);
    await Promise.all([access(first.artifactsDir), access(second.artifactsDir)]);
  });

  it("isolates workflow artifacts across managers sharing a root", async () => {
    const artifactsRoot = await mkdtemp(join(tmpdir(), "wf-shared-test-"));
    tempDirs.push(artifactsRoot);
    const starter = async () => fakeJob({ exitCode: 0, resultText: "ok", delayMs: 10 });
    const firstManager = new WorkflowManager({
      artifactsRoot,
      subagentOptions: { starter },
    });
    const secondManager = new WorkflowManager({
      artifactsRoot,
      subagentOptions: { starter },
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
    let resolveThird!: () => void;
    const thirdSettled = new Promise<void>((resolve) => {
      resolveThird = resolve;
    });
    const { m } = await createManager({
      maxRunning: 1,
      maxTracked: 1,
      subagentOptions: {
        starter: async () =>
          fakeJob({ exitCode: 0, resultText: "ok scout/review/synth", delayMs: 30 }),
      },
      onSettled: ({ snapshot }) => {
        if (snapshot.goal === "third workflow") resolveThird();
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

    const third = await m.start({ goal: "third workflow", cwd: process.cwd() });
    await thirdSettled;
    assert.equal(m.get(first.id), undefined);
    assert.equal(m.get(later.id), undefined);
    assert.equal(m.get(third.id)?.status, "done");
  });

  it("a throwing onChange does not reject the start promise", async () => {
    const { m } = await createManager({
      onChange: () => {
        throw new Error("stale");
      },
      subagentOptions: {
        starter: async () => fakeJob({ exitCode: 0, resultText: "ok", delayMs: 1 }),
      },
    });

    const started = await m.start({ goal: "survive stale UI", cwd: process.cwd() });
    assert.equal(started.status, "running");
    await m.wait([started.id]);
  });

  it("a throwing onChange does not strand the concurrency slot", async () => {
    const { m } = await createManager({
      maxRunning: 1,
      onChange: () => {
        throw new Error("stale");
      },
      subagentOptions: {
        starter: async () => fakeJob({ exitCode: 0, resultText: "ok", delayMs: 1 }),
      },
    });

    const first = await m.start({ goal: "first workflow", cwd: process.cwd() });
    await m.wait([first.id]);
    const second = await m.start({ goal: "second workflow", cwd: process.cwd() });
    await m.wait([second.id]);
  });

  it("wait fails cleanly when the manager is disposed mid-wait", async () => {
    const { m } = await createManager({
      subagentOptions: {
        starter: async () => fakeJob({ exitCode: 0, resultText: "ok", delayMs: 30 }),
      },
    });

    const started = await m.start({ goal: "dispose mid wait", cwd: process.cwd() });
    const waiting = m.wait([started.id]);
    await m.disposeAll();
    await assert.rejects(waiting, /disposed during wait/);
  });

  it("a throwing onSettled does not produce an unhandled rejection", async () => {
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => unhandled.push(reason);
    process.once("unhandledRejection", recordUnhandled);
    const { m } = await createManager({
      onSettled: () => {
        markSettled();
        throw new Error("stale");
      },
      subagentOptions: {
        starter: async () => fakeJob({ exitCode: 0, resultText: "ok", delayMs: 1 }),
      },
    });

    try {
      const started = await m.start({ goal: "finish safely", cwd: process.cwd() });
      await settled;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      await m.wait([started.id]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });

  it("prunes workflows after successful waits and cancellations", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const settled = new Map<string, () => void>();
    const { m } = await createManager({
      maxRunning: 2,
      maxTracked: 1,
      subagentOptions: {
        starter: async ({ prompt }) => {
          if (!prompt.includes("retained workflow")) {
            return fakeJob({ exitCode: 0, resultText: "slow", delayMs: 30_000 });
          }
          const gate = prompt.includes("first retained workflow") ? firstGate : secondGate;
          const wait = gate.then(() => ({ exitCode: 0 }));
          return {
            handle: { pid: 99_001, kill: () => {}, wait },
            collect: async () => {
              const result = await wait;
              return { ...result, resultText: "done", output: "" };
            },
          };
        },
      },
      onSettled: ({ snapshot }) => settled.get(snapshot.id)?.(),
    });
    const first = await m.start({
      goal: "first retained workflow",
      cwd: process.cwd(),
    });
    const second = await m.start({
      goal: "second retained workflow",
      cwd: process.cwd(),
    });
    const firstSettled = new Promise<void>((resolve) => settled.set(first.id, resolve));

    const waiting = m.wait([first.id, second.id]);
    releaseFirst();
    await firstSettled;
    releaseSecond();

    const snapshots = await waiting;
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.status),
      ["done", "done"],
    );
    assert.deepEqual(m.list().map((snapshot) => snapshot.id), [second.id]);
    await waitForMissing(first.artifactsDir);

    const third = await m.start({
      goal: "third cancelled workflow",
      cwd: process.cwd(),
    });
    const cancelled = await m.cancel([second.id, third.id]);
    assert.deepEqual(
      cancelled.map((snapshot) => snapshot.status),
      ["done", "cancelled"],
    );
    assert.deepEqual(m.list().map((snapshot) => snapshot.id), [third.id]);
    await waitForMissing(second.artifactsDir);
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
    await writeFile(join(artifactsRoot, "caller-owned"), "keep");

    await assert.rejects(
      () =>
        m.start({
          goal: "abort after writing the first artifact",
          cwd: process.cwd(),
          signal: controller.signal,
        }),
      /aborted/i,
    );

    assert.deepEqual(await readdir(artifactsRoot), ["caller-owned"]);
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

  it("prefers file-search tools and falls back to native read-only tools", async () => {
    assert.deepEqual(
      selectReconTools(["read", "fd", "rg", "find", "grep", "ls"]),
      ["read", "fd", "rg"],
    );
    assert.deepEqual(selectReconTools(["read", "grep"]), ["read", "grep"]);
    assert.equal(selectReconTools(["fd", "rg"]), undefined);
    const reconTools = selectReconTools(["read", "fd", "rg"]);
    const calls: Array<{ key: string; tools?: string[]; extensionPath?: string }> = [];
    const { m } = await createManager({
      reconTools,
      reconExtensionPath: "/package/extensions/file-search/index.ts",
      subagentOptions: {
        starter: async ({ prompt, tools, extensionPath }) => {
          const key = prompt.match(/task key: (\w+)/)?.[1] ?? "";
          calls.push({ key, tools, extensionPath });
          return fakeJob({ exitCode: 0, resultText: `${key} complete` });
        },
      },
    });

    const started = await m.start({ goal: "verify tool policy", cwd: process.cwd() });
    await m.wait([started.id]);

    assert.deepEqual(calls, [
      {
        key: "structure",
        tools: ["read", "fd", "rg"],
        extensionPath: "/package/extensions/file-search/index.ts",
      },
      {
        key: "relevant",
        tools: ["read", "fd", "rg"],
        extensionPath: "/package/extensions/file-search/index.ts",
      },
      { key: "implement", tools: undefined, extensionPath: undefined },
      { key: "review", tools: undefined, extensionPath: undefined },
      { key: "synthesize", tools: ["read"], extensionPath: undefined },
    ]);
  });

  it("runs four phases, preserves artifacts, synthesizes after partial failure", async () => {
    const settled: Array<{ status: string; consumed: boolean }> = [];
    const { m, artifactsRoot } = await createManager({
      subagentOptions: {
        starter: partialFailureStarter(),
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
        starter: async () =>
          fakeJob({ exitCode: 0, resultText: "ok scout/review/synth", delayMs: 10 }),
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
        starter: async () => fakeJob({ exitCode: 0, resultText: "slow", delayMs: 30_000 }),
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

  it("keeps cancel interest until an aborted workflow settles", async () => {
    let backendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      backendStarted = resolve;
    });
    let finish!: () => void;
    const wait = new Promise<{ exitCode: number }>((resolve) => {
      finish = () => resolve({ exitCode: 1 });
    });
    let resolveSettled!: (consumed: boolean) => void;
    const settled = new Promise<boolean>((resolve) => {
      resolveSettled = resolve;
    });
    const { m } = await createManager({
      onSettled: ({ consumed }) => resolveSettled(consumed),
      subagentOptions: {
        starter: async () => {
          backendStarted();
          return {
            handle: { pid: 99_001, kill: () => {}, wait },
            collect: async () => ({ ...(await wait), resultText: "", output: "" }),
          };
        },
      },
    });
    const snap = await m.start({ goal: "late cancellation", cwd: process.cwd() });
    await started;
    const controller = new AbortController();
    const cancelling = m.cancel([snap.id], controller.signal);

    controller.abort();
    await assert.rejects(cancelling, /aborted/i);
    assert.equal(m.get(snap.id)?.status, "running");
    finish();

    assert.equal(await settled, true);
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
        starter: async () => {
          starts += 1;
          return fakeJob({ exitCode: 0, resultText: "unexpected" });
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
          starter: async () => {
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
          starter: async () => {
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
      });

      const snap = await m.start({ goal: "cancel during startup", cwd: process.cwd() });
      await entered;
      const cancelling = m.cancel([snap.id]);
      releaseStarter();

      await killed;
      const [cancelled] = await cancelling;
      assert.equal(cancelled?.status, "cancelled");
      assert.equal(cancelled?.failedTaskCount, 0);
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
        starter: async () => fakeJob({ exitCode: 0, resultText: "x", delayMs: 5 }),
      },
    });
    await assert.rejects(
      () => m.start({ goal: "  ", cwd: process.cwd() }),
      /goal must not be empty/,
    );
  });

  it("preserves a large valid synthesis artifact exactly", async () => {
    const largeResult = `large valid result\n${"é".repeat(512_000)}`;
    const { m } = await createManager({
      subagentOptions: {
        starter: async (opts: { prompt: string }) =>
          fakeJob({
            exitCode: 0,
            resultText: opts.prompt.includes("task key: synthesize")
              ? largeResult
              : "phase ok",
            delayMs: 5,
          }),
      },
    });

    const snap = await m.start({ goal: "preserve output", cwd: process.cwd() });
    const [done] = await m.wait([snap.id]);

    assert.equal(done?.status, "done");
    assert.ok(done?.finalArtifactPath);
    assert.equal(await readFile(done!.finalArtifactPath!, "utf8"), `${largeResult}\n`);
  });

  it("records an oversized synthesis as failed without a complete artifact", async () => {
    const { m } = await createManager({
      subagentOptions: {
        starter: async (opts: { prompt: string }) => {
          const job = fakeJob({ exitCode: 0, resultText: "phase ok", delayMs: 5 });
          if (opts.prompt.includes("task key: synthesize")) {
            job.collect = async () => {
              await job.handle.wait;
              throw new PiResultRecordTooLargeError();
            };
          }
          return job;
        },
      },
    });

    const snap = await m.start({ goal: "reject oversized output", cwd: process.cwd() });
    const [done] = await m.wait([snap.id]);
    const synthesis = done?.phases.find((phase) => phase.name === "synthesis");
    const task = synthesis?.tasks.find((candidate) => candidate.key === "synthesize");

    assert.equal(done?.status, "partial");
    assert.equal(task?.status, "failed");
    assert.match(task?.error ?? "", /result record exceeds.*UTF-8 limit/);
    assert.ok(task?.artifactPath);
    assert.match(await readFile(task!.artifactPath!, "utf8"), /- status: failed/);
    assert.ok(done?.finalArtifactPath);
    assert.match(await readFile(done!.finalArtifactPath!, "utf8"), /fallback/i);
  });

  it("fallback synthesis when synthesis agent fails", async () => {
    const { m } = await createManager({
      subagentOptions: {
        starter: async (opts: { prompt: string }) => {
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
