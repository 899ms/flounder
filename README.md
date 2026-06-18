<p align="center"><img src="assets/flounder-blue.png" alt="Flounder" width="280" /></p>

<h1 align="center">Flounder</h1>

<p align="center"><em>Find vulnerabilities beneath the surface.</em></p>

<p align="center">
  <a href="docs/USAGE.md">Usage</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/SOLIDITY.md">Solidity</a> ·
  <a href="docs/STARKNET.md">Starknet</a> ·
  <a href="SECURITY.md">Security</a>
</p>

White-hat security audit framework for autonomous, model-driven source investigation. Flounder gives the model **capability and guarantees** — sandboxed read/write/edit/bash tools, a hard execution-confirmation gate, and replayable state — and lets it decide *what* might be a bug and *how* to prove it. Two complementary passes:

- **`flounder run`** — network-**sealed** discovery. A thin agentic loop with no network access, so a finding is provably *found blind*, not looked up. The model investigates the source and proves bugs with local tests.
- **`flounder confirm`** — the **open-world** counterpart. It reproduces a run's findings against real ground truth (e.g. a mainnet fork), consolidates duplicates into distinct bugs, checks novelty, and emits a submit/no-submit decision sheet — by execution, not argument.

> Found blind (`run`), then confirmed open (`confirm`).

## Quickstart

```bash
npm install && npm run build

# sealed discovery → open-world confirmation
flounder run     --target my-target --source ./src --corpus ./docs
flounder confirm ./runs/my-target-<timestamp> --source ./src

# …or track and drive audits from a local dashboard
flounder ui      # http://127.0.0.1:4500
```

For live runs, log into a pi-ai provider once (e.g. `openai-codex`); `--mock-llm` runs offline. Full commands, flags, materials, and examples are in **[docs/USAGE.md](docs/USAGE.md)**.

## How it works

- **Thin capability layer.** The framework only does what the model can't safely do itself — load authorized source, expose sandboxed tools, enforce command safety, persist a replayable transcript + memory. Strategy belongs to the agent; there are no built-in bug-class checklists.
- **A run is map → dig.** MAP enumerates and scores a complete scope inventory; the dig deep-audits each scope obligation-by-obligation. Resumable, and unbounded by default.
- **Execution is the only truth.** A finding isn't `confirmed` until a cited local test passes; a fix-equivalence + independent-refutation pass guards against vacuous PoCs. The model can't upgrade a finding by assertion.
- **Control plane + daemon.** `flounder ui` is a control plane (REST API + SQLite + job queue); audits execute on a **daemon** (optionally another machine), so the target code and provider keys never leave it.

→ Design, flow diagrams, and internals: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Dashboard

`flounder ui` is a local web app to track and drive audits across projects — live scope coverage, finding timelines, and the bugs actually **confirmed** on the real target. Every operation is a self-describing REST call (`GET /api`), so an agent can drive the whole workflow headless. Provider profiles and connected daemons live behind the gear. → [docs/USAGE.md#dashboard](docs/USAGE.md#dashboard).

## White-hat use

Flounder is for **authorized** auditing only — your own code or public bug-bounty scope. `run` is network-sealed; `confirm` may **fork and read** live networks but **never broadcasts**, moves funds, or writes to a live system — exploits replay against a *local* fork. Build the smallest proof needed, report privately, coordinate disclosure. See [SECURITY.md](SECURITY.md).

## Documentation

- **[Usage](docs/USAGE.md)** — commands, flags, materials, examples, outputs, the dashboard, the API, the library.
- **[Architecture](docs/ARCHITECTURE.md)** — the thin-layer design, agentic flow, the confirmation boundary, and the control/execution split.
- **[Solidity](docs/SOLIDITY.md)** · **[Starknet](docs/STARKNET.md)** — stack-specific guidance.
- **[Domain profiles](configs/README.md)** — opt-in `--config` presets (off by default).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). MIT licensed.
