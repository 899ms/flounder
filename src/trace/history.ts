import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditorConfig } from "../config.js";
import type { AuditItem, AuditResult, AuditSummary, FailureMode, RankedFinding, Severity } from "../types.js";
import { publicPath } from "../util/paths.js";

const HISTORY_VERSION = 1;
const DEFAULT_HISTORY_DIR_NAME = "history";

export interface ProjectHistoryRun {
  runId: string;
  runDir: string;
  targetName: string;
  startedAt?: string;
  updatedAt: string;
  sourcePaths: string[];
  corpusPaths: string[];
  provider?: string;
  enumModel?: string;
  auditModel?: string;
  verifyModel?: string;
  thinkingLevel?: string;
  rounds: number;
  trials?: number;
  itemsTotal: number;
  auditedItems: number;
  findingsTotal: number;
  bySeverity: Record<Severity, number>;
  confirmedSource: number;
  confirmedExecutable: number;
  sourceFiles: string[];
}

export interface ProjectHistoryFinding {
  runId: string;
  id: string;
  title: string;
  severity: Severity;
  location: string;
  failureMode: FailureMode;
  confirmationStatus: RankedFinding["confirmationStatus"];
  verificationVerdict?: RankedFinding["verificationVerdict"];
  reproductionStatus?: RankedFinding["reproductionStatus"];
}

export type ProjectHistoryMaterialKind =
  | "source-path"
  | "corpus-path"
  | "project-profile"
  | "project-learning"
  | "source-index"
  | "proof-obligations"
  | "provenance-graph"
  | "lens-packs"
  | "checklist"
  | "coverage"
  | "context-retrieval"
  | "deepening-items"
  | "audit-results"
  | "summary"
  | "verification"
  | "reproduction"
  | "report"
  | "event-log"
  | "model-call"
  | "run-artifact";

export interface ProjectHistoryMaterial {
  key: string;
  kind: ProjectHistoryMaterialKind;
  path: string;
  runId?: string;
  title?: string;
  sizeBytes?: number;
  source: "configured-source" | "configured-corpus" | "run-artifact";
}

export interface ProjectHistoryMaterialIndex {
  version: 1;
  targetName: string;
  historyKey: string;
  updatedAt: string;
  materials: ProjectHistoryMaterial[];
}

export interface ProjectHistoryManifest {
  version: 1;
  targetName: string;
  historyKey: string;
  createdAt: string;
  updatedAt: string;
  latestRunId?: string;
  latestRunDir?: string;
  runs: ProjectHistoryRun[];
  findings: ProjectHistoryFinding[];
  materials: ProjectHistoryMaterial[];
  aggregate: {
    totalRuns: number;
    totalRounds: number;
    totalItems: number;
    auditedItems: number;
    findingsTotal: number;
    materialsTotal: number;
    bySeverity: Record<Severity, number>;
    confirmedSource: number;
    confirmedExecutable: number;
    sourceFiles: string[];
    failureModes: Record<string, number>;
  };
}

export interface ProjectHistoryUpdateInput {
  cfg: AuditorConfig;
  runDir: string;
  summary: AuditSummary;
  items: AuditItem[];
  results: AuditResult[];
  completedRounds: number;
  startedAt?: string;
}

export interface ProjectHistoryLocationInput {
  outputDir: string;
  targetName: string;
  historyDir?: string;
}

export interface ProjectHistoryImportInput extends ProjectHistoryLocationInput {
  runDir: string;
}

export async function updateProjectHistory(input: ProjectHistoryUpdateInput): Promise<ProjectHistoryManifest> {
  const location = historyLocationFromConfig(input.cfg);
  const projectDir = projectHistoryDir(location);
  await mkdir(projectDir, { recursive: true });
  const existing = await readProjectHistoryManifest(location);
  const run = historyRunFromPipeline(input, projectDir);
  const findings = input.summary.findings.map((finding) => historyFinding(run.runId, finding));
  const materials = await materialIndexForRun({
    projectDir,
    runDir: input.runDir,
    runId: run.runId,
    sourcePaths: run.sourcePaths,
    corpusPaths: run.corpusPaths,
  });
  return writeProjectHistoryManifest(projectDir, mergeHistory(existing, input.cfg.targetName, projectHistoryKey(input.cfg.targetName), run, findings, materials));
}

