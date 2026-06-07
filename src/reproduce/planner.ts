import { spawn } from "node:child_process";
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditorConfig } from "../config.js";
import { buildReproductionPrompt, REPRODUCTION_SYSTEM } from "../agents/prompts.js";
import { selectFindingsForFollowUp } from "../audit/impact.js";
import { SourceIndex } from "../index/source-index.js";
import { renderProjectLearning } from "../learn/project.js";
import { analyzeReproductionCommandSafety } from "../security/policy.js";
import type {
  ConfirmationStatus,
  Doc,
  LlmClient,
  ProjectLearning,
  RankedFinding,
  Reproduction,
  ReproductionCommand,
  ReproductionCommandResult,
  ReproductionFile,
  ReproductionPlan,
  Verification,
} from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import { extractJsonObject } from "../util/json.js";

export async function reproduceTop(input: {
  cfg: AuditorConfig;
  findings: RankedFinding[];
  verifications: Verification[];
  source: Doc[];
  projectLearning?: ProjectLearning;
  llm?: LlmClient;
  logger: RunLogger;
  topK: number;
}): Promise<Reproduction[]> {
  if (input.cfg.reproductionMode === "off" || input.topK <= 0) return [];

  const byId = new Map(input.verifications.map((verification) => [verification.id, verification]));
  const index = new SourceIndex(input.source);
  const out: Reproduction[] = [];
  const selectedFindings = selectFindingsForFollowUp(input.findings, input.topK, input.cfg);

  for (const finding of selectedFindings) {
    const verification = byId.get(finding.id);
    const sourceStatus = confirmationStatusFor(finding, verification);
    if (verification?.verdict === "false-positive") {
      out.push(skippedReproduction(finding, "Source verifier marked the finding false-positive."));
      continue;
    }

    if (input.cfg.dryRun || !input.llm) {
      out.push(skippedReproduction(finding, "Reproduction planning requires a live model client."));
      continue;
    }

    const sourceText = index.contextForItem(
      {
        id: finding.id,
        location: finding.location,
        securityProperty: finding.description,
        failureMode: finding.failureMode,
        why: finding.evidence,
      },
      input.cfg.contextCharBudget,
    );
    const prompt = buildReproductionPrompt({
      title: finding.title,
      location: finding.location,
      severity: finding.severity,
      description: finding.description,
      evidence: finding.evidence,
      fix: finding.fix,
      verification: verification?.markdown ?? "(not available)",
      projectLearning: renderProjectLearning(input.projectLearning),
      source: sourceText,
      maxCommands: input.cfg.reproductionMaxCommands,
      commandTimeoutMs: input.cfg.reproductionCommandTimeoutMs,
    });
    const raw = await input.llm.complete({
      tag: `reproduce_${finding.id}`,
      system: REPRODUCTION_SYSTEM,
      user: prompt,
      model: input.cfg.verifyModel,
      maxTokens: input.cfg.maxTokens,
      thinkingLevel: input.cfg.thinkingLevel,
    });
    const plan = normalizePlan(raw, input.cfg);
    if (!plan || (plan.files.length === 0 && plan.commands.length === 0)) {
      out.push({
        id: `repro_${finding.id}`,
        findingId: finding.id,
        status: "needs-work",
        confirmationStatus: sourceStatus,
        ...(plan ? { plan } : {}),
        commandResults: [],
        markdown: renderReproductionMarkdown({
          title: finding.title,
          mode: input.cfg.reproductionMode,
          status: "needs-work",
          confirmationStatus: sourceStatus,
          ...(plan ? { plan } : {}),
          reason: "The ReproductionAgent could not produce an executable local test plan from the loaded context.",
        }),
      });
      continue;
    }

    if (input.cfg.reproductionMode === "plan") {
      out.push({
        id: `repro_${finding.id}`,
        findingId: finding.id,
        status: "planned",
        confirmationStatus: sourceStatus,
        plan,
        commandResults: [],
        markdown: renderReproductionMarkdown({
          title: finding.title,
          mode: input.cfg.reproductionMode,
          status: "planned",
          confirmationStatus: sourceStatus,
          plan,
          reason: "Execution was not requested. Run with reproductionMode=execute or --repro execute to create the temp workspace and run local tests.",
        }),
      });
      continue;
    }

    out.push(await executePlan({ cfg: input.cfg, finding, ...(verification ? { verification } : {}), sourceStatus, plan, logger: input.logger }));
  }

  await input.logger.artifact("reproductions.json", out);
  return out;
}

