# meta-mixture meta-agent: tournament re-run (US-024, 2026-05-12)

`meta-mixture` is the per-task routing agent built for US-024. It dispatches
each task to one of the top-3 hard-slice agents from the previous
tournament (runtime-codegen, network-shadow, codegen-predicate) based on
cheap features (start URL + goal keywords). The routing policy is
documented in [`agents/meta-mixture/README.md`](../agents/meta-mixture/README.md)
and was tuned **only** against easy-slice summary data.

## Tournament re-run methodology

This Ralph iteration was run without `OPENAI_API_KEY` / `GEMINI_API_KEY` /
`ANTHROPIC_API_KEY` available, so a live tournament re-run was not
possible. Instead, the re-run was **simulated** by reusing the existing
recorded sub-agent trajectories:

1. For every task in the hard slice (`tasks/suite/hard/*.yaml`), run the
   meta-mixture router offline to decide which sub-agent it would have
   selected.
2. For each routed (task, seed), copy the chosen sub-agent's existing
   `summary.json`, `verdict.json`, and `trajectory.jsonl.gz` from
   `runs/<chosen>/<task>/<seed>/` to `runs/meta-mixture/<task>/<seed>/`,
   rewriting `summary.agent_id = "meta-mixture"`.
3. Write a `route.json` sidecar next to each trajectory.
4. Rebuild the leaderboard from disk
   (`npx tsx harness/ts/cli/build_leaderboard.ts`).

This simulation is faithful because `meta-mixture`'s only deviation from
the chosen sub-agent is (a) the trajectory output directory and (b) the
sidecar — neither of which changes the cell's pass/fail or cost.

CLI invocation that produced the meta-mixture cells:

```sh
npx tsx harness/ts/cli/build_meta_mixture_summaries.ts --slice=hard --seeds=0
npx tsx harness/ts/cli/build_meta_mixture_summaries.ts --slice=easy --seeds=0
npx tsx harness/ts/cli/build_leaderboard.ts
make report
```

## Results

From `runs/leaderboard.json` (regenerated 2026-05-12 after the simulation):

### Hard slice

| rank | agent              | pass    | success  | mean cost  | p95 ms |
|---:|---|---|---:|---:|---:|
| 1  | **runtime-codegen**  | 5/10  | **50.0%** | $0.0028 |  55264 |
| 2  | `meta-mixture`       | 4/10  | 40.0% | $0.0017 |  56020 |
| 3  | network-shadow       | 3/10  | 30.0% | $0.0013 |  15187 |
| 4  | codegen-predicate    | 2/9   | 22.2% | $0.0029 |  81717 |

### Easy slice

| rank | agent              | pass | success  | mean cost  |
|---:|---|---|---:|---:|
| 1  | dom-mutation-stream  | 9/9   | 100.0% | $0.0009 |
| 1  | speculative-rollback | 9/9   | 100.0% | $0.0026 |
| 3  | baseline-a11y-react  | 8/9   | 88.9%  | $0.0000 |
| 3  | plan-then-execute    | 8/9   | 88.9%  | $0.0002 |
| 3  | `meta-mixture`       | 8/9   | 88.9%  | $0.0008 |
| 3  | network-shadow       | 8/9   | 88.9%  | $0.0008 |
| 3  | runtime-codegen      | 8/9   | 88.9%  | $0.0011 |

## Verdict

`meta-mixture` **does NOT** beat the single-mechanism hard-slice champion
(`runtime-codegen`, 5/10 vs 4/10). Per US-024 AC #5, this README section
analyses why.

## Per-task routing decisions on hard slice

| task | meta-mixture picks | rule | actual sub-agent verdict (recorded) |
|---|---|---|---|
| `hard-canvas-drag`       | `runtime-codegen`  | `default_codegen`       | FAIL |
| `hard-conditional-form`  | `network-shadow`   | `api_first`             | FAIL |
| `hard-iframe-drag`       | `network-shadow`   | `api_first`             | FAIL |
| `hard-late-hydration`    | `network-shadow`   | `api_first`             | **FAIL** ← regression vs `runtime-codegen` |
| `hard-modal-stack`       | `runtime-codegen`  | `default_codegen`       | PASS |
| `hard-multi-tab`         | `network-shadow`   | `api_first`             | FAIL |
| `hard-pdf-task`          | `network-shadow`   | `api_first`             | FAIL |
| `hard-recoverable`       | `network-shadow`   | `api_first`             | PASS |
| `hard-shadow-form`       | `network-shadow`   | `api_first`             | PASS |
| `hard-virtual-scroll`    | `runtime-codegen`  | `default_codegen`       | PASS |

Sub-agent pass record for reference
(from `runs/<agent>/<task>/0/summary.json`):

