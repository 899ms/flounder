import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { verifyTop } from "../dist/verify/planner.js";
import { RunLogger } from "../dist/trace/logger.js";

test("verification queue includes high-impact Halo2 findings beyond topK", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-verify-impact-"));
  const cfg = defaultConfig();
  cfg.outputDir = out;
  cfg.targetName = "verify-impact";
  cfg.highImpactVerification = true;
  cfg.highImpactMaxFindings = 8;
  const logger = new RunLogger(out, cfg.targetName);
  await logger.init();
  const calls = [];
  const llm = {
    async complete(input) {
      calls.push(input.tag);
      if (input.tag === "verify_composition_halo2-soundness") {
        assert.match(input.user, /Composition verification rules/);
        assert.match(input.user, /caller or gadget composition/);
      }
      return "VERDICT: confirmed\n\nSource-level confirmation for queue test.\n\nExecutable success patterns:\n\n- verifier-owned queue test pattern\n";
    },
  };

  const verifications = await verifyTop({
    cfg,
    findings: [
      finding({
        id: "top-low",
        failureMode: "input_validation",
        title: "Top ranked ordinary issue",
        severity: "low",
        score: 100,
        impactScore: 0,
      }),
      finding({
        id: "halo2-soundness",
        failureMode: "soundness_gap",
        title: "Malicious prover can satisfy proof with inconsistent witness",
        severity: "medium",
        score: 1,
        impactScore: 4,
        impactSignals: ["zk-or-proof-soundness"],
        description: "A Halo2 assigned cell may not be bound to the caller-provided base before the verifier accepts a false statement.",
        evidence: "assign_advice is visible without a caller handoff in the local context.",
      }),
    ],
    source: [
      {
        path: "src/circuit.rs",
        kind: "source",
        content: [
          "fn assign(region: &mut Region) {",
          "    let cell = region.assign_advice(|| \"x_p\", config.advice, 0, || witness)?;",
          "    meta.create_gate(\"mul\", |meta| vec![meta.query_selector(config.q_mul)]);",
          "}",
        ].join("\n"),
      },
    ],
    llm,
    logger,
    topK: 1,
  });

  assert.deepEqual(calls, ["verify_top-low", "verify_composition_halo2-soundness"]);
  assert.equal(verifications.length, 2);
  assert.equal(verifications[1].mode, "composition");
  assert.equal(verifications[1].queueReason, "high-impact");
  assert.deepEqual(verifications[1].executableSuccessPatterns, ["verifier-owned queue test pattern"]);
  const artifact = JSON.parse(await readFile(path.join(logger.runDir, "verification_context_retrieval.json"), "utf8"));
  assert.equal(artifact.length, 2);
  assert.equal(artifact[1].mode, "composition");
});

function finding(overrides) {
  return {
    id: "finding",
    location: "src/circuit.rs:2",
    failureMode: "missing_constraint",
    title: "Finding",
    severity: "medium",
    hitRate: 0.5,
    confidence: 0.7,
    score: 1,
    description: "Candidate description.",
    evidence: "Candidate evidence.",
    exploitSketch: "Local-only sketch.",
    fix: "Add the missing enforcement edge.",
    confirmationStatus: "suspected",
    ...overrides,
  };
}
