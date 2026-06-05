import { aggregate } from "../audit/aggregate.js";
import { buildDeepeningPrompt, DEEPEN_SYSTEM } from "../agents/prompts.js";
import type { AuditorConfig } from "../config.js";
import { effectiveFailureModes } from "../config.js";
import { assemble } from "../ingest/source.js";
import { auditItemKey, dedupeAuditItems, normalizeAuditItem, type RawAuditItem } from "../items.js";
import { renderLensPacks, renderProjectContext } from "../lens/context.js";
import { renderProjectProfile } from "../profile/project.js";
import type { AuditItem, AuditResult, Doc, LlmClient, ProjectProfile, RankedFinding } from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import { extractJsonArray } from "../util/json.js";

export async function deepenAuditItems(input: {
  cfg: AuditorConfig;
  corpus: Doc[];
  source: Doc[];
  projectProfile?: ProjectProfile;
  existingItems: AuditItem[];
  results: AuditResult[];
  round: number;
  llm?: LlmClient;
  logger: RunLogger;
}): Promise<AuditItem[]> {
  if (input.cfg.dryRun || !input.llm) return [];

  const remainingBudget = remainingItemBudget(input.cfg.maxAuditItems, input.existingItems.length);
  if (remainingBudget === 0) {
    await input.logger.event("deepening_skipped", { round: input.round, reason: "max_audit_items_reached" });
    return [];
  }

  const maxItems = Math.max(1, Math.min(input.cfg.maxNewItemsPerRound, remainingBudget ?? input.cfg.maxNewItemsPerRound));
  const currentSummary = aggregate(input.results);
  const corpusText = assemble(input.corpus, Math.floor(input.cfg.contextCharBudget / 3));
  const sourceText = assemble(input.source, Math.floor(input.cfg.contextCharBudget / 2), true);
  const text = await input.llm.complete({
    tag: `deepen_round_${input.round}`,
    system: DEEPEN_SYSTEM,
    user: buildDeepeningPrompt({
      target: input.cfg.targetName,
      round: input.round,
      maxItems,
      failureModes: effectiveFailureModes(input.cfg),
      projectProfile: input.projectProfile ? renderProjectProfile(input.projectProfile) : "",
      projectContext: renderProjectContext(input.cfg.projectContext),
      lensPacks: renderLensPacks(input.cfg.lensPacks),
      existingChecklist: renderChecklist(input.existingItems),
      auditObservations: renderAuditObservations(input.results),
      currentFindings: renderFindings(currentSummary.findings),
      corpus: corpusText,
      source: sourceText,
    }),
    model: input.cfg.enumModel,
    maxTokens: input.cfg.maxTokens,
    thinkingLevel: input.cfg.thinkingLevel,
  });

  const proposed = extractJsonArray<RawAuditItem>(text).map((item) => normalizeAuditItem(item, input.round)).filter((item): item is AuditItem => item !== undefined);
  const dedupedProposed = dedupeAuditItems(proposed);
  const existingKeys = new Set(input.existingItems.map(auditItemKey));
  const novelCandidates = dedupedProposed.filter((item) => !existingKeys.has(auditItemKey(item)));
  const novel = novelCandidates.slice(0, maxItems);
  await input.logger.artifact(`round_${input.round}_deepening_items.json`, {
    round: input.round,
    proposed: proposed.length,
    uniqueProposed: dedupedProposed.length,
    repeated: dedupedProposed.length - novelCandidates.length,
    capped: Math.max(0, novelCandidates.length - novel.length),
    accepted: novel,
  });
  await input.logger.event("deepening_done", {
    round: input.round,
    proposed: proposed.length,
    uniqueProposed: dedupedProposed.length,
    accepted: novel.length,
  });
  return novel;
}

function remainingItemBudget(maxAuditItems: number | undefined, existingCount: number): number | undefined {
  if (typeof maxAuditItems !== "number" || !Number.isFinite(maxAuditItems) || maxAuditItems < 1) return undefined;
  return Math.max(0, Math.floor(maxAuditItems) - existingCount);
}

function renderChecklist(items: AuditItem[]): string {
  return items
    .slice(0, 120)
    .map((item) => `- round=${item.round ?? 1} id=${item.id} mode=${item.failureMode} location=${item.location} property=${item.securityProperty}`)
    .join("\n");
}

function renderAuditObservations(results: AuditResult[]): string {
  return results
    .slice(-80)
    .map((result) => {
      const bestHit = result.trials
        .filter((trial) => trial.finding)
        .sort((a, b) => b.confidence - a.confidence)[0];
      const status = result.nHits > 0 ? `hitRate=${round(result.hitRate)} severity=${bestHit?.severity ?? "info"}` : "no-finding";
      const evidence = bestHit?.evidence ? ` evidence=${oneLine(bestHit.evidence).slice(0, 240)}` : "";
      return `- round=${result.item.round ?? 1} id=${result.item.id} ${status} location=${result.item.location}${evidence}`;
    })
    .join("\n");
}

function renderFindings(findings: RankedFinding[]): string {
  return findings
    .slice(0, 20)
    .map(
      (finding) =>
        `- id=${finding.id} severity=${finding.severity} confidence=${finding.confidence} location=${finding.location} title=${oneLine(finding.title).slice(0, 180)}`,
    )
    .join("\n");
}

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
