import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => {
    if (ctx.mode !== "tui") return;

    const current = ctx.ui.theme?.name;
    const usingDefault = !current || current === "dark" || current === "light";
    const hasGithubTheme = ctx.ui.getAllThemes().some((t) => t.name === "github-dark-default");
    if (usingDefault && hasGithubTheme) {
      ctx.ui.setTheme("github-dark-default");
    }
  });
}
