import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ResultDelivery } from "../shared/delivery.ts";
import { TOOL_LIMITS_NOTE, truncateForModel } from "../shared/text.ts";
import { discoverAgents, type AgentDefinition } from "./agents.ts";
import type { SubagentSnapshot } from "./domain.ts";
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
  agent: Type.Optional(
    Type.String({
      description:
        "Named agent definition (see sa_agents). Omit for an ad-hoc worker with full default tools.",
    }),
  ),
  prompt: Type.String({
    description: "Self-contained task prompt for the child (include all needed context)",
  }),
  title: Type.Optional(Type.String({ description: "Short label for listings and completion" })),
  model: Type.Optional(
    Type.String({
      description:
        "Model override, provider/id pattern. Default: the agent definition's model, else the parent's current model.",
    }),
  ),
  thinking: Type.Optional(
    Type.String({
      description:
        "Thinking level override (off|minimal|low|medium|high|...). Default: the agent definition's thinking, else the parent's current level.",
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

function describeAgent(a: AgentDefinition) {
  const tools = a.tools ? ` [tools: ${a.tools.join(",")}]` : "";
  const model = a.model ? ` [model: ${a.model}]` : "";
  return `${a.name} (${a.source}): ${a.description}${tools}${model}`;
}

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
    const label = running === 1 ? "1 subagent running" : `${running} subagents running`;
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
            agent: value.agent,
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
    description: `Start a background subagent: pi's own native worker (a separate pi process), never a third-party CLI. Optionally named via \`agent\` (see sa_agents); omit for an ad-hoc general worker. Child gets an isolated context and self-contained prompt. Named sa_* to avoid clashing with packages that register subagent/subagent_wait. ${TOOL_LIMITS_NOTE}`,
    promptSnippet: "Spawn a native pi subagent in the background (sa_*)",
    promptGuidelines: [
      "Use sa_spawn for parallelizable or long agent work; keep the prompt self-contained.",
      "Use sa_agents to see named agent definitions (specialized tools/model per role) before picking an `agent`.",
      "After sa_spawn, keep working; a completion message arrives when the child finishes.",
    ],
    parameters: SpawnParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      captureParentDefaults(ctx);
      const m = getManager();
      const cwd = resolve(ctx.cwd, params.working_dir ?? ".");

      let agentDef: AgentDefinition | undefined;
      const agentName = params.agent?.trim();
      if (agentName) {
        const { agents } = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
        agentDef = agents.find((a) => a.name === agentName);
        if (!agentDef) {
          const available = agents.map((a) => a.name).join(", ") || "none";
          throw new Error(`Unknown agent: "${agentName}". Available: ${available}.`);
        }
        if (agentDef.source === "project" && ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            "Run project-local subagent?",
            `Agent: ${agentDef.name}\nSource: ${agentDef.filePath}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok) {
            return {
              content: [
                { type: "text" as const, text: `Canceled: project agent "${agentDef.name}" not approved.` },
              ],
              details: { cancelled: true },
            };
          }
        }
      }

      const model = params.model?.trim() || agentDef?.model || parentModelLabel;
      const thinking = params.thinking?.trim() || agentDef?.thinking || parentThinking;

      const snap = await m.spawn({
        agent: agentDef?.name,
        prompt: params.prompt,
        title: params.title ?? agentDef?.description,
        cwd,
        model,
        thinking,
        tools: agentDef?.tools,
        systemPromptAppend: agentDef?.systemPrompt,
      });
      updateWidget();
      return {
        content: [{ type: "text" as const, text: buildSpawnResult(snap) }],
        details: { id: snap.id, agent: snap.agent, status: snap.status, pid: snap.pid },
      };
    },
  });

  pi.registerTool({
    name: "sa_agents",
    label: "Subagent agents",
    description: `List named agent definitions available to sa_spawn's \`agent\` param (user: ~/.pi/agent/agents/*.md, project: .pi/agents/*.md when trusted). ${TOOL_LIMITS_NOTE}`,
    promptSnippet: "List available named sa_* agent definitions",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { agents } = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
      const text =
        agents.length === 0
          ? "No named agent definitions found. sa_spawn without `agent` runs an ad-hoc worker with full default tools."
          : truncateForModel(agents.map(describeAgent).join("\n"));
      return {
        content: [{ type: "text" as const, text }],
        details: { count: agents.length, agents: agents.map((a) => a.name) },
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
        details: { id: snap.id, status: snap.status, agent: snap.agent },
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
          results: snaps.map((s) => ({ id: s.id, status: s.status, agent: s.agent })),
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
          ctx.ui.notify(`Side task ${snap.id} started`, "info");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
      }
    },
  });
}
