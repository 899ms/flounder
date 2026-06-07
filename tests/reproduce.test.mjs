import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { loadSource } from "../dist/ingest/source.js";
import { reproduceTop } from "../dist/reproduce/planner.js";
import { RunLogger } from "../dist/trace/logger.js";

test("reproduction execute mode writes and runs PoC only in a copied workspace", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "fsa-repro-project-"));
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "src", "target.js"), "export function vulnerable() { return true; }\n");
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-repro-run-"));
  const cfg = defaultConfig();
  cfg.targetName = "repro-test";
  cfg.sourcePaths = [project];
  cfg.outputDir = out;
  cfg.reproductionMode = "execute";
  cfg.reproductionCommandTimeoutMs = 30_000;
  const logger = new RunLogger(cfg.outputDir, cfg.targetName);
  await logger.init();
  const source = await loadSource(cfg.sourcePaths);

  const reproductions = await reproduceTop({
    cfg,
    findings: [
      {
        id: "mock-finding",
        location: "src/target.js:1",
        failureMode: "input_validation",
        title: "Mock executable finding",
        severity: "high",
        hitRate: 1,
        confidence: 0.9,
        score: 10,
        description: "A mock finding used to exercise the local reproduction runner.",
        evidence: "The mock source contains a visible test target.",
        exploitSketch: "A local test can demonstrate the behavior.",
        fix: "Add the missing check.",
        confirmationStatus: "confirmed-source",
      },
    ],
    verifications: [
      {
        id: "mock-finding",
        verdict: "confirmed",
        confirmationStatus: "confirmed-source",
        markdown: "VERDICT: confirmed\n\nSource-level mock confirmation.",
        executableSuccessPatterns: ["local reproduction command runs in workspace"],
      },
    ],
    source,
    llm: new ReproductionOnlyLlm(),
    logger,
    topK: 1,
  });

  assert.equal(reproductions.length, 1);
  assert.equal(reproductions[0].status, "confirmed-executable");
  assert.equal(reproductions[0].confirmationStatus, "confirmed-executable");
  assert.equal(reproductions[0].commandResults[0].exitCode, 0);
  assert.equal(await exists(path.join(project, "repro.test.mjs")), false);

  const artifact = await readFile(path.join(logger.runDir, "reproductions.json"), "utf8");
  assert.equal(artifact.includes(project), false);
  assert.equal(artifact.includes(out), false);
  if (process.env.HOME) assert.equal(artifact.includes(process.env.HOME), false);
  assert.match(artifact, /"workspace": "reproduction\/mock-finding\/workspace"/);
  assert.match(artifact, /node-options=unset/);
});

test("reproduction execute mode requires machine-checkable success patterns", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "fsa-repro-no-pattern-project-"));
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "src", "target.js"), "export function target() { return true; }\n");
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-repro-no-pattern-run-"));
  const cfg = defaultConfig();
  cfg.targetName = "repro-no-pattern";
  cfg.sourcePaths = [project];
  cfg.outputDir = out;
  cfg.reproductionMode = "execute";
  const logger = new RunLogger(cfg.outputDir, cfg.targetName);
  await logger.init();
  const source = await loadSource(cfg.sourcePaths);

  const reproductions = await reproduceTop({
    cfg,
    findings: [mockFinding()],
    verifications: [mockVerification()],
    source,
    llm: new NoPatternReproductionLlm(),
    logger,
    topK: 1,
  });

  assert.equal(reproductions[0].status, "needs-work");
  assert.equal(reproductions[0].confirmationStatus, "confirmed-source");
  assert.match(reproductions[0].markdown, /No verifier-owned executableSuccessPatterns were provided/);
});

