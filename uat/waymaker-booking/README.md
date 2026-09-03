# Booking form — UAT

**A full copy of the booking app, carrying the piercing build, the touch-up
service, and the move off n8n onto Supabase.** Production lives in
[`../../waymaker-booking/`](../../waymaker-booking/) and shares no files with
this folder.

The two trees will drift. That is the point of the copy — nothing here can
reach a client until someone deliberately ports it — but it is also the cost,
so the differences are written down below rather than left to be discovered.

---

## ⚠ Read this first

**This form no longer submits to n8n.** It POSTs to `/api/intake`, which nginx
proxies to the Supabase `intake` Edge Function. The record is a row in
`public.requests`, the photos are objects in the `request-refs` bucket, and the
artist decides in the admin portal rather than from links in an email.

The architecture, the runbook and the smoke tests are in
[`../PORTAL-INITIATIVE.md`](../PORTAL-INITIATIVE.md). Read that before this.

Two consequences for what follows:

- **The n8n Code nodes that used to live here are gone.** Their logic was
  ported into [`../supabase/functions/`](../supabase/functions/); the UAT-only
  piercing work moved to `../../waymaker-booking/n8n/uat-piercing/`.
- **`WM_WEBHOOK_URL` is now a relative path** (`/api/intake`), and
  `WM_FUNCTIONS_UPSTREAM` is a new required variable. See
  [`.env.example`](.env.example).

---

## Layout

```
uat/waymaker-booking/
├── Dockerfile                  build context is THIS folder
├── nginx.conf.template         production's nginx.conf + noindex + UAT flag
│                               + the /api/intake proxy to Supabase
├── docker-entrypoint-uat.sh    renders the config, auth file, robots.txt
├── docker-entrypoint.sh        copy of production's — writes config.js
├── .env.example
└── public/                     the app, with piercing and touch-ups
```

---

## What differs from production, right now

### `public/` — the piercing build (BUILD Step 1)

| | Change |
|---|---|
| `app.js` | `services` on each artist (1.1), defaulting to `['tattoo']`; service routing; panel show/hide with clear-on-exit; the pair rule; the minor branches; service-aware validation |
| `index.html` | Hero service chips; service echo in the Artist card; age row; under-18 + tattoo stop; *Who's Being Pierced* section; *The Piercing* section |
| `styles.css` | `.wm-notice`, `.wm-notice-stop`, `.wm-hero-choice`, `.wm-chip.is-disabled` |

### `public/` — the touch-up service and the Supabase cutover

| | Change |
|---|---|
| `app.js` | `touchup` in `ALL_SERVICES`; `SERVICE_SUBMIT` and `INK_SERVICES`; the touch-up panel and its one required field; `emptyRefsHint()`; `WEBHOOK_URL` now `/api/intake`; the honeypot forwarded instead of stripped |
| `index.html` | A third hero chip; the *Touch Up* section; `data-service` carrying the machine key |
| `nginx.conf.template` | The `^~ /api/intake` proxy block |
| `docker-entrypoint-uat.sh` | `WM_FUNCTIONS_UPSTREAM` validation and the derived `WM_FUNCTIONS_HOST` |

⚠ **`data-service` carries the machine key, not the label.** The two diverged
the moment Touch Up arrived: its label has a space and its key does not.
Lowercasing the label to derive the key gives `touch up`, which matches no
artist's `services` entry, and the chip silently disables itself. `app.js` reads
the attribute; `value` is only what gets submitted.

⚠ **Under 18 blocks touch-ups too.** `INK_SERVICES` is the list, and both the
form and `buildRow()` in the intake function enforce it — the form so nobody
fills in a page they cannot submit, the function because a POST can skip the
form entirely.

Applied from `PIERCING-BUILD.md` 1.1–1.4, including the **1.3a** picker
corrections (four piercings she does not perform removed, names matched to the
menu, Anti-tragus added, the wrong "priced per piercing" note deleted),
**1.3b** (count split from side), and **1.5** (age-limit machinery deleted —
there are no per-piercing age minimums, only the one consent rule).

⚠ **The hero chips are outside the `<form>`.** They are named `serviceChoice`
and carry no submitted value; `app.js` mirrors the choice into a hidden
`service` input inside the form. Moving them inside the form without removing
that hidden input would submit `service` twice.

