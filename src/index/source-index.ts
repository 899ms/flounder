import type { AuditItem, Doc } from "../types.js";
import { numberLines } from "../ingest/source.js";
import { retrievalTermsForItem, shouldIncludeStructuralContext } from "./retrieval-terms.js";
import { parseLocationRanges } from "../util/location.js";

export interface ContextSlice {
  doc: Doc;
  startLine: number;
  endLine: number;
  reason: string;
}

export interface ContextTrace {
  context: string;
  slices: Array<{
    path: string;
    startLine: number;
    endLine: number;
    reason: string;
    chars: number;
    included: boolean;
  }>;
  budget: number;
  usedChars: number;
  truncated: boolean;
}

export interface SymbolRef {
  name: string;
  kind: "function" | "struct" | "class" | "contract" | "impl" | "module";
  path: string;
  line: number;
}

export class SourceIndex {
  readonly docs: Doc[];
  readonly symbols: SymbolRef[];

  constructor(docs: Doc[]) {
    this.docs = docs;
    this.symbols = docs.flatMap((doc) => extractSymbols(doc));
  }

  contextForItem(item: AuditItem, budget: number): string {
    return this.contextForItemWithTrace(item, budget).context;
  }

  contextForItemWithTrace(item: AuditItem, budget: number, extraSlices: ContextSlice[] = []): ContextTrace {
    const slices = [...this.slicesForItem(item), ...extraSlices];
    const trace = renderContextSlices(slices, budget);
    if (trace.context.length > 0) return trace;
    const fallback = fallbackContext(this.docs, budget);
    return {
      context: fallback,
      slices: [],
      budget,
      usedChars: fallback.length,
      truncated: fallback.length >= budget,
    };
  }

  slicesForItem(item: AuditItem): ContextSlice[] {
    const out: ContextSlice[] = [];
    const terms = retrievalTermsForItem(item);
    const directDocs: Doc[] = [];
    const directSlices: ContextSlice[] = [];
    for (const direct of parseLocationRanges(item.location)) {
      const doc = this.findDoc(direct.pathHint);
      if (doc) {
        directDocs.push(doc);
        const semanticSlice = semanticSliceForDirectRange(doc, direct.startLine, direct.endLine);
        if (semanticSlice) {
          out.push(semanticSlice);
          directSlices.push(semanticSlice);
        }
        const slice = {
          doc,
          startLine: Math.max(1, direct.startLine - 40),
          endLine: direct.endLine + 40,
          reason: "direct location",
        };
        directSlices.push(slice);
        out.push(slice);
      }
    }
    const symbolLocationSlices = this.slicesForSymbolLocations(item.location);
    out.push(...symbolLocationSlices);
    directSlices.push(...symbolLocationSlices);
    for (const slice of symbolLocationSlices) {
      if (!directDocs.includes(slice.doc)) directDocs.push(slice.doc);
    }

    const referenceTerms = referenceTermsForSlices(directSlices);
    const expandedTerms = [...new Set([...referenceTerms, ...terms])].slice(0, 64);

    for (const symbol of this.symbols) {
      if (!referenceTerms.includes(symbol.name.toLowerCase())) continue;
      const doc = this.findDoc(symbol.path);
      if (!doc) continue;
      out.push({
        doc,
        startLine: Math.max(1, symbol.line - 30),
        endLine: symbol.line + 80,
        reason: `referenced ${symbol.kind} ${symbol.name}`,
      });
    }

    const symbolNames = new Set(this.symbols.map((symbol) => symbol.name.toLowerCase()));
    out.push(...callSiteSlicesForTerms(this.docs, referenceTerms.filter((term) => symbolNames.has(term)).slice(0, 12), directSlices));

    if (shouldIncludeStructuralContext(item, expandedTerms)) {
      for (const doc of directDocs) {
        for (const symbol of this.symbols.filter((candidate) => candidate.path === doc.path && isConstraintSupportSymbol(candidate.name))) {
          out.push({
            doc,
            startLine: Math.max(1, symbol.line - 20),
            endLine: symbol.line + 140,
            reason: `constraint context ${symbol.name}`,
          });
        }
      }
    }

    for (const doc of this.docs) {
      const lineHits = searchLines(doc, expandedTerms).slice(0, 6);
      for (const hit of lineHits) {
        out.push({
          doc,
          startLine: Math.max(1, hit - 35),
          endLine: hit + 35,
          reason: "term match",
        });
      }
    }

    for (const symbol of this.symbols) {
      if (!expandedTerms.some((term) => symbol.name.toLowerCase().includes(term))) continue;
      const doc = this.findDoc(symbol.path);
      if (!doc) continue;
      out.push({
        doc,
        startLine: Math.max(1, symbol.line - 40),
        endLine: symbol.line + 80,
        reason: `${symbol.kind} ${symbol.name}`,
      });
    }

    return out;
  }

