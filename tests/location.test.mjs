import assert from "node:assert/strict";
import test from "node:test";
import { locationContainsLine, parseLocationRanges } from "../dist/util/location.js";

test("location parser handles multi-range locations with omitted path continuations", () => {
  const ranges = parseLocationRanges("external/incomplete.rs:121-163,254-267,269-370");
  assert.deepEqual(ranges, [
    { pathHint: "external/incomplete.rs", startLine: 121, endLine: 163 },
    { pathHint: "external/incomplete.rs", startLine: 254, endLine: 267 },
    { pathHint: "external/incomplete.rs", startLine: 269, endLine: 370 },
  ]);
  assert.equal(locationContainsLine("external/incomplete.rs:121-163,254-267,269-370", 309, /incomplete\.rs/), true);
  assert.equal(locationContainsLine("external/incomplete.rs:121-163,254-267,269-370", 240, /incomplete\.rs/), false);
  assert.equal(locationContainsLine("external/incomplete.rs:121-163,254-267,269-370", 309, /other\.rs/), false);
});

test("location parser handles semicolon-separated files", () => {
  const ranges = parseLocationRanges("external/mul.rs:164-224; external/chip.rs:483-492");
  assert.deepEqual(ranges, [
    { pathHint: "external/mul.rs", startLine: 164, endLine: 224 },
    { pathHint: "external/chip.rs", startLine: 483, endLine: 492 },
  ]);
  assert.equal(locationContainsLine("external/mul.rs:164-224; external/chip.rs:483-492", 488, /chip\.rs/), true);
  assert.equal(locationContainsLine("external/mul.rs:164-224; external/chip.rs:483-492", 488, /mul\.rs/), false);
});
