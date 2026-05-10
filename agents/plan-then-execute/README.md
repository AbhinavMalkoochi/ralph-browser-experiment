# plan-then-execute

First novel agent slot (US-014). The mechanism is **batch planning over
intent-keyed selectors**, deliberately distinct from
`baseline-a11y-react`.

## Mechanism

One LLM call emits the entire plan upfront, as a JSON array of operations
defined in `script.ts`. Each operation references the page by *visible
text* — link copy, button label, input label, body-text snippet — rather
than an integer accessibility id. The executor resolves text → element
inside the page at run time using a small CSS-free in-page script
(`CLICK_BY_TEXT`, `TYPE_BY_LABEL`, etc.) that walks the DOM, filters to
visible interactive elements, and prefers exact match over prefix over
substring.

Operation set (see `script.ts` for the full schema):

- `goto(url)` — navigate.
- `click_text(text)` — click the first interactive element whose visible
  name matches.
- `type(label, value, submit?)` — fill the input whose label/placeholder
  matches; optionally request-submit its enclosing form.
- `wait_for_text(text, timeout_ms?)` — poll body text until it appears.
- `assert_text(text)` — fail-fast guard for verification.
- `scroll(direction, pixels?)`, `extract(query)`, `finish(reason)`.

The agent runs ops sequentially. When an op classified as `hard_fail`
trips (e.g. `click_text` matches nothing), it re-snapshots URL + title
and asks the LLM for a *remaining* plan from the current page. Up to
`maxRepairs=2` repair calls are allowed; otherwise the trajectory ends
`DECLINED` with the failure trace. With no failures, the entire task is
one LLM call.

## How it differs from `baseline-a11y-react`

| Axis              | baseline-a11y-react                       | plan-then-execute                        |
|-------------------|-------------------------------------------|------------------------------------------|
| LLM turns         | one per step (ReAct)                      | one for the whole plan, +≤2 repairs      |
| Selector key      | integer aid from per-turn snapshot        | visible text (label / link copy)         |
| Page observation  | full a11y snapshot every step             | only URL + title (then the page itself)  |
| Repair            | implicit (next ReAct turn)                | explicit failure-conditioned re-plan     |
| Element resolver  | `data-gba-aid` lookup                     | DOM walk for visible match in-page       |

`distinct_from: [baseline-a11y-react]` is enforced by the discovery
distinctness check (Jaccard on `approach_keywords`); the two agents
share zero keywords, so the check passes trivially.

## Prior art

The "plan then act" pattern is a long-standing idea in agent literature
(SayCan, ReWOO, LATS-style decompositions). What this agent specifically
borrows from the browser-automation tradition is the **text-keyed
selector** layer: visible-name resolution, similar in spirit to
Stagehand's natural-language locator hints — but performed with a tiny
in-page script and no LLM in the loop for selector resolution. The
batch-plan-with-repair shape is closer to ReWOO than to ReAct.

## Trade-offs

- **Win conditions**: straight-line tasks (search → result extraction,
  fixed-form fills) are one LLM call instead of N. Lower latency and
  lower cost when the page DOM is well-labelled.
- **Loss conditions**: highly stateful tasks (modal stacks, conditional
  forms whose later steps depend on observed values) burn through the
  repair budget quickly. Tasks whose interactive elements lack visible
  text (canvas, icon-only buttons) are unresolvable by this agent.
- **No skill library**, no world model, no code generation — those are
  later slots' problem.

## Files

- `script.ts` — operation DSL, parser, classifier, in-page executor.
- `agent.ts` — Agent subclass: build prompt, call LLM, execute, repair.
- `manifest.yaml` — id / language / keywords / distinct_from.

## Running

```
make eval AGENT=plan-then-execute SLICE=easy
```

Without `OPENAI_API_KEY` / `GEMINI_API_KEY` set, every cell finishes
`DECLINED` (the contract test path). With keys, the agent issues real
LLM calls; results land under `runs/plan-then-execute/`.
