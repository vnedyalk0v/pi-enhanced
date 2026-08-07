import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Stored on disk — only overrides; missing keys mean package defaults. */
export type PackageConfigFile = {
  subagents?: {
    /** provider/id; omit or empty = inherit Pi session model (after agent pin) */
    defaultModel?: string;
    /** omit or empty = inherit Pi session thinking level (after agent pin) */
    defaultThinking?: string;
    maxRunning?: number;
    maxRuntimeMinutes?: number;
  };
  backgroundTerminals?: {
    maxRunning?: number;
  };
  workflows?: {
    maxRunning?: number;
    /** Per-workflow child subagent pool size. */
    childMaxRunning?: number;
  };
};

export type ResolvedPackageConfig = {
  subagents: {
    defaultModel?: string;
    defaultThinking?: string;
    maxRunning: number;
    maxRuntimeMinutes: number;
    maxRuntimeMs: number;
  };
  backgroundTerminals: {
    maxRunning: number;
  };
  workflows: {
    maxRunning: number;
    childMaxRunning: number;
  };
};

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const PACKAGE_CONFIG_FILENAME = "pi-enhanced.json";

export const DEFAULT_PACKAGE_CONFIG: ResolvedPackageConfig = {
  subagents: {
    maxRunning: 4,
    maxRuntimeMinutes: 30,
    maxRuntimeMs: 30 * 60_000,
  },
  backgroundTerminals: {
    maxRunning: 8,
  },
  workflows: {
    maxRunning: 1,
    childMaxRunning: 4,
  },
};

export type ConfigScope = "global" | "project";

export function globalConfigPath() {
  return join(getAgentDir(), "extensions", PACKAGE_CONFIG_FILENAME);
}

export function projectConfigPath(cwd: string) {
  return join(cwd, CONFIG_DIR_NAME, PACKAGE_CONFIG_FILENAME);
}

export function configPathForScope(scope: ConfigScope, cwd: string) {
  return scope === "global" ? globalConfigPath() : projectConfigPath(cwd);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalPositiveInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalThinking(value: unknown): string | undefined {
  const s = optionalNonEmptyString(value);
  if (!s) return undefined;
  return (THINKING_LEVELS as readonly string[]).includes(s) ? s : undefined;
}

/** Parse and sanitize a config file object; invalid fields are dropped. */
export function parsePackageConfigFile(raw: unknown): PackageConfigFile {
  if (!isPlainObject(raw)) return {};
  const out: PackageConfigFile = {};

  if (isPlainObject(raw.subagents)) {
    const s = raw.subagents;
    const subagents: NonNullable<PackageConfigFile["subagents"]> = {};
    const model = optionalNonEmptyString(s.defaultModel);
    if (model) subagents.defaultModel = model;
    const thinking = optionalThinking(s.defaultThinking);
    if (thinking) subagents.defaultThinking = thinking;
    const maxRunning = optionalPositiveInt(s.maxRunning, 1, 32);
    if (maxRunning !== undefined) subagents.maxRunning = maxRunning;
    const maxRuntimeMinutes = optionalPositiveInt(s.maxRuntimeMinutes, 1, 240);
    if (maxRuntimeMinutes !== undefined) subagents.maxRuntimeMinutes = maxRuntimeMinutes;
    if (Object.keys(subagents).length > 0) out.subagents = subagents;
  }

  if (isPlainObject(raw.backgroundTerminals)) {
    const maxRunning = optionalPositiveInt(raw.backgroundTerminals.maxRunning, 1, 32);
    if (maxRunning !== undefined) out.backgroundTerminals = { maxRunning };
  }

  if (isPlainObject(raw.workflows)) {
    const w = raw.workflows;
    const workflows: NonNullable<PackageConfigFile["workflows"]> = {};
    const maxRunning = optionalPositiveInt(w.maxRunning, 1, 8);
    if (maxRunning !== undefined) workflows.maxRunning = maxRunning;
    const childMaxRunning = optionalPositiveInt(w.childMaxRunning, 1, 32);
    if (childMaxRunning !== undefined) workflows.childMaxRunning = childMaxRunning;
    if (Object.keys(workflows).length > 0) out.workflows = workflows;
  }

  return out;
}

export function readConfigFile(path: string): PackageConfigFile {
  try {
    const text = readFileSync(path, "utf8");
    return parsePackageConfigFile(JSON.parse(text) as unknown);
  } catch {
    return {};
  }
}

export function mergeConfigFiles(
  globalFile: PackageConfigFile,
  projectFile: PackageConfigFile,
): PackageConfigFile {
  return {
    subagents: { ...globalFile.subagents, ...projectFile.subagents },
    backgroundTerminals: {
      ...globalFile.backgroundTerminals,
      ...projectFile.backgroundTerminals,
    },
    workflows: { ...globalFile.workflows, ...projectFile.workflows },
  };
}

export function resolvePackageConfig(file: PackageConfigFile): ResolvedPackageConfig {
  const minutes =
    file.subagents?.maxRuntimeMinutes ?? DEFAULT_PACKAGE_CONFIG.subagents.maxRuntimeMinutes;
  return {
    subagents: {
      defaultModel: file.subagents?.defaultModel,
      defaultThinking: file.subagents?.defaultThinking,
      maxRunning: file.subagents?.maxRunning ?? DEFAULT_PACKAGE_CONFIG.subagents.maxRunning,
      maxRuntimeMinutes: minutes,
      maxRuntimeMs: minutes * 60_000,
    },
    backgroundTerminals: {
      maxRunning:
        file.backgroundTerminals?.maxRunning ??
        DEFAULT_PACKAGE_CONFIG.backgroundTerminals.maxRunning,
    },
    workflows: {
      maxRunning: file.workflows?.maxRunning ?? DEFAULT_PACKAGE_CONFIG.workflows.maxRunning,
      childMaxRunning:
        file.workflows?.childMaxRunning ?? DEFAULT_PACKAGE_CONFIG.workflows.childMaxRunning,
    },
  };
}

export type PackageConfigCtx = {
  cwd: string;
  projectTrusted: boolean;
};

/**
 * Load effective package config. Project file is only applied when the project
 * is trusted (same rule as other project-local Pi config).
 */
export function loadPackageConfig(options: PackageConfigCtx): ResolvedPackageConfig {
  const globalFile = readConfigFile(globalConfigPath());
  const projectFile = options.projectTrusted ? readConfigFile(projectConfigPath(options.cwd)) : {};
  return resolvePackageConfig(mergeConfigFiles(globalFile, projectFile));
}

/** Extension ctx may predate `isProjectTrusted`; default-deny when it is absent. */
export function projectTrustedOf(ctx: { isProjectTrusted?: () => boolean }) {
  return typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
}

/** Config for a remembered session ctx, or an untrusted cwd before one is seen. */
export function loadPackageConfigFor(ctx: PackageConfigCtx | undefined) {
  return loadPackageConfig(ctx ?? { cwd: process.cwd(), projectTrusted: false });
}

function pruneEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const nested = pruneEmpty(v as Record<string, unknown>);
      if (Object.keys(nested).length > 0) out[k] = nested;
      continue;
    }
    out[k] = v;
  }
  return out as Partial<T>;
}

