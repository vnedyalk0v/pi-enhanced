import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createManagerHost } from "../shared/host.ts";
import { TOOL_LIMITS_NOTE, truncateOneLine } from "../shared/text.ts";
import { JobsOverlay } from "../shared/jobs-overlay.ts";
import {
  buildKillResult,
  buildListResult,
  buildStartResult,
  buildStatusResult,
  buildTerminalResultMessage,
} from "./format.ts";
import { TerminalManager, type TerminalSnapshot } from "./manager.ts";
import { terminalOverlayConfig } from "./ps.ts";

const WIDGET_ID = "background-terminals";

const StartParams = Type.Object({
  command: Type.String({
    description:
      "Shell command line to run in the background (sh -c on POSIX, cmd.exe /d /s /c on Windows). Receives no stdin (EOF immediately); interactive commands will not work.",
  }),
  title: Type.String({
    description: "Short human-readable name shown in listings and the UI",
  }),
  working_dir: Type.Optional(
    Type.String({ description: "Working directory (default: current working directory)" }),
  ),
});

const StatusParams = Type.Object({
  id: Type.String({ description: 'Terminal id, e.g. "bt-1"' }),
});

const KillParams = Type.Object({
  ids: Type.Array(Type.String(), {
    description: 'Terminal ids to stop, e.g. ["bt-1"]',
  }),
});

export default function (pi: ExtensionAPI) {
  let manager: TerminalManager | undefined;

  const host = createManagerHost<TerminalSnapshot>(pi, {
    widgetId: WIDGET_ID,
    customType: "background-terminal-result",
    runningLabel: (n) =>
      n === 1
        ? "1 background terminal running • /ps to view"
        : `${n} background terminals running • /ps to view`,
    completion: (snap) => ({
      content: buildTerminalResultMessage(snap),
      details: {
        id: snap.id,
        title: snap.title,
        status: snap.status,
        exitCode: snap.exitCode,
        signal: snap.signal,
      },
    }),
    getRunning: () => manager?.getRunningCount(),
    dispose: async () => {
      const m = manager;
      manager = undefined;
      if (m) await m.disposeAll();
    },
  });

  const getManager = () => {
    if (host.disposed) throw new Error("Background terminal manager is shutting down.");
    manager ??= new TerminalManager({
      onSettled: host.onSettled,
      onChange: host.updateWidget,
    });
    return manager;
  };

  pi.registerTool({
    name: "bg_start",
    label: "Background start",
    description: `Start a long-lived shell command in the background (dev servers, watchers, streaming builds). No stdin. ${TOOL_LIMITS_NOTE}`,
    promptSnippet:
      "Run a long-lived shell command in the background (dev servers, builds, watchers); output is captured and you're notified on exit",
    promptGuidelines: [
      "Use bg_start for commands expected to run long or indefinitely (servers, watch modes); use the regular bash tool for quick commands.",
      "bg_start processes receive no stdin — never start a command that requires interactive input.",
      "After bg_start, keep working; the exit result arrives automatically. Use bg_status only when you need current output before continuing.",
    ],
    parameters: StartParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const m = getManager();
      const cwd = resolve(ctx.cwd, params.working_dir ?? ".");
      const snap = await m.start({
        command: params.command,
        title: params.title,
        cwd,
      });
      host.updateWidget();
      return {
        content: [{ type: "text" as const, text: buildStartResult(snap) }],
        details: { id: snap.id, pid: snap.pid, status: snap.status },
      };
    },
  });

  pi.registerTool({
    name: "bg_status",
    label: "Background status",
    description: `Get status and recent output for a background terminal. ${TOOL_LIMITS_NOTE}`,
    promptSnippet: "Inspect a background terminal's status and recent output",
    parameters: StatusParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const m = getManager();
      const snap = m.get(params.id);
      if (!snap) {
        throw new Error(`Unknown terminal id: ${params.id}`);
      }
      // If completion was pending, model is reading it now — don't also inject.
      if (snap.status !== "running") {
        host.consume([snap.id]);
      }
      return {
        content: [{ type: "text" as const, text: buildStatusResult(snap) }],
        details: {
          id: snap.id,
          status: snap.status,
          exitCode: snap.exitCode,
          signal: snap.signal,
        },
      };
    },
  });

  pi.registerTool({
    name: "bg_list",
    label: "Background list",
    description: "List all tracked background terminals (running and recently completed).",
    promptSnippet: "List background terminals",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const m = getManager();
      const snaps = m.list();
      return {
        content: [{ type: "text" as const, text: buildListResult(snaps) }],
        details: { count: snaps.length, ids: snaps.map((s) => s.id) },
      };
    },
  });

  pi.registerTool({
    name: "bg_kill",
    label: "Background kill",
    description:
      "Stop one or more background terminals (SIGTERM, then SIGKILL). Termination continues even if the tool wait is aborted.",
    promptSnippet: "Stop background terminals",
    parameters: KillParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const m = getManager();
      if (params.ids.length === 0) {
        throw new Error("ids must not be empty");
      }
      try {
        const results = await m.kill(params.ids, signal);
        host.consume(params.ids);
        host.updateWidget();
        return {
          content: [{ type: "text" as const, text: buildKillResult(results) }],
          details: {
            results: results.map((r) => ({
              id: r.id,
              status: r.snapshot.status,
              alreadySettled: r.alreadySettled,
            })),
          },
        };
      } catch (error) {
        host.consumeIfWaitAborted(error, params.ids);
        throw error;
      }
    },
  });

  pi.registerCommand("ps", {
    description: "Inspect and manage background terminals",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        const m = manager;
        if (!m || !ctx.hasUI) {
          if (ctx.hasUI) ctx.ui.notify("No background terminals", "info");
          return;
        }
        const text = buildListResult(m.list());
        ctx.ui.notify(text.slice(0, 300) + (text.length > 300 ? "…" : ""), "info");
        return;
      }

      const m = getManager();
      await ctx.ui.custom((tui, theme, _kb, done) => {
        const overlay = new JobsOverlay<TerminalSnapshot>(
          terminalOverlayConfig(m, (snap) => {
            // Queue before waiting for process termination; the user can close
            // the overlay and start another turn immediately.
            pi.sendMessage(
              {
                customType: "background-terminal-user-kill",
                content: `User requested termination of background terminal ${snap.id} "${truncateOneLine(snap.title, 120)}" from /ps.`,
                display: false,
                details: { id: snap.id, status: snap.status },
              },
              { deliverAs: "nextTurn", triggerTurn: false },
            );
          }),
          theme,
          () => {
            overlay.dispose();
            done(undefined);
          },
          () => tui.requestRender(),
          () => tui.terminal.rows,
        );
        return {
          render: (width: number) => overlay.render(width),
          invalidate: () => {},
          handleInput: (data: string) => overlay.handleInput(data),
          dispose: () => overlay.dispose(),
        };
      });
    },
  });
}