export async function importRunToProjectHistory(input: ProjectHistoryImportInput): Promise<ProjectHistoryManifest> {
  const projectDir = projectHistoryDir(input);
  const sourceRunDir = path.resolve(input.runDir);
  const snapshotDir = path.join(projectDir, "runs", path.basename(sourceRunDir));
  await mkdir(path.dirname(snapshotDir), { recursive: true });
  if (path.resolve(snapshotDir) !== sourceRunDir) {
    await cp(sourceRunDir, snapshotDir, { recursive: true, force: true });
  }
  const existing = await readProjectHistoryManifest(input);
  const run = await historyRunFromRunDir({
    projectDir,
    runDir: snapshotDir,
    targetName: input.targetName,
  });
  const summary = await readRequiredJson<AuditSummary>(path.join(snapshotDir, "summary.json"));
  const findings = summary.findings.map((finding) => historyFinding(run.runId, finding));
  const materials = await materialIndexForRun({
    projectDir,
    runDir: snapshotDir,
    runId: run.runId,
    sourcePaths: run.sourcePaths,
    corpusPaths: run.corpusPaths,
  });
  return writeProjectHistoryManifest(projectDir, mergeHistory(existing, input.targetName, projectHistoryKey(input.targetName), run, findings, materials));
}

export async function readProjectHistoryManifest(input: ProjectHistoryLocationInput): Promise<ProjectHistoryManifest | undefined> {
  return readOptionalJson<ProjectHistoryManifest>(projectHistoryManifestPath(input));
}

export async function resolveProjectHistoryLatestRunDir(input: ProjectHistoryLocationInput): Promise<string> {
  const projectDir = projectHistoryDir(input);
  const manifest = await readProjectHistoryManifest(input);
  if (!manifest?.latestRunDir) {
    throw new Error(`No project history run found for target: ${input.targetName}`);
  }
  if (path.isAbsolute(manifest.latestRunDir)) {
    throw new Error(`Project history latestRunDir must be relative for target: ${input.targetName}`);
  }
  return path.resolve(projectDir, manifest.latestRunDir);
}

export function projectHistoryManifestPath(input: ProjectHistoryLocationInput): string {
  return path.join(projectHistoryDir(input), "manifest.json");
}

export function projectHistoryDir(input: ProjectHistoryLocationInput): string {
  return path.join(historyRoot(input), projectHistoryKey(input.targetName));
}

export function historyRoot(input: { outputDir: string; historyDir?: string }): string {
  return path.resolve(input.historyDir ?? path.join(input.outputDir, DEFAULT_HISTORY_DIR_NAME));
}

export function projectHistoryKey(targetName: string): string {
  const cleaned = targetName.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  return cleaned || "target";
}

async function historyRunFromRunDir(input: { projectDir: string; runDir: string; targetName: string }): Promise<ProjectHistoryRun> {
  const [summary, items, results, runStart] = await Promise.all([
    readRequiredJson<AuditSummary>(path.join(input.runDir, "summary.json")),
    readOptionalJson<AuditItem[]>(path.join(input.runDir, "checklist.json")),
    readOptionalJson<AuditResult[]>(path.join(input.runDir, "audit_results.json")),
    readRunStartEvent(input.runDir),
  ]);
  const checklist = Array.isArray(items) ? items : [];
  const auditResults = Array.isArray(results) ? results : [];
  return {
    runId: path.basename(input.runDir),
    runDir: relativeManifestPath(input.projectDir, input.runDir),
    targetName: input.targetName,
    ...(typeof runStart?.ts === "string" ? { startedAt: runStart.ts } : {}),
    updatedAt: new Date().toISOString(),
    sourcePaths: cleanStringArray(runStart?.sourcePaths),
    corpusPaths: cleanStringArray(runStart?.corpusPaths),
    ...(typeof runStart?.provider === "string" ? { provider: runStart.provider } : {}),
    ...(typeof runStart?.enumModel === "string" ? { enumModel: runStart.enumModel } : {}),
    ...(typeof runStart?.auditModel === "string" ? { auditModel: runStart.auditModel } : {}),
    ...(typeof runStart?.verifyModel === "string" ? { verifyModel: runStart.verifyModel } : {}),
    ...(typeof runStart?.thinkingLevel === "string" ? { thinkingLevel: runStart.thinkingLevel } : {}),
    rounds: roundsFromChecklist(checklist, auditResults),
    ...optionalTrials(auditResults),
    itemsTotal: summary.coverage.itemsTotal,
    auditedItems: auditResults.length,
    findingsTotal: summary.findings.length,
    bySeverity: severityCounts(summary),
    confirmedSource: summary.findings.filter((finding) => finding.confirmationStatus === "confirmed-source").length,
    confirmedExecutable: summary.findings.filter((finding) => finding.confirmationStatus === "confirmed-executable").length,
    sourceFiles: sourceFilesFromItems(checklist),
  };
}

