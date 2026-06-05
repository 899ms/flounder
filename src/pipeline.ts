import type { AuditorConfig } from "./config.js";
import { aggregate } from "./audit/aggregate.js";
import { runAudit } from "./audit/runner.js";
import { enumerateAuditItems } from "./enumerate.js";
import { loadCorpus, loadSource } from "./ingest/source.js";
import { SourceIndex } from "./index/source-index.js";
import { mergeProjectContexts } from "./lens/context.js";
import { discoverLensPacks } from "./lens/discover.js";
import { createLlmClient } from "./llm/client.js";
import { profileProject } from "./profile/project.js";
import { renderDisclosure } from "./reports/disclosure.js";
import { summarizeChecklist, summarizeRun, summarizeSourceIndex } from "./reports/coverage.js";
import { deepenAuditItems } from "./rounds/deepen.js";
import { RunLogger } from "./trace/logger.js";
import type { AuditResult, AuditSummary, LlmClient } from "./types.js";
import { publicPath } from "./util/paths.js";
import { verifyTop } from "./verify/planner.js";

export interface PipelineResult {
  runDir: string;
  summary: AuditSummary;
}

export async function runPipeline(cfg: AuditorConfig, options: { verifyTopK?: number; llm?: LlmClient } = {}): Promise<PipelineResult> {
  const logger = new RunLogger(cfg.outputDir, cfg.targetName);
  await logger.init();
  await logger.event("run_start", {
    target: cfg.targetName,
    sourcePaths: cfg.sourcePaths.map((sourcePath) => publicPath(sourcePath)),
    corpusPaths: cfg.corpusPaths.map((corpusPath) => publicPath(corpusPath)),
    provider: cfg.provider,
    enumModel: cfg.enumModel,
    auditModel: cfg.auditModel,
    verifyModel: cfg.verifyModel,
    rounds: cfg.rounds,
    trials: cfg.trials,
    dryRun: cfg.dryRun,
  });

  const corpus = await loadCorpus(cfg.corpusPaths);
  const source = await loadSource(cfg.sourcePaths);
  const projectProfile = profileProject([...source, ...corpus]);
  const sourceIndex = new SourceIndex(source);
  await logger.event("knowledge_loaded", { corpusDocs: corpus.length, sourceDocs: source.length });
  await logger.artifact("project_profile.json", projectProfile);
  await logger.artifact("source_index.json", summarizeSourceIndex(source, sourceIndex.symbols));

  const llm = cfg.dryRun ? undefined : options.llm ?? createLlmClient(cfg, logger);
  if (llm && "setLogger" in llm && typeof llm.setLogger === "function") {
    llm.setLogger(logger);
  }
  const lensPacks = await discoverLensPacks({ cfg, corpus, source, projectProfile, ...(llm ? { llm } : {}), logger });
  const runCfg = {
    ...cfg,
    lensPacks,
    projectContext: mergeProjectContexts([cfg.projectContext, ...lensPacks.map((pack) => pack.projectContext)]),
  };
  const items = await enumerateAuditItems({ cfg: runCfg, corpus, source, projectProfile, ...(llm ? { llm } : {}), logger, round: 1 });
  await logger.artifact("checklist_coverage.json", summarizeChecklist(items));
  const results: AuditResult[] = [];
  const rounds = Math.max(1, Math.floor(runCfg.rounds));

  for (let round = 1; round <= rounds; round += 1) {
    await logger.event("round_start", { round });
    const roundItems =
      round === 1
        ? items.filter((item) => (item.round ?? 1) === 1)
        : await deepenAuditItems({
            cfg: runCfg,
            corpus,
            source,
            projectProfile,
            existingItems: items,
            results,
            round,
            ...(llm ? { llm } : {}),
            logger,
          });

    if (round > 1) items.push(...roundItems);
    if (roundItems.length === 0) {
      await logger.event("round_done", { round, newItems: 0, auditedItems: 0 });
      break;
    }

    const roundResults = await runAudit({
      cfg: runCfg,
      items: roundItems,
      source,
      corpus,
      ...(llm ? { llm } : {}),
      logger,
      artifactName: `round_${round}_audit_results.json`,
    });
    results.push(...roundResults);
    await logger.event("round_done", { round, newItems: roundItems.length, auditedItems: roundResults.length });
  }

  await logger.artifact("checklist.json", items);
  await logger.artifact("audit_results.json", results);
  await logger.artifact("checklist_coverage.json", summarizeChecklist(items));
  await logger.artifact("run_coverage.json", summarizeRun(items, results));
  const summary = aggregate(results);
  await logger.artifact("summary.json", summary);

  if (summary.findings.length > 0) {
    const verifications = await verifyTop({
      cfg: runCfg,
      findings: summary.findings,
      source,
      ...(llm ? { llm } : {}),
      logger,
      topK: options.verifyTopK ?? 3,
    });
    const byId = new Map(verifications.map((verification) => [verification.id, verification]));
    for (const finding of summary.findings.slice(0, options.verifyTopK ?? 3)) {
      await logger.artifact(`report_${finding.id}.md`, renderDisclosure(cfg.targetName, finding, byId.get(finding.id)));
    }
  }

  await logger.event("run_done", { findings: summary.findings.length });
  return { runDir: logger.runDir, summary };
}
