#!/usr/bin/env bash
# ==========================================================================
# WayMaker Ink — create the portal accounts on a LOCAL Supabase stack.
#
#   cd uat && npx supabase start && ./supabase/bootstrap-local.sh
#
# The runbook's §2 says to create Nic and Laynie by hand in the dashboard,
# which is right for UAT and production — those are two real people whose
# passwords nobody else should choose. On a local stack that is five minutes of
# clicking to get to a login screen, so this does it.
#
# ⚠ LOCAL ONLY, and it checks. It creates users with a known weak password and
# grants them `admin`, using the service-role key on the command line where it
# lands in shell history. Every one of those is fine against a throwaway
# container on 127.0.0.1 and unacceptable anywhere else.
# ==========================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

say() { printf '[bootstrap] %s\n' "$*"; }
die() { printf '[bootstrap] FATAL: %s\n' "$*" >&2; exit 1; }

# --- Read the stack's own values ---------------------------------------------
# `supabase status -o env` prints the URL and keys for the running stack.
# Reading them beats hardcoding the well-known demo keys, which have changed
# between CLI versions.
say "reading local stack status…"
STATUS="$(npx --yes supabase@2 status -o env 2>/dev/null)" || die "no local stack is running — run 'npx supabase start' first"

get() { printf '%s\n' "$STATUS" | grep -E "^$1=" | head -1 | cut -d= -f2- | tr -d '"'; }

API_URL="$(get API_URL)"
ANON_KEY="$(get ANON_KEY)"
SERVICE_KEY="$(get SERVICE_ROLE_KEY)"

[ -n "$API_URL" ]     || die "could not read API_URL from supabase status"
[ -n "$SERVICE_KEY" ] || die "could not read SERVICE_ROLE_KEY from supabase status"

# --- The guard ----------------------------------------------------------------
# The whole safety of this script is that it cannot reach a hosted project.
case "$API_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) die "API_URL is '$API_URL', which is not a local stack. This script creates weak-password admin accounts and must never run against a hosted project." ;;
esac

PASSWORD="${WM_LOCAL_PASSWORD:-portal-local-123}"

# --- Create the accounts ------------------------------------------------------
# The Auth Admin API, not INSERTs into auth.users. Writing those rows by hand
# means reproducing GoTrue's password hashing and its identities table, and
# getting it subtly wrong produces an account that exists and cannot log in.
create_user() {
  local email="$1" name="$2" artist="$3"

  local response
  response="$(curl -s -X POST "$API_URL/auth/v1/admin/users" \
    -H "apikey: $SERVICE_KEY" \
    -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\",\"email_confirm\":true,\"user_metadata\":{\"display_name\":\"$name\"}}")"

  # ⚠ Every extraction below ends in `|| true`, and it is load-bearing under
  # `set -euo pipefail`. `grep` exits 1 when it matches nothing, pipefail
  # promotes that to the pipeline's status, and a command substitution assigned
  # to an already-declared variable carries that status — so the FIRST re-run
  # of this script, on the very path that exists to make re-runs safe, would
  # exit silently at the point the user already existed.
  local id
  id="$(printf '%s' "$response" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"

  if [ -z "$id" ]; then
    # Already there from a previous run. `tr '{' '\n'` splits the list into one
    # chunk per user: GoTrue emits id, aud, role, then email before any nested
    # object, so the chunk that names this address also carries its id.
    id="$(curl -s "$API_URL/auth/v1/admin/users?per_page=200" \
      -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
      | tr '{' '\n' | grep "\"email\":\"$email\"" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
    [ -n "$id" ] || die "could not create or find $email — create response was: $response"
    say "$email already existed"
  else
    say "created $email"
  fi

  # The signup trigger made the profiles row; it cannot know who the person is.
  # `role = admin` so both see each other's queue, which is what a two-person
  # shop wants — flip either to 'artist' to scope them to their own artist_key.
  curl -s -X PATCH "$API_URL/rest/v1/profiles?id=eq.$id" \
    -H "apikey: $SERVICE_KEY" \
    -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=minimal" \
    -d "{\"display_name\":\"$name\",\"role\":\"admin\",\"artist_key\":\"$artist\"}" >/dev/null

  say "  profile set: $name · admin · artist_key=$artist"
}

create_user "nic@waymakerink.test"    "Nic"    "nic"
create_user "laynie@waymakerink.test" "Laynie" "laynie"

# --- Reference images ---------------------------------------------------------
# Not in seed.sql, and it cannot be: images live in Storage, which is an HTTP
# API rather than a table, so SQL can create the `request_images` row but never
# the object it points at. A seed that did only half of that would give the
# portal a References card with three broken thumbnails in it.
#
# Three things have to land together, which is why they are one function:
#   1. the object in the request-refs bucket
#   2. the request_images row that names its path
#   3. requests.reference_count, which is what decides whether the card renders
#      AT ALL — Images returns null at zero.
#
# The fixtures say SAMPLE across the middle on purpose. Seed data that looks
# like a real client photo is seed data somebody eventually mistakes for one.
attach_image() {
  local rid="$1" ordinal="$2" file="$3"
  local path="$rid/reference-$ordinal.jpg"
  local abs="supabase/fixtures/$file"

  [ -f "$abs" ] || die "missing fixture $abs"

  # upsert so re-running does not 409 on the second pass
  curl -s -X POST "$API_URL/storage/v1/object/request-refs/$path" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: image/jpeg" -H "x-upsert: true" \
    --data-binary "@$abs" >/dev/null

  local id
  # `|| true` for the same reason as in create_user: a request that is not in
  # the database is a skip, not a crash.
  id="$(curl -s "$API_URL/rest/v1/requests?select=id&rid=eq.$rid" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  [ -n "$id" ] || { say "  no request $rid — skipping (run 'supabase db reset' to load the seed)"; return; }

  curl -s -X POST "$API_URL/rest/v1/request_images" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=minimal" \
    -d "{\"request_id\":\"$id\",\"storage_path\":\"$path\",\"ordinal\":$ordinal,\"content_type\":\"image/jpeg\",\"byte_size\":$(wc -c < "$abs")}" >/dev/null

  say "  attached $path"
}

set_count() {
  curl -s -X PATCH "$API_URL/rest/v1/requests?rid=eq.$1" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" -H "Prefer: return=minimal" \
    -d "{\"reference_count\":$2}" >/dev/null
}

say "attaching sample reference images…"
attach_image "WMI-SEED01-AAAA" 1 "reference-1.jpg"   # tattoo, two photos
attach_image "WMI-SEED01-AAAA" 2 "reference-2.jpg"
attach_image "WMI-SEED04-DDDD" 1 "reference-3.jpg"   # touch up, one photo
set_count "WMI-SEED01-AAAA" 2
set_count "WMI-SEED04-DDDD" 1

echo
say "done. Sign in at the portal with:"
printf '\n    nic@waymakerink.test     %s\n    laynie@waymakerink.test  %s\n\n' "$PASSWORD" "$PASSWORD"
say "API_URL   $API_URL"
say "ANON_KEY  $ANON_KEY"