export function writeConfigFile(path: string, file: PackageConfigFile) {
  const cleaned = pruneEmpty(file as Record<string, unknown>) as PackageConfigFile;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(cleaned, null, 2)}\n`;
  // Atomic replace so readers never see a partial JSON document.
  const tmp = join(dir, `.${PACKAGE_CONFIG_FILENAME}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

/**
 * Patch one scope file. Pass `null` for a field to clear an override.
 * Nested objects are shallow-merged at the section level for provided keys.
 */
export function patchConfigFile(
  scope: ConfigScope,
  cwd: string,
  patch: {
    subagents?: {
      defaultModel?: string | null;
      defaultThinking?: string | null;
      maxRunning?: number | null;
      maxRuntimeMinutes?: number | null;
    };
    backgroundTerminals?: {
      maxRunning?: number | null;
    };
    workflows?: {
      maxRunning?: number | null;
      childMaxRunning?: number | null;
    };
  },
): PackageConfigFile {
  const path = configPathForScope(scope, cwd);
  const current = readConfigFile(path);

  const applySection = <T extends Record<string, unknown>>(
    base: T | undefined,
    updates: { [K in keyof T]?: T[K] | null } | undefined,
  ): T | undefined => {
    if (!updates) return base;
    const next: Record<string, unknown> = { ...(base ?? {}) };
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) delete next[key];
      else if (value !== undefined) next[key] = value;
    }
    return Object.keys(next).length > 0 ? (next as T) : undefined;
  };

  const next: PackageConfigFile = {
    subagents: applySection(current.subagents, patch.subagents),
    backgroundTerminals: applySection(current.backgroundTerminals, patch.backgroundTerminals),
    workflows: applySection(current.workflows, patch.workflows),
  };

  // Re-parse so invalid values never persist.
  const sanitized = parsePackageConfigFile(next);
  writeConfigFile(path, sanitized);
  return sanitized;
}

export function formatPackageConfigSummary(config: ResolvedPackageConfig) {
  const model = config.subagents.defaultModel ?? "(inherit from Pi session)";
  const thinking = config.subagents.defaultThinking ?? "(inherit from Pi session)";
  return [
    `subagents: model=${model} thinking=${thinking} maxRunning=${config.subagents.maxRunning} maxRuntime=${config.subagents.maxRuntimeMinutes}m`,
    `background terminals: maxRunning=${config.backgroundTerminals.maxRunning}`,
    `workflows: maxRunning=${config.workflows.maxRunning} childMaxRunning=${config.workflows.childMaxRunning}`,
  ].join("\n");
}
