/** Newest-bytes retained per stream in memory (for /ps and tool peeks). */
export const MAX_RETAINED_BYTES = 2 * 1024 * 1024;

export type OutputView = {
  text: string;
  totalBytes: number;
  truncatedBytes: number;
};

/** Bounded decoded text buffer: keeps the newest bytes and drops the head. */
export class OutputBuffer {
  private chunks: string[] = [];
  private retainedBytes = 0;
  totalBytes = 0;
  truncatedBytes = 0;
  private maxRetainedBytes: number;

  constructor(maxRetainedBytes: number = MAX_RETAINED_BYTES) {
    this.maxRetainedBytes = maxRetainedBytes;
  }

  push(chunk: string) {
    if (chunk.length === 0) return;

    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    this.totalBytes += chunkBytes;

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

  view(includeText = true): OutputView {
    return {
      text: includeText ? this.chunks.join("") : "",
      totalBytes: this.totalBytes,
      truncatedBytes: this.truncatedBytes,
    };
  }
}
