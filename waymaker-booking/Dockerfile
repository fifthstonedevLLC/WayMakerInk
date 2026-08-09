# WayMaker Ink — Appointment Request
# Static app, nginx. No build step.

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
COPY docker-entrypoint.sh /docker-entrypoint.d/40-webhook-url.sh

RUN chmod +x /docker-entrypoint.d/40-webhook-url.sh

EXPOSE 80

# 127.0.0.1, not localhost. /etc/hosts maps localhost to both 127.0.0.1 and
# ::1, busybox wget tries the IPv6 address first, and nginx listens only on
# 0.0.0.0:80 — so `localhost` is refused and the container reports unhealthy
# while serving traffic perfectly well. Dokploy gates deploys on this.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
