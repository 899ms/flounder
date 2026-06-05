import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { loadSource } from "../dist/ingest/source.js";
import { MockAuditLlmClient } from "../dist/llm/mock.js";
import { runPipeline } from "../dist/pipeline.js";
import { runSeeders } from "../dist/seeders/index.js";

const root = path.resolve(".");
const fixtures = path.join(root, "fixtures");
const basicHalo2Fixture = path.join(fixtures, "halo2_missing_constraint.rs");
const scalarMulFixture = path.join(fixtures, "halo2_scalar_mul_binding.rs");

test("checklist seeders enumerate Halo2 missing-constraint audit items", async () => {
  const source = await loadSource([basicHalo2Fixture]);
  const items = runSeeders(source);
  assert.ok(source.every((doc) => !path.isAbsolute(doc.path)));
  assert.ok(source.every((doc) => !doc.path.includes(root)));
  assert.equal(items.filter((item) => item.failureMode === "missing_constraint").length, 2);
  assert.ok(items.every((item) => item.location.includes("halo2_missing_constraint.rs")));
});

test("checklist seeders enumerate scalar-mul advice binding questions from source shape", async () => {
  const source = await loadSource([scalarMulFixture]);
  const items = runSeeders(source);
  const bindingItems = items.filter((item) => item.seeder === "halo2_advice_binding");
  assert.equal(bindingItems.length, 1);
  assert.equal(bindingItems[0].failureMode, "missing_constraint");
  assert.match(bindingItems[0].location, /halo2_scalar_mul_binding\.rs:13-14/);
  assert.match(bindingItems[0].why, /scalar\/point-binding context/);
  assert.match(bindingItems[0].securityProperty, /constrained to that input/);
});

test("dry-run pipeline writes checklist and summary without model calls", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-dry-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-dry";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.dryRun = true;

  const result = await runPipeline(cfg);
  assert.equal(result.summary.coverage.itemsTotal, 5);
  assert.equal(result.summary.coverage.itemsWithFinding, 0);
  assert.equal(result.summary.coverage.bySeverity.high, 0);
  assert.deepEqual(result.summary.findings, []);
  await stat(path.join(result.runDir, "checklist.json"));
  await stat(path.join(result.runDir, "audit_results.json"));
  await stat(path.join(result.runDir, "lens_packs.json"));
  await stat(path.join(result.runDir, "summary.json"));
  await stat(path.join(result.runDir, "source_index.json"));
  await stat(path.join(result.runDir, "checklist_coverage.json"));
  assert.deepEqual(await readdir(path.join(result.runDir, "calls")), []);
});

test("mock pipeline runs enumerate, audit, verify, and report end to end", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-mock-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-mock";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 2;

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 2 });
  assert.equal(result.summary.coverage.itemsTotal, 6);
  assert.equal(result.summary.coverage.itemsWithFinding, 6);
  assert.equal(result.summary.coverage.bySeverity.high, 6);

  const verification = JSON.parse(await readFile(path.join(result.runDir, "verifications.json"), "utf8"));
  assert.equal(verification.length, 2);
  const lensPacks = JSON.parse(await readFile(path.join(result.runDir, "lens_packs.json"), "utf8"));
  assert.equal(lensPacks[0].id, "mock-project-lens");

  const coverage = JSON.parse(await readFile(path.join(result.runDir, "run_coverage.json"), "utf8"));
  assert.equal(coverage.checklist.byFailureMode.missing_constraint, 6);
  assert.equal(Object.keys(coverage.checklist.bySourceFile).length, 2);
  assert.deepEqual(Object.keys(coverage.checklist.bySourceFile).sort(), [
    "fixtures/halo2_missing_constraint.rs",
    "fixtures/halo2_scalar_mul_binding.rs",
  ]);

  const firstFindingId = result.summary.findings[0].id;
  const reportName = `report_${firstFindingId}.md`;
  const report = await readFile(path.join(result.runDir, reportName), "utf8");
  assert.match(report, /Security disclosure/);
  assert.match(report, /local, isolated environment only/i);

  for (const artifact of [
    "source_index.json",
    "checklist.json",
    "checklist_coverage.json",
    "run_coverage.json",
    "events.jsonl",
    reportName,
  ]) {
    const body = await readFile(path.join(result.runDir, artifact), "utf8");
    assertNoLocalAbsolutePath(body, artifact, [root, out]);
  }
});

test("model-only mode requires checklist items from model enumeration", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-model-only-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-model-only";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 2;
  cfg.localChecklistSeeders = false;

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 1 });
  assert.equal(result.summary.coverage.itemsTotal, 1);
  assert.equal(result.summary.coverage.itemsWithFinding, 1);

  const checklist = JSON.parse(await readFile(path.join(result.runDir, "checklist.json"), "utf8"));
  assert.equal(checklist.length, 1);
  assert.equal("seeder" in checklist[0], false);
  assert.equal(checklist[0].why, "Mock enumeration item used to test end-to-end model-driven audit flow.");

  const calls = await readdir(path.join(result.runDir, "calls"));
  assert.ok(calls.some((file) => /_discover_lenses\.json$/.test(file)));
  assert.ok(calls.some((file) => /_enumerate\.json$/.test(file)));
  assert.ok(calls.some((file) => /_audit_/.test(file)));
});

test("multi-round mode deepens with novel follow-up checklist items", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-rounds-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-rounds";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 2;
  cfg.localChecklistSeeders = false;

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 1 });
  assert.equal(result.summary.coverage.itemsTotal, 2);
  assert.equal(result.summary.coverage.itemsWithFinding, 2);

  const checklist = JSON.parse(await readFile(path.join(result.runDir, "checklist.json"), "utf8"));
  assert.deepEqual(checklist.map((item) => item.round), [1, 2]);
  assert.equal(new Set(checklist.map((item) => `${item.location}|${item.failureMode}|${item.securityProperty}`)).size, 2);

  const deepening = JSON.parse(await readFile(path.join(result.runDir, "round_2_deepening_items.json"), "utf8"));
  assert.equal(deepening.accepted.length, 1);
  assert.equal(deepening.accepted[0].id, "mock-round-2-source-binding");

  const calls = await readdir(path.join(result.runDir, "calls"));
  assert.ok(calls.some((file) => /_deepen_round_2\.json$/.test(file)));
  await stat(path.join(result.runDir, "round_1_audit_results.json"));
  await stat(path.join(result.runDir, "round_2_audit_results.json"));
});

function assertNoLocalAbsolutePath(body, label, forbiddenRoots) {
  for (const forbiddenRoot of forbiddenRoots) {
    assert.equal(body.includes(forbiddenRoot), false, `${label} includes a local absolute path`);
  }
}
