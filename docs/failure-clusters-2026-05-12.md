# Failure clusters across all trajectories (2026-05-12)

Source: every `runs/<agent>/<task>/<seed>/verdict.json` + matching `trajectory.jsonl.gz`.
274 cells total (10 agents × variable task coverage). 93 failures.

## 1. Failures grouped by `terminal_state`

| terminal_state       | count | meaning |
|----------------------|-------|---------|
| `DECLINED`           |    82 | agent exhausted its step budget without claiming done |
| `DONE`               |     8 | agent claimed done but verifier disagreed (false-positive) |
| `BUDGET_EXCEEDED`    |     2 | token budget cap hit before completion |
| `DONE_BY_PREDICATE`  |     1 | predicate-driven loop's own predicate fired but verifier rejected |

**Headline**: 88% of failures (`DECLINED` + `DONE_BY_PREDICATE`) are *step-budget exhaustion with the agent stuck in a no-progress loop*, not "wrong answer". The substrate finishes; the policy doesn't recognise its own stagnation.

## 2. Failures grouped by task (≥3 agents fail)

| task                              | attempts | pass | pass-rate | tags                                         |
|-----------------------------------|---------:|-----:|----------:|-----------------------------------------------|
| `hard-canvas-drag`                |        9 |    0 |       0%  | canvas, pointer, geometry                    |
| `hard-iframe-drag`                |        9 |    0 |       0%  | iframe, cross-frame, drag                    |
| `hard-multi-tab`                  |        9 |    0 |       0%  | window.open, popup, postMessage              |
| `hard-conditional-form`           |        9 |    0 |       0%  | branching validation, server cross-check     |
| `hard-pdf-task`                   |        9 |    0 |       0%  | binary asset, PDF text extraction            |
| `hard-virtual-scroll`             |        8 |    1 |      13%  | virtualisation, off-screen items             |
| `easy-httpbin-form`               |        8 |    2 |      25%  | POST form, real server round-trip            |
| `hard-shadow-form`                |        9 |    3 |      33%  | open shadow DOM, hidden submit               |
| `hard-late-hydration`             |        9 |    3 |      33%  | timing, JS event handlers attached late      |
| `hard-modal-stack`                |        9 |    4 |      44%  | nested modals, state machine                 |
| `hard-recoverable`                |        9 |    6 |      67%  | flaky endpoint, retry                        |

Five tasks are **0-of-N across the entire roster**. These define the actual capability frontier.

## 3. Failure clusters by mechanism / step type

Patterns mined from the last actions of failed trajectories:

### Cluster A — Synthetic-event drag does not move native handlers
- Tasks: `hard-canvas-drag`, `hard-iframe-drag` (0/9 + 0/9 = 18 failures).
- Mechanism: every agent that has tried these emits `Runtime.evaluate` scripts that compute the right coordinates and either (a) call `canvas.dispatchEvent(new MouseEvent('mousedown'/...))` or (b) construct DataTransfer drag events. Neither triggers the canvas's internal hit-test loop (which listens to native pointer events) nor crosses an iframe boundary's drag protocol.
- Evidence: `runs/runtime-codegen/hard-canvas-drag/0/trajectory.jsonl.gz` — 12 steps of progressively-revised canvas scripts, all `ok:true`, none `done:true`. `runs/runtime-codegen/hard-iframe-drag/0/trajectory.jsonl.gz` — same shape across `srcIframe.contentDocument` → `dstIframe.contentDocument` event dispatches.
- Common root cause: the action substrate is in-page JS, not CDP `Input.dispatchMouseEvent`. The hardware-input layer is missing from every agent's vocabulary.

### Cluster B — Popup / new-window blindness
- Task: `hard-multi-tab` (0/9).
- Mechanism: page exposes "Open report" button that `window.open`s a child tab carrying the answer back via `window.opener.postMessage`. All nine agents see only their starting target; no agent enumerates `Target.targetCreated` or attaches to the popup target.
- Evidence: `runs/runtime-codegen/hard-multi-tab/0/trajectory.jsonl.gz` — agent retries `document.querySelector('button:contains("Open report")')` (jQuery-only selector syntax that returns null in standard DOM) for 12 steps and never reaches the popup.
- Common root cause: `BrowserSession` is a single-target abstraction. Even when the popup spawns, no agent has tooling to enumerate or switch context.

