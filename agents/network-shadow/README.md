# network-shadow

Sixth novel agent (US-019). API-first browser agent: treat the page as
the surface of an HTTP API, observe its traffic with DevTools-style
introspection, and prefer direct same-origin `fetch` calls over UI
interaction.

## Mechanism

```
install fetch+XHR monkey-patch (on current document AND every new document)
    │
    └─► loop:
          ├─ read window.__gba_net_log (recent traffic)
          ├─ observe page (URL + title + forms + visible buttons + text)
          ├─ LLM picks one action:
          │     fetch(method, url, body?, content_type?)    ← primary
          │     click(selector)                             ← fallback trigger
          │     navigate(url)                               ← change document
          │     wait(ms)                                    ← let async land
          │     done(reason) | decline(reason)
          ├─ execute (fetch runs IN-PAGE so cookies+origin are preserved)
          └─ record the response sample; next step's prompt sees it
```

The patch is installed via TWO CDP paths used together:

1. `Page.addScriptToEvaluateOnNewDocument` — the renderer runs this
   before any in-document script for every future navigation (including
   popups). This captures the page's initial-load traffic for
   subsequent navigations.
2. `Runtime.evaluate` against the current document — the harness has
   already navigated to `start_url` before `agent.run()` begins, so
   without this path the agent would miss any deferred fetch on the
   first page. The patch is idempotent (a `window.__gba_net_installed`
   guard).

Every `fetch` or `XMLHttpRequest` (the page's OR the agent's) is
appended to a capped FIFO log on `window.__gba_net_log` with method,
URL, request body, response status, and the first ~600 chars of the
response body. The LLM sees the most recent 12 entries each step.

## Distinct from prior slots

Two orthogonal axes:

| Axis | This agent | Prior agents |
| --- | --- | --- |
| Observation | network traffic log | DOM/a11y (baseline, p-t-e, srb, predicate-driven), raw text + counts (runtime-codegen), pixels (vision-grounded) |
| Action substrate | HTTP requests via in-page fetch | aids (baseline), text selectors (p-t-e), raw JS bodies (runtime-codegen), CSS selectors (srb, predicate-driven), pixel coords (vision-grounded) |

`approach_keywords` are
`[network_introspection, api_first, http_actions, traffic_logging,
request_replay, fetch_xhr_monkeypatch]`. Jaccard overlap with every
prior agent's keywords is 0. The auto-discovery distinctness check
(`harness/ts/tournament/distinctness.ts`) passes by margin.

## Why this mechanism is useful

A lot of the harness's hard fixtures terminate at a server endpoint:

- `shadow-form` posts JSON to `/__shadow/submit`. The shadow DOM only
  matters for the agent that has to navigate the form via the UI; an
  agent that POSTs the JSON directly bypasses the shadow root entirely.
- `conditional-form` posts the entire branching path to
  `/__conditional/submit`. The cross-validation runs server-side
  against the goal; an agent that composes the right JSON body wins
  without filling in any of the conditional steps.
- `multi-tab` works only because the popup fetches a token-scoped code
  from `/__multitab/report` and posts it back via `window.opener`.
  Both endpoints are same-origin; the agent can fetch the code itself.
- `recoverable` returns 500 on the first POST to
  `/__recoverable/submit`, 200 after. The agent's loop just retries.
- `pdf-task` requires parsing a PDF served at `/report.pdf`. The
  agent can fetch the bytes and regex-extract the answer.

`canvas-drag` and `iframe-drag` are pure client-side fixtures (verifier
checks `window.__test`, not a server endpoint) so the API-first
mechanism cannot help — those will need substrate (synthetic mouse
events) the agent does not have. The README of `runtime-codegen`
already covers that branch of the design space.

## Failure modes addressed

From earlier agents' trajectories:

- `runs/baseline-a11y-react/hard-shadow-form/0/trajectory.jsonl.gz`:
  baseline's a11y snapshot does not descend into shadow roots so the
  form's inputs are invisible. The agent emits clicks at the wrong
  level and times out.
- `runs/plan-then-execute/hard-conditional-form/0/trajectory.jsonl.gz`:
  plan-then-execute's batch plan does not adapt to which conditional
  fields actually appear after a step-1 selection; it submits an
  empty step-2 path.
- `runs/speculative-rollback/hard-multi-tab/0/trajectory.jsonl.gz`:
  the popup window opens a new target the CDP session is not attached
  to, so neither proposer nor judge sees the code; the judge keeps
  reverting because the parent never receives a postMessage.

The network-shadow agent attacks all three by observing or issuing the
underlying HTTP requests instead of the UI choreography.

## Cost shape

One LLM call per step. The prompt is dominated by the system prompt
(constant, OpenAI prompt-cache friendly) plus the network-log tail.
Each request the agent issues adds at most ~600 chars to the log; a
12-entry tail caps prompt growth. The action layer's `fetch` calls are
cheap (no LLM per execution), so step count is the binding budget axis.

## Implementation

```
agents/network-shadow/
├── agent.ts       # Agent class + loop + message builder
├── actions.ts     # AgentAction union + tolerant parser + in-page executors
├── network.ts     # Monkey-patch source + install/read/clear helpers
├── observe.ts     # Page summary (URL/title/text/forms/buttons)
├── manifest.yaml  # id, approach_keywords, distinct_from
└── README.md      # this file
```

Default model `gpt-4o-mini`. Step cap 12 — typical winning runs need
2–6 steps because each `fetch` makes immediate, observable progress.
Declines gracefully when no LLM provider is configured (contract test
runs without secrets).

## Prior art

The closest public analogue is **HTTP-replay testing** (mitmproxy,
HAR-replay) and the technique long used by web-scrapers of inspecting
DevTools' Network panel to find the underlying JSON endpoint behind a
page. What is novel here is treating that surface as the **agent's
primary action layer** rather than as a debugging aid:

- The dominant 2026 agent frameworks (browser-use, Stagehand, AgentE,
  Operator, WebVoyager, SeeAct, AppAgent) all model the page as a
  *visual or structural* surface; their action sets are click/type/
  navigate, not "POST /api/submit." The two we are aware of that touch
  network at all (AgentBench's HTTPAgent toy and PaSS-Net research
  prototypes) are narrowly API-only with no UI fallback.
- Compared to a pure REST-client agent: this one keeps a UI fallback
  (`click(selector)`) so a page whose endpoint is not visible can still
  be progressed by triggering the page's own JS — the request becomes
  visible in the log after the click and the next turn can replay or
  manipulate it.

Trade-off: the agent depends on endpoints being same-origin and
non-protected. CSRF-token-gated forms, cross-origin iframes, or pages
whose only success signal is a `window.__test` mutation (canvas-drag,
iframe-drag) are out of reach by construction. We document those
failures rather than papering over them with a UI driver.
