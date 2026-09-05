# Deploying UAT to Dokploy

Two apps, one Supabase project, two domains.

| | Domain | Build context |
|---|---|---|
| Booking form | `uat-booking.waymakerink.com` | `uat/waymaker-booking` |
| Admin portal | `uat-portal.waymakerink.com` | `uat/waymaker-portal` |

Do these in order. Steps 1–3 are Supabase and can be done before Dokploy exists;
the apps are useless without them.

---

## 0 · The branch

Dokploy builds from a git ref, and **`uat/` has never been committed**. Nothing
below works until it is pushed.

**One branch serves both apps.** Dokploy takes a *build context path* per
application, so two apps can point at the same ref and build different folders.
Two branches would mean `supabase/` and `n8n-portal/` — which both apps depend
on — living in one branch and being invisible from the other, or duplicated and
drifting.

Split them later if you want independent release trains; you do not need it to
deploy the two apps separately, because Dokploy already deploys per-app.

⚠ **Do not commit `.env` files.** `uat/.env` and `uat/supabase/functions/.env`
hold the local Supabase keys and the n8n signing secret. Both are gitignored —
confirm with `git status` before pushing, not after.

---

## 1 · Supabase

The project is created already. Point the CLI at it and push:

```sh
cd uat
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

That runs the four migrations. The last statement of the RLS migration fails the
whole push if any table in `public` lacks row-level security, so a clean run is
the check.

⚠ **`db push` does not apply `seed.sql`.** The sample requests are local-only by
construction — they cannot reach a hosted project through the normal deploy
path.

### The two accounts

Dashboard → Authentication → Users → **Add user**, for Nic and Laynie. Signup is
disabled in `config.toml`, deliberately: nobody signs themselves up for a portal
showing every client's phone number and photographs.

Then tell the portal who they are — the trigger creates the `profiles` row but
cannot know which artist a person is. Fill in the real emails in
`supabase/set-profiles.sql` and run it against the project (SQL Editor, or
`psql`):

```sql
insert into public.profiles (id, display_name, role, artist_key)
select id, 'Nic', 'admin', 'nic'
from auth.users where email = 'nic@…'
on conflict (id) do update
  set display_name = excluded.display_name,
      role         = excluded.role,
      artist_key   = excluded.artist_key;
```

`role = 'admin'` means each sees both queues, with the artist filter defaulting
to their own. Change either to `'artist'` to scope them to their own requests
only — the policy is already written for it.

### Real artist emails

The seed carries the test address. Fix it before anything sends:

```sql
update public.artists set email = 'nic@…'    where key = 'nic';
update public.artists set email = 'laynie@…' where key = 'laynie';
```

That column is the client's **Reply-To**. Left as the seed value, a client's
reply goes to a developer.

---

## 2 · Function secrets

```sh
cp supabase/.env.example supabase/.env      # fill it in; .env is gitignored
npx supabase secrets set --env-file supabase/.env
npx supabase functions deploy intake respond
```

| Variable | Value |
|---|---|
| `WM_PORTAL_URL` | `https://uat-portal.waymakerink.com` |
| `WM_ALLOWED_ORIGINS` | `https://uat-portal.waymakerink.com` |
| `WM_N8N_RESPOND_URL` | `https://n8n.fifthstonedev.com/webhook/wm-respond-uat` |
| `WM_N8N_SIGNING_SECRET` | `openssl rand -base64 32` — the **same** value on the n8n container |
| `WM_N8N_NOTIFY_URL` | `https://n8n.fifthstonedev.com/webhook/booking-request-uat` |

⚠ **`/webhook/`, never `/webhook-test/`.** A test URL accepts one request and
only while the n8n editor is open. The first response works and every one after
it 404s.

⚠ **An empty `WM_N8N_NOTIFY_URL` is silent.** `notifyArtist()` treats absent as
"not wired up yet" and returns before sending — by design, so the database half
can be tested before the mail half exists. The cost is that the artists simply
stop being told about new requests and nothing anywhere says so: the row lands,
the client sees their confirmation, and the only trace is the absence of an
email. If artists report missing notifications, check this variable first.

⚠ **The two workflows need different `REQUIRE_SIGNED` lines.** One copy of
[`n8n-portal/verify-signature.js`](n8n-portal/verify-signature.js) goes in each,
and the constant at the top asserts which fields the signature must cover:

| Workflow | `REQUIRE_SIGNED` |
|---|---|
| `wm-respond-uat` | `['rid', 'action', 'to', 'bookingUrl']` |
| `booking-request-uat` | `['rid', 'artistEmail']` |

The file ships with the respond set. Pasting it unchanged into the notify
workflow throws `Signature does not cover "action"` on every request — the
signature is fine; the node is asserting a canon that call never had.

⚠ **The booking domain does not go in `WM_ALLOWED_ORIGINS`.** Its POST goes
through its own nginx proxy, so the browser sees a same-origin request and sends
no Origin header at all.

---

## 3 · Acuity

- [ ] Piercing appointment type → already set:
      `https://waymakerink.as.me/?appointmentType=97682822`
