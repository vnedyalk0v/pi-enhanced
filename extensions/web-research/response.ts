const oversizedPrefixes = new WeakMap<object, string>();

export function getOversizedResponsePrefix(error: unknown) {
  return typeof error === "object" && error !== null
    ? oversizedPrefixes.get(error)
    : undefined;
}

export function withResponseTimeout(signal?: AbortSignal, timeoutMs = 30_000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
  label: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return text + decoder.decode();
      const remaining = Math.max(0, maxBytes - bytes);
      if (value.byteLength > remaining) {
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        text += decoder.decode();
        const error = new Error(`${label} response exceeded ${maxBytes} bytes`);
        oversizedPrefixes.set(error, text);
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
