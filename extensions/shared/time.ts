import { setTimeout as delay } from "node:timers/promises";

export function formatElapsed(createdAt: number, settledAt?: number) {
  const end = settledAt ?? Date.now();
  const ms = Math.max(0, end - createdAt);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m${rem}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

export function sleep(ms: number, signal?: AbortSignal) {
  return delay(ms, undefined, { ref: false, signal });
}

/** A wait/cancel/kill wait was aborted; the underlying work continues in the background. */
export class WaitAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaitAbortedError";
  }
}

export function abortPromise(signal: AbortSignal | undefined, message: string) {
  if (!signal) return new Promise<never>(() => {});
  if (signal.aborted) return Promise.reject(new WaitAbortedError(message));
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new WaitAbortedError(message)), { once: true });
  });
}
