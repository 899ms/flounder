import os from "node:os";
import type { AuditorConfig } from "../config.js";
import { effectiveAuditorAgents } from "../config.js";
import { AUDIT_SYSTEM, buildAuditPrompt } from "../agents/prompts.js";
import { createAgentRegistry } from "../agents/registry.js";
import { SourceIndex } from "../index/source-index.js";
import { renderProjectLearning } from "../learn/project.js";
import { renderAuditGuidanceForFailureMode } from "../lens/context.js";
import { buildAuditContext, type AuditContextResult } from "../retrieval/context.js";
import type { AuditItem, AuditResult, Doc, LlmClient, ProjectLearning, TrialFinding } from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import { extractJsonObject } from "../util/json.js";

export async function runAudit(input: {
  cfg: AuditorConfig;
  items: AuditItem[];
  source: Doc[];
  corpus?: Doc[];
  projectLearning?: ProjectLearning;
  llm?: LlmClient;
  logger: RunLogger;
  artifactName?: string;
}): Promise<AuditResult[]> {
  if (input.cfg.dryRun || !input.llm) {
    const dry = input.items.map((item) => ({
      item,
      nTrials: 0,
      nHits: 0,
      hitRate: 0,
      trials: [],
    }));
    await input.logger.artifact(input.artifactName ?? "audit_results.json", dry);
    return dry;
  }

  const index = new SourceIndex(input.source);
  const agentRegistry = createAgentRegistry(effectiveAuditorAgents(input.cfg));
  const contextTraces: AuditContextResult["trace"][] = [];
  const results = await mapLimit(input.items, input.cfg.maxWorkers, async (item) =>
    auditItem({
      cfg: input.cfg,
      item,
      index,
      agentRegistry,
      projectLearning: input.projectLearning,
      llm: input.llm!,
      logger: input.logger,
      contextTraces,
    }),
  );
  await input.logger.artifact(
    contextArtifactName(input.artifactName),
    contextTraces.sort((a, b) => a.itemId.localeCompare(b.itemId)),
  );
  await input.logger.artifact(input.artifactName ?? "audit_results.json", results);
  return results;
}

async function auditItem(input: {
  cfg: AuditorConfig;
  item: AuditItem;
  index: SourceIndex;
  agentRegistry: ReturnType<typeof createAgentRegistry>;
  projectLearning: ProjectLearning | undefined;
  llm: LlmClient;
  logger: RunLogger;
  contextTraces: AuditContextResult["trace"][];
}): Promise<AuditResult> {
  const contextResult = await buildAuditContext({ cfg: input.cfg, index: input.index, item: input.item });
  input.contextTraces.push(contextResult.trace);
  if (contextResult.trace.qmd && !contextResult.trace.qmd.available) {
    await input.logger.event("qmd_unavailable", { id: input.item.id, error: contextResult.trace.qmd.error });
  }
  const sourceContext = contextResult.context;
  const lensGuidance = renderAuditGuidanceForFailureMode(input.cfg.lensPacks, input.item.failureMode);
  const user = buildAuditPrompt(input.item, sourceContext, input.agentRegistry, lensGuidance, renderProjectLearning(input.projectLearning));
  const trials = await mapLimit(
    Array.from({ length: input.cfg.trials }, (_, idx) => idx),
    Math.min(input.cfg.trials, Math.max(1, Math.floor(os.cpus().length / 2))),
    async (trial) => {
      try {
        const text = await input.llm.complete({
          tag: `audit_${input.item.id}_t${trial}`,
          system: AUDIT_SYSTEM,
          user,
          model: input.cfg.auditModel,
          maxTokens: input.cfg.maxTokens,
          thinkingLevel: input.cfg.thinkingLevel,
        });
        return parseFinding(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await input.logger.event("trial_error", { id: input.item.id, trial, error: message.slice(0, 500) });
        return {
          finding: false,
          title: "Model call failed",
          severity: "info",
          confidence: 0,
          description: "The model provider failed for this trial; this item needs to be retried before drawing a conclusion.",
          evidence: "",
          exploitSketch: "",
          fix: "",
          modelError: true,
          raw: message.slice(0, 4000),
        } satisfies TrialFinding;
      }
    },
  );
  const hits = trials.filter((trial) => trial.finding);
  const result = {
    item: input.item,
    nTrials: trials.length,
    nHits: hits.length,
    hitRate: hits.length / Math.max(1, trials.length),
    trials,
  };
  await input.logger.event("item_done", { id: input.item.id, hitRate: result.hitRate });
  return result;
}

function contextArtifactName(auditArtifactName: string | undefined): string {
  if (!auditArtifactName || auditArtifactName === "audit_results.json") return "context_retrieval.json";
  return auditArtifactName.replace(/audit_results\.json$/, "context_retrieval.json");
}

function parseFinding(text: string): TrialFinding {
  const parsed = extractJsonObject<Partial<TrialFinding>>(text);
  if (!parsed) {
    return {
      finding: false,
      title: "Parse error",
      severity: "info",
      confidence: 0,
      description: "The model did not return valid JSON.",
      evidence: "",
      exploitSketch: "",
      fix: "",
      parseError: true,
      raw: text.slice(0, 4000),
    };
  }
  return {
    finding: Boolean(parsed.finding),
    title: String(parsed.title ?? ""),
    severity: normalizeSeverity(parsed.severity),
    confidence: normalizeConfidence(parsed.confidence),
    description: String(parsed.description ?? ""),
    evidence: String(parsed.evidence ?? ""),
    exploitSketch: String(parsed.exploitSketch ?? ""),
    fix: String(parsed.fix ?? ""),
  };
}

function normalizeSeverity(value: unknown): TrialFinding["severity"] {
  if (value === "critical" || value === "high" || value === "medium" || value === "low" || value === "info") return value;
  return "info";
}

function normalizeConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const current = items[idx];
      idx += 1;
      if (current !== undefined) out.push(await fn(current));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, () => worker()));
  return out;
}
