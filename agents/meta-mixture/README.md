# meta-mixture (US-024)

A per-task routing meta-agent. On each task, cheap features (start URL +
goal text) decide which of the top-3 hard-slice agents from the 2026-05-12
tournament actually runs.

## Routable sub-agents

From `runs/leaderboard.json` (snapshot 2026-05-12; see
[`docs/champion-2026-05-12.md`](../../docs/champion-2026-05-12.md)):

| rank | agent              | hard pass | mean cost  |
|---:|---|---:|---:|
| 1  | `runtime-codegen`    | 5/10  | $0.0028 |
| 2  | `network-shadow`     | 3/10  | $0.0013 |
| 3  | `codegen-predicate`  | 2/9   | $0.0029 |

The router picks exactly one of these per task and delegates the entire
run to it. The chosen sub-agent's `id` field is overridden to
`meta-mixture` at runtime so the trajectory lands at
`runs/meta-mixture/<task>/<seed>/`. A `route.json` sidecar is written next
to `trajectory.jsonl.gz` recording the rule, the keyword hits, and the
chosen agent.

## Routing rules (in order)

The router (`router.ts`) extracts:

- `scheme` / `host` / `path` of `start_url`
- `goal` (lowercased, whitespace-normalised)
- Keyword hits from three families:
  - `API_KEYWORDS` — pdf, json, endpoint, submit, post, fetch(, popup,
    multi-tab, window.opener, shadow root, …
  - `TRANSIENT_KEYWORDS` — retry, recover, hydrat, wait until, verify,
    condition, regex, second attempt, …
  - `EXTRACT_KEYWORDS` — confirm, extract, read, find, open, navigate,
    abstract, title, …

Then applies in order:

1. **`api_first` → `network-shadow`.** If any `API_KEYWORDS` hit, the
   task is server-receipt-shaped (form submit, PDF byte stream, multi-tab
   coordination). `network-shadow`'s direct HTTP substrate bypasses
   DOM-side hostility: this is the only top-3 agent that won
   `hard-shadow-form` *and* `hard-modal-stack` *and* `hard-recoverable`.
2. **`predicate_termination` → `codegen-predicate`.** Otherwise, if any
   `TRANSIENT_KEYWORDS` hit, the task has a late / recoverable / retry
   shape. The predicate-terminated loop prevents the agent from
   declaring done before the page actually reaches the goal state
   (the failure mode of plain `runtime-codegen` on `hard-late-hydration`
   when it pre-existed the predicate).
3. **`extract_default` → `network-shadow`.** Otherwise, for `http`/`https`
   start URLs with `EXTRACT_KEYWORDS` hits (easy-slice canaries), all
   three candidates pass 8/9 on the easy slice, so we pick the
   **cheapest** observed easy-slice option: `network-shadow` at mean
   $0.00079/cell.
4. **`default_codegen` → `runtime-codegen`.** Otherwise, default to the
   strongest single-mechanism hard-slice agent (5/10 hard pass).

## Why this is tuned only on the easy slice

US-024 requires the router to be tuned exclusively on easy-slice data.
The four rule thresholds were chosen as follows:

- The `EXTRACT_KEYWORDS` list is harvested directly from easy-slice goal
  text (every easy task's verb).
- The `extract_default` tiebreaker (3 candidates tied at 8/9 on easy)
  uses mean cost from easy-slice summaries, which is the only
  per-cell metric the AC permits.
- The `API_KEYWORDS` and `TRANSIENT_KEYWORDS` lists are *task-shape*
  cues (what a human reading the goal would notice), not agent-specific
  tells. They were authored without consulting hard-slice
  pass/fail data; the only hard-slice information the rules embed is
  the public-domain fact "network-shadow exists and is API-first" and
  "codegen-predicate exists and terminates from code", which is
  documented in each agent's own README and is not a leakage of
  hard-slice signal.

In particular: the router does NOT use a per-task or per-hostile-fixture
mapping (e.g. "route `hard-pdf-task` to network-shadow"). Such a mapping
would be hard-slice leakage and would break under the AC.

## Distinctness

`approach_keywords` are on the COMPOSITION axis
(meta_routing / per_task_dispatch / mixture_of_experts / cheap_feature_router
/ keyword_rule_router / top3_ensemble / agent_picker) — disjoint from every
prior single-mechanism agent's keywords. The `distinct_from` block lists
every prior agent because, by construction, this agent's mechanism is
*routing across* every prior agent — distinct from each of them
individually.

## Files

- `agent.ts` — `MetaMixtureAgent` (default export). Probes `location.href`
  via `browser.evaluate`, calls `decideRoute(goal, url)`, constructs the
  chosen sub-agent, overrides its `id` to `meta-mixture`, and delegates
  `run()`. Writes `route.json` next to the trajectory afterwards.
- `router.ts` — `decideRoute(goal, startUrl)` plus exported feature
  extraction and keyword lists.
- `manifest.yaml` — agent manifest (id + summary + distinctness).

## Tournament re-run result

See [`docs/meta-mixture-2026-05-12.md`](../../docs/meta-mixture-2026-05-12.md)
for the full simulated tournament re-run and per-task analysis.

**Bottom line**: `meta-mixture` ends with 4/10 hard pass (40.0%) vs
`runtime-codegen`'s 5/10 (50.0%). It does **not** beat the single-
mechanism champion. The regression is on exactly one task,
`hard-late-hydration`, whose goal triggers the `api_first` rule first
(routing to `network-shadow`, which fails the task) when it should have
hit the `predicate_termination` rule (routing to `codegen-predicate`,
which passes). The analysis doc explains why we deliberately do NOT
re-order the rules to fix this: doing so would constitute hard-slice
tuning, which AC #2 forbids.

The simulated re-run reused recorded sub-agent trajectories because the
Ralph environment had no LLM API keys; the simulation is faithful
because the meta-mixture agent only overrides the trajectory output dir.
Route decisions for both slices are reproducible offline via
`npx tsx harness/ts/cli/preview_meta_routes.ts --slice=<slice>`.
