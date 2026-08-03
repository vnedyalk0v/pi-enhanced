import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  opendirSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { terminalText } from "../shared/terminal-text.ts";
import { truncateOneLine } from "../shared/text.ts";

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
 * True when `target` is `root` or nested inside it. Checks for the actual
 * parent-traversal token (`rel === ".."` or `rel` starting with `..` + the
 * path separator), not merely a string starting with two dots — a legitimate
 * entry name like `..cache` also starts with "..", and `path.relative()`
 * returns it bare (no leading `./`) for a direct child.
 */
function isWithinDir(root: string, target: string) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * True when `workerCwd` is entitled to the same project trust as `sessionCwd`:
 * either it's the very directory pi already resolved trust for (the common
 * no-`working_dir`-override case), both resolve into the same git repository
 * (a monorepo package, "../.." back to the root), or — when the worker
 * directory isn't governed by any git repo at all — it's nested inside
 * `sessionCwd` (a subdirectory of an otherwise-ungoverned trusted project).
 * That last branch can only ever apply when `workerCwd` truly has no git
 * identity of its own: if `sessionCwd` has a git root, any directory nested
 * inside it necessarily shares that same root (or a closer one of its own,
 * e.g. a submodule — a genuinely distinct repo, correctly excluded). A
 * different repo, an unrelated non-git directory, or a symlink resolving
 * outside the repo, never qualifies.
 */
export function isSameTrustedProject(sessionCwd: string, workerCwd: string) {
  const session = canonicalize(sessionCwd);
  const worker = canonicalize(workerCwd);
  if (session === worker) return true;
  if (sharesGitRoot(sessionCwd, workerCwd)) return true;
  return findGitRoot(worker) === null && isWithinDir(session, worker);
}

/**
 * Nearest `.pi/agents` at or above cwd. Bounded at the git repo root — or,
 * when cwd isn't in a git repo at all, at `boundary` (defaults to cwd itself:
 * there's no other principled edge for "the trusted project" without a git
 * marker, so an unrelated ancestor's `.pi/agents` — a parent workspace, the
 * home directory — must never be picked up). Callers that already know the
 * trusted session directory (and have verified, via `isSameTrustedProject`,
 * that cwd is nested inside it) pass it explicitly so a nested working_dir in
 * a git-less trusted project can still see the session root's agents. Also
 * rejects a candidate whose real (symlink-resolved) location escapes the
 * directory being scanned — `.pi` or `.pi/agents` itself can be a symlink
 * pointing anywhere on disk, which `statSync`/`readdirSync` would otherwise
 * follow transparently.
 */
function findNearestProjectAgentsDir(cwd: string, boundary: string) {
  const start = canonicalize(cwd);
  const gitRoot = findGitRoot(start);
  const canonicalBoundary = canonicalize(boundary);
  // Guard against a boundary that isn't actually an ancestor of start (e.g.
  // trust wasn't established, or a caller passes something unrelated) — fall
  // back to the safe default of never climbing past the starting directory.
  const stopAt = gitRoot ?? (isWithinDir(canonicalBoundary, start) ? canonicalBoundary : start);
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
        // Keep an explicit empty list (`tools: []` / `tools: ""`) distinct
        // from an absent field — the former means "no tools at all" and must
        // not collapse into "unrestricted" (backend.ts passes `--tools ""`
        // for an empty array vs. omitting the flag entirely for `undefined`).
        tools,
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
 *
 * `discoveryBoundary` (default: cwd) bounds project-agent discovery when cwd
 * isn't in a git repo. Pass the trusted session directory when cwd is a
 * `working_dir`-resolved descendant of it (per `isSameTrustedProject`) so a
 * nested working_dir in a git-less trusted project still finds the session
 * root's agents.
 */
export function discoverAgents(
  cwd: string,
  projectTrusted: boolean,
  agentDir: string = getAgentDir(),
  discoveryBoundary: string = cwd,
): AgentDiscovery {
  const userAgents = loadAgentsFromDir(join(agentDir, "agents"), "user");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd, discoveryBoundary);
  const projectAgents =
    projectTrusted && projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];

  const byName = new Map<string, AgentDefinition>();
  for (const agent of userAgents) byName.set(agent.name, agent);
  for (const agent of projectAgents) byName.set(agent.name, agent);

  return { agents: [...byName.values()], projectAgentsDir };
}

/** Diagnostic limits apply before a repository has been trusted. */
const DIAGNOSTIC_MAX_FILE_BYTES = 256 * 1024;
const DIAGNOSTIC_MAX_FRONTMATTER_BYTES = 32 * 1024;
const DIAGNOSTIC_MAX_TOTAL_BYTES = 512 * 1024;
const DIAGNOSTIC_MAX_FILES = 64;

type DiagnosticBudget = { entries: number; bytes: number };

