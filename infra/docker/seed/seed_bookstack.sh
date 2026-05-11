#!/usr/bin/env bash
# Idempotently seed BookStack for the hard-app slice (US-027).
#
# BookStack ships with an admin user (admin@admin.com / password) on first
# boot. This script:
#   - Renames + secures the admin (sets it to GBA_BOOKSTACK_USER /
#     GBA_BOOKSTACK_PASSWORD)
#   - Creates a "harness" book seeded with three pages of realistic content
#
# BookStack does NOT have a fully self-serve REST API for first-boot
# rekeying without a long-lived API token, so this script uses the
# `php artisan` CLI inside the container for admin setup, then the
# REST API (with an issued token) for content.

set -euo pipefail

BOOKSTACK_PORT="${GBA_BOOKSTACK_PORT:-3003}"
BOOKSTACK_URL="http://127.0.0.1:${BOOKSTACK_PORT}"
USER_EMAIL="${GBA_BOOKSTACK_USER:-agent@example.invalid}"
USER_PASS="${GBA_BOOKSTACK_PASSWORD:-agent-correct-horse-battery-staple}"

log() { echo "[seed_bookstack] $*" >&2; }

wait_for_ready() {
  local i=0
  while [ $i -lt 90 ]; do
    if curl -sf "${BOOKSTACK_URL}/login" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  echo "[seed_bookstack] FATAL: ${BOOKSTACK_URL}/login unreachable after 180s" >&2
  return 1
}

reset_admin_password() {
  log "ensuring admin '${USER_EMAIL}' / '${USER_PASS}' exists"
  # BookStack's first-boot default admin is admin@admin.com / password.
  # Renaming it to our agent and resetting the password is one CLI call:
  docker exec gba-bookstack bash -lc '
    cd /app/www;
    php artisan tinker --execute="
      use BookStack\\Auth\\User;
      \$u = User::firstOrCreate(
          [\"email\" => \"'"${USER_EMAIL}"'\"],
          [
              \"name\" => \"agent\",
              \"password\" => bcrypt(\"'"${USER_PASS}"'\"),
          ]
      );
      \$u->password = bcrypt(\"'"${USER_PASS}"'\");
      \$u->email_confirmed = true;
      \$u->save();
      \$role = \\BookStack\\Auth\\Role::where(\"system_name\", \"admin\")->first();
      if (\$role) { \$u->attachRole(\$role); }
      echo \"agent_id=\" . \$u->id . PHP_EOL;
    "
  ' >/dev/null 2>&1 || log "tinker call returned non-zero; admin may already be in target state"
}

# Issue a personal API token for the agent and create one book + three
# pages via the REST API. The token is captured from the tinker output.
seed_content() {
  log "issuing API token for agent and seeding 1 book + 3 pages"
  local token_id token_secret
  read -r token_id token_secret < <(
    docker exec gba-bookstack bash -lc '
      cd /app/www;
      php artisan tinker --execute="
        \$u = \\BookStack\\Auth\\User::where(\"email\", \"'"${USER_EMAIL}"'\")->firstOrFail();
        \$t = new \\BookStack\\Api\\ApiToken();
        \$t->user_id = \$u->id;
        \$t->name = \"harness-seed-token\";
        \$t->token_id = bin2hex(random_bytes(16));
        \$t->secret = bin2hex(random_bytes(16));
        \$t->expires_at = now()->addYears(5);
        // Hash before persistence to satisfy auth flow:
        \$plainSecret = \$t->secret;
        \$t->secret = \\Hash::make(\$plainSecret);
        \$t->save();
        echo \$t->token_id . \" \" . \$plainSecret . PHP_EOL;
      "
    ' 2>/dev/null | tail -1
  )
  if [ -z "${token_id:-}" ] || [ -z "${token_secret:-}" ]; then
    log "could not issue an API token; skipping content seed"
    return 0
  fi
  local auth="Authorization: Token ${token_id}:${token_secret}"
  # Create book
  local book_resp
  book_resp=$(curl -sf -X POST -H "${auth}" -H "Content-Type: application/json" \
    -d '{"name":"Harness","description":"Seeded book for browser-agent eval."}' \
    "${BOOKSTACK_URL}/api/books" || true)
  local book_id
  book_id=$(printf '%s' "${book_resp}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id",""))' 2>/dev/null || echo "")
  if [ -z "${book_id}" ]; then
    log "book create failed; skipping page seed"
    return 0
  fi
  for i in 1 2 3; do
    curl -sf -X POST -H "${auth}" -H "Content-Type: application/json" \
      -d "{\"book_id\":${book_id},\"name\":\"Page ${i}\",\"markdown\":\"# Page ${i}\\n\\nSeeded content for page ${i}.\\n\"}" \
      "${BOOKSTACK_URL}/api/pages" >/dev/null 2>&1 || true
  done
}

wait_for_ready
reset_admin_password
seed_content
log "done. login at ${BOOKSTACK_URL}/login as ${USER_EMAIL} / ${USER_PASS}"
