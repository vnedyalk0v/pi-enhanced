import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Newest-bytes retained per stream in memory (for /ps and tool peeks). */
export const MAX_RETAINED_BYTES = 2 * 1024 * 1024;

export type OutputView = {
  text: string;
  totalBytes: number;
  truncatedBytes: number;
  spillPath?: string;
};

/**
 * Bounded decoded text buffer: keeps the newest bytes, drops the head, and
 * optionally appends every byte to a spill file for full capture.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private retainedBytes = 0;
  totalBytes = 0;
  truncatedBytes = 0;
  spillPath?: string;
  private spillStream?: WriteStream;
  private spillError?: string;
  private closed = false;
  private maxRetainedBytes: number;

  constructor(
    maxRetainedBytes: number = MAX_RETAINED_BYTES,
    spill?: { path: string; stream: WriteStream },
  ) {
    this.maxRetainedBytes = maxRetainedBytes;
    if (spill) {
      this.spillPath = spill.path;
      this.spillStream = spill.stream;
      this.spillStream.on("error", (err) => {
        this.spillError = err instanceof Error ? err.message : String(err);
        this.spillPath = undefined;
      });
    }
  }

  push(chunk: string) {
    if (this.closed || chunk.length === 0) return;

    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    this.totalBytes += chunkBytes;

    if (this.spillStream && !this.spillError) {
      this.spillStream.write(chunk);
    }

    if (chunkBytes >= this.maxRetainedBytes) {
      // Keep only the newest tail of this chunk (UTF-8 safe via Buffer slice).
      this.chunks = [];
      this.retainedBytes = 0;
      const buf = Buffer.from(chunk, "utf8");
      const tail = buf.subarray(buf.length - this.maxRetainedBytes).toString("utf8");
      this.chunks.push(tail);
      this.retainedBytes = Buffer.byteLength(tail, "utf8");
      this.truncatedBytes = this.totalBytes - this.retainedBytes;
      return;
    }

    this.chunks.push(chunk);
    this.retainedBytes += chunkBytes;

    while (this.retainedBytes > this.maxRetainedBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!;
      const droppedBytes = Buffer.byteLength(dropped, "utf8");
      this.retainedBytes -= droppedBytes;
      this.truncatedBytes += droppedBytes;
    }
  }

  view(): OutputView {
    return {
      text: this.chunks.join(""),
      totalBytes: this.totalBytes,
      truncatedBytes: this.truncatedBytes,
      spillPath: this.spillPath,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const stream = this.spillStream;
    this.spillStream = undefined;
    if (!stream) return;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
      // Avoid hanging forever if the stream is stuck.
      setTimeout(resolve, 2000).unref?.();
    });
  }
}

export function sessionSpillDir(sessionKey: string) {
  return join(tmpdir(), "pi-background-terminals", sanitizePathSegment(sessionKey));
}

export async function openSpillStreams(
  sessionKey: string,
  terminalId: string,
): Promise<{
  dir: string;
  stdout: { path: string; stream: WriteStream };
  stderr: { path: string; stream: WriteStream };
}> {
  const dir = sessionSpillDir(sessionKey);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const stdoutPath = join(dir, `${terminalId}.stdout.log`);
  const stderrPath = join(dir, `${terminalId}.stderr.log`);

  return {
    dir,
    stdout: {
      path: stdoutPath,
      stream: createWriteStream(stdoutPath, { flags: "a", mode: 0o600 }),
    },
    stderr: {
      path: stderrPath,
      stream: createWriteStream(stderrPath, { flags: "a", mode: 0o600 }),
    },
  };
}

export async function removeSpillDir(sessionKey: string) {
  const dir = sessionSpillDir(sessionKey);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

function sanitizePathSegment(value: string) {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return cleaned || "session";
}