function historyRunFromPipeline(input: ProjectHistoryUpdateInput, projectDir: string): ProjectHistoryRun {
  return {
    runId: path.basename(input.runDir),
    runDir: relativeManifestPath(projectDir, input.runDir),
    targetName: input.cfg.targetName,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    updatedAt: new Date().toISOString(),
    sourcePaths: input.cfg.sourcePaths.map((sourcePath) => publicPath(sourcePath)),
    corpusPaths: input.cfg.corpusPaths.map((corpusPath) => publicPath(corpusPath)),
    provider: input.cfg.provider,
    enumModel: input.cfg.enumModel,
    auditModel: input.cfg.auditModel,
    verifyModel: input.cfg.verifyModel,
    thinkingLevel: input.cfg.thinkingLevel,
    rounds: input.completedRounds,
    trials: input.cfg.trials,
    itemsTotal: input.summary.coverage.itemsTotal,
    auditedItems: input.results.length,
    findingsTotal: input.summary.findings.length,
    bySeverity: severityCounts(input.summary),
    confirmedSource: input.summary.findings.filter((finding) => finding.confirmationStatus === "confirmed-source").length,
    confirmedExecutable: input.summary.findings.filter((finding) => finding.confirmationStatus === "confirmed-executable").length,
    sourceFiles: sourceFilesFromItems(input.items),
  };
}

function historyLocationFromConfig(cfg: AuditorConfig): ProjectHistoryLocationInput {
  return {
    outputDir: cfg.outputDir,
    targetName: cfg.targetName,
    ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}),
  };
}

function mergeHistory(
  existing: ProjectHistoryManifest | undefined,
  targetName: string,
  historyKey: string,
  run: ProjectHistoryRun,
  findings: ProjectHistoryFinding[],
  materials: ProjectHistoryMaterial[],
): ProjectHistoryManifest {
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  const runs = replaceBy(existing?.runs ?? [], run, (entry) => entry.runId);
  const findingKeysForRun = new Set(findings.map((finding) => `${finding.runId}\u0000${finding.id}`));
  const oldFindings = (existing?.findings ?? []).filter((finding) => !findingKeysForRun.has(`${finding.runId}\u0000${finding.id}`));
  const allFindings = [...oldFindings, ...findings];
  const materialKeysForRun = new Set(materials.map((material) => material.key));
  const oldMaterials = (existing?.materials ?? []).filter((material) => !materialKeysForRun.has(material.key));
  const allMaterials = dedupeMaterials([...oldMaterials, ...materials]).sort((a, b) => a.path.localeCompare(b.path));
  const latestRunDir = run.runDir;
  return {
    version: HISTORY_VERSION,
    targetName,
    historyKey,
    createdAt,
    updatedAt: new Date().toISOString(),
    latestRunId: run.runId,
    latestRunDir,
    runs,
    findings: allFindings,
    materials: allMaterials,
    aggregate: aggregateHistory(runs, allFindings, allMaterials),
  };
}

function aggregateHistory(
  runs: ProjectHistoryRun[],
  findings: ProjectHistoryFinding[],
  materials: ProjectHistoryMaterial[],
): ProjectHistoryManifest["aggregate"] {
  return {
    totalRuns: runs.length,
    totalRounds: runs.reduce((sum, run) => sum + run.rounds, 0),
    totalItems: runs.reduce((sum, run) => sum + run.itemsTotal, 0),
    auditedItems: runs.reduce((sum, run) => sum + run.auditedItems, 0),
    findingsTotal: findings.length,
    materialsTotal: materials.length,
    bySeverity: addSeverityCounts(runs.map((run) => run.bySeverity)),
    confirmedSource: findings.filter((finding) => finding.confirmationStatus === "confirmed-source").length,
    confirmedExecutable: findings.filter((finding) => finding.confirmationStatus === "confirmed-executable").length,
    sourceFiles: [...new Set(runs.flatMap((run) => run.sourceFiles))].sort(),
    failureModes: countBy(findings, (finding) => finding.failureMode),
  };
}

