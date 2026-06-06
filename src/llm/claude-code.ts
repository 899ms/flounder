import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LlmClient } from "../types.js";
import type { RunLogger } from "../trace/logger.js";

export class ClaudeCodeClient implements LlmClient {
  constructor(private readonly logger?: RunLogger) {}

  async complete(input: {
    tag: string;
    system: string;
    user: string;
    model?: string;
    maxTokens?: number;
    thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
  }): Promise<string> {
    if (!input.model) throw new Error("model is required");
    const tmp = await mkdtemp(path.join(os.tmpdir(), "fsa-claude-code-"));
    const system = renderSystemPrompt(input.system);
    const args = [
      "-p",
      "--model",
      input.model,
      "--effort",
      effortFor(input.thinkingLevel),
      "--system-prompt",
      system,
      "--output-format",
      "json",
      "--tools",
      "",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
    ];

    try {
      const stdout = await spawnClaude(args, input.user, {
        cwd: tmp,
        maxBuffer: 20 * 1024 * 1024,
        timeout: Number(process.env.FSA_CLAUDE_CODE_TIMEOUT_MS ?? 900_000),
      });
      const { text, meta } = parseClaudeOutput(stdout);
      await this.logger?.call({
        tag: input.tag,
        model: `claude-code/${input.model}`,
        system: input.system,
        user: input.user,
        response: text,
        meta,
      });
      if (text.trim().length === 0) throw new Error(`claude-code returned no text: model=${input.model}`);
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logger?.call({
        tag: input.tag,
        model: `claude-code/${input.model}`,
        system: input.system,
        user: input.user,
        response: "",
        meta: { error: message },
      });
      throw new Error(`claude-code completion failed: ${message}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

function renderSystemPrompt(system: string): string {
  return `You are acting as a non-interactive language model inside an audit pipeline.
Do not run tools, inspect files, or rely on external context. Answer only from the text below.
Return only the exact response format requested by the user task. Do not include markdown fences, preambles, or reasoning prose outside that requested format.

System instructions:
${system}
`;
}

function effortFor(level: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined): "low" | "medium" | "high" | "max" {
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium") return "medium";
  if (level === "high") return "high";
  return "max";
}

function parseClaudeOutput(stdout: string): { text: string; meta: Record<string, unknown> } {
  const parsed = JSON.parse(stdout) as { result?: unknown; modelUsage?: unknown; usage?: unknown; total_cost_usd?: unknown; session_id?: unknown };
  return {
    text: typeof parsed.result === "string" ? parsed.result : "",
    meta: {
      ...(parsed.modelUsage !== undefined ? { modelUsage: parsed.modelUsage } : {}),
      ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
      ...(parsed.total_cost_usd !== undefined ? { totalCostUsd: parsed.total_cost_usd } : {}),
      ...(parsed.session_id !== undefined ? { sessionId: parsed.session_id } : {}),
    },
  };
}

function spawnClaude(args: string[], input: string, options: { cwd: string; maxBuffer: number; timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`claude-code timed out after ${options.timeout}ms`));
    }, options.timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk, options.maxBuffer);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, options.maxBuffer);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude exited with code ${code}: ${(stderr || stdout).slice(0, 2000)}`));
      }
    });
    child.stdin.end(input);
  });
}

function appendBounded(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}
