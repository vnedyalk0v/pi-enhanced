import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { BackendJob } from "./backends/pi.ts";
import { SubagentManager, type ManagerOptions } from "./manager.ts";

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
      backend: "pi",
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
      backend: "pi",
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

  it("rejects non-pi/codex is compile-time; cancel kills running", async () => {
    const m = createManager({
      starters: {
        pi: async () => fakeJob({ exitCode: 0, resultText: "late", delayMs: 5000 }),
      },
    });
    const snap = await m.spawn({
      backend: "pi",
      prompt: "long",
      cwd: process.cwd(),
    });
    const cancelled = await m.cancel([snap.id]);
    assert.equal(cancelled[0]?.status, "killed");
  });

  it("enforces concurrency limit", async () => {
    const m = createManager({
      maxRunning: 1,
      starters: {
        pi: async () => fakeJob({ exitCode: 0, resultText: "a", delayMs: 2000 }),
      },
    });
    await m.spawn({ backend: "pi", prompt: "one", cwd: process.cwd() });
    await assert.rejects(
      () => m.spawn({ backend: "pi", prompt: "two", cwd: process.cwd() }),
      /Concurrency limit/,
    );
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

    const first = m.spawn({ backend: "pi", prompt: "one", cwd: process.cwd() });
    await Promise.resolve();
    await assert.rejects(
      () => m.spawn({ backend: "pi", prompt: "two", cwd: process.cwd() }),
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
      () => m.spawn({ backend: "pi", prompt: "first", cwd: process.cwd() }),
      /starter failed/,
    );
    const started = await m.spawn({
      backend: "pi",
      prompt: "second",
      cwd: process.cwd(),
    });
    await m.wait([started.id]);
    assert.equal(m.get(started.id)?.status, "done");
  });

  it("lists both backends", async () => {
    const m = createManager({
      starters: {
        pi: async () => fakeJob({ exitCode: 0, resultText: "p", delayMs: 10 }),
        codex: async () => fakeJob({ exitCode: 0, resultText: "c", delayMs: 10 }),
      },
    });
    await m.spawn({ backend: "pi", prompt: "p", cwd: process.cwd() });
    await m.spawn({ backend: "codex", prompt: "c", cwd: process.cwd() });
    const list = m.list();
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((s) => s.backend).sort(), ["codex", "pi"]);
  });

  it("failed exit becomes failed status", async () => {
    const m = createManager({
      starters: {
        pi: async () =>
          fakeJob({ exitCode: 2, resultText: "", errorText: "boom", delayMs: 20 }),
      },
    });
    const snap = await m.spawn({ backend: "pi", prompt: "f", cwd: process.cwd() });
    await m.wait([snap.id]);
    assert.equal(m.get(snap.id)?.status, "failed");
    assert.equal(m.get(snap.id)?.exitCode, 2);
  });
});
