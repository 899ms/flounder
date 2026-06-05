# full-stack-auditor

White-hat full-stack security audit agent framework for model-driven source auditing across languages, stacks, and security domains.

This implementation is TypeScript-first and uses pi-mono as the agent/runtime integration point. The audit core stays framework-light so it can run as a batch CLI, a pi package extension, a coding-agent workflow, or a future UI/RPC service.

## Design

The core workflow is:

1. Load source, specs, papers, books, and implementation notes.
2. Build a deterministic project profile from language, framework, manifest, entrypoint, and security-domain signals.
3. In live runs, let the model perform project reconnaissance and propose dynamic lens packs.
4. Enumerate concrete audit items before looking for bugs.
5. Route each item to built-in or project-specific failure-mode agents.
6. Run one or more exploration rounds. Later rounds use prior coverage and audit observations to propose novel follow-up items.
7. Run multiple independent model audit trials per item.
8. Aggregate by severity, hit rate, confidence, and evidence quality.
9. Verify findings separately, in local sandbox-only tests.
10. Keep a complete audit trail of prompts, model outputs, artifacts, and events.

Only model-backed audit trials produce bug findings. Project profiles, source indexes, dynamic lens packs, and local checklist seeders organize context and propose questions; they do not count as discovery evidence by themselves.

`rounds` and `trials` are separate controls. Rounds deepen project exploration by generating new checklist items from previous coverage gaps. Trials repeat the audit of one item to measure stochastic agreement and reduce one-off model noise. A multi-round run must add novel checklist coverage; it is not a replay of a single pass.

## Why pi-mono

pi already provides the pieces this project will need if it grows into a coding agent:

- `@earendil-works/pi-ai` for multi-provider LLM calls.
- `@earendil-works/pi-coding-agent` for SDK sessions, tools, extensions, skills, prompts, and RPC mode.
- Project-local `.pi` style extensibility through package manifests.

The framework therefore exposes both:

- a normal CLI: `fsa run ...`
- a pi package: `package.json` declares `src/pi/extension.ts`, `skills/`, and `prompts/`

LLM calls use `@earendil-works/pi-ai` by default. A local `codex-cli` fallback provider is available for environments where pi provider credentials are unavailable but Codex CLI is authenticated; it is opt-in and not the default path.
Provider availability is a runtime concern. Do not hard-code assumptions that every model family is available through every pi provider.

## Install

```bash
npm install
npm run build
npm test
```

For live model runs, configure provider credentials in your shell or secret manager according to the pi-ai provider documentation. Do not commit credentials, local environment files, or machine-specific paths.

## Dry Run

```bash
npm run dry-run
```

This reads local source and emits checklist items without calling a model. Dry-run output is useful for coverage inspection, but it cannot produce bug findings.

## Mock End-to-End Run

```bash
npm run mock-run
```

This runs the full pipeline with a deterministic mock LLM: enumeration, audit trials, aggregation, verification, report generation, and audit-trail logging. It is the no-API-key smoke test.

## Full Run

```bash
fsa run \
  --target protocol-audit \
  --source ./src ./contracts \
  --corpus ./docs ./specs \
  --provider openai \
  --model gpt-5.5 \
  --thinking xhigh \
  --rounds 2 \
  --trials 4
```

Artifacts are written under `runs/<target>-<timestamp>/`.

If pi provider credentials are unavailable but local Codex CLI is authenticated, use the fallback provider:

```bash
fsa run --config ./audit-config.json --provider codex-cli --model gpt-5.5 --thinking xhigh
```

For cost-controlled exploratory runs, cap checklist size explicitly:

```bash
fsa run --config ./audit-config.json --max-items 25
```

The default is uncapped.

## Project-Specific Lens Packs

Generic built-in agents are the default baseline. For a real project, add project context and custom lens packs through a JSON config file:

```json
{
  "targetName": "example-service",
  "sourcePaths": ["./src"],
  "corpusPaths": ["./docs"],
  "projectContext": {
    "criticalAssets": ["tenant-owned records", "billing state"],
    "attackerCapabilities": ["authenticated low-privilege user", "malicious webhook sender"],
    "trustBoundaries": ["HTTP request to database object ownership"],
    "securityInvariants": ["users can access only objects in their tenant"],
    "focusAreas": ["authorization", "webhook processing", "billing state transitions"]
  },
  "lensPacks": [
    {
      "id": "tenant-isolation",
      "displayName": "Tenant Isolation",
      "failureModes": ["cross_tenant_object_access", "access_control"],
      "auditorAgents": [
        {
          "failureMode": "cross_tenant_object_access",
          "id": "tenant-object-auditor",
          "displayName": "Tenant Object Auditor",
          "guidance": "Trace tenant identity, object id, authorization checks, and query predicates together."
        }
      ],
      "enumerationGuidance": ["Find routes and jobs that load objects by id."],
      "auditGuidance": ["Confirm tenant ownership is enforced in the same query or transaction."]
    }
  ]
}
```

