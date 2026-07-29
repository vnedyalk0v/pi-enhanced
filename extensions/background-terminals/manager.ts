import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { InterestTracker, pruneSettled } from "../shared/lifecycle.ts";
import { abortPromise, sleep } from "../shared/time.ts";
import {
  createSpillDir,
  OutputBuffer,
  openSpillStreams,
  removeSpillDir,
  type OutputView,
} from "./output.ts";

export type TerminalStatus = "running" | "done" | "failed" | "killed";

export type TerminalSnapshot = {
  id: string;
  command: string;
  title: string;
  cwd: string;
  pid?: number;
  status: TerminalStatus;
  createdAt: number;
  settledAt?: number;
  exitCode?: number;
  signal?: string;
  errorText?: string;
  stdout: OutputView;
  stderr: OutputView;
};

export type StartOptions = {
  command: string;
  title: string;
  cwd: string;
};

export type KillResult = {
  id: string;
  snapshot: TerminalSnapshot;
  alreadySettled: boolean;
};

export type SettledInfo = {
  snapshot: TerminalSnapshot;
  /** True when bg_kill (or similar) already collected the result — skip async message. */
  consumed: boolean;
};

export type ManagerOptions = {
  sessionKey: string;
  maxRunning?: number;
  maxTracked?: number;
  killGraceMs?: number;
  onSettled?: (info: SettledInfo) => void;
  onChange?: () => void;
};

type Entry = {
  id: string;
  command: string;
  title: string;
  cwd: string;
  pid?: number;
  status: TerminalStatus;
  createdAt: number;
  settledAt?: number;
  exitCode?: number;
  signal?: string;
  errorText?: string;
  stdout: OutputBuffer;
  stderr: OutputBuffer;
  child?: ChildProcess;
  killSignaled: boolean;
  settlePromise: Promise<void>;
  resolveSettle: () => void;
};

const DEFAULT_MAX_RUNNING = 8;
const DEFAULT_MAX_TRACKED = 32;
const DEFAULT_KILL_GRACE_MS = 2000;
const OUTPUT_NOTIFY_INTERVAL_MS = 100;

export class TerminalManager {
  private entries = new Map<string, Entry>();
  private counter = 0;
  private startingCount = 0;
  private disposed = false;
  private killInterest = new InterestTracker();
  private listeners = new Set<() => void>();
  private outputNotifyTimer?: ReturnType<typeof setTimeout>;
  private spillDirPromise?: Promise<string>;
  private spillOpenings = new Set<Promise<Awaited<ReturnType<typeof openSpillStreams>>>>();
  private readonly maxRunning: number;
  private readonly maxTracked: number;
  private readonly killGraceMs: number;
  private onSettled?: (info: SettledInfo) => void;
  private onChange?: () => void;

