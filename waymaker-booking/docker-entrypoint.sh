#!/bin/sh
# Writes public/config.js from the environment at container start, so the same
# image ships to every environment. Runs from nginx's /docker-entrypoint.d/
# before the server boots.
#
#   WM_WEBHOOK_URL  production intake webhook. Must be /webhook/, not
#                   /webhook-test/ — test URLs accept one request and only
#                   while the n8n editor is open.
#   WM_ARTISTS      JSON object, artist key -> { enabled, name, headline, blurb }
#                   e.g. {"nic":{"enabled":true,"name":"Nic Sinnwell"}}
#                   Adding an artist is an edit here, not a code change.
#
# No artist emails: this file is served to the public, and the intake workflow
# resolves the artist from its own server-side map regardless.
set -e

# Overridable so the local dev server can exercise this exact script instead
# of reimplementing it and drifting from what actually ships.
TARGET="${WM_CONFIG_TARGET:-/usr/share/nginx/html/config.js}"

# WEBHOOK_URL is the older name; accept it so an existing Dokploy app keeps
# working after this change.
URL="${WM_WEBHOOK_URL:-$WEBHOOK_URL}"
ARTISTS="${WM_ARTISTS:-}"

if [ -z "$URL" ]; then
  echo "[wm-booking] WARNING: neither WM_WEBHOOK_URL nor WEBHOOK_URL set — app.js falls back to its baked-in value"
fi

# An unparseable WM_ARTISTS would be a syntax error in config.js and would take
# the whole form down, so fall back to null and let app.js use its defaults.
if [ -n "$ARTISTS" ]; then
  if ! printf '%s' "$ARTISTS" | grep -q '^[[:space:]]*{'; then
    echo "[wm-booking] WARNING: WM_ARTISTS is not a JSON object — ignoring it"
    ARTISTS=""
  fi
fi

{
  echo "/* Generated at container start by docker-entrypoint.sh. Do not edit. */"
  echo "window.WM_CONFIG = {"
  if [ -n "$URL" ]; then
    echo "  webhookUrl: '${URL}',"
  else
    echo "  webhookUrl: null,"
  fi
  if [ -n "$ARTISTS" ]; then
    echo "  artists: ${ARTISTS}"
  else
    echo "  artists: null"
  fi
  echo "};"
} > "$TARGET"

echo "[wm-booking] config written: webhook=${URL:-<unset>} artists=${ARTISTS:+<set>}${ARTISTS:-<defaults>}"
