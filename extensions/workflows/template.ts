import type { WorkflowTaskDef } from "./domain.ts";

/** Fixed four-phase repository task: recon → implementation → review → synthesis. */
export const REPO_TASK_PHASES: Array<{ name: string; tasks: WorkflowTaskDef[] }> = [
  {
    name: "reconnaissance",
    tasks: [
      {
        key: "structure",
        title: "Map repository structure",
        backend: "pi",
        role: [
          "You are a reconnaissance scout.",
          "Map the repository layout: entry points, packages, key modules, and how the project is built/tested.",
          "Do not modify files. Return a compressed structural brief the implementer can use.",
        ].join(" "),
      },
      {
        key: "relevant",
        title: "Find goal-relevant code",
        backend: "pi",
        role: [
          "You are a reconnaissance scout focused on the goal.",
          "Find files, symbols, and existing patterns relevant to the goal.",
          "Do not modify files. Cite concrete paths and note risks or unknowns.",
        ].join(" "),
      },
    ],
  },
  {
    name: "implementation",
    tasks: [
      {
        key: "implement",
        title: "Implement the goal",
        backend: "codex",
        thinking: "high",
        role: [
          "You are the implementation worker.",
          "Using prior reconnaissance (and noting any missing recon if a scout failed), implement the goal.",
          "Make focused changes. Run available checks if reasonable.",
          "Summarize what you changed, how to verify, and any follow-ups.",
        ].join(" "),
      },
    ],
  },
  {
    name: "review",
    tasks: [
      {
        key: "review",
        title: "Review the work",
        backend: "pi",
        role: [
          "You are a critical reviewer.",
          "Review the implementation against the goal and recon notes.",
          "Report correctness issues, missing tests, regressions, and residual risks.",
          "Do not re-implement unless a trivial fix is clearly required; prefer actionable findings.",
        ].join(" "),
      },
    ],
  },
  {
    name: "synthesis",
    tasks: [
      {
        key: "synthesize",
        title: "Synthesize final result",
        backend: "pi",
        role: [
          "You are the synthesis agent.",
          "Produce ONE final report for the parent agent.",
          "Include: outcome vs goal, what was implemented, review findings, and any failed or incomplete agent steps.",
          "If earlier phases partially failed, still deliver the best available synthesis from preserved artifacts.",
          "End with concrete next steps if work remains.",
        ].join(" "),
      },
    ],
  },
];