function normalizePlan(raw: string, cfg: AuditorConfig): ReproductionPlan | undefined {
  const parsed = extractJsonObject<Record<string, unknown>>(raw);
  if (!parsed) return undefined;
  const files = normalizeFiles(parsed.files, cfg.reproductionMaxFileBytes);
  const commands = normalizeCommands(parsed.commands, cfg);
  return {
    summary: cleanString(parsed.summary) || "Local-only reproduction plan.",
    files,
    commands,
    successCriteria: normalizeStringList(parsed.successCriteria ?? parsed.success_criteria),
    successPatterns: normalizeStringList(parsed.successPatterns ?? parsed.success_patterns),
    safetyNotes: normalizeStringList(parsed.safetyNotes ?? parsed.safety_notes),
  };
}

function normalizeFiles(value: unknown, maxFileBytes: number): ReproductionFile[] {
  if (!Array.isArray(value)) return [];
  const out: ReproductionFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const rawPath = cleanString(record.path);
    const content = typeof record.content === "string" ? record.content : undefined;
    if (!rawPath || content === undefined || Buffer.byteLength(content, "utf8") > maxFileBytes) continue;
    const normalizedPath = normalizeRelativePath(rawPath);
    if (!normalizedPath) continue;
    out.push({ path: normalizedPath, content });
  }
  return out.slice(0, 8);
}

function normalizeCommands(value: unknown, cfg: AuditorConfig): ReproductionCommand[] {
  if (!Array.isArray(value)) return [];
  const out: ReproductionCommand[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const program = cleanString(record.program);
    const args = Array.isArray(record.args) ? record.args.map((arg) => String(arg)).filter((arg) => arg.length > 0) : [];
    if (!program) continue;
    const command: ReproductionCommand = { program, args };
    const cwd = cleanString(record.cwd);
    if (cwd && cwd !== ".") {
      const normalizedCwd = normalizeRelativePath(cwd);
      if (!normalizedCwd) continue;
      command.cwd = normalizedCwd;
    }
    const timeoutMs = numberInRange(record.timeoutMs ?? record.timeout_ms, 1000, cfg.reproductionCommandTimeoutMs, cfg.reproductionCommandTimeoutMs);
    command.timeoutMs = timeoutMs;
    const expectedExitCode = numberInRange(record.expectedExitCode ?? record.expected_exit_code, 0, 255, 0);
    command.expectedExitCode = expectedExitCode;
    out.push(command);
  }
  return out.slice(0, cfg.reproductionMaxCommands);
}