  constructor(options: ManagerOptions) {
    this.maxRunning = options.maxRunning ?? DEFAULT_MAX_RUNNING;
    this.maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.onSettled = options.onSettled;
    this.onChange = options.onChange;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    if (this.outputNotifyTimer) {
      clearTimeout(this.outputNotifyTimer);
      this.outputNotifyTimer = undefined;
    }
    this.onChange?.();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // UI listeners must not break process bookkeeping.
      }
    }
  }

  private notifyOutput() {
    if (this.disposed || this.outputNotifyTimer) return;
    this.outputNotifyTimer = setTimeout(() => {
      this.outputNotifyTimer = undefined;
      this.notify();
    }, OUTPUT_NOTIFY_INTERVAL_MS);
    this.outputNotifyTimer.unref?.();
  }

  getRunningCount() {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.status === "running") n++;
    }
    return n;
  }

  private snapshotOf(entry: Entry): TerminalSnapshot {
    return {
      id: entry.id,
      command: entry.command,
      title: entry.title,
      cwd: entry.cwd,
      pid: entry.pid,
      status: entry.status,
      createdAt: entry.createdAt,
      settledAt: entry.settledAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      errorText: entry.errorText,
      stdout: entry.stdout.view(),
      stderr: entry.stderr.view(),
    };
  }

  list(): TerminalSnapshot[] {
    return [...this.entries.values()].map((e) => this.snapshotOf(e));
  }

  get(id: string): TerminalSnapshot | undefined {
    const entry = this.entries.get(id);
    return entry ? this.snapshotOf(entry) : undefined;
  }

  async start(options: StartOptions): Promise<TerminalSnapshot> {
    if (this.disposed) {
      throw new Error("Background terminal manager is disposed.");
    }
    if (this.getRunningCount() + this.startingCount >= this.maxRunning) {
      throw new Error(
        `Concurrency limit: at most ${this.maxRunning} background terminals may run at once.`,
      );
    }

    const cwd = resolve(options.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`Working directory does not exist or is not a directory: ${cwd}`);
    }

    const command = options.command.trim();
    if (!command) {
      throw new Error("command must not be empty");
    }
    const title = (options.title.trim().slice(0, 80) || "terminal");

    this.startingCount += 1;
    this.counter += 1;
    const id = `bt-${this.counter}`;

    const spillOpening = this.openSpillStreams(id);
    this.spillOpenings.add(spillOpening);
    let spill: Awaited<typeof spillOpening>;
    try {
      spill = await spillOpening;
    } catch (error) {
      this.startingCount -= 1;
      throw error;
    } finally {
      this.spillOpenings.delete(spillOpening);
    }
    if (this.disposed) {
      this.startingCount -= 1;
      spill.stdout.stream.end();
      spill.stderr.stream.end();
      await removeSpillFiles(spill);
      throw new Error("Background terminal manager is disposed.");
    }
    const stdout = new OutputBuffer(undefined, spill.stdout);
    const stderr = new OutputBuffer(undefined, spill.stderr);

    let resolveSettle!: () => void;
    const settlePromise = new Promise<void>((resolveSettleFn) => {
      resolveSettle = resolveSettleFn;
    });

    const entry: Entry = {
      id,
      command,
      title,
      cwd,
      status: "running",
      createdAt: Date.now(),
      stdout,
      stderr,
      killSignaled: false,
      settlePromise,
      resolveSettle,
    };

    const isWin = process.platform === "win32";
    const shell = isWin ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh";
    const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

    let child: ChildProcess;
    try {
      child = spawn(shell, shellArgs, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: !isWin,
        windowsHide: true,
      });
    } catch (error) {
      try {
        await stdout.close();
        await stderr.close();
        await removeSpillFiles(spill);
      } finally {
        this.startingCount -= 1;
      }
      throw new Error(boundedError(error));
    }

    entry.child = child;
    entry.pid = child.pid;

    // ENOENT and similar often arrive on 'error' rather than throw from spawn.
    let spawnFailed = false;
    child.once("error", (error) => {
      spawnFailed = true;
      entry.errorText = boundedError(error);
    });

    const captureOutput = (stream: Readable | null, output: OutputBuffer) => {
      if (!stream) return;
      const decoder = new StringDecoder("utf8");
      let waitingForDrain = false;
      const push = (text: string) => {
        if (!text) return;
        if (!output.push(text)) {
          stream.pause();
          if (!waitingForDrain) {
            waitingForDrain = true;
            void output.waitForDrain().then(() => {
              waitingForDrain = false;
              if (entry.status === "running") stream.resume();
            });
          }
        }
        this.notifyOutput();
      };
      // A multi-byte UTF-8 char can straddle two chunks; StringDecoder carries
      // partial bytes across writes instead of emitting U+FFFD per split char.
      stream.on("data", (buf: Buffer) => push(decoder.write(buf)));
      stream.on("end", () => push(decoder.end()));
    };
    captureOutput(child.stdout, entry.stdout);
    captureOutput(child.stderr, entry.stderr);

    child.once("close", (code, signal) => {
      if (spawnFailed) {
        void this.settle(entry, {
          status: "failed",
          errorText: entry.errorText,
        });
        return;
      }
      const killSignaled = entry.killSignaled;
      if (killSignaled) {
        void this.settle(entry, {
          status: "killed",
          exitCode: code ?? undefined,
          signal: signal ?? undefined,
        });
        return;
      }
      if (signal) {
        void this.settle(entry, {
          status: "failed",
          signal,
          exitCode: code ?? undefined,
        });
        return;
      }
      if (code === 0) {
        void this.settle(entry, { status: "done", exitCode: 0 });
      } else {
        void this.settle(entry, {
          status: "failed",
          exitCode: code ?? 1,
        });
      }
    });

    this.entries.set(id, entry);
    this.startingCount -= 1;
    this.notify();
    return this.snapshotOf(entry);
  }

  private async settle(
    entry: Entry,
    result: {
      status: Exclude<TerminalStatus, "running">;
      exitCode?: number;
      signal?: string;
      errorText?: string;
    },
  ) {
    if (entry.status !== "running") return;

    entry.status = result.status;
    entry.settledAt = Date.now();
    entry.exitCode = result.exitCode;
    entry.signal = result.signal;
    if (result.errorText) entry.errorText = result.errorText;
    entry.child = undefined;

    await entry.stdout.close();
    await entry.stderr.close();

    const consumed = this.killInterest.has(entry.id);
    entry.resolveSettle();
    pruneSettled(
      this.entries,
      this.maxTracked,
      (e) => e.status === "running" || this.killInterest.has(e.id),
    );
    this.notify();

    if (!this.disposed) {
      this.onSettled?.({ snapshot: this.snapshotOf(entry), consumed });
    }
  }

  /**
   * Stop terminals. Marks kill interest so async completion is not also delivered.
   * Resolves when each targeted running process has settled, unless aborted.
   * Termination continues even if the wait is aborted.
   */
  async kill(ids: readonly string[], signal?: AbortSignal): Promise<KillResult[]> {
    if (this.disposed) {
      throw new Error("Background terminal manager is disposed.");
    }

    const unknown = ids.filter((id) => !this.entries.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown terminal id(s): ${unknown.join(", ")}`);
    }

    const results: KillResult[] = [];
    const waiting: Promise<void>[] = [];
    const interested: string[] = [];

    for (const id of ids) {
      const entry = this.entries.get(id)!;
      if (entry.status !== "running") {
        results.push({
          id,
          snapshot: this.snapshotOf(entry),
          alreadySettled: true,
        });
        continue;
      }

      this.killInterest.add(id);
      interested.push(id);
      entry.killSignaled = true;
      void this.terminateChild(entry);

      waiting.push(entry.settlePromise);
      results.push({
        id,
        snapshot: this.snapshotOf(entry),
        alreadySettled: false,
      });
    }

    if (waiting.length === 0) return results;

    try {
      await Promise.race([
        Promise.all(waiting),
        abortPromise(signal, "Kill wait aborted; termination continues in the background."),
      ]);

      // Refresh snapshots after settle when wait completed.
      return results.map((r) => {
        const snap = this.get(r.id);
        return snap ? { ...r, snapshot: snap } : r;
      });
    } finally {
      for (const id of interested) this.killInterest.release(id);
    }
  }

  private async terminateChild(entry: Entry) {
    const child = entry.child;
    if (!child || child.killed) return;

    const pid = child.pid;
    if (pid === undefined) return;

    try {
      if (process.platform === "win32") {
        await runTaskKill(pid, false);
      } else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            // already gone
          }
        }
      }
    } catch {
      // process may have already exited
    }

    const settled = await Promise.race([
      entry.settlePromise.then(() => true),
      sleep(this.killGraceMs).then(() => false),
    ]);
    if (settled || entry.status !== "running") return;

    try {
      if (process.platform === "win32") {
        await runTaskKill(pid, true);
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    } catch {
      // ignore
    }
  }

  async disposeAll() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.outputNotifyTimer) {
      clearTimeout(this.outputNotifyTimer);
      this.outputNotifyTimer = undefined;
    }

    const running = [...this.entries.values()].filter((e) => e.status === "running");
    for (const entry of running) {
      this.killInterest.add(entry.id);
      entry.killSignaled = true;
      void this.terminateChild(entry);
    }

    await Promise.race([
      Promise.all(running.map((e) => e.settlePromise)),
      sleep(this.killGraceMs + 1000),
    ]);

    for (const entry of this.entries.values()) {
      await entry.stdout.close();
      await entry.stderr.close();
    }

    this.entries.clear();
    this.listeners.clear();
    this.killInterest.clear();
    await Promise.allSettled([...this.spillOpenings]);
    const spillDir = await this.spillDirPromise?.catch(() => undefined);
    if (spillDir) await removeSpillDir(spillDir);
    this.notify();
  }

  private async openSpillStreams(id: string) {
    this.spillDirPromise ??= createSpillDir().catch((error) => {
      this.spillDirPromise = undefined;
      throw error;
    });
    const dir = await this.spillDirPromise;
    if (this.disposed) throw new Error("Background terminal manager is disposed.");
    return openSpillStreams(dir, id);
  }
}

async function removeSpillFiles(spill: {
  stdout: { path: string };
  stderr: { path: string };
}) {
  await Promise.all([
    rm(spill.stdout.path, { force: true }).catch(() => {}),
    rm(spill.stderr.path, { force: true }).catch(() => {}),
  ]);
}

function boundedError(error: unknown, max = 500) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function runTaskKill(pid: number, force: boolean) {
  await new Promise<void>((resolve) => {
    const args = force ? ["/pid", String(pid), "/t", "/f"] : ["/pid", String(pid), "/t"];
    const child = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}
