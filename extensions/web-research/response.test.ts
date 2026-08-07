import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { getOversizedResponsePrefix, readResponseText, withResponseTimeout } from "./response.ts";

function streamingResponse(chunks: Uint8Array[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

const encode = (text: string) => new TextEncoder().encode(text);

describe("readResponseText", () => {
  it("reads a body that fits under the cap", async () => {
    const response = streamingResponse([encode("hello world")]);
    const result = await readResponseText(response, 1000, "T", new AbortController().signal);
    assert.equal(result, "hello world");
  });

  it("joins multiple chunks", async () => {
    const response = streamingResponse([encode("ab"), encode("cd"), encode("ef")]);
    const result = await readResponseText(response, 1000, "T", new AbortController().signal);
    assert.equal(result, "abcdef");
  });

  it("returns an empty string when the response has no body", async () => {
    const response = new Response(null);
    const result = await readResponseText(response, 1000, "T", new AbortController().signal);
    assert.equal(result, "");
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = encode("héllo");
    // "h" is 1 byte, "é" is 2 bytes; split inside the two-byte character.
    const splitIndex = 2;
    const response = streamingResponse([bytes.slice(0, splitIndex), bytes.slice(splitIndex)]);
    const result = await readResponseText(response, 1000, "T", new AbortController().signal);
    assert.equal(result, "héllo");
  });

  it("throws with the prefix when the body exceeds the cap", async () => {
    const response = streamingResponse([encode("abcdefghij")]);
    await assert.rejects(
      readResponseText(response, 4, "TestProvider", new AbortController().signal),
      (error) => {
        assert.equal(getOversizedResponsePrefix(error), "abcd");
        assert.ok(error instanceof Error);
        assert.match(error.message, /TestProvider/);
        assert.match(error.message, /4/);
        return true;
      },
    );
  });

  it("counts bytes across chunks before tripping the cap", async () => {
    const response = streamingResponse([encode("abc"), encode("def")]);
    await assert.rejects(
      readResponseText(response, 4, "T", new AbortController().signal),
      (error) => {
        assert.equal(getOversizedResponsePrefix(error), "abcd");
        return true;
      },
    );
  });

  it("throws without reading when the signal is already aborted", async () => {
    const response = streamingResponse([encode("hello")]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      readResponseText(response, 1000, "T", controller.signal),
      (error) => getOversizedResponsePrefix(error) === undefined,
    );
  });
});

describe("withResponseTimeout", () => {
  it("aborts on the caller signal or the timeout, whichever comes first", async () => {
    const timeoutOnly = withResponseTimeout(undefined, 5);
    await delay(30);
    assert.equal(timeoutOnly.aborted, true);

    const controller = new AbortController();
    const combined = withResponseTimeout(controller.signal, 10_000);
    controller.abort();
    await Promise.resolve();
    assert.equal(combined.aborted, true);
  });
});
