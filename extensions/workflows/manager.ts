import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { abortPromise, sleep } from "../shared/time.ts";
import type { ManagerOptions as SubagentManagerOptions } from "../subagents/manager.ts";
import { SubagentManager } from "../subagents/manager.ts";
import { phaseDir, writeFinalArtifact, writeTaskArtifact } from "./artifacts.ts";
import type {
  PhaseRunSnapshot,
  StartWorkflowOptions,
  StructuredOutput,
  TaskRunSnapshot,
  WorkflowSnapshot,
  WorkflowStatus,
  WorkflowTaskDef,
} from "./domain.ts";
import { buildTaskPrompt, extractSummary, validateStructuredOutput } from "./handoff.ts";
import { REPO_TASK_PHASES } from "./template.ts";

const DEFAULT_MAX_RUNNING = 1;
const DEFAULT_MAX_TRACKED = 16;

type PhaseRuntime = {
  name: string;
  status: PhaseRunSnapshot["status"];
  tasks: Map<string, TaskRunSnapshot>;
};

type Entry = {
  id: string;
  title: string;
  goal: string;
  cwd: string;
  model?: string;
  thinking?: string;
  status: WorkflowStatus;
  createdAt: number;
  settledAt?: number;
  currentPhase?: string;
  artifactsDir: string;
  phases: PhaseRuntime[];
  priorOutputs: StructuredOutput[];
  finalArtifactPath?: string;
  finalSummary?: string;
  errorText?: string;
  failedTaskCount: number;
  cancelRequested: boolean;
  settlePromise: Promise<void>;
  resolveSettle: () => void;
  subagents: SubagentManager;
};

export type WorkflowSettledInfo = {
  snapshot: WorkflowSnapshot;
  /** True when wf_wait / wf_cancel already holds interest — skip async message. */
  consumed: boolean;
};

export type WorkflowManagerOptions = {
  maxRunning?: number;
  maxTracked?: number;
  /** Root for artifact dirs (default: tmpdir/pi-enhanced-workflows). */
  artifactsRoot?: string;
  onSettled?: (info: WorkflowSettledInfo) => void;
  onChange?: () => void;
  /** Injected into each workflow's SubagentManager (tests). */
  subagentOptions?: Omit<SubagentManagerOptions, "onSettled" | "onChange">;
};

export class WorkflowManager {
  private entries = new Map<string, Entry>();
  private counter = 0;
  private startingCount = 0;
  private disposed = false;
  private waitInterest = new Map<string, number>();
  private readonly maxRunning: number;
  private readonly maxTracked: number;
  private readonly artifactsRoot: string;
  private onSettled?: (info: WorkflowSettledInfo) => void;
  private onChange?: () => void;
  private subagentOptions?: Omit<SubagentManagerOptions, "onSettled" | "onChange">;

  constructor(options: WorkflowManagerOptions = {}) {
    this.maxRunning = options.maxRunning ?? DEFAULT_MAX_RUNNING;
    this.maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED;
    this.artifactsRoot = options.artifactsRoot ?? join(tmpdir(), "pi-enhanced-workflows");
    this.onSettled = options.onSettled;
    this.onChange = options.onChange;
    this.subagentOptions = options.subagentOptions;
  }

  list(): WorkflowSnapshot[] {
    return [...this.entries.values()].map((e) => this.snapshotOf(e));
  }

  get(id: string) {
    const e = this.entries.get(id);
    return e ? this.snapshotOf(e) : undefined;
  }

