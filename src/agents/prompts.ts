import type { AuditItem, FailureMode } from "../types.js";
import { AUDITOR_AGENTS, getAuditorAgent, type AuditorAgentRegistry } from "./registry.js";

export const MODE_GUIDANCE: Record<FailureMode, string> = Object.fromEntries(
  Object.entries(AUDITOR_AGENTS).map(([mode, agent]) => [mode, agent.guidance]),
) as Record<FailureMode, string>;

export const ENUM_SYSTEM = `You are the enumeration stage of an automated white-hat security audit framework.
Your job is not to find bugs yet. Your job is to exhaustively map the audit surface so later specialized agents can check each item.
Optimize for coverage, specificity, and traceability. Ground each item in source and reference material.
Do not invent files, frameworks, APIs, manifests, dependencies, entrypoints, or runtime surfaces that are not present in the loaded material.`;

export function buildEnumerationPrompt(input: {
  target: string;
  failureModes: FailureMode[];
  projectProfile: string;
  projectContext: string;
  lensPacks: string;
  corpus: string;
  source: string;
}): string {
  return `Target: ${input.target}

Allowed failure modes: ${input.failureModes.join(", ")}

Project profile:
${input.projectProfile || "(not available)"}

Project context:
${input.projectContext || "(none configured)"}

Active lens packs:
${input.lensPacks || "(none configured)"}

Enumerate concrete audit items. Each item must have:
- id: short slug
- location: file + line range or function/component
- securityProperty: invariant that must hold
- failureMode: one allowed tag
- why: why this spot is worth checking
- specRefs: optional list of cited spec/reference snippets
- attackerControlledInputs: optional list of inputs a malicious actor/prover controls

Grounding rules:
- Enumerate only source-backed or corpus-backed items. If the loaded material does not show the file, function, manifest, route, contract, circuit, or API, do not create an item for it.
- Every item should point to the most specific visible location available. Prefer file:line-range locations from the loaded source.
- Treat missing manifests, tests, configs, docs, or entrypoints as unknown context, not as vulnerabilities or audit items, unless the loaded material explicitly makes their absence security-relevant.
- If only a narrow source excerpt is loaded, stay within that excerpt's observable language and domain. Do not infer a web/API/dependency audit surface from a standalone circuit, contract, library, or algorithm file.
- For proof, circuit, constraint-system, verifier, or witness-assignment code, include source-binding items when caller-owned values, public inputs, private witness values, or function arguments are assigned into advice/witness cells. The later audit must verify that assigned cells are constrained to the intended source values; internal equality or constancy across rows is not enough.

Prioritize issues that match the project profile and evidence in the loaded material. Consider implementation/spec mismatch, trust-boundary mistakes, under-constrained witness values, value conservation, replay or uniqueness failures, auth/session bugs, injection, SSRF, path traversal, deserialization, unsafe external calls, race conditions, consensus divergence, dependency trust, secret exposure, and cheap-to-trigger expensive work.

Return only a JSON array. No markdown fences.

===== REFERENCE / SPEC MATERIAL =====
${input.corpus || "(none provided)"}

===== SOURCE UNDER AUDIT =====
${input.source || "(none provided)"}
`;
}

export const AUDIT_SYSTEM = `You are a specialized auditor inside an authorized white-hat audit framework.
Analyze only the assigned item. Real audited code can contain critical bugs, but do not invent findings.
Reason from actual constraints, checks, and data flow. If the invariant is enforced, say so plainly.
Do not treat plausible intent, comments, internal repetition, or naming similarity as proof of enforcement.`;

export function buildAuditPrompt(item: AuditItem, source: string, registry?: AuditorAgentRegistry, lensGuidance = ""): string {
  const agent = getAuditorAgent(item.failureMode, registry);
  return `Audit item:
  id: ${item.id}
  location: ${item.location}
  securityProperty: ${item.securityProperty}
  failureMode: ${item.failureMode}
  why: ${item.why}

Specialized auditor:
  id: ${agent.id}
  name: ${agent.displayName}

Failure-mode guidance:
${agent.guidance}

Project-specific lens guidance:
${lensGuidance || "(none)"}

Relevant source:
${source}

Audit reasoning rules:
- Ground every positive finding in exact source lines, visible checks, visible constraints, or a visible missing edge in data flow.
- If the item is about a proof, circuit, constraint system, verifier, or witness assignment, trace from the original input/argument/cell to every assigned advice/witness cell and then to the enforcing constraint. Internal equality, row-to-row constancy, or curve/arithmetic validity does not prove binding to the intended source by itself.
- If relevant source lines are missing from the context, return "finding": false with a needs-more-context explanation instead of guessing.

Respond as a JSON object only:
{
  "finding": true,
  "title": "...",
  "severity": "info|low|medium|high|critical",
  "confidence": 0.0,
  "description": "what the bug is",
  "evidence": "exact lines, checks, or missing constraints",
  "exploitSketch": "high-level attacker steps, no working exploit code",
  "fix": "minimal change that enforces the property"
}

If there is no bug, return the same object shape with "finding": false and explain why the property is enforced.`;
}

