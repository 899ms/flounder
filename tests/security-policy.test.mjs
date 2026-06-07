import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCommandSafety, analyzeReproductionCommandSafety } from "../dist/security/policy.js";

test("command safety policy blocks live-network broadcast-like commands", () => {
  const decision = analyzeCommandSafety("zcash-cli -testnet sendrawtransaction poc");
  assert.equal(decision.blocked, true);
  assert.match(decision.reason, /local-only/i);
  assert.equal(decision.matchedNetwork?.toLowerCase(), "testnet");
  assert.equal(decision.matchedAction?.toLowerCase(), "sendrawtransaction");
});

test("command safety policy allows local-only reproductions", () => {
  assert.equal(analyzeCommandSafety("cargo test local_regtest_poc").blocked, false);
  assert.equal(analyzeCommandSafety("zcash-cli -regtest sendrawtransaction fixture").blocked, false);
});

test("reproduction command policy allows only structured local test commands", () => {
  assert.equal(analyzeReproductionCommandSafety({ program: "cargo", args: ["test", "local_regtest_poc"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "node", args: ["--test", "repro.test.mjs"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "forge", args: ["test", "--match-test", "testLocalRepro"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "npx", args: ["hardhat", "test", "test/repro.ts"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "zcash-cli", args: ["-testnet", "sendrawtransaction", "poc"] }).blocked, true);
  assert.equal(analyzeReproductionCommandSafety({ program: "bash", args: ["-lc", "cargo test"] }).blocked, true);
  assert.equal(analyzeReproductionCommandSafety({ program: "cargo;curl", args: ["test"] }).blocked, true);
});

test("reproduction command policy keeps Solidity fork and network targets local-only", () => {
  assert.equal(
    analyzeReproductionCommandSafety({ program: "forge", args: ["test", "--fork-url", "https://eth.llamarpc.com"] }).blocked,
    true,
  );
  assert.equal(
    analyzeReproductionCommandSafety({ program: "forge", args: ["test", "--fork-url", "http://127.0.0.1:8545"] }).blocked,
    false,
  );
  assert.equal(
    analyzeReproductionCommandSafety({ program: "npx", args: ["hardhat", "test", "--network", "sepolia"] }).blocked,
    true,
  );
  assert.equal(
    analyzeReproductionCommandSafety({ program: "npx", args: ["hardhat", "test", "--network", "hardhat"] }).blocked,
    false,
  );
  assert.equal(
    analyzeReproductionCommandSafety({ program: "forge", args: ["test", "--fork-url", "$MAINNET_RPC_URL"] }).blocked,
    true,
  );
});
