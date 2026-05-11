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
`loadAgent`, with `AGENT_ALIASES` for short names (`trivial → click-first-link`,
`baseline → click-first-link` until US-013 ships the real
`baseline-a11y-react`). Per-difficulty `Budget` limits live in
`DIFFICULTY_BUDGETS` and mirror US-010's spec; update both together when
budgets are tuned.

Per-slice retry defaults live in `SLICE_RETRIES` and are looked up via
`defaultRetriesForSlice(slice)`. Easy is `2` (so a flaky cell gets up to 3
total attempts before being recorded as failed); other slices retry zero
times. Override at the CLI with `--retries=N`. The retry happens around the
whole cell, including `fixtures.reset()` — so server-side state IS reset
between attempts, which is the intended behaviour for live-site flakiness.

## Easy slice v2 (`tasks/suite/easy/`, US-029 — supersedes US-009)

The easy slice is 22 tasks across 10+ public sites. **It is no longer a
pure-extraction slice** — US-029 replaced the trivial "open URL → regex
on body" tasks with multi-step interactive flows that exercise click,
type, scroll, and cross-page navigation. The slice still passes in
<60s/task for a competent agent and gives signal between mechanisms.

The slice is divided into two buckets, marked by tag:

- **Canaries** (`canary` tag + `extract` skill): single-page extraction
  tests. The agent only has to stay on the start URL and read body
  content. Max 8 canaries. They are smoke tests for the harness, NOT
  signal for agent mechanisms.
- **Interactive** (`interactive` tag + `{search, navigate, fill}`
  skill): require >=3 in-page interactions OR cross-page navigation.
  Verifier asserts the URL changed (pathname / search / hash) to a
  specific destination, so a no-op or click-first-link agent fails. Min
  14 interactive.

Author conventions:

- `id: easy-<slug>` (every easy task id starts with `easy-`).
- `difficulty: easy`.
- Goal text: <= 120 words. Keep it tight; ideally <= 80 words.
- Tags MUST include:
   * `easy`
   * exactly ONE of `{search, navigate, extract, fill}` (the skill tag)
   * exactly ONE of `{canary, interactive}` (the bucket tag)
   * exactly ONE `pattern:<unique_pattern_id>` tag — the value is unique
     across ALL tasks in the slice. This is the AC-2 "no fixture-pattern
     twice" enforcer. Pick descriptive names like
     `pattern:wiki_search_box`, `pattern:github_repo_issues_tab`,
     `pattern:mdn_see_also_link`.
   * any descriptive tags you like (`public`, etc.); the validator
     ignores them as long as the structural ones above are present.
- `start_url` MUST be `http://` or `https://` (no `fixtures://` —
  fixtures are for hard).
- `verifier.kind` MUST be `js` or `trajectory_predicate`. No `llm_judge`
  in easy (the slice is meant to be cheap; LLM-judge tasks belong in
  medium / hard).
- **Interactive verifiers** MUST check `document.location` (so the
  cross-page navigation is observable from the verdict) AND MUST use
  a case-insensitive regex (`/.../i`) somewhere in the expression
  (real sites change copy). Combine `document.location.pathname` with
  a body-text regex via `&&` — the URL signal is structural (resists
  copy edits) and the body signal is semantic (resists route renames).
- **Canary verifiers** check `document.location.pathname` equals the
  start URL's path AND `document.location.hash === ''` AND body has
  expected content — this is the strict shape that makes
  click-first-link fail even when the only link on the page is a
  `#skip-to-content` accessibility anchor.
- The verifier expression should NOT depend on auth, paywalls, or
  destructive actions. Public-read endpoints only.
- Cross-origin verifiers cannot `fetch('/__some_path')` because the page
  origin is the live site, not our fixtures server. Use
  `document.title`, `document.body.innerText`, or `document.location` —
  match against a regex tolerant of minor copy edits.
- Stay achievable in <= 6 steps for an honest baseline agent. The
  agent should reasonably be able to: navigate, click a link or two,
  optionally type into one input, optionally submit one form.

The validator at `harness/ts/tests/easy_slice.test.ts` enforces all of
the above; adding a new easy task usually means dropping a YAML in this
directory — the test picks it up automatically. To delete a task,
remove its YAML; to retag (canary <-> interactive), update the bucket
tag and the verifier shape accordingly.

### Why two buckets?

The pre-US-029 slice was 22 single-page extractions. Almost every
LLM-using agent scored 19+/22 because the page-text verifier matched
before the agent did anything — the eval runner pre-navigates to
`start_url`, so any agent that even fails-fast lands at the right URL.
This compressed the slice's signal: a strong runtime-codegen agent and
a hands-off click-first-link agent ended up only 2 points apart.

The v2 design fixes this by splitting:
- 8 canaries preserve the "is the harness wired up correctly" smoke.
  An agent that no-ops still passes them (because the harness pre-
  navigates), so we get a fast trivially-true baseline.
