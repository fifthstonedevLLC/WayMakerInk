# Admin Portal — the initiative

**Requests stop living in a Google Sheet and start living in Supabase, and the
artist stops deciding from a link in an email and starts deciding in a portal
they log into.**

This folder is the whole of it. Nothing here can reach a live client: production
is `../waymaker-booking/`, still on n8n + Sheets + Drive, and shares no file,
no database and no webhook path with anything below.

---

## Contents

| Path | What it is |
|---|---|
| [`supabase/`](supabase/) | Schema, RLS, seed data, and the two Edge Functions |
| [`waymaker-portal/`](waymaker-portal/) | The admin portal — Vite + React + TypeScript |
| [`waymaker-booking/`](waymaker-booking/) | The UAT booking form, now posting to Supabase |
| [`n8n-portal/`](n8n-portal/) | The two mail workflows and the signature check that guards them |
| [`docker-compose.yml`](docker-compose.yml) | Brings the form and the portal up together, locally |
| [`../waymaker-booking/`](../waymaker-booking/) | **Production. Do not touch from here.** |

---

## What replaces what

```
BEFORE (production today)

  form ──POST──▶ n8n Workflow A ──▶ Google Sheet  (the record)
                        │          ──▶ Google Drive (the photos)
                        └──email──▶ artist
                                      │  five signed tier links
                                      ▼
                 n8n Workflow B ──▶ review page (renders a row)
                 n8n Workflow C ──▶ writes the row, emails the client


AFTER (this folder)

  form ──POST──▶ /api/intake ──▶ Supabase Edge Function `intake`
                 (nginx proxy)         │
                                       ├──▶ requests           (the record)
                                       ├──▶ storage/request-refs (the photos)
                                       └──▶ n8n ──email──▶ artist  "you have one"

  artist ──login──▶ Admin Portal ──▶ reads requests + tier_options + photos
                          │
                          └──▶ Edge Function `respond`
                                       ├──▶ claims the row, writes the decision
                                       └──▶ n8n ──email──▶ client (estimate + link)
```

**n8n keeps exactly one job: sending mail.** It holds no data, no signing
secret, no pricing table and no booking links. Two webhooks, two mail merges.

---

## Why each piece is where it is

