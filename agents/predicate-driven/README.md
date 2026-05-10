# predicate-driven

Fourth novel agent (US-017). Test-driven browsing: synthesise the
finish-line first, then iteratively mutate the page until the finish-line is
crossed.

## Mechanism

```
synthesise predicate (1 LLM call) ──► loop:
                                        ├─ observe page
                                        ├─ pick next action (1 LLM call)
                                        ├─ execute action
                                        ├─ evaluate predicate in-page
                                        └─ if predicate true → DONE
```

The agent makes **one** LLM call upfront whose job is to author a JavaScript
expression — the *predicate* — that returns `true` in the live page exactly
when the goal is satisfied (and `false` otherwise). The expression runs as
the body of an async IIFE wrapped in `Boolean(...)` and may use any in-page
JS the action layer would: `document.*` queries, `fetch()` against same-origin
endpoints, `shadowRoot` traversal, `await` on a promise, `?.` short-circuits,
regex against `innerText`. The harness's `BrowserSession.evaluate`
already passes `awaitPromise=true`.

After every action, the agent **polls** the predicate against the post-action
page. The instant it returns `true` the trajectory ends `DONE`. If `maxSteps`
elapses with the predicate still false, the trajectory ends `DECLINED`.

The action LLM never sees the predicate text — its only job is "look at the
goal and the current page; pick the next move." It also has no `finish`
action: the action parser explicitly rejects `{type: "finish"}`. The LLM
simply cannot terminate the loop.

## Distinct from prior slots

Every other agent in `agents/` lets the LLM signal completion:

| Agent | Termination signal |
| --- | --- |
| baseline-a11y-react | LLM emits `{action: "finish", reason: ...}` |
| plan-then-execute | the plan's last op runs, or repair budget is exhausted |
| runtime-codegen | the in-page IIFE returns `{done: true, ...}` |
| speculative-rollback | a separate JUDGE LLM emits `{verdict: "done"}` |
| **predicate-driven** | **a JS expression run in the page returns true** |

The other agents bind termination to LLM output, which is a finding-of-fact
the LLM is asked to perform on its own state. This agent binds termination
to a finding-of-fact about the *page state*, computed by code. Two
consequences:

1. **Stop being lied to.** "I clicked submit and saw a confirmation" is a
   well-documented LLM hallucination class. The predicate cannot hallucinate
   — if the page does not contain `submission accepted`, the loop continues.
2. **Retry-driven recovery for free.** When the page is in a *transient*
   non-success state (mid-hydration, after a server 500), the predicate
   stays false and the action LLM is invited to try again. No special-case
   "retry" logic is needed.

## Failure modes addressed

Predicates are well-suited to fixtures whose success criterion is
*observable in the page* and whose failure modes are *transient*:

- `hard-recoverable` (US-008): submit fails once with 500, page surfaces a
  re-enabled button and a banner. With a predicate of
  `document.querySelector('h1')?.innerText.includes('submitted')`, the
  agent simply keeps trying after each failed click. Trajectories from
  `runs/baseline-a11y-react/hard-recoverable/0/trajectory.jsonl.gz` and
  `runs/plan-then-execute/hard-recoverable/0/trajectory.jsonl.gz` show
  the prior agents giving up (or `finish`-ing) after one failed click.
- `hard-late-hydration` (US-008): button has a no-op handler for the first
  1500ms. With a predicate of `window.__test?.completed === true`, the
  agent's clicks are no-ops until the real handler attaches; once it does,
  one more click fires the predicate. Prior agents that emit `finish` after
  a single click race the hydration window and fail when
  `clickedAt < hydratedAt`.
- `hard-conditional-form` (US-007): a form whose validation rules change
  mid-stream. A predicate of `document.title === 'submitted'` keeps the
  agent honest about what "done" actually looks like, where prior agents
  have been observed declaring `finish` on an intermediate step that
  *appeared* successful.

For UI-substrate-bound failures (canvas drag, multi-tab popups, PDF
parsing), the predicate-driven mechanism does NOT add capability — the
action layer is plain CSS-selector clicks/types/scrolls/waits/navigates,
identical in reach to speculative-rollback's substrate. Those fixtures
remain out of reach for this agent regardless of how good the predicate is.

## Cost shape

Per task: 1 synthesis call + N action calls + N in-page evaluates (free).
Strictly cheaper than speculative-rollback's worst case (1 propose + K
judges per step) and comparable to baseline's per-step cost. The synthesis
call's prompt is small (system prompt + goal + initial observation), so
the upfront cost is roughly half a regular step.

## Implementation

```
agents/predicate-driven/
├── agent.ts        # Agent class + outer loop + LLM message builders
├── predicate.ts    # parsePredicate + wrapPredicate + evaluatePredicate
├── actions.ts      # AgentAction union + parser (rejects `finish`) + executor
├── observe.ts      # in-page snapshot script + formatter
├── manifest.yaml   # id, approach_keywords, distinct_from
└── README.md       # this file
```

The action substrate (CSS-selector keyed) is shared in *style* with
speculative-rollback; the **mechanism** that distinguishes this agent is
entirely in `agent.ts`'s loop and `predicate.ts`'s evaluator. Action
keywords were deliberately chosen with zero overlap against every prior
manifest's `approach_keywords`, so the auto-discovery distinctness check
(`harness/ts/tournament/distinctness.ts`) passes by margin.

Default model: `gpt-4o-mini`. Step cap: 10. The agent gracefully declines
when no LLM provider is configured (returns `terminal_state: "DECLINED"`),
so the contract test runs without secrets.

## Prior art

The closest analogues outside this repo are *goal-conditioned RL* (which
also separates a stationary success signal from a learned policy) and
property-based testing (which authors a property and lets the engine search
for a satisfying input). What is novel here is binding the success signal
to a runtime-evaluated DOM probe inside the agent's own browser, without a
separate verifier service or labelled training set, and refusing to give
the policy LLM any way to override that signal.
