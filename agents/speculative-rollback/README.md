# speculative-rollback

Third novel agent slot (US-016). Treats every action as a **speculative
trial**: take a state snapshot, execute a candidate action, ask a second
LLM whether the resulting state is closer to the goal, and revert the
action when the judge says it regressed. The agent's core loop is shaped
by the **commit-or-revert** decision, not by the action substrate.

## Loop

Per step (capped at `maxSteps`, default 10):

1. **Observe + snapshot.** The agent reads the page (URL, title, visible
   text, button/input lists with selector hints — see `observe.ts`) and
   captures a client-side state snapshot (URL + localStorage +
   sessionStorage — see `snapshot.ts`).
2. **Propose.** One LLM call (the *proposer*) returns up to K=2 candidate
   actions, ordered most promising first, in a JSON envelope.
3. **Try the top candidate.** Execute it (CSS-selector-keyed click/type,
   plus scroll/wait/navigate/finish). The action result message is
   recorded in the trajectory.
4. **Judge.** A second LLM call (the *judge*) classifies the post-action
   state vs the pre-action state as `commit` (progress), `revert`
   (regress/no-op), or `done` (goal reached).
5. **Branch.**
   - On `done`, finish the trajectory `DONE`.
   - On `commit`, keep the new state and let the outer loop re-enter.
   - On `revert`, restore the snapshot (clear+rewrite local/sessionStorage,
     then navigate back to the snapshot URL), add the candidate's label
     to a **blacklist**, and try the next candidate.
6. If every candidate from a propose call is reverted, the loop re-enters
   with the blacklist surfaced to the next proposer turn, forcing it to
   pick a different approach.

## Distinct mechanism

| Slot | Loop shape | Action substrate | Has rollback? |
| --- | --- | --- | --- |
| baseline-a11y-react | per-step ReAct, single LLM call | integer aids | no |
| plan-then-execute | one batched plan, repair on hard-fail | visible text | no |
| runtime-codegen | per-step LLM emits raw JS | LLM-authored code | no |
| **speculative-rollback** | **propose-K → execute → judge → commit-or-revert** | **CSS selectors** | **yes** |

The three prior agents never **abandon a misstep**: baseline takes the
next action regardless of the last one's outcome; plan-then-execute
repairs forward; runtime-codegen self-corrects via the next observation
but cannot undo a click. speculative-rollback explicitly snapshots a
state, decides post-hoc whether to keep the change, and reverts when the
judge disagrees.

## Limitations the substrate exposes

State restoration is client-side only:

- **Server-side side effects are not undone.** If a candidate action
  POSTed `/__submit`, the server has already recorded the submission;
  reverting only resets the page URL and the storage entries. The judge
  may still classify the action as a regress (e.g. if the page now shows
  an error banner) and the blacklist prevents repeating it, but the
  underlying mutation sticks.
- **HttpOnly cookies are not captured.** `document.cookie` cannot read
  them and we deliberately stay inside the page's JS sandbox. Same-origin
  HTTP-only sessions therefore drift across a revert.
- **Cross-origin storage does not transfer.** If an action navigates
  cross-origin, the restoration's storage write applies to the wrong
  origin. Navigation back to the original URL still works, but storage
  is not restored on the destination.

These are accepted trade-offs of running the snapshot/restore from
inside the page rather than via Network.* CDP methods. The mechanism's
value comes from the **decision loop**, not from cryptographically
exact rollback.

## Cost

Each *attempted* candidate costs two LLM calls (proposer + judge). With
K=2 candidates per step and worst-case revert on the first, a single
step is up to 3 LLM calls; an `n`-step run with no reverts costs `2n`
calls. The default `gpt-4o-mini` model keeps a 10-step hard-slice run
well under the $3 budget.

## Files

| File | Purpose |
| --- | --- |
| `agent.ts` | Main loop (propose → execute → judge → commit-or-revert) |
| `actions.ts` | CSS-selector action set + tolerant JSON parser |
| `observe.ts` | Page observation with selector hints for the proposer |
| `snapshot.ts` | URL + local/sessionStorage capture and restore |
| `manifest.yaml` | Distinctness contract + approach keywords |

## Live results (gpt-4o-mini)

- **Easy slice**: 22/22 PASS. Most easy tasks are content-extraction over
  well-known public pages; the runner pre-navigates and many tasks pass on
  the initial observation alone. The interactive tasks (httpbin form, search)
  are reached via the proposer's CSS selectors + judge's commit verdict.
- **Hard slice**: 1/10 PASS (`hard-recoverable`). The single pass exercises
  the mechanism end-to-end: the first submit returns 500 with a visible
  error banner; the judge classifies that state as `revert`; the proposer's
  next candidate retries the submit and lands on the 200 path.

The nine hard failures fall into mechanism-bound categories the agent's
CSS-selector action substrate cannot reach: shadow DOM (`shadow-form`),
canvas pixel coordinates (`canvas-drag`), cross-frame drag (`iframe-drag`),
sustained scrolling past 200 rows (`virtual-scroll`), and binary PDF
parsing (`pdf-task`). Other failures (`modal-stack`, `conditional-form`,
`late-hydration`, `multi-tab`) need either deeper page-state observation
or popup target attachment that the harness's per-task CdpBrowserSession
does not expose. The judge correctly identified regresses (e.g. clicking
into the wrong modal path resets the state machine to `aborted`); the
proposer simply ran out of CSS-selector approaches that could advance.

These are limits of the substrate, not of the speculative-rollback loop —
the same mechanism over a richer action set (e.g. emitted JS bodies like
`runtime-codegen`) would in principle inherit the rollback discipline
without giving up shadow/canvas/iframe reach.
