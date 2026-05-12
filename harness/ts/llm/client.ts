// Unified LLM shim used by every agent.
//
// Responsibilities:
//   1. Multi-provider routing (OpenAI, Gemini) by model name prefix.
//   2. Per-call cost accounting (token counts × pricing → USD).
//   3. Record-or-replay deterministic cache (file-system, sha256 keyed).
//   4. Per-task budget enforcement: budget.check() before AND after each call.
//   5. Trajectory recording: every call appends an llm_call line.
//   6. Secret redaction: API keys never leave the provider boundary in
//      errors, trajectories, or cache files.
//
// The client is constructed once per agent run and shared across all calls
// inside that run.

import type { Trajectory } from "../agent/trajectory.js";
import { Budget } from "../agent/types.js";

import { LLMCache, hashKey, defaultCacheRoot } from "./cache.js";
import type { CacheEntry } from "./cache.js";
import { costUsd } from "./pricing.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OpenAiProvider } from "./providers/openai.js";
import type {
  LLMMessage,
  LLMOpts,
  LLMProvider,
  LLMResult,
} from "./types.js";
import { LLMProviderUnavailableError, LLMReplayMissError } from "./types.js";

export type LLMMode = "record" | "replay";

export interface LLMClientOpts {
  /** Cache root; defaults to runs/.cache/llm. */
  cacheRoot?: string;
  /** "record" (default): cache miss → call provider, persist. "replay": cache miss → throw. */
  mode?: LLMMode;
  /** Salt added to the cache key for every call this client makes. */
  paradigmSeed?: string;
  /** When set, every call is checked against this budget and recorded into it. */
  budget?: Budget;
  /** When set, every call appends an llm_call line into this trajectory. */
  trajectory?: Trajectory;
  /** Provider plumbing. Defaults to no providers (replay-only client). */
  providers?: { openai?: LLMProvider; gemini?: LLMProvider };
  /** Strings (typically API keys) to scrub from any error message that escapes the client. */
  redactValues?: string[];
}

export class LLMClient {
  private readonly cache: LLMCache;
  private readonly mode: LLMMode;
  private readonly paradigmSeed?: string;
  private readonly budget?: Budget;
  private readonly trajectory?: Trajectory;
  private readonly providers: { openai?: LLMProvider; gemini?: LLMProvider };
  private readonly redactValues: string[];

  constructor(opts: LLMClientOpts = {}) {
    this.cache = new LLMCache(opts.cacheRoot ?? defaultCacheRoot());
    this.mode = opts.mode ?? "record";
    this.paradigmSeed = opts.paradigmSeed;
    this.budget = opts.budget;
    this.trajectory = opts.trajectory;
    this.providers = opts.providers ?? {};
    this.redactValues = (opts.redactValues ?? []).filter((v) => v.length > 0);
  }

  async call(model: string, messages: LLMMessage[], opts: LLMOpts = {}): Promise<LLMResult> {
    // Budget gate BEFORE anything: if we're already over, refuse outright so
    // the agent gets a clean BUDGET_EXCEEDED without spending tokens.
    this.budget?.check();

    const seed = opts.paradigm_seed ?? this.paradigmSeed;
    const keyInput = { model, messages, opts: stripCacheKeyOpts(opts), paradigm_seed: seed };
    const key = hashKey(keyInput);

    const cached = await this.cache.get(key);
    if (cached) {
      const cost = costUsd(model, cached.tokens_in, cached.tokens_out);
      // Replays are free in $ terms — we don't double-charge the budget for a
      // re-run of the same prompt. We DO record the token count so any
      // downstream "tokens consumed" stat is accurate.
      this.budget?.recordTokens(cached.tokens_in, cached.tokens_out, 0);
      // After-call check is still meaningful (the recorded tokens may now
      // tip the tokens-axis over the limit even though usd didn't move).
      this.budget?.check();
      const result: LLMResult = {
        text: cached.text,
        model,
        tokens_in: cached.tokens_in,
        tokens_out: cached.tokens_out,
        cost_usd: cost,
        latency_ms: 0,
        prompt_hash: key,
        cached: true,
      };
      await this.recordTrajectory(result);
      return result;
    }

    if (this.mode === "replay") {
      throw new LLMReplayMissError(model, key);
    }

    const provider = this.pickProvider(model);
    const t0 = Date.now();
    let resp: { text: string; tokens_in: number; tokens_out: number };
    try {
      resp = await provider.call({ model, messages, opts });
    } catch (err) {
      throw this.redactError(err);
    }
    const latency_ms = Date.now() - t0;
    const cost = costUsd(model, resp.tokens_in, resp.tokens_out);

    const entry: CacheEntry = {
      key,
      model,
      text: resp.text,
      tokens_in: resp.tokens_in,
      tokens_out: resp.tokens_out,
      recorded_at: new Date().toISOString(),
    };
    await this.cache.set(entry);

    this.budget?.recordTokens(resp.tokens_in, resp.tokens_out, cost);
    // Throw AFTER persisting the result: the call already happened, and we
    // want the cache to reflect that, but the agent should see BudgetExceeded
    // on the very next budget.check() (or here on this.budget.check()).
    this.budget?.check();

    const result: LLMResult = {
      text: resp.text,
      model,
      tokens_in: resp.tokens_in,
      tokens_out: resp.tokens_out,
      cost_usd: cost,
      latency_ms,
      prompt_hash: key,
      cached: false,
    };
    await this.recordTrajectory(result);
    return result;
  }

