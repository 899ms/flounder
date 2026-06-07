import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunLogger } from "../dist/trace/logger.js";

test("run logger rejects artifact paths outside the run directory", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-logger-"));
  const logger = new RunLogger(out, "logger-paths");
  await logger.init();

  await assert.rejects(
    () => logger.artifact("../escape.json", "{}"),
    /Unsafe artifact path/,
  );
  await assert.rejects(
    () => logger.artifact(path.join("..", "escape.json"), "{}"),
    /Unsafe artifact path/,
  );
});
