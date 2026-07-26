import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ResultDelivery } from "../shared/delivery.ts";
import type { WorkflowSnapshot } from "./domain.ts";
import { TOOL_LIMITS_NOTE } from "../shared/text.ts";
import {
  buildCancelResult,
  buildCompletionMessage,
  buildListResult,
  buildStartResult,
  buildStatusResult,
  buildWaitResult,
} from "./format.ts";
import { WorkflowManager } from "./manager.ts";

const WIDGET_ID = "workflows";

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
  let uiCtx: ExtensionContext | undefined;
  let disposed = false;
  const delivery = new ResultDelivery<WorkflowSnapshot>();

  let parentModelLabel: string | undefined;
  let parentThinking: string | undefined;

  const getManager = () => {
    if (manager) return manager;
    manager = new WorkflowManager({
      onSettled: ({ snapshot, consumed }) => {
        if (disposed || consumed) return;
        delivery.enqueue(snapshot.id, snapshot);
        flushDelivery();
      },
      onChange: () => updateWidget(),
    });
    return manager;
  };

  const updateWidget = () => {
    if (!uiCtx?.hasUI || !manager) return;
    const running = manager.list().filter((s) => s.status === "running").length;
    if (running === 0) {
      uiCtx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }
    const label =
      running === 1 ? "1 workflow running" : `${running} workflows running`;
    uiCtx.ui.setWidget(WIDGET_ID, [label]);
  };

  const flushDelivery = () => {
    if (disposed) {
      delivery.clear();
      return;
    }
    for (const { value } of delivery.drainAll()) {
      pi.sendMessage(
        {
          customType: "workflow-result",
          content: buildCompletionMessage(value),
          display: true,
          details: {
            id: value.id,
            status: value.status,
            artifactsDir: value.artifactsDir,
            finalArtifactPath: value.finalArtifactPath,
            failedTaskCount: value.failedTaskCount,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
  };

  const captureParentDefaults = (ctx: ExtensionContext) => {
    if (ctx.model) {
      parentModelLabel = `${ctx.model.provider}/${ctx.model.id}`;
    }
    if (ctx.thinkingLevel) parentThinking = ctx.thinkingLevel;
  };

  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    uiCtx = ctx;
    captureParentDefaults(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    captureParentDefaults(ctx);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    parentThinking = event.level;
    captureParentDefaults(ctx);
  });

  pi.on("session_shutdown", async () => {
    disposed = true;
    delivery.clear();
    if (uiCtx?.hasUI) uiCtx.ui.setWidget(WIDGET_ID, undefined);
    const m = manager;
    manager = undefined;
    uiCtx = undefined;
    if (m) await m.disposeAll();
  });

  pi.registerTool({
    name: "wf_start",
    label: "Workflow start",
    description: `Start a multi-phase workflow (recon → implement → review → synthesis) using Pi/Codex subagents. Parallel tasks within a phase; structured outputs hand off via on-disk artifacts. Named wf_* to avoid clashes. ${TOOL_LIMITS_NOTE}`,
    promptSnippet: "Start a multi-phase workflow (wf_*)",
    promptGuidelines: [
      "Use wf_start for multi-step work that benefits from separate recon, implement, review, and synthesis agents.",
      "Prefer sa_spawn for a single parallel worker; prefer wf_start when you want phased handoffs and preserved artifacts.",
      "After wf_start, keep working; a completion message arrives when the workflow finishes.",
    ],
    parameters: StartParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      captureParentDefaults(ctx);
      const m = getManager();
      const cwd = resolve(ctx.cwd, params.working_dir ?? ".");
      const snap = await m.start({
        goal: params.goal,
        title: params.title,
        cwd,
        model: parentModelLabel,
        thinking: parentThinking,
      });
      updateWidget();
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
      if (snap.status !== "running") delivery.consume([snap.id]);
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
      delivery.consume(params.ids);
      updateWidget();
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
        delivery.consume(params.ids);
        updateWidget();
        return {
          content: [{ type: "text" as const, text: buildCancelResult(snaps) }],
          details: {
            results: snaps.map((s) => ({ id: s.id, status: s.status })),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Cancel wait aborted")) {
          delivery.consume(params.ids);
          updateWidget();
        }
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
      captureParentDefaults(ctx);
      const m = getManager();
      try {
        const snap = await m.start({
          goal,
          cwd: ctx.cwd,
          model: parentModelLabel,
          thinking: parentThinking,
        });
        updateWidget();
        if (ctx.hasUI) {
          ctx.ui.notify(`Workflow ${snap.id} started — artifacts: ${snap.artifactsDir}`, "info");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
      }
    },
  });
}
