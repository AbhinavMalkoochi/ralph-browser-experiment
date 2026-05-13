# codegen-predicate (US-032)

A **composed** browser agent: fuses the action substrate of `runtime-codegen`
with the termination mechanism of `predicate-driven`. The composition is the
novelty — neither parent in isolation has BOTH a free-form action substrate
AND a code-decided exit condition.

## Mechanism

```
synthesise predicate (1 LLM call)
loop:
  observe page
  action LLM emits the BODY of an async JS function (1 call)
  harness runs the body in-page via Runtime.evaluate
  harness re-evaluates the predicate in-page
  if predicate → true: terminal_state = DONE_BY_PREDICATE; exit
end loop
```

Per step there is **one** action LLM call plus two cheap in-page evaluations
(the script and the predicate). The action LLM's return value has NO `done`
field — even if the LLM sets one it is ignored. Termination is owned by
code that runs in the page itself.

## What's distinct from each parent

- **vs. `runtime-codegen`** (US-015): runtime-codegen also lets the LLM
  author the action as raw JS, but it also lets the LLM declare itself
  finished via the body's `{done: true}` return. codegen-predicate strips
  that exit channel — the LLM cannot lie about completion. The same hostile
  fixtures where runtime-codegen's LLM finished early ("clicked submit, must
  be done") are exactly where a code-decided predicate keeps the agent
  honest.
- **vs. `predicate-driven`** (US-017): predicate-driven owns termination from
  code but constrains actions to a fixed `{click, type, scroll, wait,
  navigate}` JSON vocabulary keyed by CSS selectors. That substrate cannot
  pierce shadow DOM, drive a canvas, or POST to a same-origin endpoint
  without the page's normal UI. codegen-predicate keeps the predicate
  termination but swaps in runtime-codegen's unbounded JS body, so the
  agent can do anything an in-page script could do — and **still** can't
  declare itself done.
- **vs. `speculative-rollback`** (US-016, predecessor): srb also decouples
  termination from the action LLM, but at the cost of TWO LLM calls per
  step (proposer + judge) — the judge call doubles cost without expanding
  the action substrate. codegen-predicate has ONE action LLM call per step
  and a deterministic in-page probe instead of an LLM judge, closing the
  cost gap that bottomed srb on the hard slice.

The COMPOSITION is novel vs the union of the three: neither runtime-codegen,
predicate-driven, nor speculative-rollback exposes the pair (free-form JS
action substrate, code-decided exit condition, one action LLM call per
step). codegen-predicate is the first agent in this repo that does.

## Failure modes the composition is targeted at

- **recoverable / late-hydration** fixtures: runtime-codegen wins these
  when its body happens to retry. When it doesn't, the LLM's "done" verdict
  ratifies the failed first attempt. With a predicate, the loop simply does
  not exit until the page has actually moved to the goal state, forcing
  the LLM into another turn whether it likes it or not.
- **shadow / iframe / canvas substrate-bound fixtures**: predicate-driven
  cannot reach these with its CSS-selector vocabulary; runtime-codegen can.
  Composing the two pulls the predicate-driven loop into a regime where
  the action substrate is no longer the bottleneck.

## Cost / quality tradeoff (vs srb)

Speculative-rollback paid 2× LLM calls per step for a judge that decided
commit/revert/done. codegen-predicate pays 1× LLM call per step plus a
~few-millisecond in-page predicate eval. The predicate eval is
deterministic page JS — no LLM, no temperature, no spend. The result is a
strictly cheaper agent on the same termination axis.

## Acceptance targets

- Live eval on hard slice: ≥6/10 PASS (≥1 more than runtime-codegen's 5/10).
- Live eval on easy slice: ≥20/22.
- Manifest distinctness vs baseline-a11y-react, plan-then-execute,
  runtime-codegen, predicate-driven, and speculative-rollback (US-012
  Jaccard ≤ 0.5).