function historyFinding(runId: string, finding: RankedFinding): ProjectHistoryFinding {
  return {
    runId,
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    location: finding.location,
    failureMode: finding.failureMode,
    confirmationStatus: finding.confirmationStatus,
    ...(finding.verificationVerdict ? { verificationVerdict: finding.verificationVerdict } : {}),
    ...(finding.reproductionStatus ? { reproductionStatus: finding.reproductionStatus } : {}),
  };
}

async function writeProjectHistoryManifest(projectDir: string, manifest: ProjectHistoryManifest): Promise<ProjectHistoryManifest> {
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeProjectMaterialsIndex(projectDir, manifest);
  return manifest;
}

async function writeProjectMaterialsIndex(projectDir: string, manifest: ProjectHistoryManifest): Promise<void> {
  const materialsDir = path.join(projectDir, "materials");
  await mkdir(materialsDir, { recursive: true });
  const index: ProjectHistoryMaterialIndex = {
    version: HISTORY_VERSION,
    targetName: manifest.targetName,
    historyKey: manifest.historyKey,
    updatedAt: manifest.updatedAt,
    materials: manifest.materials,
  };
  await writeFile(path.join(materialsDir, "index.json"), JSON.stringify(index, null, 2));
}

async function materialIndexForRun(input: {
  projectDir: string;
  runDir: string;
  runId: string;
  sourcePaths: string[];
  corpusPaths: string[];
}): Promise<ProjectHistoryMaterial[]> {
  const configured = [
    ...input.sourcePaths.map((sourcePath) => configuredMaterial(input.runId, "source-path", sourcePath, "configured-source")),
    ...input.corpusPaths.map((corpusPath) => configuredMaterial(input.runId, "corpus-path", corpusPath, "configured-corpus")),
  ];
  const artifactFiles = await listFiles(input.runDir);
  const artifacts = await Promise.all(
    artifactFiles.map(async (file) => {
      const relativeRunPath = toPosix(path.relative(input.runDir, file));
      const manifestPath = relativeManifestPath(input.projectDir, file);
      const fileStat = await stat(file);
      return {
        key: materialKey(input.runId, manifestPath),
        kind: materialKind(relativeRunPath),
        path: manifestPath,
        runId: input.runId,
        title: materialTitle(relativeRunPath),
        sizeBytes: fileStat.size,
        source: "run-artifact" as const,
      };
    }),
  );
  return dedupeMaterials([...configured, ...artifacts]).sort((a, b) => a.path.localeCompare(b.path));
}

function configuredMaterial(
  runId: string,
  kind: Extract<ProjectHistoryMaterialKind, "source-path" | "corpus-path">,
  publicInputPath: string,
  source: Extract<ProjectHistoryMaterial["source"], "configured-source" | "configured-corpus">,
): ProjectHistoryMaterial {
  const pathValue = toPosix(publicInputPath);
  return {
    key: materialKey(runId, `${kind}:${pathValue}`),
    kind,
    path: pathValue,
    runId,
    source,
  };
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(absolute)));
    } else if (entry.isFile()) {
      out.push(absolute);
    }
  }
  return out;
}

