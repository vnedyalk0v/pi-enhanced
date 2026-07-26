import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const expected = new Set([
  "copy-all",
  "summary",
  "ps",
  "btw",
  "workflow",
  "skill:subagents",
  "skill:background-terminals",
  "skill:web-research",
  "skill:workflows",
]);
const root = await mkdtemp(join(tmpdir(), "pi-enhanced-package-smoke-"));
let child;

try {
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  await Promise.all(["fd", "rg"].map(async (name) => {
    const path = join(binDir, name);
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
  }));

  const env = {
    ...process.env,
    HOME: root,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  };
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|TOKEN)$/.test(key)) delete env[key];
  }

  const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
  child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--offline", "--approve", "--session-dir", join(root, "sessions"), "-e", "./"], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Package smoke timed out")), 10_000);
    let buffer = "";
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.on("error", fail);
    child.on("close", (code) => {
      fail(new Error(`Pi exited before get_commands (${code}): ${stderr.trim()}`));
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const end = buffer.indexOf("\n");
        if (end === -1) return;
        let line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          fail(new Error(`Malformed RPC JSON: ${line}`));
          return;
        }
        if (message.type === "extension_error") {
          fail(new Error(`Extension error: ${message.extensionPath}: ${message.error}`));
          return;
        }
        if (message.id === "smoke" && message.command === "get_commands") {
          if (!message.success) {
            fail(new Error(`get_commands failed: ${JSON.stringify(message)}`));
            return;
          }
          const commands = new Set(message.data?.commands?.map((command) => command.name));
          const missing = [...expected].filter((name) => !commands.has(name));
          if (missing.length > 0) {
            fail(new Error(`Missing package resources: ${missing.join(", ")}`));
            return;
          }
          clearTimeout(timeout);
          resolve();
        }
      }
    });
    child.stdin.end('{"id":"smoke","type":"get_commands"}\n');
  });
} finally {
  child?.kill();
  await rm(root, { recursive: true, force: true });
}
