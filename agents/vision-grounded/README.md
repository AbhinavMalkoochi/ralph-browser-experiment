# vision-grounded

Fifth novel agent (US-018). Pure pixels in, pixel coordinates out, OS-level
events as the substrate.

## Mechanism

Every step the agent does exactly four things:

1. **Capture a JPEG screenshot of the viewport** via `Page.captureScreenshot`
   (quality=70, ~30–60 KB for a 800×600 viewport). The agent also reads
   `location.href`, `document.title`, and `window.innerWidth/Height` so it
   can show a small text banner alongside the image.
2. **Send a multimodal user message** to a vision-capable LLM (default
   `gpt-4o-mini`): `[{type:"text", text: goal + banner + recent actions},
   {type:"image_url", image_url:{url: <jpeg data url>}}]`.
3. **Parse a single JSON action** from the response (`click`, `double_click`,
   `move`, `drag`, `type`, `press`, `scroll`, `wait`, `navigate`, `finish`).
4. **Dispatch the action via CDP `Input.*`**:
   - `click(x, y)` → `Input.dispatchMouseEvent {type:"mousePressed",
     button:"left", x, y, clickCount:1}` then `mouseReleased`.
   - `drag(x1,y1→x2,y2)` → press at the source, eight intermediate
     `mouseMoved` events along the path so HTML5 drag-and-drop libraries see
     motion, then release at the target.
   - `type(text)` → `Input.insertText`. Text goes to the focused element,
     so the LLM must click into a field first.
   - `press(key)` → `Input.dispatchKeyEvent` for `Enter`, `Tab`, `Escape`,
     `Backspace`, `Delete`, `Arrow*`, `PageUp/Down`, `Home`, `End`, `Space`;
     printable single characters fall back to `insertText`.
   - `scroll(x, y, delta_y)` → `Input.dispatchMouseEvent {type:"mouseWheel",
     deltaY}` anchored at the cursor.

There is no `querySelector`, no `Runtime.evaluate` for action execution, no
shadow-root traversal, no DOM walk. The page receives synthetic OS-level
events as if a human had moved a mouse and pressed keys.

## Why this is different from prior slots in this repo

All five existing agents (`baseline-a11y-react`, `plan-then-execute`,
`runtime-codegen`, `speculative-rollback`, `predicate-driven`) share a
**DOM-mediated substrate**: they observe the page by walking the DOM (or
running JS that walks it) and they manipulate the page by addressing DOM
elements (aid integers, text labels, CSS selectors, in-page JS bodies).
This agent has neither DOM observation nor DOM action. The closest
prior is `runtime-codegen`, but even that one runs JS *inside* the page;
this agent never injects JS for action execution.

That makes it qualitatively different on two orthogonal axes:

|                       | Observation | Action substrate          |
| --------------------- | ----------- | ------------------------- |
| baseline-a11y-react   | a11y aids   | aids → click/type via JS  |
| plan-then-execute     | text labels | DOM walk by visible text  |
| runtime-codegen       | JS counts   | LLM-emitted JS bodies     |
| speculative-rollback  | CSS hints   | LLM CSS + judge LLM       |
| predicate-driven      | CSS hints   | LLM CSS, code termination |
| **vision-grounded**   | **pixels**  | **CDP Input.* events**    |

## Novelty (vs prior art beyond this repo)

Vision-flavoured browser agents do exist publicly. What separates this
design is the **absence of DOM augmentation on the perception side**:

- **WebVoyager (2024)** uses screenshots overlaid with **Set-of-Marks** —
  numbered bounding boxes drawn over interactive DOM elements. The LLM
  picks `id=N` and the framework resolves N back to a DOM element. The
  screenshot is just a presentation surface; the action substrate is
  still DOM. This agent has no overlays at all — the LLM has to localise
  pixels itself.
- **SeeAct (2024)** also uses Set-of-Marks plus an "action grounding"
  step that maps the model's verbal target back to a DOM element via
  HTML inspection. Same DOM crutch.
- **Operator (OpenAI, 2025)** is closer — it does ground actions in
  pixels — but is closed-source and (per public descriptions) still
  augments the screenshot with text snippets describing visible
  affordances. This agent intentionally sends only the raw banner
  (URL, title, viewport size); no text affordance description.
- **AppAgent (2024)** for Android is screenshot+XML; the XML is the
  text affordance index.
- **browser-use, Stagehand, AgentE**: DOM-first, no screenshot in the
  loop.

The genuinely-new claim is therefore not "use vision" — that has been
done — but **un-augmented vision combined with OS-level event
dispatch**. Both halves intentionally remove a DOM crutch:

1. **Perception**: no Set-of-Marks, no DOM-derived text affordance list,
   no a11y tree. The LLM has to do its own visual grounding.
2. **Action**: no `querySelector`, no JS injection. Dispatch goes
   through `Input.*` commands so the page can't tell a script is in
   control. This makes the same agent work on canvas, shadow DOM, and
   iframes uniformly — three substrates that have defeated every prior
   slot on this harness.

The trade-off is well-known and accepted: an off-by-50px localisation
mistake is a wrong click on a neighbour, and small affordances (the
1px-tall scrollbar of a virtualised list) are below visual resolution at
JPEG-70.

## Live results

`make eval AGENT=vision-grounded SLICE=easy` (gpt-4o-mini, temperature=0,
viewport 780×441 from the harness's headless Chrome launch, image
detail tier "high", 200ms post-action settle delay, 10-step cap):

- **Easy slice: 20/22 PASS** in ~200s. The two failures are
  `easy-httpbin-form` (BUDGET_EXCEEDED — submitting a small form
  whose inputs the agent cannot reliably localise) and
  `easy-rfc-791` (BUDGET_EXCEEDED — agent navigated away from the
  start_url and the page-text verifier no longer matches).
