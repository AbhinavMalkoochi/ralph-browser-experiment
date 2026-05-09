// File-system cache for LLM calls.
//
// Key: sha256(stable-json({model, messages, opts, paradigm_seed})).
// On disk: <root>/<key[:2]>/<key>.json — one file per call, JSON-serialised.
//
// Cache stores ONLY the request signature components and the response text +
// token counts. It NEVER stores headers or auth material. Cost is recomputed
// from token counts at read time so old cache entries pick up new pricing.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import type { LLMMessage, LLMOpts } from "./types.js";

export interface HashKeyInput {
  model: string;
  messages: LLMMessage[];
  opts: LLMOpts;
  paradigm_seed?: string;
}

export interface CacheEntry {
  key: string;
  model: string;
  text: string;
  tokens_in: number;
  tokens_out: number;
  /** ISO timestamp when this entry was written. */
  recorded_at: string;
}

/** Stable JSON: keys sorted alphabetically, arrays preserved in order. */
function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = stableSort(v);
    }
    return out;
  }
  return value;
}

export function hashKey(input: HashKeyInput): string {
  const blob = JSON.stringify(stableSort(input));
  return createHash("sha256").update(blob).digest("hex");
}

export class LLMCache {
  constructor(public readonly root: string) {}

  pathFor(key: string): string {
    return join(this.root, key.slice(0, 2), key + ".json");
  }

  async get(key: string): Promise<CacheEntry | null> {
    try {
      const raw = await readFile(this.pathFor(key), "utf8");
      return JSON.parse(raw) as CacheEntry;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async set(entry: CacheEntry): Promise<void> {
    const dest = this.pathFor(entry.key);
    await mkdir(dirname(dest), { recursive: true });
    // Atomic replace: write to a sibling tmp then rename. Avoids torn reads
    // if two replays race against the same key.
    const tmp = join(dirname(dest), `.${entry.key}.${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(tmp, JSON.stringify(entry, null, 2));
    await rename(tmp, dest);
  }
}

/**
 * Default cache root; agents can override. Lives under runs/.cache/llm so
 * `make clean` wipes it alongside trajectories.
 */
export function defaultCacheRoot(): string {
  return join(process.cwd(), "runs", ".cache", "llm");
}

/** For tests that want an isolated cache without touching the repo's runs/. */
export function tmpCacheRoot(): string {
  return join(tmpdir(), `gba-llm-cache-${randomBytes(4).toString("hex")}`);
}
