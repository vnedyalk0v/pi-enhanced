import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function render(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  if (!model) return undefined;

  const theme = ctx.ui.theme;
  const id = `${model.provider}/${model.id}`;
  let text = theme.fg("accent", id);

  if (ctx.thinkingLevel) {
    text += theme.fg("dim", ` · ${ctx.thinkingLevel}`);
  }

  const usage = ctx.getContextUsage();
  if (usage) {
    if (usage.percent != null) {
      const pct = Math.round(usage.percent);
      const color = pct >= 85 ? "error" : pct >= 70 ? "warning" : "dim";
      text += theme.fg(color, ` · ${pct}%`);
    } else if (usage.tokens != null) {
      text += theme.fg("dim", ` · ${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`);
    }
  }

  return text;
}

function update(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("model", render(ctx));
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => {
    update(ctx);
  });
  pi.on("model_select", async (_e, ctx) => {
    update(ctx);
  });
  pi.on("turn_end", async (_e, ctx) => {
    update(ctx);
  });
  pi.on("agent_end", async (_e, ctx) => {
    update(ctx);
  });

  pi.registerCommand("model-info", {
    description: "Refresh model/context status in the footer",
    handler: async (_args, ctx) => {
      update(ctx);
      if (ctx.hasUI) ctx.ui.notify("Model status refreshed", "info");
    },
  });
}
