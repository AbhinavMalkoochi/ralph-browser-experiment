# Self-hosted apps for the hard-app slice (US-027)

Four open-source web apps hosted locally via Docker Compose, used as
substrate for the `hard-app` task slice. Their purpose is to give the agent
a complex SPA to drive — multi-step write operations against rich client
state — without the third-party-auth headache. The harness owns the admin
account; the seed scripts pre-create the agent user; `loginAs(session,
app)` injects the session before `agent.run()`.

## Apps and ports

| App        | Image                                       | Port | What it tests                                                  |
|------------|---------------------------------------------|------|----------------------------------------------------------------|
| Gitea      | `gitea/gitea:1.22.4-rootless`               | 3001 | GitHub-like form fills + multi-page nav (issues, PRs)          |
| Excalidraw | `excalidraw/excalidraw:latest`              | 3002 | Canvas/whiteboard; state in `localStorage["excalidraw"]`       |
| BookStack  | `lscr.io/linuxserver/bookstack:latest`      | 3003 | Notion-like docs (books → chapters → pages); rich-text editor  |
| Vikunja    | `vikunja/vikunja:0.24.6`                    | 3004 | Linear/Asana-like task tracker; JWT-authed SPA over REST API   |

BookStack ships with an embedded MariaDB sidecar in the compose file.
Gitea and Vikunja use built-in SQLite. Excalidraw is a pure static
frontend with no backend; verifiers read `localStorage` directly.

## Lifecycle

```bash
make apps-up      # boot all four services (~60 s on first boot)
make apps-seed    # idempotently seed users + a project + 10+ items per app
make apps-status  # docker compose ps + a curl probe per port
make apps-down    # docker compose down -v (wipes named volumes — fast reset)
```

The compose file binds every port to `127.0.0.1` so nothing is exposed on
the network. Volumes are named so `apps-down -v` is the fast path to a
clean slate.

## Resource budget

Steady-state RAM, headless (idle, after seed):

| App           | RAM   |
|---------------|-------|
| gitea         | ~150 MB |
| excalidraw    | ~30 MB  |
| bookstack-db  | ~250 MB |
| bookstack     | ~350 MB |
| vikunja       | ~80 MB  |
| **Total**     | **~860 MB** |

First-boot migrations can push BookStack briefly to ~700 MB. Plan for
~1.5 GB total head-room as the AC #7 requires.

## Opt out

Set `SKIP_SELF_HOSTED=1` in your env to make the tournament runner SKIP
the `hard-app` slice without trying to reach the apps:

```bash
SKIP_SELF_HOSTED=1 make tournament SLICE=hard-app SEEDS=1
# -> [tournament] SKIP slice=hard-app: SKIP_SELF_HOSTED=1; slice intentionally skipped
```

The preflight is HTTP-only (small probe per app, ~1.5 s budget), so even
without `SKIP_SELF_HOSTED=1` the slice will skip cleanly when the apps
aren't running.

## Credentials

`infra/docker/.env.example` documents the env vars; defaults match what
the seed scripts write. The harness reads them via
`credentialsFromEnv(app)` in `harness/ts/cdp/loginAs.ts`. Agents never
see the credentials — `loginAs` runs before `agent.run()` and the
session cookie / JWT is already in place.

## Slice contract

See `tasks/CLAUDE.md` (section "Hard-app slice") for the task-author
contract enforced by `harness/ts/tests/hard_app_slice.test.ts`.

## See also

- `infra/docker/TODO.md` — items deferred from this iteration (full live
  agent sweep, deeper task coverage per app).
- `infra/docker/seed/*.sh` — idempotent seed scripts.
- `harness/ts/cdp/loginAs.ts` — login adapters per app.
- `harness/ts/tournament/preflight.ts` — slice-level preflight contract.
