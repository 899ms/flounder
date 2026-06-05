#!/usr/bin/env node
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig, publicLocation, runPipeline } from "../dist/index.js";

const args = process.argv.slice(2);
const source = readFlag(args, "--source") ?? process.env.FSA_DISCOVERY_SOURCE;
if (!source) {
  throw new Error("Provide --source <path> or set FSA_DISCOVERY_SOURCE.");
}

const out = await mkdtemp(path.join(os.tmpdir(), "fsa-source-discovery-"));
const cfg = defaultConfig();
cfg.targetName = readFlag(args, "--target") ?? "source-discovery";
cfg.sourcePaths = [source];
cfg.corpusPaths = readMultiFlag(args, "--corpus");
cfg.outputDir = out;
cfg.provider = readFlag(args, "--provider") ?? cfg.provider;
cfg.enumModel = readFlag(args, "--enum-model") ?? readFlag(args, "--model") ?? cfg.enumModel;
cfg.auditModel = readFlag(args, "--audit-model") ?? readFlag(args, "--model") ?? cfg.auditModel;
cfg.verifyModel = readFlag(args, "--verify-model") ?? readFlag(args, "--model") ?? cfg.verifyModel;
cfg.rounds = readIntFlag(args, "--rounds") ?? cfg.rounds;
cfg.maxNewItemsPerRound = readIntFlag(args, "--max-new-items-per-round") ?? cfg.maxNewItemsPerRound;
cfg.trials = readIntFlag(args, "--trials") ?? cfg.trials;
cfg.maxAuditItems = readIntFlag(args, "--max-items") ?? cfg.maxAuditItems;
cfg.thinkingLevel = readThinkingFlag(args, "--thinking") ?? cfg.thinkingLevel;
cfg.dryRun = false;
cfg.dynamicLensDiscovery = !hasFlag(args, "--no-dynamic-lenses");
cfg.localChecklistSeeders = hasFlag(args, "--allow-local-seeders");

const expectedFailureMode = readFlag(args, "--expect-failure-mode") ?? "missing_constraint";
const expectedFailureModeRegex = readRegexFlag(args, "--expect-failure-mode-regex");
const expectedLocation = readRegexFlag(args, "--expect-location-regex");
const expectedEvidence = readRegexFlag(args, "--expect-evidence-regex") ?? /(constraint|bound|bind|advice|witness|source|input)/i;
const minimumSeverity = readFlag(args, "--expect-min-severity") ?? readFlag(args, "--expect-severity") ?? "high";

const result = await runPipeline(cfg);
const calls = await readdir(path.join(result.runDir, "calls"));
const auditCalls = calls.filter((file) => /_audit_/.test(file));
const enumerateCalls = calls.filter((file) => /_enumerate\.json$/.test(file));
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
  const evidenceText = [item.title, item.description, item.evidence, item.fix].join("\n");
  return expectedEvidence.test(evidenceText);
});

if (!finding) {
  const failureModeLabel = expectedFailureModeRegex ? `/${expectedFailureModeRegex.source}/i` : expectedFailureMode;
  throw new Error(`No live model finding matched failureMode=${failureModeLabel} minSeverity=${minimumSeverity}.`);
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
