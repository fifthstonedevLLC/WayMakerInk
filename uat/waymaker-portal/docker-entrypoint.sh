#!/bin/sh
# ==========================================================================
# WayMaker Ink — admin portal, container start
#
# Renders three things from the environment:
#   /etc/nginx/conf.d/default.conf   from nginx.conf.template
#   /etc/nginx/wm/auth.conf          basic auth, or empty
#   /usr/share/nginx/html/config.js  the Supabase URL and anon key
#
# Everything written into config.js is served to the browser. The anon key
# belongs there — it grants exactly what the RLS policies grant an
# unauthenticated caller, which is nothing. The service-role key does NOT and
# must never be set on this app at all.
# ==========================================================================
set -eu

log() { echo "[portal-config] $*"; }

# --- validate before writing anything ---------------------------------------
# A malformed value here is a syntax error that takes the whole portal down,
# not just the setting it came from — the same reason the booking form's
# entrypoint validates before writing.

SUPABASE_URL="${WM_SUPABASE_URL:-}"
SUPABASE_ANON="${WM_SUPABASE_ANON_KEY:-}"
ENV_LABEL="${WM_ENV_LABEL:-}"

case "$SUPABASE_URL" in
  https://*) ;;
  '')
    log "FATAL: WM_SUPABASE_URL is not set. The portal cannot start without it."
    exit 1
    ;;
  # Plaintext to the loopback only — the `npx supabase start` stack, which
  # serves on http://127.0.0.1:54321 with no certificate. Refusing it would
  # mean the only way to run the portal is against a hosted project.
  #
  # ⚠ This value is read by the BROWSER, not by this container: it lands in
  # config.js and supabase-js calls it from the user's machine. So it stays
  # 127.0.0.1 even though the booking form's WM_FUNCTIONS_UPSTREAM, pointing at
  # the same stack, has to be host.docker.internal. Same service, two
  # hostnames, because two different things do the resolving.
  http://127.0.0.1:*|http://localhost:*)
    log "NOTE: WM_SUPABASE_URL is plaintext http to the loopback — local development only"
    ;;
  *)
    log "FATAL: WM_SUPABASE_URL must be an https:// URL (http:// is allowed only for 127.0.0.1 / localhost). Got: $SUPABASE_URL"
    exit 1
    ;;
esac

# Trailing slash removed: supabase-js appends its own paths and a doubled slash
# 404s on some of them.
SUPABASE_URL="${SUPABASE_URL%/}"

if [ -z "$SUPABASE_ANON" ]; then
  log "FATAL: WM_SUPABASE_ANON_KEY is not set."
  exit 1
fi

# A service-role key pasted into the anon slot would give every visitor full
# database access with RLS bypassed, in a file served to the public. It is the
# single worst configuration mistake available here, and the two keys sit next
# to each other on the same dashboard page — so this checks rather than trusts.
#
# ⚠ Grepping the raw key for "service_role" does NOT work, however obvious it
# looks. A Supabase JWT is header.payload.signature with the payload base64url
# encoded, so the literal string never appears in the token — such a check
# passes every key, including the one it exists to catch.
#
# Two key formats to handle:
#   sb_secret_… / sb_publishable_…   the newer opaque format, checked by prefix
#   eyJ….eyJ….sig                    the JWT format, whose payload is decoded
looks_like_secret=no

