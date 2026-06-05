import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LlmClient } from "../types.js";
import type { RunLogger } from "../trace/logger.js";

export class CodexCliClient implements LlmClient {
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
    const tmp = await mkdtemp(path.join(os.tmpdir(), "fsa-codex-cli-"));
    const outputFile = path.join(tmp, "last-message.txt");
    const prompt = renderPrompt(input.system, input.user);
    const args = [
      "exec",
      "--model",
      input.model,
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--cd",
      tmp,
      "--output-last-message",
      outputFile,
      "-",
    ];
    if (input.thinkingLevel) {
      args.splice(1, 0, "-c", `model_reasoning_effort="${input.thinkingLevel}"`);
    }

    try {
      await spawnCodex(args, prompt, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: Number(process.env.FSA_CODEX_TIMEOUT_MS ?? 900_000),
      });
      const text = await readFile(outputFile, "utf8");
      await this.logger?.call({
        tag: input.tag,
        model: `codex-cli/${input.model}`,
        system: input.system,
        user: input.user,
        response: text,
      });
      if (text.trim().length === 0) throw new Error(`codex-cli returned no text: model=${input.model}`);
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logger?.call({
        tag: input.tag,
        model: `codex-cli/${input.model}`,
        system: input.system,
        user: input.user,
        response: "",
        meta: { error: message },
      });
      throw new Error(`codex-cli completion failed: ${message}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

function renderPrompt(system: string, user: string): string {
  return `You are acting as a non-interactive language model inside an audit pipeline.
Do not run tools, inspect files, or rely on external context. Answer only from the text below.

System instructions:
${system}

User task:
${user}
`;
}

function spawnCodex(args: string[], input: string, options: { maxBuffer: number; timeout: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`codex-cli timed out after ${options.timeout}ms`));
    }, options.timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk, options.maxBuffer);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, options.maxBuffer);
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
        resolve();
      } else {
        reject(new Error(`codex exited with code ${code}: ${(stderr || stdout).slice(0, 2000)}`));
      }
    });
    child.stdin.end(input);
  });
}

function appendBounded(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}
