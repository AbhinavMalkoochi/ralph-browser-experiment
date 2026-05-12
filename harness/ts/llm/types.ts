// LLM contract shared by every agent. The harness owns the LLMClient; agents
// receive one constructed for their (task, budget, trajectory) and call
// `client.call(model, messages, opts)`.
//
// US-004 covers OpenAI + Gemini. Anthropic is left to a later iteration if
// any agent opts in (.env.example already documents ANTHROPIC_API_KEY).

export type LLMRole = "system" | "user" | "assistant" | "tool";

/**
 * One element of a multimodal user message. Mirrors the OpenAI Chat
 * Completions content-part shape so vision-capable models can be addressed
 * without a wrapper protocol. Providers that only handle text (Gemini) MUST
 * reject array content.
 */
export type LLMContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "low" | "high" | "auto" };
    };

export interface LLMMessage {
  role: LLMRole;
  /**
   * Either a plain string (the common case) or an array of content parts for
   * multimodal calls. Array content currently only round-trips through the
   * OpenAI provider — Gemini throws on it. Cache key is computed from the
   * full structure either way.
   */
  content: string | LLMContentPart[];
}

export interface LLMOpts {
  temperature?: number;
  max_tokens?: number;
  /**
   * Free-form salt that becomes part of the cache key. Agents that share the
   * same model + messages but differ in a paradigm-level decision (e.g. a
   * code-gen agent using a self-improving prompt) should pass a unique seed
   * so their caches don't collide.
   */
  paradigm_seed?: string;
  json_mode?: boolean;
  stop?: string[];
}

export interface LLMResult {
  text: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  prompt_hash: string;
  /** True if served from cache (replay or record-hit). */
  cached: boolean;
}

/** Lower-level shape providers are asked to satisfy. */
export interface ProviderRequest {
  model: string;
  messages: LLMMessage[];
  opts: LLMOpts;
}

export interface ProviderResponse {
  text: string;
  tokens_in: number;
  tokens_out: number;
}

export interface LLMProvider {
  /** Stable name used in routing. */
  readonly name: "openai" | "gemini" | "anthropic" | "mock";
  call(req: ProviderRequest): Promise<ProviderResponse>;
}

export class LLMReplayMissError extends Error {
  readonly key: string;
  readonly model: string;
  constructor(model: string, key: string) {
    super(`LLM replay miss: model=${model} key=${key}`);
    this.name = "LLMReplayMissError";
    this.model = model;
    this.key = key;
  }
}

export class LLMProviderUnavailableError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`No provider configured to serve model ${model}`);
    this.name = "LLMProviderUnavailableError";
    this.model = model;
  }
}