### `n8n/` — gone

This folder had copies of the four Workflow A/B/C Code nodes and their
templates. The form does not call n8n at all any more, so they described a
system this app no longer participates in.

The two that carried real UAT work — the piercing build in `intake.js` and the
`-uat` path suffix in `review-page.js`, plus `request-email-piercing.html` —
moved to [`../../waymaker-booking/n8n/uat-piercing/`](../../waymaker-booking/n8n/uat-piercing/),
next to the `PIERCING-BUILD.md` and `PIERCING-ROLLOUT.md` that describe them.
The rest were byte-identical duplicates of production's and were deleted.

The mail workflows this system *does* use are in
[`../n8n-portal/`](../n8n-portal/).
---

## Running it

Easiest is the compose stack, which brings the form and the portal up together:

```sh
cd uat
cp docker-compose.env.example .env      # fill in the Supabase values
docker compose up --build
```

Or this app alone:

```sh
cd uat/waymaker-booking
docker build -t wm-booking-uat .
docker run --rm -p 8080:80 \
  -e WM_WEBHOOK_URL="/api/intake" \
  -e WM_FUNCTIONS_UPSTREAM="https://YOUR-PROJECT-REF.supabase.co" \
  -e WM_RESOLVER="127.0.0.11" \
  -e WM_ARTISTS='{"laynie":{"enabled":true,"name":"Laynie Joy","services":["tattoo","piercing","touchup"]}}' \
  -e WM_REDIRECT_SECONDS=0 \
  -e WM_UAT_LABEL="UAT" \
  wm-booking-uat
```

Then `http://localhost:8080/laynie`. `?service=piercing` and `?service=touchup`
open straight on those forms.

⚠ **`WM_FUNCTIONS_UPSTREAM` is required** — the entrypoint refuses to start
without it. A form that renders and silently drops every request is worse than
one that does not come up at all.

⚠ **Keep `WM_WEBHOOK_URL` relative.** nginx proxies `/api/intake` so the POST is
same-origin. Point it straight at the functions host and the response is
cross-origin: `app.js` posts `FormData` then reads `res.ok`, a response with no
`Access-Control-Allow-Origin` is unreadable, so `fetch` rejects and the retry
path fires three times while the function processes every one. Three rows for
one submission.

⚠ **`WM_RESOLVER` must be Docker's embedded DNS** (`127.0.0.11`) when the
upstream is `host.docker.internal` — nginx's `resolver` never reads
`/etc/hosts`, which is the only place that name exists. A public resolver
cannot resolve it and every submission 502s.

`services` defaults to `['tattoo']`, so an artist in `WM_ARTISTS` without that
key sees no piercing or touch-up anything — the page looks as production's does.
---

## What still has to happen

The form is done. Everything downstream of it moved to Supabase:

- [x] Intake — `../supabase/functions/intake/`, replacing the n8n workflow
- [x] The record — Postgres, replacing the Google Sheet
- [x] The photos — Supabase Storage, replacing the Drive folder
- [x] The review surface — the admin portal, replacing the signed decision links
- [ ] The piercing appointment type in Acuity, 30 minutes, Laynie only

`PIERCING_PAIRS` in [`public/app.js`](public/app.js) and the `piercing_prices`
table have to agree on which piercings can be sold as a pair. The form decides
whether the chip is selectable; the table holds the money and is authoritative.

Sheet columns are no longer a thing — the schema is in
[`../supabase/migrations/`](../supabase/migrations/), and adding a field is a
migration rather than a header row plus a node mapping.
---

## Promoting to production

There is no shared file to merge, so promotion is a deliberate port, file by
file, into `../../waymaker-booking/`. Before you start:

- [ ] Diff each file against its production counterpart and read the whole
      diff — production has its own uncommitted work in `public/app.js` and
      `public/index.html` that predates this folder
- [ ] Re-run the smoke tests against production's copy afterwards, not just
      this one
- [ ] Follow `PIERCING-ROLLOUT.md` phase order — the front end is Phase 4 and
      ships with `services: ['tattoo']` still set for Laynie