  private pickProvider(model: string): LLMProvider {
    if (model.startsWith("gpt-") || model.startsWith("o4-") || model.startsWith("o3-")) {
      if (this.providers.openai) return this.providers.openai;
      throw new LLMProviderUnavailableError(model);
    }
    if (model.startsWith("gemini-")) {
      if (this.providers.gemini) return this.providers.gemini;
      throw new LLMProviderUnavailableError(model);
    }
    if (model.startsWith("mock-")) {
      // Tests inject a mock under one of the named slots; check both.
      if (this.providers.openai) return this.providers.openai;
      if (this.providers.gemini) return this.providers.gemini;
      throw new LLMProviderUnavailableError(model);
    }
    throw new LLMProviderUnavailableError(model);
  }

  private async recordTrajectory(r: LLMResult): Promise<void> {
    if (!this.trajectory) return;
    await this.trajectory.recordLlmCall({
      model: r.model,
      prompt_hash: r.prompt_hash,
      prompt_tokens: r.tokens_in,
      completion_tokens: r.tokens_out,
      latency_ms: r.latency_ms,
      cost_usd: r.cost_usd,
      cached: r.cached,
    });
  }

  private redactError(err: unknown): Error {
    const original = err instanceof Error ? err : new Error(String(err));
    if (this.redactValues.length === 0) return original;
    let msg = original.message;
    for (const secret of this.redactValues) {
      while (msg.includes(secret)) msg = msg.replace(secret, "[REDACTED]");
    }
    if (msg === original.message) return original;
    const e = new Error(msg);
    e.name = original.name;
    return e;
  }
}

/**
 * Cache key is invariant to `paradigm_seed` here — that's pulled out and
 * placed on the top-level key blob in `call()` so it's still part of the
 * digest. Other opts go through verbatim.
 */
function stripCacheKeyOpts(opts: LLMOpts): Omit<LLMOpts, "paradigm_seed"> {
  const { paradigm_seed: _drop, ...rest } = opts;
  return rest;
}

export interface DefaultClientOpts extends Omit<LLMClientOpts, "providers" | "redactValues"> {
  /** Override env lookup; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build a client wired to whatever providers have keys in the environment.
 * If neither key is set, the client is replay-only (still useful for tests
 * that pre-populate the cache).
 */
/**
 * Hard-auth slice (US-028): well-known third-party auth env vars. If any
 * of these are set in the environment, their VALUES are added to the
 * LLMClient's redaction list so a leaked token never reaches a committed
 * trajectory or error message. Keep this in sync with KNOWN_AUTH_ENV_VARS
 * in harness/ts/auth/inject.ts and the .env.example documentation.
 */
export const HARD_AUTH_ENV_VARS: readonly string[] = [
  "GITHUB_PAT",
  "GITHUB_SANDBOX_REPO",
  "HF_TOKEN",
  "HF_TEST_REPO",
  "NPM_AUTH_TOKEN",
  "NPM_SANDBOX_PACKAGE",
];

export function defaultClient(opts: DefaultClientOpts = {}): LLMClient {
  const env = opts.env ?? process.env;
  const providers: NonNullable<LLMClientOpts["providers"]> = {};
  const redactValues: string[] = [];
  if (env.OPENAI_API_KEY) {
    providers.openai = new OpenAiProvider({ apiKey: env.OPENAI_API_KEY });
    redactValues.push(env.OPENAI_API_KEY);
  }
  if (env.GEMINI_API_KEY) {
    providers.gemini = new GeminiProvider({ apiKey: env.GEMINI_API_KEY });
    redactValues.push(env.GEMINI_API_KEY);
  }
  for (const name of HARD_AUTH_ENV_VARS) {
    const v = env[name];
    // Only redact substantive secret values (length>=8) — repo slugs and
    // owner names ("octocat/hello") are not secret and would over-redact
    // legitimate prose.
    if (v && v.length >= 8 && !redactValues.includes(v)) {
      redactValues.push(v);
    }
  }
  return new LLMClient({ ...opts, providers, redactValues });
}
