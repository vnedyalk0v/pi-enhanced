import { spawn, type ChildProcess } from "node:child_process";
import { contentToText } from "../shared/text.ts";

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

  child.stdout?.on("data", (buf: Buffer) => {
    options.onStdout?.(buf.toString("utf8"));
  });
  child.stderr?.on("data", (buf: Buffer) => {
    options.onStderr?.(buf.toString("utf8"));
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

export function extractPiLastAssistantText(stdout: string) {
  let last = "";
  for (const line of stdout.split("\n")) {
    const text = parsePiAssistantText(line);
    if (text) last = text;
  }
  return last;
}

export function createPiAssistantTextCollector() {
  let remainder = "";
  let last = "";
  const processLine = (line: string) => {
    const text = parsePiAssistantText(line);
    if (text) last = text;
  };

  return {
    push(chunk: string) {
      const lines = (remainder + chunk).split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) processLine(line);
      return last;
    },
    finish() {
      processLine(remainder);
      remainder = "";
      return last;
    },
  };
}

export function extractCodexLastMessage(stdout: string, fileContents?: string) {
  if (fileContents?.trim()) return fileContents.trim();

  let last = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = String(event.type ?? event.msg ?? "");
      // Common codex JSONL shapes
      if (
        type === "item.completed" ||
        type === "agent_message" ||
        type === "message" ||
        type.includes("agent_message")
      ) {
        const text =
          stringField(event, "text") ||
          stringField(event, "message") ||
          contentToText(event.content) ||
          contentToText((event.item as Record<string, unknown> | undefined)?.text);
        if (text) last = text;
      }
      if (event.last_agent_message && typeof event.last_agent_message === "string") {
        last = event.last_agent_message;
      }
    } catch {
      // ignore
    }
  }
  return last;
}

function stringField(obj: Record<string, unknown>, key: string) {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

function parsePiAssistantText(line: string) {
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
    return "";
  }
}
