# dom-mutation-stream

Seventh novel agent (US-020). The agent's primary observation is the
STREAM OF DOM MUTATIONS since the previous action — not the current
page state. No prior slot surfaces "what just changed" as the
first-class signal.

## Mechanism

```
install MutationObserver (on current doc AND every new doc)
    │
    └─► loop:
          ├─ read window.__gba_dom_log entries with seq > lastSeq
          ├─ snapshot current interactive elements (data-gba-stream-aid)
          ├─ LLM emits one of:
          │     click(aid)               ← primary substrate
          │     type(aid, text, submit?)
          │     scroll(direction, pixels?)
          │     wait(ms)
          │     await_change(timeout_ms) ← novel: block until DOM moves
          │     navigate(url)
          │     done(reason) | decline(reason)
          ├─ execute via Runtime.evaluate against the aid
          ├─ for state-changing actions: settleAfter() blocks IN-PAGE
          │   until log grows and quiesces (cap 400ms)
          └─ next turn's prompt shows the mutation delta
```

The observer is installed via TWO CDP paths used together:

1. `Page.addScriptToEvaluateOnNewDocument` — the renderer runs this
   before any in-document script for every document the browser
   creates after install (page navigations, popups). It catches the
   page's initial bursts of layout-driven mutations for subsequent
   navigations.
2. `Runtime.evaluate` against the current document — the harness has
   already navigated to `start_url` before `agent.run()` begins, so
   without this path the agent would miss any mutation that happens
   between initial paint and the agent's first action. The install
   is idempotent: a `window.__gba_dom_installed` guard short-circuits
   re-installs.

Every `childList`, `attribute`, and `characterData` mutation is
serialized as a small record (`{seq, t, kind, target, node?, attr?,
oldv?, newv?}`) and pushed onto a FIFO log capped at 200 entries. The
LLM sees the most recent 24 entries each step alongside the
interactive-element snapshot.

## Distinct from prior slots

Two orthogonal axes:

| Axis | This agent | Prior agents |
| --- | --- | --- |
| Observation | DOM mutation delta (this) | full DOM/a11y snapshot (baseline, plan-then-execute, runtime-codegen, predicate-driven, speculative-rollback), pixels (vision-grounded), network traffic (network-shadow) |
| Cadence primitive | `await_change(timeout_ms)` blocks until DOM moves; harness auto-settles after every state-changing action | every prior agent's timing is wall-clock: `wait(ms)` only |

`approach_keywords` are `[mutation_observer, dom_event_stream,
delta_observation, change_driven_loop, await_dom_change,
transition_aware]`. Jaccard overlap with every prior agent's keywords
is 0. The auto-discovery distinctness check
(`harness/ts/tournament/distinctness.ts`) passes by margin.

### Composition note (per US-020 AC #2)

The agent composes patterns from network-shadow and baseline:

- **From network-shadow**: install-via-`addScriptToEvaluateOnNewDocument`
  + `Runtime.evaluate` for the current document; idempotent
  window-flag guard; FIFO-capped log that the agent reads each turn.
- **From baseline**: aid-keyed action substrate
  (`data-gba-stream-aid`) — clicks and typed input reference stable
  integer ids in the page.

The COMPOSITION is novel because:

1. The signal axis is **deltas, not states** — the LLM reads "+ div
   added into form" / "~ button disabled: true → ∅" instead of
   re-deriving the change from a snapshot diff every turn.
2. The action primitive `await_change` makes the page itself the
   cadence source. No prior agent has a "block until something
   happens" primitive; they all gate on `wait(ms)` (wall-clock) or
   the LLM's own self-report.

## Why this mechanism is useful

The harness has six hard fixtures whose verifier success depends on a
TRANSITION the agent has to react to:

- `conditional-form` — the field set changes after step-1 selection;
  a delta-first view picks up the added/removed input nodes
  immediately rather than rescanning a 30-element snapshot.
