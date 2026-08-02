import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createManagerHost, modelLabel } from "../shared/host.ts";
import { JobsOverlay } from "../shared/jobs-overlay.ts";
import { terminalText } from "../shared/terminal-text.ts";
import type { WorkflowSnapshot } from "./domain.ts";
import { TOOL_LIMITS_NOTE, truncateOneLine } from "../shared/text.ts";
import { formatElapsed } from "../shared/time.ts";
import {
  buildCancelResult,
  buildCompletionMessage,
  buildListResult,
  buildPhaseTree,
  buildStartResult,
  buildStatusResult,
  buildWaitResult,
} from "./format.ts";
import { selectReconTools, WorkflowManager } from "./manager.ts";

const WIDGET_ID = "workflows";
const FILE_SEARCH_EXTENSION = fileURLToPath(new URL("../file-search/index.ts", import.meta.url));

const StartParams = Type.Object({
  goal: Type.String({
    description: "Self-contained goal for the multi-phase workflow (include needed context)",
  }),
  title: Type.Optional(Type.String({ description: "Short label for listings and completion" })),
  working_dir: Type.Optional(
    Type.String({ description: "Working directory (default: current session cwd)" }),
  ),
});

const IdParams = Type.Object({
  id: Type.String({ description: 'Workflow id, e.g. "wf-1"' }),
});

const IdsParams = Type.Object({
  ids: Type.Array(Type.String(), { description: 'Workflow ids, e.g. ["wf-1"]' }),
});

