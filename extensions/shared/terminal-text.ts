import { stripVTControlCharacters } from "node:util";

function stripControlStrings(value: string) {
  let output = "";
  let chunkStart = 0;
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    let introducerLength = 0;
    let osc = false;
    if (code === 0x1b && index + 1 < value.length) {
      const next = value[index + 1];
      if (next === "]") {
        introducerLength = 2;
        osc = true;
      } else if (next === "P" || next === "X" || next === "^" || next === "_") {
        introducerLength = 2;
      }
    } else if (code === 0x9d) {
      introducerLength = 1;
      osc = true;
    } else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      introducerLength = 1;
    }
    if (introducerLength === 0) {
      index++;
      continue;
    }

    output += value.slice(chunkStart, index);
    index += introducerLength;
    while (index < value.length) {
      const current = value.charCodeAt(index);
      if (osc && current === 0x07) {
        index++;
        break;
      }
      if (current === 0x9c) {
        index++;
        break;
      }
      if (current === 0x1b && value[index + 1] === "\\") {
        index += 2;
        break;
      }
      index++;
    }
    chunkStart = index;
  }
  return output + value.slice(chunkStart);
}

/** Strip OSC/DCS/SOS/PM/APC control strings plus ordinary VT sequences. */
export function stripTerminalControlStrings(value: string) {
  return stripVTControlCharacters(stripControlStrings(value));
}

/** One-line-safe, control-free text for overlay rows and headers. */
export function terminalText(value: string) {
  return stripTerminalControlStrings(value)
    .replace(/[\t\r\n]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}
