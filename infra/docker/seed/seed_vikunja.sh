#!/usr/bin/env bash
# Idempotently seed Vikunja for the hard-app slice (US-027).
#
# Creates: the agent user, one project, three states ("backlog", "in
# progress", "done"), and ten realistic task cards distributed across
# columns. Safe to re-run; missing entities are created.

set -euo pipefail

VIKUNJA_PORT="${GBA_VIKUNJA_PORT:-3004}"
VIKUNJA_URL="http://127.0.0.1:${VIKUNJA_PORT}/api/v1"
USER_NAME="${GBA_VIKUNJA_USER:-agent}"
USER_PASS="${GBA_VIKUNJA_PASSWORD:-agent-correct-horse-battery-staple}"
USER_EMAIL="${GBA_VIKUNJA_EMAIL:-agent@example.invalid}"

log() { echo "[seed_vikunja] $*" >&2; }

wait_for_ready() {
  local i=0
  while [ $i -lt 60 ]; do
    if curl -sf "${VIKUNJA_URL}/info" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "[seed_vikunja] FATAL: ${VIKUNJA_URL}/info unreachable after 60s" >&2
  return 1
}

# Register the agent. Returns 0 if the user existed or got created.
register_user() {
  local resp
  resp=$(curl -sf -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"${USER_NAME}\",\"email\":\"${USER_EMAIL}\",\"password\":\"${USER_PASS}\"}" \
    "${VIKUNJA_URL}/register" || true)
  if [ -n "${resp}" ]; then
    log "user '${USER_NAME}' created"
  else
    log "user '${USER_NAME}' likely already exists; continuing"
  fi
}

# Log in and capture a JWT for subsequent calls.
JWT=""
login_user() {
  local resp
  resp=$(curl -sf -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"${USER_NAME}\",\"password\":\"${USER_PASS}\"}" \
    "${VIKUNJA_URL}/login" || true)
  JWT=$(printf '%s' "${resp}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("token",""))' 2>/dev/null || echo "")
  if [ -z "${JWT}" ]; then
    echo "[seed_vikunja] FATAL: login failed" >&2
    return 1
  fi
}

# List the user's projects; print the id of the first one named "Harness".
find_project_id() {
  curl -sf -H "Authorization: Bearer ${JWT}" \
    "${VIKUNJA_URL}/projects" \
    | python3 -c '
import json,sys
ps = json.load(sys.stdin)
for p in ps:
    if p.get("title") == "Harness":
        print(p["id"])
        break
' 2>/dev/null || true
}

create_project() {
  local pid
  pid=$(find_project_id)
  if [ -n "${pid}" ]; then
    log "project 'Harness' exists (id=${pid})"
    echo "${pid}"
    return 0
  fi
  log "creating project 'Harness'"
  curl -sf -X PUT -H "Authorization: Bearer ${JWT}" -H "Content-Type: application/json" \
    -d '{"title":"Harness","description":"Seeded for browser-agent eval (US-027).","is_archived":false}' \
    "${VIKUNJA_URL}/projects" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' 2>/dev/null
}

# Seed at least 10 cards distributed across done=0 and done=1.
seed_cards() {
  local project_id="$1"
  local existing
  existing=$(curl -sf -H "Authorization: Bearer ${JWT}" \
              "${VIKUNJA_URL}/projects/${project_id}/tasks" \
              | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d, list) else 0)' 2>/dev/null || echo "0")
  if [ "${existing}" -ge 10 ]; then
    log "project ${project_id} has ${existing} tasks already; skipping seed"
    return 0
  fi
  log "seeding tasks under project ${project_id}"
  local titles=(
    "Pin Chrome version in CI"
    "Write contributor guide"
    "Add typescript strict mode"
    "Migrate to ESM"
    "Investigate flaky test pool.test.ts:42"
    "Cut release v0.2"
    "Update README with eval instructions"
    "Audit dependencies for licenses"
    "Add coverage badge"
    "Plan v0.3 milestone"
  )
  local i=0
  for title in "${titles[@]}"; do
    local done_flag="false"
    if [ $((i % 3)) -eq 2 ]; then
      done_flag="true"
    fi
    curl -sf -X PUT -H "Authorization: Bearer ${JWT}" -H "Content-Type: application/json" \
      -d "{\"title\":\"${title}\",\"description\":\"Seeded card #$((i+1)).\",\"done\":${done_flag},\"priority\":$((i % 5))}" \
      "${VIKUNJA_URL}/projects/${project_id}/tasks" >/dev/null 2>&1 || true
    i=$((i + 1))
  done
}

wait_for_ready
register_user
login_user
PROJECT_ID=$(create_project)
if [ -z "${PROJECT_ID}" ]; then
  echo "[seed_vikunja] FATAL: could not create or find 'Harness' project" >&2
  exit 1
fi
seed_cards "${PROJECT_ID}"
log "done. login at http://localhost:${VIKUNJA_PORT}/ as ${USER_NAME} / ${USER_PASS}"
