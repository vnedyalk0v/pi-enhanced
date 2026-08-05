import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  discoverAgents,
  findGitRoot,
  isSameTrustedProject,
  sharesGitRoot,
} from "./agents.ts";

// realpathSync matters here: mkdtemp roots can themselves sit behind a symlink
// (e.g. macOS's /var/folders -> /private/var/folders), and discoverAgents/
// findGitRoot canonicalize internally, so tests must compare against the same
// canonical form or they'd fail purely on path spelling, not behavior.
function mkTempDir(prefix: string) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

let agentDir: string;
let cwd: string;

beforeEach(() => {
  agentDir = mkTempDir("pi-subagent-agentdir-");
  cwd = mkTempDir("pi-subagent-cwd-");
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function writeAgent(dir: string, filename: string, content: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf8");
}

describe("discoverAgents", () => {
  it("loads a user agent with tools and model frontmatter", () => {
    writeAgent(
      join(agentDir, "agents"),
      "scout.md",
      [
        "---",
        "name: scout",
        "description: Fast codebase recon",
        "tools: read, grep, find",
        "model: anthropic/claude-haiku-4-5",
        "---",
        "Find things quickly.",
      ].join("\n"),
    );

    const { agents } = discoverAgents(cwd, false, agentDir);
    assert.equal(agents.length, 1);
    assert.deepEqual(agents[0], {
      name: "scout",
      description: "Fast codebase recon",
      tools: ["read", "grep", "find"],
      model: "anthropic/claude-haiku-4-5",
      thinking: undefined,
      systemPrompt: "Find things quickly.",
      source: "user",
      filePath: join(agentDir, "agents", "scout.md"),
    });
  });

  it("skips files missing required frontmatter", () => {
    writeAgent(join(agentDir, "agents"), "broken.md", "---\ndescription: no name\n---\nbody");
    const { agents } = discoverAgents(cwd, false, agentDir);
    assert.equal(agents.length, 0);
  });

  it("ignores project agents when the project is untrusted", () => {
    writeAgent(
      join(cwd, CONFIG_DIR_NAME, "agents"),
      "worker.md",
      "---\nname: worker\ndescription: general\n---\nBody.",
    );

    const untrusted = discoverAgents(cwd, false, agentDir);
    assert.equal(untrusted.agents.length, 0);
    assert.equal(untrusted.projectAgentsDir, join(cwd, CONFIG_DIR_NAME, "agents"));

    const trusted = discoverAgents(cwd, true, agentDir);
    assert.equal(trusted.agents.length, 1);
    assert.equal(trusted.agents[0].source, "project");
  });

  it("lets a trusted project agent override a same-named user agent", () => {
    writeAgent(
      join(agentDir, "agents"),
      "worker.md",
      "---\nname: worker\ndescription: user version\n---\nUser body.",
    );
    writeAgent(
      join(cwd, CONFIG_DIR_NAME, "agents"),
      "worker.md",
      "---\nname: worker\ndescription: project version\n---\nProject body.",
    );

    const { agents } = discoverAgents(cwd, true, agentDir);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].description, "project version");
    assert.equal(agents[0].source, "project");
  });

  it("skips a file with malformed YAML frontmatter and keeps loading the rest", () => {
    const dir = join(agentDir, "agents");
    writeAgent(dir, "broken.md", "---\nname: [unterminated\ndescription: bad\n---\nBody.");
    writeAgent(dir, "good.md", "---\nname: good\ndescription: still works\n---\nBody.");

    const { agents } = discoverAgents(cwd, false, agentDir);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "good");
  });

  it("trims a quoted name so it matches a trimmed sa_spawn lookup", () => {
    writeAgent(
      join(agentDir, "agents"),
      "scout.md",
      '---\nname: " scout "\ndescription: Fast codebase recon\n---\nBody.',
    );

    const { agents } = discoverAgents(cwd, false, agentDir);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "scout");
  });

  it("rejects a project-agent symlink pointing outside the project", () => {
    const outsideFile = join(agentDir, "private.md");
    writeFileSync(outsideFile, "---\nname: private\ndescription: not part of this project\n---\nBody.", "utf8");

    const projectAgentsDir = join(cwd, CONFIG_DIR_NAME, "agents");
    mkdirSync(projectAgentsDir, { recursive: true });
    symlinkSync(outsideFile, join(projectAgentsDir, "leaked.md"));

    const { agents } = discoverAgents(cwd, true, agentDir);
    assert.equal(agents.length, 0);
  });

  it("still allows a symlinked user agent", () => {
    const realFile = join(cwd, "shared-scout.md");
    writeFileSync(realFile, "---\nname: scout\ndescription: shared via symlink\n---\nBody.", "utf8");

    const userAgentsDir = join(agentDir, "agents");
    mkdirSync(userAgentsDir, { recursive: true });
    symlinkSync(realFile, join(userAgentsDir, "scout.md"));

    const { agents } = discoverAgents(cwd, false, agentDir);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "scout");
  });

  it("accepts a YAML list tools field the same as a comma string", () => {
    writeAgent(
      join(agentDir, "agents"),
      "list-tools.md",
      ["---", "name: listy", "description: tools as a YAML list", "tools:", "  - read", "  - grep", "---", "Body."].join(
        "\n",
      ),
    );

    const { agents } = discoverAgents(cwd, false, agentDir);
    assert.equal(agents.length, 1);
    assert.deepEqual(agents[0].tools, ["read", "grep"]);
  });

  it("skips the whole definition for a tools field that is neither a string nor a string array", () => {
    writeAgent(
      join(agentDir, "agents"),
      "bad-tools.md",
      "---\nname: badtools\ndescription: tools is a number\ntools: 42\n---\nBody.",
    );

    // A read-only-intended agent must never fail open to the full default
    // tool set just because its tools field couldn't be parsed.
    const { agents } = discoverAgents(cwd, false, agentDir);
    assert.equal(agents.length, 0);
  });

  it("preserves an explicit empty tools list distinct from an absent one", () => {
    writeAgent(
      join(agentDir, "agents"),
      "no-tools-list.md",
      "---\nname: notools1\ndescription: explicit empty YAML list\ntools: []\n---\nBody.",
    );
    writeAgent(
      join(agentDir, "agents"),
      "no-tools-string.md",
      '---\nname: notools2\ndescription: explicit empty string\ntools: ""\n---\nBody.',
    );

    // An agent with no tools at all must stay distinguishable from one with
    // no tools field — the latter means "unrestricted", not the former.
    const { agents } = discoverAgents(cwd, false, agentDir);
    assert.equal(agents.length, 2);
    const byName = new Map(agents.map((a) => [a.name, a]));
    assert.deepEqual(byName.get("notools1")?.tools, []);
    assert.deepEqual(byName.get("notools2")?.tools, []);
    assert.notEqual(byName.get("notools1")?.tools, undefined);
  });

  it("does not climb past the git repo root for project agents", () => {
    const sandbox = mkTempDir("pi-subagent-sandbox-");
    try {
      const repoRoot = join(sandbox, "repo");
      const nestedCwd = join(repoRoot, "src", "nested");
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      mkdirSync(nestedCwd, { recursive: true });

      // Outside the repo (an ancestor of repoRoot) — must never be picked up.
      writeAgent(
        join(sandbox, CONFIG_DIR_NAME, "agents"),
        "leaked.md",
        "---\nname: leaked\ndescription: outside the repo\n---\nBody.",
      );

      const outside = discoverAgents(nestedCwd, true, agentDir);
      assert.equal(outside.agents.length, 0);
      assert.equal(outside.projectAgentsDir, null);

      // Inside the repo root itself — found even though cwd is nested deeper.
      writeAgent(
        join(repoRoot, CONFIG_DIR_NAME, "agents"),
        "inside.md",
        "---\nname: inside\ndescription: inside the repo\n---\nBody.",
      );

      const inside = discoverAgents(nestedCwd, true, agentDir);
      assert.equal(inside.agents.length, 1);
      assert.equal(inside.agents[0].name, "inside");
      assert.equal(inside.projectAgentsDir, join(repoRoot, CONFIG_DIR_NAME, "agents"));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("does not climb past the starting directory when there is no git repo at all", () => {
    const sandbox = mkTempDir("pi-subagent-nogit-sandbox-");
    try {
      const projectDir = join(sandbox, "project");
      mkdirSync(projectDir, { recursive: true });

      // An unrelated ancestor's .pi/agents (e.g. a parent workspace or home
      // directory) must never be picked up just because there's no git repo
      // to otherwise bound the climb.
      writeAgent(
        join(sandbox, CONFIG_DIR_NAME, "agents"),
        "leaked.md",
        "---\nname: leaked\ndescription: unrelated ancestor, no git repo anywhere\n---\nBody.",
      );

      const result = discoverAgents(projectDir, true, agentDir);
      assert.equal(result.agents.length, 0);
      assert.equal(result.projectAgentsDir, null);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("climbs up to an explicit boundary for a nested working_dir with no git repo", () => {
    const sandbox = mkTempDir("pi-subagent-nogit-boundary-sandbox-");
    try {
      const sessionRoot = join(sandbox, "project");
      const nestedWorkingDir = join(sessionRoot, "src", "nested");
      mkdirSync(nestedWorkingDir, { recursive: true });

      writeAgent(
        join(sessionRoot, CONFIG_DIR_NAME, "agents"),
        "scout.md",
        "---\nname: scout\ndescription: at the session root\n---\nBody.",
      );

      // Without an explicit boundary, discovery never climbs past the
      // starting (nested) directory — matches sa_spawn's default working_dir.
      const noBoundary = discoverAgents(nestedWorkingDir, true, agentDir);
      assert.equal(noBoundary.agents.length, 0);

      // With the session root passed as the boundary (what index.ts does via
      // isSameTrustedProject + resolveDiscoveryContext), the session root's
      // agents are found even though cwd is nested deeper.
      const withBoundary = discoverAgents(nestedWorkingDir, true, agentDir, sessionRoot);
      assert.equal(withBoundary.agents.length, 1);
      assert.equal(withBoundary.agents[0].name, "scout");

      // An unrelated boundary (not an ancestor of cwd) must not silently
      // widen the climb either.
      const unrelatedBoundary = discoverAgents(nestedWorkingDir, true, agentDir, join(sandbox, "unrelated"));
      assert.equal(unrelatedBoundary.agents.length, 0);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects a .pi/agents directory that is itself a symlink escaping the project", () => {
    const sandbox = mkTempDir("pi-subagent-dirlink-sandbox-");
    try {
      const repoRoot = join(sandbox, "repo");
      mkdirSync(join(repoRoot, ".git"), { recursive: true });

      const outsideAgentsDir = join(sandbox, "outside-agents");
      writeAgent(
        outsideAgentsDir,
        "leaked.md",
        "---\nname: leaked\ndescription: reached via a symlinked .pi/agents directory\n---\nBody.",
      );

      // .pi/agents (the whole directory, not just a file inside it) is a
      // symlink pointing outside the repo.
      mkdirSync(join(repoRoot, CONFIG_DIR_NAME), { recursive: true });
      symlinkSync(outsideAgentsDir, join(repoRoot, CONFIG_DIR_NAME, "agents"));

      const result = discoverAgents(repoRoot, true, agentDir);
      assert.equal(result.agents.length, 0);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("findGitRoot", () => {
  it("finds the repo root from a nested subdirectory", () => {
    const sandbox = mkTempDir("pi-gitroot-sandbox-");
    try {
      const repoRoot = join(sandbox, "repo");
      const nested = join(repoRoot, "packages", "app");
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      mkdirSync(nested, { recursive: true });

      assert.equal(findGitRoot(nested), repoRoot);
      assert.equal(findGitRoot(repoRoot), repoRoot);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("returns null outside any git repo", () => {
    const sandbox = mkTempDir("pi-gitroot-sandbox-");
    try {
      assert.equal(findGitRoot(sandbox), null);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("resolves a symlink before climbing, so it reports the real repo root", () => {
    const sandbox = mkTempDir("pi-gitroot-symlink-sandbox-");
    try {
      const repoRoot = join(sandbox, "repo");
      mkdirSync(join(repoRoot, ".git"), { recursive: true });

      const outside = join(sandbox, "outside");
      mkdirSync(outside, { recursive: true });

      const link = join(repoRoot, "escape-hatch");
      symlinkSync(outside, link);

      // The symlink lexically lives under repoRoot, but resolves outside it —
      // its git root must not be reported as repoRoot.
      assert.notEqual(findGitRoot(link), repoRoot);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("sharesGitRoot", () => {
  it("is true for two directories in the same repo", () => {
    const sandbox = mkTempDir("pi-sharesroot-sandbox-");
    try {
      const repoRoot = join(sandbox, "repo");
      const nested = join(repoRoot, "packages", "app");
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      mkdirSync(nested, { recursive: true });

      assert.equal(sharesGitRoot(repoRoot, nested), true);
      assert.equal(sharesGitRoot(nested, repoRoot), true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("is false across two different repos, and when neither is a repo", () => {
    const sandbox = mkTempDir("pi-sharesroot-sandbox-");
    try {
      const repoA = join(sandbox, "repo-a");
      const repoB = join(sandbox, "repo-b");
      mkdirSync(join(repoA, ".git"), { recursive: true });
      mkdirSync(join(repoB, ".git"), { recursive: true });

      assert.equal(sharesGitRoot(repoA, repoB), false);
      assert.equal(sharesGitRoot(sandbox, sandbox), false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("is false for a working_dir symlink that escapes the repo, even though it's lexically inside it", () => {
    const sandbox = mkTempDir("pi-sharesroot-symlink-sandbox-");
    try {
      const repoRoot = join(sandbox, "repo");
      mkdirSync(join(repoRoot, ".git"), { recursive: true });

      const outside = join(sandbox, "outside");
      mkdirSync(outside, { recursive: true });

      // A working_dir symlink inside the trusted repo that resolves outside it.
      const link = join(repoRoot, "escape-hatch");
      symlinkSync(outside, link);

      assert.equal(sharesGitRoot(repoRoot, link), false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("isSameTrustedProject", () => {
  it("is true for the exact same directory even outside any git repo", () => {
    const sandbox = mkTempDir("pi-sametrust-sandbox-");
    try {
      // No .git anywhere — sharesGitRoot alone would be false here.
      assert.equal(isSameTrustedProject(sandbox, sandbox), true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("is true for another directory in the same git repo", () => {
    const sandbox = mkTempDir("pi-sametrust-sandbox-");
    try {
      const repoRoot = join(sandbox, "repo");
      const nested = join(repoRoot, "packages", "app");
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      mkdirSync(nested, { recursive: true });

      assert.equal(isSameTrustedProject(repoRoot, nested), true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("is false for a different directory with no git repo at all", () => {
    const sandbox = mkTempDir("pi-sametrust-sandbox-");
    try {
      const a = join(sandbox, "a");
      const b = join(sandbox, "b");
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });

      assert.equal(isSameTrustedProject(a, b), false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("is true for a nested working_dir inside a trusted project with no git repo at all", () => {
    const sandbox = mkTempDir("pi-sametrust-nogit-nested-sandbox-");
    try {
      const projectRoot = join(sandbox, "project");
      const nested = join(projectRoot, "src", "nested");
      mkdirSync(nested, { recursive: true });

      assert.equal(isSameTrustedProject(projectRoot, nested), true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("is true for a nested directory whose name merely starts with two dots", () => {
    const sandbox = mkTempDir("pi-sametrust-dotdot-name-sandbox-");
    try {
      const projectRoot = join(sandbox, "project");
      // A real, legitimate directory name — not the ".." parent-traversal
      // token — but path.relative() returns it bare ("..cache"), which a
      // naive `startsWith("..")` check would wrongly treat as an escape.
      const dotDotNamed = join(projectRoot, "..cache");
      mkdirSync(dotDotNamed, { recursive: true });

      assert.equal(isSameTrustedProject(projectRoot, dotDotNamed), true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("is false for a nested working_dir that has its own distinct git repo", () => {
    const sandbox = mkTempDir("pi-sametrust-submodule-sandbox-");
    try {
      const projectRoot = join(sandbox, "project");
      const submodule = join(projectRoot, "vendor", "lib");
      // projectRoot itself has no .git, but the nested directory does — a
      // distinct repo must not silently inherit the outer directory's trust.
      mkdirSync(join(submodule, ".git"), { recursive: true });

      assert.equal(isSameTrustedProject(projectRoot, submodule), false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("is false for a working_dir symlink that escapes the repo", () => {
    const sandbox = mkTempDir("pi-sametrust-symlink-sandbox-");
    try {
      const repoRoot = join(sandbox, "repo");
      mkdirSync(join(repoRoot, ".git"), { recursive: true });

      const outside = join(sandbox, "outside");
      mkdirSync(outside, { recursive: true });

      const link = join(repoRoot, "escape-hatch");
      symlinkSync(outside, link);

      assert.equal(isSameTrustedProject(repoRoot, link), false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
