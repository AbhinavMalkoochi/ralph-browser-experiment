# vision-som

US-031. Successor to **vision-grounded** (US-018) with the canonical
**Set-of-Marks** fix used by WebVoyager / SeeAct / Operator.

## Mechanism

Per step the agent does four things:

1. **Walk the DOM** in-page (`Runtime.evaluate`) to find every visible
   interactive element whose bounding box intersects the viewport. Each
   gets a fresh integer mark id `1..N` and a `data-gba-som-id="<N>"`
   attribute. An overlay `<div id="__gba_som_overlay">` is appended to
   `<body>`, containing one absolutely-positioned outline rect + one
   numbered label per mark (palette of 10 colours so adjacent marks are
   distinguishable).
2. **Capture a JPEG screenshot of the viewport** via
   `Page.captureScreenshot`. The overlay is then torn down so the live
   page stays clean for the next CDP action.
3. **Send a multimodal user message** to the vision LLM (default
   `gpt-4o-mini`) with the annotated screenshot AND a small text mark
   table (`[N] role "name" bbox=x,y,wxh`). The mark table redundancy is
   intentional: it lets the LLM disambiguate when overlay labels overlap.
4. **Translate one action verb** back to a CDP `Input.*` event dispatched
   at the centre of the marked element's recomputed bounding box. The
   LLM never emits raw pixel coordinates — only a mark id.

Action set: `click(mark)`, `type(mark, text, submit?)`,
`scroll(direction, pixels?)`, `wait(ms)`, `navigate(url)`, `done(reason)`,
`decline(reason)`.

## Why this is different from vision-grounded

The vision-grounded post-mortem
([agents/vision-grounded/README.md](../vision-grounded/README.md)) showed
two reproducible failure modes on the hard slice:

- `runs/vision-grounded/hard-recoverable/0/trajectory.jsonl.gz`: the LLM's
  `thought` consistently named "Click the 'Submit order' button" but it
  emitted `(390, 220)` against a button whose true centre was `(110, 170)`.
- `runs/vision-grounded/hard-modal-stack/0/trajectory.jsonl.gz`: every
  click came back as `(610, 370)` — a centre-bottom-right "default"
  position the model falls back to when uncertain.

Both are documented limitations of un-augmented chat-LLM pixel grounding
(also in the public ScreenSpot-V2 / WebSRC literature). Set-of-Marks
removes the failure mode entirely: the LLM only ever picks an INTEGER, so
"the Submit button" never has to round-trip through pixel arithmetic. The
harness owns the bbox → click translation.

## Distinctness vs prior slots

Observation modality and action substrate, vs every prior slot:

|                       | Observation              | Action substrate                  |
| --------------------- | ------------------------ | --------------------------------- |
| baseline-a11y-react   | a11y aids                | aids → click/type via JS          |
| plan-then-execute     | text labels              | text-keyed selectors              |
| runtime-codegen       | JS counts                | LLM-emitted JS bodies             |
| speculative-rollback  | CSS hints                | CSS selectors + judge LLM         |
| predicate-driven      | CSS hints                | CSS selectors + code termination  |
| vision-grounded       | raw pixels               | CDP Input at LLM-picked (x,y)     |
| network-shadow        | network traffic          | HTTP requests                     |
| dom-mutation-stream   | DOM mutations            | aid-keyed actions + await_change  |
| **vision-som**        | **annotated screenshot** | **CDP Input at mark bbox centre** |

The mechanism axis vs vision-grounded is the **localisation primitive**:
vision-grounded asked the LLM to localise pixels; vision-som asks the LLM
to pick an integer that already names a DOM element. Both still dispatch
via `Input.*` (so canvas/iframe/shadow rendering is uniform on the
action side), but the perception pipeline is now DOM-anchored.

## Cost shape

One vision LLM call per step (same as vision-grounded), plus two
`Runtime.evaluate` calls (collect+overlay, then teardown) and one
`Page.captureScreenshot`. JPEG quality=70 averages ~30–60 KB per
~800×600 viewport.

## Files

- `agent.ts` — main loop (collect+overlay → screenshot → vision LLM →
  parse → CDP dispatch → loop until `done`/`decline` or `maxSteps`).
- `actions.ts` — action union + tolerant JSON parser + CDP Input
  executor + special-key submit handling.
- `observe.ts` — DOM walk + overlay injection + screenshot capture +
  base64-data-url builder.
- `manifest.yaml` — id, distinct_from (lists every prior slot),
  approach_keywords (Jaccard=0 vs every prior agent's keywords).
