import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Pi invalidates a captured ctx after session replacement or reload; every
 * property access then throws, so `ctx?.hasUI` is not a sufficient guard.
 */
export function isUsable(ctx: ExtensionContext | undefined) {
  if (!ctx) return false;
  try {
    return ctx.hasUI;
  } catch {
    return false;
  }
}

/** Run a UI side effect, swallowing a stale-ctx throw. Returns false if it did not run. */
export function withUI(ctx: ExtensionContext | undefined, fn: (ctx: ExtensionContext) => void) {
  if (!isUsable(ctx)) return false;
  try {
    fn(ctx!);
    return true;
  } catch {
    return false;
  }
}
