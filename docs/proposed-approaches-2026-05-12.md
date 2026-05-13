# Proposed new approaches mined from failure clusters (2026-05-12)

Companion to `docs/failure-clusters-2026-05-12.md`. Each approach below is grounded in a 0-of-N cluster from the trajectory corpus, names trajectory evidence by path, and proposes a mechanism whose `approach_keywords` are disjoint from every agent already in `agents/*/manifest.yaml`.

Existing keyword space (checked against; new approaches must avoid these):
> a11y_snapshot, react_loop, json_actions, click_first, composed_mechanism, codegen_action_substrate, predicate_terminated_loop, mutation_observer, dom_event_stream, filesystem_metaphor, cwd_navigation, shell_command_substrate, filesystem_working_memory, on_disk_scratchpad, network_introspection, api_first, plan_then_execute, batch_planning, goal_predicate, predicate_loop, code_generation, in_page_runtime, runtime_evaluate, speculative_execution, state_snapshot_restore, dual_llm_judge, vision_grounded, screenshot_perception, pixel_coordinate_actions, set_of_marks, numbered_overlays, mark_id_actions.

---

## Approach 1 — CDP-pointer-stream drag primitive (hardware input substrate)

- **Motivating clusters / traces**:
  - Cluster A: `hard-canvas-drag` (0/9) and `hard-iframe-drag` (0/9).
  - `runs/runtime-codegen/hard-canvas-drag/0/trajectory.jsonl.gz` — 12 `Runtime.evaluate` scripts that compute the right canvas coordinates and `dispatchEvent(new MouseEvent('mousedown', ...))`, none of which engage the canvas' internal pointer-capture path.
  - `runs/runtime-codegen/hard-iframe-drag/0/trajectory.jsonl.gz` — same shape, with the additional handicap that synthesised DataTransfer drag events don't cross the iframe boundary.