export default function (pi: ExtensionAPI) {
  let manager: WorkflowManager | undefined;

  const host = createManagerHost<WorkflowSnapshot>(pi, {
    widgetId: WIDGET_ID,
    customType: "workflow-result",
    runningLabel: (n) =>
      n === 1 ? "1 workflow running • /wf to view" : `${n} workflows running • /wf to view`,
    completion: (snap) => ({
      content: buildCompletionMessage(snap),
      details: {
        id: snap.id,
        status: snap.status,
        artifactsDir: snap.artifactsDir,
        finalArtifactPath: snap.finalArtifactPath,
        failedTaskCount: snap.failedTaskCount,
      },
    }),
    getRunning: () =>
      manager ? manager.list().filter((s) => s.status === "running").length : undefined,
    dispose: async () => {
      const m = manager;
      manager = undefined;
      if (m) await m.disposeAll();
    },
  });

  const getManager = () => {
    if (host.disposed) throw new Error("Workflow manager is shutting down.");
    if (manager) return manager;
    const reconTools = selectReconTools(pi.getAllTools().map((tool) => tool.name));
    manager = new WorkflowManager({
      reconTools,
      reconExtensionPath: reconTools.includes("fd") ? FILE_SEARCH_EXTENSION : undefined,
      onSettled: host.onSettled,
      onChange: host.updateWidget,
    });
    return manager;
  };

  pi.registerTool({
    name: "wf_start",
    label: "Workflow start",
    description: `Start a multi-phase workflow (recon → implement → review → synthesis) using pi's native subagents. Parallel tasks within a phase; structured outputs hand off via on-disk artifacts. Named wf_* to avoid clashes. ${TOOL_LIMITS_NOTE}`,
    promptSnippet: "Start a multi-phase workflow (wf_*)",
    promptGuidelines: [
      "Use wf_start for multi-step work that benefits from separate recon, implement, review, and synthesis agents.",
      "Prefer sa_spawn for a single parallel worker; prefer wf_start when you want phased handoffs and preserved artifacts.",
      "After wf_start, keep working; a completion message arrives when the workflow finishes.",
    ],
    parameters: StartParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const m = getManager();
      const cwd = resolve(ctx.cwd, params.working_dir ?? ".");
      const snap = await m.start({
        goal: params.goal,
        title: params.title,
        cwd,
        model: modelLabel(ctx),
        thinking: ctx.thinkingLevel,
        signal,
      });
      host.updateWidget();
      return {
        content: [{ type: "text" as const, text: buildStartResult(snap) }],
        details: {
          id: snap.id,
          status: snap.status,
          artifactsDir: snap.artifactsDir,
        },
      };
    },
  });

  pi.registerTool({
    name: "wf_status",
    label: "Workflow status",
    description: `Compact status and final summary for a wf_* workflow. Full outputs live under artifacts/. ${TOOL_LIMITS_NOTE}`,
    promptSnippet: "Inspect a wf_* workflow",
    parameters: IdParams,
    async execute(_toolCallId, params) {
      const m = getManager();
      const snap = m.get(params.id);
      if (!snap) throw new Error(`Unknown workflow id: ${params.id}`);
      if (snap.status !== "running") host.delivery.consume([snap.id]);
      return {
        content: [{ type: "text" as const, text: buildStatusResult(snap) }],
        details: {
          id: snap.id,
          status: snap.status,
          artifactsDir: snap.artifactsDir,
          finalArtifactPath: snap.finalArtifactPath,
        },
      };
    },
  });

  pi.registerTool({
    name: "wf_list",
    label: "Workflow list",
    description: "List tracked wf_* workflows (running and recent).",
    promptSnippet: "List wf_* workflows",
    parameters: Type.Object({}),
    async execute() {
      const snaps = getManager().list();
      return {
        content: [{ type: "text" as const, text: buildListResult(snaps) }],
        details: { count: snaps.length, ids: snaps.map((s) => s.id) },
      };
    },
  });

  pi.registerTool({
    name: "wf_wait",
    label: "Workflow wait",
    description:
      "Wait until the given wf_* workflows settle. Suppresses async completion for those ids (result returned here).",
    promptSnippet: "Wait for wf_* workflows to finish",
    parameters: IdsParams,
    async execute(_toolCallId, params, signal) {
      if (params.ids.length === 0) throw new Error("ids must not be empty");
      const m = getManager();
      const snaps = await m.wait(params.ids, signal);
      host.delivery.consume(params.ids);
      host.updateWidget();
      return {
        content: [{ type: "text" as const, text: buildWaitResult(snaps) }],
        details: {
          results: snaps.map((s) => ({
            id: s.id,
            status: s.status,
            artifactsDir: s.artifactsDir,
            finalArtifactPath: s.finalArtifactPath,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "wf_cancel",
    label: "Workflow cancel",
    description: "Cancel running wf_* workflows (stops child subagents). Suppresses async completion.",
    promptSnippet: "Cancel wf_* workflows",
    parameters: IdsParams,
    async execute(_toolCallId, params, signal) {
      if (params.ids.length === 0) throw new Error("ids must not be empty");
      const m = getManager();
      try {
        const snaps = await m.cancel(params.ids, signal);
        host.delivery.consume(params.ids);
        host.updateWidget();
        return {
          content: [{ type: "text" as const, text: buildCancelResult(snaps) }],
          details: {
            results: snaps.map((s) => ({ id: s.id, status: s.status })),
          },
        };
      } catch (error) {
        host.consumeIfWaitAborted(error, params.ids);
        throw error;
      }
    },
  });

  pi.registerCommand("workflow", {
    description: "Start a repo-task workflow: recon → implement → review → synthesis",
    handler: async (args, ctx) => {
      const goal = args.trim();
      if (!goal) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /workflow <goal>", "warning");
        return;
      }
      const m = getManager();
      try {
        const snap = await m.start({
          goal,
          cwd: ctx.cwd,
          model: modelLabel(ctx),
          thinking: ctx.thinkingLevel,
        });
        host.updateWidget();
        if (ctx.hasUI) {
          ctx.ui.notify(`Workflow ${snap.id} started — artifacts: ${snap.artifactsDir}`, "info");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
      }
    },
  });

  pi.registerCommand("wf", {
    description: "Inspect and cancel workflows",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (!ctx.hasUI) return;
        const m = manager;
        if (!m) {
          ctx.ui.notify("No workflows", "info");
          return;
        }
        const text = buildListResult(m.list());
        ctx.ui.notify(text.slice(0, 300) + (text.length > 300 ? "…" : ""), "info");
        return;
      }

      const m = getManager();
      await ctx.ui.custom((tui, theme, _kb, done) => {
        const overlay = new JobsOverlay<WorkflowSnapshot>(
          {
            title: "Workflows",
            list: () => m.list(),
            subscribe: (listener) => m.subscribe(listener),
            renderRow: (snap, th) => {
              const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
              const phase = snap.currentPhase ? ` ${th.fg("muted", snap.currentPhase)}` : "";
              const fails =
                snap.failedTaskCount > 0
                  ? ` ${th.fg("error", `${snap.failedTaskCount} failed`)}`
                  : "";
              return `${snap.id} ${workflowStatusColor(th, snap)} "${terminalText(snap.title)}"${phase}${fails} ${th.fg("dim", `(${elapsed})`)}`;
            },
            detailHeader: (snap, th) => {
              const lines = [
                `${workflowStatusColor(th, snap)}  ${formatElapsed(snap.createdAt, snap.settledAt)}` +
                  (snap.currentPhase ? `  ${snap.currentPhase}` : ""),
                th.fg("dim", terminalText(truncateOneLine(snap.goal, 200))),
                th.fg("dim", terminalText(snap.artifactsDir)),
              ];
              if (snap.errorText) {
                lines.push(th.fg("error", terminalText(truncateOneLine(snap.errorText, 200))));
              }
              return lines;
            },
            detailBody: (snap) => {
              const lines = buildPhaseTree(snap);
              if (snap.finalArtifactPath) lines.push("", `final: ${snap.finalArtifactPath}`);
              if (snap.finalSummary) lines.push("", snap.finalSummary);
              return lines.join("\n");
            },
            canCancel: (snap) => snap.status === "running",
            cancel: (id) =>
              m.cancel([id]).then((snaps) => {
                host.delivery.consume([id]);
                host.updateWidget();
                const snap = snaps[0];
                if (snap) {
                  // Record the user action for the model without starting a turn.
                  pi.sendMessage(
                    {
                      customType: "workflow-user-cancel",
                      content: `User cancelled workflow ${snap.id} "${snap.title}" from /wf.`,
                      display: false,
                      details: { id: snap.id, status: snap.status },
                    },
                    { deliverAs: "nextTurn", triggerTurn: false },
                  );
                }
              }),
          },
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

function workflowStatusColor(th: Theme, snap: WorkflowSnapshot) {
  switch (snap.status) {
    case "running":
      return th.fg("success", "running");
    case "done":
      return th.fg("muted", "done");
    case "partial":
      return th.fg("warning", "partial");
    case "failed":
      return th.fg("error", "failed");
    case "cancelled":
      return th.fg("warning", "cancelled");
  }
}
