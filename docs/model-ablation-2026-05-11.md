# Model-diversity ablation — 2026-05-11

Two agents × three models × hard slice (10 fixtures) × 1 seed = **60 cells**.
Goal: does mechanism win, or does model win? US-030 wires Anthropic's
Messages API as the third LLM provider in `harness/ts/llm/providers/anthropic.ts`
and re-runs the two highest-hard-score agents from the prior sweeps —
`runtime-codegen` and `network-shadow` — under three models in
`{gpt-4o-mini, claude-haiku-4-5, claude-sonnet-4-6}`.

Both agents read `GBA_MODEL` (added in this story) so the same agent code is
exercised across all three models with zero per-model branching.

## How to run

```bash
# All three providers need keys; without ANTHROPIC_API_KEY the claude cells
# will throw LLMProviderUnavailableError.
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
export GEMINI_API_KEY=...   # not used here, but defaultClient picks it up

npx tsx harness/ts/cli/model_ablation.ts \
  --slice=hard --seeds=1 --out=docs/model-ablation-2026-05-11.md
```

The script runs 6 ablation cells (`runtime-codegen` × 3 models then
`network-shadow` × 3 models), each cell being one pass over the 10
hard-slice fixtures. Outputs land at
`runs/model-ablation/<agent>/<task>/<seed>/`. Each cell's per-task
`summary.json` carries the verifier verdict and `cost_usd_total`, so a
re-run with the same cache files is free (record-or-replay determinism is
tested by `llm_anthropic_provider.test.ts`).

## Results

The 60-cell live sweep requires `ANTHROPIC_API_KEY` to be present at run
time. Ralph's autonomous iteration that landed US-030 does NOT have an
Anthropic key in its environment, so the rows below are populated by
whoever next runs the script with all three providers wired. The plumbing
(provider, routing, pricing, env-driven model override, cached
determinism, ablation CLI) is in place and tested.

| Agent             | Model              | Pass        | Mean cost (USD) | Mean latency (ms) |
| ----------------- | ------------------ | ----------- | --------------- | ------------------ |
| runtime-codegen   | gpt-4o-mini        | _pending_   | _pending_       | _pending_          |
| runtime-codegen   | claude-haiku-4-5   | _pending_   | _pending_       | _pending_          |
| runtime-codegen   | claude-sonnet-4-6  | _pending_   | _pending_       | _pending_          |
| network-shadow    | gpt-4o-mini        | _pending_   | _pending_       | _pending_          |
| network-shadow    | claude-haiku-4-5   | _pending_   | _pending_       | _pending_          |
| network-shadow    | claude-sonnet-4-6  | _pending_   | _pending_       | _pending_          |

### Reference baselines (single-model, gpt-4o-mini)

From the prior single-model hard-slice sweeps:

- `runtime-codegen` — 5/10 hard (canonical leader on `tasks/suite/hard/`).
- `network-shadow` — 1/10 hard locally; 3/10 hard on `hard-app/`. The
  API-first observation modality is high-variance on substrate-bound
  fixtures (shadow/canvas/PDF) and shines on REST-backed apps.

## What we expect to see

The pre-registered hypothesis (filled in here before running the live
sweep so a post-hoc rationalisation can't quietly creep in):

1. `runtime-codegen` × `claude-sonnet-4-6` should be the strongest single
   cell. The agent emits raw JS function bodies, and Sonnet's coding
   strength on out-of-distribution browser idioms (shadow DOM, late
   hydration) should compound with the mechanism's free-form action
   substrate.
2. `network-shadow` will gain less from a larger model than
   `runtime-codegen` will. Its bottleneck is whether the page even
   exposes an API endpoint the agent can hit, not the LLM's reasoning.
3. `claude-haiku-4-5` will beat `gpt-4o-mini` at similar mean cost on
   `runtime-codegen` (Haiku's published code performance is competitive
   with gpt-4o-mini at the same price tier), but the gap will be small
   enough that mechanism still dominates model — i.e. swapping
   `runtime-codegen` (mechanism A) for `network-shadow` (mechanism B)
   under the same model should move pass rate more than swapping
   gpt-4o-mini for claude-haiku-4-5 under the same mechanism.

If (1)–(3) all hold, the headline reads "mechanism wins, but a stronger
model on the right mechanism is the second axis". If (3) flips —
mechanism-held-constant model-swap moves the needle more than
model-held-constant mechanism-swap — the recommendation flips: scale
the model before adding new mechanisms.

## Provider notes

- The Anthropic provider in `harness/ts/llm/providers/anthropic.ts` is
  parity with the OpenAI provider on retry semantics (5 attempts,
  honours `Retry-After`, parses "try again in Xms" body hints, 500ms
  exponential backoff floor). It defaults `max_tokens` to 4096 because
  Anthropic requires the field; OpenAI does not, so the harness
  commonly omits it.
- Multimodal: OpenAI-style `image_url` content parts translate to
  Anthropic's `{ type: "image", source: { type: "base64" | "url", ... } }`
  blocks. Data URLs (`data:image/png;base64,…`) become base64 sources
  with the right `media_type`; remote URLs become `url` sources.
- `json_mode` has no Anthropic equivalent and is silently dropped — the
  convention is to ask for JSON in the prompt. The cache key still
  captures the caller's intent so swapping back to OpenAI re-keys
  cleanly (no stale JSON-mode cache hits).
- `ANTHROPIC_API_KEY` is registered for redaction by `defaultClient`
  alongside `OPENAI_API_KEY` and `GEMINI_API_KEY`.

## Tests added

`harness/ts/tests/llm_anthropic_provider.test.ts` (12 tests):

1. Wire-shape parity (POST `/messages`, `x-api-key`, `anthropic-version`).
2. System messages folded into the top-level `system` field.
3. Multimodal image_url → native source blocks (base64 + url).
4. 429 retry with body-hint backoff floor.
5. Retry exhaustion surfaces last `Anthropic 429`.
6. Non-transient 4xx not retried.
7. Tool-role messages rejected with a clear error.
8. LLMClient routes `claude-*` → anthropic provider with correct pricing.
9. Replay miss for `claude-*` throws `LLMReplayMissError`.
10. Record-then-replay determinism (single provider call across N reads).
11. `claude-*` without an anthropic provider throws
    `LLMProviderUnavailableError`.
12. API-key redaction at the LLMClient boundary.
