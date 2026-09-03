#!/bin/sh
# WayMaker Ink — waiver forms: container start-up configuration.
#
# Runs from nginx's /docker-entrypoint.d/ before the server boots, and does two
# things:
#
#   1. Renders nginx.conf.template -> /etc/nginx/conf.d/default.conf, injecting
#      the n8n webhook URL and the shared secret that authenticates us to it.
#   2. Writes public/config.js with the Turnstile site key.
#
# Environment (set in the Dokploy panel, never committed):
#
#   WM_WAIVER_WEBHOOK_URL   required. Full n8n production webhook URL, e.g.
#                           https://n8n.fifthstonedev.com/webhook/<path>. Must
#                           be /webhook/, not /webhook-test/ — test URLs accept
#                           one request and only while the n8n editor is open.
#   WM_FORM_KEY             required. Shared secret matching the Header Auth
#                           credential on the n8n webhook node. Generate with
#                           `openssl rand -base64 32`.
#   WM_TURNSTILE_SITE_KEY   optional. Cloudflare Turnstile site key for this
#                           domain. Unset disables the widget (see below).
#   WM_ROBOTS_TAG           optional. X-Robots-Tag value. Defaults to
#                           "noindex, nofollow" so a UAT host is never indexed;
#                           production sets it to "all".
#
# FAIL-CLOSED: if a required variable is missing this script exits non-zero
# WITHOUT writing default.conf. The stock nginx welcome-page config is left in
# place, which has no /api/waiver route at all — so a misconfigured deploy
# serves a 404 rather than an unauthenticated open proxy into n8n. That is the
# same posture as cfg() in the booking workflow's Code nodes, which throws
# rather than falling back to a placeholder secret.
set -e

TEMPLATE="${WM_NGINX_TEMPLATE:-/etc/nginx/wm/nginx.conf.template}"
NGINX_TARGET="${WM_NGINX_TARGET:-/etc/nginx/conf.d/default.conf}"
CONFIG_TARGET="${WM_CONFIG_TARGET:-/usr/share/nginx/html/config.js}"

fail() {
  echo "[wm-waiver] FATAL: $1" >&2
  echo "[wm-waiver] Refusing to start. /api/waiver will not be served." >&2
  exit 1
}

# --- Required: the n8n webhook URL ------------------------------------------
# Validated strictly because this string is interpolated into an nginx config.
# A stray semicolon or brace would let a bad environment value inject nginx
# directives; a quote would break out of the proxy_set_header string below.
[ -n "$WM_WAIVER_WEBHOOK_URL" ] || fail "WM_WAIVER_WEBHOOK_URL is not set"
case "$WM_WAIVER_WEBHOOK_URL" in
  http://*|https://*) ;;
  *) fail "WM_WAIVER_WEBHOOK_URL must be an http(s) URL" ;;
esac
case "$WM_WAIVER_WEBHOOK_URL" in
  *[\;\{\}\"\'[:space:]]*) fail "WM_WAIVER_WEBHOOK_URL contains an illegal character" ;;
esac
case "$WM_WAIVER_WEBHOOK_URL" in
  */webhook-test/*)
    fail "WM_WAIVER_WEBHOOK_URL points at /webhook-test/ — that URL accepts one request, and only while the n8n editor is open. Use the production /webhook/ URL."
    ;;
esac

# --- Required: the shared secret --------------------------------------------
# Never echoed. Length check catches an accidentally-truncated paste; the
# character check protects the quoted nginx string it lands in.
[ -n "$WM_FORM_KEY" ] || fail "WM_FORM_KEY is not set"
case "$WM_FORM_KEY" in
  *[\;\{\}\"\'[:space:]]*) fail "WM_FORM_KEY contains an illegal character (no quotes, braces, semicolons or whitespace)" ;;
esac
if [ "${#WM_FORM_KEY}" -lt 20 ]; then
  fail "WM_FORM_KEY is shorter than 20 characters — generate one with: openssl rand -base64 32"
fi

# --- Optional: robots ---------------------------------------------------------
# Defaults to noindex. A UAT host that gets crawled puts a fake-data waiver form
# in search results under the shop's name, so the safe default is the strict one
# and production must opt out explicitly.
WM_ROBOTS_TAG="${WM_ROBOTS_TAG:-noindex, nofollow}"
case "$WM_ROBOTS_TAG" in
  *[\;\{\}\"]*) fail "WM_ROBOTS_TAG contains an illegal character" ;;
esac

# envsubst is a separate process and reads the *environment*, not this shell's
# variables. Without these exports a defaulted value renders as an empty string
# — which for WM_ROBOTS_TAG means the noindex default silently does nothing and
# a UAT host becomes crawlable. Export all three, not just the defaulted one:
# the other two only survive today because the caller happened to export them.
export WM_WAIVER_WEBHOOK_URL WM_FORM_KEY WM_ROBOTS_TAG

# --- Render the nginx config --------------------------------------------------
[ -f "$TEMPLATE" ] || fail "template not found at $TEMPLATE"

# The explicit variable list is load-bearing. A bare `envsubst` substitutes
# every variable it finds, which would blank out nginx's own $uri, $scheme,
# $proxy_host and $binary_remote_addr and produce a config that either fails to
# parse or, worse, parses into something wrong.
envsubst '${WM_WAIVER_WEBHOOK_URL} ${WM_FORM_KEY} ${WM_ROBOTS_TAG}' \
  < "$TEMPLATE" > "$NGINX_TARGET"

# --- Write config.js ----------------------------------------------------------
# Lands in a single-quoted JS string, so a quote or backslash would end the
# literal early and take every form on the site down with a syntax error.
SITE_KEY="${WM_TURNSTILE_SITE_KEY:-}"
if [ -n "$SITE_KEY" ]; then
  case "$SITE_KEY" in
    *[\'\\\"[:space:]]*)
      echo "[wm-waiver] WARNING: WM_TURNSTILE_SITE_KEY contains an illegal character — ignoring it" >&2
      SITE_KEY=""
      ;;
  esac
fi

if [ -z "$SITE_KEY" ]; then
  # Not fatal: the server-side siteverify check in the n8n workflow is the
  # actual control, and it rejects a submission with no token regardless. A
  # missing site key degrades to "nobody can submit", which is loud, visible,
  # and safe — unlike silently accepting unverified submissions.
  echo "[wm-waiver] WARNING: WM_TURNSTILE_SITE_KEY is not set — the widget will not render and submissions will be rejected server-side" >&2
fi

{
  echo "/* Generated at container start by docker-entrypoint.sh. Do not edit. */"
  echo "window.WM_CONFIG = {"
  if [ -n "$SITE_KEY" ]; then
    echo "  turnstileSiteKey: '${SITE_KEY}'"
  else
    echo "  turnstileSiteKey: null"
  fi
  echo "};"
} > "$CONFIG_TARGET"

# The webhook URL is logged (it is not a secret once the header auth is what
# actually gates it); the key is never printed, only confirmed present.
echo "[wm-waiver] config written: webhook=${WM_WAIVER_WEBHOOK_URL} key=<set> turnstile=${SITE_KEY:-<unset>} robots=${WM_ROBOTS_TAG}"
