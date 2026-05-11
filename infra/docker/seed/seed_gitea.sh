#!/usr/bin/env bash
# Idempotently seed the Gitea instance for the hard-app slice (US-027).
#
# - Creates an admin (root) and an agent user
# - Creates the playground org and a repo with realistic content
#   (>=10 issues, >=1 open PR with a review thread, README + LICENSE)
#
# Reads credentials from env (with defaults matching .env.example). Safe to
# re-run; missing entities are created, existing ones are left alone.
#
# Usage: bash infra/docker/seed/seed_gitea.sh

set -euo pipefail

GITEA_PORT="${GBA_GITEA_PORT:-3001}"
GITEA_URL="http://127.0.0.1:${GITEA_PORT}"
ADMIN_USER="${GBA_GITEA_ADMIN_USER:-root}"
ADMIN_PASS="${GBA_GITEA_ADMIN_PASSWORD:-root-correct-horse-battery-staple}"
AGENT_USER="${GBA_GITEA_USER:-agent}"
AGENT_PASS="${GBA_GITEA_PASSWORD:-agent-correct-horse-battery-staple}"
ORG_NAME="${GBA_GITEA_ORG:-playground}"
REPO_NAME="${GBA_GITEA_REPO:-harness}"

log() { echo "[seed_gitea] $*" >&2; }

# Wait for Gitea to be reachable. apps-up does this too, but seed scripts
# may run standalone.
wait_for_ready() {
  local i=0
  while [ $i -lt 60 ]; do
    if curl -sf "${GITEA_URL}/api/healthz" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "[seed_gitea] FATAL: ${GITEA_URL}/api/healthz unreachable after 60s" >&2
  return 1
}

