# WayMaker Ink — Appointment Request, UAT
#
# A standalone copy of the booking app, carrying the piercing build while it is
# tested. Production is built from ../../waymaker-booking/ and shares nothing
# with this folder.
#
# ⚠ These two trees WILL drift, by design and by definition — that is what this
# folder is for. When a change here is accepted, port it deliberately; see
# README.md, "Promoting to production".

FROM nginx:1.27-alpine

# Rendered by docker-entrypoint-uat.sh, NOT by the image's own
# 20-envsubst-on-templates.sh — which is why it lands outside
# /etc/nginx/templates/. That script substitutes every environment variable it
# finds and would eat nginx's own $uri, $request_uri and
# $proxy_add_x_forwarded_for.
COPY nginx.conf.template /etc/nginx/wm/nginx.conf.template

COPY public/ /usr/share/nginx/html/

# 35 renders the nginx config, the basic-auth file and robots.txt. Numbered
# above the image's own 30-tune-worker-processes.sh rather than beside it.
# 40 writes config.js from the environment — a copy of production's entrypoint,
# taken at the time this folder was created.
COPY docker-entrypoint-uat.sh /docker-entrypoint.d/35-uat-config.sh
COPY docker-entrypoint.sh     /docker-entrypoint.d/40-webhook-url.sh

RUN chmod +x /docker-entrypoint.d/35-uat-config.sh \
             /docker-entrypoint.d/40-webhook-url.sh

EXPOSE 80

# 127.0.0.1, not localhost. /etc/hosts maps localhost to both 127.0.0.1 and
# ::1, busybox wget tries the IPv6 address first, and nginx listens only on
# 0.0.0.0:80 — so `localhost` is refused and the container reports unhealthy
# while serving traffic perfectly well. Dokploy gates deploys on this.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
