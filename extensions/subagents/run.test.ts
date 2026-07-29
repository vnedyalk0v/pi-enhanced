import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendBounded,
  createPiAssistantTextCollector,
  PiResultRecordTooLargeError,
  runProcess,
} from "./run.ts";

function timeout(message: string) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(message)), 2_000).unref();
  });
}

it(
  "escalates SIGTERM to SIGKILL",
  { skip: process.platform === "win32" },
  async () => {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const handle = runProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1_000);',
      ],
      cwd: process.cwd(),
      onStdout: (chunk) => {
        if (chunk.includes("ready")) markReady();
      },
    });

    try {
      await Promise.race([ready, timeout("child did not become ready")]);
      handle.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 50));
      handle.kill("SIGKILL");
      const result = await Promise.race([handle.wait, timeout("child did not exit")]);
      assert.equal(result.signal, "SIGKILL");
    } finally {
      if (handle.pid !== undefined) {
        try {
          process.kill(-handle.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await handle.wait;
    }
  },
);

it(
  "waits for inherited stdout to close after the child exits",
  { skip: process.platform === "win32" },
  async () => {
    const marker = "tail-after-parent-exit";
    const grandchildScript = `setTimeout(() => process.stdout.write("${marker}"), 200);`;
    const parentScript = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: ["ignore", 1, 2] }).unref();`;
    let stdout = "";
    const handle = runProcess({
      command: process.execPath,
      args: ["-e", parentScript],
      cwd: process.cwd(),
      onStdout: (chunk) => {
        stdout += chunk;
      },
    });

    try {
      await Promise.race([handle.wait, timeout("child streams did not close")]);
      assert.match(stdout, new RegExp(marker));
    } finally {
      if (handle.pid !== undefined) {
        try {
          process.kill(-handle.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  },
);

describe("appendBounded", () => {
  it("keeps a tail when over max", () => {
    const out = appendBounded("abcdef", "ghij", 8);
    assert.equal(out.length, 8);
    assert.equal(out, "cdefghij");
  });
});

describe("createPiAssistantTextCollector", () => {
  const assistantEvent = (text: string) =>
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  const assistantEventAtBytes = (bytes: number) => {
    const empty = assistantEvent("");
    return assistantEvent("x".repeat(bytes - Buffer.byteLength(empty, "utf8")));
  };

  it("returns the last assistant text across arbitrary chunks", () => {
    const collector = createPiAssistantTextCollector();
    const output = `${assistantEvent("first")}\n${assistantEvent("last")}\n`;

    collector.push(output.slice(0, 17));
    collector.push(output.slice(17, 63));
    collector.push(output.slice(63));

    assert.equal(collector.finish(), "last");
  });

  it("accepts complete records through the exact UTF-8 byte ceiling", () => {
    const emptyBytes = Buffer.byteLength(assistantEvent(""), "utf8");
    const limit = emptyBytes + 16;

    for (const size of [limit - 1, limit]) {
      const collector = createPiAssistantTextCollector(limit);
      const event = assistantEventAtBytes(size);

      assert.equal(Buffer.byteLength(event, "utf8"), size);
      collector.push(`${event}\n`);
      assert.equal(collector.finish(), "x".repeat(size - emptyBytes));
    }
  });

  it("rejects a complete record one UTF-8 byte over the ceiling", () => {
    const emptyBytes = Buffer.byteLength(assistantEvent(""), "utf8");
    const limit = emptyBytes + 16;
    const collector = createPiAssistantTextCollector(limit);

    assert.throws(
      () => collector.push(`${assistantEventAtBytes(limit + 1)}\n`),
      PiResultRecordTooLargeError,
    );
  });

  it("rejects an oversized unterminated record and stays failed", () => {
    const collector = createPiAssistantTextCollector(16);

    assert.equal(collector.push("x".repeat(16)), "");
    assert.throws(() => collector.push("é"), {
      name: "PiResultRecordTooLargeError",
      code: "PI_RESULT_RECORD_TOO_LARGE",
    });
    assert.throws(() => collector.finish(), PiResultRecordTooLargeError);
  });

  it("measures the ceiling in UTF-8 bytes, not characters", () => {
    const event = assistantEvent("é");
    const collector = createPiAssistantTextCollector(
      Buffer.byteLength(event, "utf8") - 1,
    );

    assert.throws(() => collector.push(`${event}\n`), PiResultRecordTooLargeError);
  });

  it("ignores malformed lines", () => {
    const collector = createPiAssistantTextCollector();

    collector.push(`not-json\n${assistantEvent("valid")}\n{broken}\n`);

    assert.equal(collector.finish(), "valid");
  });

  it("processes an unterminated final record only on finish", () => {
    const collector = createPiAssistantTextCollector();

    assert.equal(collector.push(assistantEvent("final")), "");
    assert.equal(collector.finish(), "final");
  });
});
