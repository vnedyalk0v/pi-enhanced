import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
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
  stderr: string;
  hasOutput: boolean;
};

type HeadState = {
  text: string;
  truncation?: ReturnType<typeof truncateHead>;
};

function appendHead(state: HeadState, text: string) {
  if (state.truncation) return;
  const truncation = truncateHead(state.text + text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  state.text = truncation.content;
  if (truncation.truncated) state.truncation = truncation;
}

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
  prefix: string,
  signal?: AbortSignal,
): Promise<RunResult> {
  const tempDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const tempFile = join(tempDir, "output.txt");
  let stopChild: (() => void) | undefined;

  try {
    const child = spawn(binaryPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    stopChild = () => child.kill();

    const stdoutHead: HeadState = { text: "" };
    const stderrHead: HeadState = { text: "" };
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let totalBytes = 0;
    let newlineCount = 0;
    let sawOutput = false;
    let endedWithNewline = false;
    let lineHasContent = false;
    let lineCount = 0;
    let hasOutput = false;

    const consumeStdout = (text: string) => {
      if (!text) return;
      appendHead(stdoutHead, text);
      totalBytes += Buffer.byteLength(text);
      sawOutput = true;
      endedWithNewline = text.endsWith("\n");
      hasOutput ||= /\S/u.test(text);

      let start = 0;
      for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", start)) {
        newlineCount++;
        if (lineHasContent || index > start) lineCount++;
        lineHasContent = false;
        start = index + 1;
      }
      if (start < text.length) lineHasContent = true;
    };

    const stdoutTask = pipeline(
      child.stdout,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          consumeStdout(stdoutDecoder.write(chunk));
          callback(null, chunk);
        },
        flush(callback) {
          consumeStdout(stdoutDecoder.end());
          callback();
        },
      }),
      createWriteStream(tempFile, { flags: "wx" }),
    );

    const stderrTask = pipeline(
      child.stderr,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          appendHead(stderrHead, stderrDecoder.write(chunk));
          callback();
        },
        final(callback) {
          appendHead(stderrHead, stderrDecoder.end());
          callback();
        },
      }),
    );

    const exitTask = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });

    let exitCode: number;
    try {
      [exitCode] = await Promise.all([exitTask, stdoutTask, stderrTask]);
    } catch (error) {
      stopChild();
      await Promise.allSettled([exitTask, stdoutTask, stderrTask]);
      throw error;
    }

    if (lineHasContent) lineCount++;
    const totalLines = newlineCount + (sawOutput && !endedWithNewline ? 1 : 0);
    const truncation = stdoutHead.truncation;
    if (!truncation) {
      await rm(tempDir, { recursive: true });
      return {
        text: stdoutHead.text || "(no output)",
        stderr: stderrHead.text,
        exitCode,
        truncated: false,
        lineCount,
        hasOutput,
      };
    }

    const notice =
      `\n\n[Output truncated: showing ${truncation.outputLines} of ${totalLines} lines` +
      ` (${formatSize(truncation.outputBytes)} of ${formatSize(totalBytes)}).` +
      ` Full output: ${tempFile}]`;

    return {
      text: stdoutHead.text + notice,
      stderr: stderrHead.text,
      exitCode,
      truncated: true,
      fullOutputPath: tempFile,
      lineCount,
      hasOutput,
    };
  } catch (error) {
    stopChild?.();
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
