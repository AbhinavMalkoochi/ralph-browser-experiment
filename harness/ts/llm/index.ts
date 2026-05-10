// LLM module barrel. Agents import from here:
//   import { LLMClient, defaultClient, type LLMResult } from "../../harness/ts/llm/index.js";

export { LLMClient, defaultClient } from "./client.js";
export type { LLMClientOpts, LLMMode, DefaultClientOpts } from "./client.js";
export { LLMCache, hashKey, defaultCacheRoot, tmpCacheRoot } from "./cache.js";
export type { CacheEntry, HashKeyInput } from "./cache.js";
export { OpenAiProvider } from "./providers/openai.js";
export { GeminiProvider } from "./providers/gemini.js";
export { PRICING, costUsd, isPricedModel } from "./pricing.js";
export {
  LLMReplayMissError,
  LLMProviderUnavailableError,
} from "./types.js";
export type {
  LLMMessage,
  LLMContentPart,
  LLMOpts,
  LLMResult,
  LLMRole,
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
} from "./types.js";
