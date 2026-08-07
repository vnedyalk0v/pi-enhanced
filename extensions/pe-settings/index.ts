import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getSelectListTheme,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";

type AnyModel = Model<Api>;
import {
  SelectList,
  SettingsList,
  type SelectItem,
  type SettingItem,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_PACKAGE_CONFIG,
  THINKING_LEVELS,
  configPathForScope,
  formatPackageConfigSummary,
  globalConfigPath,
  loadPackageConfig,
  patchConfigFile,
  readConfigFile,
  type ConfigScope,
  type PackageConfigFile,
} from "../shared/package-config.ts";

/** Clear numeric override in this scope (fall through to package default). */
const UNSET = "(default)";
/**
 * Clear model/thinking override: subagents use the live Pi session
 * model and thinking level (after agent-definition pins, if any).
 */
export const INHERIT = "(inherit from Pi)";
const MAX_RUNNING_BASE = [UNSET, "1", "2", "4", "8", "16", "32"];
const WORKFLOW_MAX_BASE = [UNSET, "1", "2", "4", "8"];
const RUNTIME_MINUTES_BASE = [UNSET, "15", "30", "60", "120", "240"];

/** Ensure a hand-edited override (e.g. 6) appears in the cycle list. */
function withOverrideChoice(base: string[], override: number | undefined) {
  if (override === undefined) return base;
  const s = String(override);
  return base.includes(s) ? base : [UNSET, s, ...base.filter((v) => v !== UNSET)];
}

function projectTrustedOf(ctx: { isProjectTrusted?: () => boolean }) {
  return typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
}

export function effectiveConfig(ctx: { cwd: string; isProjectTrusted?: () => boolean }) {
  return loadPackageConfig({ cwd: ctx.cwd, projectTrusted: projectTrustedOf(ctx) });
}

export type SessionModelCtx = Pick<
  ExtensionContext,
  "model" | "thinkingLevel" | "modelRegistry" | "scopedModels"
>;

export function piModelLabel(ctx: Pick<ExtensionContext, "model">) {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

/** Models the user can pick for subagents: same provider as the active Pi model. */
export function modelsForCurrentProvider(ctx: SessionModelCtx): AnyModel[] {
  const registry = ctx.modelRegistry;
  const all = registry?.getAvailable?.() ?? registry?.getAll?.() ?? [];
  const provider = ctx.model?.provider;
  if (!provider) return [...all];
  return all.filter((m) => m.provider === provider);
}

/** Resolve a provider/id (or bare id) against registry models, then fall back to Pi's model. */
export function resolveModel(
  ctx: SessionModelCtx,
  pattern: string | undefined,
): AnyModel | undefined {
  const trimmed = pattern?.trim();
  if (!trimmed) return ctx.model;

  const pool = [
    ...(ctx.modelRegistry?.getAvailable?.() ?? []),
    ...(ctx.modelRegistry?.getAll?.() ?? []),
    ...(ctx.scopedModels ?? []).map((e) => e.model).filter(Boolean),
    ctx.model,
  ].filter((m): m is AnyModel => !!m);

  const lower = trimmed.toLowerCase();
  const exact = pool.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower);
  if (exact) return exact;
  const byId = pool.find((m) => m.id.toLowerCase() === lower);
  if (byId) return byId;
  return ctx.model;
}

/** Thinking levels supported by the effective subagent model (override or Pi). */
export function thinkingLevelsFor(
  ctx: SessionModelCtx,
  modelOverride: string | undefined,
): string[] {
  const model = resolveModel(ctx, modelOverride);
  if (!model) return [...THINKING_LEVELS];
  return getSupportedThinkingLevels(model);
}

function displayModel(override: string | undefined, ctx: SessionModelCtx) {
  if (override?.trim()) return override.trim();
  const pi = piModelLabel(ctx);
  return pi ? `${INHERIT} → ${pi}` : INHERIT;
}

function displayThinking(override: string | undefined, ctx: SessionModelCtx) {
  if (override?.trim()) return override.trim();
  const level = ctx.thinkingLevel?.trim();
  return level ? `${INHERIT} → ${level}` : INHERIT;
}

function displayNumeric(override: number | undefined) {
  return override === undefined ? UNSET : String(override);
}