- 14 interactive tasks require the agent to actually drive the page.
  Verifiers assert the URL changed, so an agent that does nothing or
  clicks the first irrelevant link fails. This is where mechanism
  differences (search-box-finding, in-article-link-resolution,
  tab-clicking, form-fill) actually surface.

The slice still satisfies "competent agent passes >=14/22 in <60s/task"
(roughly matches the easy budget of 50k tokens / $0.20 / 60s / 15
steps).

## Hard-real slice (`tasks/suite/hard-real/`, US-026)

The hard-real slice is 8–10 tasks against REAL public websites with
non-trivial DOM/JS complexity, no auth required. Counterpart to the
local `hard/` fixtures: same difficulty tier, same budget (600s wall,
80 steps), but the agent is tested on transfer from synthetic to real.

Author conventions:

- `id: hard-real-<slug>` (every task id starts with `hard-real-`).
- `difficulty: hard` so the harness applies the hard-tier `Budget`.
- Tags MUST include `hard`, `real_site`, and exactly ONE of
  `{search, navigate, extract, fill}`. Tasks that traverse multiple
  pages (the common case) also add `cross_page`.
- `start_url` MUST be `https://`. No `fixtures://`, no `http://`, no
  pages requiring auth or destructive writes.
- Each task hostname MUST be distinct from every other task's hostname
  in this slice AND from every easy-slice hostname (i.e. no
  example.com, wikipedia, iana, info.cern.ch, rfc-editor, arxiv,
  developer.mozilla.org, httpbin, github.com — those are easy-slice
  hosts). The slice's purpose is breadth across hosts.
- Each task requires `>=3 in-page interactions OR cross-page
  navigation`. Single-page extractions on the start_url's body are
  NOT allowed — the verifier MUST check that the page state changed
  past what loading the start URL alone produces. The simplest pattern:
  put the answer-bearing content on a different URL and have the
  verifier match `document.location.pathname` against a regex that
  excludes the start_url's path.
- `verifier.kind` MUST be `js` or `trajectory_predicate`. No
  `llm_judge` (programmatic only; we want cheap, deterministic
  signal). The verifier expression should:
  - Use case-insensitive regexes (`/.../i`) — sites change copy.
  - Combine a URL check with a text check (`pathname match && body
    text match`) to be robust to either a copy change or a route
    rename (one will still fire).
  - Allow alternatives with `||` where reasonable (e.g. the hash
    OR the pathname for hash-routed sites like caniuse).
  - NEVER `fetch('/__path')` — the page origin is the live site, not
    our fixtures server; cross-origin fetches will fail or be CORS-
    blocked.
- Real sites are flaky (DNS, TLS handshake jitter, transient 5xx,
  rate limits, Cloudflare interstitial). `SLICE_RETRIES["hard-real"]`
  defaults to `2` so a transient failure does not poison the
  leaderboard. Override at the CLI with `--retries=N`.

### Rate-limit and network-flake risk

The slice hits public infra we do not own. Each cell makes one or
more HTTPS requests per attempt, plus whatever the agent emits.
Risks:

- **Rate limits / bot interstitials**: Cloudflare, HF, npm, and
  others can return 4xx/5xx or a JS challenge when they detect
  headless Chrome. We do NOT spoof UA or solve challenges; failures
  here are recorded as ordinary FAIL with `terminal_state` reflecting
  what the agent reached. If a host is consistently inaccessible from
  the test machine, drop the YAML rather than retrying forever.
- **Network flake**: DNS/TLS jitter accounts for most failures on a
  healthy network. The slice's per-slice retry default of `2`
  absorbs single-attempt blips. Don't crank retries higher — past 2
  retries you are mostly burning wall time on a host that is
  systemically failing for you.
- **Site drift**: if a site renames a route or changes copy, the
  verifier may stop matching. Prefer URL-pattern checks over copy
  checks where possible. Re-author tasks rather than skipping them
  long-term.
- **Cost**: agents that use LLMs (the seven novel agents) will burn
  tokens on each cell. With 9 tasks × 1 seed × ~5–15 LLM calls per
  task at ~$0.01–0.05 per call, a full hard-real sweep across 7
  agents is on the order of $5–20 in tokens. Budget enforced by
  the hard-tier `Budget` (USD cap = $3 per task).

### Adding a new hard-real task

1. Pick a public host NOT already used by any easy or hard-real task.
2. Pick a destination URL (the "answer page") that is several clicks
   or one cross-page navigation away from a sensible start URL.
3. Write the YAML with the conventions above. Goal text should
   describe the destination URL pattern so the verifier and the
   prompt agree on success.
4. Add the host to `HARD_REAL_FORBIDDEN_HOSTS` in
   `harness/ts/tests/hard_real_slice.test.ts` ONLY if you want to
   forbid it for some reason; otherwise the existing distinct-host
   check picks it up automatically.

## Hard-app slice (`tasks/suite/hard-app/`, US-027)

