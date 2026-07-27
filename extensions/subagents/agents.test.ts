import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { discoverAgents, findGitRoot, sharesGitRoot } from "./agents.ts";

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

  it("ignores a non-string tools field instead of throwing", () => {
    writeAgent(
      join(agentDir, "agents"),
      "list-tools.md",
      ["---", "name: listy", "description: tools as a YAML list", "tools:", "  - read", "  - grep", "---", "Body."].join(
        "\n",
      ),
    );

    const { agents } = discoverAgents(cwd, false, agentDir);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].tools, undefined);
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
