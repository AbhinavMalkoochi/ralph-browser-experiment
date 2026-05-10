# baseline-a11y-react

The honest control: an a11y-snapshot + ReAct-loop + JSON-action browser
agent. Every novel agent in this repo declares distinctness from this
one, and the tournament's Pareto chart is read relative to its score.

## Mechanism

Each step does the same six things:

1. **Snapshot.** A single `Runtime.evaluate` walks the DOM, marks every
   interactive element with a stable `data-gba-aid` integer, and returns
   `{url, title, text, elements[], seq}`. The element list carries each
   node's role, accessible name, type, value, placeholder, href, and
   visibility — enough for the LLM to issue actions without writing
   selectors. Aids persist across snapshots (the next-id counter lives on
   `window.__gba_next_aid`), so the LLM may safely reference an aid it
   saw in a prior turn.
2. **Render.** The snapshot is rendered as a compact text observation:
   `URL`, `Title`, the first 800 chars of body text, then a numbered
   list of the first 60 interactive elements. Format is stable so prompt
   caching works.
3. **Plan.** A single LLM call (default `gpt-4o-mini`, temperature=0)
   receives the system prompt, the goal, the last six action results,
   and the current snapshot. It must reply with one compact JSON object.
4. **Parse.** The action parser tolerates ```` ```json ```` fences and
   leading/trailing prose but rejects unknown action types. A bad turn
   is logged as `parse_error` and re-prompted; the agent does not abort.
5. **Act.** The action is dispatched against the live page:
   - `click(target)` → `document.querySelector('[data-gba-aid="…"]').click()`
   - `type(target, text, submit?)` → set `value`, dispatch `input` +
     `change`, optionally `form.requestSubmit()`
   - `scroll(direction, pixels?)` → `window.scrollBy`
   - `wait(ms)` → `setTimeout` (≤10s, for hydration)
   - `navigate(url)` → `BrowserSession.navigate`
   - `extract(query)` → grep body text for keyword-bearing lines
   - `finish(reason)` → exit the loop with `terminal_state=DONE`
6. **Record.** Step is appended to the trajectory with the action,
   result message, and latency. `budget.check()` runs before and after.

The loop is capped at 12 steps by default (the easy budget allows 15 —
the cap leaves headroom). Hitting the cap finishes with
`terminal_state=DECLINED, decline_reason="max steps (12) exhausted"`.

## Failure modes the baseline does NOT address

- **Shadow DOM.** `document.querySelectorAll('*')` does not pierce shadow
  roots, so the shadow-form fixture is invisible to the snapshot.
- **Canvas / drag-and-drop.** No mouse-event synthesis; canvas-drag and
  iframe-drag are out of scope.
- **Late hydration.** The agent has no notion of "wait for the page to
  fully bind" beyond an explicit `wait` action — racing hydration is
  expected to fail without an explicit wait.
- **Multi-tab.** Popups run in their own CDP target which the
  `CdpBrowserSession` does not attach to.

These are deliberate limitations of the baseline mechanism. The novel
agents in slots US-014..U-021 will pick off subsets of these failures by
choosing distinct mechanisms (event-bus interception, code-gen, world
models, etc.).

## Prior art

The combination of "ReAct loop + JSON action set + snapshot rendered as
numbered interactive elements" is shared by:

- **browser-use** (https://github.com/browser-use/browser-use): same
  shape; we deliberately mirror their `[N] role "name"` rendering so a
  reader of either codebase recognises the pattern instantly.
- **Stagehand** (https://github.com/browserbase/stagehand): adds an
  observability/eval layer and a richer action surface (e.g. `act` /
  `extract` / `observe`). Our `extract` action is the same idea.
- **AgentE / OpenAdapt / WebAgent**: small variations on the same
  ReAct + a11y snapshot recipe.

What this implementation specifically does NOT include and why:

- **Visual screenshot grounding.** Many production browser agents
  ship a visual modality alongside the a11y tree. The baseline is
  text-only on purpose: subsequent vision-first slots (if Ralph picks
  one) get a clean comparison point.
- **Skill library / scratchpad.** There is no inter-task memory; each
  trajectory starts cold.
- **Self-critique / multi-vote.** A single LLM turn per step. The
  baseline does the simplest thing that compiles; verifier-first or
  multi-sample agents (later slots) are the contrast.

## When the LLM is unavailable

`defaultClient()` reads `OPENAI_API_KEY` and `GEMINI_API_KEY` from the
environment. If neither is set, the first `llm.call` raises
`LLMProviderUnavailableError`; the agent catches that and finishes with
`terminal_state=DECLINED, decline_reason="no LLM provider configured"`.
The trajectory still completes cleanly — this satisfies the US-012
contract test and lets `make tournament` run without secrets in CI.

If the LLM is configured but a step's prompt is not in the cache and
the client is in `replay` mode, `LLMReplayMissError` similarly resolves
to `DECLINED`. This is the right behaviour for replaying a prior
tournament: a trajectory we never recorded cannot be reconstructed.

## Files

- `agent.ts` — the ReAct loop + Trajectory plumbing.
- `actions.ts` — strict action set + tolerant LLM-output parser +
  per-action browser dispatch.
- `snapshot.ts` — the in-page snapshot script + observation renderer.
- `manifest.yaml` — id/language/summary/approach_keywords/distinct_from.

## Testing

Unit tests cover the parser, snapshot rendering, and a fully-mocked
ReAct loop (`harness/ts/tests/baseline_agent.test.ts`). The contract
test (`tournament_contract.test.ts`) exercises the agent end-to-end on
a tiny `data:` URL with `LLMProviderUnavailableError` as the expected
no-LLM path. A real-LLM smoke run on the easy slice requires
`OPENAI_API_KEY`; trajectories from such a run land under `runs/`.
