import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { abortPromise, sleep } from "../shared/time.ts";
import { startCodexBackend } from "./backends/codex.ts";
import { startPiBackend, type BackendJob } from "./backends/pi.ts";
import type {
  BackendName,
  SettledInfo,
  SpawnOptions,
  SubagentSnapshot,
  SubagentStatus,
} from "./domain.ts";
import { appendBounded } from "./run.ts";

const DEFAULT_MAX_RUNNING = 4;
const DEFAULT_MAX_TRACKED = 32;
const DEFAULT_KILL_GRACE_MS = 3000;
const OUTPUT_TAIL_CHARS = 24_000;

type Entry = {
  id: string;
  backend: BackendName;
  title: string;
  prompt: string;
  cwd: string;
  model?: string;
  thinking?: string;
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
  maxRunning?: number;
  maxTracked?: number;
  killGraceMs?: number;
  onSettled?: (info: SettledInfo) => void;
  onChange?: () => void;
  /** Inject backends for tests. */
  starters?: {
    pi?: typeof startPiBackend;
    codex?: typeof startCodexBackend;
  };
};

export class SubagentManager {
  private entries = new Map<string, Entry>();
  private counter = 0;
  private disposed = false;
  private waitInterest = new Map<string, number>();
  private readonly maxRunning: number;
  private readonly maxTracked: number;
  private readonly killGraceMs: number;
  private onSettled?: (info: SettledInfo) => void;
  private onChange?: () => void;
  private starters: {
    pi: typeof startPiBackend;
    codex: typeof startCodexBackend;
  };

  constructor(options: ManagerOptions = {}) {
    this.maxRunning = options.maxRunning ?? DEFAULT_MAX_RUNNING;
    this.maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.onSettled = options.onSettled;
    this.onChange = options.onChange;
    this.starters = {
      pi: options.starters?.pi ?? startPiBackend,
      codex: options.starters?.codex ?? startCodexBackend,
    };
  }

  private notify() {
    this.onChange?.();
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
      backend: entry.backend,
      title: entry.title,
      prompt: entry.prompt,
      cwd: entry.cwd,
      model: entry.model,
      thinking: entry.thinking,
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

  async spawn(options: SpawnOptions): Promise<SubagentSnapshot> {
    if (this.disposed) throw new Error("Subagent manager is disposed.");
    if (this.runningCount() >= this.maxRunning) {
      throw new Error(
        `Concurrency limit: at most ${this.maxRunning} subagents may run at once.`,
      );
    }
    if (options.backend !== "pi" && options.backend !== "codex") {
      throw new Error(`Unsupported backend: ${options.backend}. Only pi and codex are allowed.`);
    }

    const prompt = options.prompt.trim();
    if (!prompt) throw new Error("prompt must not be empty");

    const cwd = resolve(options.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`Working directory does not exist or is not a directory: ${cwd}`);
    }

    this.counter += 1;
    const id = `sa-${this.counter}`;
    const title =
      (options.title?.trim().slice(0, 80) || `${options.backend} subagent ${id}`);

    let resolveSettle!: () => void;
    const settlePromise = new Promise<void>((r) => {
      resolveSettle = r;
    });

    const entry: Entry = {
      id,
      backend: options.backend,
      title,
      prompt,
      cwd,
      model: options.model,
      thinking: options.thinking,
      status: "running",
      createdAt: Date.now(),
      outputTail: "",
      killSignaled: false,
      settlePromise,
      resolveSettle,
    };

    const onOutput = (chunk: string) => {
      entry.outputTail = appendBounded(entry.outputTail, chunk, OUTPUT_TAIL_CHARS);
      this.notify();
    };

    let job: BackendJob;
    try {
      if (options.backend === "pi") {
        job = await this.starters.pi({
          prompt,
          cwd,
          model: options.model,
          thinking: options.thinking,
          onOutput,
        });
      } else {
        job = await this.starters.codex({
          prompt,
          cwd,
          model: options.model,
          reasoningEffort: options.thinking ?? "high",
          onOutput,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start ${options.backend} subagent: ${message}`);
    }

    entry.job = job;
    entry.pid = job.handle.pid;
    this.entries.set(id, entry);
    this.notify();

    // Background collection — never await here.
    void this.collectEntry(entry, job);

    return this.snapshotOf(entry);
  }

  private async collectEntry(entry: Entry, job: BackendJob) {
    try {
      const result = await job.collect();
      if (entry.status !== "running") return;

      if (entry.killSignaled) {
        await this.settle(entry, {
          status: "killed",
          exitCode: result.exitCode,
          signal: result.signal,
          resultText: result.resultText || undefined,
          errorText: result.errorText,
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

    const consumed = (this.waitInterest.get(entry.id) ?? 0) > 0;
    entry.resolveSettle();
    this.pruneSettled();
    this.notify();

    if (!this.disposed) {
      this.onSettled?.({ snapshot: this.snapshotOf(entry), consumed });
    }
  }

  private pruneSettled() {
    const settled = [...this.entries.values()]
      .filter((e) => e.status !== "running")
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
    while (settled.length > this.maxTracked) {
      const oldest = settled.shift();
      if (!oldest) break;
      this.entries.delete(oldest.id);
    }
  }

  private addInterest(id: string) {
    this.waitInterest.set(id, (this.waitInterest.get(id) ?? 0) + 1);
  }

  private releaseInterest(id: string) {
    const n = (this.waitInterest.get(id) ?? 0) - 1;
    if (n <= 0) this.waitInterest.delete(id);
    else this.waitInterest.set(id, n);
  }

  async wait(ids: readonly string[], signal?: AbortSignal): Promise<SubagentSnapshot[]> {
    if (this.disposed) throw new Error("Subagent manager is disposed.");
    const unknown = ids.filter((id) => !this.entries.has(id));
    if (unknown.length > 0) throw new Error(`Unknown subagent id(s): ${unknown.join(", ")}`);

    for (const id of ids) this.addInterest(id);
    try {
      const waits = ids.map((id) => this.entries.get(id)!.settlePromise);
      await Promise.race([
        Promise.all(waits),
        abortPromise(signal, "Wait aborted; subagents continue in the background."),
      ]);
    } finally {
      for (const id of ids) this.releaseInterest(id);
    }
    return ids.map((id) => this.snapshotOf(this.entries.get(id)!));
  }

  async cancel(ids: readonly string[], signal?: AbortSignal): Promise<SubagentSnapshot[]> {
    if (this.disposed) throw new Error("Subagent manager is disposed.");
    const unknown = ids.filter((id) => !this.entries.has(id));
    if (unknown.length > 0) throw new Error(`Unknown subagent id(s): ${unknown.join(", ")}`);

    const waiting: Promise<void>[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id)!;
      if (entry.status !== "running") continue;
      this.addInterest(id);
      entry.killSignaled = true;
      entry.job?.handle.kill("SIGTERM");
      setTimeout(() => {
        if (entry.status === "running") entry.job?.handle.kill("SIGKILL");
      }, this.killGraceMs).unref?.();
      waiting.push(
        entry.settlePromise.finally(() => {
          this.releaseInterest(id);
        }),
      );
    }

    if (waiting.length > 0) {
      await Promise.race([
        Promise.all(waiting),
        abortPromise(signal, "Cancel wait aborted; termination continues in the background."),
      ]);
    }

    return ids.map((id) => this.snapshotOf(this.entries.get(id)!));
  }

  async disposeAll() {
    if (this.disposed) return;
    this.disposed = true;
    const running = [...this.entries.values()].filter((e) => e.status === "running");
    for (const entry of running) {
      this.addInterest(entry.id);
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
