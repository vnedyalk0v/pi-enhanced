export type SubagentStatus = "running" | "done" | "failed" | "killed";

export type SubagentSnapshot = {
  id: string;
  /** Named agent definition used, if any (ad-hoc worker when omitted). */
  agent?: string;
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
  /** Named agent definition to apply (tools/model/system prompt), if any. */
  agent?: string;
  prompt: string;
  title?: string;
  cwd: string;
  model?: string;
  thinking?: string;
  /** Tool allowlist from the agent definition, if restricted. */
  tools?: string[];
  /** Extension required by an explicitly allowed worker tool. */
  extensionPath?: string;
  /** Agent definition's system prompt body, appended to the worker guidance. */
  systemPromptAppend?: string;
};

export type SettledInfo = {
  snapshot: SubagentSnapshot;
  consumed: boolean;
};
