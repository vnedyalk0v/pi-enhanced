export type BackendName = "pi" | "codex";

export type SubagentStatus = "running" | "done" | "failed" | "killed";

export type SubagentSnapshot = {
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
  /** Bounded tail of combined process output for status peeks. */
  outputTail: string;
  /** Final agent message when settled successfully. */
  resultText?: string;
  pid?: number;
};

export type SpawnOptions = {
  backend: BackendName;
  prompt: string;
  title?: string;
  cwd: string;
  model?: string;
  thinking?: string;
};

export type SettledInfo = {
  snapshot: SubagentSnapshot;
  consumed: boolean;
};

export function formatExit(snap: SubagentSnapshot) {
  if (snap.status === "running") return "running";
  if (snap.signal) return snap.signal;
  if (snap.exitCode !== undefined) return `exit ${snap.exitCode}`;
  if (snap.errorText) return "error";
  return snap.status;
}
