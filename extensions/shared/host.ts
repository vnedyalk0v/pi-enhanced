import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ResultDelivery } from "./delivery.ts";
import { WaitAbortedError } from "./time.ts";
import { withUI } from "./ui.ts";

export type ManagerHostOptions<S extends { id: string }> = {
  widgetId: string;
  /** customType for async completion messages. */
  customType: string;
  runningLabel: (running: number) => string;
  completion: (snapshot: S) => {
    content: string;
    details: Record<string, unknown>;
    /** Default true; false delivers to the transcript without starting a model turn. */
    triggerTurn?: boolean;
  };
  /** Running-job count, or undefined until the manager exists. */
  getRunning: () => number | undefined;
  /** Dispose the manager at session shutdown; host clears widget and delivery first. */
  dispose: () => Promise<void>;
};

/**
 * Shared session plumbing for the job-manager extensions (background
 * terminals, subagents, workflows): running-count footer widget, deferred
 * async completion delivery, and session start/shutdown lifecycle. The host
 * is the sole registrant of session_start/session_shutdown for its extension.
 */
export function createManagerHost<S extends { id: string }>(
  pi: ExtensionAPI,
  options: ManagerHostOptions<S>,
) {
  let sessionCtx: ExtensionContext | undefined;
  let uiCtx: ExtensionContext | undefined;
  let disposed = false;
  let agentActive = false;
  /** Non-turn-triggering completions held while the agent is streaming. */
  const heldWhileStreaming: Array<{
    content: string;
    details: Record<string, unknown>;
  }> = [];
  const delivery = new ResultDelivery<S>();

  const updateWidget = () => {
    const running = options.getRunning();
    if (running === undefined) return;
    const ok = withUI(uiCtx, (ctx) => {
      ctx.ui.setWidget(
        options.widgetId,
        running === 0 ? undefined : [options.runningLabel(running)],
      );
    });
    if (!ok) uiCtx = undefined;
  };

  // The agent_start event flag alone leaves a gap: the run flag flips before
  // extension agent_start handlers fire, so also consult ctx.isIdle(), which
  // reads the same flag sendMessage's streaming branch checks. Stale ctx
  // throws on access; treat that as idle (the event flag is the fallback).
  const agentStreaming = () => {
    if (agentActive) return true;
    try {
      return sessionCtx ? !sessionCtx.isIdle() : false;
    } catch {
      return false;
    }
  };

  const sendQuiet = (message: { content: string; details: Record<string, unknown> }) => {
    pi.sendMessage(
      { customType: options.customType, content: message.content, display: true, details: message.details },
      { deliverAs: "followUp", triggerTurn: false },
    );
  };

  const flushDelivery = () => {
    if (disposed) {
      delivery.clear();
      return;
    }
    for (const { value } of delivery.drainAll()) {
      const { content, details, triggerTurn } = options.completion(value);
      if (triggerTurn === false) {
        // While the agent is streaming, a followUp is drained straight into the
        // next model prompt regardless of triggerTurn — hold quiet messages
        // until the agent settles so they never start or steer a turn.
        if (agentStreaming()) heldWhileStreaming.push({ content, details });
        else sendQuiet({ content, details });
        continue;
      }
      pi.sendMessage(
        { customType: options.customType, content, display: true, details },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    agentActive = false;
    sessionCtx = ctx;
    uiCtx = ctx;
  });

  pi.on("agent_start", async () => {
    agentActive = true;
  });

  pi.on("agent_settled", async () => {
    agentActive = false;
    if (disposed) {
      heldWhileStreaming.length = 0;
      return;
    }
    while (heldWhileStreaming.length > 0) {
      sendQuiet(heldWhileStreaming.shift()!);
    }
  });

  pi.on("session_shutdown", async () => {
    disposed = true;
    delivery.clear();
    heldWhileStreaming.length = 0;
    withUI(uiCtx, (ctx) => ctx.ui.setWidget(options.widgetId, undefined));
    sessionCtx = undefined;
    uiCtx = undefined;
    await options.dispose();
  });

  return {
    get disposed() {
      return disposed;
    },
    delivery,
    updateWidget,
    /** Manager onSettled callback: queue async completion unless already consumed. */
    onSettled({ snapshot, consumed }: { snapshot: S; consumed: boolean }) {
      if (disposed || consumed) return;
      delivery.enqueue(snapshot.id, snapshot);
      flushDelivery();
    },
    /**
     * An aborted wait leaves termination running in the background; mark ids
     * consumed so the eventual settle does not double-notify. Callers rethrow.
     */
    consumeIfWaitAborted(error: unknown, ids: readonly string[]) {
      if (error instanceof WaitAbortedError) {
        delivery.consume(ids);
        updateWidget();
      }
    },
  };
}

/** Parent session's model as a provider/id label for child spawn defaults. */
export function modelLabel(ctx: ExtensionContext) {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}
