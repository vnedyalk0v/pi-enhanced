import type { WriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Newest-bytes retained per stream in memory (for /ps and tool peeks). */
export const MAX_RETAINED_BYTES = 2 * 1024 * 1024;
export const MAX_SPILL_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_SPILL_BYTES = 64 * 1024 * 1024;

export type SpillBudget = {
  remainingBytes: number;
};

export type OutputView = {
  text: string;
  totalBytes: number;
  truncatedBytes: number;
  spillTruncatedBytes: number;
  spillPath?: string;
};

/**
 * Bounded decoded text buffer: keeps the newest bytes, drops the head, and
 * optionally appends output to a bounded spill file.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private retainedBytes = 0;
  totalBytes = 0;
  truncatedBytes = 0;
  spillTruncatedBytes = 0;
  spillPath?: string;
  private spillStream?: WriteStream;
  private spillError?: string;
  private spillBytes = 0;
  private spillStopped = false;
  private spillBudget?: SpillBudget;
  private maxSpillBytes = MAX_SPILL_BYTES;
  private closed = false;
  private maxRetainedBytes: number;

  constructor(
    maxRetainedBytes: number = MAX_RETAINED_BYTES,
    spill?: {
      path: string;
      stream: WriteStream;
      budget?: SpillBudget;
      maxBytes?: number;
    },
  ) {
    this.maxRetainedBytes = maxRetainedBytes;
    if (spill) {
      this.spillPath = spill.path;
      this.spillStream = spill.stream;
      this.spillBudget = spill.budget;
      this.maxSpillBytes = spill.maxBytes ?? MAX_SPILL_BYTES;
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
      const capacity = Math.min(
        this.maxSpillBytes - this.spillBytes,
        this.spillBudget?.remainingBytes ?? Infinity,
      );
      if (!this.spillStopped && capacity > 0) {
        let spillChunk: string | Buffer = chunk;
        let spillChunkBytes = chunkBytes;
        if (chunkBytes > capacity) {
          const encoded = Buffer.from(chunk, "utf8");
          spillChunkBytes = capacity;
          while (
            spillChunkBytes > 0 &&
            encoded[spillChunkBytes] !== undefined &&
            (encoded[spillChunkBytes]! & 0xc0) === 0x80
          ) {
            spillChunkBytes -= 1;
          }
          spillChunk = encoded.subarray(0, spillChunkBytes);
        }
        if (spillChunkBytes > 0) {
          accepted = this.spillStream.write(spillChunk);
          this.spillBytes += spillChunkBytes;
          if (this.spillBudget) this.spillBudget.remainingBytes -= spillChunkBytes;
        }
        this.spillStopped = spillChunkBytes < chunkBytes;
        this.spillTruncatedBytes += chunkBytes - spillChunkBytes;
      } else {
        this.spillStopped = true;
        this.spillTruncatedBytes += chunkBytes;
      }
    }

    if (chunkBytes >= this.maxRetainedBytes) {
      this.chunks = [];
      this.retainedBytes = 0;
      const buf = Buffer.from(chunk, "utf8");
      // Advance off any continuation byte so the decoded tail starts on a whole
      // character; decoding an arbitrary byte offset yields U+FFFD and inflates
      // the retained size past the cap.
      let start = buf.length - this.maxRetainedBytes;
      while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
        start += 1;
      }
      const tail = buf.subarray(start).toString("utf8");
      this.chunks.push(tail);
      this.retainedBytes = Buffer.byteLength(tail, "utf8");
      this.truncatedBytes = Math.max(0, this.totalBytes - this.retainedBytes);
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
      spillTruncatedBytes: this.spillTruncatedBytes,
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
