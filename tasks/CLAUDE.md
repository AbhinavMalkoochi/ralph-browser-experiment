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
     (`shadow_dom`, `canvas`, `virtualization`, etc.).

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