  slicesForSymbolLocations(location: string): ContextSlice[] {
    const out: ContextSlice[] = [];
    const seen = new Set<string>();
    for (const segment of location.split(/\s*;\s*/)) {
      const match = /^([^:]+?\.[A-Za-z0-9]+)\s*:\s*(.+)$/.exec(segment.trim());
      if (!match) continue;
      const pathHint = match[1]?.trim();
      const rawNames = match[2] ?? "";
      if (!pathHint || /^\d/.test(rawNames.trim())) continue;
      const doc = this.findDoc(pathHint);
      if (!doc) continue;
      for (const name of symbolNamesFromLocationHint(rawNames)) {
        const symbol = this.symbols.find(
          (candidate) => candidate.path === doc.path && candidate.name.toLowerCase() === name.toLowerCase(),
        );
        if (!symbol) continue;
        const range = solidityBlockRange(doc, symbol.line) ?? {
          startLine: Math.max(1, symbol.line - 20),
          endLine: symbol.line + 120,
        };
        const key = `${doc.path}:${range.startLine}:${range.endLine}:${symbol.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          doc,
          startLine: Math.max(1, range.startLine - 5),
          endLine: range.endLine + 5,
          reason: `location symbol ${symbol.name}`,
        });
      }
    }
    return out;
  }

  findDoc(pathHint: string): Doc | undefined {
    const lowered = pathHint.toLowerCase();
    return (
      this.docs.find((doc) => doc.path.toLowerCase() === lowered) ??
      this.docs.find((doc) => lowered.includes(doc.path.toLowerCase())) ??
      this.docs.find((doc) => doc.path.toLowerCase().includes(lowered)) ??
      this.docs.find((doc) => doc.path.toLowerCase().endsWith(lowered.split("/").at(-1) ?? lowered))
    );
  }
}

export function renderContextSlices(slices: ContextSlice[], budget: number): ContextTrace {
    const seen = new Set<string>();
    const chunks: string[] = [];
    const trace: ContextTrace["slices"] = [];
    let used = 0;
    let truncated = false;

    for (const slice of slices) {
      const key = `${slice.doc.path}:${slice.startLine}:${slice.endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const body = lineSlice(slice.doc, slice.startLine, slice.endLine);
      const block = `\n===== FILE: ${slice.doc.path} lines ${slice.startLine}-${slice.endLine} (${slice.reason}) =====\n${body}\n`;
      if (used + block.length > budget) {
        const remaining = budget - used;
        truncated = true;
        if (remaining > 1000) {
          chunks.push(`${block.slice(0, remaining)}\n...[truncated]...\n`);
          used += remaining;
          trace.push({
            path: slice.doc.path,
            startLine: slice.startLine,
            endLine: slice.endLine,
            reason: slice.reason,
            chars: remaining,
            included: true,
          });
        } else {
          trace.push({
            path: slice.doc.path,
            startLine: slice.startLine,
            endLine: slice.endLine,
            reason: slice.reason,
            chars: block.length,
            included: false,
          });
        }
        break;
      }
      chunks.push(block);
      used += block.length;
      trace.push({
        path: slice.doc.path,
        startLine: slice.startLine,
        endLine: slice.endLine,
        reason: slice.reason,
        chars: block.length,
        included: true,
      });
    }

    if (chunks.length > 0) {
      return {
        context: chunks.join(""),
        slices: trace,
        budget,
        usedChars: used,
        truncated,
      };
    }
    return {
      context: chunks.join(""),
      slices: trace,
      budget,
      usedChars: used,
      truncated,
    };
}

function fallbackContext(docs: Doc[], budget: number): string {
  const chunks: string[] = [];
  let used = 0;
  for (const doc of docs) {
    const block = `\n===== FILE: ${doc.path} =====\n${numberLines(doc.content)}\n`;
    if (used + block.length > budget) {
      const remaining = budget - used;
      if (remaining > 1000) chunks.push(`${block.slice(0, remaining)}\n...[truncated]...\n`);
      break;
    }
    chunks.push(block);
    used += block.length;
  }
  return chunks.join("");
}

function isConstraintSupportSymbol(name: string): boolean {
  return /configure|create_gate|gate|constraint|synthesi[sz]e|assign|layout/i.test(name);
}

function semanticSliceForDirectRange(doc: Doc, startLine: number, endLine: number): ContextSlice | undefined {
  if (!doc.path.toLowerCase().endsWith(".sol")) return undefined;
  const symbols = extractSymbols(doc)
    .filter((symbol) => symbol.kind === "function" || symbol.kind === "contract")
    .sort((a, b) => b.line - a.line);
  for (const symbol of symbols) {
    if (symbol.line > startLine) continue;
    const range = solidityBlockRange(doc, symbol.line);
    if (!range || range.endLine < startLine) continue;
    return {
      doc,
      startLine: Math.max(1, range.startLine - 5),
      endLine: Math.max(range.endLine + 5, endLine + 5),
      reason: `${symbol.kind} block ${symbol.name}`,
    };
  }
  return undefined;
}

function symbolNamesFromLocationHint(input: string): string[] {
  const ignored = new Set([
    "and",
    "component",
    "contract",
    "external",
    "function",
    "functions",
    "internal",
    "line",
    "lines",
    "sol",
  ]);
  return [
    ...new Set(
      input
        .replace(/\([^)]*\)/g, " ")
        .split(/[^A-Za-z0-9_]+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2 && !ignored.has(term.toLowerCase()) && !/^\d+$/.test(term)),
    ),
  ].slice(0, 24);
}

function solidityBlockRange(doc: Doc, startLine: number): { startLine: number; endLine: number } | undefined {
  const lines = doc.content.split(/\r?\n/);
  const startIdx = Math.max(0, startLine - 1);
  let firstBraceIdx = -1;
  for (let idx = startIdx; idx < lines.length; idx += 1) {
    const line = stripSolidityLineComment(lines[idx] ?? "");
    if (line.includes("{")) {
      firstBraceIdx = idx;
      break;
    }
    if (line.includes(";")) return { startLine, endLine: idx + 1 };
    if (idx - startIdx > 80) break;
  }
  if (firstBraceIdx === -1) return undefined;

  let depth = 0;
  let seenBrace = false;
  for (let idx = firstBraceIdx; idx < lines.length; idx += 1) {
    const line = stripSolidityLineComment(lines[idx] ?? "");
    for (const char of line) {
      if (char === "{") {
        depth += 1;
        seenBrace = true;
      } else if (char === "}") {
        depth -= 1;
        if (seenBrace && depth === 0) return { startLine, endLine: idx + 1 };
      }
    }
  }
  return undefined;
}

function stripSolidityLineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

function referenceTermsForSlices(slices: ContextSlice[]): string[] {
  const ignored = new Set([
    "clone",
    "config",
    "configure",
    "create_gate",
    "assign",
    "assign_region",
    "expect",
    "from",
    "into",
    "map",
    "namespace",
    "ok",
    "unwrap",
    "zip",
    "assign_advice",
    "copy_advice",
    "query_advice",
    "query_selector",
  ]);
  const out: string[] = [];
  for (const slice of slices) {
    const text = rawSlice(slice.doc, slice.startLine, slice.endLine);
    for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{3,})\s*\(/g)) {
      const term = match[1]?.toLowerCase();
      if (!term || ignored.has(term)) continue;
      out.push(term);
    }
  }
  return [...new Set(out)].slice(0, 64);
}

