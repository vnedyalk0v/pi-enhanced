import { stripVTControlCharacters } from "node:util";

const VT_CONTROL_STRING_PATTERN =
  /(?:(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c)|(?:\x1b(?:P|X|\^|_)|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\x1b\\|\u009c))/g;

/** Strip OSC/DCS/SOS/PM/APC control strings plus ordinary VT sequences. */
export function stripTerminalControlStrings(value: string) {
  return stripVTControlCharacters(value.replace(VT_CONTROL_STRING_PATTERN, ""));
}

/** One-line-safe, control-free text for overlay rows and headers. */
export function terminalText(value: string) {
  return stripTerminalControlStrings(value)
    .replace(/[\t\r\n]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}
