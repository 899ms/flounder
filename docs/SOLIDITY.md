# Solidity And EVM Contract Audits

`configs/solidity-contract-hunt.default.json` is the default profile for authorized Solidity and EVM smart-contract audits.

The profile keeps the framework's discovery rules intact: deterministic project profiles, source indexes, provenance facts, tool outputs, and local seeders are planning evidence only. Findings still require model-backed audit trials, source verification, and optional local-only reproduction.

## What The Profile Adds

- Solidity and EVM project context for assets, authorities, trust boundaries, attacker capabilities, and invariants.
- Domain lens packs for entrypoint authorization, token accounting, vault share accounting, callbacks, reentrancy, oracle manipulation, signatures, permits, bridges, upgradeability, storage layout, liquidation, solvency, deployment, and dependency trust.
- Custom auditor agents for EVM-specific failure modes such as `evm_token_accounting`, `evm_vault_share_accounting`, `evm_oracle_manipulation`, `evm_upgradeability_storage`, `evm_bridge_message_replay`, and `evm_liquidation_solvency`.
- Solidity provenance extraction for externally callable functions, external calls, delegatecall, state writes, auth guards, signatures, oracle reads, upgrade hooks, token transfers, and unchecked arithmetic.
- EVM-specific portfolio enumeration that turns provenance facts into candidate audit items for public entrypoints, token movements, external calls, proxies, signatures, oracles, and unchecked arithmetic.
- Default `augment` scope mode with a lens-free baseline reserve, so manually selected contract lenses do not become an accidental hard boundary.
- Local reproduction compatibility with Foundry and Hardhat test commands under the existing white-hat command policy.

## Recommended Run

```bash
fsa run \
  --config ./configs/solidity-contract-hunt.default.json \
  --target protocol-contract-audit \
  --source <target>/src <target>/contracts \
  --corpus <target>/README.md <target>/docs <target>/specs \
  --provider openai \
  --model gpt-5.5 \
  --rounds 3 \
  --trials 4
```

For larger repositories, use a QMD collection scoped to the target material:

```bash
fsa run \
  --config ./configs/solidity-contract-hunt.default.json \
  --target protocol-contract-audit \
  --source <target>/src <target>/contracts \
  --corpus <target>/README.md <target>/docs <target>/specs \
  --qmd-collection target-contracts
```

## Local Reproduction

The default profile does not plan or execute reproductions during the audit run. After findings are collected, request local-only reproduction planning or execution explicitly:

```bash
fsa reproduce \
  --run runs/<target-run> \
  --source <target> \
  --repro plan \
  --verify-top 20
```

When execution is enabled, reproduction commands are restricted to local test runners such as:

- `forge test`
- `npx hardhat test`

The command policy blocks public-network broadcast, transfer, credential, persistence, and exploit-optimization flows.

High-impact contract findings are forced through follow-up beyond the normal ranked topK queue by default. This includes value/accounting breaks, reentrancy and callback exposure, privileged path bypasses, signature replay, oracle manipulation, liquidation/solvency breaks, bridge message replay, and upgradeability or storage-layout issues. Increase `--high-impact-max-findings` for high-budget hunts.

Executable confirmation requires verifier-owned `executableSuccessPatterns` in local command output. A passing `forge test` or `npx hardhat test` command is not enough by itself, and ReproductionAgent-only strings cannot upgrade a finding to `confirmed-executable`; the output must match the source verifier's intended invariant break, regression test, or fix-validation signal.

For EVM projects, fork and RPC flags are also local-only. `forge test --fork-url http://127.0.0.1:8545` is allowed, but public RPC URLs, public Hardhat networks, and arguments that reference RPC or secret environment variables are blocked. Use a local Anvil, Hardhat, or isolated devnet endpoint when executable reproduction is required.

## Input Checklist

Load as much source-backed context as possible:

- `src/`, `contracts/`, `script/`, deployment libraries, generated address registries, and linked libraries.
- `foundry.toml`, `remappings.txt`, Hardhat configs, compiler settings, and dependency manifests.
- Protocol specs, whitepapers, docs, invariants, prior audits, known limitations, and threat-model notes.
- Fuzz, invariant, and unit tests as context. Tests are coverage evidence, not proof that a property is enforced.

For high-stakes runs, extend `projectContext` with the exact protocol assets, roles, deployed components, upgrade model, oracle model, cross-chain assumptions, and out-of-scope components.

Leave `scopeMode` as `augment` for general bug hunting and bounty-oriented audits. Use `restrict` only for engagements where the owner has explicitly limited the authorized scope and the report should not search adjacent code paths outside that boundary.
