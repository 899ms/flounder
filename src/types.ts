export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type BuiltInFailureMode =
  | "missing_constraint"
  | "supply_balance_integrity"
  | "double_spend_nullifier"
  | "soundness_gap"
  | "spec_impl_mismatch"
  | "integer_overflow"
  | "input_validation"
  | "injection"
  | "ssrf"
  | "path_traversal"
  | "deserialization"
  | "access_control"
  | "privilege_boundary"
  | "reentrancy"
  | "signature_replay"
  | "cryptographic_misuse"
  | "consensus_divergence"
  | "dos_resource"
  | "race_condition"
  | "secret_exposure"
  | "dependency_supply_chain";

export type FailureMode = BuiltInFailureMode | (string & {});

export interface AuditorAgentDefinition {
  failureMode: FailureMode;
  id: string;
  displayName: string;
  guidance: string;
}

export interface ProjectContext {
  summary?: string;
  criticalAssets?: string[];
  attackerCapabilities?: string[];
  trustBoundaries?: string[];
  securityInvariants?: string[];
  focusAreas?: string[];
  outOfScope?: string[];
  scenarioGuidance?: string[];
}

export interface AuditLensPackDefinition {
  id: string;
  displayName?: string;
  description?: string;
  projectContext?: ProjectContext;
  failureModes?: FailureMode[];
  auditorAgents?: AuditorAgentDefinition[];
  enumerationGuidance?: string[];
  auditGuidance?: string[];
}

export interface Doc {
  path: string;
  content: string;
  kind: "source" | "corpus";
}

export interface ProjectProfile {
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  manifests: string[];
  likelySecurityDomains: string[];
  entrypoints: string[];
  notes: string[];
}

export interface AuditItem {
  id: string;
  location: string;
  securityProperty: string;
  failureMode: FailureMode;
  why: string;
  specRefs?: string[];
  attackerControlledInputs?: string[];
  seeder?: string;
  round?: number;
}

export interface TrialFinding {
  finding: boolean;
  title: string;
  severity: Severity;
  confidence: number;
  description: string;
  evidence: string;
  exploitSketch: string;
  fix: string;
  parseError?: boolean;
  raw?: string;
}

export interface AuditResult {
  item: AuditItem;
  nTrials: number;
  nHits: number;
  hitRate: number;
  trials: TrialFinding[];
}

export interface RankedFinding {
  id: string;
  location: string;
  failureMode: FailureMode;
  title: string;
  severity: Severity;
  hitRate: number;
  confidence: number;
  score: number;
  description: string;
  evidence: string;
  exploitSketch: string;
  fix: string;
}

export interface AuditSummary {
  coverage: {
    itemsTotal: number;
    itemsWithFinding: number;
    bySeverity: Record<Severity, number>;
  };
  findings: RankedFinding[];
}

export interface Verification {
  id: string;
  markdown: string;
}

export interface LlmClient {
  complete(input: {
    tag: string;
    system: string;
    user: string;
    model?: string;
    maxTokens?: number;
    thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
  }): Promise<string>;
}