- `late-hydration` — the click handler is initially a no-op and
  swaps to the real handler after `HYDRATION_DELAY_MS`. The swap is
  visible as an attribute mutation (the page sets
  `data-hydrated="true"`); a transition-aware loop can wait for that
  signal explicitly via `await_change`.
- `modal-stack` — each click advances an FSM that adds/removes a
  modal subtree. The mutation log shows each step as one or two
  `+ div` / `- div` entries — much terser than diffing snapshots.
- `recoverable` — the first submit returns 500 and the page
  re-enables the button + flashes a banner. The button's `disabled`
  attribute flip and the banner-add show up as two mutation entries
  in the next slice.
- `virtual-scroll` — row visibility flips on scroll; the mutation
  log carries the `+ tr / - tr` deltas without the agent having to
  re-walk the DOM.
- `shadow-form` — content shadow-attached after a click triggers a
  `childList` mutation (the shadow host's `attachShadow` creates a
  new shadow root, and visible content gets `<slot>`-attached).

`canvas-drag` and `iframe-drag` are out of reach by construction:
canvas mutations don't fire MutationObserver, and cross-origin
iframes are opaque to the parent observer.

## Failure modes addressed

From earlier agents' trajectories:

- `runs/baseline-a11y-react/hard-modal-stack/0/trajectory.jsonl.gz`:
  baseline keeps re-snapshotting and clicks the same aid twice
  because the snapshot diff isn't obvious to the LLM. A delta-first
  prompt makes "step-1 modal removed, step-2 modal added" the
  literal first line of the next observation.
- `runs/baseline-a11y-react/hard-late-hydration/0/trajectory.jsonl.gz`:
  baseline clicks before hydration finishes; the recoverable click
  isn't enough because the verifier asserts `clickedAt >=
  hydratedAt`. With `await_change`, the LLM can pause until the
  `data-hydrated="true"` attribute mutation lands, then click.
- `runs/plan-then-execute/hard-recoverable/0/trajectory.jsonl.gz`:
  p-t-e's batch plan submits twice, but the second submit fires
  before the page's banner-re-enable mutation processes. A
  delta-aware loop sees the banner add and the button
  re-enablement explicitly and the click lands cleanly.

## Cost shape

One LLM call per step. The mutation log is at most ~24 entries × ~120
chars per entry ≈ 2.5 KB per prompt. The snapshot is bounded at 50
interactive elements; combined prompt growth is modest. Settle delays
are gated at 400 ms and only fire after state-changing actions, so
wall-clock cost scales with the number of actions, not with snapshot
churn.

## Implementation

```
agents/dom-mutation-stream/
├── agent.ts       # Agent class + loop + message builder
├── actions.ts     # AgentAction union + tolerant parser + in-page executors
├── observer.ts    # MutationObserver install source + read/await/snapshot helpers
├── manifest.yaml  # id, approach_keywords, distinct_from
└── README.md      # this file
```

Default model `gpt-4o-mini`, temperature 0. Step cap 12. Declines
gracefully when no LLM provider is configured (contract test runs
without secrets).

## Prior art

The closest public analogue is the technique long used in QA
automation of subscribing to `MutationObserver` to know "when the
SPA is done re-rendering" before issuing the next action. What is
novel here is treating that signal as **the agent's PRIMARY
observation** rather than a synchronization aid:

- Public 2026 agent frameworks (browser-use, Stagehand, AgentE,
  Operator, WebVoyager) all model the page as a sequence of
  **states** (snapshot or screenshot) and re-derive what changed
  via diffing. The mutation observer is at best used for
  "wait-for-stability."
- This agent inverts the relationship: deltas are the signal,
  snapshots are the secondary index. Combined with `await_change`
  (block-on-document-moved), turn cadence is gated by the page
  itself, not by wall-clock heuristics.

Trade-off: the agent depends on the page driving its state changes
through the DOM. Pure-canvas fixtures (canvas-drag) emit no
mutations on internal redraws; cross-origin iframes are opaque. The
mechanism shines exactly where prior agents struggled (transitions
with timing or FSM semantics) and fails exactly where prior agents
failed for substrate reasons.
