import type { StructuredOutput, WorkflowTaskDef } from "./domain.ts";

const SUMMARY_MAX = 400;
const BODY_IN_PROMPT_MAX = 2_500;

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
    return {
      phase,
      taskKey,
      title,
      status: "killed",
      summary: "",
      artifactPath,
      subagentId,
      error: options.errorText || "cancelled",
    };
  }

  if (options.subagentStatus === "failed") {
    return {
      phase,
      taskKey,
      title,
      status: "failed",
      summary: "",
      artifactPath,
      subagentId,
      error: options.errorText || "failed",
    };
  }

  const body = (options.resultText ?? "").trim();
  if (!body) {
    return {
      phase,
      taskKey,
      title,
      status: "failed",
      summary: "",
      artifactPath,
      subagentId,
      error: "empty result (validation failed)",
    };
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

/** Compact model-facing dump of handoffs (for status / synthesis context notes). */
export function formatPriorCompact(prior: StructuredOutput[]) {
  if (prior.length === 0) return "(none)";
  return prior
    .map((p) => {
      if (p.status !== "ok") return `- ${p.phase}/${p.taskKey}: ${p.status}${p.error ? ` (${p.error})` : ""}`;
      const s =
        p.summary.length <= 120 ? p.summary : `${p.summary.slice(0, 120)}…`;
      return `- ${p.phase}/${p.taskKey}: ok — ${s}`;
    })
    .join("\n");
}

export function clipForPrompt(text: string, max = BODY_IN_PROMPT_MAX) {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…[truncated ${t.length - max} chars; see artifact]`;
}
