#!/bin/sh
# WayMaker Ink — Appointment Request, UAT: container start-up configuration.
#
# Runs from nginx's /docker-entrypoint.d/ as 35-uat-config.sh, before
# production's own entrypoint (installed as 40-webhook-url.sh) writes
# config.js. Three jobs, none of which production has:
#
#   1. Render uat/nginx.conf.template -> /etc/nginx/conf.d/default.conf.
#   2. Write /etc/nginx/wm/auth.conf — the basic-auth directives, or nothing.
#   3. Write robots.txt.
#
# Environment (Dokploy panel; see uat/.env.example for the annotated set):
#
#   WM_UAT_LABEL      optional. Text in the corner flag. Default "UAT" when
#                     UNSET. Set it to an empty string — or to "none" for panels
#                     that cannot express empty — to remove the flag entirely,
#                     which is what this image needs when it serves production.
#                     Empty removes the directive; it does not paint a blank
#                     flag.
#   WM_ROBOTS_TAG     optional. X-Robots-Tag value. Default "noindex, nofollow".
#                     There is no reason for UAT to ever set this to anything
#                     else; it exists so the value is not a literal in the
#                     template.
#   WM_UAT_USER       optional. Basic-auth username. Default "uat".
#   WM_UAT_PASSWORD   optional. Set it to put the whole site behind a password;
#                     leave it unset for an open (but unlisted and noindexed)
#                     host. /healthz, /webhook/ and /webhook-test/ are never
#                     gated — an artist's decision link arrives from a mail
#                     client that cannot answer a challenge.
#   WM_N8N_UPSTREAM   optional. scheme://host:port of the n8n container.
#                     Defaults to the same one production proxies to.
#
# FAIL-CLOSED: on a bad value this exits non-zero WITHOUT writing default.conf.
# The image's own entrypoint runs with `set -e`, so the container never starts,
# the healthcheck never passes, and Dokploy reports a failed deploy. That is
# the intended outcome — a UAT host serving the form with no flag and no
# noindex is worse than one serving nothing.
set -e

TEMPLATE="${WM_NGINX_TEMPLATE:-/etc/nginx/wm/nginx.conf.template}"
NGINX_TARGET="${WM_NGINX_TARGET:-/etc/nginx/conf.d/default.conf}"
AUTH_TARGET="${WM_AUTH_TARGET:-/etc/nginx/wm/auth.conf}"
HTPASSWD_TARGET="${WM_HTPASSWD_TARGET:-/etc/nginx/wm/htpasswd}"
ROBOTS_TARGET="${WM_ROBOTS_TARGET:-/usr/share/nginx/html/robots.txt}"

fail() {
  echo "[wm-uat] FATAL: $1" >&2
  echo "[wm-uat] Refusing to start." >&2
  exit 1
}

# --- The corner flag ----------------------------------------------------------
# Lands inside a single-quoted nginx string that is itself inside an HTML
# attribute soup, so a quote, angle bracket or backslash would either break the
# config or inject markup into every page.
#
# `-` and not `:-`, so an explicitly EMPTY value is honoured rather than falling
# back to "UAT". That distinction is what lets this image serve production: the
# flag is a sub_filter that fires on every page unconditionally, so an empty
# label without the removal below renders a blank red box in the corner forever
# rather than no box.
#
# Unset still means "UAT". A UAT deploy that forgets the variable gets flagged,
# which is the direction this should fail in — an unflagged UAT looks exactly
# like production, and that is how someone sends a real client a test link.
#
# `none` is accepted as an alias because some deployment panels cannot express
# "set, but empty" and silently drop the variable instead.
WM_UAT_LABEL="${WM_UAT_LABEL-UAT}"
[ "$WM_UAT_LABEL" = "none" ] && WM_UAT_LABEL=""

