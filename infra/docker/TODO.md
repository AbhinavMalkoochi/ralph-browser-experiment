# Hard-app slice TODO (US-027 follow-ups)

## What landed in the first iteration (infrastructure):

- `infra/docker/docker-compose.yml` with all four apps (Gitea,
  Excalidraw, BookStack + MariaDB sidecar, Vikunja). All on
  127.0.0.1 host-mapped ports. Compose lints clean.
- `infra/docker/seed/{seed_gitea,seed_vikunja,seed_bookstack}.sh` —
  idempotent REST-API-driven seeders.
- `harness/ts/cdp/loginAs.ts` with adapters for all four apps.
  Gitea + BookStack use form-POST with CSRF; Vikunja uses JWT in
  localStorage; Excalidraw is a no-op.
- `harness/ts/tournament/preflight.ts` — slice-level HTTP probe;
  hard-app skips cleanly when apps aren't reachable AND when
  `SKIP_SELF_HOSTED=1`.
- Pre-login threaded into BOTH `harness/ts/eval/runner.ts` and
  `harness/ts/tournament/runner.ts` via the `app:<id>` tag.
- 9 task YAMLs across all 4 apps in `tasks/suite/hard-app/`.
- 18 unit + contract tests in `hard_app_slice.test.ts`.
- `make apps-up / apps-seed / apps-down / apps-status` targets.
- README documenting cost + opt-out.

## What landed in the second iteration (US-027 completion):

- **Docker compose hardening**:
  - Added one-shot `vikunja-init` service (alpine:3) that `chown
    1000:1000 /db` so the vikunja named volume is writable before the
    main vikunja service starts. Fresh `make apps-up` no longer hits
    `permission denied` restart loop.
  - Renamed BookStack DB env vars `DB_USER`/`DB_PASS` →
    `DB_USERNAME`/`DB_PASSWORD` — the
    `lscr.io/linuxserver/bookstack` image rejects the short forms and
    falls back to its literal `.env.example` defaults (`database_username`),
    which 500's the app on first migration.
  - Set `APP_URL=http://127.0.0.1:3003` (was `http://localhost:3003`).
    BookStack honours APP_URL for 302 Location headers; mismatching
    origins make in-page `fetch('/login', { credentials: 'include' })`
    cross-origin on the redirect, surfacing as `TypeError: Failed to
    fetch` from `loginAs(bookstack)`.

- **Seed script fix**:
  - `seed_bookstack.sh` referenced `\BookStack\Auth\User` /
    `\BookStack\Auth\Role`, which were moved to
    `\BookStack\Users\Models\User` / `\BookStack\Users\Models\Role` in
    BookStack 24+. Tinker calls now use the current namespaces; admin
    rekey + API-token issuance work against the live container.

- **Verifier wrap fix** (`harness/ts/verifier/programmatic.ts`):
  - `wrapForRuntimeEvaluate` now strips trailing whitespace + `;`
    before wrapping the expression in
    `(async () => (EXPR))()`. Previously, the idiomatic multi-line
    `|` block scalar shape `(async () => { ... })();\n` (which every
    hard-app YAML uses) produced `(...);)` — not a legal JS
    expression — and Runtime.evaluate surfaced this as
    `js verifier threw: Uncaught` (SyntaxError). EVERY hard-app cell
    failed at verification stage before this fix.
  - 3 new tests in `harness/ts/tests/verifier_iife_wrap.test.ts`
    cover the legacy single-line shape, the trailing-`;` IIFE shape,
    and multiple-trailing-`;`-plus-whitespace.

- **BookStack task tightening** (AC #5):
  - `hard-app-bookstack-create-page` now requires BOTH the
    `owner: ralph` phrase AND a fenced code block (`<pre>` or
    `<code>` tag) in the rendered page HTML. Goal text updated to
    spell out the code-block requirement. New test in
    `hard_app_slice.test.ts` enforces the verifier expression
    contains both checks.

- **Outline-vs-BookStack rationale** (AC #1):
  - `tasks/CLAUDE.md` gained an "Outline vs BookStack" subsection
    explaining why we ship BookStack (RAM budget) and a "Vikunja
    volume permissions" subsection documenting the init container.
    Hard-app section also gained these docs so the rationale
    survives compose refactors.

- **Live agent sweep** (AC #8) — partial:
  - `make tournament SLICE=hard-app SEEDS=1 --agents=click-first-link`
    runs end-to-end on all 9 cells with 0/9 pass + 0 harness crashes
    (proves the slice is wired up correctly).
  - `--agents=network-shadow` runs end-to-end on all 9 cells with
    **1/9 PASS** (hard-app-bookstack-find-page in 2 steps for
    $0.0004) in ~85s. 8 cells DECLINED, no ERRORs, no harness
    crashes.
  - See `docs/hard-app-sweep-2026-05-10.md` for the per-cell results.

## Still deferred:

- [ ] **Full 8-agent sweep**. Only 2 of 8 LLM agents have been swept
  to date (network-shadow, baseline-a11y-react). The remaining 6
  (plan-then-execute, runtime-codegen, speculative-rollback,
  predicate-driven, vision-grounded, dom-mutation-stream) need a
  follow-up tournament invocation to populate leaderboard data and
  feed US-022 (failure-trace mining). Wall-clock estimate: ~5-10 min
  per agent serial = ~30-60 min total. Cost ballpark: ~$1-3 in tokens
  per agent. Trigger:
  ```
  make apps-up && make apps-seed
  set -a; . .env; set +a
  make tournament SLICE=hard-app SEEDS=1
  ```
  The tournament runner is resumable per-cell, so partial runs can
  be interrupted and resumed.

- [ ] **Vikunja kanban drag task**. AC #5's example for Vikunja was
  "drag a Plane card across columns and change its priority". Today's
  slice has `hard-app-vikunja-mark-done` (REST-driven done flip) but
  not the drag variant. A follow-up YAML can target the Vikunja
  kanban URL `/projects/<id>/kanban` with an HTML5 drag-and-drop.

- [ ] **Per-agent README pointers**. Once the full sweep happens,
  link each agent's `agents/<id>/README.md` "Live results" section
  to the hard-app trajectories under `runs/<agent>/hard-app-*/`.