### Cluster C — Hidden server-side validation, no feedback channel
- Task: `hard-conditional-form` (0/9). Step-2 + step-4 fields validate against different regexes depending on prior choices, and the *server* cross-checks the path; the page surfaces no per-field error text until POST.
- Evidence: `runs/dom-mutation-stream/hard-conditional-form/0/trajectory.jsonl.gz` — 12 clicks on `aid=1` ("personal account type") with `mutation_delta` falling 13 → 3 → 0 → 0; the loop is *clearly stalled* yet the policy keeps issuing the same click.
- Common root cause: agents observe only the page; the validation rule lives on the server. Without an active probe-the-server-and-read-the-error step, the rule is invisible.

### Cluster D — Binary / out-of-band asset content is unreadable
- Task: `hard-pdf-task` (0/9). Page links to `/report.pdf` containing the answer.
- Evidence: `runs/runtime-codegen/hard-pdf-task/0/trajectory.jsonl.gz` — every step re-clicks `a[href="report.pdf"]`, navigation happens, page becomes a PDF viewer, and `document.body.innerText` returns nothing useful. No agent has a primitive to `fetch('/report.pdf')` and decode.
- Common root cause: action vocabulary is DOM-shaped. The PDF lives outside the DOM.

### Cluster E — Repeat-action stagnation (the meta-cluster)
Spans Clusters A–D, plus partial in C. Across `DECLINED` failures, the modal pattern is *the agent emits the same action 3+ times in a row with identical observation deltas, never noticing the loop*. Examples:
- `runs/runtime-codegen/hard-multi-tab/0/trajectory.jsonl.gz` — same `button:contains(...)` selector 12×.
- `runs/dom-mutation-stream/hard-conditional-form/0/trajectory.jsonl.gz` — `click(aid=1)` 12× after the second one produced `mutation_delta=0`.
- `runs/runtime-codegen/hard-pdf-task/0/trajectory.jsonl.gz` — `link.click()` 12× with identical pre/post observations.

No agent has a "no-progress" detector that triggers strategy change.

### Cluster F — `DONE` false-positives, hard-app slice
- Tasks: `hard-app-gitea-*` (3 of 8 false-positives), one each `hard-app-excalidraw-three-shapes`, `hard-app-gitea-new-issue`, etc.
- All on `click-first-link`: the trivial agent always reports `DONE` after one click; the verifier always rejects. Not a real mechanism failure — but it reveals that the harness records *agent-claimed terminal_state independently of verifier verdict*, which is the correct design.

### Cluster G — `BUDGET_EXCEEDED` on cheap easy tasks
- 2 instances: `vision-grounded` on `easy-rfc-791` and `easy-httpbin-form`.
- Cause: vision-grounded sends a fresh screenshot every step. RFCs are long → image is huge → token budget (50k tokens, easy tier) blown in 3 steps.
- Already steered against by `steeringNotes.deprioritizedAgents`. Not actionable beyond confirming the steering choice.

## 4. Cross-cuts

- **Substrate-bounded vs policy-bounded failure**: Clusters A, B, D are *substrate-bounded* — no amount of better prompting fixes them because the agent has no primitive to do the thing. Clusters C and E are *policy-bounded* — the substrate could express the right action; the loop policy doesn't.
- **Mechanism diversity is wide on easy slice (≥86% pass for 7 of 9 agents) but collapses on hard slice (only `runtime-codegen` clears half).** The hard slice is the discriminator.
- **No agent currently has any of**: hardware pointer events, multi-target enumeration, binary fetch, stagnation detection. Each is a single-mechanism gap visible from these traces.

## 5. Per-agent pass rates (for context)

| agent                  | easy        | hard       |
|------------------------|------------:|-----------:|
| dom-mutation-stream    | 22/22       | 2/10       |
| speculative-rollback   | 22/22       | 1/10       |
| network-shadow         | 21/22       | 3/10       |
| plan-then-execute      | 21/22       | 2/10       |
| runtime-codegen        | 21/22       | 5/10       |
| vision-grounded        | 20/22       | 0/10       |
| baseline-a11y-react    | 19/22       | (no runs)  |
| predicate-driven       | 18/22       | 2/10       |
| codegen-predicate      | (no easy)   | 2/9        |
| click-first-link       | (no easy)   | 0/19       |

`codegen-predicate` and `dom-shell` / `fs-memory` / `vision-som` have not yet been run on this corpus and are excluded here.
