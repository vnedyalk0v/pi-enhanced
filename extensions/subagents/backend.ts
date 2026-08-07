import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendBounded,
  createPiAssistantTextCollector,
  PiResultRecordTooLargeError,
  runProcess,
  type RunHandle,
} from "./run.ts";

export type PiBackendOptions = {
  prompt: string;
  cwd: string;
  model?: string;
  thinking?: string;
  /** Tool allowlist from an agent definition; omitted = pi's full default set. */
  tools?: string[];
  /** Extension required by an explicitly allowed worker tool. */
  extensionPath?: string;
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
 * Base pi CLI args for model/thinking/tools. Exported (pure, no I/O) so the
 * tools handling — an explicit empty allowlist (`[]`) must still pass
 * `--tools ""` (zero tools), not be treated the same as "omitted" (pi's full
 * default set) — is directly unit-testable.
 */
export function buildBaseArgs(
  options: Pick<PiBackendOptions, "model" | "thinking" | "tools" | "extensionPath">,
) {
  const args = ["--mode", "json", "-p", "--no-session"];
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.extensionPath) args.push("--extension", options.extensionPath);
  if (options.tools !== undefined) args.push("--tools", options.tools.join(","));
  return args;
}

/**
 * Run a self-contained Pi child with isolated session (json + print + no-session).
 * This is pi's own native worker path — no third-party CLI dependency.
 */
export async function startPiBackend(options: PiBackendOptions): Promise<BackendJob> {
  options.signal?.throwIfAborted();
  const args = buildBaseArgs(options);

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
    options.signal?.throwIfAborted();
    const promptFile = join(tmpDir, "system.md");
    await writeFile(promptFile, systemExtra, { encoding: "utf8", mode: 0o600 });
    options.signal?.throwIfAborted();
    args.push("--append-system-prompt", promptFile);
  } catch (error) {
    // mkdtemp may have already created the directory before writeFile failed;
    // clean it up here since neither the throw below nor the ad-hoc fallback
    // ever reaches collect()'s own cleanup for this path.
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = undefined;
    if (options.signal?.aborted) throw error;
    if (options.systemPromptAppend) {
      // A named agent's defining prompt must not be silently dropped — the
      // child would still spawn and be reported as that agent, but behave as
      // a generic worker instead. Fail loudly rather than run the wrong thing.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write agent prompt file: ${message}`);
    }
    // Ad-hoc worker: the generic guidance above is a nice-to-have, not load-bearing.
  }

  options.signal?.throwIfAborted();

  let output = "";
  const resultCollector = createPiAssistantTextCollector();
  let resultError: PiResultRecordTooLargeError | undefined;
  let handle!: RunHandle;
  // Prompt goes over stdin (pi -p merges piped stdin into the initial
  // prompt): immune to ARG_MAX and to argv @file/flag interpretation.
  handle = runProcess({
    command: "pi",
    args,
    cwd: options.cwd,
    stdinData: `Task: ${options.prompt}`,
    onStdout: (c) => {
      output = appendBounded(output, c);
      if (resultError) return;
      try {
        resultCollector.push(c);
      } catch (error) {
        if (!(error instanceof PiResultRecordTooLargeError)) throw error;
        resultError = error;
        handle.kill("SIGKILL");
      }
      options.onOutput?.(c);
    },
    onStderr: (c) => {
      output = appendBounded(output, c);
      options.onOutput?.(c);
    },
  });

  let collected: ReturnType<BackendJob["collect"]> | undefined;

  return {
    handle,
    collect: () =>
      (collected ??= (async () => {
        const { exitCode, signal } = await handle.wait;
        if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        if (resultError) throw resultError;
        const resultText = resultCollector.finish();
        return {
          exitCode,
          signal,
          resultText,
          errorText:
            exitCode !== 0 && !resultText
              ? output.slice(-1500) || `pi exited ${exitCode}`
              : undefined,
          output,
        };
      })()),
  };
}
