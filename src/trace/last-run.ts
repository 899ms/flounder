import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const LAST_RUN_FILE = ".fsa-last-run.json";

export interface LastRunPointer {
  version: 1;
  targetName: string;
  runDirName: string;
  updatedAt: string;
}

export async function writeLastRunPointer(outputDir: string, runDir: string, targetName: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const pointer: LastRunPointer = {
    version: 1,
    targetName,
    runDirName: path.basename(runDir),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(outputDir, LAST_RUN_FILE), JSON.stringify(pointer, null, 2));
}

export async function resolveLastRunDir(outputDir: string): Promise<string> {
  const pointerPath = path.join(outputDir, LAST_RUN_FILE);
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Partial<LastRunPointer>;
  if (pointer.version !== 1 || !isSafeRunDirName(pointer.runDirName)) {
    throw new Error(`${LAST_RUN_FILE} is missing a valid run directory name`);
  }
  return path.join(outputDir, pointer.runDirName);
}

function isSafeRunDirName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.includes("/") && !value.includes("\\");
}
