import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
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
 * Nearest `.pi/agents` at or above cwd. Bounded at the git repo root (or the
 * filesystem root when cwd isn't in a repo) so a directory outside the
 * trusted project can never be picked up as "project" agents.
 */
function findNearestProjectAgentsDir(cwd: string) {
  let dir = canonicalize(cwd);
  const gitRoot = findGitRoot(dir);
  while (true) {
    const candidate = join(dir, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;
    if (gitRoot && dir === gitRoot) return null;
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
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = join(dir, entry.name);
    try {
      const content = readFileSync(filePath, "utf8");
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

      const name = frontmatter.name;
      const description = frontmatter.description;
      if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !description.trim()) {
        continue;
      }

      const rawTools = frontmatter.tools;
      const tools =
        typeof rawTools === "string"
          ? rawTools
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined;

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