function searchLines(doc: Doc, terms: string[]): number[] {
  if (terms.length === 0) return [];
  const hits: number[] = [];
  const lines = doc.content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const lowered = (lines[idx] ?? "").toLowerCase();
    if (terms.some((term) => lowered.includes(term))) hits.push(idx + 1);
  }
  return hits;
}

function callSiteSlicesForTerms(docs: Doc[], terms: string[], directSlices: ContextSlice[]): ContextSlice[] {
  const directRanges = directSlices.map((slice) => ({
    path: slice.doc.path,
    startLine: slice.startLine,
    endLine: slice.endLine,
  }));
  const out: ContextSlice[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const callPattern = new RegExp(`\\b${escapeRegExp(term)}\\s*[(<]`);
    for (const doc of docs) {
      const lines = doc.content.split(/\r?\n/);
      for (let idx = 0; idx < lines.length; idx += 1) {
        const lineNumber = idx + 1;
        if (isInsideDirectRange(doc.path, lineNumber, directRanges)) continue;
        if (!callPattern.test(lines[idx] ?? "")) continue;
        const key = `${doc.path}:${term}:${lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          doc,
          startLine: Math.max(1, lineNumber - 35),
          endLine: lineNumber + 45,
          reason: `call site ${term}`,
        });
        if (out.length >= 24) return out;
        break;
      }
    }
  }
  return out;
}

function isInsideDirectRange(path: string, line: number, ranges: Array<{ path: string; startLine: number; endLine: number }>): boolean {
  return ranges.some((range) => range.path === path && line >= range.startLine && line <= range.endLine);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rawSlice(doc: Doc, startLine: number, endLine: number): string {
  const lines = doc.content.split(/\r?\n/);
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, Math.max(start, endLine));
  return lines.slice(start - 1, end).join("\n");
}

function lineSlice(doc: Doc, startLine: number, endLine: number): string {
  const lines = doc.content.split(/\r?\n/);
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, Math.max(start, endLine));
  return lines
    .slice(start - 1, end)
    .map((line, idx) => `${String(start + idx).padStart(5, " ")}  ${line}`)
    .join("\n");
}

function extractSymbols(doc: Doc): SymbolRef[] {
  const symbols: SymbolRef[] = [];
  const lines = doc.content.split(/\r?\n/);
  const ext = doc.path.split(".").at(-1) ?? "";
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const ref = symbolFromLine(line, ext);
    if (ref) symbols.push({ ...ref, path: doc.path, line: idx + 1 });
  }
  return symbols;
}

function symbolFromLine(line: string, ext: string): Omit<SymbolRef, "path" | "line"> | undefined {
  const patterns: Array<[RegExp, SymbolRef["kind"]]> = [
    [/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/, "function"],
    [/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, "function"],
    [/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, "function"],
    [/\b(struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/, "struct"],
    [/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/, "class"],
    [/\bcontract\s+([A-Za-z_][A-Za-z0-9_]*)\b/, "contract"],
    [/^\s*impl(?:<[^>]+>)?\s+([A-Za-z_][A-Za-z0-9_]*)\b/, "impl"],
    [/\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\b/, "module"],
  ];
  for (const [pattern, kind] of patterns) {
    const match = pattern.exec(line);
    if (!match) continue;
    const name = kind === "struct" ? match[2] : match[1];
    if (!name) continue;
    if (ext === "rs" && kind === "contract") continue;
    return { name, kind };
  }
  return undefined;
}
