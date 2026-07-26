import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type BinaryName, ensureBinary } from "./binaries.ts";
import { buildFdArgs, buildRgArgs, runBinary, truncateToolOutput } from "./run.ts";

const FdParams = Type.Object({
  pattern: Type.String({ description: "Filename glob/pattern for fd" }),
  path: Type.Optional(Type.String({ description: "Root directory (default: cwd)" })),
  type: Type.Optional(
    Type.String({ description: "Entry type filter: f (file), d (directory), l (symlink)" }),
  ),
  extension: Type.Optional(Type.String({ description: "File extension without dot" })),
  hidden: Type.Optional(Type.Boolean({ description: "Include hidden files" })),
  maxResults: Type.Optional(Type.Number({ description: "Max results to return" })),
});

const RgParams = Type.Object({
  pattern: Type.String({ description: "Regex pattern" }),
  path: Type.Optional(Type.String({ description: "File or directory (default: cwd)" })),
  glob: Type.Optional(Type.String({ description: "Glob filter, e.g. '*.ts'" })),
  caseInsensitive: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
  maxCount: Type.Optional(Type.Number({ description: "Max matches per file" })),
});

const binaryCache = new Map<BinaryName, string>();

async function getBinary(
  name: BinaryName,
  notify?: (message: string) => void,
): Promise<string> {
  const cached = binaryCache.get(name);
  if (cached) return cached;
  const result = await ensureBinary(name);
  if (result.installed) {
    notify?.(`Installed ${name} to local Pi bin directory`);
  }
  binaryCache.set(name, result.path);
  return result.path;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Resolve quietly at startup; install only if missing.
    for (const name of ["fd", "rg"] as const) {
      try {
        const result = await ensureBinary(name);
        binaryCache.set(name, result.path);
        if (result.installed && ctx.hasUI) {
          ctx.ui.notify(`Installed ${name} for file-search tools`, "info");
        }
      } catch {
        // Leave resolution to first tool use so the model sees a clear error.
      }
    }
  });

  pi.registerTool({
    name: "fd",
    label: "fd",
    description: `Find files by name using fd. Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Prefer this over shell find for filename discovery.`,
    promptSnippet: "Find files by name (fd)",
    parameters: FdParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const binary = await getBinary("fd", (msg) => {
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
        });
        const args = buildFdArgs(params);
        const { stdout, stderr, exitCode } = await runBinary(binary, args, ctx.cwd, signal);
        if (exitCode !== 0 && !stdout.trim()) {
          return {
            content: [{ type: "text" as const, text: stderr.trim() || `fd exited ${exitCode}` }],
            details: { exitCode, matchCount: 0 },
          };
        }
        const truncated = await truncateToolOutput(stdout, "pi-fd");
        return {
          content: [{ type: "text" as const, text: truncated.text }],
          details: {
            exitCode,
            matchCount: truncated.lineCount,
            truncated: truncated.truncated,
            fullOutputPath: truncated.fullOutputPath,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `fd failed: ${message}` }],
          details: { exitCode: 1, matchCount: 0 },
        };
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("fd "));
      text += theme.fg("accent", args.pattern);
      if (args.path) text += theme.fg("muted", ` in ${args.path}`);
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "rg",
    label: "rg",
    description: `Search file contents using ripgrep. Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Prefer this over shell grep for content search.`,
    promptSnippet: "Search file contents (rg)",
    parameters: RgParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const binary = await getBinary("rg", (msg) => {
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
        });
        const args = buildRgArgs(params);
        const { stdout, stderr, exitCode } = await runBinary(binary, args, ctx.cwd, signal);
        // rg exits 1 when no matches
        if (exitCode === 1 && !stdout.trim()) {
          return {
            content: [{ type: "text" as const, text: "No matches found" }],
            details: { exitCode, matchCount: 0 },
          };
        }
        if (exitCode > 1 && !stdout.trim()) {
          return {
            content: [{ type: "text" as const, text: stderr.trim() || `rg exited ${exitCode}` }],
            details: { exitCode, matchCount: 0 },
          };
        }
        const truncated = await truncateToolOutput(stdout, "pi-rg");
        return {
          content: [{ type: "text" as const, text: truncated.text }],
          details: {
            exitCode,
            matchCount: truncated.lineCount,
            truncated: truncated.truncated,
            fullOutputPath: truncated.fullOutputPath,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `rg failed: ${message}` }],
          details: { exitCode: 1, matchCount: 0 },
        };
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("rg "));
      text += theme.fg("accent", `"${args.pattern}"`);
      if (args.path) text += theme.fg("muted", ` in ${args.path}`);
      if (args.glob) text += theme.fg("dim", ` --glob ${args.glob}`);
      return new Text(text, 0, 0);
    },
  });
}
