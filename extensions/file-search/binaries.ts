import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type BinaryName = "fd" | "rg";

export type PlatformTarget = {
  os: "darwin" | "linux";
  arch: "x64" | "arm64";
};

type TargetKey = `${PlatformTarget["os"]}-${PlatformTarget["arch"]}`;

const FD_VERSION = "10.2.0";
const RG_VERSION = "14.1.1";
const PUBLISH_LOCK_STALE_MS = 5_000;

const DIGESTS: Record<BinaryName, Record<TargetKey, string>> = {
  fd: {
    "darwin-arm64": "ae6327ba8c9a487cd63edd8bddd97da0207887a66d61e067dfe80c1430c5ae36",
    "darwin-x64": "991a648a58870230af9547c1ae33e72cb5c5199a622fe5e540e162d6dba82d48",
    "linux-arm64": "6de8be7a3d8ca27954a6d1e22bc327af4cf6fc7622791e68b820197f915c422b",
    "linux-x64": "5f9030bcb0e1d03818521ed2e3d74fdb046480a45a4418ccff4f070241b4ed25",
  },
  rg: {
    "darwin-arm64": "24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be",
    "darwin-x64": "fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3",
    "linux-arm64": "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f",
    "linux-x64": "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e",
  },
};

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

function rustTriple(name: BinaryName, target: PlatformTarget): string {
  const arch = target.arch === "x64" ? "x86_64" : "aarch64";
  if (target.os === "darwin") return `${arch}-apple-darwin`;
  if (name === "rg" && target.arch === "x64") return `${arch}-unknown-linux-musl`;
  return `${arch}-unknown-linux-gnu`;
}

export function releaseUrl(name: BinaryName, target: PlatformTarget): string {
  const triple = rustTriple(name, target);
  if (name === "fd") {
    return `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-${triple}.tar.gz`;
  }
  return `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${triple}.tar.gz`;
}

export function expectedDigest(
  name: BinaryName,
  target: { os: string; arch: string },
): string | null {
  const key = `${target.os}-${target.arch}`;
  return Object.hasOwn(DIGESTS[name], key) ? DIGESTS[name][key as TargetKey] : null;
}

export async function verifyArchive(
  archivePath: string,
  expected: string,
  label: string,
): Promise<void> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
  if (hash.digest("hex") !== expected) {
    throw new Error(`Digest mismatch for ${label}`);
  }
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
  attemptDir: string,
): Promise<string> {
  const extractDir = join(attemptDir, "extract");
  mkdirSync(extractDir);
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
  const prepared = join(attemptDir, binaryName);
  renameSync(found, prepared);
  chmodSync(prepared, 0o755);
  return prepared;
}

function isRegularExecutable(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function removeStaleLock(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || Date.now() - stat.mtimeMs < PUBLISH_LOCK_STALE_MS) return false;
    rmdirSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function publishPrepared(
  prepared: string,
  dest: string,
  linkPrepared = linkSync,
): Promise<boolean> {
  try {
    linkPrepared(prepared, dest);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      if (!isRegularExecutable(dest)) {
        throw new Error(`Refusing to replace invalid binary destination ${dest}`);
      }
      return false;
    }
    if (code !== "EPERM" && code !== "EOPNOTSUPP" && code !== "ENOTSUP") throw error;
  }

  const lockDir = `${dest}.install-lock`;
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isRegularExecutable(dest)) return false;
      if (removeStaleLock(lockDir)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to install ${dest}`);
      }
      await delay(10);
    }
  }

  try {
    if (existsSync(dest)) {
      if (!isRegularExecutable(dest)) {
        throw new Error(`Refusing to replace invalid binary destination ${dest}`);
      }
      return false;
    }
    renameSync(prepared, dest);
    return true;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export async function ensureBinary(
  name: BinaryName,
  options?: { agentDir?: string; platform?: PlatformTarget | null },
  dependencies: {
    resolveExisting: typeof resolveExisting;
    downloadToFile: typeof downloadToFile;
    expectedDigest: typeof expectedDigest;
    linkPrepared?: typeof linkSync;
  } = { resolveExisting, downloadToFile, expectedDigest },
): Promise<{ path: string; installed: boolean }> {
  const agentDir = options?.agentDir ?? getAgentDir();
  const existing = await dependencies.resolveExisting(name, agentDir);
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
  const attemptDir = await mkdtemp(join(binDir, `.${name}-install-`));
  const archive = join(attemptDir, `${name}.tar.gz`);
  const url = releaseUrl(name, target);

  let installed = true;
  try {
    await dependencies.downloadToFile(url, archive);
    const digest = dependencies.expectedDigest(name, target);
    if (!digest) {
      throw new Error(`No pinned digest for ${name} on ${target.os}/${target.arch}`);
    }
    const version = name === "fd" ? FD_VERSION : RG_VERSION;
    await verifyArchive(archive, digest, `${name} ${version} on ${target.os}/${target.arch}`);
    const prepared = await extractBinary(archive, name, attemptDir);
    installed = await publishPrepared(prepared, dest, dependencies.linkPrepared);
  } finally {
    rmSync(attemptDir, { recursive: true, force: true });
  }

  if (!isRegularExecutable(dest)) {
    throw new Error(`Failed to install ${name} to ${dest}`);
  }
  return { path: dest, installed };
}
