import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { createLlmClient } from "../dist/llm/client.js";
import { ClaudeCodeClient } from "../dist/llm/claude-code.js";
import { CodexCliClient } from "../dist/llm/codex-cli.js";
import { PiAiClient } from "../dist/llm/pi-ai.js";
import { RunLogger } from "../dist/trace/logger.js";

test("llm factory uses pi-ai by default and CLI fallbacks only when requested", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-llm-client-"));
  const logger = new RunLogger(out, "factory-test");
  const cfg = defaultConfig();

  assert.ok(createLlmClient(cfg, logger) instanceof PiAiClient);
  cfg.provider = "codex-cli";
  assert.ok(createLlmClient(cfg, logger) instanceof CodexCliClient);
  cfg.provider = "claude-code";
  assert.ok(createLlmClient(cfg, logger) instanceof ClaudeCodeClient);
});
