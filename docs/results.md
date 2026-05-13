# Final results — general-browser-agent tournament

_Post-mortem for the full tournament arc (US-001 through US-024). Generated
2026-05-12. Every number in this document is regenerable from `runs/` via
`make report`; the source-of-truth file is
[`runs/leaderboard.json`](../runs/leaderboard.json) built by
[`harness/ts/cli/build_leaderboard.ts`](../harness/ts/cli/build_leaderboard.ts)._

## TL;DR

- **Champion: [`runtime-codegen`](../agents/runtime-codegen/README.md)** —
  50.0% pass on the hard slice (5/10), 20 points above the runner-up.
  Mechanism: the LLM emits an async JS function body that `Runtime.evaluate`
  runs in the page each turn. Detail in
  [`champion-2026-05-12.md`](champion-2026-05-12.md).
- **Best easy-slice agent: [`dom-mutation-stream`](../agents/dom-mutation-stream/README.md)**
  on the canonical 9-fixture easy split (9/9, $0.0009 mean). On the
  v2 22-task easy slice (US-029) the leader is
  [`network-shadow`](../agents/network-shadow/README.md) at 19/22 (86.4%) —
  see [`easy-v2-results-2026-05-11.md`](easy-v2-results-2026-05-11.md).
- **The capability frontier is real**: five hard fixtures
  (`hard-canvas-drag`, `hard-iframe-drag`, `hard-multi-tab`,
  `hard-conditional-form`, `hard-pdf-task`) are **0/N across the entire
  roster**. They define the next research umbrella; substrate gaps explain
  every one of them. See [§4](#4-failure-taxonomy).
- **Mechanism beats vocabulary**: of the 11 ranked agents, the top-4 hard
  performers (runtime-codegen, meta-mixture, network-shadow,
  codegen-predicate) all share **code-emission or out-of-band observation**.
  Fixed JSON action vocabularies cap at 20% hard. See [§5](#5-mechanism-success-correlation).

## 1. Champion summary

| field | value |
|---|---|
| agent | [`runtime-codegen`](../agents/runtime-codegen/README.md) |
| manifest | [`agents/runtime-codegen/manifest.yaml`](../agents/runtime-codegen/manifest.yaml) |
| hard pass | 5/10 (50.0%) |
| hard mean cost | $0.0028 |
| hard p95 latency | 55,264 ms |
| margin over #2 | +20 points (next: `meta-mixture` 4/10) |
| full write-up | [`docs/champion-2026-05-12.md`](champion-2026-05-12.md) |

Mechanism: each turn the LLM emits the **body of an async JavaScript
function** that runs inside the target page via CDP `Runtime.evaluate`. No
fixed action vocabulary — the body has direct access to shadow roots,
same-origin iframes, synthetic `MouseEvent` dispatch, `fetch()`, and
`postMessage`. The body returns `{done?, message, navigate?, sleep_ms?}` and
the harness loops to step cap. Wins exercise primitives the fixed-vocabulary
agents cannot reach without harness changes:

| won task | trajectory | what the body did |
|---|---|---|
| `hard-shadow-form` | [trajectory](../runs/runtime-codegen/hard-shadow-form/0/trajectory.jsonl.gz) | walked `host.shadowRoot.querySelector(...)` |
| `hard-modal-stack` | [trajectory](../runs/runtime-codegen/hard-modal-stack/0/trajectory.jsonl.gz) | chained `.click()` on z-ordered roots, ignored decoys by text |
| `hard-virtual-scroll` | [trajectory](../runs/runtime-codegen/hard-virtual-scroll/0/trajectory.jsonl.gz) | computed `scrollTop = idx * rowHeight - 100` |
| `hard-recoverable` | [trajectory](../runs/runtime-codegen/hard-recoverable/0/trajectory.jsonl.gz) | re-clicked submit after observing recovery banner |
| `hard-late-hydration` | [trajectory](../runs/runtime-codegen/hard-late-hydration/0/trajectory.jsonl.gz) | polled `window.__test.hydrated` from the body before clicking |

## 2. Full leaderboard

Reproduce: `npx tsx harness/ts/cli/build_leaderboard.ts && make report` ⇒
[`docs/leaderboard.md`](leaderboard.md) (regenerated table is the canonical
copy; pasted below as of the latest `make report`).

### Hard slice

| rank | agent | pass | success | mean steps | mean cost | p50 ms | p95 ms |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | [runtime-codegen](../agents/runtime-codegen/README.md) | 5/10 | 50.0% | 9.2 | $0.0028 | 23,175 | 55,264 |
| 2 | [meta-mixture](../agents/meta-mixture/README.md) | 4/10 | 40.0% | 8.4 | $0.0017 | 11,015 | 55,264 |
| 3 | [network-shadow](../agents/network-shadow/README.md) | 3/10 | 30.0% | 8.1 | $0.0013 | 10,301 | 15,187 |
| 4 | [codegen-predicate](../agents/codegen-predicate/README.md) | 2/9 | 22.2% | 10.6 | $0.0029 | 14,817 | 81,717 |
| 5 | [plan-then-execute](../agents/plan-then-execute/README.md) | 2/10 | 20.0% | 8.6 | $0.0004 | 5,837 | 13,775 |
| 5 | [predicate-driven](../agents/predicate-driven/README.md) | 2/10 | 20.0% | 11.0 | $0.0014 | 10,827 | 12,286 |
| 5 | [dom-mutation-stream](../agents/dom-mutation-stream/README.md) | 2/10 | 20.0% | 9.5 | $0.0014 | 14,529 | 46,732 |
| 8 | [speculative-rollback](../agents/speculative-rollback/README.md) | 1/10 | 10.0% | 11.8 | $0.0031 | 28,739 | 32,985 |
| 9 | [click-first-link](../agents/click-first-link/README.md) | 0/19 | 0.0% | 1.0 | $0.0000 | 16 | 47 |
| 9 | [vision-grounded](../agents/vision-grounded/README.md) | 0/10 | 0.0% | 10.0 | $0.0228 | 46,105 | 47,565 |

### Easy slice (canonical 9-fixture)

| rank | agent | pass | success | mean cost |
|---:|---|---|---:|---:|
| 1 | [dom-mutation-stream](../agents/dom-mutation-stream/README.md) | 9/9 | 100.0% | $0.0009 |
| 2 | [speculative-rollback](../agents/speculative-rollback/README.md) | 9/9 | 100.0% | $0.0026 |
| 3 | [baseline-a11y-react](../agents/baseline-a11y-react/README.md) | 8/9 | 88.9% | $0.0000 |
| 3 | [plan-then-execute](../agents/plan-then-execute/README.md) | 8/9 | 88.9% | $0.0002 |
| 3 | [meta-mixture](../agents/meta-mixture/README.md) | 8/9 | 88.9% | $0.0008 |
| 3 | [network-shadow](../agents/network-shadow/README.md) | 8/9 | 88.9% | $0.0008 |
| 3 | [runtime-codegen](../agents/runtime-codegen/README.md) | 8/9 | 88.9% | $0.0011 |
| 3 | [vision-grounded](../agents/vision-grounded/README.md) | 8/9 | 88.9% | $0.0045 |
| 9 | [predicate-driven](../agents/predicate-driven/README.md) | 7/9 | 77.8% | $0.0008 |

### Easy v2 slice (US-029, 22 tasks)

Full table: [`easy-v2-results-2026-05-11.md`](easy-v2-results-2026-05-11.md).
Top 3:

| rank | agent | pass | % |
|---:|---|---|---:|
| 1 | network-shadow | 19/22 | 86.4% |
| 2 | predicate-driven / baseline-a11y-react / speculative-rollback (tied) | 17/22 | 77.3% |

### Hard-app slice (live docker apps, sequential sweep)

Full table + state-contamination caveat:
[`hard-app-sweep-2026-05-10.md`](hard-app-sweep-2026-05-10.md). Top 2:

| rank | agent | pass | % |
|---:|---|---|---:|
| 1 | predicate-driven | 5/9 | 55.6% |
| 1 | vision-grounded | 5/9 | 55.6% |

## 3. Ablation findings

### 3a. Mixture-of-experts (US-024)

[`meta-mixture`](../agents/meta-mixture/README.md) routes each task to one
of the three top hard-slice agents
(`runtime-codegen` / `network-shadow` / `codegen-predicate`) using cheap
URL + goal-keyword features. Result:

- Hard slice: **40.0%** (4/10), beats every individual non-champion but
  underperforms the champion alone (50.0%).
- Easy slice: **88.9%** (matches the median; no easy-slice gain).
- Mean cost stays at $0.0017 (cheaper than the champion).

The router is correct when the chosen sub-agent is correct, and wrong when
its features mis-route a fixture (e.g. the meta-mixture picks `network-shadow`
for `hard-canvas-drag` because the goal mentions "drag", but no agent
in the routing set wins canvas-drag). Methodology + per-task routing
decisions: [`meta-mixture-2026-05-12.md`](meta-mixture-2026-05-12.md).

**Lesson**: ensemble routing's ceiling is bounded by the union of its
sub-agents' wins. The 0-of-N tasks in §4 are union-wide failures, so a
router built from existing agents cannot reach them; new substrate is
required.

### 3b. Model diversity (US-030)

Two agents × three models × 10 hard fixtures = 60 cells. Plumbing is wired
(Anthropic provider at `harness/ts/llm/providers/anthropic.ts`, GBA_MODEL
env override). Full results table is incomplete because the Ralph iteration
that landed US-030 had no `ANTHROPIC_API_KEY` available; the harness side is
deterministic-cached and replays for free when keys are re-supplied.
Reproducibility recipe + provider plumbing:
[`model-ablation-2026-05-11.md`](model-ablation-2026-05-11.md).

**Lesson**: agent code MUST read `process.env.GBA_MODEL` rather than hard-
code a model string, so a single agent can be swept across providers without
forking. The two agents updated for US-030 (`runtime-codegen`,
`network-shadow`) demonstrate the pattern.

### 3c. Filesystem-as-memory / DOM-as-filesystem (US-021, US-033)

Two architectural experiments — externalising observation history to disk
(`fs-memory`) and treating the DOM as a POSIX-ish filesystem with `cd`/`ls`/`cat`
(`dom-shell`) — landed late and did not produce enough hard-slice cells to
re-rank the top of the leaderboard, but their manifests
([`agents/fs-memory/manifest.yaml`](../agents/fs-memory/manifest.yaml),
[`agents/dom-shell/manifest.yaml`](../agents/dom-shell/manifest.yaml))
document mechanism axes (observation-storage, command-grammar) that future
work can re-explore.

## 4. Failure taxonomy

Full mining: [`failure-clusters-2026-05-12.md`](failure-clusters-2026-05-12.md).
Summary across 274 cells / 93 failures:

### 4a. By terminal_state

| terminal_state | count | meaning |
|---|---:|---|
| `DECLINED` | 82 (88%) | step budget exhausted, agent stuck in no-progress loop |
| `DONE` | 8 | agent claimed done, verifier disagreed |
| `BUDGET_EXCEEDED` | 2 | token cap hit |
| `DONE_BY_PREDICATE` | 1 | predicate fired, verifier rejected |

Headline: ~88% of failures are step-budget exhaustion. The substrate runs;
the policy doesn't recognise its own stagnation. This is a policy bug, not
a substrate bug, and motivates Hypothesis #3 below.

### 4b. By task — the 0-of-N frontier

Five hard fixtures fail across the **entire** roster (9 LLM-using agents
each):

| task | tags | substrate gap |
|---|---|---|
| `hard-canvas-drag` | canvas, pointer, geometry | no CDP `Input.dispatchMouseEvent` action; synthetic `MouseEvent` doesn't engage native hit-test |
| `hard-iframe-drag` | iframe, cross-frame, drag | same + cross-frame drag protocol not crossed |
| `hard-multi-tab` | window.open, popup | `BrowserSession` is single-target; no `Target.targetCreated` enumeration |
| `hard-conditional-form` | branching validation, server cross-check | no probe-the-server-for-error mechanism in any agent's loop |
| `hard-pdf-task` | binary asset, PDF text | action vocabulary is DOM-shaped, no binary-decoder primitive |

Trajectory evidence (one example per cluster):

- Cluster A — synthetic-event drag:
  [`runs/runtime-codegen/hard-canvas-drag/0/trajectory.jsonl.gz`](../runs/runtime-codegen/hard-canvas-drag/0/trajectory.jsonl.gz)
- Cluster B — popup blindness:
  [`runs/runtime-codegen/hard-multi-tab/0/trajectory.jsonl.gz`](../runs/runtime-codegen/hard-multi-tab/0/trajectory.jsonl.gz)
- Cluster C — hidden server validation:
  [`runs/dom-mutation-stream/hard-conditional-form/0/trajectory.jsonl.gz`](../runs/dom-mutation-stream/hard-conditional-form/0/trajectory.jsonl.gz)
- Cluster D — binary asset:
  [`runs/runtime-codegen/hard-pdf-task/0/trajectory.jsonl.gz`](../runs/runtime-codegen/hard-pdf-task/0/trajectory.jsonl.gz)

## 5. Mechanism → success correlation

Pinning each agent's `approach_keywords` against its hard-slice pass-rate:

| agent | substrate axis | hard pass-rate |
|---|---|---:|
| runtime-codegen | code emission into page | 50% |
| meta-mixture | composed routing over top-3 | 40% |
| network-shadow | HTTP-first observation | 30% |
| codegen-predicate | code emission + predicate | 22% |
| plan-then-execute | batch JSON plan | 20% |
| predicate-driven | predicate-terminated JSON loop | 20% |
| dom-mutation-stream | MutationObserver stream | 20% |
| speculative-rollback | snapshot + speculate | 10% |
| vision-grounded | pixel-coordinate vision | 0% |
| baseline-a11y-react | a11y-tagged JSON actions | (hard ∅) |
| click-first-link | trivial baseline | 0% |

Observations:

1. **Code-emission wins.** The two agents that emit JS into the page
   (`runtime-codegen`, `codegen-predicate`) plus the agent that picks them
   (`meta-mixture`) own three of the top four hard slots. Fixed action
   vocabularies cap at 20%.
2. **HTTP-as-observable matters.** `network-shadow` reaches 30% by reading
   the page's own POSTs back, with the cheapest cost in its tier ($0.0013).
   This is the only non-code-emission mechanism that breaks 20% on hard.
3. **Pixel-grounded vision was a documented dead end.** `vision-grounded`
   went 0/10 on hard because gpt-4o-mini/gpt-4o systematically centre-bias
   their x estimates (notes in `progress.txt` US-018 entry). The fix —
   Set-of-Marks ([`vision-som`](../agents/vision-som/README.md), US-031) —
   removes pixel localisation by integer-indirecting through the DOM, but
   it lacks a hard-slice cell run.

## 6. Falsifiable next-paradigm hypotheses

Full text + trajectory grounding:
[`proposed-approaches-2026-05-12.md`](proposed-approaches-2026-05-12.md).
Five hypotheses, each with a pre-registered fail condition; the four
substrate-bound ones below are the strongest because each maps to a 0-of-N
task cluster.

### H1 — CDP-pointer-stream drag primitive

- **Cluster**: A (`hard-canvas-drag`, `hard-iframe-drag`, 0/18 combined).
- **Mechanism**: expose `pointer_down/move/up` and `drag(from,to,steps)`
  actions that compile to CDP `Input.dispatchMouseEvent` at the
  browser-process layer, bypassing the page's JS event surface.
- **Prediction**: on those two tasks, runtime-codegen + this primitive
  passes ≥1/2 within the 12-step budget over 3 seeds. **Rejected** if both
  still fail 0/2 after 3×2 cells.

### H2 — Multi-target window-graph perception

- **Cluster**: B (`hard-multi-tab`, 0/9).
- **Mechanism**: attach to `Target.targetCreated`/`targetDestroyed` at
  pool-acquire time; expose `list_targets()` / `switch_target(id)` /
  `wait_for_new_target(timeout)` so the LLM sees a graph of pages.
- **Prediction**: with the baseline-a11y-react policy unchanged, `hard-multi-tab`
  rises 0/3 → ≥1/3. **Rejected** if it stays 0/3.

### H3 — Adversarial probe-and-shrink for hidden server validation

- **Cluster**: C (`hard-conditional-form` 0/9) plus easy-slice
  `easy-httpbin-form` (2/8).
- **Mechanism**: on observation delta = 0 after an action, switch into
  *probe* mode — deliberately submit a known-invalid value, capture the
  server error text (DOM + response body), and incorporate it as a
  constraint. This is the only proposal that addresses the §4a stagnation
  failure mode by **making the policy act when it's stuck**.
- **Prediction**: `hard-conditional-form` 0/3 → ≥1/3 AND `easy-httpbin-form`
  2/8 → ≥4/8. **Rejected** if neither improves.

### H4 — Out-of-band binary asset reader

- **Cluster**: D (`hard-pdf-task`, 0/9).
- **Mechanism**: action `fetch_resource(url)` returns
  `{contentType, bytes_base64, text_utf8?}`, plus a harness-side
  `extract_text_from_pdf` (minimal text-stream parser for the fixture; ship
  a worker-bound pdfjs for real-world coverage).
- **Prediction**: `hard-pdf-task` 0/3 → ≥2/3. **Rejected** if the extractor
  is wired and the agent still fails.

## 7. Lessons for the next research umbrella

### Keep

- **The Trajectory contract** (`harness/ts/agent/trajectory.ts`). Every
  number in this document came out of `trajectory.jsonl.gz` + the
  `summary.json` / `verdict.json` sidecars. Per-step JSONL with `meta` /
  `step` / `llm_call` / `verification` / `end` lines, gzipped on finish, is
  the right level of structure for offline replay + downstream mining.
- **LLM record/replay cache** (`harness/ts/llm/cache.ts`). Made model
  ablation tractable and let the meta-mixture re-run in §3a be performed
  without keys.
- **Pool isolation** (`harness/ts/cdp/pool.ts`). The destroy-and-respawn
  contract removed cross-task contamination and exposed the
  hard-app sweep's *verifier-side* contamination (see
  [`hard-app-sweep-2026-05-10.md`](hard-app-sweep-2026-05-10.md) §"State
  contamination caveat") rather than masking it as an agent bug.
- **Verifier framework** with `js` / `trajectory_predicate` / `llm_judge`
  kinds at load-time validation (`harness/ts/verifier/loader.ts`). Three
  ways of stating ground-truth covered every task we wrote.

### Replace

- **`baseline-a11y-react` as the default baseline**: it has no hard-slice
  cells and is dominated on every slice that does have data. Replace with
  `network-shadow` as the "cheap-and-correct" baseline (hard 30%, easy
  88.9% canonical / 86.4% v2, $0.0013 mean cost — the Pareto front for any
  agent under $0.005 should clear this bar).
- **`vision-grounded`** (US-018) as the canonical vision agent. It is
  superseded mechanism-for-mechanism by `vision-som` (US-031). Re-run
  vision-som across the hard slice before the next tournament; if it
  passes ≥3/10 the prior pixel-grounded line of work can be retired.
- **`click-first-link`** as the trivial smoke baseline. It contaminates
  the leaderboard with 19 hard cells (vs 10 for every other agent) and
  reports a misleading 0/19 vs others' 0/10. Replace with a real no-op
  agent that declines immediately.

### Extend

- **Per-task verifier provenance**: the hard-app slice taught us that a
  verifier that queries app state without provenance-checking lets the
  *first* agent's artifact pass for *every* subsequent agent. Verifiers
  in app-slice tasks must scope-check to the current run (e.g. timestamp
  the seed in the artifact body and require the verifier to find that
  exact tag) before live sequential sweeps are trustworthy.
- **Substrate axes as a planning input**: each new agent slot should
  declare its `approach_keywords` against the §5 axes (action-vocabulary
  shape, observation channel, code-emission yes/no, target-graph awareness,
  binary-asset access). Future Ralph iterations can reject proposals whose
  keyword set is a subset of an existing agent's — the harness already has
  the data via `agents/*/manifest.yaml`.
- **Step-budget feedback to the policy**: every agent's prompt is
  currently blind to its own progress. A `steps_used / steps_total` line
  plus a "stagnation detected" signal (no observation delta last K steps)
  pushed into the prompt would attack the 88% DECLINED failure mode without
  any substrate change. This is the cheapest experiment on this list.

## 8. Reproducibility

Every cell, table, and percentage in this document is regenerable from
`runs/`:

```sh
# One-shot — backfill summaries for any trajectories without sidecars.
npx tsx harness/ts/cli/synthesize_summaries.ts

# Rebuild runs/leaderboard.json from disk (does not run any LLM).
npx tsx harness/ts/cli/build_leaderboard.ts

# Render docs/leaderboard.md + per-slice tables.
make report
```

A live re-run, when budget allows:

```sh
make tournament SLICE=easy SEEDS=3 BRACKET=on
make tournament SLICE=hard SEEDS=3 BRACKET=on
make report
```

Caveats from prior iterations carry forward: SEEDS=1 across most of the
ranked cells (`docs/champion-2026-05-12.md` §"Caveat — methodology"); the
hard-app slice's verifier-state contamination is documented but not yet
fixed in the verifiers themselves.

## 9. Companion documents

- [`champion-2026-05-12.md`](champion-2026-05-12.md) — champion deep-dive.
- [`leaderboard.md`](leaderboard.md) — full per-slice tables, Pareto front, per-tag failures.
- [`failure-clusters-2026-05-12.md`](failure-clusters-2026-05-12.md) — full failure mining.
- [`proposed-approaches-2026-05-12.md`](proposed-approaches-2026-05-12.md) — five next-paradigm proposals.
- [`meta-mixture-2026-05-12.md`](meta-mixture-2026-05-12.md) — US-024 routing methodology.
- [`easy-v2-results-2026-05-11.md`](easy-v2-results-2026-05-11.md) — US-029 22-task easy re-run.
- [`hard-app-sweep-2026-05-10.md`](hard-app-sweep-2026-05-10.md) — US-027 live docker-app sweep + contamination caveat.
- [`model-ablation-2026-05-11.md`](model-ablation-2026-05-11.md) — US-030 provider sweep plumbing.