export const DEEPEN_SYSTEM = `You are the deepening stage of an automated white-hat security audit framework.
Your job is not to find bugs yet. Your job is to design new audit items for the next round.
Use prior checklist coverage, audit outcomes, source evidence, and reference material to identify unexamined assumptions and adjacent data-flow edges.
Do not repeat existing checklist items. Do not claim vulnerabilities.`;

export function buildDeepeningPrompt(input: {
  target: string;
  round: number;
  maxItems: number;
  failureModes: FailureMode[];
  projectProfile: string;
  projectContext: string;
  lensPacks: string;
  existingChecklist: string;
  auditObservations: string;
  currentFindings: string;
  corpus: string;
  source: string;
}): string {
  return `Target: ${input.target}
Round: ${input.round}
Maximum new items: ${input.maxItems}

Allowed failure modes: ${input.failureModes.join(", ")}

Project profile:
${input.projectProfile || "(not available)"}

Project context:
${input.projectContext || "(none configured)"}

Active lens packs:
${input.lensPacks || "(none configured)"}

Existing checklist items:
${input.existingChecklist || "(none)"}

Prior audit observations:
${input.auditObservations || "(none)"}

Current ranked findings:
${input.currentFindings || "(none)"}

Create only new audit items for the next round. Each item must have:
- id: short slug
- location: file + line range or function/component
- securityProperty: invariant that must hold
- failureMode: one allowed tag
- why: explain the new angle and which previous coverage gap, weak assumption, neighboring flow, or skeptical observation led to this item
- specRefs: optional list of cited spec/reference snippets
- attackerControlledInputs: optional list of inputs a malicious actor/prover controls

Depth rules:
- Prefer items that connect two pieces of evidence not checked together in prior rounds, such as source-to-witness binding, caller input to assigned cell, spec statement to implementation branch, or authorization identity to storage predicate.
- Follow unresolved, low-confidence, or skeptical audit observations into adjacent code and data flow instead of re-auditing the same location.
- If a prior finding depends on an assumption, enumerate the cheapest item that would refute or support that assumption.
- If the loaded source is narrow, stay within the visible source and reference material. Do not invent files, APIs, manifests, routes, dependencies, or deployment surfaces.
- For proof, circuit, constraint-system, verifier, or witness-assignment code, prioritize unexamined source-binding paths where assigned advice/witness cells must be tied to intended caller-owned values or input cells.
- Do not include an item if its normalized location, failure mode, and security property are already present in the existing checklist.

Return only a JSON array. No markdown fences.

===== REFERENCE / SPEC MATERIAL =====
${input.corpus || "(none provided)"}

===== SOURCE UNDER AUDIT =====
${input.source || "(none provided)"}
`;
}

export const VERIFY_SYSTEM = `You are the verification stage of a white-hat audit framework.
Independently confirm or refute the candidate finding by reasoning from the code.

Hard rules:
- Reproduction must target a local unit test, regtest, devnet, or forked node only.
- Never target public testnet or mainnet.
- Verify the bug; do not optimize a value-extraction exploit.
- If the invariant is enforced, mark it false-positive.`;

export function buildVerifyPrompt(input: {
  title: string;
  location: string;
  severity: string;
  description: string;
  evidence: string;
  fix: string;
  source: string;
}): string {
  return `Candidate finding:
  title: ${input.title}
  location: ${input.location}
  severity: ${input.severity}
  description: ${input.description}
  evidence: ${input.evidence}
  proposed fix: ${input.fix}

Relevant source:
${input.source}

Produce markdown:
1. VERDICT: confirmed / needs-investigation / false-positive.
2. Reasoning with specific lines or missing constraints.
3. Confidence ladder from cheapest local check to strongest local-only check.
4. PoC scaffold for the first local-only rung only.
5. Minimal fix and a test that should pass after the fix.`;
}
