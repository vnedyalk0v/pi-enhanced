import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type BinaryName, ensureBinary } from "./binaries.ts";
import {
  buildFdArgs,
  buildRgArgs,
  runBinary,
  stripSpillPathClause,
  type RunResult,
} from "./run.ts";

const FdParams = Type.Object({
  pattern: Type.String({
    description:
      "Filename pattern. Glob by default (e.g. *.ts, **/*.tsx). Set regex=true for fd regex syntax (e.g. .*\\.ts$).",
  }),
  path: Type.Optional(Type.String({ description: "Root directory (default: cwd)" })),
  type: Type.Optional(
    Type.String({ description: "Entry type filter: f (file), d (directory), l (symlink)" }),
  ),
  extension: Type.Optional(Type.String({ description: "File extension without dot" })),
  hidden: Type.Optional(Type.Boolean({ description: "Include hidden files" })),
  maxResults: Type.Optional(Type.Number({ description: "Max results to return" })),
  regex: Type.Optional(
    Type.Boolean({
      description: "Treat pattern as a regular expression instead of a glob (default false)",
    }),
  ),
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
  signal?: AbortSignal,
): Promise<string> {
  const cached = binaryCache.get(name);
  if (cached) return cached;
  const result = await ensureBinary(name, { signal });
  if (result.installed) {
    notify?.(`Installed ${name} to local Pi bin directory`);
  }
  binaryCache.set(name, result.path);
  return result.path;
}

/**
 * Make fd/rg the default discovery tools for this package:
 * keep them active and deactivate built-in find/grep when present.
 */
function preferFdAndRg(pi: ExtensionAPI) {
  const active = pi.getActiveTools();
  const next = active.filter((name) => name !== "find" && name !== "grep");
  if (!next.includes("fd")) next.push("fd");
  if (!next.includes("rg")) next.push("rg");

  const same =
    next.length === active.length &&
    next.every((name) => active.includes(name)) &&
    active.includes("fd") &&
    active.includes("rg") &&
    !active.includes("find") &&
    !active.includes("grep");
  if (!same) pi.setActiveTools(next);
}

export default function (pi: ExtensionAPI) {
  const spillDirectories = new Set<string>();
  let shuttingDown = false;

  async function trackSpill(result: RunResult) {
    const { fullOutputPath } = result;
    if (!fullOutputPath) return result;
    const directory = dirname(fullOutputPath);
    if (shuttingDown) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      return {
        ...result,
        text: stripSpillPathClause(result.text),
        fullOutputPath: undefined,
      };
    }
    spillDirectories.add(directory);
    return result;
  }

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    const directories = [...spillDirectories];
    spillDirectories.clear();
    await Promise.allSettled(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

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
    // Prefer our tools over built-in find/grep for this package.
    preferFdAndRg(pi);
  });

  // Re-apply after branch/session switches that may restore tool sets.
  pi.on("session_tree", async () => {
    preferFdAndRg(pi);
  });

  pi.registerTool({
    name: "fd",
    label: "fd",
    description: `Find files by name using fd (default for this package). Patterns are globs by default (*.ts works). Set regex=true for regex. Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Prefer fd over find, bash find, or ls pipelines for filename discovery.`,
    promptSnippet: "Default file finder (fd globs, e.g. *.ts)",
    promptGuidelines: [
      "Use fd for finding files by name or glob (e.g. *.ts, **/index.ts). Do not use find, bash find, or ls pipelines for filename discovery when fd is available.",
      "fd patterns are globs by default; use regex=true only when you need regular expressions.",
    ],
    parameters: FdParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const binary = await getBinary("fd", (msg) => {
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
        }, signal);
        const args = buildFdArgs(params);
        const result = await trackSpill(
          await runBinary(binary, args, ctx.cwd, "pi-fd", signal),
        );
        if (result.exitCode !== 0 && !result.hasOutput) {
          return {
            content: [
              {
                type: "text" as const,
                text: result.stderr.trim() || `fd exited ${result.exitCode}`,
              },
            ],
            details: { exitCode: result.exitCode, matchCount: 0 },
          };
        }
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            exitCode: result.exitCode,
            matchCount: result.lineCount,
            truncated: result.truncated,
            fullOutputPath: result.fullOutputPath,
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
    description: `Search file contents using ripgrep (default for this package). Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Prefer rg over grep or bash grep for content search.`,
    promptSnippet: "Default content search (rg)",
    promptGuidelines: [
      "Use rg for searching code/text by regex. Do not use grep, bash grep, or find+xargs for content search when rg is available.",
      "Use rg's path and glob parameters to narrow the search instead of grepping the whole disk.",
    ],
    parameters: RgParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const binary = await getBinary("rg", (msg) => {
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
        }, signal);
        const args = buildRgArgs(params);
        const result = await trackSpill(
          await runBinary(binary, args, ctx.cwd, "pi-rg", signal),
        );
        // rg exits 1 when no matches
        if (result.exitCode === 1 && !result.hasOutput) {
          return {
            content: [{ type: "text" as const, text: "No matches found" }],
            details: { exitCode: result.exitCode, matchCount: 0 },
          };
        }
        if (result.exitCode > 1 && !result.hasOutput) {
          return {
            content: [
              {
                type: "text" as const,
                text: result.stderr.trim() || `rg exited ${result.exitCode}`,
              },
            ],
            details: { exitCode: result.exitCode, matchCount: 0 },
          };
        }
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            exitCode: result.exitCode,
            matchCount: result.lineCount,
            truncated: result.truncated,
            fullOutputPath: result.fullOutputPath,
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
