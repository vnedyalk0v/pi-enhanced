import { spawn } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type BinaryName = "fd" | "rg";

export type PlatformTarget = {
  os: "darwin" | "linux";
  arch: "x64" | "arm64";
};

const FD_VERSION = "10.2.1";
const RG_VERSION = "14.1.1";

export function detectPlatform(
  platform = process.platform,
  arch = process.arch,
): PlatformTarget | null {
  if (platform !== "darwin" && platform !== "linux") return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  return { os: platform, arch };
}

export function fallbackBinDir(agentDir = getAgentDir()): string {
  return join(agentDir, "bin");
}

export function candidateNames(name: BinaryName): string[] {
  if (name === "fd" && process.platform === "linux") return ["fd", "fdfind"];
  return [name];
}

export async function which(command: string): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn("which", [command], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      const path = out.trim().split("\n")[0];
      resolve(code === 0 && path ? path : null);
    });
  });
}

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

function rustTriple(target: PlatformTarget): string {
  const arch = target.arch === "x64" ? "x86_64" : "aarch64";
  if (target.os === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

export function releaseUrl(name: BinaryName, target: PlatformTarget): string {
  const triple = rustTriple(target);
  if (name === "fd") {
    return `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-${triple}.tar.gz`;
  }
  return `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${triple}.tar.gz`;
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": "pi-enhanced-file-search" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  await pipeline(nodeStream, createWriteStream(dest));
}

function findNamedFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findNamedFile(full, name);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === name) {
      return full;
    }
  }
  return null;
}

async function extractBinary(
  archivePath: string,
  binaryName: BinaryName,
  destPath: string,
): Promise<void> {
  const extractDir = await mkdtemp(join(tmpdir(), `pi-${binaryName}-`));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("tar", ["-xzf", archivePath, "-C", extractDir], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (c: Buffer) => {
        err += c.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar extract failed (${code}): ${err.trim() || archivePath}`));
      });
    });

    const found = findNamedFile(extractDir, binaryName);
    if (!found) throw new Error(`Binary ${binaryName} not found in archive`);
    if (!statSync(found).isFile()) throw new Error(`Expected file at ${found}`);
    renameSync(found, destPath);
    chmodSync(destPath, 0o755);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

export async function ensureBinary(
  name: BinaryName,
  options?: { agentDir?: string; platform?: PlatformTarget | null },
): Promise<{ path: string; installed: boolean }> {
  const agentDir = options?.agentDir ?? getAgentDir();
  const existing = await resolveExisting(name, agentDir);
  if (existing) return { path: existing, installed: false };

  const target = options?.platform === undefined ? detectPlatform() : options.platform;
  if (!target) {
    throw new Error(
      `${name} not found and platform ${process.platform}/${process.arch} is unsupported for auto-install. Install ${name} with your package manager.`,
    );
  }

  const binDir = fallbackBinDir(agentDir);
  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, name);
  const archive = join(binDir, `${name}-download.tar.gz`);
  const url = releaseUrl(name, target);

  await downloadToFile(url, archive);
  try {
    await extractBinary(archive, name, dest);
  } finally {
    rmSync(archive, { force: true });
  }

  if (!existsSync(dest)) {
    throw new Error(`Failed to install ${name} to ${dest}`);
  }
  return { path: dest, installed: true };
}