async function executePlan(input: {
  cfg: AuditorConfig;
  finding: RankedFinding;
  verification?: Verification;
  sourceStatus: ConfirmationStatus;
  plan: ReproductionPlan;
  logger: RunLogger;
}): Promise<Reproduction> {
  const blocked = firstBlockedCommand(input.plan.commands);
  if (blocked) {
    return {
      id: `repro_${input.finding.id}`,
      findingId: input.finding.id,
      status: "blocked",
      confirmationStatus: input.sourceStatus,
      plan: input.plan,
      commandResults: [],
      markdown: renderReproductionMarkdown({
        title: input.finding.title,
        mode: input.cfg.reproductionMode,
        status: "blocked",
        confirmationStatus: input.sourceStatus,
        plan: input.plan,
        reason: blocked,
      }),
      blockedReason: blocked,
    };
  }
  const blockedFile = firstBlockedPlanFile(input.plan.files);
  if (blockedFile) {
    return {
      id: `repro_${input.finding.id}`,
      findingId: input.finding.id,
      status: "blocked",
      confirmationStatus: input.sourceStatus,
      plan: input.plan,
      commandResults: [],
      markdown: renderReproductionMarkdown({
        title: input.finding.title,
        mode: input.cfg.reproductionMode,
        status: "blocked",
        confirmationStatus: input.sourceStatus,
        plan: input.plan,
        reason: blockedFile,
      }),
      blockedReason: blockedFile,
    };
  }

  const workspace = await prepareWorkspace(input.cfg.sourcePaths, input.logger, input.finding.id);
  await writePlanFiles(workspace.absolute, input.plan.files);
  const commandResults: ReproductionCommandResult[] = [];
  for (const command of input.plan.commands) {
    commandResults.push(await runLocalCommand(command, workspace.absolute, input.cfg.reproductionMaxLogBytes, input.cfg.sourcePaths));
  }
  const exitStatusMatched = commandResults.length > 0 && commandResults.every((result) => result.exitCode === result.expectedExitCode && !result.timedOut);
  const patternCheck = matchSuccessPatterns(input.verification?.executableSuccessPatterns ?? [], commandResults);
  const confirmed = exitStatusMatched && patternCheck.missing.length === 0 && patternCheck.matched.length > 0;
  const status = confirmed ? "confirmed-executable" : "needs-work";
  const confirmationStatus = confirmed ? "confirmed-executable" : input.sourceStatus;
  return {
    id: `repro_${input.finding.id}`,
    findingId: input.finding.id,
    status,
    confirmationStatus,
    plan: input.plan,
    workspace: workspace.relative,
    commandResults,
    successPatternsMatched: patternCheck.matched,
    successPatternsMissing: patternCheck.missing,
    markdown: renderReproductionMarkdown({
      title: input.finding.title,
      mode: input.cfg.reproductionMode,
      status,
      confirmationStatus,
      plan: input.plan,
      commandResults,
      successPatternsMatched: patternCheck.matched,
      successPatternsMissing: patternCheck.missing,
      reason: confirmed
        ? "Local commands matched expected exit status and all machine-checkable success patterns."
        : reproductionFailureReason(exitStatusMatched, patternCheck),
    }),
  };
}

function firstBlockedCommand(commands: ReproductionCommand[]): string | undefined {
  for (const command of commands) {
    const decision = analyzeReproductionCommandSafety(command);
    if (decision.blocked) return decision.reason ?? "Reproduction command blocked by policy.";
  }
  return undefined;
}

function firstBlockedPlanFile(files: ReproductionFile[]): string | undefined {
  for (const file of files) {
    const decision = analyzeGeneratedFileSafety(file);
    if (decision) return decision;
  }
  return undefined;
}

