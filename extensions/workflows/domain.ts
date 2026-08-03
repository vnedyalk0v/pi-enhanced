export type WorkflowStatus =
  | "running"
  | "done"
  | "partial"
  | "failed"
  | "cancelled";

export type TaskRunStatus = "pending" | "running" | "done" | "failed" | "killed";

export type PhaseRunStatus = "pending" | "running" | "done" | "failed";

/** One parallel agent slot inside a phase. */
export type WorkflowTaskDef = {
  key: string;
  title: string;
  /** Role instructions embedded in the child prompt. */
  role: string;
  model?: string;
  thinking?: string;
  tools?: string[];
};

/** Validated handoff record stored as artifact and fed to later phases. */
export type StructuredOutput = {
  phase: string;
  taskKey: string;
  title: string;
  status: "ok" | "failed" | "killed";
  /** Short validated summary for later prompts (empty when not ok). */
  summary: string;
  /** Absolute path to the full artifact file. */
  artifactPath: string;
  subagentId?: string;
  error?: string;
};

export type TaskRunSnapshot = {
  key: string;
  title: string;
  status: TaskRunStatus;
  subagentId?: string;
  summary?: string;
  artifactPath?: string;
  error?: string;
};

export type PhaseRunSnapshot = {
  name: string;
  status: PhaseRunStatus;
  tasks: TaskRunSnapshot[];
};

export type WorkflowSnapshot = {
  id: string;
  title: string;
  goal: string;
  status: WorkflowStatus;
  cwd: string;
  artifactsDir: string;
  createdAt: number;
  settledAt?: number;
  currentPhase?: string;
  phases: PhaseRunSnapshot[];
  /** Compact path to final synthesis artifact when available. */
  finalArtifactPath?: string;
  /** Truncated final synthesis text for status peeks. */
  finalSummary?: string;
  errorText?: string;
  /** Count of task failures across all phases (including recovered partials). */
  failedTaskCount: number;
};

export type StartWorkflowOptions = {
  goal: string;
  title?: string;
  cwd: string;
  /** Parent model label for pi defaults (provider/id). */
  model?: string;
  thinking?: string;
};
