import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createManagerHost, modelLabel } from "./host.ts";
import { WaitAbortedError } from "./time.ts";

type Handler = (...args: unknown[]) => Promise<unknown>;
type Sent = { message: Record<string, unknown>; options: Record<string, unknown> };

function makePi() {
  const handlers = new Map<string, Handler>();
  const sent: Sent[] = [];
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    sendMessage: (message: Sent["message"], options: Sent["options"]) =>
      sent.push({ message, options }),
  } as unknown as ExtensionAPI;
  return { pi, handlers, sent };
}

function makeCtx(
  widgets: Map<string, unknown>,
  options?: { isIdle?: () => boolean; hasUI?: boolean },
) {
  return {
    hasUI: options?.hasUI ?? true,
    isIdle: options?.isIdle ?? (() => true),
    ui: {
      setWidget: (id: string, value: unknown) => widgets.set(id, value),
    },
  } as unknown as ExtensionContext;
}

type TestSnap = { id: string; label: string; quiet?: boolean };

function makeHost(overrides?: { getRunning?: () => number | undefined; dispose?: () => Promise<void> }) {
  const { pi, handlers, sent } = makePi();
  const host = createManagerHost<TestSnap>(pi, {
    widgetId: "test-widget",
    customType: "test-result",
    runningLabel: (n) => `${n} running`,
    completion: (snap) => ({
      content: `done: ${snap.label}`,
      details: { id: snap.id },
      ...(snap.quiet ? { triggerTurn: false } : {}),
    }),
    getRunning: overrides?.getRunning ?? (() => undefined),
    dispose: overrides?.dispose ?? (async () => {}),
  });
  return { host, handlers, sent };
}

