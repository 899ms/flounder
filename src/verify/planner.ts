import type { AuditorConfig } from "../config.js";
import { buildCompositionVerifyPrompt, buildVerifyPrompt, VERIFY_SYSTEM } from "../agents/prompts.js";
import { followUpQueueReason, selectFindingsForFollowUp } from "../audit/impact.js";
import { SourceIndex } from "../index/source-index.js";
import { renderProjectLearning } from "../learn/project.js";
import type { ContextSlice } from "../index/source-index.js";
import type { Doc, LlmClient, ProjectLearning, RankedFinding, Verification, VerificationVerdict } from "../types.js";
import type { RunLogger } from "../trace/logger.js";

export async function verifyTop(input: {
  cfg: AuditorConfig;
  findings: RankedFinding[];
  source: Doc[];
  projectLearning?: ProjectLearning;
  llm?: LlmClient;
  logger: RunLogger;
  topK: number;
}): Promise<Verification[]> {
  const selectedFindings = selectFindingsForFollowUp(input.findings, input.topK, input.cfg);
  const topKFindings = input.findings.slice(0, Math.max(0, Math.floor(input.topK)));
  if (input.cfg.dryRun || !input.llm) {
    const out = selectedFindings.map((finding) => ({
      id: finding.id,
      verdict: "needs-investigation" as const,
      confirmationStatus: "suspected" as const,
      markdown: `VERDICT: needs-investigation\n\nDry-run mode skipped model verification for ${finding.title}.`,
      mode: verificationModeFor(finding, input.source),
      queueReason: followUpQueueReason(finding, topKFindings),
    }));
    await input.logger.artifact("verifications.json", out);
    return out;
  }
  const index = new SourceIndex(input.source);
  const out: Verification[] = [];
  const traces: Array<{ id: string; mode: Verification["mode"]; queueReason: Verification["queueReason"]; trace: ReturnType<SourceIndex["contextForItemWithTrace"]> }> = [];
  await input.logger.event("verification_queue", {
    topK: input.topK,
    selected: selectedFindings.length,
    highImpact: selectedFindings.filter((finding) => followUpQueueReason(finding, topKFindings) === "high-impact").length,
  });
  for (const finding of selectedFindings) {
    const mode = verificationModeFor(finding, input.source);
    const queueReason = followUpQueueReason(finding, topKFindings);
    const context = buildVerificationContext({ cfg: input.cfg, index, finding, mode });
    traces.push({ id: finding.id, mode, queueReason, trace: context.trace });
    const common = {
      title: finding.title,
      location: finding.location,
      severity: finding.severity,
      description: finding.description,
      evidence: finding.evidence,
      fix: finding.fix,
      projectLearning: renderProjectLearning(input.projectLearning),
      source: context.trace.context,
    };
    const user = mode === "composition" ? buildCompositionVerifyPrompt(common) : buildVerifyPrompt(common);
    const markdown = await input.llm.complete({
      tag: mode === "composition" ? `verify_composition_${finding.id}` : `verify_${finding.id}`,
      system: VERIFY_SYSTEM,
      user,
      model: input.cfg.verifyModel,
      maxTokens: input.cfg.maxTokens,
      thinkingLevel: input.cfg.thinkingLevel,
    });
    const verdict = parseVerificationVerdict(markdown);
    out.push({
      id: finding.id,
      verdict,
      confirmationStatus: verdict === "confirmed" ? "confirmed-source" : "suspected",
      markdown,
      mode,
      queueReason,
      executableSuccessPatterns: parseExecutableSuccessPatterns(markdown),
    });
  }
  await input.logger.artifact("verification_context_retrieval.json", traces);
  await input.logger.artifact("verifications.json", out);
  return out;
}

export function parseVerificationVerdict(markdown: string): VerificationVerdict {
  const verdictLine = markdown
    .split(/\r?\n/)
    .find((line) => /\bverdict\b/i.test(line))
    ?.toLowerCase();
  const text = (verdictLine ?? markdown.slice(0, 500)).toLowerCase();
  if (/false[\s-]?positive|refuted|not\s+a\s+bug/.test(text)) return "false-positive";
  if (/\bconfirmed(?:[\s-]?source)?\b/.test(text)) return "confirmed";
  return "needs-investigation";
}

