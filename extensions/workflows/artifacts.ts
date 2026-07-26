import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function phaseDir(artifactsDir: string, phaseIndex: number, phaseName: string) {
  const slug = slugify(phaseName);
  return join(artifactsDir, "phases", `${String(phaseIndex + 1).padStart(2, "0")}-${slug}`);
}

export async function writeTaskArtifact(options: {
  dir: string;
  taskKey: string;
  title: string;
  status: string;
  body: string;
  error?: string;
  subagentId?: string;
}): Promise<string> {
  await mkdir(options.dir, { recursive: true, mode: 0o700 });
  const path = join(options.dir, `${slugify(options.taskKey)}.md`);
  const header = [
    `# ${options.title}`,
    "",
    `- task: ${options.taskKey}`,
    `- status: ${options.status}`,
    options.subagentId ? `- subagent: ${options.subagentId}` : undefined,
    options.error ? `- error: ${options.error}` : undefined,
    "",
    "---",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  await writeFile(path, `${header}${options.body.trim() || "(empty)"}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

export async function writeFinalArtifact(artifactsDir: string, body: string) {
  const path = join(artifactsDir, "final.md");
  await writeFile(path, `${body.trim() || "(empty)"}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "task"
  );
}