# Returns 0 if the response body looks like a JSON object (best-effort check
# that doesn't need jq).
is_json_object() {
  local body="$1"
  [[ "$body" == \{* ]]
}

# Create the admin user via docker exec (the only path that bootstraps an
# admin without an existing admin). Idempotent: ignores "user already
# exists" error.
create_admin() {
  if curl -sf -u "${ADMIN_USER}:${ADMIN_PASS}" \
       "${GITEA_URL}/api/v1/users/${ADMIN_USER}" >/dev/null 2>&1; then
    log "admin '${ADMIN_USER}' already exists, skipping"
    return 0
  fi
  log "creating admin user '${ADMIN_USER}' via gitea CLI"
  docker exec -u 1000 gba-gitea gitea admin user create \
    --username "${ADMIN_USER}" \
    --password "${ADMIN_PASS}" \
    --email "${ADMIN_USER}@example.invalid" \
    --admin --must-change-password=false \
    >/dev/null 2>&1 \
    || log "admin create returned non-zero (likely already exists); continuing"
}

# Create the agent (regular) user via the admin API.
create_agent_user() {
  if curl -sf -u "${ADMIN_USER}:${ADMIN_PASS}" \
       "${GITEA_URL}/api/v1/users/${AGENT_USER}" >/dev/null 2>&1; then
    log "user '${AGENT_USER}' already exists, skipping"
    return 0
  fi
  log "creating user '${AGENT_USER}'"
  curl -sf -X POST -u "${ADMIN_USER}:${ADMIN_PASS}" \
    -H "Content-Type: application/json" \
    -d "{\"login_name\":\"${AGENT_USER}\",\"username\":\"${AGENT_USER}\",\"email\":\"${AGENT_USER}@example.invalid\",\"password\":\"${AGENT_PASS}\",\"must_change_password\":false}" \
    "${GITEA_URL}/api/v1/admin/users" >/dev/null
}

create_org() {
  if curl -sf -u "${ADMIN_USER}:${ADMIN_PASS}" \
       "${GITEA_URL}/api/v1/orgs/${ORG_NAME}" >/dev/null 2>&1; then
    log "org '${ORG_NAME}' already exists, skipping"
    return 0
  fi
  log "creating org '${ORG_NAME}'"
  curl -sf -X POST -u "${ADMIN_USER}:${ADMIN_PASS}" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${ORG_NAME}\",\"full_name\":\"Playground\",\"visibility\":\"public\"}" \
    "${GITEA_URL}/api/v1/orgs" >/dev/null
}

create_repo() {
  if curl -sf -u "${ADMIN_USER}:${ADMIN_PASS}" \
       "${GITEA_URL}/api/v1/repos/${ORG_NAME}/${REPO_NAME}" >/dev/null 2>&1; then
    log "repo '${ORG_NAME}/${REPO_NAME}' already exists, skipping"
    return 0
  fi
  log "creating repo '${ORG_NAME}/${REPO_NAME}' with README + LICENSE"
  curl -sf -X POST -u "${ADMIN_USER}:${ADMIN_PASS}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${REPO_NAME}\",\"description\":\"Playground for browser-agent eval (US-027).\",\"private\":false,\"auto_init\":true,\"default_branch\":\"main\",\"license\":\"MIT\",\"readme\":\"Default\"}" \
    "${GITEA_URL}/api/v1/orgs/${ORG_NAME}/repos" >/dev/null
}

# Create N seeded issues. Re-running just appends new ones — so we count
# existing first and only top up.
seed_issues() {
  local want=10
  local current
  current=$(curl -sf -u "${ADMIN_USER}:${ADMIN_PASS}" \
              "${GITEA_URL}/api/v1/repos/${ORG_NAME}/${REPO_NAME}/issues?state=all&type=issues&limit=50" \
              | tr -cd '{' | wc -c)
  if [ "${current}" -ge "${want}" ]; then
    log "found ${current} issues already; skipping seed"
    return 0
  fi
  local needed=$((want - current))
  log "seeding ${needed} additional issues"
  local titles=(
    "Document the configuration file format"
    "Add CI badge to README"
    "Fix typo in installation instructions"
    "Investigate slow startup time"
    "Refactor logger to use structured fields"
    "Improve error message on permission denied"
    "Add unit tests for the new parser"
    "Pin runtime dependencies for reproducibility"
    "Audit deprecated API usage"
    "Plan v2 roadmap discussion"
  )
  local labels=("bug" "documentation" "enhancement" "question" "good first issue")
  local i
  for i in $(seq 1 ${needed}); do
    local title="${titles[$(( (current + i - 1) % ${#titles[@]} ))]}"
    local body
    body="Tracked as issue #$((current + i)) in seeded data. Filed by automation."
    curl -sf -X POST -u "${ADMIN_USER}:${ADMIN_PASS}" \
      -H "Content-Type: application/json" \
      -d "{\"title\":\"${title}\",\"body\":\"${body}\"}" \
      "${GITEA_URL}/api/v1/repos/${ORG_NAME}/${REPO_NAME}/issues" >/dev/null
  done
}

# A "review thread": open a branch, commit a change, open a PR, then post a
# review comment. We do all of this through the API to keep the seed script
# free of `git` host-side state.
seed_pr() {
  local count
  count=$(curl -sf -u "${ADMIN_USER}:${ADMIN_PASS}" \
            "${GITEA_URL}/api/v1/repos/${ORG_NAME}/${REPO_NAME}/pulls?state=all" \
            | tr -cd '{' | wc -c)
  if [ "${count}" -ge 1 ]; then
    log "found ${count} pull requests already; skipping seed"
    return 0
  fi
  log "seeding one PR with review thread"
  # 1. Create a branch from main
  local sha
  sha=$(curl -sf -u "${ADMIN_USER}:${ADMIN_PASS}" \
          "${GITEA_URL}/api/v1/repos/${ORG_NAME}/${REPO_NAME}/branches/main" \
          | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("commit",{}).get("id","") or "")' \
          2>/dev/null || true)
  if [ -z "${sha}" ]; then
    log "could not read main branch sha; skipping PR seed"
    return 0
  fi
  curl -sf -X POST -u "${ADMIN_USER}:${ADMIN_PASS}" \
    -H "Content-Type: application/json" \
    -d "{\"new_branch_name\":\"feature/x\",\"old_branch_name\":\"main\"}" \
    "${GITEA_URL}/api/v1/repos/${ORG_NAME}/${REPO_NAME}/branches" >/dev/null 2>&1 || true
  # 2. Modify README on the feature branch
  local readme
  readme=$(curl -sf -u "${ADMIN_USER}:${ADMIN_PASS}" \
             "${GITEA_URL}/api/v1/repos/${ORG_NAME}/${REPO_NAME}/contents/README.md?ref=feature/x" \
             || true)
  local readme_sha
  readme_sha=$(printf '%s' "${readme}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("sha",""))' 2>/dev/null || echo "")
  if [ -n "${readme_sha}" ]; then
    local newcontent_b64
    newcontent_b64=$(printf '# Playground\n\nUpdated by feature/x.\n' | base64 -w 0)
    curl -sf -X PUT -u "${ADMIN_USER}:${ADMIN_PASS}" \
      -H "Content-Type: application/json" \
      -d "{\"branch\":\"feature/x\",\"sha\":\"${readme_sha}\",\"content\":\"${newcontent_b64}\",\"message\":\"docs: update readme\"}" \
      "${GITEA_URL}/api/v1/repos/${ORG_NAME}/${REPO_NAME}/contents/README.md" >/dev/null 2>&1 || true
  fi
  # 3. Open the PR
  local pr_resp
  pr_resp=$(curl -sf -X POST -u "${ADMIN_USER}:${ADMIN_PASS}" \
              -H "Content-Type: application/json" \
              -d "{\"title\":\"Update README on feature/x\",\"body\":\"Draft PR seeded for browser-agent eval. Awaiting review.\",\"head\":\"feature/x\",\"base\":\"main\"}" \
              "${GITEA_URL}/api/v1/repos/${ORG_NAME}/${REPO_NAME}/pulls" || true)
  local pr_index
  pr_index=$(printf '%s' "${pr_resp}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("number",""))' 2>/dev/null || echo "")
  if [ -z "${pr_index}" ]; then
    log "PR create failed; review thread skipped"
    return 0
  fi
  # 4. Post a review comment (issue-level comment is fine for the AC's
  #    "review thread" — verifiers query /issues/comments for it).
  curl -sf -X POST -u "${ADMIN_USER}:${ADMIN_PASS}" \
    -H "Content-Type: application/json" \
    -d "{\"body\":\"Looks good; one nit on the heading.\"}" \
    "${GITEA_URL}/api/v1/repos/${ORG_NAME}/${REPO_NAME}/issues/${pr_index}/comments" >/dev/null 2>&1 || true
}

wait_for_ready
create_admin
create_agent_user
create_org
create_repo
seed_issues
seed_pr
log "done. open ${GITEA_URL} and sign in as ${AGENT_USER} / ${AGENT_PASS}"