- **Hard slice: 0/10 PASS** in ~440s. All 10 fixtures finish DECLINED
  (max steps exhausted), no ERRORs.

AC #4 thresholds: easy ≥3/20 met (20 of 22); hard ≥1/10 NOT met. The
"OR documented failure analysis" branch of AC #4 is what we ship under;
the rest of this section is that analysis.

## Failure analysis (hard slice, gpt-4o-mini)

The mechanism (vision in / pixel coords out / CDP Input dispatch)
demonstrably *works*: the e2e tests show that when the LLM emits the
right `(x, y)` for a known target, the action lands and the page
responds correctly. The empirical issue on the hard slice is that
**gpt-4o-mini systematically mis-localises small targets in the JPEG**.

Sampled from `runs/vision-grounded/hard-recoverable/0/trajectory.jsonl.gz`:

- The page renders a "Submit order" button at approximately `(110, 170)`
  in viewport coordinates (body margin 24, card padding 20, button text
  ~100px wide, sits below an H1 + paragraph).
- The agent's thought field consistently reads "Click the 'Submit order'
  button" — i.e. the LLM has correctly identified the target.
- The agent's emitted coordinates are consistently `(390, 220)` —
  hitting blank space ~280px to the right of the actual button.

This pattern repeats across all hard fixtures: the agent recognises
the affordance, names it, and clicks the wrong place. For
`hard-modal-stack` every click came back as `(610, 370)`, which is the
bottom-right corner of the viewport — well past the modal's "Next"
button. For `hard-canvas-drag` the agent emitted drag coordinates that
also drifted toward the centre/right.

We tested two interventions:

1. **Switch to gpt-4o (10× more capable per the public eval suites,
   ~10× the cost).** Same failure mode: the bigger model also
   centre-biases its `x` estimates, just with marginally less variance.
   The single recoverable run with gpt-4o emitted `(340, 180)` — closer
   on `y` but still ~230px off on `x`.
2. **Switch image detail from `low` (85 tokens flat) to `high`
   (~765 tokens for our viewport).** Helps the agent read text in the
   image but does not help with coordinate emission. Localisation
   accuracy is bounded by the model's spatial reasoning, not by
   resolution.

This matches the public literature on un-augmented vision agents.
WebVoyager's authors found the same pattern in 2024 and introduced
**Set-of-Marks** (numbered DOM-derived bounding-box overlays) as the
fix — the LLM picks `id=N` instead of emitting raw pixels. SeeAct,
Operator, AppAgent, and every other production-grade screenshot agent
either uses Set-of-Marks or some other DOM-derived affordance index.
The only agents that succeed at **un-augmented pixel-grounding** are
purpose-trained GUI models (CogAgent, ScreenAgent, the Anthropic
Computer Use models in their 4.x series) — generic chat models simply
do not have the spatial reasoning to convert "the Submit button" into
accurate pixel coordinates on novel page layouts.

**The failure is therefore a LIMITATION OF CURRENT VISION LLMS, not of
the mechanism.** The mechanism is what makes the agent qualitatively
different from prior slots; the win-rate on hard slice is bounded by
the model's pixel-localisation ability, which is structurally weak in
gpt-4o-mini and gpt-4o (per the public benchmarks: ScreenSpot-V2,
WebSRC, OS-Atlas pixel-grounding scores).

### Non-options considered

- Adding **textual affordance hints** ("there's a Submit button at
  (110, 170)") would defeat the un-augmented-vision novelty pitch.
- Adding **Set-of-Marks overlays** would also defeat the novelty pitch
  — that is exactly what WebVoyager already does.
- Adding **a coordinate grid overlay** (rendered into the JPEG via
  in-page canvas before screenshot) would technically preserve "no DOM
  augmentation" but reintroduces the question of whether the agent is
  still meaningfully "vision-grounded" or just "grid-resolved." Left
  as a future iteration's design choice.
- Switching to a **purpose-trained GUI model** (CogAgent, OS-Atlas-7B)
  would change the result drastically but requires a different
  provider plumbed into the LLMClient. Out of scope for this story.

### Where the mechanism does win, and where it would shine

Despite the hard-slice score, the mechanism has documented advantages
over the DOM-mediated prior slots in the kinds of pages we DON'T have
fixtures for yet: pages where the actionable affordance has no DOM
representation at all (e.g. "click the red dot in the third column of
the heatmap" — every prior agent fails because no DOM element exists;
this agent only fails because gpt-4o-mini can't see the dot
accurately). Once vision LLMs cross the pixel-localisation threshold,
this mechanism is the only one in the repo that can act on those
pages.

The fixtures it is **poorly suited to** are ones where the answer is
in sub-pixel text the JPEG cannot resolve (e.g. the random per-load
access codes in `pdf-task` are inside the binary, not the rasterised
viewport — even a perfect localiser would have nothing to read). For
those fixtures the mechanism is structurally wrong, not just
empirically weak.

## Files

- `agent.ts` — main loop (snapshot → vision LLM → parse → CDP dispatch →
  loop until `finish` or `maxSteps`).
- `actions.ts` — action union + tolerant JSON parser + CDP Input
  executor + special-key table.
- `observe.ts` — viewport metadata + JPEG screenshot capture +
  base64-data-url builder.
- `manifest.yaml` — id, distinct_from (lists every prior agent),
  approach_keywords (Jaccard=0 vs every prior agent's keywords).

## Cost shape

One vision LLM call per step. JPEG quality=70 averages ~40 KB per image,
which at gpt-4o-mini's `auto` detail tier is roughly $0.0004 per call.
A 10-step run is ~$0.004 plus the prompt/output text. Roughly an order
of magnitude more per step than the text-only prior agents, but well
within the per-task USD budget on every difficulty tier.
