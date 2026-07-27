import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentSource = "user" | "project";

export type AgentDefinition = {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
};

export type AgentDiscovery = {
  agents: AgentDefinition[];
  projectAgentsDir: string | null;
};

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve symlinks so the git-root/climb logic operates on the real directory
 * tree. A `working_dir` symlink inside a trusted repo can point outside it;
 * without this, lexical `dirname()` climbing never notices the jump and can
 * treat an external directory's `.git`/`.pi/agents` as part of the trusted repo.
 */
function canonicalize(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Nearest ancestor (including itself) containing `.git`, bounding how far project-local discovery may climb. */
export function findGitRoot(cwd: string) {
  let dir = canonicalize(cwd);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * True when both directories resolve into the same git repository. Trust
 * travels with the repository, not the exact path — a `working_dir` elsewhere
 * in the same repo (a monorepo package, "../.." back to the root, or a
 * symlink resolving inside it) shares the session's trust decision; a
 * different repo, no repo, or a symlink resolving outside the repo never does.
 */
export function sharesGitRoot(a: string, b: string) {
  const rootA = findGitRoot(a);
  return rootA !== null && rootA === findGitRoot(b);
}

/**
 * True when `workerCwd` is entitled to the same project trust as `sessionCwd`:
 * either it's the very directory pi already resolved trust for (the common
 * no-`working_dir`-override case — including trusted projects that aren't
 * git repos at all, where `sharesGitRoot` can never be true), or both resolve
 * into the same git repository (a monorepo package, "../.." back to the
 * root). A different repo, no repo at all with a different directory, or a
 * symlink resolving outside the repo, never qualifies.
 */
export function isSameTrustedProject(sessionCwd: string, workerCwd: string) {
  return canonicalize(sessionCwd) === canonicalize(workerCwd) || sharesGitRoot(sessionCwd, workerCwd);
}

/** True when `target` is `root` or nested inside it. */
function isWithinDir(root: string, target: string) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Nearest `.pi/agents` at or above cwd. Bounded at the git repo root — or,
 * when cwd isn't in a git repo at all, at cwd itself (there's no other
 * principled boundary for "the trusted project" without a git marker, so an
 * unrelated ancestor's `.pi/agents` — a parent workspace, the home directory —
 * must never be picked up as this directory's project agents). Also rejects
 * a candidate whose real (symlink-resolved) location escapes the directory
 * being scanned — `.pi` or `.pi/agents` itself can be a symlink pointing
 * anywhere on disk, which `statSync`/`readdirSync` would otherwise follow
 * transparently.
 */
function findNearestProjectAgentsDir(cwd: string) {
  const start = canonicalize(cwd);
  const gitRoot = findGitRoot(start);
  const stopAt = gitRoot ?? start;
  let dir = start;
  while (true) {
    const candidate = canonicalize(join(dir, CONFIG_DIR_NAME, "agents"));
    if (isWithinDir(dir, candidate) && isDirectory(candidate)) return candidate;
    if (dir === stopAt) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentDefinition[] {
  if (!isDirectory(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    // Project definitions are repo-controlled; a symlink there could resolve
    // anywhere on disk (e.g. a private user-level prompt) and have its target
    // silently read as a system prompt, under a confirm dialog that only ever
    // shows the innocuous in-repo path. User definitions are already fully
    // trusted, so symlinks there (e.g. a shared agents repo) stay supported.
    const symlinkAllowed = source === "user" && entry.isSymbolicLink();
    if (!entry.isFile() && !symlinkAllowed) continue;

    const filePath = join(dir, entry.name);
    try {
      const content = readFileSync(filePath, "utf8");
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

      const rawName = frontmatter.name;
      const description = frontmatter.description;
      if (
        typeof rawName !== "string" ||
        !rawName.trim() ||
        typeof description !== "string" ||
        !description.trim()
      ) {
        continue;
      }
      const name = rawName.trim();

      const rawTools = frontmatter.tools;
      let tools: string[] | undefined;
      if (rawTools === undefined) {
        tools = undefined;
      } else if (typeof rawTools === "string") {
        tools = rawTools
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      } else if (Array.isArray(rawTools) && rawTools.every((t) => typeof t === "string")) {
        tools = rawTools.map((t) => t.trim()).filter(Boolean);
      } else {
        // Some other shape (number, object, mixed array, ...) — skip the whole
        // definition rather than silently dropping the restriction and
        // granting the full default tool set instead of the intended one.
        continue;
      }

      agents.push({
        name,
        description,
        tools: tools && tools.length > 0 ? tools : undefined,
        model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
        thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
        systemPrompt: body,
        source,
        filePath,
      });
    } catch {
      // Malformed frontmatter (bad YAML, wrong field types) — skip only this
      // file; one broken definition must not abort discovery for the rest.
      continue;
    }
  }
  return agents;
}

/**
 * Discover named subagent definitions: user-level (~/.pi/agent/agents, always) and
 * project-level (.pi/agents, only for trusted projects — these are repo-controlled
 * prompts). Project agents override user agents with the same name.
 */
export function discoverAgents(
  cwd: string,
  projectTrusted: boolean,
  agentDir: string = getAgentDir(),
): AgentDiscovery {
  const userAgents = loadAgentsFromDir(join(agentDir, "agents"), "user");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const projectAgents =
    projectTrusted && projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];

  const byName = new Map<string, AgentDefinition>();
  for (const agent of userAgents) byName.set(agent.name, agent);
  for (const agent of projectAgents) byName.set(agent.name, agent);

  return { agents: [...byName.values()], projectAgentsDir };
}
