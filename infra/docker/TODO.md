# Hard-app slice TODO (US-027 follow-ups)

What landed in this iteration:

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
- 18 unit + contract tests in `hard_app_slice.test.ts`. 455 TS +
  7 Python tests passing.
- `make apps-up / apps-seed / apps-down / apps-status` targets.
- README documenting cost + opt-out.

What still needs follow-up before the slice is "done":

- [ ] **Live agent sweep (AC #8).** All 7 existing agents must run
  end-to-end against the slice and have their results recorded.
  This needs:
  1. ~1.5 GB free RAM and ~3 GB disk for image pulls.
  2. `make apps-up && make apps-seed` (cold-start ~2 minutes; pulls
     gitea, excalidraw, bookstack, mariadb, vikunja).
  3. `set -a; . .env; set +a` to export the LLM keys.
  4. `make tournament SLICE=hard-app SEEDS=1`. Wall-clock estimate:
     ~5 min × 9 tasks × 7 agents = ~5 h serially. With the existing
     BrowserPool plumbed in via the resumable runner, ~1.5–2 h.
  5. `make report` to update `docs/leaderboard.md`.

- [ ] **Seed verification.** The seed scripts have been written but
  not executed against live containers in this iteration. Smoke
  steps to take on first boot:
  ```
  make apps-up
  make apps-seed
  curl -sf -u root:root-correct-horse-battery-staple \
    http://127.0.0.1:3001/api/v1/repos/playground/harness/issues | jq length   # expect >= 10
  curl -sf http://127.0.0.1:3004/api/v1/info | jq .version
  curl -sf http://127.0.0.1:3003/login | head -1
  ```
  If a seed script needs a tweak, edit the script — its tail-end
  `log "done"` line is the heartbeat. Re-run `make apps-seed`; the
  scripts are idempotent.

- [ ] **Vikunja "drag a card across columns" task (AC #5).** Today
  the slice has `hard-app-vikunja-mark-done` which sets `done=true`
  via REST; the AC's example was specifically "drag a Plane card
  across columns and change its priority". Vikunja's kanban view
  uses HTML5 drag-and-drop; a follow-up task can add this against
  the kanban URL `/projects/<id>/kanban`.

- [ ] **BookStack page with code block (AC #5).** Today's
  `hard-app-bookstack-create-page` requires a body phrase but not a
  fenced code block; the AC mentions "create a doc with a heading
  and code block". A follow-up task can tighten the verifier to
  check for `<pre>` or `<code>` content via the API.

- [ ] **Outline-vs-BookStack note in `tasks/CLAUDE.md`.** AC #1
  lists "Outline OR BookStack"; this iteration shipped BookStack
  because Outline requires Postgres + Redis + S3-compatible storage,
  which violates the AC #7 "1.5 GB RAM total" budget. Document the
  rationale somewhere durable.

- [ ] **Per-agent README pointers.** Once the agent sweep happens
  and results are in, link each agent's
  `agents/<id>/README.md` "Live results" section to the hard-app
  trajectories under `runs/<agent>/hard-app-*/`.

## Why this is staged

Booting four containers + pulling ~1 GB of images + running ~63 agent
cells exceeds a single Ralph iteration's wall-clock budget. The
infrastructure landed first so the next iteration can pick up at
"AC #8 live sweep" without re-discovering any of the seeding or
login plumbing.
