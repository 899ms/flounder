import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Doc } from "../types.js";
import { publicPath } from "../util/paths.js";

const SOURCE_EXTS = new Set([
  ".rs",
  ".sol",
  ".go",
  ".py",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".rb",
  ".php",
  ".ex",
  ".exs",
  ".cs",
  ".fs",
  ".scala",
  ".dart",
  ".lua",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".sh",
  ".bash",
  ".move",
  ".cairo",
  ".vy",
  ".circom",
  ".sql",
  ".proto",
  ".graphql",
  ".gql",
  ".tf",
  ".hcl",
  ".rego",
  ".json",
  ".jsonc",
  ".toml",
  ".yaml",
  ".yml",
  ".xml",
  ".gradle",
]);

const SOURCE_BASENAMES = new Set([
  "dockerfile",
  "makefile",
  "gemfile",
  "rakefile",
  "justfile",
  "procfile",
  "pipfile",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "deno.json",
  "deno.jsonc",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "poetry.lock",
  "pom.xml",
  "build.gradle",
  "settings.gradle",
  "composer.json",
  "mix.exs",
  "foundry.toml",
  "remappings.txt",
  "hardhat.config.ts",
  "hardhat.config.js",
  "hardhat.config.cjs",
  "hardhat.config.mjs",
  "slither.config.json",
  "echidna.yaml",
  "echidna.yml",
  "medusa.json",
  "wrangler.toml",
]);

const DOC_EXTS = new Set([".md", ".txt", ".rst", ".tex", ".org", ".adoc", ".html", ".htm"]);
const PDF_EXTS = new Set([".pdf"]);
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "target",
  "build",
  "dist",
  "coverage",
  "runs",
  "__pycache__",
  ".cache",
  ".npm-cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "venv",
  ".tox",
]);

export async function loadSource(paths: string[]): Promise<Doc[]> {
  return walk(paths, SOURCE_EXTS, "source");
}

export async function loadCorpus(paths: string[]): Promise<Doc[]> {
  return walk(paths, new Set([...SOURCE_EXTS, ...DOC_EXTS, ...PDF_EXTS]), "corpus");
}

export function numberLines(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line, idx) => `${String(idx + 1).padStart(5, " ")}  ${line}`)
    .join("\n");
}

export function assemble(docs: Doc[], charBudget: number, withLineNumbers = false): string {
  const chunks: string[] = [];
  let used = 0;
  for (const doc of docs) {
    const body = withLineNumbers ? numberLines(doc.content) : doc.content;
    const block = `\n===== FILE: ${doc.path} =====\n${body}\n`;
    if (used + block.length > charBudget) {
      const remaining = charBudget - used;
      if (remaining > 1000) chunks.push(`${block.slice(0, remaining)}\n...[truncated]...\n`);
      break;
    }
    chunks.push(block);
    used += block.length;
  }
  return chunks.join("");
}

async function walk(paths: string[], exts: Set<string>, kind: Doc["kind"]): Promise<Doc[]> {
  const docs: Doc[] = [];
  const cwd = process.cwd();
  for (const input of paths) {
    const full = path.resolve(input);
    await walkOne(full, exts, kind, docs, cwd);
  }
  return docs;
}

async function walkOne(fullPath: string, exts: Set<string>, kind: Doc["kind"], out: Doc[], cwd: string): Promise<void> {
  let info;
  try {
    info = await stat(fullPath);
  } catch {
    return;
  }

  if (info.isDirectory()) {
    const entries = await readdir(fullPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      await walkOne(path.join(fullPath, entry.name), exts, kind, out, cwd);
    }
    return;
  }

  if (!info.isFile()) return;

  const ext = path.extname(fullPath).toLowerCase();
  const base = path.basename(fullPath).toLowerCase();
  if (!exts.has(ext) && !SOURCE_BASENAMES.has(base)) return;

  const content = await readDoc(fullPath, ext);
  if (content.trim().length === 0) return;
  out.push({ path: publicPath(fullPath, cwd), content, kind });
}

async function readDoc(fullPath: string, ext: string): Promise<string> {
  if (PDF_EXTS.has(ext)) {
    try {
      return execFileSync("pdftotext", [fullPath, "-"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }).slice(0, 500_000);
    } catch {
      return "";
    }
  }
  return (await readFile(fullPath, "utf8")).slice(0, 500_000);
}