export function modelItems(ctx: SessionModelCtx, current: string | undefined): SelectItem[] {
  const pi = piModelLabel(ctx);
  const items: SelectItem[] = [
    {
      value: INHERIT,
      label: INHERIT,
      description: pi
        ? `Use Pi session model (${pi})`
        : "Use whatever model is active in the Pi session",
    },
  ];
  const seen = new Set<string>([INHERIT]);
  const add = (value: string, description?: string) => {
    const v = value.trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    items.push({ value: v, label: v, description });
  };

  if (current?.trim()) add(current, "Current package override");

  const provider = ctx.model?.provider;
  for (const m of modelsForCurrentProvider(ctx)) {
    const label = `${m.provider}/${m.id}`;
    const bits = [
      m.name && m.name !== m.id ? m.name : undefined,
      m.reasoning ? "reasoning" : "no reasoning",
      provider ? undefined : m.provider,
    ].filter(Boolean);
    add(label, bits.join(" · ") || undefined);
  }

  // If scoped models pin a same-provider entry, surface it too.
  for (const entry of ctx.scopedModels ?? []) {
    const m = entry.model;
    if (!m?.provider || !m?.id) continue;
    if (provider && m.provider !== provider) continue;
    add(`${m.provider}/${m.id}`, "Scoped model");
  }

  return items.slice(0, 200);
}

export function thinkingItems(
  ctx: SessionModelCtx,
  modelOverride: string | undefined,
  thinkingOverride: string | undefined,
): SelectItem[] {
  const levels = thinkingLevelsFor(ctx, modelOverride);
  const piLevel = ctx.thinkingLevel?.trim();
  const items: SelectItem[] = [
    {
      value: INHERIT,
      label: INHERIT,
      description: piLevel
        ? `Use Pi session thinking (${piLevel})`
        : "Use whatever thinking level is active in the Pi session",
    },
  ];
  const seen = new Set<string>([INHERIT]);
  for (const level of levels) {
    if (seen.has(level)) continue;
    seen.add(level);
    items.push({ value: level, label: level });
  }
  // Keep a hand-edited override visible even if unsupported by the model map.
  if (thinkingOverride?.trim() && !seen.has(thinkingOverride.trim())) {
    items.push({
      value: thinkingOverride.trim(),
      label: thinkingOverride.trim(),
      description: "Stored override (may be clamped by the model)",
    });
  }
  return items;
}

/**
 * Editor rows reflect **file overrides for the active scope**, not the fully
 * merged effective config. Missing numeric keys show `(default)` so Enter
 * does not silently write a package default over a higher global value.
 * Model/thinking default to inherit from the live Pi session.
 */
export function buildItems(
  scope: ConfigScope,
  file: PackageConfigFile,
  ctx: SessionModelCtx,
): SettingItem[] {
  const d = DEFAULT_PACKAGE_CONFIG;
  const sa = file.subagents;
  const bg = file.backgroundTerminals;
  const wf = file.workflows;
  const pi = piModelLabel(ctx);
  const levels = thinkingLevelsFor(ctx, sa?.defaultModel);
  return [
    {
      id: "scope",
      label: "Edit scope",
      description:
        scope === "global"
          ? `Writes ${globalConfigPath()}`
          : "Writes .pi/pi-enhanced.json (trusted projects only)",
      currentValue: scope,
      values: ["global", "project"],
    },
    {
      id: "subagents.defaultModel",
      label: "Subagent default model",
      description: pi
        ? `Default inherits Pi (${pi}). Pick another ${ctx.model?.provider ?? "provider"} model to override.`
        : "Default inherits the active Pi session model. Open to pick an override.",
      currentValue: displayModel(sa?.defaultModel, ctx),
    },
    {
      id: "subagents.defaultThinking",
      label: "Subagent default thinking",
      description: `Default inherits Pi thinking${ctx.thinkingLevel ? ` (${ctx.thinkingLevel})` : ""}. Available for this model: ${levels.join(", ") || "off"}.`,
      currentValue: displayThinking(sa?.defaultThinking, ctx),
    },
    {
      id: "subagents.maxRunning",
      label: "Subagent concurrency",
      description: `Max concurrent standalone subagents (package default ${d.subagents.maxRunning})`,
      currentValue: displayNumeric(sa?.maxRunning),
      values: withOverrideChoice(MAX_RUNNING_BASE, sa?.maxRunning),
    },
    {
      id: "subagents.maxRuntimeMinutes",
      label: "Subagent max runtime (min)",
      description: `Force-kill after this many minutes (package default ${d.subagents.maxRuntimeMinutes})`,
      currentValue: displayNumeric(sa?.maxRuntimeMinutes),
      values: withOverrideChoice(RUNTIME_MINUTES_BASE, sa?.maxRuntimeMinutes),
    },
    {
      id: "backgroundTerminals.maxRunning",
      label: "Background terminal concurrency",
      description: `Max concurrent bg_* terminals (package default ${d.backgroundTerminals.maxRunning})`,
      currentValue: displayNumeric(bg?.maxRunning),
      values: withOverrideChoice(MAX_RUNNING_BASE, bg?.maxRunning),
    },
    {
      id: "workflows.maxRunning",
      label: "Workflow concurrency",
      description: `Max concurrent workflows (package default ${d.workflows.maxRunning})`,
      currentValue: displayNumeric(wf?.maxRunning),
      values: withOverrideChoice(WORKFLOW_MAX_BASE, wf?.maxRunning),
    },
    {
      id: "workflows.childMaxRunning",
      label: "Workflow child pool",
      description: `Max concurrent child subagents per workflow (package default ${d.workflows.childMaxRunning})`,
      currentValue: displayNumeric(wf?.childMaxRunning),
      values: withOverrideChoice(MAX_RUNNING_BASE, wf?.childMaxRunning),
    },
  ];
}

