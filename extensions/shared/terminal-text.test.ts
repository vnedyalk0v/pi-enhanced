import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalControlStrings, terminalText } from "./terminal-text.ts";

describe("terminal text sanitization", () => {
  it("strips terminated OSC and DCS strings plus ordinary VT sequences", () => {
    const value = "before\x1b]0;title\x07middle\x1bPpayload\x1b\\after\x1b[31mred\x1b[0m";
    assert.equal(stripTerminalControlStrings(value), "beforemiddleafterred");
  });

  it("consumes unterminated control strings through the end in linear order", () => {
    const malformed = `safe${"\x1b]unterminated".repeat(20_000)}`;
    assert.equal(stripTerminalControlStrings(malformed), "safe");
  });

  it("keeps terminalText one-line safe", () => {
    assert.equal(terminalText("one\ttwo\nthree\x1b[31m!"), "one two three!");
  });
});
