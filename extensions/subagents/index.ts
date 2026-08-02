import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createManagerHost, modelLabel } from "../shared/host.ts";
import { JobsOverlay } from "../shared/jobs-overlay.ts";
import { terminalText } from "../shared/terminal-text.ts";
import {
  formatExit,
  TOOL_LIMITS_NOTE,
  truncateForModel,
  truncateOneLine,
} from "../shared/text.ts";
import { formatElapsed } from "../shared/time.ts";
import {
  describeHiddenAgent,
  discoverAgents,
  findHiddenAgent,
  isSameTrustedProject,
  type AgentDefinition,
} from "./agents.ts";
import type { SubagentSnapshot } from "./domain.ts";
import {
  buildBtwAnswer,
  buildCancelResult,
  buildCompletionMessage,
  buildListResult,
  buildSpawnResult,
  buildStatusResult,
  buildWaitResult,
  truncateAtWord,
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

/**
 * Fail a nonsense model override before spawning instead of after a full
 * child round trip. Substring match over id/name/provider-qualified id
 * approximates pi's own fuzzy resolution; globs and an empty registry are
 * left for the child to resolve.
 */
export function modelPatternMatchesRegistry(
  pattern: string,
  models: Array<{ provider: string; id: string; name?: string }>,
) {
  if (models.length === 0 || /[*?]/.test(pattern)) return true;
  // pi resolves <known-provider>/<any-id> to a custom model (targeting ids
  // newer than the local registry), so a known provider prefix always passes.
  const slash = pattern.indexOf("/");
  if (slash > 0) {
    const provider = pattern.slice(0, slash).toLowerCase();
    if (models.some((m) => m.provider.toLowerCase() === provider)) return true;
  }
  const tries = [pattern.toLowerCase()];
  const colon = pattern.lastIndexOf(":");
  if (colon > 0) tries.push(pattern.slice(0, colon).toLowerCase());
  return models.some((m) => {
    const candidates = [m.id, m.name ?? "", `${m.provider}/${m.id}`].map((c) => c.toLowerCase());
    return tries.some((t) => candidates.some((c) => c.includes(t)));
  });
}

export default function (pi: ExtensionAPI) {
  let manager: SubagentManager | undefined;
  /** Ids spawned by /btw: completions go straight to the user, no model turn. */
  const btwIds = new Set<string>();

  const host = createManagerHost<SubagentSnapshot>(pi, {
    widgetId: WIDGET_ID,
    customType: "subagent-result",
    runningLabel: (n) =>
      n === 1 ? "1 subagent running • /sa to view" : `${n} subagents running • /sa to view`,
    completion: (snap) => {
      if (btwIds.delete(snap.id)) {
        return {
          content: buildBtwAnswer(snap),
          details: { id: snap.id, agent: snap.agent, status: snap.status, btw: true },
          triggerTurn: false,
        };
      }
      return {
        content: buildCompletionMessage(snap),
        details: { id: snap.id, agent: snap.agent, status: snap.status, exitCode: snap.exitCode },
      };
    },
    getRunning: () =>
      manager ? manager.list().filter((s) => s.status === "running").length : undefined,
    dispose: async () => {
      const m = manager;
      manager = undefined;
      btwIds.clear();
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

      // Validate before any discovery or confirm dialog so a bogus override
      // fails fast instead of after the user approved a project agent.
      const modelOverride = params.model?.trim();
      if (modelOverride && !modelPatternMatchesRegistry(modelOverride, ctx.modelRegistry?.getAll() ?? [])) {
        throw new Error(
          `Model "${modelOverride}" does not match any model in the registry. ` +
            "Use a provider/id pattern from pi --list-models, or omit `model` to inherit the parent's.",
        );
      }

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
          const hidden = projectTrusted
            ? undefined
            : findHiddenAgent(agentName, cwd, ctx.cwd, ctx.isProjectTrusted());
          const explanation = hidden ? ` ${describeHiddenAgent(agentName, cwd, hidden)}` : "";
          throw new Error(
            `Unknown agent: "${agentName}".${explanation} Available: ${truncateOneLine(available, 300)}.`,
          );
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

      const model = modelOverride || agentDef?.model || modelLabel(ctx);
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
        for (const id of params.ids) btwIds.delete(id);
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
            "Answer this side question for the user.",
            "Be concise. Do not modify files unless the question explicitly requires it.",
            "",
            prompt,
          ].join("\n"),
          title: `btw: ${truncateAtWord(prompt, 40)}`,
          cwd: ctx.cwd,
          model: modelLabel(ctx),
          thinking: ctx.thinkingLevel ?? "low",
        });
        btwIds.add(snap.id);
        host.updateWidget();
        if (ctx.hasUI) {
          ctx.ui.notify(`Side task ${snap.id} started — answer will appear here`, "info");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
      }
    },
  });

  pi.registerCommand("sa", {
    description: "Inspect and cancel subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (!ctx.hasUI) return;
        const m = manager;
        if (!m) {
          ctx.ui.notify("No subagents", "info");
          return;
        }
        const text = buildListResult(m.list());
        ctx.ui.notify(text.slice(0, 300) + (text.length > 300 ? "…" : ""), "info");
        return;
      }

      const m = getManager();
      await ctx.ui.custom((tui, theme, _kb, done) => {
        const overlay = new JobsOverlay<SubagentSnapshot>(
          {
            title: "Subagents",
            list: () => m.list(),
            subscribe: (listener) => m.subscribe(listener),
            renderRow: (snap, th) => {
              const elapsed = formatElapsed(snap.createdAt, snap.settledAt);
              const detail =
                snap.status === "running" ? elapsed : `${formatExit(snap)}, ${elapsed}`;
              const agent = snap.agent ? ` ${th.fg("muted", snap.agent)}` : "";
              return `${snap.id} ${subagentStatusColor(th, snap)} "${terminalText(snap.title)}"${agent} ${th.fg("dim", `(${detail})`)}`;
            },
            detailHeader: (snap, th) => {
              const lines = [
                `${subagentStatusColor(th, snap)}` +
                  (snap.status === "running" ? "" : `  ${formatExit(snap)}`) +
                  `  ${formatElapsed(snap.createdAt, snap.settledAt)}` +
                  (snap.pid !== undefined ? `  pid ${snap.pid}` : ""),
                th.fg(
                  "dim",
                  terminalText(
                    [snap.agent && `agent ${snap.agent}`, snap.model, snap.thinking]
                      .filter(Boolean)
                      .join("  "),
                  ),
                ),
                th.fg("dim", terminalText(snap.cwd)),
                th.fg("dim", terminalText(truncateOneLine(snap.prompt, 200))),
              ];
              if (snap.errorText) {
                lines.push(th.fg("error", terminalText(truncateOneLine(snap.errorText, 200))));
              }
              return lines.filter((l) => l.trim() !== "");
            },
            detailBody: (snap) => snap.resultText || snap.outputTail || "(no output)",
            canCancel: (snap) => snap.status === "running",
            cancel: (id) =>
              m.cancel([id]).then((snaps) => {
                host.delivery.consume([id]);
                btwIds.delete(id);
                host.updateWidget();
                const snap = snaps[0];
                if (snap) {
                  // Record the user action for the model without starting a turn.
                  pi.sendMessage(
                    {
                      customType: "subagent-user-cancel",
                      content: `User cancelled subagent ${snap.id} "${snap.title}" from /sa.`,
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

function subagentStatusColor(th: Theme, snap: SubagentSnapshot) {
  switch (snap.status) {
    case "running":
      return th.fg("success", "running");
    case "done":
      return th.fg("muted", "done");
    case "failed":
      return th.fg("error", "failed");
    case "killed":
      return th.fg("warning", "killed");
  }
}
