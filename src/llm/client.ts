import type { AuditorConfig } from "../config.js";
import type { RunLogger } from "../trace/logger.js";
import type { LlmClient } from "../types.js";
import { ClaudeCodeClient } from "./claude-code.js";
import { CodexCliClient } from "./codex-cli.js";
import { PiAiClient } from "./pi-ai.js";

export function createLlmClient(cfg: AuditorConfig, logger: RunLogger): LlmClient {
  if (cfg.provider === "claude-code") return new ClaudeCodeClient(logger);
  if (cfg.provider === "codex-cli") return new CodexCliClient(logger);
  return new PiAiClient(cfg.provider, logger);
}