The hard-app slice is 8–10 tasks against four self-hosted SPAs
(Gitea, Excalidraw, BookStack, Vikunja) booted via
`infra/docker/docker-compose.yml`. Unlike hard-real, the harness
owns the infrastructure: an admin user is seeded, the agent user is
pre-created, and `loginAs(session, app)` injects the session before
`agent.run()`. The point is to test multi-step write operations on
complex SPAs without third-party-auth headaches.

Author conventions:

- `id: hard-app-<slug>` (every task id starts with `hard-app-`).
- `difficulty: hard` so the harness applies the hard-tier `Budget`.
- Tags MUST include `hard`, `app`, and `app:<id>` where `<id>` is
  one of `gitea | excalidraw | bookstack | vikunja`. The tournament
  runner reads the `app:<id>` tag to dispatch the right
  `loginAs(...)` adapter before navigate.
- Each task ALSO carries exactly one skill tag
  `{search, navigate, extract, fill}`.
- `start_url` MUST be `http://127.0.0.1:<port>/...` where `<port>`
  matches the docker-compose host mapping (gitea=3001,
  excalidraw=3002, bookstack=3003, vikunja=3004). The slice tests
  enforce port↔app-tag consistency.
- `verifier.kind` MUST be `js` or `trajectory_predicate`. No
  `llm_judge` (we want cheap, deterministic signal).
- Verifiers SHOULD query the app's REST API to confirm state. The
  page origin in the browser IS the app's origin, so
  `fetch('/api/...', { credentials: 'include' })` is the canonical
  pattern. Verifier expressions handle JSON responses inside an
  `(async () => { ... })()` IIFE.
- Excalidraw has no auth — its verifiers read
  `localStorage.getItem('excalidraw')` directly.

### Preflight + opt-out

`harness/ts/tournament/preflight.ts` probes the four apps before the
slice runs. If any app is unreachable (or `SKIP_SELF_HOSTED=1` is
set), the tournament runner SKIPS the slice with a clear log line
and does NOT write summary.json files for it. The slice is opt-in
on machines without enough RAM / disk for the docker stack.

### Adding a new hard-app task

1. Decide which app to target. If you need a 5th app, edit
   `harness/ts/cdp/loginAs.ts` (HardAppId union, DEFAULT_PORTS,
   loginXxx adapter), `infra/docker/docker-compose.yml`, and add a
   seed script under `infra/docker/seed/`. The slice tests
   automatically pick up new app ids that you add to the `HardAppId`
   union.
2. Decide the start_url: open the app's web UI and pick the page
   the agent should land on after login. Use the host-mapped port.
3. Write the verifier: prefer an API call to confirm state. Wrap
   in `(async () => { ... })()`; return either a boolean or
   `{ pass, score, reason }` (the runner accepts both).
4. Tag with `hard`, `app`, `app:<id>`, plus one skill tag.
5. `npm test -- harness/ts/tests/hard_app_slice.test.ts` — the
   slice contract test validates port/tag consistency and skill
   tag uniqueness on every YAML.

### Resource / cost notes for hard-app

- RAM: ~860 MB steady state with all four apps up (peaks ~1.5 GB
  during first-boot BookStack migrations).
- Disk: ~1.5 GB for the four images on first pull.
- Cost: agents that use LLMs burn tokens on each cell.
  Hard-tier budget is $3 / task, so a full 7-agent × 9-task sweep
  is ≤ $189 worst-case (typically much less; ~$10–30 in practice
  with gpt-4o-mini and competent agents).
- Wall clock: serially, ~5 min × 9 tasks × 7 agents ≈ 5 h. With
  the BrowserPool the resumable runner already supports, ~1.5–2 h.

### Outline vs BookStack (AC #1 deviation)

AC #1 lists "Outline or BookStack" as candidates for the Notion-like
docs app. We ship BookStack, not Outline, because:

- Outline requires Postgres + Redis + S3-compatible storage and SMTP
  (or a magic-link bypass). That stack exceeds the AC #7 ~1.5 GB
  RAM budget and adds two more containers on top of MariaDB.
- BookStack runs on PHP + MariaDB and fits in ~400 MB. Single
  container plus the shared `bookstack-db` MariaDB sidecar.
- Both surface the same agent-facing primitive (book → page,
  WYSIWYG editor with code blocks, REST API for verification).
- The `app:bookstack` tag is the only place this choice is
  exposed to tasks; swapping to Outline would mean changing the
  loginAs adapter and the compose stack, but no task YAMLs.

### Vikunja volume permissions (init container)

`vikunja/vikunja:0.24.6` runs as uid 1000 and the named volume
`vikunja_data` defaults to root-owned on first creation, so the
service hits a permission-denied loop opening `/db/vikunja.db`.
The compose ships a one-shot `vikunja-init` service (alpine:3 +
`chown -R 1000:1000 /db`) that depends-on completes before
`vikunja` starts. Do not delete the init service when refactoring
the compose — fresh `make apps-down -v && make apps-up` will
break without it.
