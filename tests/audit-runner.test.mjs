import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { aggregate } from "../dist/audit/aggregate.js";
import { runAudit } from "../dist/audit/runner.js";
import { defaultConfig } from "../dist/config.js";
import { RunLogger } from "../dist/trace/logger.js";

test("audit runner records provider failures as trial errors", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-audit-error-"));
  const cfg = defaultConfig();
  cfg.targetName = "audit-error";
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.maxWorkers = 1;
  const logger = new RunLogger(out, cfg.targetName);
  await logger.init();
  const llm = {
    async complete() {
      throw new Error("provider unavailable");
    },
  };

  const results = await runAudit({
    cfg,
    items: [
      {
        id: "provider-failure",
        location: "src/circuit.rs:1",
        securityProperty: "Provider failures should not abort the whole audit round.",
        failureMode: "missing_constraint",
        why: "Regression coverage for item-level provider failure handling.",
        round: 1,
      },
    ],
    source: [{ path: "src/circuit.rs", content: "fn circuit() {}", kind: "source" }],
    llm,
    logger,
    artifactName: "round_1_audit_results.json",
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].nHits, 0);
  assert.equal(results[0].trials[0].modelError, true);
  assert.match(results[0].trials[0].raw, /provider unavailable/);

  const events = await readFile(path.join(logger.runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"trial_error"/);
  assert.match(events, /"kind":"item_done"/);
});

test("aggregate exposes retry and unverified finding quality counters", () => {
  const summary = aggregate([
    {
      item: item("finding-with-parse-error"),
      nTrials: 2,
      nHits: 1,
      hitRate: 0.5,
      trials: [
        findingTrial({ title: "High confidence candidate" }),
        findingTrial({ finding: false, parseError: true, title: "Parse error", confidence: 0.1 }),
      ],
    },
    {
      item: item("provider-error"),
      nTrials: 1,
      nHits: 0,
      hitRate: 0,
      trials: [findingTrial({ finding: false, modelError: true, title: "Provider error", confidence: 0 })],
    },
    {
      item: item("needs-context"),
      nTrials: 1,
      nHits: 0,
      hitRate: 0,
      trials: [findingTrial({ finding: false, needsMoreContext: true, title: "Needs more context", confidence: 0.2 })],
    },
  ]);

  assert.equal(summary.coverage.itemsTotal, 3);
  assert.equal(summary.coverage.itemsWithFinding, 1);
  assert.equal(summary.coverage.itemsNeedingRetry, 3);
  assert.equal(summary.coverage.modelErrorTrials, 1);
  assert.equal(summary.coverage.parseErrorTrials, 1);
  assert.equal(summary.coverage.needsMoreContextTrials, 1);
  assert.equal(summary.coverage.verifiedFindings, 0);
  assert.equal(summary.coverage.unverifiedFindings, 1);
  assert.ok((summary.findings[0].impactScore ?? 0) > 0);
});

test("audit runner treats unavailable qmd retrieval as non-fatal", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-qmd-unavailable-"));
  const cfg = defaultConfig();
  cfg.targetName = "qmd-unavailable";
  cfg.outputDir = out;
  cfg.contextRetrieval = "source-index+qmd";
  cfg.qmdCommand = "definitely-not-installed-qmd";
  cfg.qmdCollections = ["target-code"];
  cfg.trials = 1;
  cfg.maxWorkers = 1;
  const logger = new RunLogger(out, cfg.targetName);
  await logger.init();
  const llm = {
    async complete() {
      return JSON.stringify({
        finding: false,
        title: "No finding",
        severity: "info",
        confidence: 0.5,
        description: "The item was audited with source-index context only.",
        evidence: "QMD is optional.",
        exploitSketch: "",
        fix: "",
      });
    },
  };

  const results = await runAudit({
    cfg,
    items: [
      {
        id: "qmd-optional",
        location: "src/circuit.rs:1",
        securityProperty: "Optional semantic retrieval must not block audit execution.",
        failureMode: "missing_constraint",
        why: "QMD is an optional supplement.",
        round: 1,
      },
    ],
    source: [{ path: "src/circuit.rs", content: "fn circuit() {}", kind: "source" }],
    llm,
    logger,
  });

  assert.equal(results.length, 1);
  const trace = JSON.parse(await readFile(path.join(logger.runDir, "context_retrieval.json"), "utf8"));
  assert.equal(trace[0].mode, "source-index+qmd");
  assert.equal(trace[0].qmd.available, false);
  assert.deepEqual(trace[0].qmd.collections, ["target-code"]);
  const events = await readFile(path.join(logger.runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"qmd_unavailable"/);
});

function item(id) {
  return {
    id,
    location: "src/circuit.rs:1",
    securityProperty: `${id} property`,
    failureMode: "missing_constraint",
    why: `${id} rationale`,
    round: 1,
  };
}

function findingTrial(overrides = {}) {
  return {
    finding: true,
    title: "Candidate finding",
    severity: "high",
    confidence: 0.8,
    description: "Source-backed candidate.",
    evidence: "Relevant source line.",
    exploitSketch: "Local-only sketch.",
    fix: "Add the missing check.",
    ...overrides,
  };
}
