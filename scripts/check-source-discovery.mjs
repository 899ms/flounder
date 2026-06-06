#!/usr/bin/env node
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig, locationContainsLine, publicLocation, runPipeline } from "../dist/index.js";

const args = process.argv.slice(2);
const existingRunDir = readFlag(args, "--run-dir");
const source = existingRunDir ? undefined : readFlag(args, "--source") ?? process.env.FSA_DISCOVERY_SOURCE;
if (!existingRunDir && !source) {
  throw new Error("Provide --source <path>, --run-dir <path>, or set FSA_DISCOVERY_SOURCE.");
}

const cfg = defaultConfig();
cfg.targetName = readFlag(args, "--target") ?? "source-discovery";
if (source) cfg.sourcePaths = [source];
cfg.corpusPaths = readMultiFlag(args, "--corpus");
cfg.outputDir = existingRunDir ? path.dirname(existingRunDir) : await mkdtemp(path.join(os.tmpdir(), "fsa-source-discovery-"));
cfg.provider = readFlag(args, "--provider") ?? cfg.provider;
cfg.enumModel = readFlag(args, "--enum-model") ?? readFlag(args, "--model") ?? cfg.enumModel;
cfg.auditModel = readFlag(args, "--audit-model") ?? readFlag(args, "--model") ?? cfg.auditModel;
cfg.verifyModel = readFlag(args, "--verify-model") ?? readFlag(args, "--model") ?? cfg.verifyModel;
cfg.rounds = readIntFlag(args, "--rounds") ?? cfg.rounds;
cfg.explorationStrategy = readStrategyFlag(args) ?? cfg.explorationStrategy;
cfg.maxNewItemsPerRound = readIntFlag(args, "--max-new-items-per-round") ?? cfg.maxNewItemsPerRound;
cfg.trials = readIntFlag(args, "--trials") ?? cfg.trials;
cfg.maxAuditItems = readIntFlag(args, "--max-items") ?? cfg.maxAuditItems;
cfg.thinkingLevel = readThinkingFlag(args, "--thinking") ?? cfg.thinkingLevel;
cfg.dryRun = false;
cfg.projectLearning = !hasFlag(args, "--no-project-learning");
cfg.dynamicLensDiscovery = !hasFlag(args, "--no-dynamic-lenses");
cfg.localChecklistSeeders = hasFlag(args, "--allow-local-seeders");

const expectedFailureMode = readFlag(args, "--expect-failure-mode") ?? "missing_constraint";
const expectedFailureModeRegex = readRegexFlag(args, "--expect-failure-mode-regex");
const expectedLocation = readRegexFlag(args, "--expect-location-regex");
const expectedLocationFile = readRegexFlag(args, "--expect-location-file-regex");
const expectedLocationLine = readIntFlag(args, "--expect-location-line");
const expectedEvidence = readRegexFlag(args, "--expect-evidence-regex") ?? /(constraint|enforce|equation|guard|check|invariant|verification|binding|mismatch|authorization|validation)/i;
const minimumSeverity = readFlag(args, "--expect-min-severity") ?? readFlag(args, "--expect-severity") ?? "high";

const result = existingRunDir ? { runDir: existingRunDir } : await runPipeline(cfg);
const calls = await readdir(path.join(result.runDir, "calls"));
const auditCalls = calls.filter((file) => /_audit_/.test(file));
const learningCalls = calls.filter((file) => /_learn_project\.json$/.test(file));
const enumerateCalls = calls.filter((file) => /_enumerate\.json$/.test(file));
if (cfg.projectLearning && learningCalls.length === 0) {
  throw new Error("No initialization learning model call was recorded; project learning did not run as model reasoning.");
}
if (enumerateCalls.length === 0) {
  throw new Error("No enumeration model call was recorded; checklist generation did not run as model reasoning.");
}
if (auditCalls.length === 0) {
  throw new Error("No audit model calls were recorded; live model reasoning did not run.");
}

const summary = JSON.parse(await readFile(path.join(result.runDir, "summary.json"), "utf8"));
const checklist = JSON.parse(await readFile(path.join(result.runDir, "checklist.json"), "utf8"));
const findings = Array.isArray(summary.findings) ? summary.findings : [];
const finding = findings.find((item) => {
  if (expectedFailureModeRegex ? !expectedFailureModeRegex.test(item.failureMode) : item.failureMode !== expectedFailureMode) return false;
  if (!atLeastSeverity(item.severity, minimumSeverity)) return false;
  if (expectedLocation && !expectedLocation.test(item.location)) return false;
  if (expectedLocationFile && expectedLocationLine === undefined && !expectedLocationFile.test(item.location)) return false;
  if (expectedLocationLine !== undefined && !locationContainsLine(item.location, expectedLocationLine, expectedLocationFile)) return false;
  const evidenceText = [item.title, item.description, item.evidence, item.fix].join("\n");
  return expectedEvidence.test(evidenceText);
});

if (!finding) {
  const failureModeLabel = expectedFailureModeRegex ? `/${expectedFailureModeRegex.source}/i` : expectedFailureMode;
  const locationLabel = expectedLocationLine === undefined ? "" : ` expectedLine=${expectedLocationLine}`;
  throw new Error(`No live model finding matched failureMode=${failureModeLabel} minSeverity=${minimumSeverity}${locationLabel}.`);
}

const checklistItem = Array.isArray(checklist) ? checklist.find((item) => item.id === finding.id) : undefined;
if (!cfg.localChecklistSeeders && checklistItem?.seeder) {
  throw new Error(`Matched finding came from local checklist seeder '${checklistItem.seeder}', not model enumeration.`);
}

const report = await readFile(path.join(result.runDir, `report_${finding.id}.md`), "utf8");
if (!report.includes("Security disclosure")) {
  throw new Error("Matched finding did not produce a disclosure report.");
}

console.log(`Model source discovery check passed: ${finding.severity} ${publicLocation(finding.location)}`);

function hasFlag(values, name) {
  return values.includes(name);
}

function readFlag(values, name) {
  const idx = values.indexOf(name);
  if (idx === -1) return undefined;
  return values[idx + 1];
}

function readIntFlag(values, name) {
  const value = readFlag(values, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readThinkingFlag(values, name) {
  const value = readFlag(values, name);
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
}

function readStrategyFlag(values) {
  const value = readFlag(values, "--strategy") ?? readFlag(values, "--exploration-strategy");
  return value === "breadth" || value === "depth" || value === "hybrid" ? value : undefined;
}

function readRegexFlag(values, name) {
  const value = readFlag(values, name);
  return value ? new RegExp(value, "i") : undefined;
}

function readMultiFlag(values, name) {
  const idx = values.indexOf(name);
  if (idx === -1) return [];
  const out = [];
  for (let i = idx + 1; i < values.length; i += 1) {
    const value = values[i];
    if (!value || value.startsWith("--")) break;
    out.push(value);
  }
  return out;
}

function atLeastSeverity(actual, minimum) {
  const rank = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };
  return (rank[actual] ?? 0) >= (rank[minimum] ?? 4);
}
