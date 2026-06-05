import assert from "node:assert/strict";
import test from "node:test";
import { SourceIndex } from "../dist/index/source-index.js";

test("source index expands comma-separated line ranges for one file", () => {
  const doc = makeDoc("external/incomplete.rs", 380, {
    181: "line 181 q_mul_2 selector start",
    254: "line 254 middle accumulator transition",
    309: "line 309 assign_advice x_p",
    310: "line 310 assign_advice y_p",
  });
  const index = new SourceIndex([doc]);
  const context = index.contextForItem(
    {
      id: "multi-range",
      location: "external/incomplete.rs:181-209,254-267,297-362",
      securityProperty: "Assigned advice cells are constrained to the intended source values.",
      failureMode: "missing_constraint",
      why: "Model returned a multi-range location.",
    },
    100_000,
  );

  assert.match(context, /line 181 q_mul_2 selector start/);
  assert.match(context, /line 254 middle accumulator transition/);
  assert.match(context, /line 309 assign_advice x_p/);
  assert.match(context, /line 310 assign_advice y_p/);
});

test("source index accepts repeated file names in multi-range locations", () => {
  const doc = makeDoc("src/circuit.rs", 80, {
    12: "line 12 witness input",
    42: "line 42 constraint gate",
  });
  const index = new SourceIndex([doc]);
  const context = index.contextForItem(
    {
      id: "repeated-path",
      location: "src/circuit.rs:12-13, src/circuit.rs:42-44",
      securityProperty: "Witness assignments are bound to constraints.",
      failureMode: "missing_constraint",
      why: "Model returned two explicit ranges.",
    },
    100_000,
  );

  assert.match(context, /line 12 witness input/);
  assert.match(context, /line 42 constraint gate/);
});

function makeDoc(path, lineCount, overrides) {
  const lines = Array.from({ length: lineCount }, (_, idx) => `line ${idx + 1}`);
  for (const [line, text] of Object.entries(overrides)) {
    lines[Number(line) - 1] = text;
  }
  return {
    path,
    content: lines.join("\n"),
    kind: "source",
  };
}