case "$WM_UAT_LABEL" in
  *[\'\"\<\>\\\;]*) fail "WM_UAT_LABEL contains an illegal character (no quotes, angle brackets, backslashes or semicolons)" ;;
esac

# --- Robots -------------------------------------------------------------------
WM_ROBOTS_TAG="${WM_ROBOTS_TAG:-noindex, nofollow}"
case "$WM_ROBOTS_TAG" in
  *[\;\{\}\"]*) fail "WM_ROBOTS_TAG contains an illegal character" ;;
esac

# --- The n8n upstream ---------------------------------------------------------
# Interpolated into an nginx `set` directive, so it is validated as strictly as
# the waiver app validates its webhook URL: a stray semicolon or brace here
# would let an environment value inject nginx directives.
WM_N8N_UPSTREAM="${WM_N8N_UPSTREAM:-http://n8n-automations-n8nrunnerpostgresollama-egxbst-n8n-1:5678}"
case "$WM_N8N_UPSTREAM" in
  http://*|https://*) ;;
  *) fail "WM_N8N_UPSTREAM must be an http(s) URL" ;;
esac
case "$WM_N8N_UPSTREAM" in
  *[\;\{\}\"\'[:space:]]*) fail "WM_N8N_UPSTREAM contains an illegal character" ;;
esac
case "$WM_N8N_UPSTREAM" in
  */) fail "WM_N8N_UPSTREAM must not end in a slash — the path comes from \$request_uri" ;;
esac

# --- The Host header sent upstream --------------------------------------------
# An internal container upstream does not care what Host says, and production
# passes the client's through. An external https upstream — the hosted n8n
# behind Traefik — is routed BY Host and SNI, so passing "localhost:8080" gets
# a 404 from Traefik rather than anything from n8n. Derive it instead of adding
# a variable that has to agree with WM_N8N_UPSTREAM by hand.
case "$WM_N8N_UPSTREAM" in
  https://*)
    WM_N8N_HOST=$(printf '%s' "$WM_N8N_UPSTREAM" | sed -e 's|^https://||' -e 's|/.*$||')
    [ -n "$WM_N8N_HOST" ] || fail "could not read a hostname out of WM_N8N_UPSTREAM"
    ;;
  *)
    # The literal string, for nginx to expand per-request. envsubst does not
    # recurse, so this reaches the config as $host and not as its value here.
    WM_N8N_HOST='$host'
    ;;
esac

# --- The Supabase functions upstream ------------------------------------------
# Where /api/intake is proxied. The form cannot submit anything without it, so
# this fails closed rather than defaulting: a booking form that renders and
# silently drops every request is the worst outcome available here.
#
# Value is the project origin with no path and no trailing slash, e.g.
# https://abcdefghijklm.supabase.co — the /functions/v1/intake part is in the
# template.
WM_FUNCTIONS_UPSTREAM="${WM_FUNCTIONS_UPSTREAM:-}"
[ -n "$WM_FUNCTIONS_UPSTREAM" ] || fail "WM_FUNCTIONS_UPSTREAM is not set — the form has nowhere to submit to"
case "$WM_FUNCTIONS_UPSTREAM" in
  https://*) ;;
  # Plaintext is allowed to the loopback and to the Docker host, and nowhere
  # else. That is the `npx supabase start` stack, which serves on
  # http://127.0.0.1:54321 and has no certificate — refusing it would mean the
  # only way to run this locally is against a hosted project. Client requests
  # still arrive over TLS; this is the hop from nginx to a service on the same
  # machine. Any other http:// host is a real submission crossing a network in
  # the clear, carrying a name, an email and a phone number.
  http://127.0.0.1:*|http://localhost:*|http://host.docker.internal:*)
    echo "[wm-uat] NOTE: WM_FUNCTIONS_UPSTREAM is plaintext http to a local address — local development only" >&2
    ;;
  *) fail "WM_FUNCTIONS_UPSTREAM must be an https:// URL (http:// is allowed only for localhost / host.docker.internal)" ;;