| Decision | Reason |
|---|---|
| Intake is an **Edge Function**, not a direct insert from the form | A public anon key on the form page is a write endpoint anyone can script. No RLS policy can tell a real submission from a scripted one. The function holds the service-role key and applies the same artist/service/price rules `nodes/intake.js` did. |
| The portal calls **`respond`**, not the n8n webhook | The portal is a browser app; any secret it holds is public. An n8n webhook it could authenticate to is one anyone can authenticate to — and that webhook sends mail from the shop's address to an arbitrary recipient. The function holds the shared token; the browser's credential is a short-lived Supabase JWT. |
| Photos in **Supabase Storage**, private bucket | The portal renders them inline with a one-hour signed URL. Drive would mean an OAuth dance per artist and no thumbnails. |
| `service_tiers` + `piercing_prices` are **tables** | They were three hardcoded maps across two Code nodes that had to be kept in step by hand, and drifted once already (Laynie pointing at Nic's five Acuity types). Editing a price is now a row, not a deploy. |
| The form still **POSTs same-origin** through nginx | `app.js` reads `res.ok`; a cross-origin response with no `Access-Control-Allow-Origin` makes `fetch` reject, and the retry path fires three times while the server processes all three. Three rows for one submission. |

---

## What changed in the data

The sheet stored what a person reads. The database stores what code branches on,
and the portal renders the label.

| Sheet | Database |
|---|---|
| `status` `LINK SENT` | `status` `LINK_SENT` — no spaces, ever |
| `service` `Piercing` | `service` `piercing` |
| `firstTattoo` `'No'` | `first_time` `false` |
| `minorAge` `'12'` | `minor_age` `12` |
| `driveFolder`, `referenceCount` | rows in `request_images` |
| *(nothing)* | `request_events` — an audit trail |
| *(nothing)* | `touchup_*` — the new service |

Two behaviours are new rather than ported:

- **Retries no longer duplicate.** `requests.rid` is unique, and `intake` turns
  a unique-violation into a `200`. The form already held one rid across all
  three attempts; the sheet had no way to use that.
- **The honeypot actually runs.** `app.js` used to check `company` itself and
  delete the field, so the server-side check was dead code and a bot POSTing
  straight at the webhook was unfiltered. The field now travels and the
  function decides.

---

## Running it locally

```sh
cd uat
cp docker-compose.env.example .env      # fill in the Supabase values
docker compose up --build
```

| | |
|---|---|
| Form | http://localhost:8080 — `/laynie`, `?service=touchup` |
| Portal | http://localhost:8081 |

Both images build and run today, and both fail closed on a missing or wrong
setting rather than starting broken. **Neither does anything useful without a
Supabase project behind it** — the form posts to `intake` and the portal reads
the database, so §1–§3 of the runbook come first. Two ways to supply one, both
in [`docker-compose.env.example`](docker-compose.env.example): the hosted UAT
project, or `cd supabase && npx supabase start` for a fully local stack.

⚠ With a local stack, `WM_SUPABASE_URL` and `WM_FUNCTIONS_UPSTREAM` point at
the same thing through **different hostnames** — `127.0.0.1:54321` for the
first because the browser reads it, `host.docker.internal:54321` for the second
because nginx reads it from inside a container. Getting them the same way round
is the one thing that catches people.

The deployed hosts do not use compose. They are two Dokploy apps, each building
one of these contexts with its own environment panel; the compose file is for a
laptop.

---

## Runbook

### 1 · Create the Supabase project

A **separate project from production's**, when production moves. The UAT project
is the only thing keeping test submissions out of the real request table.

```sh
cd uat
npx supabase link --project-ref <uat-project-ref>
npx supabase db push          # runs the four migrations in order
```

Then check the belt-and-braces assertion at the end of the RLS migration
passed — it fails the migration if any table in `public` lacks RLS.

### 2 · Create the two accounts

Dashboard → Authentication → Users → **Add user** (signup is disabled in
`config.toml`, deliberately: nobody signs themselves up for a portal showing
every client's phone number and photographs).

Then set what they may see — the signup trigger creates the `profiles` row but
cannot know who the person is:

```sql
update public.profiles set display_name = 'Nic',    role = 'admin', artist_key = 'nic'
  where id = (select id from auth.users where email = 'nic@…');
update public.profiles set display_name = 'Laynie', role = 'admin', artist_key = 'laynie'
  where id = (select id from auth.users where email = 'laynie@…');
```

`role = 'admin'` means each sees the other's queue, which is what a two-person
shop wants. Changing either to `'artist'` scopes them to their own `artist_key`
immediately — the policy is already written for it, no migration needed.

### 3 · Set the function secrets

```sh
cp supabase/.env.example supabase/.env    # fill it in — .env is gitignored
npx supabase secrets set --env-file supabase/.env
npx supabase functions deploy intake respond
```

`WM_N8N_SIGNING_SECRET` must be set on **both** sides — here and on the n8n
container — and n8n must actually verify it. See [`n8n-portal/README.md`](n8n-portal/README.md):
paste [`verify-signature.js`](n8n-portal/verify-signature.js) into a Code node
immediately after each Webhook node. A secret that is set on one side and
ignored on the other is a secret that does nothing.

### 4 · Deploy the two apps

Two Dokploy apps, each with its own environment panel:

| App | Build context | Env template |
|---|---|---|
| UAT booking form | `uat/waymaker-booking/` | [`.env.example`](waymaker-booking/.env.example) |
| UAT admin portal | `uat/waymaker-portal/` | [`.env.example`](waymaker-portal/.env.example) |

The portal's origin has to appear in `WM_ALLOWED_ORIGINS` on the functions, or
every **Send Response** fails with an opaque network error.

### 5 · Build the two n8n workflows

Both are new, both on UAT paths, and both are a mail merge with a token check
in front. Neither reads or writes anything.

| Path | Trigger | Sends |
|---|---|---|
| `/webhook/booking-request-uat` | `intake`, after the row commits | "You have a new request" → artist, with a link to `/r/<rid>` |
| `/webhook/wm-respond-uat` | `respond`, after the row is claimed | The estimate + booking link, or the decline → client |

Each: **Webhook** → **Code** (`verify-signature.js`) → **Send Email**.

**[`n8n-portal/BUILD-RESPONSE.md`](n8n-portal/BUILD-RESPONSE.md) is the build sheet** — the node
tables, the payload field lists, the Send Email maps, and the four tests that
prove the signature check actually rejects things.

⚠ **Both webhook URLs are public and make the shop send email.** That is the
whole threat, and it is why the calls are signed rather than carrying a token:
the signature proves the caller is us, covers the fields that decide who is
mailed and what link they get, and expires after five minutes so a captured
call cannot be replayed.

⚠ **Turn off *Append n8n Attribution*** on every Send Email node. It defaults to
ON and appends `--- This email was sent automatically with n8n` below the
template. It is a node option, not part of the HTML, so no amount of editing the
template removes it.

### 6 · Acuity

- [ ] **Piercing** appointment type, 30 minutes, Laynie only → set `acuity_url`
      on the `laynie/piercing/pierce` row in `service_tiers`
- [ ] **Touch up · 30 min** and **Touch up · 1 hr**, per artist → set
      `acuity_url` on the four `touchup*` rows

Until those URLs are set the portal renders those tiers greyed out and says why.
`respond` refuses to send on a null URL rather than mailing a client a button
that goes nowhere.

---

## Smoke test order

Run these against UAT in this order. Each one is the first thing that breaks if
the step before it is wrong.

| # | Do | Expect |
|---|---|---|
| 1 | Submit a **tattoo** with 2 reference images | Row in `requests`, `status = NEW`, 2 rows in `request_images`, 2 objects in the bucket |
| 2 | Sign in to the portal | The request in the **Needs a response** tab |
| 3 | Open it | Both photos render inline; every field the form asked is on screen |
| 4 | Pick a tier, edit the estimate, **Send Response** | Client email carries **the edited estimate** and that tier's Acuity link; `status = LINK_SENT`; `tier_sent` set |
| 5 | Reload and try to respond again | The response panel is gone — it shows what was sent instead |
| 6 | Submit a **piercing**, Helix, Pair | `quoted_price = 75`, `quote_label = "Pair · $75"`; the portal shows it as the menu price |
| 7 | Submit a piercing, *Something else* | `quoted_price` is **null** and the portal reads **Quote on request** — not `$0` |
| 8 | Submit a **touch up** | The touch-up panel's four fields land; `service = touchup`; tattoo columns are `''` |
| 9 | Open that touch up in the portal | Both touch-up tiers greyed out, with the "no Acuity link yet" note |
| 10 | Pick *Under 18* + Tattoo, then + Touch Up | Both show the stop notice; the form's submit button is gone in both |
| 11 | Under 18 + Piercing, guardian block filled | Row lands with `guardian_consent = true`; portal shows the *Who's Being Pierced* card |
| 12 | Submit, kill the network mid-request, let it retry | **One** row, not three — the rid is held across attempts and the second insert is a no-op |
| 13 | Fill the hidden `company` field from devtools and submit | `200`, and **no row** |
| 14 | Sign out, then `GET /rest/v1/requests` with the anon key | `[]` or a 401 — never a row |
| 15 | Open a signed photo URL after an hour | Expired |

Step 7 is the one that used to be a `$0`. Step 12 is the duplicate-row problem
the sheet could not solve. Step 14 is the whole of RLS in one curl.

---

## Where this stands

**Done**

- [x] Schema, RLS, views, seed data — four migrations
- [x] `intake` and `respond` Edge Functions
- [x] Admin portal: login, queue with filters and search, request detail with
      inline photos, tier picker, estimate, message, send/decline, history
- [x] UAT form: **Touch Up** as a third service, posting to `/api/intake`
      through a same-origin nginx proxy
- [x] Honeypot forwarded so the server-side check runs
- [x] Calls to n8n signed with HMAC-SHA256 + timestamp, verified by
      [`n8n-portal/verify-signature.js`](n8n-portal/verify-signature.js)
- [x] Both Docker images build, run and pass their health checks;
      `docker compose up` brings the pair up together

Three bugs found by actually running the containers, now fixed:

- **`WM_UAT_PASSWORD` had never worked on the UAT booking form.** The htpasswd
  file was written `chmod 600`, but nginx's workers drop to the `nginx` user —
  so every authenticated request died with `[crit] … Permission denied` and a
  500, on every page. `/healthz` has `auth_basic off`, so the container went on
  reporting healthy and Dokploy would have called the deploy a success. Now
  `640 root:nginx`, in both apps.
- **The portal entrypoint called `openssl`**, which is not in `nginx:alpine` —
  no openssl, no htpasswd. It now uses `{PLAIN}` like the booking form, which
  is why that file did.
- **The service-role key guard was decorative.** It grepped the raw key for
  `service_role`, but a Supabase JWT base64url-encodes its payload, so the
  literal string never appears and the check passed every key including the one
  it existed to catch. It now decodes the payload, and also rejects the newer
  `sb_secret_…` format.

**Next, in this order**

- [ ] Create the Supabase project and run the migrations (§1)
- [ ] Create the two accounts and set their profiles (§2)
- [ ] Deploy the functions with secrets (§3) — at this point steps 1–3 of the
      smoke test can run with no n8n at all: leave `WM_N8N_NOTIFY_URL` unset and
      intake treats it as "not wired up yet"
- [ ] Deploy both apps (§4)
- [ ] Build the two n8n workflows (§5) — steps 4–15 need these
- [ ] Create the Acuity types and set the four `acuity_url` values (§6)

**Open questions, none of them blocking**

- **Touch-up pricing.** Seeded as 30 min and 1 hr off the artist's hourly rate
  (`$62.50` / `$125` for Nic, `$50` / `$100` for Laynie). If the shop prices
  touch-ups flat — or free within some window of the original — that is a
  `flat_price` on those four rows and no code change. Worth confirming before
  step 6.
- **Who offers touch-ups.** Seeded as both artists. One `update artists set
  services = ...` if that is wrong.
- **`BOOKED` is not visible to us.** Nothing writes it — Acuity is where a
  client actually books and nothing watches it. The portal's status filter
  therefore has no Booked tab: it could only ever return an empty list, which
  reads as "nobody is booking" rather than "we cannot see it".

  The status itself stays legal — the CHECK constraint accepts it, the label
  renders, and `respond` treats it as decided — so an Acuity webhook or a
  polling workflow can start writing it later and the tab comes back as one
  line in `Queue.tsx`. Until then, `LINK_SENT` is as far as a request gets in
  this system, and whether it turned into an appointment is a question only
  Acuity can answer.
- **Client confirmation email.** Still absent, still a missing nicety rather
  than a false statement — the form does not claim one was sent.

---

## Promoting to production

Not yet, and not by copying files. When it happens it is:

1. A **second Supabase project**, its own migrations run from the same files,
   its own seed with the **real artist emails**.
2. Production's `nginx.conf` gains the `/api/intake` block and its
   `WM_FUNCTIONS_UPSTREAM`.
3. Production's `public/` takes this folder's `app.js` and `index.html` — read
   the whole diff, per the warning in
   [`waymaker-booking/README.md`](waymaker-booking/README.md).
4. The three old n8n workflows are **deactivated, not deleted**, until the
   30-day TTL on the last signed decision link has passed. There are `tier1…5`
   links sitting in inboxes right now, and deactivating Workflow B turns them
   into a 404 rather than a wrong answer.

⚠ **The sheet is not migrated.** Historical rows stay in the sheet, read-only.
Writing a backfill means reconciling `'LINK SENT'` against `LINK_SENT`, blank
`service` against `tattoo`, and Drive folder ids against storage paths that do
not exist — for rows nobody will act on again. Keep the sheet; start clean.
