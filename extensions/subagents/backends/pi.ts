import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendBounded,
  extractPiLastAssistantText,
  resolvePiInvocation,
  runProcess,
  type RunHandle,
} from "../run.ts";

export type PiBackendOptions = {
  prompt: string;
  cwd: string;
  model?: string;
  thinking?: string;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
};

export type BackendJob = {
  handle: RunHandle;
  /** Await and parse final result. */
  collect: () => Promise<{
    exitCode: number;
    signal?: string;
    resultText: string;
    errorText?: string;
    output: string;
  }>;
};

/**
 * Run a self-contained Pi child with isolated session (json + print + no-session).
 */
export async function startPiBackend(options: PiBackendOptions): Promise<BackendJob> {
  const args = ["--mode", "json", "-p", "--no-session"];
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);

  // System guidance: child is a worker; return a clear final answer.
  const systemExtra = [
    "You are a subagent worker in an isolated Pi session.",
    "Complete the task thoroughly. Prefer concise final answers.",
    "Do not wait for the parent agent; you will not receive follow-ups in this process.",
  ].join(" ");

  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "pi-subagent-sys-"));
    const promptFile = join(tmpDir, "system.md");
    await writeFile(promptFile, systemExtra, { encoding: "utf8", mode: 0o600 });
    args.push("--append-system-prompt", promptFile);
  } catch {
    // Fall through without append if tmp fails
    tmpDir = undefined;
  }

  args.push(options.prompt);

  let output = "";
  const inv = resolvePiInvocation(args);
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
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      const resultText = extractPiLastAssistantText(output);
      return {
        exitCode,
        signal,
        resultText,
        errorText:
          exitCode !== 0 && !resultText
            ? tailText(output, 1500) || `pi exited ${exitCode}`
            : undefined,
        output,
      };
    },
  };
}

function tailText(s: string, n: number) {
  return s.length <= n ? s : s.slice(s.length - n);
}
