import type { AuditorConfig } from "./config.js";
import { effectiveFailureModes } from "./config.js";
import { buildEnumerationPrompt, ENUM_SYSTEM } from "./agents/prompts.js";
import { assemble } from "./ingest/source.js";
import { renderLensPacks, renderProjectContext } from "./lens/context.js";
import { renderProjectProfile } from "./profile/project.js";
import { runSeeders } from "./seeders/index.js";
import type { AuditItem, Doc, LlmClient, ProjectProfile } from "./types.js";
import { extractJsonArray } from "./util/json.js";
import type { RunLogger } from "./trace/logger.js";
import { dedupeAuditItems, normalizeAuditItem, type RawAuditItem } from "./items.js";

export async function enumerateAuditItems(input: {
  cfg: AuditorConfig;
  corpus: Doc[];
  source: Doc[];
  projectProfile?: ProjectProfile;
  llm?: LlmClient;
  logger: RunLogger;
  round?: number;
}): Promise<AuditItem[]> {
  const round = input.round ?? 1;
  const seeded = input.cfg.localChecklistSeeders ? runSeeders(input.source).map((item) => ({ ...item, round })) : [];
  await input.logger.event("seeders_done", { round, enabled: input.cfg.localChecklistSeeders, nItems: seeded.length });

  if (input.cfg.dryRun || !input.llm) {
    await input.logger.artifact("checklist.json", seeded);
    return seeded;
  }

  const corpusText = assemble(input.corpus, Math.floor(input.cfg.contextCharBudget / 2));
  const sourceText = assemble(input.source, Math.floor(input.cfg.contextCharBudget / 2), true);
  const user = buildEnumerationPrompt({
    target: input.cfg.targetName,
    failureModes: effectiveFailureModes(input.cfg),
    projectProfile: input.projectProfile ? renderProjectProfile(input.projectProfile) : "",
    projectContext: renderProjectContext(input.cfg.projectContext),
    lensPacks: renderLensPacks(input.cfg.lensPacks),
    corpus: corpusText,
    source: sourceText,
  });
  const text = await input.llm.complete({
    tag: "enumerate",
    system: ENUM_SYSTEM,
    user,
    model: input.cfg.enumModel,
    maxTokens: input.cfg.maxTokens,
    thinkingLevel: input.cfg.thinkingLevel,
  });

  const llmItems = extractJsonArray<RawAuditItem>(text).map((item) => normalizeAuditItem(item, round)).filter((item): item is AuditItem => item !== undefined);
  const deduped = dedupeAuditItems([...seeded, ...llmItems]);
  const all = limitItems(deduped, input.cfg.maxAuditItems);
  if (all.length < deduped.length) {
    await input.logger.event("enumeration_limited", {
      maxAuditItems: input.cfg.maxAuditItems,
      before: deduped.length,
      after: all.length,
    });
  }
  await input.logger.artifact("checklist.json", all);
  await input.logger.event("enumeration_done", { seeded: seeded.length, llm: llmItems.length, deduped: deduped.length, total: all.length });
  return all;
}

function limitItems(items: AuditItem[], maxAuditItems: number | undefined): AuditItem[] {
  if (typeof maxAuditItems !== "number" || !Number.isFinite(maxAuditItems) || maxAuditItems < 1) return items;
  return items.slice(0, Math.floor(maxAuditItems));
}
