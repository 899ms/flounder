import type { AuditItem } from "./types.js";

export interface RawAuditItem {
  id?: string;
  location?: string;
  securityProperty?: string;
  security_property?: string;
  failureMode?: string;
  failure_mode?: string;
  why?: string;
  specRefs?: string[];
  spec_refs?: string[];
  attackerControlledInputs?: string[];
  attacker_controlled_inputs?: string[];
}

export function normalizeAuditItem(raw: RawAuditItem, round?: number): AuditItem | undefined {
  const location = raw.location?.trim();
  const securityProperty = (raw.securityProperty ?? raw.security_property)?.trim();
  const failureMode = (raw.failureMode ?? raw.failure_mode)?.trim();
  if (!location || !securityProperty || !failureMode) return undefined;
  const item: AuditItem = {
    id: raw.id?.trim() || slug(`${failureMode}-${location}`),
    location,
    securityProperty,
    failureMode: failureMode as AuditItem["failureMode"],
    why: raw.why?.trim() || "Enumerated by model.",
  };
  const specRefs = raw.specRefs ?? raw.spec_refs;
  const attackerControlledInputs = raw.attackerControlledInputs ?? raw.attacker_controlled_inputs;
  if (specRefs) item.specRefs = specRefs;
  if (attackerControlledInputs) item.attackerControlledInputs = attackerControlledInputs;
  if (round !== undefined) item.round = round;
  return item;
}

export function dedupeAuditItems(items: AuditItem[]): AuditItem[] {
  const seen = new Set<string>();
  const out: AuditItem[] = [];
  for (const item of items) {
    const key = auditItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.map((item, idx) => ({ ...item, id: item.id || `item-${idx}` }));
}

export function auditItemKey(item: Pick<AuditItem, "location" | "failureMode" | "securityProperty">): string {
  return [item.location, item.failureMode, item.securityProperty].map(canonicalText).join("|");
}

function canonicalText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}
