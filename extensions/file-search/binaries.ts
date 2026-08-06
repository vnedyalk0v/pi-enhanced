import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type BinaryName = "fd" | "rg";

/** Package-manager hints for the "not installed" error, per binary. */
const INSTALL_HINTS: Record<BinaryName, string> = {
  fd: "brew install fd, apt install fd-find, or see https://github.com/sharkdp/fd",
  rg: "brew install ripgrep, apt install ripgrep, or see https://github.com/BurntSushi/ripgrep",
};

export function fallbackBinDir(agentDir = getAgentDir()): string {
  return join(agentDir, "bin");
}

export function candidateNames(name: BinaryName): string[] {
  if (name === "fd" && process.platform === "linux") return ["fd", "fdfind"];
  return [name];
}

export function locatorCommand(platform = process.platform): "where.exe" | "which" {
  return platform === "win32" ? "where.exe" : "which";
}

export function firstLocatorResult(output: string): string | null {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
}

type RunLocator = (
  locator: string,
  command: string,
) => Promise<{ code: number | null; output: string }>;

async function runLocator(locator: string, command: string) {
  return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(locator, [command], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output: out }));
  });
}

export async function which(
  command: string,
  platform = process.platform,
  locate: RunLocator = runLocator,
): Promise<string | null> {
  try {
    const result = await locate(locatorCommand(platform), command);
    return result.code === 0 ? firstLocatorResult(result.output) : null;
  } catch {
    return null;
  }
}

/**
 * Locate fd/rg on PATH, falling back to the Pi bin directory so binaries
 * installed by earlier versions of this package keep working.
 */
export async function resolveExisting(
  name: BinaryName,
  agentDir = getAgentDir(),
): Promise<string | null> {
  for (const candidate of candidateNames(name)) {
    const fromPath = await which(candidate);
    if (fromPath) return fromPath;
  }
  const local = join(fallbackBinDir(agentDir), name);
  if (existsSync(local)) return local;
  return null;
}

/** Resolved path, or a clear install instruction. */
export async function resolveBinary(
  name: BinaryName,
  agentDir = getAgentDir(),
): Promise<string> {
  const existing = await resolveExisting(name, agentDir);
  if (existing) return existing;
  throw new Error(
    `${name} was not found on PATH. Install it (${INSTALL_HINTS[name]}) and restart Pi.`,
  );
}