case "$SUPABASE_ANON" in
  sb_secret_*)
    looks_like_secret=yes
    ;;
  *.*.*)
    # base64url -> base64 (tr), then pad to a multiple of 4, then decode.
    # Failure to decode is not an error: an unrecognised key shape is caught by
    # Supabase at the first request, and refusing to boot over one would be a
    # guess dressed up as a check.
    payload=$(printf '%s' "$SUPABASE_ANON" | cut -d. -f2 | tr '_-' '/+')
    case $(( ${#payload} % 4 )) in
      2) payload="${payload}==" ;;
      3) payload="${payload}=" ;;
    esac
    if printf '%s' "$payload" | base64 -d 2>/dev/null | grep -q 'service_role'; then
      looks_like_secret=yes
    fi
    ;;
esac

if [ "$looks_like_secret" = yes ]; then
  log "FATAL: WM_SUPABASE_ANON_KEY is a SERVICE ROLE key."
  log "       That key bypasses every RLS policy, and this value is written"
  log "       into /config.js, which is served to every visitor."
  log "       Use the 'anon' / 'public' key from Project Settings -> API."
  exit 1
fi

# Values land inside a JavaScript string literal. A quote or a backslash would
# end it early and turn the rest of the file into syntax errors.
for value in "$SUPABASE_URL" "$SUPABASE_ANON" "$ENV_LABEL"; do
  case "$value" in
    *\'*|*\\*|*'<'*)
      log "FATAL: a config value contains a quote, backslash or angle bracket."
      exit 1
      ;;
  esac
done

# --- config.js ---------------------------------------------------------------
cat > /usr/share/nginx/html/config.js <<EOF
/* Generated at container start. Do not edit — see docker-entrypoint.sh. */
window.WM_PORTAL_CONFIG = {
  supabaseUrl: '${SUPABASE_URL}',
  supabaseAnonKey: '${SUPABASE_ANON}',
  envLabel: '${ENV_LABEL}'
};
EOF

log "config.js written · supabase=${SUPABASE_URL} · label=${ENV_LABEL:-none}"

# --- basic auth --------------------------------------------------------------
# A second lock in front of the whole site, on top of the Supabase login. Not a
# substitute for it: this one is a shared doormat password, and its job is to
# keep the UAT host out of reach of anyone who stumbles on the hostname.
mkdir -p /etc/nginx/wm

if [ -n "${WM_UAT_PASSWORD:-}" ]; then
  user="${WM_UAT_USER:-uat}"

  # ⚠ {PLAIN}, not a hash. There is NO hashing tool in nginx:alpine — no
  # openssl, no htpasswd — so `openssl passwd -apr1` here would fail at
  # container start and take the portal down every time a password was set.
  # The booking form's entrypoint learned this first; both do it the same way.
  #
  # Acceptable because this is a shared doormat whose only job is keeping
  # strangers off an unlisted host. The real credential is the Supabase login
  # behind it. Do not reuse a real password.
  #
  # htpasswd is a colon-separated line and nginx reads {PLAIN} literally, so a
  # colon in either field silently shifts the split and the password stops
  # matching.
  case "$user" in
    *:*|*[[:space:]]*) log "FATAL: WM_UAT_USER must not contain a colon or whitespace"; exit 1 ;;
  esac
  case "$WM_UAT_PASSWORD" in
    *:*|*[[:space:]]*) log "FATAL: WM_UAT_PASSWORD must not contain a colon or whitespace"; exit 1 ;;
  esac

  # printf, not echo: busybox echo interprets backslashes in some builds.
  printf '%s:{PLAIN}%s\n' "$user" "$WM_UAT_PASSWORD" > /etc/nginx/wm/htpasswd

  # ⚠ 640 root:nginx, NOT 600. This script runs as root, but nginx's WORKER
  # processes drop to the `nginx` user and they are what open this file on each
  # request. At 600 every authenticated request fails with
  #   [crit] open() "/etc/nginx/wm/htpasswd" failed (13: Permission denied)
  # and nginx answers 500 on every page. /healthz keeps returning 200 because
  # it has auth_basic off, so the container reports healthy while serving
  # nothing and Dokploy calls the deploy a success.
  chown root:nginx /etc/nginx/wm/htpasswd 2>/dev/null || true
  chmod 640 /etc/nginx/wm/htpasswd

  cat > /etc/nginx/wm/auth.conf <<'EOF'
auth_basic "WayMaker Ink";
auth_basic_user_file /etc/nginx/wm/htpasswd;
EOF
  log "basic auth ON (user: $user)"
else
  rm -f /etc/nginx/wm/htpasswd
  # Always write the file: the template includes it unconditionally, and a
  # missing include is a start-up failure.
  : > /etc/nginx/wm/auth.conf
  log "basic auth OFF"
fi

# --- robots ------------------------------------------------------------------
# The portal shows client contact details and photographs. It is never indexed,
# in any environment.
printf 'User-agent: *\nDisallow: /\n' > /usr/share/nginx/html/robots.txt

# --- nginx -------------------------------------------------------------------
# An explicit variable list, so envsubst leaves nginx's own $uri,
# $request_uri and $proxy_add_x_forwarded_for alone.
export WM_ROBOTS_TAG="${WM_ROBOTS_TAG:-noindex, nofollow}"

envsubst '${WM_ROBOTS_TAG}' \
  < /etc/nginx/wm/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf

log "nginx config rendered"
