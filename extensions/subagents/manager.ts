import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  InterestTracker,
  pruneSettled,
  resolveLimit,
  type LimitValue,
} from "../shared/lifecycle.ts";
import { abortPromise, sleep } from "../shared/time.ts";
import { startPiBackend, type BackendJob } from "./backend.ts";
import type { SettledInfo, SpawnOptions, SubagentSnapshot, SubagentStatus } from "./domain.ts";
import { appendBounded } from "./run.ts";

const DEFAULT_MAX_RUNNING = 4;
const DEFAULT_MAX_TRACKED = 32;
const DEFAULT_KILL_GRACE_MS = 3000;
// ponytail: fixed ceiling, not per-task tuning; raise via ManagerOptions.maxRuntimeMs
// or package config (pe-settings / pi-enhanced.json) if a task needs longer than 30 minutes.
const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
const OUTPUT_TAIL_CHARS = 24_000;
const OUTPUT_NOTIFY_INTERVAL_MS = 100;

type Entry = {
  id: string;
  agent?: string;
  title: string;
  prompt: string;
  cwd: string;
  model?: string;
  thinking?: string;
  quiet?: boolean;
  status: SubagentStatus;
  createdAt: number;
  settledAt?: number;
  exitCode?: number;
  signal?: string;
  errorText?: string;
  outputTail: string;
  resultText?: string;
  pid?: number;
  job?: BackendJob;
  killSignaled: boolean;
  settlePromise: Promise<void>;
  resolveSettle: () => void;
};

export type ManagerOptions = {
  maxRunning?: LimitValue;
  maxTracked?: number;
  killGraceMs?: number;
  /** Force-kill a subagent that runs longer than this (default 30 minutes). */
  maxRuntimeMs?: LimitValue;
  onSettled?: (info: SettledInfo) => void;
  onChange?: () => void;
  /** Inject the backend starter for tests. */
  starter?: typeof startPiBackend;
};

export class SubagentManager {
  private entries = new Map<string, Entry>();
  private counter = 0;
  private startingCount = 0;
  private disposed = false;
  private waitInterest = new InterestTracker();
  private readonly maxRunningOpt: LimitValue | undefined;
  private readonly maxTracked: number;
  private readonly killGraceMs: number;
  private readonly maxRuntimeMsOpt: LimitValue | undefined;
  private onSettled?: (info: SettledInfo) => void;
  private onChange?: () => void;
  private readonly starter: typeof startPiBackend;

  constructor(options: ManagerOptions = {}) {
    this.maxRunningOpt = options.maxRunning;
    this.maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.maxRuntimeMsOpt = options.maxRuntimeMs;
    this.onSettled = options.onSettled;
    this.onChange = options.onChange;
    this.starter = options.starter ?? startPiBackend;
  }

  private maxRunning() {
    return resolveLimit(this.maxRunningOpt, DEFAULT_MAX_RUNNING);
  }

  private maxRuntimeMs() {
    return resolveLimit(this.maxRuntimeMsOpt, DEFAULT_MAX_RUNTIME_MS);
  }

