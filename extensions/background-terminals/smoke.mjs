/**
 * Integration smoke for background-terminals core lifecycle.
 * Run: node --experimental-strip-types extensions/background-terminals/smoke.mjs
 */
import assert from "node:assert/strict";
import { access, readFile, readdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const managerUrl = pathToFileURL(new URL("./manager.ts", import.meta.url).pathname).href;
const formatUrl = pathToFileURL(new URL("./format.ts", import.meta.url).pathname).href;
const deliveryUrl = pathToFileURL(new URL("./delivery.ts", import.meta.url).pathname).href;

const { TerminalManager } = await import(managerUrl);
const {
  buildStartResult,
  buildStatusResult,
  buildListResult,
  buildKillResult,
  buildTerminalResultMessage,
} = await import(formatUrl);
const { ResultDelivery } = await import(deliveryUrl);

const log = (step, ok, detail = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${step}${detail ? ` — ${detail}` : ""}`);
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  return undefined;
}

async function main() {
  let failed = 0;
  const check = (step, cond, detail) => {
    if (!cond) failed++;
    log(step, !!cond, detail);
  };

  // --- 0. Standalone HTTP server; background terminal curls it and stays alive ---
  // (Avoids shell-quoting hell around nested node -e scripts.)
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const settled = [];
  const sessionKey = `smoke-${Date.now()}`;
  const m = new TerminalManager({
    sessionKey,
    killGraceMs: 1000,
    onSettled: (info) => settled.push(info),
  });

  // Long-lived: print READY, probe HTTP once, then sleep forever.
  const cmd = `printf 'READY\\n'; curl -fsS http://127.0.0.1:${port}/; printf '\\nHTTP_OK\\n'; sleep 120`;

  const snap = await m.start({
    command: cmd,
    title: "smoke-dev-server",
    cwd: process.cwd(),
  });
  check("start returns running", snap.status === "running", `id=${snap.id} pid=${snap.pid}`);
  check("start result text", buildStartResult(snap).includes(snap.id));

  const ready = await waitUntil(() => {
    const cur = m.get(snap.id);
    if (cur?.stdout.text.includes("HTTP_OK")) return cur;
    if (cur?.status !== "running") return cur; // settled early = failure path
    return undefined;
  });

  check(
    "background process printed READY + HTTP_OK",
    !!ready && ready.stdout.text.includes("READY") && ready.stdout.text.includes("HTTP_OK"),
    ready ? JSON.stringify(ready.stdout.text).slice(0, 120) : "timeout",
  );
  check("still running after probe", m.get(snap.id)?.status === "running");

  // Direct HTTP still works (server owned by this smoke process)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    check("HTTP server still up", (await res.text()) === "ok");
  } catch (e) {
    check("HTTP server still up", false, String(e));
  }

  const statusText = buildStatusResult(m.get(snap.id));
  check("status shows running + stdout", statusText.includes("running") && statusText.includes("READY"));

  const listText = buildListResult(m.list());
  check("list includes terminal", listText.includes(snap.id) && listText.includes("smoke-dev-server"));

  const spillDir = join(tmpdir(), "pi-background-terminals", sessionKey);
  try {
    await access(spillDir);
    const files = await readdir(spillDir);
    check("spill directory has log files", files.some((f) => f.endsWith(".stdout.log")), files.join(","));
    const out = await readFile(join(spillDir, `${snap.id}.stdout.log`), "utf8");
    check("spill contains READY", out.includes("READY"));
  } catch (e) {
    check("spill directory exists", false, String(e));
  }

  const killResults = await m.kill([snap.id]);
  check("kill settles as killed", killResults[0]?.snapshot.status === "killed", killResults[0]?.snapshot.status);
  check("kill result text", buildKillResult(killResults).includes("Killed"));
  check("onSettled consumed=true", settled.length === 1 && settled[0].consumed === true);

  // Process gone
  let alive = true;
  try {
    process.kill(snap.pid, 0);
  } catch {
    alive = false;
  }
  check("pid reaped after kill", !alive, `pid=${snap.pid}`);

  server.close();

  // --- 1. Natural exit + delivery queue ---
  const delivery = new ResultDelivery();
  const m2 = new TerminalManager({
    sessionKey: `${sessionKey}-b`,
    onSettled: ({ snapshot, consumed }) => {
      if (!consumed) delivery.enqueue(snapshot.id, snapshot);
    },
  });

  const short = await m2.start({
    command: "printf 'done-work\\n'; exit 0",
    title: "short-job",
    cwd: process.cwd(),
  });
  await waitUntil(() => {
    const s = m2.get(short.id);
    return s && s.status !== "running" ? s : undefined;
  });
  const finished = m2.get(short.id);
  check("short job done", finished?.status === "done", finished?.status);
  check("unconsumed settle queued", delivery.take(short.id)?.status === "done");
  check("completion message builds", buildTerminalResultMessage(finished).includes("exited"));

  // --- 2. Failed exit ---
  const fail = await m2.start({
    command: "exit 42",
    title: "fail-job",
    cwd: process.cwd(),
  });
  await waitUntil(() => {
    const s = m2.get(fail.id);
    return s && s.status !== "running" ? s : undefined;
  });
  check(
    "fail job status=failed exit 42",
    m2.get(fail.id)?.status === "failed" && m2.get(fail.id)?.exitCode === 42,
  );

  // --- 3. Process group kill (child of shell) ---
  const m3 = new TerminalManager({ sessionKey: `${sessionKey}-c`, killGraceMs: 1500 });
  // Spawn a shell that spawns a sleeper grandchild; killing the group should reap both.
  const sleeper = await m3.start({
    command: "sleep 120",
    title: "sleeper",
    cwd: process.cwd(),
  });
  const pid = sleeper.pid;
  await m3.disposeAll();
  let sleeperAlive = true;
  try {
    process.kill(pid, 0);
  } catch {
    sleeperAlive = false;
  }
  check("disposeAll reaps sleeper", !sleeperAlive, `pid=${pid}`);

  // --- 4. Concurrency limit ---
  const m4 = new TerminalManager({ sessionKey: `${sessionKey}-d`, maxRunning: 1 });
  await m4.start({ command: "sleep 30", title: "one", cwd: process.cwd() });
  let threw = false;
  try {
    await m4.start({ command: "sleep 30", title: "two", cwd: process.cwd() });
  } catch (e) {
    threw = /Concurrency limit/.test(String(e));
  }
  check("concurrency limit enforced", threw);
  await m4.disposeAll();

  await m.disposeAll();
  await m2.disposeAll();

  // --- 5. Pi RPC: extension loads, /ps command registered ---
  const rpc = await runPiRpcProbe();
  check("pi RPC loads extension", rpc.ok, rpc.detail);
  check("pi RPC registers /ps command", rpc.hasPs, rpc.commandsPreview);

  console.log("");
  if (failed === 0) {
    console.log("SMOKE OK — lifecycle + Pi load checks passed.");
    process.exit(0);
  }
  console.log(`SMOKE FAILED — ${failed} check(s) failed.`);
  process.exit(1);
}

