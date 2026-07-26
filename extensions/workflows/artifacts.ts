import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StructuredOutput, WorkflowSnapshot } from "./domain.ts";

export function phaseDir(artifactsDir: string, phaseIndex: number, phaseName: string) {
  const slug = slugify(phaseName);
  return join(artifactsDir, "phases", `${String(phaseIndex + 1).padStart(2, "0")}-${slug}`);
}

export async function writeMeta(artifactsDir: string, meta: Record<string, unknown>) {
  await writeFile(join(artifactsDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

export async function writeGoal(artifactsDir: string, goal: string) {
  await writeFile(join(artifactsDir, "goal.txt"), `${goal.trim()}\n`, "utf8");
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
  await mkdir(options.dir, { recursive: true });
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
  await writeFile(path, `${header}${options.body.trim() || "(empty)"}\n`, "utf8");
  return path;
}

export async function writeStructuredIndex(dir: string, outputs: StructuredOutput[]) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "outputs.json");
  await writeFile(path, `${JSON.stringify(outputs, null, 2)}\n`, "utf8");
  return path;
}

export async function writeFinalArtifact(artifactsDir: string, body: string) {
  const path = join(artifactsDir, "final.md");
  await writeFile(path, `${body.trim() || "(empty)"}\n`, "utf8");
  return path;
}

export async function writeSnapshot(artifactsDir: string, snap: WorkflowSnapshot) {
  await writeFile(
    join(artifactsDir, "status.json"),
    `${JSON.stringify(snap, null, 2)}\n`,
    "utf8",
  );
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
