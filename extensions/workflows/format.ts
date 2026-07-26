import { formatElapsed } from "../shared/time.ts";
import { truncateForModel, truncateOneLine } from "../shared/text.ts";
import type { WorkflowSnapshot } from "./domain.ts";

export function describeWorkflow(snap: WorkflowSnapshot) {
  const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
  const phase = snap.currentPhase ? ` phase=${snap.currentPhase}` : "";
  const fails = snap.failedTaskCount > 0 ? ` failedTasks=${snap.failedTaskCount}` : "";
  return `${snap.id} [${snap.status}] "${snap.title}" (${elapsed}${phase}${fails})`;
}

export function buildStartResult(snap: WorkflowSnapshot) {
  return [
    `Started workflow ${snap.id} "${snap.title}".`,
    `goal: ${truncateOneLine(snap.goal, 200)}`,
    `cwd: ${snap.cwd}`,
    `artifacts: ${snap.artifactsDir}`,
    "Phases run headlessly: reconnaissance → implementation → review → synthesis.",
    "Artifacts are stored on disk (not in the prompt). Use",
    `wf_status / wf_wait / wf_cancel with id "${snap.id}".`,
  ].join("\n");
}

export function buildStatusResult(snap: WorkflowSnapshot) {
  const lines = [
    describeWorkflow(snap),
    `goal: ${truncateOneLine(snap.goal, 200)}`,
    `cwd: ${snap.cwd}`,
    `artifacts: ${snap.artifactsDir}`,
  ];
  if (snap.errorText) lines.push(`error: ${snap.errorText}`);
  lines.push("", "--- phases ---");
  for (const phase of snap.phases) {
    lines.push(`${statusIcon(phase.status)} ${phase.name} [${phase.status}]`);
    for (const task of phase.tasks) {
      const sa = task.subagentId ? ` ${task.subagentId}` : "";
      const extra = task.error
        ? ` — ${task.error}`
        : task.summary
          ? ` — ${truncateOneLine(task.summary, 80)}`
          : "";
      lines.push(`  ${statusIcon(task.status)} ${task.key} (${task.backend}) [${task.status}]${sa}${extra}`);
    }
  }
  if (snap.finalArtifactPath) {
    lines.push("", `final: ${snap.finalArtifactPath}`);
  }
  if (snap.finalSummary) {
    lines.push("", "--- final summary ---", truncateForModel(snap.finalSummary));
  }
  return lines.join("\n");
}

export function buildListResult(snaps: WorkflowSnapshot[]) {
  if (snaps.length === 0) return "No workflows.";
  return snaps.map(describeWorkflow).join("\n");
}

export function buildWaitResult(snaps: WorkflowSnapshot[]) {
  return snaps
    .map((s) => {
      const head = describeWorkflow(s);
      const bits = [head, `artifacts: ${s.artifactsDir}`];
      if (s.finalArtifactPath) bits.push(`final: ${s.finalArtifactPath}`);
      if (s.finalSummary) bits.push("", truncateForModel(s.finalSummary));
      if (s.errorText) bits.push(`error: ${s.errorText}`);
      return bits.join("\n");
    })
    .join("\n\n");
}

export function buildCancelResult(snaps: WorkflowSnapshot[]) {
  return snaps
    .map((s) => {
      if (s.status === "cancelled") return `Cancelled ${s.id} "${s.title}".`;
      return `${s.id} "${s.title}" was already ${s.status}.`;
    })
    .join("\n");
}

export function buildCompletionMessage(snap: WorkflowSnapshot) {
  const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
  const verb =
    snap.status === "done"
      ? "finished"
      : snap.status === "partial"
        ? "finished with partial agent failures"
        : snap.status === "cancelled"
          ? "was cancelled"
          : "failed";
  const lines = [
    `Workflow ${snap.id} "${snap.title}" ${verb} after ${elapsed}.`,
    `goal: ${truncateOneLine(snap.goal, 200)}`,
    `artifacts: ${snap.artifactsDir}`,
  ];
  if (snap.failedTaskCount > 0) {
    lines.push(`failed tasks: ${snap.failedTaskCount}`);
  }
  if (snap.errorText) lines.push(`error: ${snap.errorText}`);
  if (snap.finalArtifactPath) lines.push(`final: ${snap.finalArtifactPath}`);
  if (snap.finalSummary) {
    lines.push("", "--- synthesis ---", truncateForModel(snap.finalSummary));
  }
  return lines.join("\n");
}

function statusIcon(status: string) {
  switch (status) {
    case "done":
    case "ok":
      return "✓";
    case "failed":
    case "killed":
    case "cancelled":
      return "✗";
    case "running":
      return "…";
    case "partial":
      return "~";
    default:
      return "·";
  }
}