function isClearToken(v: string) {
  // Display values for inherit include " → model"; any inherit prefix clears.
  return v === UNSET || !v.trim() || v.startsWith(INHERIT);
}

export function applyChange(
  scope: ConfigScope,
  cwd: string,
  id: string,
  newValue: string,
  options?: { projectTrusted?: boolean },
): { scope: ConfigScope; error?: string } {
  // Default-deny: only an explicit true allows project-scope writes.
  const projectTrusted = options?.projectTrusted === true;

  if (id === "scope") {
    if (newValue !== "global" && newValue !== "project") return { scope };
    if (newValue === "project" && !projectTrusted) {
      return {
        scope: "global",
        error: "Project scope requires a trusted project.",
      };
    }
    return { scope: newValue };
  }

  if (scope === "project" && !projectTrusted) {
    return {
      scope: "global",
      error: "Project scope requires a trusted project. Switched back to global.",
    };
  }

  const asNullIfClear = (v: string) => (isClearToken(v) ? null : v);
  const asIntOrNull = (v: string) => {
    if (isClearToken(v)) return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  };

  const patches: Record<string, Parameters<typeof patchConfigFile>[2]> = {
    "subagents.defaultModel": { subagents: { defaultModel: asNullIfClear(newValue) } },
    "subagents.defaultThinking": { subagents: { defaultThinking: asNullIfClear(newValue) } },
    "subagents.maxRunning": { subagents: { maxRunning: asIntOrNull(newValue) } },
    "subagents.maxRuntimeMinutes": { subagents: { maxRuntimeMinutes: asIntOrNull(newValue) } },
    "backgroundTerminals.maxRunning": {
      backgroundTerminals: { maxRunning: asIntOrNull(newValue) },
    },
    "workflows.maxRunning": { workflows: { maxRunning: asIntOrNull(newValue) } },
    "workflows.childMaxRunning": { workflows: { childMaxRunning: asIntOrNull(newValue) } },
  };

  try {
    const patch = patches[id];
    if (patch) patchConfigFile(scope, cwd, patch);
    return { scope };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { scope, error: message };
  }
}

export function createSettingsItems(
  scope: ConfigScope,
  file: PackageConfigFile,
  ctx: SessionModelCtx,
): SettingItem[] {
  const items = buildItems(scope, file, ctx);

  for (const item of items) {
    if (item.id === "subagents.defaultModel") {
      item.submenu = (_current, done) => {
        const select = new SelectList(
          modelItems(ctx, file.subagents?.defaultModel),
          12,
          getSelectListTheme(),
        );
        select.onSelect = (picked) => done(picked.value);
        select.onCancel = () => done(undefined);
        return select;
      };
    }
    if (item.id === "subagents.defaultThinking") {
      item.submenu = (_current, done) => {
        const select = new SelectList(
          thinkingItems(ctx, file.subagents?.defaultModel, file.subagents?.defaultThinking),
          Math.min(12, thinkingLevelsFor(ctx, file.subagents?.defaultModel).length + 2),
          getSelectListTheme(),
        );
        select.onSelect = (picked) => done(picked.value);
        select.onCancel = () => done(undefined);
        return select;
      };
    }
  }
  return items;
}