  private readonly listeners = new Set<() => void>();
  private outputNotifyTimer?: ReturnType<typeof setTimeout>;

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
    try {
      this.onChange?.();
    } catch {
      // UI listeners must not break process bookkeeping.
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // UI listeners must not break process bookkeeping.
      }
    }
  }

  /** Coalesced notify for streamed output, so /sa follows a running worker. */
  private notifyOutput() {
    if (this.disposed || this.outputNotifyTimer) return;
    this.outputNotifyTimer = setTimeout(() => {
      this.outputNotifyTimer = undefined;
      this.notify();
    }, OUTPUT_NOTIFY_INTERVAL_MS);
    this.outputNotifyTimer.unref?.();
  }

  private pruneAfterInterestRelease() {
    const size = this.entries.size;
    pruneSettled(
      this.entries,
      this.maxTracked,
      (e) => e.status === "running" || this.waitInterest.has(e.id),
    );
    if (this.entries.size < size) this.notify();
  }

  private runningCount() {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.status === "running") n++;
    }
    return n;
  }

  private snapshotOf(entry: Entry): SubagentSnapshot {
    return {
      id: entry.id,
      agent: entry.agent,
      title: entry.title,
      prompt: entry.prompt,
      cwd: entry.cwd,
      model: entry.model,
      thinking: entry.thinking,
      quiet: entry.quiet,
      status: entry.status,
      createdAt: entry.createdAt,
      settledAt: entry.settledAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      errorText: entry.errorText,
      outputTail: entry.outputTail,
      resultText: entry.resultText,
      pid: entry.pid,
    };
  }

  list(): SubagentSnapshot[] {
    return [...this.entries.values()].map((e) => this.snapshotOf(e));
  }

  get(id: string) {
    const e = this.entries.get(id);
    return e ? this.snapshotOf(e) : undefined;
  }

  async spawn(options: SpawnOptions & { signal?: AbortSignal }): Promise<SubagentSnapshot> {
    if (this.disposed) throw new Error("Subagent manager is disposed.");
    options.signal?.throwIfAborted();
    const maxRunning = this.maxRunning();
    if (this.runningCount() + this.startingCount >= maxRunning) {
      throw new Error(
        `Concurrency limit: at most ${maxRunning} subagents may run at once.`,
      );
    }

    const prompt = options.prompt.trim();
    if (!prompt) throw new Error("prompt must not be empty");

    const cwd = resolve(options.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`Working directory does not exist or is not a directory: ${cwd}`);
    }

    this.startingCount += 1;
    this.counter += 1;
    const id = `sa-${this.counter}`;
    const title = options.title?.trim().slice(0, 80) || `subagent ${id}`;

    let resolveSettle!: () => void;
    const settlePromise = new Promise<void>((r) => {
      resolveSettle = r;
    });

    const entry: Entry = {
      id,
      agent: options.agent,
      title,
      prompt,
      cwd,
      model: options.model,
      thinking: options.thinking,
      quiet: options.quiet,
      status: "running",
      createdAt: Date.now(),
      outputTail: "",
      killSignaled: false,
      settlePromise,
      resolveSettle,
    };

    const onOutput = (chunk: string) => {
      entry.outputTail = appendBounded(entry.outputTail, chunk, OUTPUT_TAIL_CHARS);
      this.notifyOutput();
    };

    let job: BackendJob;
    try {
      try {
        job = await this.starter({
          prompt,
          cwd,
          model: options.model,
          thinking: options.thinking,
          tools: options.tools,
          extensionPath: options.extensionPath,
          systemPromptAppend: options.systemPromptAppend,
          signal: options.signal,
          onOutput,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to start subagent: ${message}`);
      }

      if (this.disposed || options.signal?.aborted) {
        job.handle.kill("SIGKILL");
        await job.collect().catch(() => {});
        if (this.disposed) throw new Error("Subagent manager is disposed.");
        if (options.signal) options.signal.throwIfAborted();
        throw new Error("Subagent start aborted.");
      }

      entry.job = job;
      entry.pid = job.handle.pid;
      this.entries.set(id, entry);
      this.notify();

      // Background collection — never await here.
      // Resolve the runtime limit before the detached collector runs so a
      // failing package-config getter cannot race past a successful start.
      const maxRuntimeMs = this.maxRuntimeMs();
      void this.collectEntry(entry, job, maxRuntimeMs);

      return this.snapshotOf(entry);
    } finally {
      this.startingCount -= 1;
    }
  }

  private async collectEntry(entry: Entry, job: BackendJob, maxRuntimeMs: number) {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      entry.killSignaled = true;
      job.handle.kill("SIGTERM");
      setTimeout(() => job.handle.kill("SIGKILL"), this.killGraceMs).unref?.();
    }, maxRuntimeMs);
    timer.unref?.();

    try {
      const result = await job.collect();
      clearTimeout(timer);
      if (entry.status !== "running") return;

      if (entry.killSignaled) {
        await this.settle(entry, {
          status: "killed",
          exitCode: result.exitCode,
          signal: result.signal,
          resultText: result.resultText || undefined,
          errorText: timedOut
            ? `Killed: exceeded max runtime of ${Math.round(maxRuntimeMs / 60_000)}m`
            : result.errorText,
          output: result.output,
        });
        return;
      }

      if (result.exitCode === 0) {
        await this.settle(entry, {
          status: "done",
          exitCode: 0,
          resultText: result.resultText || "(no final message)",
          output: result.output,
        });
      } else {
        await this.settle(entry, {
          status: "failed",
          exitCode: result.exitCode,
          signal: result.signal,
          resultText: result.resultText || undefined,
          errorText: result.errorText || `exit ${result.exitCode}`,
          output: result.output,
        });
      }
    } catch (error) {
      clearTimeout(timer);
      if (entry.status !== "running") return;
      const message = error instanceof Error ? error.message : String(error);
      await this.settle(entry, {
        status: entry.killSignaled ? "killed" : "failed",
        errorText: message,
        output: entry.outputTail,
      });
    }
  }

  private async settle(
    entry: Entry,
    result: {
      status: Exclude<SubagentStatus, "running">;
      exitCode?: number;
      signal?: string;
      resultText?: string;
      errorText?: string;
      output?: string;
    },
  ) {
    if (entry.status !== "running") return;
    entry.status = result.status;
    entry.settledAt = Date.now();
    entry.exitCode = result.exitCode;
    entry.signal = result.signal;
    entry.resultText = result.resultText;
    entry.errorText = result.errorText;
    if (result.output) {
      entry.outputTail = appendBounded("", result.output, OUTPUT_TAIL_CHARS);
    }
    entry.job = undefined;

    const consumed = this.waitInterest.has(entry.id);
    entry.resolveSettle();
    pruneSettled(
      this.entries,
      this.maxTracked,
      (e) => e.status === "running" || this.waitInterest.has(e.id),
    );
    this.notify();

    if (!this.disposed) {
      try {
        this.onSettled?.({ snapshot: this.snapshotOf(entry), consumed });
      } catch {
        // Completion listeners must not break settle bookkeeping.
      }
    }
  }

  async wait(ids: readonly string[], signal?: AbortSignal): Promise<SubagentSnapshot[]> {
    if (this.disposed) throw new Error("Subagent manager is disposed.");
    const unknown = ids.filter((id) => !this.entries.has(id));
    if (unknown.length > 0) throw new Error(`Unknown subagent id(s): ${unknown.join(", ")}`);

    for (const id of ids) this.waitInterest.add(id);
    try {
      const waits = ids.map((id) => this.entries.get(id)!.settlePromise);
      await Promise.race([
        Promise.all(waits),
        abortPromise(signal, "Wait aborted; subagents continue in the background."),
      ]);
      // disposeAll may clear entries between the settle and this continuation.
      if (this.disposed) throw new Error("Subagent manager was disposed during wait.");
      return ids.map((id) => this.snapshotOf(this.entries.get(id)!));
    } finally {
      for (const id of ids) this.waitInterest.release(id);
      this.pruneAfterInterestRelease();
    }
  }

  async cancel(ids: readonly string[], signal?: AbortSignal): Promise<SubagentSnapshot[]> {
    if (this.disposed) throw new Error("Subagent manager is disposed.");
    const unknown = ids.filter((id) => !this.entries.has(id));
    if (unknown.length > 0) throw new Error(`Unknown subagent id(s): ${unknown.join(", ")}`);

    for (const id of ids) this.waitInterest.add(id);
    try {
      const waiting: Promise<void>[] = [];
      for (const id of ids) {
        const entry = this.entries.get(id)!;
        if (entry.status !== "running") continue;
        entry.killSignaled = true;
        entry.job?.handle.kill("SIGTERM");
        setTimeout(() => {
          if (entry.status === "running") entry.job?.handle.kill("SIGKILL");
        }, this.killGraceMs).unref?.();
        waiting.push(entry.settlePromise);
      }

      if (waiting.length > 0) {
        await Promise.race([
          Promise.all(waiting),
          abortPromise(signal, "Cancel wait aborted; termination continues in the background."),
        ]);
      }
      // disposeAll may clear entries between the settle and this continuation.
      if (this.disposed) throw new Error("Subagent manager was disposed during cancel.");
      return ids.map((id) => this.snapshotOf(this.entries.get(id)!));
    } finally {
      for (const id of ids) {
        const entry = this.entries.get(id);
        if (entry?.status === "running") {
          void entry.settlePromise
            .then(() => {
              this.waitInterest.release(id);
              this.pruneAfterInterestRelease();
            })
            .catch(() => {});
        } else {
          this.waitInterest.release(id);
        }
      }
      this.pruneAfterInterestRelease();
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
      this.waitInterest.add(entry.id);
      entry.killSignaled = true;
      entry.job?.handle.kill("SIGTERM");
    }
    await Promise.race([
      Promise.all(running.map((e) => e.settlePromise)),
      sleep(this.killGraceMs + 1000),
    ]);
    for (const entry of running) {
      if (entry.status === "running") entry.job?.handle.kill("SIGKILL");
    }
    this.entries.clear();
    this.waitInterest.clear();
    this.notify();
  }
}
