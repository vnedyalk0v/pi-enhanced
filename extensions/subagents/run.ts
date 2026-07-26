import { spawn, type ChildProcess } from "node:child_process";

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

  let killed = false;
  let resolveWait!: (v: { exitCode: number; signal?: string }) => void;
  const wait = new Promise<{ exitCode: number; signal?: string }>((resolve) => {
    resolveWait = resolve;
  });

  child.stdout?.on("data", (buf: Buffer) => {
    options.onStdout?.(buf.toString("utf8"));
  });
  child.stderr?.on("data", (buf: Buffer) => {
    options.onStderr?.(buf.toString("utf8"));
  });

  child.once("error", (err) => {
    options.onStderr?.(err.message);
    resolveWait({ exitCode: 1 });
  });

  child.once("exit", (code, signal) => {
    resolveWait({
      exitCode: code ?? (signal ? 1 : 0),
      signal: signal ?? undefined,
    });
  });

  const kill = (signal: NodeJS.Signals = "SIGTERM") => {
    if (killed) return;
    killed = true;
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
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
      };
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = contentToText(event.message.content);
        if (text) last = text;
      }
    } catch {
      // non-json line
    }
  }
  return last;
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

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string };
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n").trim();
}

function stringField(obj: Record<string, unknown>, key: string) {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

export function resolvePiInvocation(args: string[]) {
  // Prefer the same pi binary on PATH that users run interactively.
  return { command: "pi", args };
}

export function resolveCodexInvocation(args: string[]) {
  return { command: "codex", args };
}
