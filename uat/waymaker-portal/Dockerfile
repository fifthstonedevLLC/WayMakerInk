# WayMaker Ink — admin portal, UAT
#
# Two stages. Unlike the booking app — which is static files copied straight
# into nginx — this one has a build, so the image is bigger and the deploy is
# slower. That is the cost of the React/TS choice and it is paid here, once,
# rather than in the runtime.
#
# ⚠ Nothing environment-specific is baked in. No VITE_* variables, no Supabase
# URL, no anon key: the entrypoint writes /config.js at container start, the
# same way the booking form's does. One image runs UAT and production.

# --------------------------------------------------------------------- build ---
FROM node:22-alpine AS build

WORKDIR /app

# Copied first so a source-only change reuses the cached install layer.
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile exists (reproducible), `npm install` when one does
# not (first run, before the lockfile is committed).
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json vite.config.ts index.html ./
COPY public/ ./public/
COPY src/ ./src/

# `npm run build` runs tsc --noEmit first, so a type error fails the image
# rather than shipping a portal that throws in the artist's browser.
RUN npm run build


# --------------------------------------------------------------------- serve ---
FROM nginx:1.27-alpine

COPY nginx.conf.template /etc/nginx/wm/nginx.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# 35 renders the nginx config, the basic-auth file and robots.txt; 40 writes
# config.js. Numbered above the image's own 30-tune-worker-processes.sh, and
# outside /etc/nginx/templates/ so the image's 20-envsubst script does not eat
# nginx's own $uri and $request_uri.
COPY docker-entrypoint.sh /docker-entrypoint.d/35-portal-config.sh
RUN chmod +x /docker-entrypoint.d/35-portal-config.sh

EXPOSE 80

# 127.0.0.1, not localhost: /etc/hosts maps localhost to ::1 as well, busybox
# wget tries the IPv6 address first, and nginx listens only on 0.0.0.0:80 — so
# `localhost` is refused and the container reports unhealthy while serving
# traffic perfectly well. Dokploy gates deploys on this.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
