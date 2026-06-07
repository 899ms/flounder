import type { Doc, ProofObligation, ProvenanceFact, ProvenanceFactKind, ProvenanceGraph } from "../types.js";

const SIGNAL_TERMS = [
  "asset",
  "balance",
  "bridge",
  "bus",
  "credit",
  "delegatecall",
  "erc20",
  "endpoint",
  "erc4626",
  "fee",
  "flash",
  "governance",
  "guid",
  "hydra",
  "initializer",
  "layerzero",
  "liquidation",
  "lzreceive",
  "lzsend",
  "cooldown",
  "collateral",
  "custodian",
  "decimals",
  "eip1271",
  "eip712",
  "deadline",
  "global",
  "mint",
  "native drop",
  "order",
  "oracle",
  "oft",
  "permit",
  "proxy",
  "redeem",
  "receiver",
  "restricted",
  "refund",
  "shares",
  "spell",
  "staker",
  "stable",
  "stargate",
  "starguard",
  "storage",
  "subproxy",
  "supply",
  "timelock",
  "ticket",
  "transfer",
  "upgrade",
  "vault",
  "whitelist",
  "withdraw",
];

export function extractSolidityProvenance(source: Doc[]): ProvenanceGraph {
  const facts: ProvenanceFact[] = [];
  let files = 0;
  for (const doc of source) {
    if (!looksLikeSolidityDoc(doc)) continue;
    files += 1;
    facts.push(...extractFactsFromDoc(doc));
  }
  const obligations = solidityRoutingObligations(facts);
  return {
    domain: "solidity",
    facts,
    obligations,
    summary: {
      files,
      facts: facts.length,
      byKind: countBy(facts, (fact) => fact.kind),
      assignmentFlowObligations: obligations.length,
    },
  };
}

function extractFactsFromDoc(doc: Doc): ProvenanceFact[] {
  const out: ProvenanceFact[] = [];
  const lines = doc.content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const code = stripInlineComment(line).trim();
    if (code.length === 0) continue;
    const functionName = enclosingFunction(lines, idx);
    const nearbySignals = nearbySignalsFor(lines, idx);
    for (const fact of factsFromLine(doc.path, idx + 1, code, functionName, nearbySignals)) {
      out.push(fact);
    }
  }
  return out;
}

