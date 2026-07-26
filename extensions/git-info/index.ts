import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

type GitSnapshot = {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
};

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 256 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export function parseGitStatus(status: string): GitSnapshot {
  let branch: string | null = null;
  let oid: string | null = null;
  let dirty = false;
  let ahead = 0;
  let behind = 0;

  for (const line of status.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length);
      branch = head === "(detached)" ? null : head || null;
    } else if (line.startsWith("# branch.oid ")) {
      oid = line.slice("# branch.oid ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const [, aheadStr, behindStr] = line.match(/^# branch\.ab \+(\d+) -(\d+)$/) ?? [];
      ahead = Number(aheadStr) || 0;
      behind = Number(behindStr) || 0;
    } else if (line && !line.startsWith("# ")) {
      dirty = true;
    }
  }

  if (!branch && oid && !oid.startsWith("(")) branch = oid.slice(0, 7) || "detached";
  return { branch: branch ?? "detached", dirty, ahead, behind };
}

async function readGit(cwd: string): Promise<GitSnapshot | null> {
  const status = await runGit(cwd, ["status", "--porcelain=v2", "--branch"]);
  return status === null ? null : parseGitStatus(status);
}

function formatStatus(snap: GitSnapshot, theme: ExtensionContext["ui"]["theme"]): string {
  const branch = snap.branch ?? "?";
  let text = theme.fg("accent", branch);
  if (snap.dirty) text += theme.fg("warning", "*");
  if (snap.ahead > 0) text += theme.fg("success", ` ↑${snap.ahead}`);
  if (snap.behind > 0) text += theme.fg("error", ` ↓${snap.behind}`);
  return text;
}

export default function (pi: ExtensionAPI) {
  const refresh = async (ctx: ExtensionContext) => {
    // Never capture ctx across awaits that outlive the event; print/rpc teardown
    // marks ctx stale and throws on property access.
    try {
      if (!ctx.hasUI) return;
      const cwd = ctx.cwd;
      const theme = ctx.ui.theme;
      const snap = await readGit(cwd);
      if (!snap) {
        ctx.ui.setStatus("git", undefined);
        return;
      }
      ctx.ui.setStatus("git", formatStatus(snap, theme));
    } catch {
      // Ignore stale-ctx / shutdown races.
    }
  };

  pi.on("session_start", async (_e, ctx) => {
    await refresh(ctx);
  });
  pi.on("agent_settled", async (_e, ctx) => {
    await refresh(ctx);
  });

  pi.registerCommand("git-info", {
    description: "Refresh git branch/dirty status in the footer",
    handler: async (_args, ctx) => {
      await refresh(ctx);
      if (ctx.hasUI) ctx.ui.notify("Git status refreshed", "info");
    },
  });
}
