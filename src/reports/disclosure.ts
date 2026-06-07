import type { RankedFinding, Reproduction, Verification } from "../types.js";

export function reportArtifactName(findingId: string): string {
  return `report_${safeReportId(findingId)}.md`;
}

export function renderDisclosure(target: string, finding: RankedFinding, verification?: Verification, reproduction?: Reproduction): string {
  return `# Security disclosure: ${finding.title}

Private report for maintainers. Please coordinate disclosure.

- Project: ${target}
- Severity estimate: ${finding.severity.toUpperCase()}
- Component / location: ${finding.location}
- Class: ${finding.failureMode}
- Confirmation status: ${finding.confirmationStatus}
- Source verifier verdict: ${verification?.verdict ?? "not-run"}
- Verification mode: ${verification?.mode ?? "not-run"}
- Impact signals: ${finding.impactSignals?.join(", ") || "not-scored"}
- Reproduction status: ${reproduction?.status ?? "not-run"}

## Summary

${finding.description}

## Affected Invariant

${finding.evidence}

## Impact

${finding.exploitSketch}

## Suggested Fix

${finding.fix}

## Reproduction

Verification is intended for a local, isolated environment only: unit tests, regtest, devnet, or forked node. It must not be run against a live public network.

${verification?.markdown ?? "_Verification notes not generated._"}

${reproduction?.markdown ?? "_Executable reproduction not generated. Run the optional ReproductionAgent stage in plan or execute mode when local PoC evidence is needed._"}

## Disclosure Preferences

- Please confirm a security contact or encrypted channel.
- Happy to coordinate on an embargo and remediation timeline.
`;
}

function safeReportId(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return cleaned || "finding";
}
