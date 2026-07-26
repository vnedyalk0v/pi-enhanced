import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { extractConversationText } from "../shared/text.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-all", {
    description: "Copy the full conversation branch to the clipboard",
    handler: async (_args, ctx) => {
      const text = extractConversationText(ctx.sessionManager.getBranch());
      if (!text.trim()) {
        if (ctx.hasUI) ctx.ui.notify("Nothing to copy", "warning");
        return;
      }
      try {
        await copyToClipboard(text);
        if (ctx.hasUI) {
          const chars = text.length;
          ctx.ui.notify(`Copied conversation (${chars} chars)`, "info");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`Copy failed: ${message}`, "error");
      }
    },
  });
}
