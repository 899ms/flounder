import type { ProjectContext } from "./types.js";

export interface AuditorConfig {
  targetName: string;
  sourcePaths: string[];
  corpusPaths: string[];
  outputDir: string;
  historyDir?: string;
  provider: string;
  auditModel: string;
  maxTokens: number;
  thinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh";
  projectContext: ProjectContext;
  // Sandbox limits shared with the bash tool and warm-up.
  reproductionCommandTimeoutMs: number;
  reproductionMaxFileBytes: number;
  reproductionMaxLogBytes: number;
  // Hunt controls.
  huntMaxSteps: number;
  huntScopeNote?: string;
  huntPrepare: boolean;
  huntPrepareTimeoutMs: number;
  dryRun: boolean;
}

export function defaultConfig(): AuditorConfig {
  return {
    targetName: "target",
    sourcePaths: [],
    corpusPaths: [],
    outputDir: "runs",
    provider: "openai-codex",
    auditModel: "gpt-5.5",
    maxTokens: 8000,
    thinkingLevel: "xhigh",
    projectContext: {},
    reproductionCommandTimeoutMs: 120_000,
    reproductionMaxFileBytes: 200_000,
    reproductionMaxLogBytes: 40_000,
    huntMaxSteps: 40,
    huntPrepare: true,
    huntPrepareTimeoutMs: 600_000,
    dryRun: false,
  };
}

const MAX_CONTEXT_LIST_ITEMS = 24;
const MAX_CONTEXT_FIELD_CHARS = 1600;

/** Parse a configured/CLI project-context object into the bounded scope-note shape hunt uses. */
export function normalizeProjectContext(input: unknown): ProjectContext | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const out: ProjectContext = {};
  const summary = cleanContextString(raw.summary);
  if (summary) out.summary = summary;
  setContextList(out, "criticalAssets", raw.criticalAssets ?? raw.critical_assets);
  setContextList(out, "attackerCapabilities", raw.attackerCapabilities ?? raw.attacker_capabilities);
  setContextList(out, "trustBoundaries", raw.trustBoundaries ?? raw.trust_boundaries);
  setContextList(out, "securityInvariants", raw.securityInvariants ?? raw.security_invariants);
  setContextList(out, "focusAreas", raw.focusAreas ?? raw.focus_areas);
  setContextList(out, "outOfScope", raw.outOfScope ?? raw.out_of_scope);
  setContextList(out, "scenarioGuidance", raw.scenarioGuidance ?? raw.scenario_guidance);
  return Object.keys(out).length === 0 ? undefined : out;
}

function setContextList<K extends keyof ProjectContext>(out: ProjectContext, key: K, value: unknown): void {
  if (!Array.isArray(value)) return;
  const cleaned = [
    ...new Set(value.map((item) => cleanContextString(item)).filter((item): item is string => item !== undefined)),
  ].slice(0, MAX_CONTEXT_LIST_ITEMS);
  if (cleaned.length > 0) out[key] = cleaned as ProjectContext[K];
}

function cleanContextString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length === 0 ? undefined : cleaned.slice(0, MAX_CONTEXT_FIELD_CHARS);
}
