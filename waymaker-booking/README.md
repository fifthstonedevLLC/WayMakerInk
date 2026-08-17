# WayMaker Ink — Appointment Request

Standalone static app. Dark theme matched to the waiver forms, but with no
runtime dependency on them. No build step, no framework.

```
waymaker-booking/
├── public/
│   ├── index.html                      # all four views (chooser / form / unavailable / success)
│   ├── styles.css                      # theme + components, self-contained
│   ├── app.js                          # routing, uploads, validation, submit
│   ├── config.js                       # ← rewritten at container start from env
│   └── WaymakerInk_Logo_transparent.png  ← copy this in before first deploy
├── n8n/                                # the workflow side: Code nodes + email templates
│   ├── nodes/                          # paste these into n8n Code nodes
│   ├── templates/                      # paste these into Send Email / Respond nodes
│   ├── BUILD-SHEET.md                  # node-by-node build order
│   └── README.md                       # why the three workflows are split
├── nginx.conf
├── Dockerfile
├── docker-entrypoint.sh
└── README.md
```

## Run it locally

```bash
node dev-server.js                  # http://localhost:8080
```

No dependencies, Node 18+. Stands in for nginx: it reproduces
`try_files $uri $uri/ /index.html`, so `/nic` and `/laynie` resolve the way
they will in production, and serves `/healthz`.

To exercise the env-driven config, set the variables and it runs the **real**
`docker-entrypoint.sh` to generate `config.js` — the same code path that ships,
rather than a reimplementation that can drift:

```bash
WM_ARTISTS='{"nic":{"enabled":true,"name":"Nic Sinnwell"},"laynie":{"enabled":true,"name":"Laynie Joy"}}' \
  node dev-server.js
```

The generated config is held in memory and served for `/config.js`; the tracked
`public/config.js` is never overwritten. With no `WM_*` set, that committed
file is served as-is.

It is **not** nginx — cache headers, gzip and the security headers in
`nginx.conf` aren't reproduced. Verify those against the container:

```bash
docker build -t wm-booking . && docker run --rm -p 8080:80 \
  -e WM_WEBHOOK_URL=https://booking.waymakerink.com/webhook/booking-request \
  wm-booking
```

## Before first deploy

1. **Copy the logo** into `public/` — `WaymakerInk_Logo_transparent.png`, the
   same file the waiver app uses.
2. **Set the environment variables** in Dokploy (below). No code edit needed;
   they're injected into `config.js` at container start.

## Routes

| Path      | Renders |
|-----------|---------|
| `/nic`    | Nic's request form |
| `/laynie` | Laynie's form when she's enabled — otherwise a "not taking requests" page |
| `/`       | Goes straight to the only enabled artist. Becomes a chooser card grid automatically once a second artist is enabled. |
| `?artist=nic` | Also honoured, useful for testing |
| anything else | The same "not taking requests" page |

nginx rewrites everything to `index.html`; `app.js` reads the last path segment.

**A named artist is never silently swapped.** If the URL asks for someone who
is disabled or unknown, the page says so rather than falling through to
whoever happens to be live — a request filed against the wrong artist looks
exactly like a working submission to everyone involved.

## Adding Laynie

Edit `WM_ARTISTS` in Dokploy — no code change, no image rebuild:

```json
{"nic":{"enabled":true,"name":"Nic Sinnwell"},
 "laynie":{"enabled":true,"name":"Laynie Joy"}}
```

`/laynie` starts working and `/` turns into a two-card chooser on its own.
Her Acuity tier links, rates and email live in n8n, not here — this app only
collects the request. The `DEFAULT_ARTISTS` block in `app.js` is the local-dev
fallback and the shape reference; production values come from the environment.

## Dokploy setup

1. **New Application** → source: this Git repo (or upload).
2. **Build type:** Dockerfile. Nothing else to configure — no build command,
   no install step.
3. **Port:** `80`
4. **Environment variables:**
   ```
   WM_WEBHOOK_URL=https://<your-n8n-host>/webhook/booking-request
   WM_ARTISTS={"nic":{"enabled":true,"name":"Nic Sinnwell"}}
   ```
   `/webhook/`, not `/webhook-test/` — a test URL accepts one request and only
   while the n8n editor is open, so the form works once and then silently stops.
   `WM_ARTISTS` is optional; without it `app.js` uses its built-in defaults.
   (`WEBHOOK_URL` is still accepted as the old name for the first variable.)
5. **Domain:** `booking.waymakerink.com` → enable HTTPS (Let's Encrypt).
6. Point an `A` record for `booking` at the Dokploy host — the same IP your n8n
   instance resolves to, if both run on the one VPS.

⚠ **Create the DNS record before adding the domain in Dokploy.** If the
hostname doesn't resolve yet you get `queryA ENOTFOUND booking.waymakerink.com`,
and the failure outlives the fix: resolvers cache the negative answer (this
zone's SOA gives it a 300s TTL), so a retry inside that window fails again with
a record that is already correct. Let's Encrypt also rate-limits failed
validations at roughly 5 per hostname per hour — worth not burning them on a
DNS problem.

Health check is at `/healthz`.

## CORS

The form POSTs cross-origin (`booking.waymakerink.com` → n8n host), so the n8n
Webhook node must return CORS headers. In the node's options set **Allowed
Origins** to `https://booking.waymakerink.com`.

Without this the `fetch()` fails silently while a plain form POST still works —
which makes it look like a JS bug rather than a CORS one. If submits fail with
no error in the n8n log, check this first.

## What the webhook receives

`multipart/form-data`:

| Field | Notes |
|---|---|
| `rid` | `WMI-…` — generated client-side, stable across retries |
| `artist` | `nic` / `laynie` — route-derived |
| `artistName` | `Nic Sinnwell` |
| `firstName`, `lastName`, `email`, `phone` | |
| `firstTattoo` | Yes / No |
| `idea`, `placement`, `size`, `style` | |
| `budget`, `timing` | optional |
| `ageConfirm` | `yes` |
| `submittedAt` | ISO 8601 |
| `pageUrl` | full URL as submitted |
| `reference1`…`reference5` | JPEG binary, ≤1600px long edge |
| `referenceCount` | integer |

## Notes on the implementation

- **Images are resized client-side** to 1600px / JPEG 0.82 before upload.
  Five phone photos land around 1–2 MB total, well under n8n's ~16 MB webhook
  payload cap. Raising `N8N_PAYLOAD_SIZE_MAX` is not required.
- **Submit retries** up to three times with exponential backoff — this gets
  filled out on phones with poor signal. Requests carry a 30s `AbortController`
  deadline, because a stalled connection otherwise never settles the promise
  and the client waits on "Sending…" forever. 4xx responses are not retried;
  the same bytes would be rejected again.
- **A stable `rid`** is generated once per page load and reused across retries,
  so a submission that times out and is resent is identifiable as the same
  request rather than appearing as a second one under a new id.
- **Progressive enhancement is partial.** The `<form>` carries a real
  `action`/`method`/`enctype`, so a submission still POSTs if `app.js` fails to
  load — but the file input has no `name`, so **no images are sent**, there's
  no `referenceCount`, and the browser lands on n8n's raw JSON response. It
  degrades to a text-only request, not a graceful one.
- **Honeypot** field (`company`) — filled means bot; the app fakes success and
  sends nothing. Stripped from the payload otherwise. No captcha, deliberately:
  every request is human-reviewed before anything is booked.
- **`noindex`** is set — this is a linked destination, not a landing page.
