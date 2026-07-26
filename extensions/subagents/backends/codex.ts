import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendBounded,
  extractCodexLastMessage,
  resolveCodexInvocation,
  runProcess,
} from "../run.ts";
import type { BackendJob } from "./pi.ts";

export type CodexBackendOptions = {
  prompt: string;
  cwd: string;
  model?: string;
  /** Defaults to high per package policy. */
  reasoningEffort?: string;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
};

/**
 * Run Codex non-interactively via `codex exec`.
 * Defaults: ephemeral session, high reasoning, workspace-write sandbox.
 */
export async function startCodexBackend(options: CodexBackendOptions): Promise<BackendJob> {
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-subagent-codex-"));
  const lastMessagePath = join(tmpDir, "last-message.txt");
  const effort = options.reasoningEffort ?? "high";

  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    options.cwd,
    "-s",
    "workspace-write",
    "-c",
    `model_reasoning_effort="${effort}"`,
    "-c",
    'approval_policy="never"',
    "-o",
    lastMessagePath,
  ];
  if (options.model) {
    args.push("-m", options.model);
  }
  args.push(options.prompt);

  let output = "";
  const inv = resolveCodexInvocation(args);
  const handle = runProcess({
    command: inv.command,
    args: inv.args,
    cwd: options.cwd,
    signal: options.signal,
    onStdout: (c) => {
      output = appendBounded(output, c);
      options.onOutput?.(c);
    },
    onStderr: (c) => {
      output = appendBounded(output, c);
      options.onOutput?.(c);
    },
  });

  return {
    handle,
    collect: async () => {
      const { exitCode, signal } = await handle.wait;
      let lastFile = "";
      try {
        lastFile = await readFile(lastMessagePath, "utf8");
      } catch {
        // optional
      }
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      const resultText = extractCodexLastMessage(output, lastFile);
      return {
        exitCode,
        signal,
        resultText,
        errorText:
          exitCode !== 0 && !resultText
            ? tailText(output, 1500) || `codex exited ${exitCode}`
            : undefined,
        output,
      };
    },
  };
}

function tailText(s: string, n: number) {
  return s.length <= n ? s : s.slice(s.length - n);
}