function runPiRpcProbe() {
  return new Promise((resolve) => {
    const child = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "-e",
        "./extensions/background-terminals/index.ts",
        "--offline",
      ],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });

    child.stdin.write(JSON.stringify({ id: "1", type: "get_commands" }) + "\n");
    child.stdin.write(JSON.stringify({ id: "2", type: "get_state" }) + "\n");

    setTimeout(() => {
      child.kill("SIGTERM");
    }, 2500);

    child.on("close", () => {
      let hasPs = false;
      let ok = false;
      let commandsPreview = "";
      try {
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.id === "1" && msg.success) {
            ok = true;
            const names = (msg.data?.commands ?? []).map((c) => c.name);
            hasPs = names.includes("ps");
            commandsPreview = names.filter((n) => n === "ps" || n.startsWith("bg")).join(",") || names.slice(0, 5).join(",");
          }
        }
      } catch (e) {
        resolve({ ok: false, hasPs: false, detail: `parse error: ${e}; stderr=${stderr.slice(0, 200)}` });
        return;
      }
      resolve({
        ok,
        hasPs,
        detail: ok ? "get_commands ok" : `no response; stderr=${stderr.slice(0, 200)} stdout=${stdout.slice(0, 200)}`,
        commandsPreview,
      });
    });
  });
}

// silence unused if imports tree-shaken oddly
void assert;
void writeFile;
void mkdtemp;
void rm;
void spawn;

main().catch((err) => {
  console.error("SMOKE ERROR", err);
  process.exit(1);
});