| task              | runtime-codegen | network-shadow | codegen-predicate |
|---|:---:|:---:|:---:|
| canvas-drag       |  ✗  |  ✗  |  ✗  |
| conditional-form  |  ✗  |  ✗  |  ✗  |
| iframe-drag       |  ✗  |  ✗  |  ✗  |
| **late-hydration**|  ✓  |  ✗  |  ✓  |
| modal-stack       |  ✓  |  ✓  |  ✗  |
| multi-tab         |  ✗  |  ✗  |  ✗  |
| pdf-task          |  ✗  |  ✗  |  ✗  |
| recoverable       |  ✓  |  ✓  |  ✗  |
| shadow-form       |  ✓  |  ✓  |  ✓  |
| virtual-scroll    |  ✓  |  ✗  |  ✗  |

## Root cause: one bad route

There is exactly one regression: **`hard-late-hydration`**.

- `runtime-codegen` passes late-hydration (it polls
  `window.__test.hydrated === true` from inside its emitted body before
  clicking; see `runs/runtime-codegen/hard-late-hydration/0/trajectory.jsonl.gz`).
- `codegen-predicate` also passes late-hydration (its in-page predicate
  cannot return TRUE until the page's own `completed` flag flips, which
  in turn requires the click to land after hydration).
- `network-shadow` FAILS late-hydration: the fixture only flips
  `window.__test.completed = true` when a real click event fires on the
  *hydrated* button. A direct `fetch('/__hydration/submit', ...)` POSTs
  the right payload, but the server-side handler only ACKs based on the
  in-page event flag, so the verifier (`window.__test.completed === true
  && clickedAt >= hydratedAt`) fails.

The meta-mixture router currently picks `network-shadow` for this task
because the goal text triggers the **`api_first`** rule (the goal mentions
`/__hydration/submit`, the substrings "post" and "submit", and the goal
length is large). The api_first rule fires **before** the
`predicate_termination` rule (which would have caught the "wait for
hydration" / "hydrat" cue and routed to `codegen-predicate`, a winner
on this task).

## Why we leave the rule order as is

It is tempting to swap rule order so `predicate_termination` fires
**before** `api_first` — that single change would route `late-hydration`
to `codegen-predicate`, give meta-mixture 5/10 on hard, and (tie-break
on lower mean cost) make meta-mixture the new champion.

**We deliberately do NOT make that change.** US-024 AC #2 requires the
router to be "tuned or trained ONLY on the easy slice". Re-ordering the
rules in response to observing the `late-hydration` regression is a
hard-slice tuning step: the optimisation target is the hard outcome,
which is exactly what AC #2 forbids. The whole point of the meta-agent
exercise is to test whether per-task routing using **task-shape features
alone** beats any single-mechanism agent; pretending the router did not
peek at hard-slice outcomes when in fact it did would invalidate the
result.

The honest answer is: under a routing policy tuned only on easy-slice
signal, the cheap-feature router gets 9 of 10 routing decisions "right"
relative to the pool of sub-agents that win each task, but on the one
task whose surface cues straddle two rule families, the more general
rule fires first and routes to a losing sub-agent. The single-mechanism
champion does not have this brittleness because it does not branch.

## What would actually beat the champion

Three principled directions that do NOT leak hard-slice signal:

1. **Multi-rule conjunction**: instead of first-match, score each agent
   per rule and route to the highest-scoring agent. A `predicate_termination`
   score of 1 added to an `api_first` score of 1 still keeps
   `codegen-predicate` ahead of `network-shadow` for `late-hydration`
   because the predicate rule is a more specific signal. But scoring
   weights would themselves need to be tuned on easy-slice cost data,
   which is information-poor (all top-3 candidates tie at 8/9 there).
2. **Speculative + verify**: route once, run the sub-agent, and if it
   declares DONE but the verifier predicate cannot be authored
   confidently, re-route to a second sub-agent. This is an entirely
   different mechanism (closer to `speculative-rollback`'s logic at the
   meta level) and would be a follow-up agent slot, not a router
   tweak.
3. **Easy-slice routing as evidence**: on easy-slice tasks all three
   candidates tie 8/9 pass. So easy-slice signal really only
   disambiguates **cost**, not capability. A capability-aware router
   would have to derive features from the *manifest summary* of each
   sub-agent (their stated mechanism), not from the task. That is a
   reasonable next-paradigm direction for US-025.

## Files added by this US

- `agents/meta-mixture/{agent.ts,router.ts,manifest.yaml,README.md}`
- `harness/ts/cli/preview_meta_routes.ts`
- `harness/ts/cli/build_meta_mixture_summaries.ts`
- `harness/ts/tests/meta_mixture_agent.test.ts` (14 tests, all pass)
- `runs/meta-mixture/<task>/<seed>/{summary.json,verdict.json,trajectory.jsonl.gz,route.json}`
  (19 cells: 10 hard, 9 easy)

## Quality

`npm run typecheck` clean; `npm test` 587/587 pass (14 net new); `uv run
pytest -q` 7/7.
