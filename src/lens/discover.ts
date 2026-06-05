import type { AuditorConfig } from "../config.js";
import { effectiveFailureModes } from "../config.js";
import { assemble } from "../ingest/source.js";
import { renderProjectProfile } from "../profile/project.js";
import type { AuditLensPackDefinition, Doc, LlmClient, ProjectProfile } from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import { extractJsonArray } from "../util/json.js";
import { normalizeLensPacks, renderLensPacks, renderProjectContext } from "./context.js";

export const LENS_SYSTEM = `You are the reconnaissance stage of an automated white-hat security audit framework.
Your job is not to find bugs. Your job is to design project-specific audit lenses so later agents know what to inspect.
Read the project profile, source excerpts, and reference material. Infer assets, trust boundaries, invariants, attacker capabilities, and specialized failure modes.
Every lens must be grounded in observed source, corpus, or deterministic profile evidence. Do not invent unobserved frameworks, entrypoints, APIs, manifests, dependencies, or deployment surfaces.
Return only structured lens packs. Do not include exploit code, credentials, or machine-specific paths.`;

export async function discoverLensPacks(input: {
  cfg: AuditorConfig;
  corpus: Doc[];
  source: Doc[];
  projectProfile: ProjectProfile;
  llm?: LlmClient;
  logger: RunLogger;
}): Promise<AuditLensPackDefinition[]> {
  if (input.cfg.dryRun || !input.llm || !input.cfg.dynamicLensDiscovery) {
    await input.logger.artifact("lens_packs.json", input.cfg.lensPacks);
    return input.cfg.lensPacks;
  }

  const corpusText = assemble(input.corpus, Math.floor(input.cfg.contextCharBudget / 3));
  const sourceText = assemble(input.source, Math.floor(input.cfg.contextCharBudget / 2), true);
  const text = await input.llm.complete({
    tag: "discover_lenses",
    system: LENS_SYSTEM,
    user: buildLensDiscoveryPrompt({
      target: input.cfg.targetName,
      projectProfile: renderProjectProfile(input.projectProfile),
      configuredProjectContext: renderProjectContext(input.cfg.projectContext),
      configuredLensPacks: renderLensPacks(input.cfg.lensPacks),
      knownFailureModes: effectiveFailureModes(input.cfg),
      corpus: corpusText,
      source: sourceText,
    }),
    model: input.cfg.enumModel,
    maxTokens: input.cfg.maxTokens,
    thinkingLevel: input.cfg.thinkingLevel,
  });

  const discovered = normalizeLensPacks(extractJsonArray<unknown>(text));
  const merged = [...input.cfg.lensPacks, ...discovered];
  await input.logger.artifact("lens_packs.json", merged);
  await input.logger.event("lens_discovery_done", { configured: input.cfg.lensPacks.length, discovered: discovered.length, total: merged.length });
  return merged;
}

function buildLensDiscoveryPrompt(input: {
  target: string;
  projectProfile: string;
  configuredProjectContext: string;
  configuredLensPacks: string;
  knownFailureModes: string[];
  corpus: string;
  source: string;
}): string {
  return `Target: ${input.target}

Known failure modes:
${input.knownFailureModes.join(", ")}

Deterministic project profile:
${input.projectProfile}

Configured project context:
${input.configuredProjectContext}

Configured lens packs:
${input.configuredLensPacks}

Design 2-8 project-specific audit lens packs. Prefer existing failure modes when they fit. Add custom failure modes only when the project has domain-specific invariants that the generic taxonomy does not express well.

Each lens pack must have:
- id: lowercase slug
- displayName
- description
- projectContext: inferred assets, attacker capabilities, trust boundaries, security invariants, focus areas, out-of-scope notes, and scenario guidance
- failureModes: existing or custom slug tags
- auditorAgents: only for custom failure modes or when the project needs more precise guidance than the generic agent
- enumerationGuidance: instructions for finding checklist items in this project
- auditGuidance: instructions for auditing those items

Grounding rules:
- Create lenses only for domains, assets, and trust boundaries visible in the profile, loaded source, configured context, or corpus.
- If the source set is narrow, design narrow lenses for what is visible. Do not add web/API/dependency/configuration lenses unless those surfaces are loaded or configured.
- If proof, circuit, constraint-system, verifier, or witness-assignment code is visible, include guidance to inspect source binding: assigned advice/witness cells must be constrained to the intended caller-owned values or input cells, not merely internally consistent.
- Absence of a manifest, route table, deployment file, or test suite is unknown context unless loaded reference material states it is security-critical.

Hard boundaries:
- Do not claim any vulnerability.
- Do not include proof-of-concept code.
- Do not include absolute local paths.
- Do not include credentials or private data.

Return only a JSON array. No markdown fences.

===== REFERENCE / SPEC MATERIAL =====
${input.corpus || "(none provided)"}

===== SOURCE UNDER AUDIT =====
${input.source || "(none provided)"}
`;
}