esac
case "$WM_FUNCTIONS_UPSTREAM" in
  *[\;\{\}\"\'[:space:]]*) fail "WM_FUNCTIONS_UPSTREAM contains an illegal character" ;;
esac
case "$WM_FUNCTIONS_UPSTREAM" in
  */) fail "WM_FUNCTIONS_UPSTREAM must not end in a slash" ;;
esac
case "$WM_FUNCTIONS_UPSTREAM" in
  */functions/*) fail "WM_FUNCTIONS_UPSTREAM is the project ORIGIN only — the /functions/v1/ path is in the template" ;;
esac

# Supabase's edge router selects the project by Host and SNI, so this is
# derived rather than being a second variable that has to agree by hand.
# Both schemes are stripped: the http:// case is the local stack, where the
# Host header does not select anything but still has to be a hostname rather
# than a whole URL.
WM_FUNCTIONS_HOST=$(printf '%s' "$WM_FUNCTIONS_UPSTREAM" | sed -e 's|^https\{0,1\}://||' -e 's|/.*$||')
[ -n "$WM_FUNCTIONS_HOST" ] || fail "could not read a hostname out of WM_FUNCTIONS_UPSTREAM"

# --- DNS ----------------------------------------------------------------------
# Docker's embedded resolver, which exists for containers on a user-defined
# network — which is what Dokploy gives every app. On a plain `docker run` with
# no --network there is nothing at 127.0.0.11 and every proxied request fails,
# so local use against the hosted n8n wants a public resolver instead.
WM_RESOLVER="${WM_RESOLVER:-127.0.0.11}"
case "$WM_RESOLVER" in
  *[\;\{\}\"\'\$]*) fail "WM_RESOLVER contains an illegal character" ;;
esac

# envsubst is a separate process and reads the *environment*, not this shell's
# variables. Without these exports a defaulted value renders as an empty string
# — which for WM_ROBOTS_TAG means the noindex default silently does nothing and
# a UAT booking form becomes crawlable, and for WM_N8N_UPSTREAM means `set $n8n ;`
# and a config that will not parse.
export WM_UAT_LABEL WM_ROBOTS_TAG WM_N8N_UPSTREAM WM_N8N_HOST WM_RESOLVER
export WM_FUNCTIONS_UPSTREAM WM_FUNCTIONS_HOST

# --- Basic auth ---------------------------------------------------------------
# Always write the file: the template includes it unconditionally, and a
# missing include is a start-up failure.
mkdir -p "$(dirname "$AUTH_TARGET")"

if [ -n "${WM_UAT_PASSWORD:-}" ]; then
  WM_UAT_USER="${WM_UAT_USER:-uat}"

  # htpasswd is a colon-separated line, and nginx reads {PLAIN} literally, so a
  # colon in either field silently shifts the split and the password stops
  # matching. There is no hashing tool in nginx:alpine — no openssl, no
  # htpasswd — hence {PLAIN}, which is fine for a value whose only job is
  # keeping strangers off a test host. Do not reuse a real password here.
  case "$WM_UAT_USER" in
    *[:[:space:]]*) fail "WM_UAT_USER must not contain a colon or whitespace" ;;
  esac
  case "$WM_UAT_PASSWORD" in
    *[:[:space:]]*) fail "WM_UAT_PASSWORD must not contain a colon or whitespace" ;;
  esac

  printf '%s:{PLAIN}%s\n' "$WM_UAT_USER" "$WM_UAT_PASSWORD" > "$HTPASSWD_TARGET"

  # ⚠ 640 root:nginx, NOT 600. This entrypoint runs as root, but nginx's WORKER
  # processes drop to the `nginx` user and they are what open this file on each
  # request. At 600 every authenticated request fails with
  #   [crit] open() "/etc/nginx/wm/htpasswd" failed (13: Permission denied)
  # and nginx answers 500 — on every page, including the ones that worked a
  # moment earlier without a password set. /healthz keeps returning 200 because
  # it has auth_basic off, so the container reports healthy while serving
  # nothing, and Dokploy calls the deploy a success.
  chown root:nginx "$HTPASSWD_TARGET" 2>/dev/null || true
  chmod 640 "$HTPASSWD_TARGET"

  {
    echo '# Generated at container start by docker-entrypoint-uat.sh.'
    echo 'auth_basic "WayMaker Ink — UAT";'
    echo "auth_basic_user_file ${HTPASSWD_TARGET};"
  } > "$AUTH_TARGET"

  AUTH_STATE="on (user=${WM_UAT_USER})"
else
  rm -f "$HTPASSWD_TARGET"
  {
    echo '# Generated at container start by docker-entrypoint-uat.sh.'
    echo '# WM_UAT_PASSWORD is unset, so the site is open. Unlisted and'
    echo '# noindexed, but anyone holding the URL can submit a request.'
  } > "$AUTH_TARGET"

  AUTH_STATE="off"

  # Only a warning where it is actually wrong. A production booking form is
  # MEANT to be open — clients have no login — so warning there would fire on
  # every start, be correct never, and teach whoever reads these logs to skip
  # the line. The corner flag is the tell: if this deploy is labelled, it is not
  # production, and an unauthenticated copy of it is worth shouting about.
  if [ -n "$WM_UAT_LABEL" ]; then
    echo "[wm-uat] WARNING: WM_UAT_PASSWORD is not set — this ${WM_UAT_LABEL} form is reachable by anyone with the URL" >&2
  else
    echo "[wm-uat] basic auth off — public form, as production expects"
  fi
fi

# --- robots.txt ---------------------------------------------------------------
# Overwrites anything of that name in public/, deliberately: production may
# grow a permissive robots.txt one day, and inheriting it here is exactly the
# accident this file prevents.
printf 'User-agent: *\nDisallow: /\n' > "$ROBOTS_TARGET"

# --- Render the nginx config --------------------------------------------------
[ -f "$TEMPLATE" ] || fail "template not found at $TEMPLATE"

# The explicit variable list is load-bearing. A bare `envsubst` substitutes
# every variable it finds, which would blank out nginx's own $uri, $request_uri,
# $proxy_add_x_forwarded_for and $n8n and produce a config that either fails to
# parse or, worse, parses into something wrong.
envsubst '${WM_UAT_LABEL} ${WM_ROBOTS_TAG} ${WM_N8N_UPSTREAM} ${WM_N8N_HOST} ${WM_RESOLVER} ${WM_FUNCTIONS_UPSTREAM} ${WM_FUNCTIONS_HOST}' \
  < "$TEMPLATE" > "$NGINX_TARGET"

# An empty label means no flag at all, not an empty flag. The sub_filter in the
# template is unconditional, so the only way to switch it off is to take the
# directive out of the rendered config — leaving it with an empty label paints a
# blank red rectangle over the corner of every page.
#
# Matched on the id, which appears nowhere else in the template. sub_filter_once
# is left in place: harmless on its own, and removing a second line is a second
# thing to get wrong.
if [ -z "$WM_UAT_LABEL" ]; then
  sed -i '/id="wm-uat-flag"/d' "$NGINX_TARGET"
  grep -q 'id="wm-uat-flag"' "$NGINX_TARGET" && fail "could not remove the corner flag from the rendered config"
  FLAG_STATE="off (production)"
else
  FLAG_STATE="$WM_UAT_LABEL"
fi

echo "[wm-uat] config written: flag=${FLAG_STATE} robots=${WM_ROBOTS_TAG} auth=${AUTH_STATE}"
echo "[wm-uat] n8n:       ${WM_N8N_UPSTREAM} host=${WM_N8N_HOST} resolver=${WM_RESOLVER}"
echo "[wm-uat] functions: ${WM_FUNCTIONS_UPSTREAM} host=${WM_FUNCTIONS_HOST}"
