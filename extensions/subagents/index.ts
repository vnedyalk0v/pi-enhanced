import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createManagerHost, modelLabel } from "../shared/host.ts";
import { TOOL_LIMITS_NOTE, truncateForModel, truncateOneLine } from "../shared/text.ts";
import { discoverAgents, isSameTrustedProject, type AgentDefinition } from "./agents.ts";
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

/** Resolve the directory sa_spawn/sa_agents actually inspect, and whether it inherits the session's project trust. */
function resolveDiscoveryContext(ctx: ExtensionContext, workingDir: string | undefined) {
  const cwd = resolve(ctx.cwd, workingDir ?? ".");
  const projectTrusted = isSameTrustedProject(ctx.cwd, cwd) && ctx.isProjectTrusted();
  return { cwd, projectTrusted };
}

const PROJECT_AGENT_CONFIRM_TIMEOUT_MS = 30_000;

export default function (pi: ExtensionAPI) {
  let manager: SubagentManager | undefined;

  const host = createManagerHost<SubagentSnapshot>(pi, {
    widgetId: WIDGET_ID,
    customType: "subagent-result",
    runningLabel: (n) => (n === 1 ? "1 subagent running" : `${n} subagents running`),
    completion: (snap) => ({
      content: buildCompletionMessage(snap),
      details: { id: snap.id, agent: snap.agent, status: snap.status, exitCode: snap.exitCode },
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
    if (host.disposed) throw new Error("Subagent manager is shutting down.");
    manager ??= new SubagentManager({
      onSettled: host.onSettled,
      onChange: host.updateWidget,
    });
    return manager;
  };

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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const m = getManager();
      // Discover from (and confirm against) the directory the child actually
      // runs in, not the parent session's cwd — see resolveDiscoveryContext.
      const { cwd, projectTrusted } = resolveDiscoveryContext(ctx, params.working_dir);

      let agentDef: AgentDefinition | undefined;
      const agentName = params.agent?.trim();
      if (agentName) {
        const { agents } = discoverAgents(cwd, projectTrusted, undefined, ctx.cwd);
        agentDef = agents.find((a) => a.name === agentName);
        if (!agentDef) {
          const available = agents.map((a) => a.name).join(", ") || "none";
          throw new Error(`Unknown agent: "${agentName}". Available: ${truncateOneLine(available, 300)}.`);
        }
        if (agentDef.source === "project" && ctx.hasUI) {
          // hasUI covers both tui and rpc modes — rpc dialog methods work over
          // the extension UI sub-protocol, but a non-interactive rpc client may
          // never answer, so bound the wait and fail closed (declined) rather
          // than blocking sa_spawn forever.
          const ok = await ctx.ui.confirm(
            "Run project-local subagent?",
            `Agent: ${agentDef.name}\nSource: ${agentDef.filePath}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
            { timeout: PROJECT_AGENT_CONFIRM_TIMEOUT_MS },
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

      const model = params.model?.trim() || agentDef?.model || modelLabel(ctx);
      const thinking = params.thinking?.trim() || agentDef?.thinking || ctx.thinkingLevel;

      const snap = await m.spawn({
        agent: agentDef?.name,
        prompt: params.prompt,
        title: params.title ?? agentDef?.description,
        cwd,
        model,
        thinking,
        tools: agentDef?.tools,
        systemPromptAppend: agentDef?.systemPrompt,
        signal,
      });
      host.updateWidget();
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
    parameters: Type.Object({
      working_dir: Type.Optional(
        Type.String({
          description:
            "Working directory to inspect, matching a planned sa_spawn call (default: current session cwd).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { cwd, projectTrusted } = resolveDiscoveryContext(ctx, params.working_dir);
      const { agents } = discoverAgents(cwd, projectTrusted, undefined, ctx.cwd);
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
      if (snap.status !== "running") host.delivery.consume([snap.id]);
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
      host.delivery.consume(params.ids);
      host.updateWidget();
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

  // Side research without hijacking the main conversation tools list heavily.
  pi.registerCommand("btw", {
    description: "Ask a quick side question via a Pi subagent (background)",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /btw <question>", "warning");
        return;
      }
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
          model: modelLabel(ctx),
          thinking: ctx.thinkingLevel ?? "low",
        });
        host.updateWidget();
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