describe("createManagerHost", () => {
  it("delivers async completion once and skips consumed settles", async () => {
    const { host, handlers, sent } = makeHost();
    await handlers.get("session_start")!({}, makeCtx(new Map()));

    host.onSettled({ snapshot: { id: "x-1", label: "first" }, consumed: false });
    host.onSettled({ snapshot: { id: "x-2", label: "second" }, consumed: true });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.message.customType, "test-result");
    assert.equal(sent[0]!.message.content, "done: first");
    assert.deepEqual(sent[0]!.message.details, { id: "x-1" });
    assert.deepEqual(sent[0]!.options, { deliverAs: "followUp", triggerTurn: true });
  });

  it("sends a quiet completion immediately while the agent is idle", async () => {
    const { host, handlers, sent } = makeHost();
    await handlers.get("session_start")!({}, makeCtx(new Map()));

    host.onSettled({ snapshot: { id: "q-1", label: "answer", quiet: true }, consumed: false });

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.options, { deliverAs: "followUp", triggerTurn: false });
  });

  it("holds quiet completions while the agent streams and flushes on settle", async () => {
    const { host, handlers, sent } = makeHost();
    await handlers.get("session_start")!({}, makeCtx(new Map()));

    // While streaming, a followUp would be drained straight into the next
    // model prompt regardless of triggerTurn — quiet messages must wait.
    await handlers.get("agent_start")!({});
    host.onSettled({ snapshot: { id: "q-1", label: "answer", quiet: true }, consumed: false });
    host.onSettled({ snapshot: { id: "t-1", label: "loud" }, consumed: false });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.message.content, "done: loud");
    assert.deepEqual(sent[0]!.options, { deliverAs: "followUp", triggerTurn: true });

    await handlers.get("agent_settled")!({});
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.message.content, "done: answer");
    assert.deepEqual(sent[1]!.options, { deliverAs: "followUp", triggerTurn: false });
  });

  it("preserves the run-startup guard when no UI is available", async () => {
    const { host, handlers, sent } = makeHost({ getRunning: () => 1 });
    await handlers.get("session_start")!(
      {},
      makeCtx(new Map(), { hasUI: false, isIdle: () => false }),
    );
    host.updateWidget();

    host.onSettled({ snapshot: { id: "q-1", label: "answer", quiet: true }, consumed: false });
    assert.equal(sent.length, 0);

    await handlers.get("agent_settled")!({});
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.options, { deliverAs: "followUp", triggerTurn: false });
  });

  it("holds quiet completions in the run-startup window before agent_start fires", async () => {
    // The session's run flag flips before extension agent_start handlers run;
    // ctx.isIdle() reads that flag, so the hold must consult it too.
    const { host, handlers, sent } = makeHost();
    await handlers.get("session_start")!({}, makeCtx(new Map(), { isIdle: () => false }));

    host.onSettled({ snapshot: { id: "q-1", label: "answer", quiet: true }, consumed: false });
    assert.equal(sent.length, 0);

    await handlers.get("agent_settled")!({});
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.options, { deliverAs: "followUp", triggerTurn: false });
  });

  it("resets streaming state when a new session starts", async () => {
    const { host, handlers, sent } = makeHost();
    const widgets = new Map<string, unknown>();
    await handlers.get("session_start")!({}, makeCtx(widgets));
    await handlers.get("agent_start")!({});
    await handlers.get("session_shutdown")!({});

    await handlers.get("session_start")!({}, makeCtx(widgets));
    host.onSettled({ snapshot: { id: "q-1", label: "answer", quiet: true }, consumed: false });

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.options, { deliverAs: "followUp", triggerTurn: false });
  });

  it("drops held quiet completions at shutdown", async () => {
    const { host, handlers, sent } = makeHost();
    await handlers.get("session_start")!({}, makeCtx(new Map()));

    await handlers.get("agent_start")!({});
    host.onSettled({ snapshot: { id: "q-1", label: "answer", quiet: true }, consumed: false });
    await handlers.get("session_shutdown")!({});
    await handlers.get("agent_settled")!({});

    assert.equal(sent.length, 0);
  });

  it("shutdown disposes the manager, clears the widget, and drops late settles", async () => {
    let disposeCalls = 0;
    const widgets = new Map<string, unknown>();
    const { host, handlers, sent } = makeHost({
      getRunning: () => 2,
      dispose: async () => {
        disposeCalls += 1;
      },
    });
    await handlers.get("session_start")!({}, makeCtx(widgets));

    host.updateWidget();
    assert.deepEqual(widgets.get("test-widget"), ["2 running"]);

    await handlers.get("session_shutdown")!({});
    assert.equal(disposeCalls, 1);
    assert.equal(host.disposed, true);
    assert.equal(widgets.get("test-widget"), undefined);

    host.onSettled({ snapshot: { id: "late", label: "late" }, consumed: false });
    assert.equal(sent.length, 0);

    await handlers.get("session_start")!({}, makeCtx(widgets));
    assert.equal(host.disposed, false);
    host.onSettled({ snapshot: { id: "x-3", label: "third" }, consumed: false });
    assert.equal(sent.length, 1);
  });

  it("clears the widget at zero running and skips updates before the manager exists", async () => {
    const widgets = new Map<string, unknown>();
    let running: number | undefined;
    const { host, handlers } = makeHost({ getRunning: () => running });
    await handlers.get("session_start")!({}, makeCtx(widgets));

    host.updateWidget();
    assert.equal(widgets.has("test-widget"), false);

    running = 1;
    host.updateWidget();
    assert.deepEqual(widgets.get("test-widget"), ["1 running"]);

    running = 0;
    host.updateWidget();
    assert.equal(widgets.get("test-widget"), undefined);
  });

  it("consumeIfWaitAborted updates the widget only for wait-abort errors", async () => {
    const widgets = new Map<string, unknown>();
    const { host, handlers } = makeHost({ getRunning: () => 3 });
    await handlers.get("session_start")!({}, makeCtx(widgets));

    host.consumeIfWaitAborted(new Error("boom"), ["x-1"]);
    assert.equal(widgets.has("test-widget"), false);

    host.consumeIfWaitAborted(
      new WaitAbortedError("Cancel wait aborted; termination continues."),
      ["x-1"],
    );
    assert.deepEqual(widgets.get("test-widget"), ["3 running"]);
  });
});

describe("modelLabel", () => {
  it("formats provider/id and tolerates a missing model", () => {
    assert.equal(
      modelLabel({ model: { provider: "anthropic", id: "claude-x" } } as ExtensionContext),
      "anthropic/claude-x",
    );
    assert.equal(modelLabel({ model: undefined } as ExtensionContext), undefined);
  });
});
