.PHONY: install smoke eval tournament report typecheck test clean

# Default agent and slice for eval
AGENT ?= trivial
SLICE ?= easy
SEEDS ?= 1

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
	@echo "==> make eval AGENT=$(AGENT) SLICE=$(SLICE) SEEDS=$(SEEDS)"
	@echo "Note: full eval pipeline lands in US-009/US-010. Stub only for now."
	npx tsx harness/ts/cli/eval.ts --agent=$(AGENT) --slice=$(SLICE) --seeds=$(SEEDS)

tournament:
	@echo "==> make tournament SLICE=$(SLICE) SEEDS=$(SEEDS)"
	@echo "Note: full tournament lands in US-010. Stub only for now."
	npx tsx harness/ts/cli/tournament.ts --slice=$(SLICE) --seeds=$(SEEDS)

report:
	@echo "==> make report"
	@echo "Note: full report generator lands in US-011. Stub only for now."
	npx tsx harness/ts/cli/report.ts

clean:
	rm -rf runs/ node_modules/ .venv/
