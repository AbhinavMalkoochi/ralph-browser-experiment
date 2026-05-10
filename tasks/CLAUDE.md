# Tasks directory

Two trees:

- `fixtures/` — local hostile pages served by an in-process HTTP server.
  Used for the hard slice; see US-006 (and US-007/US-008 which will extend it).
- `suite/<difficulty>/` — YAML task specs (one task per file). Loaded with
  `loadTaskFile` from `harness/ts/verifier/loader.js`.

## Fixtures

Add a new hostile page in three steps:

1. Drop the page HTML at `tasks/fixtures/pages/<name>.ts` as a single exported
   `const <NAME>_HTML = \`...\`;` template literal. Keep the page self-contained
   (inline `<script>`, inline CSS) so the server can serve it without static
   assets. If the page needs server-side state, expose it under `/__<feature>/*`
   in `server.ts` and add a `/__reset` clear path to `freshState()`.

2. Wire the route into `tasks/fixtures/server.ts`:
   - Import the HTML constant.
   - Add a `GET /<route>` branch in `handleRequest` that calls `sendHtml`.
   - If the page records something the verifier needs, add the read endpoint
     too (e.g. `GET /__<feature>/last`).

3. Add the YAML spec at `tasks/suite/hard/<route>.yaml`:
   - `start_url: "fixtures://<route>"` — the eval runner rewrites this with
     `resolveFixtureUrl(start_url, server.origin)` at run time.
   - `verifier.kind: js` is preferred; `expression` runs in the page with
     `awaitPromise=true`, so `fetch('/__feature/last').then(j => …)` is fine.
   - Required tags: `hard`, `fixtures`, plus skill-specific ones
     (`shadow_dom`, `canvas`, `virtualization`, etc.). Add `irreversible`
     when the fixture has a one-shot terminal transition (modal-stack
     after a decoy click; conditional-form after submit).

### Multi-page fixtures (iframes etc.)

For fixtures that compose several pages (e.g. iframe-drag is parent +
two child frames), export each page as a separate `*_HTML` constant and
register a route per page (`/foo`, `/foo/source`, `/foo/target`). Use
`window.parent.postMessage(...)` from the children to relay state to a
listener on the parent's `window.__test`; the parent records the
canonical state for the verifier to read. postMessage delivery is
asynchronous, so cheats (and any agent) must poll for a few frames
before asserting the parent has caught the message.

### Multi-tab fixtures

For popup fixtures (`window.open` to a sibling route), the popup runs
its own JS context independent of the original CDP target — our
`CdpBrowserSession` only attaches to the first target, so an agent (or
cheat) cannot directly evaluate inside the popup. Two patterns work:

- **Auto-postback**: have the popup's onload script post results back to
  `window.opener` and then `window.close()` itself. The original page's
  `message` listener stores the result on `window.__test`; the agent
  just polls. The cheat in `fixtures_sanity.test.ts` for `multi-tab`
  bypasses the popup entirely (it knows the per-token endpoint), but a
  realistic agent only needs to click the button and wait.
- **Token-scoped state**: derive a per-page-load token (e.g. random
  string in `window.__test.token`), pass it on the popup URL, and
  cross-check on submit. This guarantees that an agent that opened the
  popup and one that hasn't are distinguishable server-side.

### Binary responses (PDF etc.)

`server.ts` exposes `sendPdf(res, Buffer)` for `application/pdf`
responses. The PDF bytes themselves are constructed by
`buildAnswerPdf(answer)` in `pages/pdf_task.ts`, which produces a
~400-byte single-page PDF whose body contains a single text run. The
cheat in `fixtures_sanity.test.ts` decodes the response as `latin1`
and regex-extracts the answer — real agents must do the same (or
render the PDF properly, which is harder). Per-session randomness for
the answer (`randomAccessCode()` on `freshState()`) prevents memorisation
across runs and means `/__reset` rotates the expected value.

### Stateful failure modes (transient errors)

For fixtures that test retry behaviour (e.g. `recoverable`), keep the
"first call fails" counter on the server-side `FixtureState` and reset
it via `freshState()` so `/__reset` between tasks restores the
contract. The page's failure-recovery UI (banner + re-enabled submit)
is what makes the retry path discoverable to a real agent; cheats poll
on `window.__test.attempts` and the button's disabled state to know
when to retry.

## Server lifecycle

`startFixturesServer({port?})` returns `{origin, port, close, reset}`. The
eval runner spins it up once per `runEval()` call when any task's `start_url`
begins with `fixtures://`, calls `reset()` between tasks, and `close()`s it
in `finally`. Tests follow the same pattern (see
`harness/ts/tests/fixtures_sanity.test.ts`).

`make fixtures` runs the server in the foreground for manual poking.

## Eval runner integration

`harness/ts/eval/runner.ts` loads agents from `agents/<id>/agent.ts` via
`loadAgent`, with `AGENT_ALIASES` for short names (`trivial → click-first-link`).
Per-difficulty `Budget` limits live in `DIFFICULTY_BUDGETS` and mirror
US-010's spec; update both together when budgets are tuned.
