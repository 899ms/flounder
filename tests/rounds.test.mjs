import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { deepenAuditItems } from "../dist/rounds/deepen.js";

test("deepening accepts only novel follow-up items", async () => {
  const cfg = defaultConfig();
  cfg.targetName = "round-test";
  cfg.maxNewItemsPerRound = 5;
  const existing = {
    id: "existing",
    location: "src/circuit.rs:10-12",
    securityProperty: "Advice cell is constrained to its intended source.",
    failureMode: "missing_constraint",
    why: "Initial item.",
    round: 1,
  };
  const artifacts = new Map();
  const events = [];
  const logger = {
    async artifact(name, value) {
      artifacts.set(name, value);
      return name;
    },
    async event(kind, data) {
      events.push({ kind, data });
    },
  };
  const llm = {
    async complete() {
      return JSON.stringify([
        {
          id: "duplicate",
          location: "src/circuit.rs:10-12",
          securityProperty: "Advice cell is constrained to its intended source.",
          failureMode: "missing_constraint",
          why: "This repeats round 1 and must be dropped.",
        },
        {
          id: "novel",
          location: "src/circuit.rs:40-45",
          securityProperty: "The downstream accumulator is bound to the copied advice cell.",
          failureMode: "missing_constraint",
          why: "This follows a neighboring data-flow edge not covered in round 1.",
        },
      ]);
    },
  };

  const items = await deepenAuditItems({
    cfg,
    corpus: [],
    source: [{ path: "src/circuit.rs", content: "fn circuit() {}", kind: "source" }],
    existingItems: [existing],
    results: [],
    round: 2,
    llm,
    logger,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].id, "novel");
  assert.equal(items[0].round, 2);
  const artifact = artifacts.get("round_2_deepening_items.json");
  assert.equal(artifact.repeated, 1);
  assert.equal(artifact.accepted.length, 1);
  assert.ok(events.some((event) => event.kind === "deepening_done" && event.data.accepted === 1));
});