function analyzeGeneratedFileSafety(file: ReproductionFile): string | undefined {
  const content = file.content;
  for (const url of content.match(/\bhttps?:\/\/[^\s"'`<>]+/gi) ?? []) {
    if (!isLocalUrl(url)) {
      return `Blocked by full-stack-auditor guardrail: generated reproduction file ${file.path} must not reference remote URLs.`;
    }
  }
  if (/\b(?:child_process|Deno\.Command|Bun\.spawn|spawnSync|execFileSync|execSync)\b/.test(content)) {
    return `Blocked by full-stack-auditor guardrail: generated reproduction file ${file.path} must not spawn subprocesses.`;
  }
  if (/\b(?:PRIVATE_KEY|MNEMONIC|SECRET|TOKEN|ALCHEMY|INFURA|QUICKNODE|MORALIS|ETHERSCAN|RPC_URL)\b/.test(content)) {
    return `Blocked by full-stack-auditor guardrail: generated reproduction file ${file.path} must not read secret or RPC environment variables.`;
  }
  if (/\b(?:sendRawTransaction|broadcast|transferFrom|withdraw|drain)\b/i.test(content) && /\b(?:mainnet|testnet|public\s+rpc|production)\b/i.test(content)) {
    return `Blocked by full-stack-auditor guardrail: generated reproduction file ${file.path} combines live-network and value-moving terms.`;
  }
  return undefined;
}

async function prepareWorkspace(sourcePaths: string[], logger: RunLogger, findingId: string): Promise<{ absolute: string; relative: string }> {
  const relative = path.posix.join("reproduction", safeName(findingId), "workspace");
  const absolute = path.join(logger.runDir, ...relative.split("/"));
  await mkdir(absolute, { recursive: true });
  if (sourcePaths.length === 1 && (await isDirectory(sourcePaths[0] ?? ""))) {
    await copyDirectoryContents(sourcePaths[0] ?? "", absolute);
  } else {
    for (const sourcePath of sourcePaths) {
      await copySourcePath(sourcePath, path.join(absolute, path.basename(sourcePath)));
    }
  }
  return { absolute, relative };
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkipCopyName(entry.name)) continue;
    await copySourcePath(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
  }
}

async function copySourcePath(sourcePath: string, targetPath: string): Promise<void> {
  if (shouldSkipCopyName(path.basename(sourcePath))) return;
  await cp(sourcePath, targetPath, {
    recursive: true,
    force: true,
    filter: (source) => !shouldSkipCopyName(path.basename(source)),
  });
}

async function writePlanFiles(workspace: string, files: ReproductionFile[]): Promise<void> {
  for (const file of files) {
    const target = resolveWorkspacePath(workspace, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

async function runLocalCommand(
  command: ReproductionCommand,
  workspace: string,
  maxLogBytes: number,
  redactPaths: string[],
): Promise<ReproductionCommandResult> {
  const cwd = command.cwd ? resolveWorkspacePath(workspace, command.cwd) : workspace;
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exitCode: number | null = null;
  const tmpDir = path.join(workspace, ".tmp");
  await mkdir(tmpDir, { recursive: true });
  const child = spawn(command.program, command.args, {
    cwd,
    shell: false,
    env: localReproductionEnv(workspace, tmpDir),
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, command.timeoutMs ?? 120_000);

  child.stdout?.on("data", (chunk) => {
    stdout = appendLimited(stdout, String(chunk), maxLogBytes);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendLimited(stderr, String(chunk), maxLogBytes);
  });

  await new Promise<void>((resolve) => {
    child.on("error", (error) => {
      stderr = appendLimited(stderr, error.message, maxLogBytes);
      resolve();
    });
    child.on("close", (code) => {
      exitCode = code;
      resolve();
    });
  });
  clearTimeout(timer);

  const redactionScope = [workspace, tmpDir, ...redactPaths, ...machineRedactionPaths()];
  return {
    command,
    exitCode,
    expectedExitCode: command.expectedExitCode ?? 0,
    timedOut,
    durationMs: Date.now() - started,
    stdout: redactMachineStrings(redactLocalPaths(stdout, redactionScope)),
    stderr: redactMachineStrings(redactLocalPaths(stderr, redactionScope)),
  };
}

function renderReproductionMarkdown(input: {
  title: string;
  mode: string;
  status: string;
  confirmationStatus: ConfirmationStatus;
  plan?: ReproductionPlan;
  commandResults?: ReproductionCommandResult[];
  successPatternsMatched?: string[];
  successPatternsMissing?: string[];
  reason: string;
}): string {
  const commands = input.plan?.commands.map((command) => `- ${[command.program, ...command.args].join(" ")} (expected exit ${command.expectedExitCode ?? 0})`).join("\n") || "- (none)";
  const files = input.plan?.files.map((file) => `- ${file.path}`).join("\n") || "- (none)";
  const results = input.commandResults?.length
    ? input.commandResults
        .map((result) => `- ${[result.command.program, ...result.command.args].join(" ")}: exit=${result.exitCode ?? "null"} expected=${result.expectedExitCode} timedOut=${result.timedOut}`)
        .join("\n")
    : "- (not run)";
  const matched = input.successPatternsMatched?.map((entry) => `- ${entry}`).join("\n") || "- (none)";
  const missing = input.successPatternsMissing?.map((entry) => `- ${entry}`).join("\n") || "- (none)";
  return `### ReproductionAgent

- Finding: ${input.title}
- Mode: ${input.mode}
- Status: ${input.status}
- Confirmation status: ${input.confirmationStatus}
- Reason: ${input.reason}

Planned files:
${files}

Planned commands:
${commands}

Command results:
${results}

Matched success patterns:
${matched}

Missing success patterns:
${missing}

Success criteria:
${input.plan?.successCriteria.map((entry) => `- ${entry}`).join("\n") || "- (none)"}

Safety notes:
${input.plan?.safetyNotes.map((entry) => `- ${entry}`).join("\n") || "- Local-only reproduction stage; no public network target is allowed."}`;
}

function skippedReproduction(finding: RankedFinding, reason: string): Reproduction {
  return {
    id: `repro_${finding.id}`,
    findingId: finding.id,
    status: "skipped",
    confirmationStatus: finding.confirmationStatus,
    commandResults: [],
    markdown: renderReproductionMarkdown({
      title: finding.title,
      mode: "off",
      status: "skipped",
      confirmationStatus: finding.confirmationStatus,
      reason,
    }),
  };
}

function confirmationStatusFor(finding: RankedFinding, verification: Verification | undefined): ConfirmationStatus {
  if (finding.confirmationStatus === "confirmed-executable") return "confirmed-executable";
  if (verification?.confirmationStatus === "confirmed-source") return "confirmed-source";
  return finding.confirmationStatus === "confirmed-source" ? "confirmed-source" : "suspected";
}

function normalizeRelativePath(input: string): string | undefined {
  const normalized = path.posix.normalize(input.replace(/\\/g, "/")).replace(/^\.\/+/, "");
  if (!normalized || normalized === "." || path.isAbsolute(input) || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

function isLocalUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

function resolveWorkspacePath(workspace: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) throw new Error(`Unsafe reproduction path: ${relativePath}`);
  const target = path.resolve(workspace, ...normalized.split("/"));
  const root = path.resolve(workspace);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe reproduction path: ${relativePath}`);
  }
  return target;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => cleanString(entry)).filter((entry): entry is string => Boolean(entry)).slice(0, 8);
}

function matchSuccessPatterns(patterns: string[], commandResults: ReproductionCommandResult[]): { matched: string[]; missing: string[] } {
  const output = commandResults.map((result) => [result.stdout, result.stderr].join("\n")).join("\n").toLowerCase();
  const matched: string[] = [];
  const missing: string[] = [];
  for (const pattern of patterns) {
    const needle = pattern.trim().toLowerCase();
    if (needle.length === 0) continue;
    if (output.includes(needle)) matched.push(pattern);
    else missing.push(pattern);
  }
  return {
    matched,
    missing: patterns.length === 0
      ? ["No verifier-owned executableSuccessPatterns were provided; reproduction-agent-only strings cannot confirm execution."]
      : missing,
  };
}

function reproductionFailureReason(exitStatusMatched: boolean, patternCheck: { matched: string[]; missing: string[] }): string {
  if (!exitStatusMatched) return "At least one local reproduction command did not match its expected exit status.";
  if (patternCheck.missing.length > 0) return "Local commands exited as expected, but machine-checkable success patterns were missing.";
  return "Local reproduction did not produce a machine-checkable confirmation signal.";
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

async function isDirectory(input: string): Promise<boolean> {
  try {
    return (await stat(input)).isDirectory();
  } catch {
    return false;
  }
}

function shouldSkipCopyName(name: string): boolean {
  return new Set([".git", ".hg", ".svn", "node_modules", "vendor", "target", "build", "dist", "coverage", "runs", "__pycache__", ".cache", ".next", ".nuxt", ".turbo"]).has(name);
}

function appendLimited(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return combined.slice(0, Math.max(0, maxBytes)) + "\n[truncated]\n";
}

function redactLocalPaths(input: string, paths: string[]): string {
  let out = input;
  for (const candidate of paths) {
    if (!candidate) continue;
    const absolute = path.resolve(candidate);
    out = replaceAll(out, absolute, "<local-path>");
  }
  return out;
}

function machineRedactionPaths(): string[] {
  return [process.env.HOME, process.env.TMPDIR, process.env.TEMP, process.env.TMP].filter((value): value is string => Boolean(value));
}

function redactMachineStrings(input: string): string {
  let out = input;
  for (const value of [process.env.USER, process.env.LOGNAME]) {
    if (value && value.length >= 3) out = replaceAll(out, value, "<local-user>");
  }
  return out;
}

function replaceAll(input: string, needle: string, replacement: string): string {
  return input.split(needle).join(replacement);
}

function localReproductionEnv(workspace: string, tmpDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    CI: "1",
    HOME: workspace,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    XDG_CACHE_HOME: path.join(tmpDir, "xdg-cache"),
    CARGO_HOME: path.join(tmpDir, "cargo-home"),
    GOCACHE: path.join(tmpDir, "go-build-cache"),
    GOMODCACHE: path.join(tmpDir, "go-mod-cache"),
    NPM_CONFIG_CACHE: path.join(tmpDir, "npm-cache"),
  };
  if (process.env.PATH !== undefined) out.PATH = process.env.PATH;
  if (process.env.LANG !== undefined) out.LANG = process.env.LANG;
  if (process.env.LC_ALL !== undefined) out.LC_ALL = process.env.LC_ALL;
  return out;
}

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80) || "finding";
}
