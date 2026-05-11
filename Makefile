.PHONY: install smoke eval tournament report typecheck test clean fixtures apps-up apps-down apps-seed apps-status

# Default agent and slice for eval
AGENT ?= trivial
SLICE ?= easy
SEEDS ?= 1
# RETRIES override for `make eval`. When unset the runner uses the
# per-slice default from SLICE_RETRIES (easy=2, others=0).
RETRIES ?=

# Boot the hostile-fixtures server in the foreground (Ctrl-C to stop). Useful
# for poking at /shadow-form, /canvas-drag, /virtual-scroll without an agent.
fixtures:
	npx tsx tasks/fixtures/serve.ts

install:
	@echo "==> Installing Node deps"
	npm install --silent --no-audit --no-fund
	@echo "==> Installing Python deps"
	uv sync --quiet || uv venv --quiet
	@echo "==> Done"

smoke:
	npm run --silent smoke

typecheck:
	npm run --silent typecheck

test: test-ts test-py

test-ts:
	npm run --silent test

test-py:
	uv run --quiet pytest -q

eval:
	@echo "==> make eval AGENT=$(AGENT) SLICE=$(SLICE) SEEDS=$(SEEDS)$(if $(RETRIES), RETRIES=$(RETRIES))"
	npx tsx harness/ts/cli/eval.ts --agent=$(AGENT) --slice=$(SLICE) --seeds=$(SEEDS) $(if $(RETRIES),--retries=$(RETRIES))

BRACKET ?= off

tournament:
	@echo "==> make tournament SLICE=$(SLICE) SEEDS=$(SEEDS) BRACKET=$(BRACKET)"
	npx tsx harness/ts/cli/tournament.ts --slice=$(SLICE) --seeds=$(SEEDS) --bracket=$(BRACKET)

report:
	@echo "==> make report"
	npx tsx harness/ts/cli/report.ts

clean:
	rm -rf runs/ node_modules/ .venv/

# Self-hosted apps for the hard-app slice (US-027). Lifecycle:
#   make apps-up   -> docker compose up -d  (boot all four services)
#   make apps-seed -> idempotent user/project/repo seeding via REST APIs
#   make apps-down -> docker compose down -v  (wipes named volumes for fast reset)
#
# Health: `make apps-status` prints docker compose ps + a curl probe per app.
COMPOSE := docker compose -f infra/docker/docker-compose.yml

apps-up:
	@echo "==> booting hard-app services (gitea, excalidraw, bookstack, vikunja)"
	$(COMPOSE) up -d
	@echo "==> waiting for healthchecks (this may take 60s on first boot)"
	@bash -c 'i=0; while [ $$i -lt 120 ]; do all=1; for p in 3001 3002 3003 3004; do curl -sf -o /dev/null http://127.0.0.1:$$p/ 2>/dev/null || all=0; done; [ $$all -eq 1 ] && echo "==> all four apps reachable" && exit 0; i=$$((i+1)); sleep 2; done; echo "==> timeout: at least one app is not yet reachable; check make apps-status"'

apps-seed:
	@echo "==> seeding apps"
	bash infra/docker/seed/seed_gitea.sh
	bash infra/docker/seed/seed_vikunja.sh
	bash infra/docker/seed/seed_bookstack.sh
	@echo "==> seed done"

apps-down:
	@echo "==> tearing down hard-app services"
	$(COMPOSE) down -v

apps-status:
	$(COMPOSE) ps
	@for p in 3001 3002 3003 3004; do printf "127.0.0.1:%s -> " "$$p"; curl -sf -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:$$p/" 2>&1 || echo "unreachable"; done