- **Hypothesised mechanism**: Expose an action vocabulary of `pointer_down(x,y) / pointer_move(x,y) / pointer_up(x,y)` and a sugar `drag(fromCss|coord, toCss|coord, steps)`. Each compiles to a sequence of CDP `Input.dispatchMouseEvent` (and `Input.dispatchDragEvent` for OS-level drag) at the *browser-process* layer, bypassing the page's JS event-dispatch surface entirely. The LLM no longer authors event-construction JS; it issues coordinate-stream intents.
- **Falsifiable prediction**: With this primitive and the same backbone model as `runtime-codegen` (the current hard-slice leader at 5/10), pass-rate on `{hard-canvas-drag, hard-iframe-drag}` rises from 0/2 to ≥1/2 within the same 12-step budget. If both still fail at 0/2 after 3 seeds × 2 tasks, the hypothesis is rejected.
- **Slice / tag where this should beat the champion**: `hard` slice, `tag in {canvas, drag, iframe}`. Should NOT improve and may slightly degrade on `hard-shadow-form` / `hard-modal-stack` (no drag, more prompt tokens spent on a substrate the agent isn't using).
- **Distinct from existing**: Closest is `vision-grounded` (`cdp_input_events`, `pixel_coordinate_actions`) — but vision-grounded *infers* coordinates from a screenshot, which is the documented failure mode the steering note bans (centre-bias). This proposal *receives* coordinates from a DOM/getBoundingClientRect resolution step but still emits hardware events, so the mechanism is the substrate, not the perception.
- **Proposed `approach_keywords`**: `cdp_pointer_stream`, `synthetic_drag_primitive`, `hardware_input_substrate`, `coordinate_resolved_from_dom`, `os_level_drag`.

---

## Approach 2 — Multi-target window-graph perception

- **Motivating cluster / traces**:
  - Cluster B: `hard-multi-tab` (0/9).
  - `runs/runtime-codegen/hard-multi-tab/0/trajectory.jsonl.gz` — agent retries `document.querySelector('button:contains("Open report")')` (jQuery-only selector) 12× and never even spawns the popup, much less reads from it. Even agents that *do* click the Open-report button cannot observe the new tab because their `BrowserSession` is single-target.
- **Hypothesised mechanism**: Attach to CDP `Target.targetCreated` / `Target.targetDestroyed` at pool-acquire time; maintain a `TargetGraph` data structure (current tab, popup tabs, OOPIF subtrees, service workers). Expose observation primitives `list_targets()` and `switch_target(id)` plus action primitives `wait_for_new_target(timeout)`. The LLM sees a *graph* of pages, not one page.
- **Falsifiable prediction**: With identical model/prompt to `baseline-a11y-react` plus only this perception change, pass-rate on `hard-multi-tab` rises from 0/1 to ≥1/3 seeds. Additionally, on `hard-app-gitea-pr-comment` (which currently bleeds into popup-style auth flows) we should see ≥1 fewer DECLINED across the roster.
- **Slice / tag**: `hard` slice, tag `popup` / `window.open` / `multi_target`. Should be capability-neutral elsewhere.
- **Distinct from existing**: No agent has any target enumeration. Closest is `network-shadow` (`network_introspection`), but that observes HTTP traffic, not target lifecycle events. Different CDP domain (Target vs Network), different observable.
- **Proposed `approach_keywords`**: `multi_target_perception`, `target_graph`, `popup_aware`, `cdp_target_domain`, `cross_tab_observation`.

---

## Approach 3 — Adversarial probe-and-shrink for hidden server validation

- **Motivating cluster / traces**:
  - Cluster C: `hard-conditional-form` (0/9), partially Cluster E.
  - `runs/dom-mutation-stream/hard-conditional-form/0/trajectory.jsonl.gz` — `click(aid=1)` issued 12× with `mutation_delta` collapsing 13 → 3 → 0 → 0. The agent never *probes* the form (a deliberate-bad-submit) to read the server's error message back, because nothing in its loop says "when stuck, generate a probe".
  - Easy-slice corollary: `easy-httpbin-form` (2/8) — agents that succeed submit once; agents that fail submit and never read the response back.
- **Hypothesised mechanism**: A loop that, on detecting no observation delta after a click, switches mode to *probe*: deliberately submit a known-invalid value, capture the resulting server error text (DOM + response body if the page exposes it), and incorporate it as a constraint into the working set. The agent shrinks the hypothesis space by *eliciting* validation rules, not by inferring them.
- **Falsifiable prediction**: On `hard-conditional-form` over 3 seeds, pass-rate rises from 0/3 to ≥1/3. On `easy-httpbin-form` rises from 2/8 to ≥4/8 (because probe-mode forces the agent to read the submission echo). If neither improves, the hypothesis — that hidden-constraint failure is policy-bounded rather than substrate-bounded — is rejected.
- **Slice / tag**: hard `branching_validation`; easy `form_post`.
- **Distinct from existing**: `predicate-driven` synthesises an LLM-generated test for success but never authors a *probe* to learn from failure. `network-shadow` records traffic but doesn't actively perturb. The novelty is *deliberate adversarial perturbation as an observation-acquisition action*.
- **Proposed `approach_keywords`**: `adversarial_probe`, `server_error_oracle`, `constraint_inference`, `hypothesis_shrinking`, `deliberate_bad_submit`.

---

## Approach 4 — Out-of-band binary asset reader

- **Motivating cluster / traces**:
  - Cluster D: `hard-pdf-task` (0/9).
  - `runs/runtime-codegen/hard-pdf-task/0/trajectory.jsonl.gz` — every step re-clicks `a[href="report.pdf"]`, the navigation happens, the page is now a PDF viewer, `document.body.innerText` returns ≈nothing useful; the loop cannot read the PDF.
- **Hypothesised mechanism**: Action vocabulary gains `fetch_resource(url)` (returns `{contentType, bytes_base64, text_utf8?}` via `fetch().then(r => r.arrayBuffer())` evaluated in the page) and `extract_text_from_pdf(bytes_base64)` implemented in the harness with a minimal PDF text-stream parser (the fixture's PDF is a hand-rolled 5-object file whose text run is a literal string — no external dep needed for this fixture; for real-world coverage, ship a tiny pdfjs-in-worker). The LLM treats binary URLs as readable.
- **Falsifiable prediction**: `hard-pdf-task` rises from 0/3 seeds to ≥2/3. No regression on text-only easy slice (because the new primitive is opt-in). If the PDF extractor is wired and the agent still fails, the bug is in the *retrieval loop* not the substrate — falsifying the hypothesis.
- **Slice / tag**: hard `binary_asset` / `pdf` / `out_of_band`.
- **Distinct from existing**: `network-shadow` records URLs but doesn't decode binary content. `runtime-codegen` can `fetch()` from in-page JS but no agent has a binary→text primitive in its action vocabulary. The novelty is *the asset reader as a first-class action*, not a derived JS pattern the LLM must reinvent every prompt.
- **Proposed `approach_keywords`**: `resource_fetch_action`, `binary_decoder`, `pdf_text_extraction`, `out_of_band_content`, `bytes_as_observation`.

---

## Approach 5 (bonus) — Stagnation-detection meta-loop

- **Motivating cluster / traces**:
  - Cluster E (meta): visible in every Cluster A–D trace listed above.
  - The clearest signature is `runs/dom-mutation-stream/hard-conditional-form/0/trajectory.jsonl.gz`: after step 3, `mutation_delta` is 0 yet the action `click(aid=1)` is repeated 9 more times.
- **Hypothesised mechanism**: Wrap any inner agent in a meta-loop that hashes `(action, post_observation_summary)` per step. If the hash is seen ≥2 times in a 4-step window, raise `StagnationDetected`; the inner agent is re-prompted with a forced *mode-switch* instruction (try a different selector strategy / different action class / probe-and-elicit). This is a *substrate-agnostic* wrapper — usable around any existing agent.
- **Falsifiable prediction**: Wrapping the current hard-slice leader (`runtime-codegen`) with this meta-loop, no regression on `hard-recoverable` / `hard-shadow-form` (where it currently passes), and ≥1 net new pass across `{hard-multi-tab, hard-pdf-task, hard-conditional-form}` — drawn purely from breaking the repeat-action plateau even without new substrate primitives. If wrapping causes regression on already-passing tasks (because the mode-switch derails working trajectories), the wrapper is too aggressive and needs the threshold tuned, but the underlying hypothesis (repeat-action loops are a recoverable policy failure) remains testable.
- **Slice / tag**: hard slice broadly; the wrapper does not target a single tag.
- **Distinct from existing**: `speculative-rollback`'s second LLM call is a *judge*, not a stagnation detector — and it's already deprioritised by the steering note for being 2-LLM-per-step. This wrapper does not add an LLM call; the detector is a deterministic hash check, and the *re-prompt* on stagnation reuses the existing per-step LLM call. Approach is composable with any of Approaches 1–4.
- **Proposed `approach_keywords`**: `stagnation_detector`, `repeat_action_break`, `mode_switch_on_noprogress`, `deterministic_progress_check`, `wrapper_metaloop`.

---

## Recommended next-iteration ordering

Given the steering note (May 2026) preferring mechanism compositions over more variants:

1. **Approach 5 (stagnation wrapper)** is the cheapest, composes with everything, and converts a measurable fraction of `DECLINED` into actionable retries. Ship as a wrapper, not a slot agent.
2. **Approach 1 (CDP pointer stream)** closes the largest single substrate gap (2 fully-unsolved tasks). Worth a dedicated slot because the substrate is the novelty.
3. **Approach 4 (binary asset reader)** is small in code surface, opens a whole class of tasks for free — wire it into the action vocabulary of the current hard-slice leader.
4. **Approach 2 (multi-target perception)** requires `BrowserSession` to grow; lift to a harness change rather than an agent change.
5. **Approach 3 (adversarial probe)** is the hardest to get right because the mode-switch heuristic is subtle. Defer until Approach 5 is in place — they share the "stuck → switch mode" trigger.

Every approach above lists a single falsifiable claim referencing the trajectory paths it must improve on; failure on that claim means the approach is dropped after one Ralph iteration, not iterated on indefinitely.
