import { aggregate } from "../audit/aggregate.js";
import { buildDeepeningPrompt, DEEPEN_SYSTEM } from "../agents/prompts.js";
import type { AuditorConfig } from "../config.js";
import { effectiveFailureModes } from "../config.js";
import { assemble } from "../ingest/source.js";
import { auditItemKey, dedupeAuditItems, normalizeAuditItem, type RawAuditItem } from "../items.js";
import { renderProjectLearning } from "../learn/project.js";
import { renderLensPacks, renderProjectContext } from "../lens/context.js";
import { renderProjectProfile } from "../profile/project.js";
import type { AuditItem, AuditResult, Doc, ExplorationStrategy, LlmClient, ProjectLearning, ProjectProfile, RankedFinding } from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import { extractJsonArray } from "../util/json.js";

type DeepeningBranchStrategy = Exclude<ExplorationStrategy, "hybrid">;

export async function deepenAuditItems(input: {
  cfg: AuditorConfig;
  corpus: Doc[];
  source: Doc[];
  projectProfile?: ProjectProfile;
  projectLearning?: ProjectLearning;
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
  const nearMisses = collectNearMisses(input.results);
  const corpusText = assemble(input.corpus, Math.floor(input.cfg.contextCharBudget / 3));
  const sourceText = assemble(input.source, Math.floor(input.cfg.contextCharBudget / 2), true);
  const branches = planBranches(input.cfg.explorationStrategy, maxItems, currentSummary.findings.length > 0 || nearMisses.length > 0);
  const branchReports: Array<{
    strategy: DeepeningBranchStrategy;
    maxItems: number;
    proposed: number;
    uniqueProposed: number;
    accepted: number;
  }> = [];
  const proposedFromBranches: AuditItem[] = [];
  const commonPromptInput = {
    target: input.cfg.targetName,
    round: input.round,
    failureModes: effectiveFailureModes(input.cfg),
    projectProfile: input.projectProfile ? renderProjectProfile(input.projectProfile) : "",
    projectLearning: renderProjectLearning(input.projectLearning),
    projectContext: renderProjectContext(input.cfg.projectContext),
    lensPacks: renderLensPacks(input.cfg.lensPacks),
    existingChecklist: renderChecklist(input.existingItems),
    auditObservations: renderAuditObservations(input.results),
    nearMisses: renderNearMisses(nearMisses),
    currentFindings: renderFindings(currentSummary.findings),
    corpus: corpusText,
    source: sourceText,
  };

  for (const branch of branches) {
    const text = await input.llm.complete({
      tag: `deepen_round_${input.round}_${branch.strategy}`,
      system: DEEPEN_SYSTEM,
      user: buildDeepeningPrompt({
        ...commonPromptInput,
        strategy: branch.strategy,
        maxItems: branch.maxItems,
      }),
      model: input.cfg.enumModel,
      maxTokens: input.cfg.maxTokens,
      thinkingLevel: input.cfg.thinkingLevel,
    });
    const proposed = extractJsonArray<RawAuditItem>(text)
      .map((item) => normalizeAuditItem({ ...item, strategy: item.strategy ?? branch.strategy }, input.round))
      .filter((item): item is AuditItem => item !== undefined)
      .map((item) => ({ ...item, strategy: branch.strategy }));
    const deduped = dedupeAuditItems(proposed).slice(0, branch.maxItems);
    proposedFromBranches.push(...deduped);
    branchReports.push({
      strategy: branch.strategy,
      maxItems: branch.maxItems,
      proposed: proposed.length,
      uniqueProposed: deduped.length,
      accepted: 0,
    });
  }

  const dedupedProposed = dedupeAuditItems(proposedFromBranches);
  const existingKeys = new Set(input.existingItems.map(auditItemKey));
  const novelCandidates = dedupedProposed.filter((item) => !existingKeys.has(auditItemKey(item)));
  const novel = novelCandidates.slice(0, maxItems);
  const acceptedByStrategy = countByStrategy(novel);
  for (const report of branchReports) {
    report.accepted = acceptedByStrategy[report.strategy] ?? 0;
  }
  await input.logger.artifact(`round_${input.round}_deepening_items.json`, {
    round: input.round,
    strategy: input.cfg.explorationStrategy,
    maxItems,
    nearMisses: nearMisses.length,
    branches: branchReports,
    proposed: proposedFromBranches.length,
    uniqueProposed: dedupedProposed.length,
    repeated: dedupedProposed.length - novelCandidates.length,
    capped: Math.max(0, novelCandidates.length - novel.length),
    accepted: novel,
  });
  await input.logger.event("deepening_done", {
    round: input.round,
    strategy: input.cfg.explorationStrategy,
    proposed: proposedFromBranches.length,
    uniqueProposed: dedupedProposed.length,
    accepted: novel.length,
  });
  return novel;
}

function planBranches(strategy: ExplorationStrategy, maxItems: number, hasFindings: boolean): Array<{ strategy: DeepeningBranchStrategy; maxItems: number }> {
  if (strategy === "breadth") return [{ strategy: "breadth", maxItems }];
  if (strategy === "depth") return [{ strategy: "depth", maxItems }];
  if (maxItems <= 1) return [{ strategy: hasFindings ? "depth" : "breadth", maxItems }];

  const depthBudget = hasFindings ? Math.max(1, Math.floor(maxItems * 0.5)) : maxItems >= 4 ? Math.max(1, Math.floor(maxItems * 0.25)) : 0;
  const breadthBudget = maxItems - depthBudget;
  return [
    ...(breadthBudget > 0 ? [{ strategy: "breadth" as const, maxItems: breadthBudget }] : []),
    ...(depthBudget > 0 ? [{ strategy: "depth" as const, maxItems: depthBudget }] : []),
  ];
}

function countByStrategy(items: AuditItem[]): Partial<Record<DeepeningBranchStrategy, number>> {
  const out: Partial<Record<DeepeningBranchStrategy, number>> = {};
  for (const item of items) {
    if (item.strategy !== "breadth" && item.strategy !== "depth") continue;
    out[item.strategy] = (out[item.strategy] ?? 0) + 1;
  }
  return out;
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

function collectNearMisses(results: AuditResult[]): AuditResult[] {
  return results
    .filter((result) => result.nHits === 0)
    .map((result) => ({ result, trial: bestNoFindingTrial(result) }))
    .filter(({ trial }) => trial && NEAR_MISS_PATTERNS.some((pattern) => pattern.test([trial.title, trial.description, trial.evidence, trial.fix].join("\n"))))
    .sort((a, b) => (b.trial?.confidence ?? 0) - (a.trial?.confidence ?? 0))
    .slice(0, 16)
    .map(({ result }) => result);
}

const NEAR_MISS_PATTERNS = [
  /adjacent|neighboring|different edge|distinct edge|separate edge/i,
  /caller|callee|handoff|dominance|entrypoint|boundary/i,
  /selector|coverage|enabled|same row|same offset|rotation/i,
  /(row[- ]to[- ]row|adjacent[- ]row|current .*next|next .*current|local|internal|visible).{0,160}(same|equal|constant|preserve|enforce)/i,
  /(same|equal|constant|preserve|enforce).{0,160}(row[- ]to[- ]row|adjacent[- ]row|current .*next|next .*current|local|internal|visible)/i,
  /not shown|not visible|requires .*context|missing .*context/i,
  /hardening|defensive|would be to|preserve this pattern/i,
  /if the intended|if the concern|if .* intended/i,
];

function bestNoFindingTrial(result: AuditResult) {
  return result.trials
    .filter((trial) => !trial.finding)
    .sort((a, b) => b.confidence - a.confidence)[0];
}

function renderNearMisses(results: AuditResult[]): string {
  return results
    .map((result) => {
      const trial = bestNoFindingTrial(result);
      if (!trial) return "";
      const clue = [trial.description, trial.evidence, trial.fix].map(oneLine).join(" ").slice(0, 420);
      return `- round=${result.item.round ?? 1} id=${result.item.id} location=${result.item.location} property=${oneLine(result.item.securityProperty).slice(0, 180)} clue=${clue}`;
    })
    .filter(Boolean)
    .join("\n");
}

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