function findFrontmatterEnd(buffer: Buffer) {
  if (buffer.length < 3 || buffer[0] !== 45 || buffer[1] !== 45 || buffer[2] !== 45) {
    return -1;
  }
  for (let i = 3; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte !== 10 && byte !== 13) continue;
    const marker = byte === 13 && buffer[i + 1] === 10 ? i + 2 : i + 1;
    if (buffer[marker] === 45 && buffer[marker + 1] === 45 && buffer[marker + 2] === 45) {
      return marker + 3;
    }
  }
  return -1;
}

function readDiagnosticAgentName(fd: number, maxBytes: number) {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let frontmatterEnd = -1;
  while (bytesRead < maxBytes && frontmatterEnd === -1) {
    const chunk = Buffer.allocUnsafe(Math.min(512, maxBytes - bytesRead));
    const count = readSync(fd, chunk, 0, chunk.length, bytesRead);
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    bytesRead += count;
    frontmatterEnd = findFrontmatterEnd(Buffer.concat(chunks, bytesRead));
  }
  if (frontmatterEnd === -1) return { bytesRead };

  try {
    // Parse only through the closing marker; prompt body bytes from the final
    // read chunk are never converted to a string or retained.
    const frontmatterBlock = Buffer.concat(chunks, bytesRead)
      .subarray(0, frontmatterEnd)
      .toString("utf8");
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(frontmatterBlock);
    const rawName = frontmatter.name;
    const description = frontmatter.description;
    if (
      typeof rawName !== "string" ||
      !rawName.trim() ||
      typeof description !== "string" ||
      !description.trim()
    ) {
      return { bytesRead };
    }
    return { bytesRead, name: rawName.trim() };
  } catch {
    return { bytesRead };
  }
}

/** Find one project agent without materializing every repo-controlled prompt. */
function findDiagnosticProjectAgent(
  name: string,
  cwd: string,
  boundary: string,
  budget: DiagnosticBudget,
) {
  const dir = findNearestProjectAgentsDir(cwd, boundary);
  if (!dir) return undefined;

  try {
    const handle = opendirSync(dir);
    try {
      while (budget.entries > 0 && budget.bytes > 0) {
        const entry = handle.readSync();
        if (!entry) break;
        // Count every directory entry, including irrelevant files and symlinks.
        budget.entries -= 1;
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

        const filePath = join(dir, entry.name);
        let fd: number | undefined;
        try {
          fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > DIAGNOSTIC_MAX_FILE_BYTES) continue;
          const result = readDiagnosticAgentName(
            fd,
            Math.min(DIAGNOSTIC_MAX_FRONTMATTER_BYTES, budget.bytes),
          );
          budget.bytes -= result.bytesRead;
          if (result.name === name) return filePath;
        } catch {
          continue;
        } finally {
          if (fd !== undefined) {
            try {
              closeSync(fd);
            } catch {
              // Best-effort diagnostic cleanup.
            }
          }
        }
      }
    } finally {
      handle.closeSync();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export type HiddenAgentInfo = {
  filePath: string;
  reason: "project-untrusted" | "working-dir-outside-project";
};

/**
 * Explain why a named agent was not discoverable: it may exist as a project
 * definition that trust rules excluded. Diagnostic only — reads frontmatter to
 * match the name, never executes the definition. The read is size-bounded
 * because it inspects a repository that has not been trusted.
 */
export function findHiddenAgent(
  name: string,
  workerCwd: string,
  sessionCwd: string,
  sessionTrusted: boolean,
): HiddenAgentInfo | undefined {
  // Diagnostics inspect project files only, avoiding unrelated user prompts.
  const budget: DiagnosticBudget = {
    entries: DIAGNOSTIC_MAX_FILES,
    bytes: DIAGNOSTIC_MAX_TOTAL_BYTES,
  };
  const sameProject = isSameTrustedProject(sessionCwd, workerCwd);
  const workerBoundary = sameProject ? sessionCwd : workerCwd;
  const nearWorker = findDiagnosticProjectAgent(name, workerCwd, workerBoundary, budget);
  if (nearWorker) {
    if (sameProject) {
      return sessionTrusted
        ? undefined
        : { filePath: nearWorker, reason: "project-untrusted" };
    }
    return { filePath: nearWorker, reason: "working-dir-outside-project" };
  }
  if (sameProject) return undefined;

  const inSession = findDiagnosticProjectAgent(name, sessionCwd, sessionCwd, budget);
  return inSession
    ? { filePath: inSession, reason: "working-dir-outside-project" }
    : undefined;
}

export function describeHiddenAgent(name: string, workingDir: string, hidden: HiddenAgentInfo) {
  // The file lives in an untrusted repo, so its name is attacker-chosen;
  // strip control characters before echoing it into a model-facing error.
  const filePath = truncateOneLine(terminalText(hidden.filePath), 300);
  if (hidden.reason === "project-untrusted") {
    return (
      `Agent "${name}" is defined at ${filePath}, but project agents only load ` +
      "for trusted projects. Approve the project to use it."
    );
  }
  return (
    `Agent "${name}" is defined at ${filePath}, but working_dir "${truncateOneLine(terminalText(workingDir), 300)}" ` +
    "does not share the trusted project, so project agents are unavailable there. " +
    "Omit working_dir or use a directory inside the project."
  );
}
