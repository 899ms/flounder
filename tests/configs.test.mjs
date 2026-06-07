import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(".");
const configDir = path.join(root, "configs");

test("default hunting config templates are publication-safe and model-backed", async () => {
  const files = (await readdir(configDir)).filter((file) => file.endsWith(".json"));
  assert.ok(files.includes("vulnerability-hunt.default.json"));
  assert.ok(files.includes("zk-constraint-hunt.default.json"));
  assert.ok(files.includes("solidity-contract-hunt.default.json"));

  for (const file of files) {
    const body = await readFile(path.join(configDir, file), "utf8");
    const config = JSON.parse(body);
    assert.equal(body.includes(root), false, `${file} includes a local absolute path`);
    assert.deepEqual(config.sourcePaths, [], `${file} should not publish target-local source paths`);
    assert.deepEqual(config.corpusPaths, [], `${file} should not publish target-local corpus paths`);
    assert.equal(config.localChecklistSeeders, false, `${file} must keep local seeders disabled for live discovery`);
    assert.equal(config.projectLearning, true, `${file} should learn target context before enumeration`);
    assert.equal(config.dynamicLensDiscovery, true, `${file} should discover target-specific lenses`);
    assert.equal(config.portfolioEnumeration, true, `${file} should keep portfolio enumeration enabled`);
    assert.equal(config.scopeMode, "augment", `${file} should treat configured lenses as guidance by default`);
    assert.ok(config.baselineExplorationShare > 0, `${file} should reserve some room for lens-free baseline exploration`);
    assert.equal(config.highImpactVerification, true, `${file} should force high-impact findings through follow-up`);
    assert.ok(config.highImpactMaxFindings >= 24, `${file} should budget high-impact verification beyond normal topK`);
    assert.equal(config.reproductionMode, "off", `${file} should not run or plan PoC by default`);
    assert.ok(config.rounds >= 2, `${file} should leave budget for deepening rounds`);
    assert.ok(config.trials >= 4, `${file} should use multiple audit trials`);
    assert.ok(config.maxAuditItems > config.maxNewItemsPerRound, `${file} should reserve budget across rounds`);
  }
});

test("Solidity contract hunting config includes EVM-specific audit lenses", async () => {
  const body = await readFile(path.join(configDir, "solidity-contract-hunt.default.json"), "utf8");
  const config = JSON.parse(body);
  const lensIds = new Set(config.lensPacks.map((pack) => pack.id));
  const modes = new Set(config.lensPacks.flatMap((pack) => pack.failureModes ?? []));
  const agents = new Set(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).map((agent) => agent.failureMode));

  assert.ok(lensIds.has("evm-value-share-accounting"));
  assert.ok(lensIds.has("evm-upgradeability-storage"));
  assert.ok(lensIds.has("evm-oracle-market-manipulation"));
  assert.ok(lensIds.has("evm-signatures-permits-delegation"));
  assert.ok(lensIds.has("evm-lending-liquidation-solvency"));

  assert.ok(modes.has("evm_token_accounting"));
  assert.ok(modes.has("evm_vault_share_accounting"));
  assert.ok(modes.has("evm_upgradeability_storage"));
  assert.ok(modes.has("evm_oracle_manipulation"));
  assert.ok(modes.has("evm_bridge_message_replay"));
  assert.ok(modes.has("evm_liquidation_solvency"));

  assert.ok(agents.has("evm_token_accounting"));
  assert.ok(agents.has("evm_upgradeability_storage"));
  assert.ok(agents.has("evm_oracle_manipulation"));
  assert.ok(config.projectContext.focusAreas.some((area) => /cross-chain/i.test(area)));
});
