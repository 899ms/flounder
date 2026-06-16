# Solidity And EVM Contract Audits

`configs/solidity-contract-hunt.default.json` provides optional context for authorized Solidity and EVM smart-contract hunts.

In hunt mode, the profile is context, not a checklist. The agent still decides what to read, suspect, test, and report. Deterministic profiles, provenance facts, source indexes, and local seeders are planning aids only; findings must come from the agent and local evidence.

## What The Profile Adds

- Solidity/EVM project context for assets, authorities, trust boundaries, attacker capabilities, and invariants.
- Optional domain hints for authorization, governance, token accounting, share accounting, staking rewards, validator accounting, async settlement, callbacks, reentrancy, oracle manipulation, signatures, bridges, Wormhole, Hyperlane, slippage, risk configuration, upgradeability, liquidation, solvency, deployment, and dependency trust.
- Solidity provenance facts for externally callable functions, external calls, delegatecall, state writes, auth guards, signatures, oracle reads, upgrade hooks, token transfers, governance paths, name-service paths, bridge fields, and unchecked arithmetic.
- Foundry and Hardhat compatibility for local-only test execution under the shared command policy.

## Recommended Hunt

```bash
fsa run \
  --config ./configs/solidity-contract-hunt.default.json \
  --target protocol-contract-audit \
  --source <target>/src <target>/contracts \
  --corpus <target>/README.md <target>/docs <target>/specs \
  --provider openai \
  --model gpt-5.5 \
  --thinking xhigh \
  --max-steps 60
```

For larger repositories, include the highest-signal specs, prior audits, test suites, deployment notes, and threat-model material as corpus input. The agent can choose when to search or read it.

## Local Reproduction

Reproduction is part of the hunt: the agent calls `bash` to write and run local tests in the copied workspace, and a finding only becomes `confirmed-executable` when a `purpose=confirm` test passes. Commands are restricted to local test runners such as:

- `forge test`
- `npx hardhat test`

The command policy blocks public-network broadcast, transfer, credential, persistence, and exploit-optimization flows. Public RPC URLs, public Hardhat networks, and arguments that reference RPC or secret environment variables are blocked. Use local Anvil, Hardhat, or isolated devnet endpoints.

## Input Checklist

Load as much source-backed context as possible:

- `src/`, `contracts/`, scripts, deployment libraries, generated address registries, and linked libraries.
- `foundry.toml`, `remappings.txt`, Hardhat configs, compiler settings, and dependency manifests.
- Protocol specs, whitepapers, docs, invariants, prior audits, known limitations, and threat-model notes.
- Fuzz, invariant, and unit tests as context. Tests are coverage evidence, not proof that a property is enforced.

For high-stakes hunts, extend `projectContext` with exact protocol assets, roles, deployed components, upgrade model, oracle model, cross-chain assumptions, and out-of-scope components.
