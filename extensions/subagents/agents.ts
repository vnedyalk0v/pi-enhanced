import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
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

function findNearestProjectAgentsDir(cwd: string) {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;
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
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      systemPrompt: body,
      source,
      filePath,
    });
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
