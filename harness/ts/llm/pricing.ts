// Per-million-token pricing for cost accounting. The tournament uses these
// for relative cost ranking, not for invoice reconciliation, so an unknown
// model is allowed (cost recorded as 0) rather than a hard error.
//
// Numbers reflect public list prices as of early 2026. Update freely; cache
// entries don't depend on these (they store raw token counts and the cost is
// recomputed at read time).

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

export const PRICING: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "o4-mini": { input: 1.1, output: 4.4 },

  // Google
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.5-flash-lite": { input: 0.04, output: 0.15 },

  // Anthropic (optional; not wired by US-004)
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },

  // Test-only model used by the mock provider.
  "mock-model": { input: 0, output: 0 },
};

export function costUsd(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
}

export function isPricedModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRICING, model);
}