function syncListFromDisk(
  settingsList: SettingsList,
  scope: ConfigScope,
  cwd: string,
  ctx: SessionModelCtx,
) {
  const file = readConfigFile(configPathForScope(scope, cwd));
  for (const item of buildItems(scope, file, ctx)) {
    if (item.id === "scope") {
      settingsList.updateValue("scope", scope);
      continue;
    }
    settingsList.updateValue(item.id, item.currentValue);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pe-settings", {
    description:
      "Configure pi-enhanced defaults (subagent model/thinking inherit Pi; override + concurrency)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          const cfg = effectiveConfig(ctx);
          const piModel = piModelLabel(ctx) ?? "(no model)";
          const piThink = ctx.thinkingLevel ?? "(none)";
          ctx.ui.notify(
            [
              "pi-enhanced settings (read-only outside TUI)",
              `Pi session: model=${piModel} thinking=${piThink}`,
              formatPackageConfigSummary(cfg),
              `Edit with /pe-settings in interactive mode, or edit ${globalConfigPath()}`,
            ].join("\n"),
            "info",
          );
        }
        return;
      }

      let scope: ConfigScope = "global";
      let cachedEffective = effectiveConfig(ctx);
      let cachedScopePath = configPathForScope(scope, ctx.cwd);

      await ctx.ui.custom((tui, theme, _kb, done) => {
        let settingsList!: SettingsList;

        const refreshMeta = () => {
          cachedEffective = effectiveConfig(ctx);
          cachedScopePath = configPathForScope(scope, ctx.cwd);
        };

        const rebuildList = () => {
          refreshMeta();
          const file = readConfigFile(configPathForScope(scope, ctx.cwd));
          const items = createSettingsItems(scope, file, ctx);

          settingsList = new SettingsList(
            items,
            Math.min(items.length + 2, 14),
            getSettingsListTheme(),
            (id, newValue) => {
              if (id === "scope") {
                if (newValue === "project" && !projectTrustedOf(ctx)) {
                  ctx.ui.notify(
                    "Project scope requires a trusted project. Use /trust or stay on global.",
                    "warning",
                  );
                  settingsList.updateValue("scope", scope);
                  tui.requestRender();
                  return;
                }
                const result = applyChange(scope, ctx.cwd, id, newValue, {
                  projectTrusted: projectTrustedOf(ctx),
                });
                if (result.error) {
                  ctx.ui.notify(result.error, "error");
                  settingsList.updateValue("scope", scope);
                  tui.requestRender();
                  return;
                }
                scope = result.scope;
                rebuildList();
                tui.requestRender();
                return;
              }

              const trusted = projectTrustedOf(ctx);
              const result = applyChange(scope, ctx.cwd, id, newValue, {
                projectTrusted: trusted,
              });
              if (result.error) {
                ctx.ui.notify(result.error, "error");
                if (result.scope !== scope) scope = result.scope;
                rebuildList();
                tui.requestRender();
                return;
              }
              // Model change can change available thinking levels — full rebuild.
              if (id === "subagents.defaultModel") {
                rebuildList();
              } else {
                syncListFromDisk(settingsList, scope, ctx.cwd, ctx);
                refreshMeta();
              }
              tui.requestRender();
            },
            () => done(undefined),
          );
        };

        rebuildList();

        return {
          render(width: number) {
            const eff = cachedEffective;
            const piModel = piModelLabel(ctx) ?? "—";
            const piThink = ctx.thinkingLevel ?? "—";
            const header = [
              theme.fg("accent", theme.bold("pi-enhanced settings")),
              theme.fg("muted", `Pi session: ${piModel} · thinking ${piThink}`),
              theme.fg("muted", `scope file: ${cachedScopePath}`),
              theme.fg(
                "dim",
                `package: sa model=${eff.subagents.defaultModel ?? "inherit Pi"} think=${eff.subagents.defaultThinking ?? "inherit Pi"} · sa×${eff.subagents.maxRunning} · bg×${eff.backgroundTerminals.maxRunning} · wf×${eff.workflows.maxRunning}/${eff.workflows.childMaxRunning}`,
              ),
              "",
            ];
            return [...header, ...settingsList.render(width)];
          },
          invalidate() {
            settingsList.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
    },
  });
}
