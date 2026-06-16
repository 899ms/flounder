import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(".");
const configDir = path.join(root, "configs");

test("default audit config templates are publication-safe and audit-shaped", async () => {
  const files = (await readdir(configDir)).filter((file) => file.endsWith(".json"));
  assert.ok(files.includes("vulnerability-audit.default.json"));
  assert.ok(files.includes("zk-constraint-audit.default.json"));
  assert.ok(files.includes("solidity-contract-audit.default.json"));
  assert.ok(files.includes("cairo-starknet-audit.default.json"));

  for (const file of files) {
    const body = await readFile(path.join(configDir, file), "utf8");
    const config = JSON.parse(body);
    assert.equal(body.includes(root), false, `${file} includes a local absolute path`);
    assert.deepEqual(config.sourcePaths, [], `${file} should not publish target-local source paths`);
    assert.deepEqual(config.corpusPaths, [], `${file} should not publish target-local corpus paths`);
    // audit scope hints live in projectContext; no staged-pipeline knobs should remain.
    assert.ok(config.projectContext && typeof config.projectContext === "object", `${file} should carry projectContext scope hints`);
    for (const stale of ["lensPacks", "failureModes", "rounds", "trials", "scopeMode", "reproductionMode"]) {
      assert.ok(!(stale in config), `${file} must not carry the removed staged-pipeline field "${stale}"`);
    }
  }
});

test("domain audit configs carry domain-specific scope focus areas", async () => {
  const cairo = JSON.parse(await readFile(path.join(configDir, "cairo-starknet-audit.default.json"), "utf8"));
  assert.ok(cairo.projectContext.focusAreas.some((area) => /Starknet/i.test(area)));

  const solidity = JSON.parse(await readFile(path.join(configDir, "solidity-contract-audit.default.json"), "utf8"));
  assert.ok(solidity.projectContext.focusAreas.some((area) => /cross-chain/i.test(area)));
});
