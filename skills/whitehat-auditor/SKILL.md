# White-Hat Auditor

Use this skill when auditing source code for security bugs across application, infrastructure, protocol, cryptography, proof-system, smart-contract, consensus, or value-integrity domains.

## Rules

- Work only on code the user is authorized to audit.
- Keep verification local-only: unit tests, regtest, devnet, or forked node.
- Do not broadcast transactions or run exploit flows on public testnet/mainnet.
- Generate the smallest reproduction needed to prove or refute the invariant.
- Prefer private disclosure report drafts over public exploit writeups.

## Workflow

1. Ingest source plus specs, protocol docs, papers, and implementation guides.
2. Build or review the project context: assets, attacker capabilities, trust boundaries, invariants, focus areas, and out-of-scope areas.
3. Use `fsa run` as the default workflow: let the agent decide what to read, search, test, remember, and report.
4. Treat optional project profiles, source indexes, provenance facts, and bug-class references as tools or context only.
5. Do not require a fixed checklist, failure-mode taxonomy, search schedule, rounds, or trials before the agent can investigate.
6. Confirm strong hypotheses with local-only tests through the sandbox.
7. Record findings privately with exact source evidence and confirmation status.

## Failure Modes

- Missing constraints in circuits or proof systems.
- Supply or balance integrity violations.
- Double-spend/nullifier/replay failures.
- Spec-implementation mismatches.
- Consensus divergence.
- Integer overflow, truncation, and unchecked arithmetic.
- Input validation, injection, SSRF, path traversal, deserialization, and parser safety.
- Authorization gaps, tenant isolation, and privilege-boundary failures.
- Reentrancy.
- Cryptographic misuse.
- Race conditions and idempotency failures.
- Secret exposure and dependency supply-chain trust.
- DoS/resource amplification.

Findings must come from the agent's own investigation grounded in specific code evidence. The framework provides capability and confirmation guarantees (sandboxed tools, a toolchain warm-up, and an execution-confirmation gate), not a checklist or a way to tell the model how to think.
