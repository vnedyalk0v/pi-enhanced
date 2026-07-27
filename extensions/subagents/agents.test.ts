import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";

let agentDir: string;
let cwd: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-agentdir-"));
  cwd = mkdtempSync(join(tmpdir(), "pi-subagent-cwd-"));
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
    const sandbox = mkdtempSync(join(tmpdir(), "pi-subagent-sandbox-"));
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