Run it with:

```bash
fsa run --config ./audit-config.json --provider openai --model gpt-5.5 --thinking xhigh
```

Live runs also enable dynamic lens discovery by default. The model reads the project profile and loaded context, writes `lens_packs.json`, and uses those lens packs during enumeration and audit. Disable that stage with `--no-dynamic-lenses` when you want only configured lenses.

## Public Release Check

```bash
npm run check:public
```

This scans the public source surface for local absolute paths and high-confidence secret patterns. It is also part of `npm run verify`.

## Blind Discovery Check

```bash
npm run check:blind-discovery
```

This runs a dry-run audit against a neutral fixture and asserts that the framework can enumerate a generic checklist item without target-specific hints. It is a checklist coverage gate, not proof of model reasoning.

To run a live model-only discovery assertion against an external source tree without committing that source:

```bash
npm run check:source-discovery -- \
  --source <path> \
  --corpus <reference-paths...> \
  --provider openai \
  --model gpt-5.5 \
  --thinking xhigh \
  --trials 4 \
  --max-items 25
```

`check:source-discovery` is intentionally not part of default CI because it requires provider credentials and live model calls. It fails unless an audit model call is recorded and a model-produced finding generates a disclosure report.

For stronger blind-proof runs, this gate disables local checklist seeders by default. The model must first enumerate the matching audit item, then audit it. Use `--allow-local-seeders` only for debugging checklist coverage.

Add `--rounds <n>` to test iterative deepening. Round 2 and later write `round_<n>_deepening_items.json`; the gate can then prove that follow-up coverage came from model reasoning rather than local checklist seeders.

## Pi Package Usage

Try the package locally from this directory:

```bash
pi -e .
```

The extension registers `fsa_run_audit`. It defaults to `dryRun: true`, so the first call only uses local checklist seeders. It also accepts `projectContext`, `lensPacks`, `dynamicLensDiscovery`, `localChecklistSeeders`, `rounds`, `maxNewItemsPerRound`, and `maxAuditItems` parameters for project-specific audits. The extension blocks bash commands that combine public live networks with exploit/broadcast-style operations.

## Outputs

Each run writes:

- `checklist.json`: enumerated audit items.
- `project_profile.json`: deterministic project profile.
- `lens_packs.json`: configured plus model-generated audit lens packs.
- `round_<n>_deepening_items.json`: model-generated novel follow-up items for round 2 and later.
- `round_<n>_audit_results.json`: audit results for one exploration round.
- `audit_results.json`: per-item, per-trial findings.
- `summary.json`: ranked finding summary and coverage.
- `verifications.json`: independent local-only verification notes.
- `report_<id>.md`: private disclosure drafts for top findings.
- `events.jsonl` and `calls/*.json`: audit trail for coverage analysis.

## Library API

The package exports the core pipeline and extension points:

```ts
import { defaultConfig, runPipeline, MockAuditLlmClient } from "full-stack-auditor";

const cfg = defaultConfig();
cfg.targetName = "example";
cfg.sourcePaths = ["./fixtures"];

const result = await runPipeline(cfg, { llm: new MockAuditLlmClient() });
console.log(result.runDir);
```

Use `full-stack-auditor/pi/extension` for the pi package extension entrypoint.

## Extending Audit Agents

Custom audit agents can be added through `AuditorConfig.auditorAgents`. Their `failureMode` values are automatically merged into the enumeration prompt and used by the audit runner when matching checklist items:

```ts
const cfg = defaultConfig();
cfg.auditorAgents = [
  {
    failureMode: "custom_constraint_system",
    id: "custom-constraint-system-auditor",
    displayName: "Custom Constraint System Auditor",
    guidance: "Trace assigned witnesses to enforced equations in the target DSL.",
  },
];
```

The built-in agents remain the default registry, so custom agents can be added incrementally.

## White-Hat Rules

- Audit only authorized code or public bug-bounty scope.
- Verification must be local only: unit tests, regtest, devnet, or forked node.
- Never broadcast or execute against public testnet/mainnet.
- Build the smallest reproduction needed to prove the invariant break.
- Report privately and coordinate disclosure.

## Contributing and Security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
