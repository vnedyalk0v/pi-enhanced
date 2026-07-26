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

async function readGit(cwd: string): Promise<GitSnapshot | null> {
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return null;

  const branch =
    (await runGit(cwd, ["branch", "--show-current"])) ||
    (await runGit(cwd, ["rev-parse", "--short", "HEAD"])) ||
    "detached";

  const status = (await runGit(cwd, ["status", "--porcelain"])) ?? "";
  const dirty = status.length > 0;

  let ahead = 0;
  let behind = 0;
  const counts = await runGit(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  if (counts) {
    const [behindStr, aheadStr] = counts.split(/\s+/);
    behind = Number(behindStr) || 0;
    ahead = Number(aheadStr) || 0;
  }

  return { branch, dirty, ahead, behind };
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
  pi.on("turn_end", async (_e, ctx) => {
    await refresh(ctx);
  });
  pi.on("agent_end", async (_e, ctx) => {
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