- [ ] **Touch up · 30 min** and **Touch up · 1 hr**, per artist → still missing

Until those two exist the portal greys the touch-up tiers out and says why, and
`respond` refuses to send on a null URL rather than mailing a dead button. Set
them when they exist:

```sql
update public.service_tiers set acuity_url = 'https://waymakerink.as.me/?appointmentType=…'
  where service = 'touchup' and tier_key = 'touchup30' and artist_key = 'nic';
```

---

## 4 · The two Dokploy apps

Same repository and branch for both; only the build path and the environment
differ.

### App: `uat-booking`

| | |
|---|---|
| Build context | `uat/waymaker-booking` |
| Dockerfile | `Dockerfile` |
| Port | `80` |
| Domain | `uat-booking.waymakerink.com` |
| Environment | [`waymaker-booking/.env.example`](waymaker-booking/.env.example) |

The values that must be real: `WM_FUNCTIONS_UPSTREAM` (the project origin, no
path, no trailing slash) and `WM_UAT_PASSWORD`.

### App: `uat-portal`

| | |
|---|---|
| Build context | `uat/waymaker-portal` |
| Dockerfile | `Dockerfile` |
| Port | `80` |
| Domain | `uat-portal.waymakerink.com` |
| Environment | [`waymaker-portal/.env.example`](waymaker-portal/.env.example) |

The values that must be real: `WM_SUPABASE_URL`, `WM_SUPABASE_ANON_KEY` (the
**anon/public** key — the entrypoint decodes it and refuses to start on a
service-role key) and `WM_UAT_PASSWORD`.

⚠ The portal builds with Node before it serves with nginx, so its first deploy
is slower than the form's. `npm run build` runs `tsc --noEmit` first: a type
error fails the image rather than shipping a portal that throws in the artist's
browser.

### DNS

Two records at the Dokploy host's address, then let Dokploy issue certificates:

```
uat-booking.waymakerink.com   A/CNAME  ->  <dokploy host>
uat-portal.waymakerink.com    A/CNAME  ->  <dokploy host>
```

### Both apps fail closed

Neither starts on a missing or malformed setting, and the reason is printed on
the first line of the container log:

| Log line | Cause |
|---|---|
| `WM_FUNCTIONS_UPSTREAM is not set` | booking app, missing the project origin |
| `WM_FUNCTIONS_UPSTREAM is the project ORIGIN only` | you included `/functions/v1` |
| `WM_SUPABASE_ANON_KEY is a SERVICE ROLE key` | wrong key from the dashboard |
| `WM_SUPABASE_URL must be an https:// URL` | portal app, missing or http |

That is deliberate. A booking form that renders and silently drops every request
is worse than one that does not come up.

⚠ **Watch the first deploy's logs, not just the health check.** `/healthz` has
`auth_basic off` and answers 200 regardless, so a container can report healthy
while every real page 500s.

---

## 5 · n8n

One workflow, five nodes: [`n8n-portal/BUILD-RESPONSE.md`](n8n-portal/BUILD-RESPONSE.md).

Set `WM_N8N_SIGNING_SECRET` on the n8n container to the same value as step 2,
plus `NODE_FUNCTION_ALLOW_BUILTIN=crypto` and
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, then restart it. **Activate** the workflow
— `/webhook/` paths only answer on an active one.

---

## 6 · Smoke test, in this order

Each step is the first thing that breaks if the one before it is wrong.

| # | Do | Expect |
|---|---|---|
| 1 | `https://uat-booking.waymakerink.com/laynie` | The form, behind the basic-auth prompt, red UAT flag top right |
| 2 | Submit a piercing with two photos | `200`, confirmation screen |
| 3 | Sign in at `https://uat-portal.waymakerink.com` | Lands on your own queue; the request is in the piercing tile |
| 4 | Open it | Both photos render inline |
| 5 | Pick the tier, **Send Response** | Client email arrives; request goes `LINK_SENT` |
| 6 | **Resend booking link** on that request | Second email; request unchanged; `resent` in History |
| 7 | Sign out, `curl` the REST API with the anon key | `[]` or `401` — never a row |

Step 7 is the whole of RLS in one command. Step 5 is the whole system.

---

## What is still UAT-only

- **`WM_ENV_LABEL` / `WM_UAT_LABEL`** put the red corner flag on every page.
  Production leaves both empty.
- **Basic auth** is a shared doormat over the top of the real Supabase login.
  Keep it on an unlisted UAT host; drop it in production, where the portal's own
  login is the gate.
- **`WM_REDIRECT_SECONDS=0`** keeps the confirmation on screen. Production wants
  `20`.
- **The `-uat` webhook path.** One n8n instance serves both environments and the
  path is the only thing separating them.

## Promoting to production

A **second Supabase project**, the same migrations pushed to it, its own seed
with the real artist emails, and two more Dokploy apps on `booking.` and
`portal.`. Nothing is shared but the code.

⚠ Leave the three old n8n workflows **deactivated, not deleted**, until the
30-day TTL on the last signed decision link has expired. There are `tier1…5`
links sitting in client inboxes; deactivating turns them into a 404 rather than
a wrong answer.
