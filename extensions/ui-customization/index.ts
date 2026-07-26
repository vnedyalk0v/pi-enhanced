import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { formatTokens } from "../shared/text.ts";

function shortPath(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) {
    const rest = cwd.slice(home.length);
    return rest ? `~${rest}` : "~";
  }
  return cwd;
}

function installFooter(ctx: ExtensionContext) {
  ctx.ui.setFooter((_tui, theme, footerData) => {
    return {
      invalidate() {},
      render(width: number): string[] {
        let input = 0;
        let output = 0;
        let cost = 0;
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            const msg = entry.message as AssistantMessage;
            if (msg.usage) {
              input += msg.usage.input ?? 0;
              output += msg.usage.output ?? 0;
              cost += msg.usage.cost?.total ?? 0;
            }
          }
        }

        const left = theme.fg(
          "dim",
          `↑${formatTokens(input)} ↓${formatTokens(output)} $${cost.toFixed(3)}`,
        );

        const statuses = [...footerData.getExtensionStatuses().values()].filter(Boolean);
        const mid = statuses.length > 0 ? theme.fg("dim", statuses.join("  ")) : "";

        // Branch/model live in extension statuses (git-info / model-info); right is cwd only.
        const cwdLabel = basename(ctx.cwd) || shortPath(ctx.cwd);
        const right = theme.fg("dim", cwdLabel);

        const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right));
        const leftGap = mid ? Math.floor(gap / 2) : gap;
        const rightGap = mid ? gap - leftGap : 0;
        const line =
          left +
          " ".repeat(leftGap) +
          mid +
          (mid ? " ".repeat(rightGap) : "") +
          right;
        return [truncateToWidth(line, width)];
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => {
    if (ctx.mode !== "tui") return;
    installFooter(ctx);

    // Prefer GitHub Dark Default when available and user has not set another custom theme path.
    const themes = ctx.ui.getAllThemes();
    const github = themes.find((t) => t.name === "github-dark-default");
    if (github) {
      // Only apply if current theme is a built-in default (dark/light).
      const current = ctx.ui.theme?.name;
      if (!current || current === "dark" || current === "light") {
        ctx.ui.setTheme("github-dark-default");
      }
    }
  });

  pi.registerCommand("footer-default", {
    description: "Restore the built-in Pi footer",
    handler: async (_args, ctx) => {
      ctx.ui.setFooter(undefined);
      if (ctx.hasUI) ctx.ui.notify("Default footer restored", "info");
    },
  });

  pi.registerCommand("footer-enhanced", {
    description: "Use the pi-enhanced footer (tokens, statuses, cwd/model)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Footer requires TUI mode", "error");
        return;
      }
      installFooter(ctx);
      if (ctx.hasUI) ctx.ui.notify("Enhanced footer enabled", "info");
    },
  });
}
