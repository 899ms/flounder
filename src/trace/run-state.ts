import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AuditItem, AuditLensPackDefinition, AuditResult, AuditSummary, ProjectLearning, Verification } from "../types.js";

export interface ResumedRunState {
  runDir: string;
  items: AuditItem[];
  results: AuditResult[];
  lensPacks: AuditLensPackDefinition[];
  projectLearning?: ProjectLearning;
  completedRounds: number;
  pendingRoundItems?: AuditItem[];
}

export async function loadResumedRunState(runDir: string): Promise<ResumedRunState> {
  const fullRunDir = path.resolve(runDir);
  const info = await stat(fullRunDir);
  if (!info.isDirectory()) throw new Error(`--resume-run must point to a run directory: ${runDir}`);

  const checkpointItems = (await readOptionalArray<AuditItem>(fullRunDir, "checklist.json")) ?? [];
  const rawResults = await readAuditResults(fullRunDir);
  const lensPacks = (await readOptionalArray<AuditLensPackDefinition>(fullRunDir, "lens_packs.json")) ?? [];
  const projectLearning = await readOptionalObject<ProjectLearning>(fullRunDir, "project_learning.json");
  const retryableResults = rawResults.filter(hasRetryableTrialError);
  const retryRound = retryableResults.reduce((min, result) => Math.min(min, cleanRound(result.item?.round)), Number.POSITIVE_INFINITY);
  const hasRetryRound = Number.isFinite(retryRound);
  const results = hasRetryRound ? rawResults.filter((result) => cleanRound(result.item?.round) < retryRound) : rawResults;
  const items = mergeAuditItems([
    ...checkpointItems.filter((item) => !hasRetryRound || cleanRound(item.round) < retryRound),
    ...results.map((result) => result.item),
  ]);
  const completedRounds = Number.isFinite(retryRound)
    ? Math.max(0, retryRound - 1)
    : Math.max(roundsFromResults(results), await roundsFromArtifacts(fullRunDir));
  if (completedRounds < 1 && !hasRetryRound) {
    throw new Error("--resume-run does not contain completed round state");
  }
  const pendingRoundItems = Number.isFinite(retryRound)
    ? retryRoundItems(checkpointItems, rawResults, retryRound)
    : await readPendingRoundItems(fullRunDir, completedRounds + 1);

  return {
    runDir: fullRunDir,
    items,
    results,
    lensPacks,
    ...(projectLearning ? { projectLearning } : {}),
    completedRounds,
    ...(pendingRoundItems.length > 0 ? { pendingRoundItems } : {}),
  };
}

function retryRoundItems(checkpointItems: AuditItem[], results: AuditResult[], retryRound: number): AuditItem[] {
  const checkpointRoundItems = checkpointItems.filter((item) => cleanRound(item.round) === retryRound);
  const resultRoundItems = results.filter((result) => cleanRound(result.item?.round) === retryRound).map((result) => result.item);
  return mergeAuditItems([...checkpointRoundItems, ...resultRoundItems]).map((item) => ({ ...item, round: retryRound }));
}

export async function loadSummaryFromRun(runDir: string): Promise<AuditSummary> {
  const fullRunDir = path.resolve(runDir);
  const value = await readOptionalObject<AuditSummary>(fullRunDir, "summary.json");
  if (!value) throw new Error(`Run directory does not contain summary.json: ${runDir}`);
  return value;
}

export async function loadVerificationsFromRun(runDir: string): Promise<Verification[]> {
  return (await readOptionalArray<Verification>(path.resolve(runDir), "verifications.json")) ?? [];
}

export async function loadProjectLearningFromRun(runDir: string): Promise<ProjectLearning | undefined> {
  return readOptionalObject<ProjectLearning>(path.resolve(runDir), "project_learning.json");
}

async function readAuditResults(runDir: string): Promise<AuditResult[]> {
  const finalResults = await readOptionalArray<AuditResult>(runDir, "audit_results.json");
  if (finalResults) return finalResults;
  return readRoundResultArtifacts(runDir);
}

async function readOptionalArray<T>(runDir: string, name: string): Promise<T[] | undefined> {
  const value = await readOptionalJson(path.join(runDir, name));
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Resume artifact ${name} must be an array`);
  return value as T[];
}

async function readOptionalObject<T>(runDir: string, name: string): Promise<T | undefined> {
  const value = await readOptionalJson(path.join(runDir, name));
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Resume artifact ${name} must be an object`);
  return value as T;
}

async function readOptionalJson(file: string): Promise<unknown | undefined> {
  try {
    return await readJson(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function readRoundResultArtifacts(runDir: string): Promise<AuditResult[]> {
  const files = await readdir(runDir);
  const roundFiles = files
    .map((file) => ({ file, match: /^round_(\d+)_audit_results\.json$/.exec(file) }))
    .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => Number.parseInt(a.match[1] ?? "0", 10) - Number.parseInt(b.match[1] ?? "0", 10));
  const out: AuditResult[] = [];
  for (const { file } of roundFiles) {
    out.push(...(await readRequiredRoundResults(runDir, file)));
  }
  return out;
}

async function readRequiredRoundResults(runDir: string, name: string): Promise<AuditResult[]> {
  const value = await readJson(path.join(runDir, name));
  if (!Array.isArray(value)) throw new Error(`Resume artifact ${name} must be an array`);
  return value as AuditResult[];
}

async function readPendingRoundItems(runDir: string, round: number): Promise<AuditItem[]> {
  const value = await readOptionalJson(path.join(runDir, `round_${round}_deepening_items.json`));
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Resume artifact round_${round}_deepening_items.json must be an object`);
  }
  const accepted = (value as { accepted?: unknown }).accepted;
  if (accepted === undefined) return [];
  if (!Array.isArray(accepted)) throw new Error(`Resume artifact round_${round}_deepening_items.json accepted must be an array`);
  return accepted.map((item) => ({ ...(item as AuditItem), round }));
}

async function roundsFromArtifacts(runDir: string): Promise<number> {
  const files = await readdir(runDir);
  let max = 0;
  for (const file of files) {
    const match = /^round_(\d+)_audit_results\.json$/.exec(file);
    if (!match) continue;
    const rawRound = match[1];
    if (!rawRound) continue;
    const round = Number.parseInt(rawRound, 10);
    if (Number.isFinite(round)) max = Math.max(max, round);
  }
  return max;
}

function roundsFromResults(results: AuditResult[]): number {
  return results.reduce((max, result) => Math.max(max, cleanRound(result.item?.round)), 0);
}

function mergeAuditItems(items: AuditItem[]): AuditItem[] {
  const out: AuditItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const key = [
      cleanRound(item.round),
      item.id,
      item.location,
      item.failureMode,
      item.securityProperty,
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function hasRetryableTrialError(result: AuditResult): boolean {
  return result.trials.some((trial) => trial.modelError || trial.parseError || trial.needsMoreContext);
}

function cleanRound(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}
