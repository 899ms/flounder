# full-stack-auditor

White-hat security audit framework for autonomous, model-driven source investigation.

The public workflow is `fsa run`: a thin agentic loop where the model decides what to read, inspect, edit in a sandbox, test, and report. The framework provides capability and guarantees, not strategy.

```bash
fsa run --target my-target --source ./src --corpus ./docs --max-steps 40
```

## Design Principle

The framework should only do what the model cannot safely or physically do for itself:

- load authorized source and reference material;
- expose pi-style generic tools for reading, writing, editing, and local shell work;
- run local inspection and tests inside an isolated workspace;
- enforce command safety and public-release hygiene;
- persist a replayable transcript, reports, and project memory;
- keep the hard confirmation boundary: a claim is not executable-confirmed until a local command proves it.

Everything about what might be a bug and how to investigate it belongs to the agent.

## Agentic Flow

```mermaid
flowchart TD
  A["fsa run"] --> B["Load source and corpus"]
  B --> C["Create logger, history, memory, session"]
  C --> D["Expose generic tools"]
  D --> E["Agent emits one JSON action or done"]
  E --> F{"Tool"}
  F --> G["read"]
  F --> H["write / edit sandbox files"]
  F --> I["bash in copied workspace"]
  G --> N["Observation appended to transcript"]
  H --> N
  I --> O{"Command confirmation-eligible?"}
  O -->|yes| N
  O -->|no| N
  N --> E
  E --> P["done"]
  P --> Q["Parse findings.json"]
  Q --> R{"Cites passed command_id?"}
  R -->|yes| S["confirmed-executable"]
  R -->|no| T["suspected"]
  S --> U["Write artifacts and history"]
  T --> U
```

## Tools

The tool surface is intentionally small:

- `read`: read loaded source/corpus or files created in the sandbox.
- `write`: write a file into the copied sandbox workspace.
- `edit`: replace text in a file inside the copied sandbox workspace.
- `bash`: run one policy-gated local inspection or test command in the copied workspace.

There are no default bug-class, dataflow, checklist, memory, or report tools. If those are useful later, they should be optional extensions or materials the model can choose to inspect, not framework-owned strategy.

## Confirmation

Findings use two statuses:

- `suspected`: the agent reported a candidate without a passing cited local test.
- `confirmed-executable`: the agent wrote `findings.json` with a `command_id` that cites a confirmation-eligible `bash` record.

The framework checks the recorded command result. The model cannot upgrade a finding by assertion. Local execution must stay local: unit tests, fixtures, regtest/devnet, forked local nodes, or isolated harnesses only.

## Install

```bash
npm install
npm run build
npm test
```

For live model runs, configure provider credentials in your shell or secret manager according to the pi-ai provider documentation. Do not commit credentials, local environment files, private corpora, or machine-specific paths.

## Usage

One command; the model decides what to read, test, and report. The flags below shape *what* it audits and *how thoroughly* — never *what the bug is*.

### Materials

- `--source <paths...>` — the code under audit. Point it at the buildable project root (the directory holding the manifest/lockfile) so the agent can execution-confirm.
- `--build-root <dir>` — when `--source` is narrow inside a larger workspace, the build root the sandbox copies so the project compiles (the model still reads only `--source`). A buildable workspace is what separates `confirmed` from `suspected`.
- `--corpus <paths...>` — design **intent** the model reads to derive what the code MUST enforce: the project's real specs, whitepapers, design notes, prior audits, or a strictly factual incident brief. Corpus is context, never answers — it must not name the bug, its location, or its mechanism, and you should not author it yourself. Give the spec and let the model find the gap.

### Modes

All modes share the tools, the confirmation gate, and the local-only boundary.

| Mode | When to use |
|---|---|
| breadth (default) | a quick survey of a small target |
| `--deep` (map → dig) | **the default for a real audit** — MAP enumerates and scores a complete scope inventory; DIG deep-audits the highest-scored scopes obligation-by-obligation and execution-confirms. Resumable, never silently drops a scope. |
| `--deep-focus <region>` | skip enumeration; deep-audit one region you already care about |
| `--scope <id,...>` | after a `--deep` map, dig specific inventory items (the human-in-the-loop pick over the complete map) |
| `--verify <findings.json>` | confirm-or-refute existing suspected findings by execution — the standalone confirmation step on a prior run's `audit_findings.json` |

### Most effective setup

For a real audit, run `--deep` on a buildable target:

```bash
fsa run --deep \
  --target protocol \
  --source ./contracts --build-root . \
  --corpus ./docs/specs \
  --provider openai-codex \
  --map-steps 60 --dig-steps 60 --dig-samples 2
```

- Set `--build-root` so the dig can execution-confirm — without it you only get `suspected` findings.
- Give generous budgets and **do not interrupt a dig**; a decisive obligation can surface late in its step budget.
- `--dig-samples K` unions K independent passes (variance reduction); `--dig-concurrency N` digs N scopes in parallel; `--remap` re-enumerates. Reliability comes from coverage and repetition, not prompt tuning.
- The codex provider (`openai-codex`) is the recommended autonomous path; it needs a one-time interactive `pi` `/login`.

