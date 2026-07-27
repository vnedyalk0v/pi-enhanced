import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendBounded,
  extractCodexLastMessage,
  runProcess,
} from "../run.ts";
import { tailText } from "../../shared/text.ts";
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
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

export async function startCodexBackend(options: CodexBackendOptions): Promise<BackendJob> {
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-subagent-codex-"));
  const lastMessagePath = join(tmpDir, "last-message.txt");
  // Codex's -c flag parses this as a bare TOML assignment; only pass known
  // words through so an unexpected value (e.g. containing a quote) can't
  // break out of the quoted config value.
  const requestedEffort = options.reasoningEffort ?? "high";
  const effort = REASONING_EFFORTS.has(requestedEffort) ? requestedEffort : "high";

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
  const model = normalizeCodexModelId(options.model);
  if (model) {
    args.push("-m", model);
  }
  args.push(options.prompt);

  let output = "";
  const handle = runProcess({
    command: "codex",
    args,
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

/**
 * Codex CLI expects a bare model id (`gpt-5.6-sol`), not Pi's provider/id
 * (`openai-codex/gpt-5.6-sol`). Passing the latter fails with ChatGPT accounts.
 */
export function normalizeCodexModelId(model?: string) {
  const raw = model?.trim();
  if (!raw) return undefined;
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const provider = raw.slice(0, slash).toLowerCase();
    // Pi-style provider prefixes only — leave other slashful ids alone.
    if (
      provider === "openai-codex" ||
      provider === "openai" ||
      provider === "codex"
    ) {
      const id = raw.slice(slash + 1).trim();
      return id || undefined;
    }
  }
  return raw;
}
