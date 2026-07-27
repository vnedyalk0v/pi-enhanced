import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendBounded, createPiAssistantTextCollector, runProcess, type RunHandle } from "./run.ts";
import { tailText } from "../shared/text.ts";

export type PiBackendOptions = {
  prompt: string;
  cwd: string;
  model?: string;
  thinking?: string;
  /** Tool allowlist from an agent definition; omitted = pi's full default set. */
  tools?: string[];
  /** Agent definition's system prompt body, appended after the base worker guidance. */
  systemPromptAppend?: string;
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
 * This is pi's own native worker path — no third-party CLI dependency.
 */
export async function startPiBackend(options: PiBackendOptions): Promise<BackendJob> {
  const args = ["--mode", "json", "-p", "--no-session"];
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));

  // System guidance: child is a worker; return a clear final answer.
  const systemExtra = [
    "You are a subagent worker in an isolated Pi session.",
    "Complete the task thoroughly. Prefer concise final answers.",
    "Do not wait for the parent agent; you will not receive follow-ups in this process.",
    options.systemPromptAppend?.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");

  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "pi-subagent-sys-"));
    const promptFile = join(tmpDir, "system.md");
    await writeFile(promptFile, systemExtra, { encoding: "utf8", mode: 0o600 });
    args.push("--append-system-prompt", promptFile);
  } catch (error) {
    if (options.systemPromptAppend) {
      // A named agent's defining prompt must not be silently dropped — the
      // child would still spawn and be reported as that agent, but behave as
      // a generic worker instead. Fail loudly rather than run the wrong thing.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write agent prompt file: ${message}`);
    }
    // Ad-hoc worker: the generic guidance above is a nice-to-have, not load-bearing.
    tmpDir = undefined;
  }

  args.push(options.prompt);

  let output = "";
  const resultCollector = createPiAssistantTextCollector();
  const handle = runProcess({
    command: "pi",
    args,
    cwd: options.cwd,
    signal: options.signal,
    onStdout: (c) => {
      resultCollector.push(c);
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
      const resultText = resultCollector.finish();
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
