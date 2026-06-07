import type { AuditResult, AuditSummary, RankedFinding, Severity, TrialFinding } from "../types.js";
import { assessImpact } from "./impact.js";

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export function aggregate(results: AuditResult[]): AuditSummary {
  const findings: RankedFinding[] = [];
  const modelErrorTrials = results.reduce((sum, result) => sum + result.trials.filter((trial) => trial.modelError).length, 0);
  const parseErrorTrials = results.reduce((sum, result) => sum + result.trials.filter((trial) => trial.parseError).length, 0);
  const needsMoreContextTrials = results.reduce((sum, result) => sum + result.trials.filter((trial) => trial.needsMoreContext).length, 0);
  const itemsNeedingRetry = results.filter((result) => result.trials.some((trial) => trial.modelError || trial.parseError || trial.needsMoreContext)).length;
  for (const result of results) {
    if (result.nHits === 0) continue;
    const best = bestTrial(result.trials);
    const impact = assessImpact(result.item, best);
    const score = SEVERITY_RANK[best.severity] * 2 + result.hitRate * 3 + best.confidence + impact.score;
    findings.push({
      id: result.item.id,
      location: result.item.location,
      failureMode: result.item.failureMode,
      title: best.title,
      severity: best.severity,
      hitRate: round(result.hitRate),
      confidence: best.confidence,
      score: round(score),
      description: best.description,
      evidence: best.evidence,
      exploitSketch: best.exploitSketch,
      fix: best.fix,
      confirmationStatus: "suspected",
      impactScore: impact.score,
      impactSignals: impact.signals,
    });
  }
  findings.sort((a, b) => b.score - a.score);
  return {
    coverage: {
      itemsTotal: results.length,
      itemsWithFinding: findings.length,
      bySeverity: {
        critical: count(findings, "critical"),
        high: count(findings, "high"),
        medium: count(findings, "medium"),
        low: count(findings, "low"),
        info: count(findings, "info"),
      },
      itemsNeedingRetry,
      modelErrorTrials,
      parseErrorTrials,
      needsMoreContextTrials,
      verifiedFindings: 0,
      unverifiedFindings: findings.length,
    },
    findings,
  };
}

function bestTrial(trials: TrialFinding[]): TrialFinding {
  const hits = trials.filter((trial) => trial.finding);
  const pool = hits.length > 0 ? hits : trials;
  return pool.reduce((best, trial) => {
    const a = SEVERITY_RANK[trial.severity] * 2 + trial.confidence;
    const b = SEVERITY_RANK[best.severity] * 2 + best.confidence;
    return a > b ? trial : best;
  });
}

function count(findings: RankedFinding[], severity: Severity): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
