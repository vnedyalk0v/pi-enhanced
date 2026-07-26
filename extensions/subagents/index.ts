import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ResultDelivery } from "../shared/delivery.ts";
import { TOOL_LIMITS_NOTE } from "../shared/text.ts";
import type { BackendName, SubagentSnapshot } from "./domain.ts";
import {
  buildCancelResult,
  buildCompletionMessage,
  buildListResult,
  buildSpawnResult,
  buildStatusResult,
  buildWaitResult,
} from "./format.ts";
import { SubagentManager } from "./manager.ts";

const WIDGET_ID = "subagents";

const SpawnParams = Type.Object({
  backend: StringEnum(["pi", "codex"] as const, {
    description: "Worker harness: pi (same stack as parent) or codex (OpenAI Codex CLI)",
  }),
  prompt: Type.String({
    description: "Self-contained task prompt for the child (include all needed context)",
  }),
  title: Type.Optional(Type.String({ description: "Short label for listings and completion" })),
  model: Type.Optional(
    Type.String({
      description:
        "Model override. Pi: provider/id pattern. Codex: model id. Defaults: parent model (pi) or Codex config/high-effort coding model (codex).",
    }),
  ),
  thinking: Type.Optional(
    Type.String({
      description:
        "Pi: thinking level (off|minimal|low|medium|high|...). Codex: model_reasoning_effort (default high).",
    }),
  ),
  working_dir: Type.Optional(
    Type.String({ description: "Working directory (default: current session cwd)" }),
  ),
});

const IdParams = Type.Object({
  id: Type.String({ description: 'Subagent id, e.g. "sa-1"' }),
});

const IdsParams = Type.Object({
  ids: Type.Array(Type.String(), { description: 'Subagent ids, e.g. ["sa-1"]' }),
});

export default function (pi: ExtensionAPI) {
  let manager: SubagentManager | undefined;
  let uiCtx: ExtensionContext | undefined;
  let disposed = false;
  const delivery = new ResultDelivery<SubagentSnapshot>();

  // Defaults captured from parent when spawning
  let parentModelLabel: string | undefined;
  let parentThinking: string | undefined;

  const getManager = () => {
    if (manager) return manager;
    manager = new SubagentManager({
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
      running === 1
        ? "1 subagent running"
        : `${running} subagents running`;
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
          customType: "subagent-result",
          content: buildCompletionMessage(value),
          display: true,
          details: {
            id: value.id,
            backend: value.backend,
            status: value.status,
            exitCode: value.exitCode,
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
    name: "sa_spawn",
    label: "Subagent spawn",
    description: `Start a background subagent (backend: pi or codex only). Child gets an isolated context and self-contained prompt. Named sa_* to avoid clashing with packages that register subagent/subagent_wait. ${TOOL_LIMITS_NOTE}`,
    promptSnippet: "Spawn a Pi or Codex subagent in the background (sa_*)",
    promptGuidelines: [
      "Use sa_spawn for parallelizable or long agent work; keep the prompt self-contained.",
      "Prefer backend pi when you want the same model stack as the parent; prefer codex for heavy coding with high reasoning.",
      "After sa_spawn, keep working; a completion message arrives when the child finishes.",
    ],
    parameters: SpawnParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      captureParentDefaults(ctx);
      const m = getManager();
      const backend = params.backend as BackendName;
      const cwd = resolve(ctx.cwd, params.working_dir ?? ".");

      let model = params.model?.trim() || undefined;
      let thinking = params.thinking?.trim() || undefined;

      if (backend === "pi") {
        model ??= parentModelLabel;
        thinking ??= parentThinking;
      } else {
        // Codex: high reasoning by default (manager/backend maps thinking → effort)
        thinking ??= "high";
        model ??= process.env.CODEX_DEFAULT_MODEL?.trim() || undefined;
      }

      const snap = await m.spawn({
        backend,
        prompt: params.prompt,
        title: params.title,
        cwd,
        model,
        thinking,
      });
      updateWidget();
      return {
        content: [{ type: "text" as const, text: buildSpawnResult(snap) }],
        details: { id: snap.id, backend: snap.backend, status: snap.status, pid: snap.pid },
      };
    },
  });

  pi.registerTool({
    name: "sa_status",
    label: "Subagent status",
    description: `Get status and result/output tail for a sa_* subagent. ${TOOL_LIMITS_NOTE}`,
    promptSnippet: "Inspect a sa_* subagent",
    parameters: IdParams,
    async execute(_toolCallId, params) {
      const m = getManager();
      const snap = m.get(params.id);
      if (!snap) throw new Error(`Unknown subagent id: ${params.id}`);
      if (snap.status !== "running") delivery.consume([snap.id]);
      return {
        content: [{ type: "text" as const, text: buildStatusResult(snap) }],
        details: { id: snap.id, status: snap.status, backend: snap.backend },
      };
    },
  });

  pi.registerTool({
    name: "sa_list",
    label: "Subagent list",
    description: "List tracked sa_* subagents (running and recent).",
    promptSnippet: "List sa_* subagents",
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
    name: "sa_wait",
    label: "Subagent wait",
    description:
      "Wait until the given sa_* subagents settle. Suppresses async completion for those ids (result returned here).",
    promptSnippet: "Wait for sa_* subagents to finish",
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
          results: snaps.map((s) => ({ id: s.id, status: s.status, backend: s.backend })),
        },
      };
    },
  });

  pi.registerTool({
    name: "sa_cancel",
    label: "Subagent cancel",
    description: "Cancel running sa_* subagents (SIGTERM then SIGKILL). Suppresses async completion.",
    promptSnippet: "Cancel sa_* subagents",
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

  // Side research without hijacking the main conversation tools list heavily.
  pi.registerCommand("btw", {
    description: "Ask a quick side question via a Pi subagent (background)",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /btw <question>", "warning");
        return;
      }
      captureParentDefaults(ctx);
      const m = getManager();
      try {
        const snap = await m.spawn({
          backend: "pi",
          prompt: [
            "Answer this side question for the parent agent.",
            "Be concise. Do not modify files unless the question explicitly requires it.",
            "",
            prompt,
          ].join("\n"),
          title: `btw: ${prompt.slice(0, 40)}`,
          cwd: ctx.cwd,
          model: parentModelLabel,
          thinking: parentThinking ?? "low",
        });
        updateWidget();
        if (ctx.hasUI) {
          ctx.ui.notify(`Side task ${snap.id} started (pi)`, "info");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
      }
    },
  });
}