function materialKind(relativeRunPath: string): ProjectHistoryMaterialKind {
  if (/^calls\/.+\.json$/.test(relativeRunPath)) return "model-call";
  if (/^reproduction\//.test(relativeRunPath) || relativeRunPath === "reproductions.json") return "reproduction";
  if (relativeRunPath === "events.jsonl") return "event-log";
  if (relativeRunPath === "project_profile.json") return "project-profile";
  if (relativeRunPath === "project_learning.json") return "project-learning";
  if (relativeRunPath === "source_index.json") return "source-index";
  if (relativeRunPath === "proof_obligations.json") return "proof-obligations";
  if (/^[a-z0-9_-]+_provenance_graph\.json$/i.test(relativeRunPath)) return "provenance-graph";
  if (relativeRunPath === "lens_packs.json") return "lens-packs";
  if (relativeRunPath === "checklist.json") return "checklist";
  if (/coverage\.json$/.test(relativeRunPath)) return "coverage";
  if (/context_retrieval\.json$/.test(relativeRunPath)) return "context-retrieval";
  if (/deepening_items\.json$/.test(relativeRunPath)) return "deepening-items";
  if (/audit_results\.json$/.test(relativeRunPath)) return "audit-results";
  if (relativeRunPath === "summary.json") return "summary";
  if (relativeRunPath === "verifications.json") return "verification";
  if (/^report_.+\.md$/.test(relativeRunPath)) return "report";
  return "run-artifact";
}

function materialTitle(relativeRunPath: string): string {
  if (relativeRunPath.startsWith("calls/")) return `Model call ${path.basename(relativeRunPath, ".json")}`;
  return relativeRunPath;
}

function materialKey(runId: string, materialPath: string): string {
  return `${runId}:${toPosix(materialPath)}`;
}

function dedupeMaterials(materials: ProjectHistoryMaterial[]): ProjectHistoryMaterial[] {
  const out = new Map<string, ProjectHistoryMaterial>();
  for (const material of materials) {
    out.set(material.key, material);
  }
  return [...out.values()];
}

async function readRunStartEvent(runDir: string): Promise<Record<string, unknown> | undefined> {
  const eventsPath = path.join(runDir, "events.jsonl");
  let body: string;
  try {
    body = await readFile(eventsPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.kind === "run_start") return event;
  }
  return undefined;
}

async function readOptionalJson<T>(file: string): Promise<T | undefined> {
  try {
    return await readRequiredJson<T>(file);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readRequiredJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

function severityCounts(summary: AuditSummary): Record<Severity, number> {
  return {
    critical: summary.coverage.bySeverity.critical ?? 0,
    high: summary.coverage.bySeverity.high ?? 0,
    medium: summary.coverage.bySeverity.medium ?? 0,
    low: summary.coverage.bySeverity.low ?? 0,
    info: summary.coverage.bySeverity.info ?? 0,
  };
}

function addSeverityCounts(counts: Array<Record<Severity, number>>): Record<Severity, number> {
  return counts.reduce(
    (out, entry) => ({
      critical: out.critical + (entry.critical ?? 0),
      high: out.high + (entry.high ?? 0),
      medium: out.medium + (entry.medium ?? 0),
      low: out.low + (entry.low ?? 0),
      info: out.info + (entry.info ?? 0),
    }),
    { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  );
}

function roundsFromChecklist(items: AuditItem[], results: AuditResult[]): number {
  return Math.max(
    1,
    ...items.map((item) => cleanRound(item.round)),
    ...results.map((result) => cleanRound(result.item.round)),
  );
}

function trialsFromResults(results: AuditResult[]): number | undefined {
  const maxTrials = Math.max(0, ...results.map((result) => result.nTrials));
  return maxTrials > 0 ? maxTrials : undefined;
}

function optionalTrials(results: AuditResult[]): Pick<ProjectHistoryRun, "trials"> | Record<string, never> {
  const trials = trialsFromResults(results);
  return trials !== undefined ? { trials } : {};
}

function sourceFilesFromItems(items: AuditItem[]): string[] {
  return [...new Set(items.flatMap((item) => splitLocationSegments(item.location).map(sourceFileFromLocation)).filter(Boolean))].sort();
}

function sourceFileFromLocation(location: string): string {
  const trimmed = location.trim();
  const lineMatch = /^(.*?):\d+(?:-\d+)?(?:\s|$)/.exec(trimmed);
  const raw = lineMatch?.[1] ?? trimmed.split(":")[0] ?? trimmed;
  return raw.replace(/\s+\([^)]*\)\s*$/, "").trim();
}

function splitLocationSegments(location: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  for (let idx = 0; idx < location.length; idx += 1) {
    const char = location[idx];
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === ";" && depth === 0) {
      out.push(location.slice(start, idx).trim());
      start = idx + 1;
    }
  }
  out.push(location.slice(start).trim());
  return out.filter(Boolean);
}

function replaceBy<T>(items: T[], next: T, key: (item: T) => string): T[] {
  const nextKey = key(next);
  return [...items.filter((item) => key(item) !== nextKey), next];
}

function relativeManifestPath(projectDir: string, targetPath: string): string {
  const relative = path.relative(projectDir, path.resolve(targetPath));
  return toPosix(relative || ".");
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function cleanRound(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function toPosix(input: string): string {
  return input.split(path.sep).join("/");
}