export function parseExecutableSuccessPatterns(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (/executable\s+(?:confirmation\s+)?success\s+patterns?|success\s+patterns?/i.test(line)) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    if (/^\s*$/.test(line)) {
      if (out.length > 0) break;
      continue;
    }
    if (out.length > 0 && /^(?:#{1,6}\s+|\d+\.\s+[A-Z])/.test(line)) break;
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/.exec(line);
    if (!bullet?.[1]) {
      if (out.length > 0) break;
      continue;
    }
    const cleaned = cleanPattern(bullet[1]);
    if (cleaned) out.push(cleaned);
    if (out.length >= 8) break;
  }
  return [...new Set(out)];
}

function cleanPattern(input: string): string | undefined {
  const cleaned = input
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return cleaned.length > 0 ? cleaned : undefined;
}

function buildVerificationContext(input: {
  cfg: AuditorConfig;
  index: SourceIndex;
  finding: RankedFinding;
  mode: NonNullable<Verification["mode"]>;
}): { trace: ReturnType<SourceIndex["contextForItemWithTrace"]> } {
  const item = {
    id: input.finding.id,
    location: input.finding.location,
    securityProperty: [input.finding.description, input.finding.evidence].join("\n"),
    failureMode: input.finding.failureMode,
    why: input.finding.fix,
  };
  const extraSlices = input.mode === "composition" ? compositionSlices(input.index.docs, input.finding) : [];
  return { trace: input.index.contextForItemWithTrace(item, input.cfg.contextCharBudget, extraSlices) };
}

function verificationModeFor(finding: RankedFinding, source: Doc[]): NonNullable<Verification["mode"]> {
  const text = [finding.failureMode, finding.title, finding.description, finding.evidence, finding.exploitSketch, finding.fix].join("\n");
  const looksZk = /\b(?:halo2|circuit|constraint|constrain|witness|prover|proof|verifier|selector|lookup|advice|assignedcell|assigned cell|gate|soundness)\b/i.test(text);
  if (!looksZk) return "standard";
  const hasZkSource = source.some((doc) => /\b(?:assign_advice|copy_advice|constrain_equal|create_gate|query_selector|halo2|AssignedCell)\b/.test(doc.content));
  return hasZkSource ? "composition" : "standard";
}

function compositionSlices(docs: Doc[], finding: RankedFinding): ContextSlice[] {
  const terms = [
    ...termsFromText([finding.location, finding.title, finding.description, finding.evidence].join("\n")),
    "assign_advice",
    "copy_advice",
    "constrain_equal",
    "enable_equality",
    "create_gate",
    "query_selector",
    "query_advice",
    "selector",
    "synthesize",
    "#[test]",
  ];
  const out: ContextSlice[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    if (!/\.(rs|md|txt|toml|json)$/i.test(doc.path)) continue;
    const lines = doc.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      if (!terms.some((term) => line.toLowerCase().includes(term.toLowerCase()))) continue;
      const lineNumber = idx + 1;
      const key = `${doc.path}:${lineNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        doc,
        startLine: Math.max(1, lineNumber - 60),
        endLine: lineNumber + 90,
        reason: "composition verification context",
      });
      if (out.length >= 36) return out;
      break;
    }
  }
  return out;
}

function termsFromText(input: string): string[] {
  return [...new Set(Array.from(input.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g)).map((match) => match[0] ?? ""))]
    .filter((term) => !COMMON_TERMS.has(term.toLowerCase()))
    .slice(0, 20);
}

const COMMON_TERMS = new Set([
  "candidate",
  "finding",
  "source",
  "evidence",
  "missing",
  "constraint",
  "visible",
  "value",
  "values",
  "should",
  "must",
  "with",
  "that",
  "this",
]);
