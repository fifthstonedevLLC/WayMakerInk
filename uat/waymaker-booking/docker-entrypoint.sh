#!/bin/sh
# Writes public/config.js from the environment at container start, so the same
# image ships to every environment. Runs from nginx's /docker-entrypoint.d/
# before the server boots.
#
#   WM_WEBHOOK_URL  production intake webhook. Must be /webhook/, not
#                   /webhook-test/ — test URLs accept one request and only
#                   while the n8n editor is open.
#   WM_ARTISTS      JSON object, artist key ->
#                     { enabled, name, pronoun, services, headline, blurb }
#                   Every key is optional except enabled; app.js fills the rest
#                   from its own DEFAULT_ARTISTS for a key it recognises.
#                     pronoun  "he" | "she" | "they"  — used in the service
#                              subtitles. Defaults to "they" for an artist this
#                              file does not already know, which reads correctly
#                              for anyone rather than guessing from a name.
#                     services subset of tattoo, piercing, touchup.
#                   e.g. {"nic":{"enabled":true,"name":"Nic Sinnwell"}}
#                   Adding an artist is an edit here, not a code change.
#   WM_HOME_URL     where the confirmation page returns to. Default
#                   https://waymakerink.com.
#   WM_REDIRECT_SECONDS
#                   how long the client gets to read the confirmation first.
#                   Default 20. Set 0 to switch the auto-return off entirely.
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
HOME_URL="${WM_HOME_URL:-}"
REDIRECT_SECONDS="${WM_REDIRECT_SECONDS:-}"

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

# Written into a single-quoted JS string, so an embedded quote would end the
# literal early and break config.js — same class of failure as a malformed
# WM_ARTISTS, and the same response: drop it and let app.js use its default.
if [ -n "$HOME_URL" ]; then
  case "$HOME_URL" in
    *\'*)
      echo "[wm-booking] WARNING: WM_HOME_URL contains a quote — ignoring it"
      HOME_URL=""
      ;;
    http://*|https://*) ;;
    *)
      echo "[wm-booking] WARNING: WM_HOME_URL is not an http(s) URL — ignoring it"
      HOME_URL=""
      ;;
  esac
fi

# Digits only. Rejects negatives and decimals along with everything else, so a
# typo can't emit a bare word into config.js and take the form down. 0 is a
# legitimate value here — it means "no auto-return".
if [ -n "$REDIRECT_SECONDS" ]; then
  case "$REDIRECT_SECONDS" in
    ''|*[!0-9]*)
      echo "[wm-booking] WARNING: WM_REDIRECT_SECONDS is not a whole number — ignoring it"
      REDIRECT_SECONDS=""
      ;;
  esac
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
    echo "  artists: ${ARTISTS},"
  else
    echo "  artists: null,"
  fi
  if [ -n "$HOME_URL" ]; then
    echo "  homeUrl: '${HOME_URL}',"
  else
    echo "  homeUrl: null,"
  fi
  # null, not 0 — app.js reads null as "no preference" and uses its default,
  # where 0 is the explicit off switch.
  echo "  redirectSeconds: ${REDIRECT_SECONDS:-null}"
  echo "};"
} > "$TARGET"

echo "[wm-booking] config written: webhook=${URL:-<unset>} artists=${ARTISTS:+<set>}${ARTISTS:-<defaults>} home=${HOME_URL:-<default>} redirect=${REDIRECT_SECONDS:-<default>}"
