import type { AuditorConfig } from "../config.js";
import type { AuditItem, RankedFinding, TrialFinding } from "../types.js";

export interface ImpactAssessment {
  score: number;
  signals: string[];
}

const HIGH_IMPACT_FAILURE_MODES = new Set([
  "soundness_gap",
  "missing_constraint",
  "supply_balance_integrity",
  "double_spend_nullifier",
  "access_control",
  "privilege_boundary",
  "reentrancy",
  "signature_replay",
  "consensus_divergence",
]);

const HIGH_IMPACT_MODE_RE = /(?:^|_)(?:zk|evm|bridge|oracle|vault|liquidation|upgrade|signature|permit|replay|solvency|soundness|constraint|nullifier|auth|access|privilege|reentrancy)(?:_|$)/i;
const ZK_IMPACT_RE = /\b(?:malicious prover|prover|false statement|proof soundness|soundness|constraint|constrain|witness|advice|assigned cell|assignedcell|selector|lookup|equality|gate|halo2|circuit|verifier)\b/i;
const VALUE_IMPACT_RE = /\b(?:funds?|asset|balance|mint|burn|withdraw|deposit|share|vault|solvency|liquidation|bridge|oracle|price|collateral)\b/i;
const AUTH_IMPACT_RE = /\b(?:authorization|access control|privilege|owner|role|admin|signature|permit|nonce|replay|delegate)\b/i;
const SYSTEMIC_IMPACT_RE = /\b(?:consensus|fork|state divergence|public input|nullifier|double spend|integrity|invariant)\b/i;

export function assessImpact(item: AuditItem, trial: TrialFinding): ImpactAssessment {
  const text = [
    item.failureMode,
    item.securityProperty,
    item.why,
    item.specRefs?.join(" "),
    item.attackerControlledInputs?.join(" "),
    trial.title,
    trial.description,
    trial.evidence,
    trial.exploitSketch,
    trial.fix,
  ].filter(Boolean).join("\n");
  const signals: string[] = [];
  if (HIGH_IMPACT_FAILURE_MODES.has(String(item.failureMode)) || HIGH_IMPACT_MODE_RE.test(String(item.failureMode))) signals.push("high-impact-failure-mode");
  if (ZK_IMPACT_RE.test(text)) signals.push("zk-or-proof-soundness");
  if (VALUE_IMPACT_RE.test(text)) signals.push("value-or-solvency");
  if (AUTH_IMPACT_RE.test(text)) signals.push("authorization-or-replay");
  if (SYSTEMIC_IMPACT_RE.test(text)) signals.push("systemic-integrity");
  if (trial.severity === "critical" || trial.severity === "high") signals.push("model-high-severity");
  if (trial.confidence >= 0.75) signals.push("model-high-confidence");

  const score =
    unique(signals).length +
    (trial.severity === "critical" ? 3 : trial.severity === "high" ? 2 : trial.severity === "medium" ? 1 : 0) +
    (trial.confidence >= 0.85 ? 1 : 0);
  return { score, signals: unique(signals) };
}

export function isHighImpactFinding(finding: RankedFinding): boolean {
  if (finding.severity === "critical" || finding.severity === "high") return true;
  if ((finding.impactScore ?? 0) >= 3) return true;
  if (HIGH_IMPACT_FAILURE_MODES.has(String(finding.failureMode)) && (finding.impactScore ?? 0) >= 2) return true;
  return false;
}

export function selectFindingsForFollowUp(
  findings: RankedFinding[],
  topK: number,
  cfg: Pick<AuditorConfig, "highImpactVerification" | "highImpactMaxFindings">,
): RankedFinding[] {
  const baseLimit = Math.max(0, Math.floor(topK));
  if (baseLimit <= 0) return [];
  const selected = findings.slice(0, baseLimit);
  if (!cfg.highImpactVerification) return selected;
  const selectedIds = new Set(selected.map((finding) => finding.id));
  const highImpact = findings
    .filter((finding) => !selectedIds.has(finding.id) && isHighImpactFinding(finding))
    .sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0) || b.score - a.score)
    .slice(0, Math.max(0, Math.floor(cfg.highImpactMaxFindings)));
  return [...selected, ...highImpact];
}

export function followUpQueueReason(finding: RankedFinding, topKFindings: RankedFinding[]): "topK" | "high-impact" {
  return topKFindings.some((entry) => entry.id === finding.id) ? "topK" : "high-impact";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
