import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

export type RunResult = {
  text: string;
  exitCode: number;
  truncated: boolean;
  fullOutputPath?: string;
  lineCount: number;
};

export function buildFdArgs(params: {
  pattern: string;
  path?: string;
  type?: string;
  extension?: string;
  hidden?: boolean;
  maxResults?: number;
  /** When true, pattern is a regex (fd default). When false/omitted, use --glob so *.ts works. */
  regex?: boolean;
}): string[] {
  const args = ["--color", "never"];
  // Agents and users almost always pass globs (*.ts). fd defaults to regex, which
  // treats * as a repetition operator and fails on patterns like "*.ts".
  if (!params.regex) args.push("--glob");
  if (params.hidden) args.push("--hidden");
  if (params.type) args.push("--type", params.type);
  if (params.extension) args.push("--extension", params.extension);
  if (params.maxResults && params.maxResults > 0) {
    args.push("--max-results", String(params.maxResults));
  }
  args.push("--", params.pattern);
  args.push(params.path || ".");
  return args;
}

export function buildRgArgs(params: {
  pattern: string;
  path?: string;
  glob?: string;
  caseInsensitive?: boolean;
  maxCount?: number;
}): string[] {
  const args = ["--line-number", "--color", "never", "--no-heading"];
  if (params.caseInsensitive) args.push("-i");
  if (params.glob) args.push("--glob", params.glob);
  if (params.maxCount && params.maxCount > 0) {
    args.push("--max-count", String(params.maxCount));
  }
  args.push("--", params.pattern);
  args.push(params.path || ".");
  return args;
}

export async function runBinary(
  binaryPath: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

export async function truncateToolOutput(output: string, prefix: string): Promise<RunResult> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const lineCount = output.length === 0 ? 0 : output.split("\n").filter(Boolean).length;
  if (!truncation.truncated) {
    return {
      text: truncation.content || "(no output)",
      exitCode: 0,
      truncated: false,
      lineCount,
    };
  }

  const tempDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const tempFile = join(tempDir, "output.txt");
  await writeFile(tempFile, output, "utf8");

  const notice =
    `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines` +
    ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).` +
    ` Full output: ${tempFile}]`;

  return {
    text: truncation.content + notice,
    exitCode: 0,
    truncated: true,
    fullOutputPath: tempFile,
    lineCount,
  };
}
