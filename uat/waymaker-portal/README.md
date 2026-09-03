# Admin portal

Where Nic and Laynie read appointment requests and respond to them. Replaces
the signed decision links in the artist email and the n8n-rendered review page.

Part of the Supabase initiative — read [`../PORTAL-INITIATIVE.md`](../PORTAL-INITIATIVE.md)
first, it has the architecture and the runbook. This file is just how to run
the app.

---

## Running it locally

```sh
npm install
```

Then point it at a Supabase project. `public/config.js` is the local-dev
fallback and is **not** overwritten by anything while running `vite dev` — fill
in the two values by hand:

```js
window.WM_PORTAL_CONFIG = {
  supabaseUrl: 'https://<project-ref>.supabase.co',
  supabaseAnonKey: '<the anon key>',
  envLabel: 'LOCAL'
};
```

```sh
npm run dev            # http://localhost:5173
```

⚠ **`http://localhost:5173` has to be in `WM_ALLOWED_ORIGINS` on the Edge
Functions**, or every Send Response fails. Reading requests works without it —
PostgREST and Storage set their own CORS — so the symptom is a portal that
looks entirely healthy until the moment it matters.

⚠ **Do not commit real values into `public/config.js`.** It is the committed
fallback, the same way the booking form's is; the container overwrites it at
start from the environment.

---

## Layout

```
waymaker-portal/
├── Dockerfile              two stages: node build → nginx serve
├── docker-entrypoint.sh    writes /config.js, auth.conf, robots.txt
├── nginx.conf.template     SPA try_files + hardening headers
├── index.html              loads /config.js BEFORE the module
├── public/
│   ├── config.js           local-dev fallback, overwritten in the container
│   └── WaymakerInk_Logo_transparent.png
└── src/
    ├── main.tsx
    ├── App.tsx             session, profile, chrome, routes
    ├── styles.css
    ├── lib/
    │   ├── supabase.ts     the client, respond(), signedImageUrls()
    │   ├── types.ts        hand-written row shapes + the label maps
    │   └── format.ts       money, dates, "3d ago"
    └── routes/
        ├── Login.tsx
        ├── Queue.tsx       filters, search, the list
        └── RequestDetail.tsx   the request, the photos, the responder
```

---

## Things that will bite

**The row types are hand-written.** `src/lib/types.ts` mirrors the migrations
and is applied at each query with `.returns<T>()`. A generated `Database` type
would have to be regenerated after every migration, and a stale one is worse
than none — it type-checks against a schema that no longer exists. The trade is
that a column rename fails at the one query that reads it, which is where you
want to be told.

**`null` price is not `0`.** A custom piercing and a tier with no price yet both
arrive as `null`, and `priceLabel()` renders "Quote on request". Anything that
coerces it to a number mails a client a free tattoo.

**The portal never writes.** There is no insert, update or delete policy on
`requests` for `authenticated` — every write goes through the `respond`
function. Adding a `.update()` here will fail silently as zero rows affected,
not loudly as a permission error.

**`config.js` must load before the module.** `src/lib/supabase.ts` throws at
import time if the config is missing, which is deliberate — a missing config is
a deployment fault, and one clear message on a blank page beats "Failed to
fetch" on every query. Reordering the two `<script>` tags in `index.html`
breaks it.

---

## Deploying

One Dokploy app, build context `uat/waymaker-portal/`. Environment in
[`.env.example`](.env.example).

The image is environment-agnostic: no `VITE_*` variables, no Supabase URL baked
in. `docker-entrypoint.sh` writes `/config.js` at container start, the same way
the booking form's does, so one image runs UAT and production.

It refuses to start if `WM_SUPABASE_ANON_KEY` looks like a service-role key.
That key bypasses every RLS policy and this file is served to the public.
