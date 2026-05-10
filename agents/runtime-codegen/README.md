# runtime-codegen

Second novel slot (US-015). Where prior agents pick from a fixed vocabulary
of JSON actions, this one writes the *code* that interacts with the page.
Each turn the LLM emits the body of an `async () => { ... }` function; the
harness wraps it in an IIFE and runs it through CDP `Runtime.evaluate`. The
body returns a small status object the agent loop reads.

## Mechanism

```
loop until done or maxSteps:
  observation = observePage(browser)           # url, title, text, structural counts
  body        = LLM(goal, history, observation) # raw JS, no vocabulary
  result      = browser.evaluate(`(async () => { try { ${body} } catch (e) { return {__error:e.message}; } })()`)
  record step
  if result.done: finish DONE
  if result.navigate: browser.navigate(result.navigate)
  sleep(result.sleep_ms)
```

The body's return type is the contract:

```js
return { done: true,  message: "<why goal is met>" };
return { done: false, message: "<short progress note>" };
return { done: false, navigate: "https://...", message: "..." };
return { done: false, sleep_ms: 500, message: "..." };
```

That's the whole API. The body can do anything you can do from page JS:

- `document.querySelectorAll('button')` with array filtering
- `host.shadowRoot.querySelector(...)` — pierces the open shadow DOM
- `iframe.contentDocument.querySelector(...)` for same-origin iframes
- `el.dispatchEvent(new MouseEvent('mousedown', {clientX, clientY, bubbles:true}))`
  for synthetic drag on canvas
- `await fetch('/api/...', {method:'POST', body:...})` for SPA APIs
- `await new Promise(r => setTimeout(r, ms))` for in-page waits

In-page exceptions are caught inside the IIFE and returned as
`{__error: "msg", __stack: "..."}`. The agent normalises that to a
fail-result and feeds it back to the LLM as the next observation — one
bad script gets one self-correcting retry before tripping the step
budget.

## Why this is distinct from prior agents

| Slot                  | Action layer                                  | Selector vocabulary             |
|-----------------------|-----------------------------------------------|---------------------------------|
| baseline-a11y-react   | fixed JSON action set (click/type/scroll/...) | `data-gba-aid` integers         |
| plan-then-execute     | fixed JSON action set, batched as a plan      | visible text (link/button copy) |
| **runtime-codegen**   | **the LLM writes the code**                   | **N/A — body picks**            |

Jaccard overlap of approach keywords vs the existing two agents is 0;
the `distinct_from: [baseline-a11y-react, plan-then-execute]` claim is
enforced by `harness/ts/tournament/distinctness.ts` at discovery time
and re-asserted by a unit test.

## What this should be good at

- **Shadow DOM.** Direct `shadowRoot.querySelector` traversal — the hard
  shadow-form fixture should be reachable.
- **Canvas drag.** Synthetic mouse events at arbitrary coordinates can
  drive the canvas-drag fixture (`mousedown` → `mousemove` → `mouseup`).
- **Same-origin iframes.** `contentDocument` traversal makes the
  iframe-drag fixture's mousedown+mouseup relay reachable.
- **Conditional forms.** The LLM can observe field state, fill the
  branch-determining field, re-observe via a second turn, then fill the
  remaining fields conditionally.
- **Recoverable failure.** The LLM can write `await fetch('/__submit')`
  in a retry loop directly inside the body, or click-retry-click across
  turns.
- **PDFs / binary blobs.** Same trick as the hand-crafted cheat: emit
  `const r = await fetch('/report.pdf'); const t = await r.text();`
  then regex-extract from `t`.

## What this is bad at

- **Late hydration.** The LLM has no built-in "wait for hydration"
  primitive. The system prompt suggests `sleep_ms` and the agent obeys,
  but the LLM has to remember to use it.
- **Multi-tab popups.** `window.open()` runs in a new CDP target the
  `CdpBrowserSession` does not attach to. Even an inline script body
  cannot script the popup.
- **Verbose pages.** The observation is structural counts + a 1500-char
  text excerpt; pages with thousands of elements only get the high-level
  counts. The LLM has to be probabilistic about selectors.
- **Long scripts.** The prompt asks for ~20-line bodies. A complex
  multi-step interaction has to be spread over multiple turns.

## Files

- `agent.ts` — the loop + Trajectory plumbing.
- `codegen.ts` — extract-script, wrap-body, run + normalise EmitResult.
- `observe.ts` — in-page structural observation + text renderer.
- `manifest.yaml` — id/language/summary/approach_keywords/distinct_from.

## Comparable prior art

The LLM-emits-JavaScript pattern shows up in several research and
production systems, with different trade-offs:

- **Code-as-policies (Liang et al., 2022)** — robot agents that emit
  Python policies. Same mechanism (code IS the action), different domain.
- **Adept-style web agents (closed-source ACT-1)** — emit Selenium-style
  code (`click(selector)`); our variant goes a step further and emits
  raw JS that runs *inside* the page rather than over the WebDriver
  protocol from the outside.
- **OpenInterpreter** and notebook-driven LLM agents — emit Python that
  runs in a host shell. Our analogue lives entirely in a browser tab.

What this agent specifically does NOT include and why:

- **No skill library.** Each turn starts cold. A skill library is a
  natural follow-up slot.
- **No multi-step planning.** plan-then-execute already owns that point
  in the design space; we are the no-planning extreme by contrast.
- **No vision.** Observation is structural + text. A vision-first slot
  is another natural follow-up.

## When the LLM is unavailable

Same convention as the baseline: `LLMProviderUnavailableError` resolves
to `DECLINED, "no LLM provider configured"`. `LLMReplayMissError`
resolves to `DECLINED, "LLM replay miss: ..."`. The contract test
exercises both paths.

## Testing

- `harness/ts/tests/runtime_codegen_agent.test.ts` covers
  `extractScript` tolerance, `wrapBody` shape, `normaliseResult` edge
  cases, an end-to-end script that clicks a button, an end-to-end
  script that pierces a shadow root, a parse-error path, a no-LLM
  decline, a tight-budget short-circuit, a script that returns
  `{__error}`, and the manifest-distinctness assertion against both
  baseline-a11y-react and plan-then-execute.
- The repo-wide contract test
  (`harness/ts/tests/tournament_contract.test.ts`) exercises the agent
  end-to-end on a tiny `data:` URL via discovery; the no-LLM path is
  the expected `DECLINED` reason.
