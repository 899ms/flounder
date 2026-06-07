export interface CommandSafetyPolicy {
  liveNetworkPatterns: RegExp[];
  highRiskActionPatterns: RegExp[];
  message: string;
}

export interface CommandSafetyDecision {
  blocked: boolean;
  reason?: string;
  matchedNetwork?: string;
  matchedAction?: string;
}

export interface StructuredReproductionCommand {
  program: string;
  args: string[];
}

export const DEFAULT_COMMAND_SAFETY_POLICY: CommandSafetyPolicy = {
  liveNetworkPatterns: [
    /\bmainnet\b/i,
    /\bmain\s*net\b/i,
    /\btestnet\b/i,
    /\btest\s*net\b/i,
    /\blivenet\b/i,
    /\blive\s*network\b/i,
    /\bproduction\b/i,
    /\bprod\b/i,
    /\bpublic\s+rpc\b/i,
  ],
  highRiskActionPatterns: [
    /\bsendrawtransaction\b/i,
    /\bsubmit(?:transaction|tx|block)?\b/i,
    /\bbroadcast\b/i,
    /\btransfer\b/i,
    /\bwithdraw\b/i,
    /\bdrain\b/i,
    /\bmint\b/i,
    /\bexploit\b/i,
    /\bpoc\b/i,
  ],
  message:
    "Blocked by full-stack-auditor white-hat guardrail: verification must stay local-only and must not broadcast to public networks.",
};

export function analyzeCommandSafety(
  command: string,
  policy: CommandSafetyPolicy = DEFAULT_COMMAND_SAFETY_POLICY,
): CommandSafetyDecision {
  const matchedNetwork = findMatch(command, policy.liveNetworkPatterns);
  const matchedAction = findMatch(command, policy.highRiskActionPatterns);
  if (!matchedNetwork || !matchedAction) return { blocked: false };
  return {
    blocked: true,
    reason: policy.message,
    matchedNetwork,
    matchedAction,
  };
}

export function analyzeReproductionCommandSafety(command: StructuredReproductionCommand): CommandSafetyDecision {
  const program = command.program.trim();
  const args = command.args.map((arg) => String(arg));
  const rendered = [program, ...args].join(" ");
  const liveNetworkDecision = analyzeCommandSafety(rendered);
  if (liveNetworkDecision.blocked) return liveNetworkDecision;
  const localNetworkDecision = analyzeStructuredLocalNetworkSafety(args);
  if (localNetworkDecision.blocked) return localNetworkDecision;

  if (program.length === 0 || program.includes("/") || program.includes("\\") || /[\s;&|`$<>]/.test(program)) {
    return {
      blocked: true,
      reason: "Blocked by full-stack-auditor guardrail: reproduction commands must use a plain local test runner program name.",
    };
  }

  if (args.some((arg) => /[\0\r\n]/.test(arg))) {
    return {
      blocked: true,
      reason: "Blocked by full-stack-auditor guardrail: reproduction command arguments must be simple argv entries.",
    };
  }

  if (!isAllowedLocalTestCommand(program, args)) {
    return {
      blocked: true,
      reason: "Blocked by full-stack-auditor guardrail: reproduction execution is limited to local test commands.",
    };
  }

  return { blocked: false };
}

function analyzeStructuredLocalNetworkSafety(args: string[]): CommandSafetyDecision {
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx] ?? "";
    const lower = arg.toLowerCase();
    const valueFromEquals = valueAfterEquals(arg);
    if (isRpcFlag(lower)) {
      const value = valueFromEquals ?? args[idx + 1];
      if (!value || !isLocalNetworkValue(value)) {
        return {
          blocked: true,
          reason: "Blocked by full-stack-auditor guardrail: reproduction RPC and fork targets must be local-only.",
          matchedAction: arg,
        };
      }
    }
    if (isNetworkFlag(lower)) {
      const value = valueFromEquals ?? args[idx + 1];
      if (value && !isLocalNetworkValue(value)) {
        return {
          blocked: true,
          reason: "Blocked by full-stack-auditor guardrail: reproduction network targets must be local-only.",
          matchedAction: arg,
          matchedNetwork: value,
        };
      }
    }
    if (looksLikeRemoteUrl(arg) && !isLocalUrl(arg)) {
      return {
        blocked: true,
        reason: "Blocked by full-stack-auditor guardrail: reproduction commands must not use remote RPC URLs.",
        matchedNetwork: arg,
      };
    }
    if (looksLikeRpcEnvReference(arg)) {
      return {
        blocked: true,
        reason: "Blocked by full-stack-auditor guardrail: reproduction commands must not depend on RPC or secret environment references.",
        matchedNetwork: arg,
      };
    }
  }
  return { blocked: false };
}

function findMatch(input: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(input);
    if (match?.[0]) return match[0];
  }
  return undefined;
}

function isAllowedLocalTestCommand(program: string, args: string[]): boolean {
  const name = program.toLowerCase();
  const first = args[0]?.toLowerCase();
  const second = args[1]?.toLowerCase();
  if (name === "cargo") return first === "test";
  if (name === "go") return first === "test";
  if (name === "npm") return first === "test" || (first === "run" && second === "test");
  if (name === "pnpm" || name === "yarn" || name === "bun") return first === "test" || (first === "run" && second === "test");
  if (name === "node") return first === "--test";
  if (name === "python" || name === "python3") return first === "-m" && (second === "pytest" || second === "unittest");
  if (name === "pytest") return true;
  if (name === "deno") return first === "test";
  if (name === "dotnet") return first === "test";
  if (name === "mvn") return first === "test" || first === "-q" && second === "test";
  if (name === "gradle" || name === "gradlew") return args.some((arg) => arg.toLowerCase() === "test");
  if (name === "forge") return first === "test";
  if (name === "npx") return first === "hardhat" && second === "test";
  return false;
}

function isRpcFlag(input: string): boolean {
  return input === "--fork-url" || input.startsWith("--fork-url=") || input === "--rpc-url" || input.startsWith("--rpc-url=") || input === "--rpc" || input.startsWith("--rpc=");
}

function isNetworkFlag(input: string): boolean {
  return input === "--network" || input.startsWith("--network=");
}

function valueAfterEquals(input: string): string | undefined {
  const idx = input.indexOf("=");
  return idx === -1 ? undefined : input.slice(idx + 1);
}

function isLocalNetworkValue(input: string): boolean {
  const lowered = input.toLowerCase();
  if (["localhost", "127.0.0.1", "::1", "hardhat", "anvil", "foundry", "local", "devnet", "regtest"].includes(lowered)) return true;
  if (isLocalUrl(input)) return true;
  return false;
}

function looksLikeRemoteUrl(input: string): boolean {
  return /^https?:\/\//i.test(input) || /^wss?:\/\//i.test(input);
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

function looksLikeRpcEnvReference(input: string): boolean {
  return /(?:^|[${_%])(?:[A-Z0-9_]*(?:RPC|ALCHEMY|INFURA|QUICKNODE|MORALIS|ETHERSCAN|PRIVATE_KEY|MNEMONIC|TOKEN|SECRET)[A-Z0-9_]*)/i.test(input);
}