function factsFromLine(
  path: string,
  line: number,
  code: string,
  functionName: string | undefined,
  nearbySignals: string[],
): ProvenanceFact[] {
  const out: ProvenanceFact[] = [];
  const common = { path, line, functionName, nearbySignals, code };

  const functionMatch = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*([^;{]*)/.exec(code);
  if (functionMatch) {
    const signature = oneLine(`${functionMatch[1]}(${functionMatch[2] ?? ""}) ${functionMatch[3] ?? ""}`);
    if (/\b(external|public)\b/.test(functionMatch[3] ?? "")) {
      out.push(fact({ ...common, kind: "evm_external_function", label: functionMatch[1], sourceExpression: signature }));
    }
    if (/\b(initializer|reinitializer|onlyProxy|upgradeTo|upgradeToAndCall)\b/i.test(code)) {
      out.push(fact({ ...common, kind: "evm_upgrade_hook", label: functionMatch[1], sourceExpression: signature }));
    }
  }

  if (/\b(receive|fallback)\s*\(/.test(code)) {
    out.push(fact({ ...common, kind: "evm_external_function", label: "fallback_or_receive", sourceExpression: code }));
  }

  if (/\b(require|if)\s*\([^)]*(msg\.sender|hasRole|owner\(\)|_owner|onlyOwner|onlyRole|AccessControl)/i.test(code) || /\bonly[A-Za-z0-9_]*\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_auth_guard", sourceExpression: code }));
  }

  if (/\.delegatecall\s*\(/.test(code)) {
    out.push(fact({ ...common, kind: "evm_delegatecall", sourceExpression: code }));
  }

  if (/\.(call|staticcall|transfer|send)\s*(?:\{|\.|\()/.test(code)) {
    out.push(fact({ ...common, kind: "evm_external_call", sourceExpression: code }));
  }

  if (/\b(safeTransferFrom|transferFrom|safeTransfer|transfer|_mint|_burn|mint|burn)\s*\(/.test(code)) {
    out.push(fact({ ...common, kind: "evm_token_transfer", sourceExpression: code }));
  }

  if (/\b(?:_lzSend|lzReceive|_lzReceive|sendCompose|isComposeMsgSender|Origin|OApp|endpoint|peers?|setPeer|quoteTaxi|taxi|rideBus|driveBus|encodeTaxi|decodeTaxi|encodeBus|decodeBus|encode\(|decode\()\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_bridge_message", sourceExpression: code }));
  }

  if (/\b(?:assetId|assetIds|stargateImpls|setAssetId|_safeGetAssetId|_safeGetStargateImpl|maxAssetId|localEid|dstEid|srcEid)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_bridge_asset_mapping", sourceExpression: code }));
  }

  if (/\b(?:paths|credit|credits|sendCredits|receiveCredits|increaseCredit|decreaseCredit|tryDecreaseCredit|burnCredit|UNLIMITED_CREDIT|PathLib|deficit|poolBalance|tvlSD|treasuryFee|applyFee|amountSD|minAmountLD)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_bridge_credit_accounting", sourceExpression: code }));
  }

  if (/\b(?:nativeDrop|nativeDropAmount|totalNativeDrops|transferNative|safeTransferNative|plannerFee|refundAddress|busFare|fare)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_bridge_native_drop", sourceExpression: code }));
  }

  if (/\b(?:OFT|IOFT|IERC20Minter|mint|burn|burnFrom|_capReward|_inflow|_outflow|sharedDecimals|convertRate|ld2sd|sd2ld|amountLD|amountSD)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_oft_supply_change", sourceExpression: code }));
  }

  if (/\b(ecrecover|ECDSA\.recover|_hashTypedDataV4|DOMAIN_SEPARATOR|permit|nonces?|isValidSignature|IERC1271|EIP1271_MAGICVALUE)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_signature_check", sourceExpression: code }));
  }

  if (/\b(?:IERC1271|isValidSignature|EIP1271|EIP1271_MAGICVALUE|SignatureType\.EIP1271|InvalidEIP1271Signature)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_eip1271_signature", sourceExpression: code }));
  }

  if (
    /\b(?:mint|redeem|Mint|Redeem|Order|order|order_id|verifyOrder|verifyRoute|route|custodian|custody|collateral|beneficiary|benefactor|notional|price|EIP712|EIP1271|_hashTypedDataV4|verifyNonce|nonce|deadline|expiry)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_mint_redeem_order", sourceExpression: code }));
  }

  if (
    /\b(?:whitelistedBenefactors|_whitelistedBenefactors|addWhitelistedBenefactor|removeWhitelistedBenefactor|isWhitelistedBenefactor|approvedBeneficiaries|_approvedBeneficiariesPerBenefactor|setApprovedBeneficiary|isApprovedBeneficiary|BenefactorNotWhitelisted|BeneficiaryNotApproved|BeneficiaryAdded|BeneficiaryRemoved)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_beneficiary_allowlist", sourceExpression: code }));
  }

  if (
    /\b(?:verifyStablesLimit|stablesDeltaLimit|STABLES_RATIO_MULTIPLIER|TokenType\.STABLE|InvalidStablePrice|collateralDecimals|usdeDecimals|normalizedCollateralAmount|differenceInBps|_getDecimals|decimals\(\)|tokenType)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_stable_price_limit", sourceExpression: code }));
  }

  if (
    /\b(?:maxMintPerBlock|maxRedeemPerBlock|globalMaxMintPerBlock|globalMaxRedeemPerBlock|totalPerBlock|totalPerBlockPerAsset|BlockTotals|GlobalConfig|belowGlobalMax|belowMaxMintPerBlock|belowMaxRedeemPerBlock|disableMintRedeem)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_block_limit", sourceExpression: code }));
  }

  if (
    /\b(?:StarGuard|StarSpell|SubProxy|spellData|plot|drop|exec|isExecutable|codehash|deadline|maxDelay|wards|Rely|Deny|delegatecall)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_governance_payload", sourceExpression: code }));
  }

  if (
    /\b(?:ERC4626|deposit|withdraw|redeem|mint|cooldown|cooldowns?|silo|totalAssets|convertToShares|previewDeposit|previewWithdraw|previewRedeem|shares|asset\(\)|maxWithdraw|maxRedeem)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_erc4626_cooldown", sourceExpression: code }));
  }

  if (
    /\b(?:FULL_RESTRICTED|SOFT_RESTRICTED|BLACKLIST|allowlist|whitelist|blacklist|restricted|restriction|hasRole|grantRole|revokeRole|renounceRole|onlyRole|MINTER_ROLE|REDEEMER_ROLE|GATEKEEPER|custodian)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_restriction_role", sourceExpression: code }));
  }

  if (/\b(latestRoundData|getRoundData|getPrice|priceFeed|oracle|twap|answer|sequencer)\b/i.test(code)) {
    out.push(fact({ ...common, kind: "evm_oracle_read", sourceExpression: code }));
  }

  if (/\b(upgradeTo|upgradeToAndCall|_authorizeUpgrade|initializer|reinitializer|proxiableUUID|__gap)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_upgrade_hook", sourceExpression: code }));
  }

  if (/\bunchecked\s*\{/.test(code)) {
    out.push(fact({ ...common, kind: "evm_unchecked_arithmetic", sourceExpression: code }));
  }

  if (looksLikeStateWrite(code)) {
    out.push(fact({ ...common, kind: "evm_state_write", sourceExpression: code }));
  }

  return out;
}

function solidityRoutingObligations(facts: ProvenanceFact[]): ProofObligation[] {
  const obligations: ProofObligation[] = [];
  pushObligation(obligations, facts, "evm_external_call", {
    id: "solidity-external-call-state-finalization",
    property:
      "External calls and callbacks should be audited with local state, accounting, reentrancy guard, and return-value handling in the same transaction boundary.",
    keywords: ["external call", "reentrancy", "callback", "accounting"],
  });
  pushObligation(obligations, facts, "evm_delegatecall", {
    id: "solidity-delegatecall-storage-and-auth",
    property:
      "Delegatecall and proxy execution paths should be tied to explicit authorization and storage-layout compatibility assumptions.",
    keywords: ["delegatecall", "proxy", "storage", "authorization"],
  });
  pushObligation(obligations, facts, "evm_upgrade_hook", {
    id: "solidity-upgrade-initializer-storage",
    property:
      "Upgrade and initializer hooks should enforce authorization, single-use initialization, implementation compatibility, and storage-layout safety.",
    keywords: ["upgrade", "initializer", "storage layout", "proxy"],
  });
  pushObligation(obligations, facts, "evm_signature_check", {
    id: "solidity-signature-domain-replay",
    property:
      "Signature acceptance should bind signer, action, amount or authority, nonce, deadline, chain id, verifying contract, and domain separator.",
    keywords: ["signature", "permit", "nonce", "domain separator", "replay"],
  });
  pushObligation(obligations, facts, "evm_oracle_read", {
    id: "solidity-oracle-freshness-manipulation",
    property:
      "Oracle reads that influence value-sensitive state should validate freshness, decimals, positivity, sequencer or liveness assumptions, and manipulation resistance.",
    keywords: ["oracle", "price", "freshness", "manipulation", "decimals"],
  });
  pushObligation(obligations, facts, "evm_token_transfer", {
    id: "solidity-token-transfer-accounting",
    property:
      "Token movement should be reconciled with balance deltas, fee-on-transfer behavior, callback behavior, decimals, and value-conservation invariants.",
    keywords: ["token transfer", "balance delta", "fee-on-transfer", "value conservation"],
  });
  pushObligation(obligations, facts, "evm_unchecked_arithmetic", {
    id: "solidity-unchecked-arithmetic-bounds",
    property:
      "Unchecked arithmetic should be audited against visible preconditions that bound overflow, underflow, rounding, and precision loss.",
    keywords: ["unchecked", "overflow", "rounding", "precision"],
  });
  pushObligation(obligations, facts, "evm_external_function", {
    id: "solidity-public-entrypoint-state-invariants",
    property:
      "Externally callable state-changing entrypoints should be audited for authorization, pause or lifecycle constraints, replay protection, and state/accounting invariants.",
    keywords: ["external function", "authorization", "state transition", "invariant"],
  });
  pushObligation(obligations, facts, "evm_bridge_message", {
    id: "solidity-bridge-message-domain-and-payload-binding",
    property:
      "Bridge message send and receive paths should bind source chain, destination chain, peer, asset id, receiver, amount, compose payload, nonce or ticket, refund, and message type before value is minted or released.",
    keywords: ["bridge message", "layerzero", "payload", "peer", "replay", "receiver"],
  });
  pushObligation(obligations, facts, "evm_bridge_asset_mapping", {
    id: "solidity-bridge-asset-id-route-binding",
    property:
      "Bridge asset mappings should prevent asset-id, route, endpoint, and implementation confusion across local and remote pools or OFTs.",
    keywords: ["asset id", "route", "endpoint", "stargate", "implementation"],
  });
  pushObligation(obligations, facts, "evm_bridge_credit_accounting", {
    id: "solidity-bridge-credit-and-liquidity-conservation",
    property:
      "Bridge credit, pool balance, treasury fee, reward, deficit, and shared-decimal accounting should conserve value across local settlement, remote release, and planner-driven credit movement.",
    keywords: ["credit", "liquidity", "pool balance", "treasury fee", "shared decimals"],
  });
  pushObligation(obligations, facts, "evm_bridge_native_drop", {
    id: "solidity-bridge-native-drop-fee-isolation",
    property:
      "Native-drop, fare, refund, and planner-fee handling should keep user transfer value, execution gas value, and protocol fees isolated under failed receiver callbacks and partial delivery.",
    keywords: ["native drop", "fare", "refund", "planner fee", "callback"],
  });
  pushObligation(obligations, facts, "evm_oft_supply_change", {
    id: "solidity-oft-mint-burn-lock-unlock-conservation",
    property:
      "OFT mint, burn, lock, unlock, dust removal, and shared-decimal conversion paths should preserve one-to-one supply and redemption invariants across chains.",
    keywords: ["oft", "mint", "burn", "lock", "unlock", "shared decimals"],
  });
  pushObligation(obligations, facts, "evm_mint_redeem_order", {
    id: "solidity-mint-redeem-order-collateral-binding",
    property:
      "Mint and redeem orders should bind signer, beneficiary, collateral asset, custodian route, amount, price, nonce, deadline, chain, verifying contract, and transfer direction before minting or releasing value.",
    keywords: ["mint", "redeem", "order", "collateral", "custodian", "nonce", "deadline"],
  });
  pushObligation(obligations, facts, "evm_erc4626_cooldown", {
    id: "solidity-erc4626-cooldown-share-asset-conservation",
    property:
      "ERC4626 staking, cooldown, silo, deposit, withdraw, and redeem paths should preserve share-to-asset accounting under donations, vesting, rounding, restrictions, and time-based exits.",
    keywords: ["erc4626", "cooldown", "shares", "assets", "silo", "rounding"],
  });
  pushObligation(obligations, facts, "evm_restriction_role", {
    id: "solidity-role-restriction-transfer-and-privilege-boundaries",
    property:
      "Role, allowlist, blacklist, restriction, minter, redeemer, gatekeeper, and custodian controls should be enforced at every asset-moving entrypoint and should not be bypassable through transfers, approvals, relayers, or alternate call paths.",
    keywords: ["role", "restriction", "allowlist", "blacklist", "minter", "redeemer", "custodian"],
  });
  pushObligation(obligations, facts, "evm_eip1271_signature", {
    id: "solidity-eip1271-contract-signature-boundary",
    property:
      "EIP-1271 contract signature checks should bind the intended contract benefactor, action, nonce, domain, and beneficiary while containing callback side effects during signature validation.",
    keywords: ["eip1271", "contract signature", "benefactor", "callback", "nonce"],
  });
  pushObligation(obligations, facts, "evm_beneficiary_allowlist", {
    id: "solidity-benefactor-beneficiary-allowlist-binding",
    property:
      "Benefactor whitelists and beneficiary approvals should be enforced before value movement and should not be bypassable through delegated signers, contract signatures, relayers, or stale approvals.",
    keywords: ["benefactor", "beneficiary", "whitelist", "approval", "delegated signer"],
  });
  pushObligation(obligations, facts, "evm_stable_price_limit", {
    id: "solidity-stable-price-decimal-limit",
    property:
      "Stablecoin mint and redeem price-delta checks should normalize decimals correctly, bound rounding and overflow, and enforce the intended loss and overpayment direction for each order type.",
    keywords: ["stable", "price", "decimals", "delta", "rounding"],
  });
  pushObligation(obligations, facts, "evm_block_limit", {
    id: "solidity-per-asset-global-block-limit",
    property:
      "Per-asset and global mint or redeem limits should measure the value that can leave or enter the protocol, not only a caller-selected nominal field that can diverge from actual settlement value.",
    keywords: ["block limit", "max mint", "max redeem", "asset limit", "global limit"],
  });
  pushObligation(obligations, facts, "evm_governance_payload", {
    id: "solidity-governance-payload-execution-boundary",
    property:
      "Governance payload execution should bind the approved payload address, codehash, selector, deadline, executability predicate, delegatecall context, and post-execution authority invariants.",
    keywords: ["governance payload", "spell", "codehash", "deadline", "delegatecall", "ward"],
  });
  return obligations;
}

function pushObligation(
  out: ProofObligation[],
  facts: ProvenanceFact[],
  kind: ProvenanceFactKind,
  input: { id: string; property: string; keywords: string[] },
): void {
  const refs = facts.filter((fact) => fact.kind === kind).map((fact) => `${fact.path}:${fact.line}`).slice(0, 16);
  if (refs.length === 0) return;
  out.push({
    id: input.id,
    kind: "provenance",
    property: input.property,
    rationale:
      "This is a Solidity provenance obligation, not a finding: the model should enumerate a source-backed audit item only if the loaded code makes this edge security-relevant.",
    evidenceRefs: refs,
    keywords: input.keywords,
  });
}

function fact(input: {
  kind: ProvenanceFactKind;
  path: string;
  line: number;
  functionName?: string | undefined;
  label?: string | undefined;
  sourceExpression?: string | undefined;
  nearbySignals: string[];
  code: string;
}): ProvenanceFact {
  return {
    id: `${input.kind}-${slug(input.path)}-${input.line}`,
    domain: "solidity",
    kind: input.kind,
    path: input.path,
    line: input.line,
    ...(input.functionName ? { functionName: input.functionName } : {}),
    ...(input.label ? { label: input.label.trim() } : {}),
    ...(input.sourceExpression ? { sourceExpression: input.sourceExpression.trim() } : {}),
    nearbySignals: input.nearbySignals,
    code: input.code,
  };
}

function looksLikeSolidityDoc(doc: Doc): boolean {
  return doc.path.endsWith(".sol");
}

function looksLikeStateWrite(code: string): boolean {
  if (!/[+\-*/%|&^]?=/.test(code)) return false;
  if (/^\s*\(/.test(code)) return false;
  if (/^\s*(?:u?int\d*|bool|address|string|bytes\d*|mapping|struct|enum)\b/.test(code)) return false;
  if (/^\s*[A-Z][A-Za-z0-9_]*(?:\[\])?\s+(?:memory|storage|calldata\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(code)) return false;
  if (/\b(require|assert|if|for|while|return|emit|revert)\b/.test(code)) return false;
  return /\b[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]+\]|\.[A-Za-z_][A-Za-z0-9_]*)?\s*[+\-*/%|&^]?=/.test(code);
}

function nearbySignalsFor(lines: string[], idx: number): string[] {
  const start = Math.max(0, idx - 6);
  const end = Math.min(lines.length, idx + 7);
  const text = lines.slice(start, end).join("\n").toLowerCase();
  return SIGNAL_TERMS.filter((term) => text.includes(term)).slice(0, 12);
}

function enclosingFunction(lines: string[], idx: number): string | undefined {
  for (let pos = idx; pos >= 0 && pos >= idx - 120; pos -= 1) {
    const line = lines[pos] ?? "";
    const functionMatch = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (functionMatch?.[1]) return functionMatch[1];
    if (/\breceive\s*\(/.test(line)) return "receive";
    if (/\bfallback\s*\(/.test(line)) return "fallback";
    const contractMatch = /\b(?:contract|library|interface)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
    if (contractMatch?.[1]) return contractMatch[1];
  }
  return undefined;
}

function stripInlineComment(input: string): string {
  return input.replace(/\/\/.*$/, "");
}

function countBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function slug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "fact";
}