### Confirmation ladder

`suspected` → `confirmed-executable` (a cited `purpose=confirm` test actually passed) → `confirmed-differential` (the model's fix, applied to pristine source, blocks the exploit). An independent refutation skeptic then re-judges every confirmation: a **vacuous** one — a PoC that only triggers by giving a trusted/pinned component behavior a real attacker cannot cause — is downgraded and flagged, never silently dropped. A downgraded finding gets one **appeal**: it rebuilds a faithful PoC answering the exact objection, and if that survives re-judgement the finding is recovered; the original confirmation, the refutation, and the appeal outcome are all kept (`--no-appeal` to skip). Build the PoC the way the attacker would — assume only capabilities a real attacker has, exercise the real components, and never grant yourself something the deployed system would deny.

### Examples

**Zcash — Rust ZK circuits (stack-agnostic, execution-confirmed).** Audit a circuit crate for a soundness gap: `--source` the crate, `--build-root` the cargo workspace, `--corpus` the circuit's design spec. `--deep` makes MAP enumerate the circuit's constraints — including operands the spec treats as given, a classic under-constrained-witness bug — and DIG write a `MockProver` malicious-witness test. A real crate-internal soundness bug reached `confirmed-differential` this way (the model wrote the exploit, the framework built and ran it, then applied the model's fix and re-ran to show it blocked). A subtle one needs `--scope` + `--dig-samples` and an uninterrupted dig.

**Aztec — Solidity rollup (incident analysis and cold audit).** Two scenarios on the deployed `RollupProcessorV3`:

- *Incident analysis* — give the agent the real deployed contracts (`--source`/`--build-root` on the Foundry project), the official Aztec specs, and a strictly factual on-chain incident brief (`--corpus`); nothing you authored, no hand-picked scope. Let it localize, then `--verify` (or the dig) confirms by execution.
- *Cold audit* — the same materials **minus** the incident brief. From scratch, `--deep` independently flagged the decode/settlement region and reached `confirmed-differential` on an unbound-input bug (`numRealTransactions` not bound to the verifier's public-input hash), with a faithful proof-of-malleability PoC — with no knowledge that an incident had ever occurred.

### Local checks

```bash
npm run mock-audit     # offline smoke test with the deterministic mock model
npm run check:public  # public-surface scan for secrets and local paths
npm run verify        # full local verification gate
```

## Reproduction

Reproduction is part of the audit itself: the agent calls `bash` to write and run local tests in the copied workspace, and a finding only reaches `confirmed-executable` when a `purpose=confirm` test passes. The agent writes files only inside a copied workspace under the run directory; it never modifies the target source tree. Command safety blocks public-network broadcast, transfer, credential, persistence, and exploit-optimization flows.

## Domain Profiles

Config files under `configs/` can still provide source paths, corpus paths, project context, and optional domain hints. In audit mode, these are context, not a framework-owned checklist.

Examples:

```bash
fsa run \
  --config ./configs/solidity-contract-audit.default.json \
  --target contract-audit \
  --source <contract-source-paths...> \
  --corpus <specs-docs-and-prior-audit-material...> \
  --provider openai \
  --model gpt-5.5
```

```bash
fsa run \
  --config ./configs/cairo-starknet-audit.default.json \
  --target starknet-audit \
  --source <cairo-and-contract-source-paths...> \
  --corpus <specs-docs-and-prior-audit-material...> \
  --provider openai \
  --model gpt-5.5
```

See [docs/SOLIDITY.md](docs/SOLIDITY.md) and [docs/STARKNET.md](docs/STARKNET.md).

## Pi Package

Try the package locally from this directory:

```bash
pi -e .
```

The extension registers `fsa_run` and installs the shared command-safety guardrail for shell commands.

## Outputs

Each audit writes:

- `audit_transcript.json`: replayable action/observation trace.
- `audit_findings.json`: raw agent-reported findings.
- `audit_command_runs.json`: local sandbox command records.
- `summary.json`: ranked finding summary and coverage.
- `report_<id>.md`: private disclosure drafts.
- `events.jsonl` and `calls/*.json`: audit trace and model-call records.
- `<out>/history/<target>/memory.jsonl`: durable per-target memory.
- `<out>/history/<target>/manifest.json`: project-level history.

Run artifacts are private by default. Redact before sharing outside the trusted project context.

## Library API

```ts
import { defaultConfig, runAudit, MockAuditLlmClient } from "full-stack-auditor";

const cfg = defaultConfig();
cfg.targetName = "example";
cfg.sourcePaths = ["./fixtures"];

const result = await runAudit(cfg, { llm: new MockAuditLlmClient() });
console.log(result.runDir);
```

Use `full-stack-auditor/pi/extension` for the pi package extension entrypoint.

## White-Hat Rules

- Audit only authorized code or public bug-bounty scope.
- Verification must be local-only: unit tests, regtest, devnet, forked local node, or isolated harness.
- Never broadcast or execute against public testnet/mainnet.
- Do not write value-extraction exploits, exfiltrate data, or read secrets.
- Build the smallest local proof needed to confirm or refute the invariant break.
- Report privately and coordinate disclosure.

## Contributing And Security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
