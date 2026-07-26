import type { StructuredOutput, WorkflowTaskDef } from "./domain.ts";

const SUMMARY_MAX = 400;

/**
 * Validate a settled subagent result into a structured handoff.
 * Empty / missing results become failed even if the process exited 0.
 */
export function validateStructuredOutput(options: {
  phase: string;
  taskKey: string;
  title: string;
  subagentStatus: "done" | "failed" | "killed" | "running";
  resultText?: string;
  errorText?: string;
  artifactPath: string;
  subagentId?: string;
}): StructuredOutput {
  const { phase, taskKey, title, artifactPath, subagentId } = options;

  if (options.subagentStatus === "killed") {
    return failedOut(phase, taskKey, title, artifactPath, "killed", options.errorText || "cancelled", subagentId);
  }

  if (options.subagentStatus === "failed") {
    return failedOut(phase, taskKey, title, artifactPath, "failed", options.errorText || "failed", subagentId);
  }

  const body = (options.resultText ?? "").trim();
  if (!body) {
    return failedOut(
      phase,
      taskKey,
      title,
      artifactPath,
      "failed",
      "empty result (validation failed)",
      subagentId,
    );
  }

  return {
    phase,
    taskKey,
    title,
    status: "ok",
    summary: extractSummary(body),
    artifactPath,
    subagentId,
  };
}

function failedOut(
  phase: string,
  taskKey: string,
  title: string,
  artifactPath: string,
  status: "failed" | "killed",
  error: string,
  subagentId?: string,
): StructuredOutput {
  return { phase, taskKey, title, status, summary: "", artifactPath, subagentId, error };
}

export function extractSummary(body: string) {
  const first = body
    .split(/\n+/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  const line = (first ?? body.trim()).replace(/\s+/g, " ");
  return line.length <= SUMMARY_MAX ? line : `${line.slice(0, SUMMARY_MAX)}…`;
}

export function buildTaskPrompt(options: {
  goal: string;
  task: WorkflowTaskDef;
  artifactsDir: string;
  prior: StructuredOutput[];
}): string {
  const { goal, task, artifactsDir, prior } = options;
  const sections = [
    `You are a workflow worker: ${task.title} (task key: ${task.key}).`,
    task.role,
    "",
    "## Goal",
    goal.trim(),
    "",
    "## Artifacts directory",
    artifactsDir,
    "Full prior outputs are stored as files under this directory. Prefer the structured handoff below; read artifact files only when you need more detail.",
    "",
    "## Prior phase outputs (validated)",
    formatPriorForPrompt(prior),
    "",
    "## Output requirements",
    "Return a clear final answer for the parent workflow.",
    "Start with a one-line summary, then details.",
    "If you cannot complete the task, say so explicitly and list blockers.",
  ];
  return sections.join("\n");
}

export function formatPriorForPrompt(prior: StructuredOutput[]) {
  if (prior.length === 0) return "(none — this is the first phase)";

  return prior
    .map((p) => {
      const head = `### ${p.phase}/${p.taskKey} — ${p.title} [${p.status}]`;
      if (p.status !== "ok") {
        return [head, `error: ${p.error ?? p.status}`, `artifact: ${p.artifactPath}`].join("\n");
      }
      const bodyNote = `summary: ${p.summary}\nartifact: ${p.artifactPath}`;
      return `${head}\n${bodyNote}`;
    })
    .join("\n\n");
}
