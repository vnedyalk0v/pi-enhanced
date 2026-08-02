import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { BackendJob } from "./backend.ts";
import { SubagentManager, type ManagerOptions } from "./manager.ts";
import { PiResultRecordTooLargeError } from "./run.ts";

const managers: SubagentManager[] = [];

afterEach(async () => {
  while (managers.length) {
    await managers.pop()!.disposeAll();
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
  const delay = result.delayMs ?? 20;
  const timer = setTimeout(() => resolveWait({ exitCode: result.exitCode }), delay);

  return {
    handle: {
      pid: 12345,
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

function createManager(opts: ManagerOptions = {}) {
  const m = new SubagentManager(opts);
  managers.push(m);
  return m;
}

describe("SubagentManager", () => {
  it("passes an extension path to the backend starter", async () => {
    let receivedExtensionPath: string | undefined;
    const m = createManager({
      starters: {
        pi: async ({ extensionPath }) => {
          receivedExtensionPath = extensionPath;
          return fakeJob({ exitCode: 0, resultText: "done" });
        },
      },
    });

    await m.spawn({
      prompt: "search files",
      cwd: process.cwd(),
      extensionPath: "/package/extensions/file-search/index.ts",
    });

    assert.equal(receivedExtensionPath, "/package/extensions/file-search/index.ts");
  });

  it("keeps streamed output without notifying for every chunk", async () => {
    let finish!: () => void;
    const wait = new Promise<{ exitCode: number }>((resolve) => {
      finish = () => resolve({ exitCode: 0 });
    });
    let changes = 0;
    const m = createManager({
      onChange: () => {
        changes += 1;
      },
      starters: {
        pi: async ({ onOutput }) => {
          for (let i = 0; i < 120; i++) onOutput?.(`chunk ${i}\n`);
          return {
            handle: { pid: 12345, kill: finish, wait },
            collect: async () => {
              const result = await wait;
              return { ...result, resultText: "done", output: "" };
            },
          };
        },
      },
    });

    const snap = await m.spawn({ prompt: "stream", cwd: process.cwd() });
    assert.equal(changes, 1);

    finish();
    await m.wait([snap.id]);

    assert.match(m.get(snap.id)?.outputTail ?? "", /chunk 119\n$/);
    assert.equal(changes, 2);
  });

  it("spawns, settles done, and delivers unconsumed completion", async () => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    const m = createManager({
      starters: {
        pi: async () => fakeJob({ exitCode: 0, resultText: "hello", delayMs: 30 }),
      },
      onSettled: ({ snapshot, consumed }) => {
        settled.push({ id: snapshot.id, consumed });
      },
    });

    const snap = await m.spawn({
      prompt: "say hi",
      title: "hi",
      cwd: process.cwd(),
    });
    assert.equal(snap.status, "running");
    assert.match(snap.id, /^sa-\d+$/);

    await m.wait([snap.id]);
    const after = m.get(snap.id)!;
    assert.equal(after.status, "done");
    assert.equal(after.resultText, "hello");
    // wait holds interest → consumed
    assert.equal(settled.at(-1)?.consumed, true);
  });

  it("async completion is not consumed when not waiting", async () => {
    const settled: boolean[] = [];
    const m = createManager({
      starters: {
        pi: async () => fakeJob({ exitCode: 0, resultText: "x", delayMs: 30 }),
      },
      onSettled: ({ consumed }) => settled.push(consumed),
    });
    const snap = await m.spawn({
      prompt: "x",
      cwd: process.cwd(),
    });
    // poll until settled without wait interest
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (m.get(snap.id)?.status !== "running") break;
    }
    assert.equal(m.get(snap.id)?.status, "done");
    assert.equal(settled.at(-1), false);
  });

  it("keeps actively awaited subagents until final snapshots are returned", async () => {
    const finishers: Array<() => void> = [];
    const settled = new Map<string, () => void>();
    const observedIds: string[][] = [];
    let m!: SubagentManager;
    m = createManager({
      maxTracked: 1,
      starters: {
        pi: async () => {
          let finish!: () => void;
          const wait = new Promise<{ exitCode: number }>((resolve) => {
            finish = () => resolve({ exitCode: 0 });
          });
          finishers.push(finish);
          return {
            handle: { pid: 12345, kill: finish, wait },
            collect: async () => {
              const result = await wait;
              return { ...result, resultText: "done", output: "" };
            },
          };
        },
      },
      onSettled: ({ snapshot }) => settled.get(snapshot.id)?.(),
      onChange: () => observedIds.push(m.list().map((snapshot) => snapshot.id)),
    });
    const first = await m.spawn({ prompt: "first", cwd: process.cwd() });
    const second = await m.spawn({ prompt: "second", cwd: process.cwd() });
    const firstSettled = new Promise<void>((resolve) => settled.set(first.id, resolve));

    const waiting = m.wait([first.id, second.id]);
    finishers[0]!();
    await firstSettled;
    finishers[1]!();

    const snapshots = await waiting;
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.status),
      ["done", "done"],
    );
    assert.deepEqual(m.list().map((snapshot) => snapshot.id), [second.id]);
    assert.deepEqual(observedIds.at(-1), [second.id]);

    const third = await m.spawn({ prompt: "third", cwd: process.cwd() });
    const cancelled = await m.cancel([second.id, third.id]);
    assert.deepEqual(
      cancelled.map((snapshot) => snapshot.status),
      ["done", "killed"],
    );
    assert.deepEqual(m.list().map((snapshot) => snapshot.id), [third.id]);
    assert.deepEqual(observedIds.at(-1), [third.id]);
  });

  it("cancel kills a running subagent", async () => {
    const m = createManager({
      starters: {
        pi: async () => fakeJob({ exitCode: 0, resultText: "late", delayMs: 5000 }),
      },
    });
    const snap = await m.spawn({
      prompt: "long",
      cwd: process.cwd(),
    });
    const cancelled = await m.cancel([snap.id]);
    assert.equal(cancelled[0]?.status, "killed");
  });

  it("keeps cancel interest until an aborted termination settles", async () => {
    let finish!: () => void;
    const wait = new Promise<{ exitCode: number }>((resolve) => {
      finish = () => resolve({ exitCode: 1 });
    });
    let resolveSettled!: (consumed: boolean) => void;
    const settled = new Promise<boolean>((resolve) => {
      resolveSettled = resolve;
    });
    const m = createManager({
      starters: {
        pi: async () => ({
          handle: { pid: 12345, kill: () => {}, wait },
          collect: async () => ({ ...(await wait), resultText: "", output: "" }),
        }),
      },
      onSettled: ({ consumed }) => resolveSettled(consumed),
    });
    const snap = await m.spawn({ prompt: "long", cwd: process.cwd() });
    const controller = new AbortController();
    const cancelling = m.cancel([snap.id], controller.signal);

    controller.abort();
    await assert.rejects(cancelling, /aborted/i);
    assert.equal(m.get(snap.id)?.status, "running");
    finish();

    assert.equal(await settled, true);
  });

  it("wait fails cleanly when the manager is disposed mid-wait", async () => {
    let finish!: () => void;
    const gate = new Promise<{ exitCode: number }>((resolve) => {
      finish = () => resolve({ exitCode: 0 });
    });
    const m = createManager({
      starters: {
        pi: async () => ({
          handle: { pid: 12345, kill: () => finish(), wait: gate },
          collect: async () => ({ ...(await gate), resultText: "ok", output: "" }),
        }),
      },
    });

    const snap = await m.spawn({ prompt: "work", cwd: process.cwd() });
    const waiting = m.wait([snap.id]);
    await m.disposeAll();
    await assert.rejects(waiting, /disposed during wait/);
  });

  it("enforces concurrency limit", async () => {
    const m = createManager({
      maxRunning: 1,
      starters: {
        pi: async () => fakeJob({ exitCode: 0, resultText: "a", delayMs: 2000 }),
      },
    });
    await m.spawn({ prompt: "one", cwd: process.cwd() });
    await assert.rejects(
      () => m.spawn({ prompt: "two", cwd: process.cwd() }),
      /Concurrency limit/,
    );
  });

  it("kills a subagent after its max runtime and releases capacity", async () => {
    const signals: NodeJS.Signals[] = [];
    let finish!: () => void;
    const wait = new Promise<{ exitCode: number }>((resolve) => {
      finish = () => resolve({ exitCode: 1 });
    });
    let calls = 0;
    const m = createManager({
      maxRunning: 1,
      maxRuntimeMs: 30,
      killGraceMs: 10,
      starters: {
        pi: async () => {
          calls += 1;
          if (calls > 1) {
            return fakeJob({ exitCode: 0, resultText: "next", delayMs: 10 });
          }
          return {
            handle: {
              pid: 12345,
              kill: (signal = "SIGTERM") => {
                signals.push(signal);
                if (signal === "SIGKILL") finish();
              },
              wait,
            },
            collect: async () => {
              const result = await wait;
              return {
                ...result,
                signal: signals.at(-1),
                resultText: "",
                output: "",
              };
            },
          };
        },
      },
    });

    const started = await m.spawn({ prompt: "timeout", cwd: process.cwd() });
    const [timedOut] = await m.wait([started.id]);
    assert.equal(timedOut?.status, "killed");
    assert.match(timedOut?.errorText ?? "", /exceeded max runtime/);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);

    const next = await m.spawn({ prompt: "next", cwd: process.cwd() });
    const [completed] = await m.wait([next.id]);
    assert.equal(completed?.status, "done");
    assert.equal(calls, 2);
  });

  it("reserves concurrency while a subagent is starting", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let calls = 0;
    const m = createManager({
      maxRunning: 1,
      starters: {
        pi: async () => {
          calls += 1;
          if (calls === 1) await startGate;
          return fakeJob({ exitCode: 0, resultText: "a", delayMs: 2000 });
        },
      },
    });

    const first = m.spawn({ prompt: "one", cwd: process.cwd() });
    await Promise.resolve();
    await assert.rejects(
      () => m.spawn({ prompt: "two", cwd: process.cwd() }),
      /Concurrency limit/,
    );

    releaseStart();
    const started = await first;
    await m.cancel([started.id]);
  });

  it("releases a reserved slot when startup fails", async () => {
    let calls = 0;
    const m = createManager({
      maxRunning: 1,
      starters: {
        pi: async () => {
          calls += 1;
          if (calls === 1) throw new Error("starter failed");
          return fakeJob({ exitCode: 0, resultText: "recovered", delayMs: 20 });
        },
      },
    });

    await assert.rejects(
      () => m.spawn({ prompt: "first", cwd: process.cwd() }),
      /starter failed/,
    );
    const started = await m.spawn({
      prompt: "second",
      cwd: process.cwd(),
    });
    await m.wait([started.id]);
    assert.equal(m.get(started.id)?.status, "done");
  });

  it("cleans a delayed startup when disposal wins before registration", async () => {
    let starterEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      starterEntered = resolve;
    });
    let releaseStarter!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStarter = resolve;
    });
    let kills = 0;
    let collects = 0;
    let finish!: () => void;
    const wait = new Promise<{ exitCode: number }>((resolve) => {
      finish = () => resolve({ exitCode: 1 });
    });
    const m = createManager({
      starters: {
        pi: async () => {
          starterEntered();
          await gate;
          return {
            handle: {
              pid: 12345,
              kill: () => {
                kills += 1;
                finish();
              },
              wait,
            },
            collect: async () => {
              collects += 1;
              const result = await wait;
              return { ...result, resultText: "", output: "" };
            },
          };
        },
      },
    });

    const starting = m.spawn({ prompt: "late", cwd: process.cwd() });
    await entered;
    await m.disposeAll();
    releaseStarter();

    await assert.rejects(starting, /Subagent manager is disposed/);
    assert.equal(kills, 1);
    assert.equal(collects, 1);
    assert.deepEqual(m.list(), []);
  });

  it("does not allocate for an already-aborted start", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const m = createManager({
      starters: {
        pi: async () => {
          calls += 1;
          return fakeJob({ exitCode: 0 });
        },
      },
    });

    await assert.rejects(
      () => m.spawn({ prompt: "no", cwd: process.cwd(), signal: controller.signal }),
      /aborted/i,
    );
    assert.equal(calls, 0);
    assert.deepEqual(m.list(), []);
  });

  it("keeps a registered subagent alive after its startup signal aborts", async () => {
    const controller = new AbortController();
    let kills = 0;
    const job = fakeJob({ exitCode: 0, resultText: "later", delayMs: 5000 });
    const originalKill = job.handle.kill;
    job.handle.kill = (signal) => {
      kills += 1;
      originalKill(signal);
    };
    const m = createManager({
      starters: {
        pi: async () => job,
      },
    });

    const started = await m.spawn({
      prompt: "keep running",
      cwd: process.cwd(),
      signal: controller.signal,
    });
    controller.abort();

    assert.equal(kills, 0);
    assert.equal(m.get(started.id)?.status, "running");
    await m.cancel([started.id]);
    assert.equal(kills, 1);
  });

  it("tracks the named agent on the snapshot", async () => {
    const m = createManager({
      starters: {
        pi: async () => fakeJob({ exitCode: 0, resultText: "p", delayMs: 10 }),
      },
    });
    const snap = await m.spawn({ agent: "scout", prompt: "p", cwd: process.cwd() });
    assert.equal(snap.agent, "scout");
    const adhoc = await m.spawn({ prompt: "q", cwd: process.cwd() });
    assert.equal(adhoc.agent, undefined);
  });

  it("failed exit becomes failed status", async () => {
    const m = createManager({
      starters: {
        pi: async () =>
          fakeJob({ exitCode: 2, resultText: "", errorText: "boom", delayMs: 20 }),
      },
    });
    const snap = await m.spawn({ prompt: "f", cwd: process.cwd() });
    await m.wait([snap.id]);
    assert.equal(m.get(snap.id)?.status, "failed");
    assert.equal(m.get(snap.id)?.exitCode, 2);
  });

  it("fails an oversized result and releases capacity for the next spawn", async () => {
    let calls = 0;
    const m = createManager({
      maxRunning: 1,
      starters: {
        pi: async () => {
          calls += 1;
          if (calls > 1) {
            return fakeJob({ exitCode: 0, resultText: "recovered", delayMs: 10 });
          }
          const job = fakeJob({ exitCode: 0, delayMs: 10 });
          job.collect = async () => {
            await job.handle.wait;
            throw new PiResultRecordTooLargeError();
          };
          return job;
        },
      },
    });

    const oversized = await m.spawn({ prompt: "oversized", cwd: process.cwd() });
    await m.wait([oversized.id]);
    const failed = m.get(oversized.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.resultText, undefined);
    assert.match(failed?.errorText ?? "", /result record exceeds.*UTF-8 limit/);
    assert.ok((failed?.errorText?.length ?? Infinity) < 100);

    const next = await m.spawn({ prompt: "next", cwd: process.cwd() });
    await m.wait([next.id]);
    assert.equal(m.get(next.id)?.status, "done");
    assert.equal(m.get(next.id)?.resultText, "recovered");
  });
});
