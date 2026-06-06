import type { AuditorConfig } from "../config.js";
import type { AuditItem } from "../types.js";
import { type ContextTrace, renderContextSlices, SourceIndex } from "../index/source-index.js";
import { retrieveWithQmd, type QmdRetrievalResult } from "./qmd.js";

export interface AuditContextResult {
  context: string;
  trace: ContextTrace & {
    itemId: string;
    mode: AuditorConfig["contextRetrieval"];
    qmd?: {
      available: boolean;
      query: string;
      collections: string[];
      hits: Array<{ path: string; score?: number; line?: number; title?: string }>;
      error?: string;
    };
  };
}

export async function buildAuditContext(input: {
  cfg: AuditorConfig;
  index: SourceIndex;
  item: AuditItem;
}): Promise<AuditContextResult> {
  if (input.cfg.contextRetrieval !== "source-index+qmd") {
    const trace = input.index.contextForItemWithTrace(input.item, input.cfg.contextCharBudget);
    return { context: trace.context, trace: { ...trace, itemId: input.item.id, mode: input.cfg.contextRetrieval } };
  }

  const sourceBudget = Math.max(4_000, Math.floor(input.cfg.contextCharBudget * 0.82));
  const qmdBudget = Math.max(0, input.cfg.contextCharBudget - sourceBudget);
  const sourceTrace = input.index.contextForItemWithTrace(input.item, sourceBudget);
  const qmd = await retrieveWithQmd(input.item, input.index.docs, {
    command: input.cfg.qmdCommand,
    limit: input.cfg.qmdLimit,
    minScore: input.cfg.qmdMinScore,
    timeoutMs: input.cfg.qmdTimeoutMs,
    collections: input.cfg.qmdCollections,
  });
  const qmdTrace = qmdBudget > 0 ? renderContextSlices(qmd.slices, qmdBudget) : renderContextSlices([], 0);
  const context = [sourceTrace.context, qmdTrace.context].filter(Boolean).join("\n");

  return {
    context,
    trace: {
      ...sourceTrace,
      context,
      itemId: input.item.id,
      mode: input.cfg.contextRetrieval,
      budget: input.cfg.contextCharBudget,
      usedChars: sourceTrace.usedChars + qmdTrace.usedChars,
      truncated: sourceTrace.truncated || qmdTrace.truncated,
      slices: [
        ...sourceTrace.slices,
        ...qmdTrace.slices.map((slice) => ({
          ...slice,
          reason: `qmd: ${slice.reason}`,
        })),
      ],
      qmd: summarizeQmd(qmd),
    },
  };
}

function summarizeQmd(result: QmdRetrievalResult): NonNullable<AuditContextResult["trace"]["qmd"]> {
  return {
    available: result.available,
    query: result.query,
    collections: result.collections,
    hits: result.hits.map((hit) => ({
      path: hit.path,
      ...(hit.score !== undefined ? { score: hit.score } : {}),
      ...(hit.line !== undefined ? { line: hit.line } : {}),
      ...(hit.title !== undefined ? { title: hit.title } : {}),
    })),
    ...(result.error ? { error: result.error } : {}),
  };
}
