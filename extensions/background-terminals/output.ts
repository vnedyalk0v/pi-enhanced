import type { WriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
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
        this.spillStream = undefined;
      });
    }
  }

  push(chunk: string) {
    if (this.closed || chunk.length === 0) return true;

    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    this.totalBytes += chunkBytes;

    let accepted = true;
    if (this.spillStream && !this.spillError) {
      accepted = this.spillStream.write(chunk);
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
      return accepted;
    }

    this.chunks.push(chunk);
    this.retainedBytes += chunkBytes;

    while (this.retainedBytes > this.maxRetainedBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!;
      const droppedBytes = Buffer.byteLength(dropped, "utf8");
      this.retainedBytes -= droppedBytes;
      this.truncatedBytes += droppedBytes;
    }
    return accepted;
  }

  async waitForDrain() {
    const stream = this.spillStream;
    if (!stream || this.spillError || !stream.writableNeedDrain) return;

    await new Promise<void>((resolve) => {
      const done = () => {
        stream.off("drain", done);
        stream.off("error", done);
        stream.off("close", done);
        resolve();
      };
      stream.once("drain", done);
      stream.once("error", done);
      stream.once("close", done);
      if (!stream.writableNeedDrain) done();
    });
  }

  view(includeText = true): OutputView {
    return {
      text: includeText ? this.chunks.join("") : "",
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
      // Avoid hanging forever if the stream is stuck.
      const timeout = setTimeout(resolve, 2000);
      timeout.unref?.();
      stream.end(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

export function createSpillDir() {
  return mkdtemp(join(tmpdir(), "pi-background-terminals-"));
}

export async function openSpillStreams(
  dir: string,
  terminalId: string,
): Promise<{
  dir: string;
  stdout: { path: string; stream: WriteStream };
  stderr: { path: string; stream: WriteStream };
}> {
  const stdoutPath = join(dir, `${terminalId}.stdout.log`);
  const stderrPath = join(dir, `${terminalId}.stderr.log`);
  const stdoutHandle = await open(stdoutPath, "wx", 0o600);
  let stderrHandle;
  try {
    stderrHandle = await open(stderrPath, "wx", 0o600);
  } catch (error) {
    await stdoutHandle.close();
    await rm(stdoutPath, { force: true });
    throw error;
  }

  return {
    dir,
    stdout: {
      path: stdoutPath,
      stream: stdoutHandle.createWriteStream(),
    },
    stderr: {
      path: stderrPath,
      stream: stderrHandle.createWriteStream(),
    },
  };
}

export async function removeSpillDir(dir: string) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
