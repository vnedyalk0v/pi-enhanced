import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ResultDelivery } from "../shared/delivery.ts";
import { TOOL_LIMITS_NOTE } from "../shared/text.ts";
import { withUI } from "../shared/ui.ts";
import {
  buildKillResult,
  buildListResult,
  buildStartResult,
  buildStatusResult,
  buildTerminalResultMessage,
} from "./format.ts";
import { TerminalManager, type TerminalSnapshot } from "./manager.ts";
import { PsOverlay } from "./ps.ts";

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
  let uiCtx: ExtensionContext | undefined;
  let disposed = false;
  const delivery = new ResultDelivery<TerminalSnapshot>();

  const getManager = (ctx: ExtensionContext) => {
    if (disposed) throw new Error("Background terminal manager is shutting down.");
    if (manager) return manager;
    const sessionKey = ctx.sessionManager.getSessionId();

    manager = new TerminalManager({
      sessionKey,
      onSettled: ({ snapshot, consumed }) => {
        if (disposed || consumed) return;
        delivery.enqueue(snapshot.id, snapshot);
        flushDelivery();
      },
      onChange: () => {
        updateWidget();
      },
    });
    return manager;
  };

  const updateWidget = () => {
    const m = manager;
    if (!m) return;
    const ok = withUI(uiCtx, (ctx) => {
      const running = m.getRunningCount();
      if (running === 0) {
        ctx.ui.setWidget(WIDGET_ID, undefined);
        return;
      }
      const label =
        running === 1
          ? "1 background terminal running • /ps to view"
          : `${running} background terminals running • /ps to view`;
      ctx.ui.setWidget(WIDGET_ID, [label]);
    });
    if (!ok) uiCtx = undefined;
  };

  const flushDelivery = () => {
    if (disposed) {
      delivery.clear();
      return;
    }
    for (const { value } of delivery.drainAll()) {
      pi.sendMessage(
        {
          customType: "background-terminal-result",
          content: buildTerminalResultMessage(value),
          display: true,
          details: {
            id: value.id,
            title: value.title,
            status: value.status,
            exitCode: value.exitCode,
            signal: value.signal,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    uiCtx = ctx;
    // Manager is created lazily on first tool use so ephemeral sessions without
    // bg tools do not create spill directories.
  });

  pi.on("session_shutdown", async () => {
    disposed = true;
    delivery.clear();
    withUI(uiCtx, (ctx) => ctx.ui.setWidget(WIDGET_ID, undefined));
    const m = manager;
    manager = undefined;
    uiCtx = undefined;
    if (m) await m.disposeAll();
  });

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
      const m = getManager(ctx);
      const cwd = resolve(ctx.cwd, params.working_dir ?? ".");
      const snap = await m.start({
        command: params.command,
        title: params.title,
        cwd,
      });
      updateWidget();
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
      const m = getManager(ctx);
      const snap = m.get(params.id);
      if (!snap) {
        throw new Error(`Unknown terminal id: ${params.id}`);
      }
      // If completion was pending, model is reading it now — don't also inject.
      if (snap.status !== "running") {
        delivery.consume([snap.id]);
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
      const m = getManager(ctx);
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
      const m = getManager(ctx);
      if (params.ids.length === 0) {
        throw new Error("ids must not be empty");
      }
      try {
        const results = await m.kill(params.ids, signal);
        delivery.consume(params.ids);
        updateWidget();
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
        const message = error instanceof Error ? error.message : String(error);
        // If wait was aborted, still mark consumed so a late settle does not double-notify.
        if (message.includes("Kill wait aborted")) {
          delivery.consume(params.ids);
          updateWidget();
        }
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

      const m = getManager(ctx);
      await ctx.ui.custom((tui, theme, _kb, done) => {
        const overlay = new PsOverlay(
          m,
          theme,
          () => {
            overlay.dispose();
            done(undefined);
          },
          () => tui.requestRender(),
        );
        return {
          render: (width: number) => overlay.render(width),
          invalidate: () => {},
          handleInput: (data: string) => overlay.handleInput(data),
        };
      });
    },
  });
}