  private runningCount() {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.status === "running") n++;
    }
    return n;
  }

  async start(options: StartWorkflowOptions): Promise<WorkflowSnapshot> {
    if (this.disposed) throw new Error("Workflow manager is disposed.");
    if (this.runningCount() + this.startingCount >= this.maxRunning) {
      throw new Error(
        `Concurrency limit: at most ${this.maxRunning} workflows may run at once.`,
      );
    }

    const goal = options.goal.trim();
    if (!goal) throw new Error("goal must not be empty");

    const cwd = resolve(options.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`Working directory does not exist or is not a directory: ${cwd}`);
    }

    this.startingCount += 1;
    this.counter += 1;
    const id = `wf-${this.counter}`;
    const title =
      options.title?.trim().slice(0, 80) ||
      `workflow: ${goal.replace(/\s+/g, " ").slice(0, 48)}`;

    let artifactsDir: string;
    try {
      await mkdir(this.artifactsRoot, { recursive: true, mode: 0o700 });
      artifactsDir = await mkdtemp(join(this.artifactsRoot, `${id}-`));
      await writeFile(join(artifactsDir, "goal.txt"), `${goal.trim()}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await writeFile(
        join(artifactsDir, "meta.json"),
        `${JSON.stringify(
          {
            id,
            title,
            goal,
            cwd,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error) {
      this.startingCount -= 1;
      throw error;
    }

    let resolveSettle!: () => void;
    const settlePromise = new Promise<void>((r) => {
      resolveSettle = r;
    });

    const phases: PhaseRuntime[] = REPO_TASK_PHASES.map((p) => ({
      name: p.name,
      status: "pending" as const,
      tasks: new Map(
        p.tasks.map((t) => [
          t.key,
          {
            key: t.key,
            title: t.title,
            backend: t.backend,
            status: "pending" as const,
          } satisfies TaskRunSnapshot,
        ]),
      ),
    }));

    const subagents = new SubagentManager({
      ...this.subagentOptions,
      onChange: () => this.notify(),
    });

    const entry: Entry = {
      id,
      title,
      goal,
      cwd,
      model: options.model,
      thinking: options.thinking,
      status: "running",
      createdAt: Date.now(),
      artifactsDir,
      phases,
      priorOutputs: [],
      failedTaskCount: 0,
      cancelRequested: false,
      settlePromise,
      resolveSettle,
      subagents,
    };

    this.entries.set(id, entry);
    this.startingCount -= 1;
    this.notify();
    void this.persist(entry);

    // Background orchestration — never await here.
    void this.runWorkflow(entry);

    return this.snapshotOf(entry);
  }

  private async runWorkflow(entry: Entry) {
    try {
      for (let i = 0; i < REPO_TASK_PHASES.length; i++) {
        if (entry.cancelRequested || this.disposed) {
          await this.finish(entry, "cancelled", "Workflow cancelled.");
          return;
        }

        const phaseDef = REPO_TASK_PHASES[i]!;
        const phaseRt = entry.phases[i]!;
        entry.currentPhase = phaseDef.name;
        phaseRt.status = "running";
        this.notify();
        await this.persist(entry);

        const phaseOutputs = await this.runPhase(entry, i, phaseDef.name, phaseDef.tasks);
        entry.priorOutputs.push(...phaseOutputs);

        const phaseFailed = phaseOutputs.some((o) => o.status !== "ok");
        phaseRt.status = phaseFailed ? "failed" : "done";

        // Synthesis is the last phase; earlier failures do not skip it.
        this.notify();
        await this.persist(entry);
      }

      if (entry.cancelRequested || this.disposed) {
        await this.finish(entry, "cancelled", "Workflow cancelled.");
        return;
      }

      const synthesis = entry.priorOutputs.filter((o) => o.phase === "synthesis");
      const synthOk = synthesis.some((o) => o.status === "ok");
      const lastSynth = [...synthesis].reverse().find((o) => o.status === "ok") ?? synthesis.at(-1);

      if (lastSynth?.status === "ok" && lastSynth.summary) {
        // Prefer full body from artifact if we stored final already in runPhase
        entry.finalSummary = lastSynth.summary;
      }

      // final.md written in runPhase for synthesis tasks; ensure path
      if (!entry.finalArtifactPath) {
        const body =
          entry.finalSummary ||
          buildFallbackSynthesis(entry.goal, entry.priorOutputs, entry.failedTaskCount);
        entry.finalArtifactPath = await writeFinalArtifact(entry.artifactsDir, body);
        entry.finalSummary = extractSummary(body);
      }

      if (!synthOk) {
        // Still produce a synthesized result from preserved artifacts after partial failure.
        const fallback = buildFallbackSynthesis(
          entry.goal,
          entry.priorOutputs,
          entry.failedTaskCount,
        );
        entry.finalArtifactPath = await writeFinalArtifact(entry.artifactsDir, fallback);
        entry.finalSummary = extractSummary(fallback);
        await this.finish(
          entry,
          entry.failedTaskCount > 0 ? "partial" : "failed",
          "Synthesis agent failed; wrote fallback synthesis from artifacts.",
        );
        return;
      }

      const status: WorkflowStatus = entry.failedTaskCount > 0 ? "partial" : "done";
      await this.finish(entry, status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const fallback = buildFallbackSynthesis(
          entry.goal,
          entry.priorOutputs,
          entry.failedTaskCount,
          message,
        );
        entry.finalArtifactPath = await writeFinalArtifact(entry.artifactsDir, fallback);
        entry.finalSummary = extractSummary(fallback);
      } catch {
        // ignore artifact write errors during failure
      }
      await this.finish(entry, "failed", message);
    }
  }

  private async runPhase(
    entry: Entry,
    phaseIndex: number,
    phaseName: string,
    tasks: WorkflowTaskDef[],
  ): Promise<StructuredOutput[]> {
    const phaseRt = entry.phases[phaseIndex]!;
    const dir = phaseDir(entry.artifactsDir, phaseIndex, phaseName);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    if (entry.cancelRequested) {
      return tasks.map((t) =>
        validateStructuredOutput({
          phase: phaseName,
          taskKey: t.key,
          title: t.title,
          subagentStatus: "killed",
          errorText: "cancelled before start",
          artifactPath: join(dir, `${t.key}.md`),
        }),
      );
    }

    // Mark running and spawn all phase tasks in parallel (within subagent concurrency).
    const spawned: Array<{ task: WorkflowTaskDef; subagentId: string }> = [];

    for (const task of tasks) {
      if (entry.cancelRequested) break;

      const tr = phaseRt.tasks.get(task.key)!;
      tr.status = "running";
      this.notify();

      const prompt = buildTaskPrompt({
        goal: entry.goal,
        task,
        artifactsDir: entry.artifactsDir,
        prior: entry.priorOutputs,
      });

      // Match sa_spawn defaults: Pi inherits parent provider/id; Codex must not —
      // parent labels look like "openai-codex/gpt-…" and Codex CLI rejects that form.
      let model: string | undefined;
      let thinking: string | undefined;
      if (task.backend === "codex") {
        model = task.model ?? (process.env.CODEX_DEFAULT_MODEL?.trim() || undefined);
        thinking = task.thinking ?? "high";
      } else {
        model = task.model ?? entry.model;
        thinking = task.thinking ?? entry.thinking;
      }

      try {
        const snap = await entry.subagents.spawn({
          backend: task.backend,
          prompt,
          title: `${entry.id}/${phaseName}/${task.key}`,
          cwd: entry.cwd,
          model,
          thinking,
        });
        tr.subagentId = snap.id;
        spawned.push({ task, subagentId: snap.id });
        this.notify();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        tr.status = "failed";
        tr.error = message;
        entry.failedTaskCount += 1;
        const artifactPath = await writeTaskArtifact({
          dir,
          taskKey: task.key,
          title: task.title,
          status: "failed",
          body: "",
          error: message,
        });
        tr.artifactPath = artifactPath;
        // Record as structured failure without subagent
        phaseRt.tasks.set(task.key, tr);
      }
    }

    if (spawned.length > 0) {
      await entry.subagents.wait(spawned.map((s) => s.subagentId));
    }

    const outputs: StructuredOutput[] = [];

    // Collect spawn failures that never got a subagent
    for (const task of tasks) {
      const already = spawned.find((s) => s.task.key === task.key);
      if (already) continue;
      const tr = phaseRt.tasks.get(task.key)!;
      const artifactPath =
        tr.artifactPath ??
        (await writeTaskArtifact({
          dir,
          taskKey: task.key,
          title: task.title,
          status: "failed",
          body: "",
          error: tr.error ?? "failed to start",
        }));
      const out = validateStructuredOutput({
        phase: phaseName,
        taskKey: task.key,
        title: task.title,
        subagentStatus: "failed",
        errorText: tr.error ?? "failed to start",
        artifactPath,
      });
      outputs.push(out);
    }

    for (const { task, subagentId } of spawned) {
      const snap = entry.subagents.get(subagentId);
      const tr = phaseRt.tasks.get(task.key)!;
      const subStatus =
        snap?.status === "done" || snap?.status === "failed" || snap?.status === "killed"
          ? snap.status
          : "failed";

      const body =
        subStatus === "done"
          ? snap?.resultText ?? ""
          : [snap?.errorText, snap?.resultText, snap?.outputTail].filter(Boolean).join("\n\n");

      const artifactPath = await writeTaskArtifact({
        dir,
        taskKey: task.key,
        title: task.title,
        status: subStatus,
        body: body || "",
        error: snap?.errorText,
        subagentId,
      });

      const out = validateStructuredOutput({
        phase: phaseName,
        taskKey: task.key,
        title: task.title,
        subagentStatus: subStatus,
        resultText: snap?.resultText,
        errorText: snap?.errorText,
        artifactPath,
        subagentId,
      });

      tr.status =
        out.status === "ok" ? "done" : out.status === "killed" ? "killed" : "failed";
      tr.summary = out.summary || undefined;
      tr.artifactPath = artifactPath;
      tr.error = out.error;
      tr.subagentId = subagentId;
      if (out.status !== "ok") entry.failedTaskCount += 1;

      outputs.push(out);

      if (phaseName === "synthesis" && out.status === "ok" && snap?.resultText) {
        entry.finalArtifactPath = await writeFinalArtifact(entry.artifactsDir, snap.resultText);
        entry.finalSummary = out.summary;
      }
    }

    await writeFile(join(dir, "outputs.json"), `${JSON.stringify(outputs, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.notify();
    return outputs;
  }

  private async finish(entry: Entry, status: WorkflowStatus, errorText?: string) {
    if (entry.status !== "running") return;
    entry.status = status;
    entry.settledAt = Date.now();
    entry.currentPhase = undefined;
    if (errorText) entry.errorText = errorText;

    // Capture before resolveSettle — waiters release interest in finally after settle.
    const consumed = (this.waitInterest.get(entry.id) ?? 0) > 0;
    entry.resolveSettle();

    try {
      await entry.subagents.disposeAll();
    } catch {
      // ignore
    }

    await this.persist(entry);
    this.pruneSettled();
    this.notify();

    if (!this.disposed) {
      this.onSettled?.({ snapshot: this.snapshotOf(entry), consumed });
    }
  }

  private async persist(entry: Entry) {
    try {
      await writeFile(
        join(entry.artifactsDir, "status.json"),
        `${JSON.stringify(this.snapshotOf(entry), null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // ignore disk errors mid-run
    }
  }

  private snapshotOf(entry: Entry): WorkflowSnapshot {
    return {
      id: entry.id,
      title: entry.title,
      goal: entry.goal,
      status: entry.status,
      cwd: entry.cwd,
      artifactsDir: entry.artifactsDir,
      createdAt: entry.createdAt,
      settledAt: entry.settledAt,
      currentPhase: entry.currentPhase,
      phases: entry.phases.map((p) => ({
        name: p.name,
        status: p.status,
        tasks: [...p.tasks.values()],
      })),
      finalArtifactPath: entry.finalArtifactPath,
      finalSummary: entry.finalSummary,
      errorText: entry.errorText,
      failedTaskCount: entry.failedTaskCount,
    };
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

  private notify() {
    this.onChange?.();
  }

  private addInterest(id: string) {
    this.waitInterest.set(id, (this.waitInterest.get(id) ?? 0) + 1);
  }

  private releaseInterest(id: string) {
    const n = (this.waitInterest.get(id) ?? 0) - 1;
    if (n <= 0) this.waitInterest.delete(id);
    else this.waitInterest.set(id, n);
  }

  async wait(ids: readonly string[], signal?: AbortSignal): Promise<WorkflowSnapshot[]> {
    if (this.disposed) throw new Error("Workflow manager is disposed.");
    const unknown = ids.filter((id) => !this.entries.has(id));
    if (unknown.length > 0) throw new Error(`Unknown workflow id(s): ${unknown.join(", ")}`);

    for (const id of ids) this.addInterest(id);
    try {
      const waits = ids.map((id) => this.entries.get(id)!.settlePromise);
      await Promise.race([
        Promise.all(waits),
        abortPromise(signal, "Wait aborted; workflows continue in the background."),
      ]);
    } finally {
      for (const id of ids) this.releaseInterest(id);
    }
    return ids.map((id) => this.snapshotOf(this.entries.get(id)!));
  }

  async cancel(ids: readonly string[], signal?: AbortSignal): Promise<WorkflowSnapshot[]> {
    if (this.disposed) throw new Error("Workflow manager is disposed.");
    const unknown = ids.filter((id) => !this.entries.has(id));
    if (unknown.length > 0) throw new Error(`Unknown workflow id(s): ${unknown.join(", ")}`);

    const waiting: Promise<void>[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id)!;
      if (entry.status !== "running") continue;
      this.addInterest(id);
      entry.cancelRequested = true;
      const runningIds = entry.subagents
        .list()
        .filter((s) => s.status === "running")
        .map((s) => s.id);
      if (runningIds.length > 0) {
        void entry.subagents.cancel(runningIds).catch(() => {});
      }
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
      entry.cancelRequested = true;
      try {
        const ids = entry.subagents
          .list()
          .filter((s) => s.status === "running")
          .map((s) => s.id);
        if (ids.length > 0) await entry.subagents.cancel(ids);
        else await entry.subagents.disposeAll();
      } catch {
        // ignore
      }
    }
    await Promise.race([
      Promise.all(running.map((e) => e.settlePromise)),
      sleep(5000),
    ]);
    this.entries.clear();
    this.waitInterest.clear();
    this.notify();
  }
}

function buildFallbackSynthesis(
  goal: string,
  prior: StructuredOutput[],
  failedTaskCount: number,
  error?: string,
) {
  const lines = [
    `# Workflow synthesis (fallback)`,
    "",
    `Goal: ${goal}`,
    failedTaskCount > 0 ? `Failed tasks: ${failedTaskCount}` : undefined,
    error ? `Orchestrator error: ${error}` : undefined,
    "",
    "## Phase outputs",
    ...prior.map((p) => {
      if (p.status === "ok") {
        return `- **${p.phase}/${p.taskKey}** (ok): ${p.summary}\n  artifact: ${p.artifactPath}`;
      }
      return `- **${p.phase}/${p.taskKey}** (${p.status}): ${p.error ?? p.status}\n  artifact: ${p.artifactPath}`;
    }),
    "",
    "The synthesis agent did not produce a valid result; this report is assembled from preserved artifacts.",
  ].filter((l) => l !== undefined);
  return lines.join("\n");
}
