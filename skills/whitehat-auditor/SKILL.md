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
3. Let reconnaissance produce project-specific lens packs when the target needs domain-specific audit guidance.
4. Enumerate `(location, security property, failure mode)` checklist items before claiming bugs.
5. Route each item to a built-in or project-specific audit lens.
6. For multi-round runs, use prior coverage and audit observations to generate novel follow-up checklist items. Do not repeat the same checklist and call it a new round.
7. Run multiple independent model-backed trials per item for stochastic coverage.
8. Aggregate by severity, hit rate, confidence, and evidence quality.
9. Verify high-priority findings with a separate skeptical pass.
10. Produce a local-only PoC scaffold and private disclosure draft.

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

Local checklist seeders, source indexes, project profiles, and lens packs are planning aids. Findings must come from model-backed audit trials grounded in specific code evidence. For blind proof runs, disable local checklist seeders so the model must enumerate the relevant audit item itself.

`rounds` are for deeper exploration and must add new checklist coverage. `trials` are independent audits of the same checklist item and are useful for agreement, confidence, and noise reduction.
