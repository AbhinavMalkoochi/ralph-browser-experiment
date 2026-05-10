// Auto-discover agents under agents/<id>/.
//
// Each subdirectory must contain a manifest.yaml and either agent.ts (TS) or
// agent.py (Python). Invalid manifests are skipped with a warning so that one
// broken agent does not abort the whole tournament. Distinctness validation
// is deferred to US-012.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { parseYaml, type YamlValue } from "../verifier/yaml.js";
import type { AgentLanguage, AgentManifest, DiscoveredAgent } from "./types.js";

export interface DiscoverOptions {
  /** Repo root; defaults to process.cwd(). */
  repoRoot?: string;
  /** Overrides the directory scanned for agent subdirs (defaults to agents/). */
  agentsDir?: string;
  /** Optional list of allowed agent ids; others are filtered out post-scan. */
  filterIds?: string[];
  /**
   * Sink for warnings when an agent dir cannot be loaded. Defaults to
   * stderr. Tests pass a buffer.
   */
  onWarn?: (msg: string) => void;
}

export async function discoverAgents(opts: DiscoverOptions = {}): Promise<DiscoveredAgent[]> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const agentsDir = opts.agentsDir ?? join(repoRoot, "agents");
  const onWarn = opts.onWarn ?? ((m) => process.stderr.write(`[tournament] ${m}\n`));
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`agents directory not readable at ${agentsDir}: ${msg}`);
  }
  const out: DiscoveredAgent[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || entry === "CLAUDE.md") continue;
    const dir = join(agentsDir, entry);
    const isDir = await safeIsDir(dir);
    if (!isDir) continue;
    try {
      const agent = await loadAgentDir(dir);
      if (!agent) continue;
      if (opts.filterIds && !opts.filterIds.includes(agent.id)) continue;
      out.push(agent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onWarn(`skipping agents/${entry}: ${msg}`);
    }
  }
  return out;
}

async function loadAgentDir(dir: string): Promise<DiscoveredAgent | null> {
  const manifestPath = join(dir, "manifest.yaml");
  const manifestExists = await safeIsFile(manifestPath);
  if (!manifestExists) return null;
  const raw = await readFile(manifestPath, "utf8");
  let parsed: YamlValue;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`manifest.yaml: ${msg}`);
  }
  const manifest = validateManifest(parsed);

  const tsPath = join(dir, "agent.ts");
  const pyPath = join(dir, "agent.py");
  const hasTs = await safeIsFile(tsPath);
  const hasPy = await safeIsFile(pyPath);

  if (manifest.language === "typescript") {
    if (!hasTs) throw new Error(`language=typescript but agent.ts missing`);
    return { id: manifest.id, language: manifest.language, dir, agentFile: tsPath, manifest };
  }
  if (manifest.language === "python") {
    if (!hasPy) throw new Error(`language=python but agent.py missing`);
    return { id: manifest.id, language: manifest.language, dir, agentFile: pyPath, manifest };
  }
  throw new Error(`unsupported language ${JSON.stringify(manifest.language)}`);
}

export function validateManifest(value: unknown): AgentManifest {
  if (!isPlainObject(value)) {
    throw new Error(`manifest.yaml: top-level must be a mapping`);
  }
  const id = requireString(value, "id");
  const languageRaw = requireString(value, "language");
  if (languageRaw !== "typescript" && languageRaw !== "python") {
    throw new Error(`manifest.yaml: language must be typescript|python; got ${JSON.stringify(languageRaw)}`);
  }
  const language = languageRaw as AgentLanguage;
  const summary = requireString(value, "summary");
  const approach_keywords = optionalStringArray(value, "approach_keywords") ?? [];
  const distinct_from = optionalStringArray(value, "distinct_from") ?? [];
  return { id, language, summary, approach_keywords, distinct_from, raw: value };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`manifest.yaml: missing or empty "${key}"`);
  }
  return v.trim();
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) {
    throw new Error(`manifest.yaml: "${key}" must be a list`);
  }
  for (const item of v) {
    if (typeof item !== "string") {
      throw new Error(`manifest.yaml: every "${key}" entry must be a string`);
    }
  }
  return v as string[];
}

async function safeIsFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function safeIsDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
