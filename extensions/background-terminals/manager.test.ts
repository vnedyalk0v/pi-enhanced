import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ResultDelivery } from "../shared/delivery.ts";
import { TerminalManager, type SettledInfo } from "./manager.ts";

const managers: TerminalManager[] = [];

afterEach(async () => {
  while (managers.length > 0) {
    const m = managers.pop()!;
    await m.disposeAll();
  }
});

function createManager(opts: { onSettled?: (info: SettledInfo) => void; maxRunning?: number } = {}) {
  const sessionKey = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const m = new TerminalManager({
    sessionKey,
    maxRunning: opts.maxRunning ?? 8,
    maxTracked: 8,
    killGraceMs: 500,
    onSettled: opts.onSettled,
  });
  managers.push(m);
  return m;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe("TerminalManager", () => {
  it("starts a short command, settles as done, and captures stdout", async () => {
    const settled: SettledInfo[] = [];
    const m = createManager({ onSettled: (info) => settled.push(info) });

    const snap = await m.start({
      command: "printf 'hello-bg\\n'",
      title: "echo",
      cwd: process.cwd(),
    });
    assert.equal(snap.status, "running");
    assert.match(snap.id, /^bt-\d+$/);
    assert.ok(snap.pid !== undefined);

    await sleep(800);
    const after = m.get(snap.id);
    assert.ok(after);
    assert.equal(after.status, "done");
    assert.equal(after.exitCode, 0);
    assert.match(after.stdout.text, /hello-bg/);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.consumed, false);
    assert.equal(settled[0]!.snapshot.status, "done");
  });

  it("records failed status for non-zero exit", async () => {
    const m = createManager();
    const snap = await m.start({
      command: "exit 7",
      title: "fail",
      cwd: process.cwd(),
    });
    await sleep(800);
    const after = m.get(snap.id)!;
    assert.equal(after.status, "failed");
    assert.equal(after.exitCode, 7);
  });

  it("kills a long-running process and marks consumed", async () => {
    const settled: SettledInfo[] = [];
    const m = createManager({ onSettled: (info) => settled.push(info) });
    const snap = await m.start({
      command: "sleep 30",
      title: "sleeper",
      cwd: process.cwd(),
    });
    assert.equal(snap.status, "running");

    const results = await m.kill([snap.id]);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.alreadySettled, false);

    const after = m.get(snap.id)!;
    assert.equal(after.status, "killed");
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.consumed, true);
  });

  it("lists running and completed terminals", async () => {
    const m = createManager();
    await m.start({ command: "printf a", title: "a", cwd: process.cwd() });
    await m.start({ command: "printf b", title: "b", cwd: process.cwd() });
    await sleep(800);
    const list = m.list();
    assert.equal(list.length, 2);
    assert.ok(list.every((s) => s.status === "done"));
  });

  it("enforces concurrency limit", async () => {
    const m = createManager({ maxRunning: 1 });
    await m.start({ command: "sleep 10", title: "one", cwd: process.cwd() });
    await assert.rejects(
      () => m.start({ command: "sleep 10", title: "two", cwd: process.cwd() }),
      /Concurrency limit/,
    );
  });

  it("rejects unknown kill ids", async () => {
    const m = createManager();
    await assert.rejects(() => m.kill(["bt-999"]), /Unknown terminal/);
  });

  it("rejects missing working directory", async () => {
    const m = createManager();
    const missing = join(tmpdir(), `no-such-dir-${Date.now()}`);
    await assert.rejects(
      () => m.start({ command: "true", title: "x", cwd: missing }),
      /Working directory/,
    );
  });

  it("disposeAll stops running processes without leaking", async () => {
    const m = createManager();
    const snap = await m.start({
      command: "sleep 60",
      title: "leak-check",
      cwd: process.cwd(),
    });
    const pid = snap.pid!;
    await m.disposeAll();
    // Remove from afterEach list since already disposed.
    const idx = managers.indexOf(m);
    if (idx >= 0) managers.splice(idx, 1);

    // Process should be gone (or reaped). ESRCH means not found — success.
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    assert.equal(alive, false);
  });
});

describe("ResultDelivery", () => {
  it("enqueues and drains once", () => {
    const d = new ResultDelivery<string>();
    d.enqueue("a", "one");
    d.enqueue("b", "two");
    assert.equal(d.take("a"), "one");
    assert.equal(d.take("a"), undefined);
    d.consume(["b"]);
    assert.equal(d.take("b"), undefined);
  });

  it("drainAll clears pending", () => {
    const d = new ResultDelivery<number>();
    d.enqueue("x", 1);
    d.enqueue("y", 2);
    const all = d.drainAll();
    assert.equal(all.length, 2);
    assert.equal(d.drainAll().length, 0);
  });
});

describe("spill session isolation", () => {
  it("uses distinct session keys without collision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bt-sess-"));
    // Managers use their own tmp spill dirs keyed by session; just ensure two managers work.
    const a = createManager();
    const b = createManager();
    await a.start({ command: "printf a", title: "a", cwd: dir });
    await b.start({ command: "printf b", title: "b", cwd: dir });
    await sleep(600);
    assert.equal(a.list().length, 1);
    assert.equal(b.list().length, 1);
    await rm(dir, { recursive: true, force: true });
  });
});
