import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { contentToText } from "../shared/text.ts";

export const PI_RESULT_RECORD_MAX_BYTES = 4 * 1024 * 1024;

export class PiResultRecordTooLargeError extends Error {
  readonly code = "PI_RESULT_RECORD_TOO_LARGE";
  readonly maxBytes: number;

  constructor(maxBytes = PI_RESULT_RECORD_MAX_BYTES) {
    super(`Pi result record exceeds the ${maxBytes}-byte UTF-8 limit.`);
    this.name = "PiResultRecordTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export type RunHandle = {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => void;
  wait: Promise<{ exitCode: number; signal?: string }>;
};

export type RunOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

/**
 * Spawn a child process, stream stdout/stderr, support SIGTERM then SIGKILL.
 * POSIX: detached process group so tree kill works.
 */
export function runProcess(options: RunOptions): RunHandle {
  const isWin = process.platform === "win32";
  const child: ChildProcess = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWin,
    windowsHide: true,
  });

  let settled = false;
  let exitResult: { exitCode: number; signal?: string } | undefined;
  const sentSignals = new Set<NodeJS.Signals>();
  let resolveWait!: (v: { exitCode: number; signal?: string }) => void;
  const wait = new Promise<{ exitCode: number; signal?: string }>((resolve) => {
    resolveWait = resolve;
  });
  const settle = (result: { exitCode: number; signal?: string }) => {
    if (settled) return;
    settled = true;
    resolveWait(result);
  };

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout?.on("data", (buf: Buffer) => {
    const text = stdoutDecoder.write(buf);
    if (text) options.onStdout?.(text);
  });
  child.stderr?.on("data", (buf: Buffer) => {
    const text = stderrDecoder.write(buf);
    if (text) options.onStderr?.(text);
  });
  child.stdout?.once("end", () => {
    const text = stdoutDecoder.end();
    if (text) options.onStdout?.(text);
  });
  child.stderr?.once("end", () => {
    const text = stderrDecoder.end();
    if (text) options.onStderr?.(text);
  });

  child.once("error", (err) => {
    options.onStderr?.(err.message);
    settle({ exitCode: 1 });
  });

  child.once("exit", (code, signal) => {
    exitResult = {
      exitCode: code ?? (signal ? 1 : 0),
      signal: signal ?? undefined,
    };
  });

  child.once("close", (code, signal) => {
    settle(
      exitResult ?? {
        exitCode: code ?? (signal ? 1 : 0),
        signal: signal ?? undefined,
      },
    );
  });

  const kill = (signal: NodeJS.Signals = "SIGTERM") => {
    if (settled || sentSignals.has(signal)) return;
    sentSignals.add(signal);
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      if (isWin) {
        spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        try {
          process.kill(-pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // already gone
          }
        }
      }
    } catch {
      // ignore
    }
  };

  if (options.signal) {
    const onAbort = () => {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref?.();
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  return { pid: child.pid, kill, wait };
}

export function appendBounded(current: string, chunk: string, maxChars = 80_000) {
  const next = current + chunk;
  if (next.length <= maxChars) return next;
  return next.slice(next.length - maxChars);
}

export function createPiAssistantTextCollector(maxBytes = PI_RESULT_RECORD_MAX_BYTES) {
  let remainder = "";
  let last = "";
  let droppedLines = 0;
  let overflow: PiResultRecordTooLargeError | undefined;
  const fail = () => {
    overflow ??= new PiResultRecordTooLargeError(maxBytes);
    remainder = "";
    last = "";
    throw overflow;
  };
  const check = (text: string) => {
    if (Buffer.byteLength(text, "utf8") > maxBytes) fail();
  };
  const normalizeLine = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);
  const processLine = (rawLine: string) => {
    const line = normalizeLine(rawLine);
    check(line);
    const text = parsePiAssistantText(line, () => droppedLines++);
    if (text) {
      check(text);
      last = text;
    }
  };

  return {
    get droppedLines() {
      return droppedLines;
    },
    push(chunk: string) {
      if (overflow) throw overflow;
      let offset = 0;
      for (let newline = chunk.indexOf("\n"); newline >= 0; newline = chunk.indexOf("\n", offset)) {
        const line = remainder + chunk.slice(offset, newline);
        remainder = "";
        processLine(line);
        offset = newline + 1;
      }
      remainder += chunk.slice(offset);
      check(normalizeLine(remainder));
      return last;
    },
    finish() {
      if (overflow) throw overflow;
      processLine(remainder);
      remainder = "";
      return last;
    },
  };
}

function parsePiAssistantText(line: string, onParseFailure?: () => void) {
  if (!line.trim()) return "";
  try {
    const event = JSON.parse(line) as {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    return event.type === "message_end" && event.message?.role === "assistant"
      ? contentToText(event.message.content)
      : "";
  } catch {
    onParseFailure?.();
    return "";
  }
}
