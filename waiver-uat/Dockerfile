# WayMaker Ink — Client Consent Forms
# Static site plus a single authenticated proxy route. No build step.

FROM nginx:1.27-alpine

# The template lands outside /etc/nginx/templates/ on purpose — see the header
# comment in nginx.conf.template. Our entrypoint renders it; the image's own
# 20-envsubst-on-templates.sh must not.
COPY nginx.conf.template /etc/nginx/wm/nginx.conf.template
COPY public/ /usr/share/nginx/html/
COPY docker-entrypoint.sh /docker-entrypoint.d/40-waiver-config.sh

RUN chmod +x /docker-entrypoint.d/40-waiver-config.sh

EXPOSE 80

# 127.0.0.1, not localhost. /etc/hosts maps localhost to both 127.0.0.1 and
# ::1, busybox wget tries the IPv6 address first, and nginx listens only on
# 0.0.0.0:80 — so `localhost` is refused and the container reports unhealthy
# while serving traffic perfectly well. Dokploy gates deploys on this.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
