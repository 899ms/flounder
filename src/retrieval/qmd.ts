import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AuditItem, Doc } from "../types.js";
import type { ContextSlice } from "../index/source-index.js";

const execFileAsync = promisify(execFile);

export interface QmdRetrievalOptions {
  command: string;
  limit: number;
  minScore: number;
  timeoutMs?: number;
  collections?: string[];
}

export interface QmdHit {
  path: string;
  score?: number;
  line?: number;
  title?: string;
  snippet?: string;
}

export interface QmdRetrievalResult {
  available: boolean;
  query: string;
  collections: string[];
  hits: QmdHit[];
  slices: ContextSlice[];
  error?: string;
}

export async function retrieveWithQmd(item: AuditItem, docs: Doc[], options: QmdRetrievalOptions): Promise<QmdRetrievalResult> {
  const query = qmdQueryForItem(item);
  const collections = cleanCollections(options.collections);
  try {
    const { stdout } = await execFileAsync(
      options.command,
      qmdArgsForQuery(query, { ...options, collections }),
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 5 * 1024 * 1024,
      },
    );
    const hits = parseQmdHits(stdout)
      .filter((hit) => hit.score === undefined || hit.score >= options.minScore)
      .slice(0, options.limit);
    return {
      available: true,
      query,
      collections,
      hits,
      slices: qmdHitsToSlices(hits, docs, query),
    };
  } catch (error) {
    return {
      available: false,
      query,
      collections,
      hits: [],
      slices: [],
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    };
  }
}

export function qmdArgsForQuery(query: string, options: Pick<QmdRetrievalOptions, "limit" | "minScore" | "collections">): string[] {
  const args = ["query", query, "--format", "json", "-n", String(options.limit), "--min-score", String(options.minScore)];
  for (const collection of cleanCollections(options.collections)) {
    args.push("-c", collection);
  }
  return args;
}

export function parseQmdHits(stdout: string): QmdHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = parseEmbeddedJson(stdout);
    if (parsed === undefined) return [];
  }
  const rows = firstArray(parsed);
  return rows.flatMap((row) => normalizeHit(row)).filter((hit): hit is QmdHit => hit !== undefined);
}

function parseEmbeddedJson(stdout: string): unknown | undefined {
  for (const [start, end] of [
    [stdout.indexOf("["), stdout.lastIndexOf("]")],
    [stdout.indexOf("{"), stdout.lastIndexOf("}")],
  ] as const) {
    if (start === -1 || end === -1 || end <= start) continue;
    try {
      return JSON.parse(stdout.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  return undefined;
}

function qmdHitsToSlices(hits: QmdHit[], docs: Doc[], query: string): ContextSlice[] {
  const out: ContextSlice[] = [];
  for (const hit of hits) {
    const doc = findDocForHit(docs, hit.path);
    if (!doc) continue;
    const line = hit.line ?? bestLineForDoc(doc, query, hit.snippet);
    out.push({
      doc,
      startLine: Math.max(1, line - 40),
      endLine: line + 80,
      reason: `qmd semantic match${hit.score === undefined ? "" : ` score=${hit.score.toFixed(3)}`}`,
    });
  }
  return out;
}

function qmdQueryForItem(item: AuditItem): string {
  return [
    item.id,
    item.failureMode,
    item.location,
    item.securityProperty,
    item.why,
    ...(item.attackerControlledInputs ?? []),
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function normalizeHit(row: unknown): QmdHit | undefined {
  if (!row || typeof row !== "object") return undefined;
  const obj = row as Record<string, unknown>;
  const doc = (typeof obj.document === "object" && obj.document ? (obj.document as Record<string, unknown>) : undefined) ?? {};
  const path = firstString(obj, ["path", "displayPath", "display_path", "file", "filepath", "filename", "docPath", "doc_path"]) ??
    firstString(doc, ["path", "displayPath", "display_path", "file", "filepath", "filename"]);
  if (!path) return undefined;
  const score = firstNumber(obj, ["score", "rrfScore", "rrf_score", "rerankScore", "rerank_score"]);
  const line = firstNumber(obj, ["line", "lineNumber", "line_number", "fromLine", "from_line", "startLine", "start_line"]);
  const title = firstString(obj, ["title", "heading", "name"]);
  const snippet = firstString(obj, ["snippet", "text", "content", "summary"]);
  return {
    path,
    ...(score !== undefined ? { score } : {}),
    ...(line !== undefined ? { line: Math.max(1, Math.floor(line)) } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
  };
}

function firstArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  for (const key of ["results", "hits", "documents", "docs", "items"]) {
    const candidate = obj[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function findDocForHit(docs: Doc[], hitPath: string): Doc | undefined {
  const lowered = hitPath.toLowerCase();
  const basename = lowered.split(/[\\/]/).at(-1) ?? lowered;
  return (
    docs.find((doc) => doc.path.toLowerCase() === lowered) ??
    docs.find((doc) => lowered.endsWith(doc.path.toLowerCase())) ??
    docs.find((doc) => doc.path.toLowerCase().endsWith(lowered)) ??
    docs.find((doc) => doc.path.toLowerCase().endsWith(basename))
  );
}

function cleanCollections(collections: string[] | undefined): string[] {
  return [...new Set((collections ?? []).map((collection) => collection.trim()).filter(Boolean))];
}

function bestLineForDoc(doc: Doc, query: string, snippet?: string): number {
  const terms = [...new Set(`${query} ${snippet ?? ""}`.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length >= 5))].slice(0, 24);
  const lines = doc.content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]?.toLowerCase() ?? "";
    if (terms.some((term) => line.includes(term))) return idx + 1;
  }
  return 1;
}
