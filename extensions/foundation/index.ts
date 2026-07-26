import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pi-enhanced", {
    description: "Verify that pi-enhanced loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("pi-enhanced loaded", "info");
    },
  });
}