test("reproduction execute mode blocks generated files that reference remote URLs", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "fsa-repro-remote-project-"));
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "src", "target.js"), "export function target() { return true; }\n");
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-repro-remote-run-"));
  const cfg = defaultConfig();
  cfg.targetName = "repro-remote";
  cfg.sourcePaths = [project];
  cfg.outputDir = out;
  cfg.reproductionMode = "execute";
  const logger = new RunLogger(cfg.outputDir, cfg.targetName);
  await logger.init();
  const source = await loadSource(cfg.sourcePaths);

  const reproductions = await reproduceTop({
    cfg,
    findings: [mockFinding()],
    verifications: [{ ...mockVerification(), executableSuccessPatterns: ["remote test should never run"] }],
    source,
    llm: new RemoteFileReproductionLlm(),
    logger,
    topK: 1,
  });

  assert.equal(reproductions[0].status, "blocked");
  assert.match(reproductions[0].blockedReason, /must not reference remote URLs/);
});

class RemoteFileReproductionLlm {
  async complete() {
    return JSON.stringify({
      summary: "A blocked plan that attempts to reference a public URL from generated test code.",
      files: [
        {
          path: "remote.test.mjs",
          content: "import test from 'node:test';\n\ntest('remote call', async () => {\n  await fetch('https://example.com');\n});\n",
        },
      ],
      commands: [
        {
          program: "node",
          args: ["--test", "remote.test.mjs"],
          cwd: ".",
          timeoutMs: 30000,
          expectedExitCode: 0,
        },
      ],
      successCriteria: ["This plan should be blocked before execution."],
      successPatterns: ["remote test should never run"],
      safetyNotes: ["Regression fixture for generated-file safety scanning."],
    });
  }
}

class ReproductionOnlyLlm {
  async complete() {
    return JSON.stringify({
      summary: "Create a local node test that proves the reproduction runner can execute inside the copied workspace.",
      files: [
        {
          path: "repro.test.mjs",
          content:
            "import assert from 'node:assert/strict';\nimport test from 'node:test';\n\ntest('local reproduction command runs in workspace', () => {\n  console.log('sandbox-home=' + process.env.HOME);\n  console.log('sandbox-user=' + (process.env.USER ?? 'unset'));\n  console.log('node-options=' + (process.env.NODE_OPTIONS ?? 'unset'));\n  assert.equal(2 + 2, 4);\n});\n",
        },
      ],
      commands: [
        {
          program: "node",
          args: ["--test", "repro.test.mjs"],
          cwd: ".",
          timeoutMs: 30000,
          expectedExitCode: 0,
        },
      ],
      successCriteria: ["node --test exits with status 0 in the copied workspace"],
      successPatterns: ["local reproduction command runs in workspace"],
      safetyNotes: ["local node test only"],
    });
  }
}

class NoPatternReproductionLlm {
  async complete() {
    return JSON.stringify({
      summary: "A local test exits successfully but does not expose a machine-checkable confirmation signal.",
      files: [
        {
          path: "repro.test.mjs",
          content:
            "import assert from 'node:assert/strict';\nimport test from 'node:test';\n\ntest('generic passing test', () => {\n  assert.equal(true, true);\n});\n",
        },
      ],
      commands: [
        {
          program: "node",
          args: ["--test", "repro.test.mjs"],
          cwd: ".",
          timeoutMs: 30000,
          expectedExitCode: 0,
        },
      ],
      successCriteria: ["A human can read this, but the runner cannot match it."],
      safetyNotes: ["local node test only"],
    });
  }
}

function mockFinding() {
  return {
    id: "mock-finding",
    location: "src/target.js:1",
    failureMode: "input_validation",
    title: "Mock executable finding",
    severity: "high",
    hitRate: 1,
    confidence: 0.9,
    score: 10,
    description: "A mock finding used to exercise the local reproduction runner.",
    evidence: "The mock source contains a visible test target.",
    exploitSketch: "A local test can demonstrate the behavior.",
    fix: "Add the missing check.",
    confirmationStatus: "confirmed-source",
  };
}

function mockVerification() {
  return {
    id: "mock-finding",
    verdict: "confirmed",
    confirmationStatus: "confirmed-source",
    markdown: "VERDICT: confirmed\n\nSource-level mock confirmation.",
  };
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
