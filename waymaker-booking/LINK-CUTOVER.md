# Link Domain Cutover

Moving the artist's decision links off `n8n.fifthstonedev.com` and onto
`booking.waymakerink.com`.

## The problem

The tier buttons in the artist's request email are built by `nodes/intake.js`
as `${WM_N8N_BASE_URL}/webhook/decide?rid=…&action=tier1&exp=…&sig=…`. That
host is flagged by a browser blocklist, so the artist gets an unsafe-site
interstitial at the exact moment they're pricing a job.

Phases A and B move those links onto the booking domain, close the n8n editor
off the public root, and request a review. n8n does not move — it keeps its own
domain, its own editor, and its other workflows.

| In the email  | Today                      | After Phase A             |
| ------------- | -------------------------- | ------------------------- |
| Tier buttons  | `n8n.fifthstonedev.com`    | `booking.waymakerink.com` |
| Branding      | WayMaker Ink               | unchanged                 |
| Sender        | `thewaymakerink@gmail.com` | held — see step 09        |

⚠ **Order matters.** Within Phase A the proxy must be live before the base URL
flips, or every decision link 404s. The review request in step 08 goes last.

---

# Phase A · today — move the links onto the booking domain

Self-contained and reversible in under a minute.

## 00 · Before you start

- [ ] **Confirm which blocklist is flagging it.** Get a screenshot of the
      warning from an artist. Gmail/Chrome → Google Safe Browsing, and step 08
      is correct. Outlook/Edge → Microsoft SmartScreen, and Search Console does
      nothing.
- [ ] **Check `waymakerink.com` is itself clean** at
      `transparencyreport.google.com/safe-browsing/search`. You are about to
      move flagged-pattern traffic onto the business's primary domain. Check
      again a week after.
- [ ] **Check the Gmail OAuth app's publishing status.** Google Cloud Console →
      APIs & Services → OAuth consent screen. If it says **Testing**, the
      refresh token expires every 7 days and sending stops dead with no visible
      error. Unrelated to the flag, but it's the most common way n8n Gmail
      workflows fail silently and you're already in there.
- [ ] **Get n8n's internal service name and port** from Dokploy (or
      `docker network inspect dokploy-network`). Needed for step 01.
- [ ] **Confirm both Dokploy apps share a Docker network.**

> **Skip the email auth headers.** They pass. Google signs mail from
> `thewaymakerink@gmail.com` with `d=gmail.com`, SPF passes, and DMARC aligns to
> `gmail.com`. Authentication isn't the problem, and no header will show you
> what is.

## 01 · Add the proxy · repo + Dokploy (form app)

- [ ] Add to `nginx.conf`, above the `gzip` lines:

```nginx
    # n8n webhooks, proxied so artist- and client-facing links live on this
    # domain rather than on the n8n host.
    #
    # ⚠ Per the note above: NO add_header in this block. It inherits the three
    # server-level hardening headers, and declaring even one of its own would
    # silently discard all three.
    #
    # ^~ not a bare prefix — the \.(css|js)$ regex location above would
    # otherwise win for any webhook path ending in .js.
    location ^~ /webhook/ {
        resolver 127.0.0.11 valid=30s ipv6=off;   # Docker embedded DNS
        set $n8n http://REPLACE_ME:5678;
        proxy_pass $n8n$request_uri;              # $request_uri required — a
                                                  # variable proxy_pass drops it

        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # The intake form posts up to 5 client-resized JPEGs as multipart.
        # nginx's 1m default would 413 them.
        client_max_body_size 25m;
        proxy_request_buffering off;

        proxy_connect_timeout 10s;
        proxy_read_timeout    120s;
    }
```

- [ ] Replace `REPLACE_ME` with the service name from step 00.
- [ ] Confirm n8n's `N8N_PAYLOAD_SIZE_MAX` is at least 25MB.
- [ ] Redeploy the booking form container.

**Why the `resolver` line.** With a literal hostname in `proxy_pass`, nginx
resolves once at config load and *refuses to start* if n8n is down — and since
the healthcheck in `Dockerfile` gates the deploy, the booking form would go
down because n8n was slow. It also caches that IP forever, so an n8n restart
silently breaks the proxy. The variable form turns both into a recoverable 502.

## 02 · Verify the proxy before flipping anything

- [ ] `curl -i https://booking.waymakerink.com/webhook/decide`

      A 403 or 400 from the verify node is **success** — the request reached
      n8n. A 404 from nginx means the proxy isn't matching.

- [ ] Confirm the response carries `X-Content-Type-Options`,
      `X-Frame-Options`, and `Referrer-Policy` — exactly once each. If n8n
      sets its own copies, add `proxy_hide_header X-Frame-Options;`.

Do not continue until this passes.

## 03 · Update the node fallbacks · repo + n8n editor

Both currently read `'https://n8n.fifthstonedev.com'`. Change both to
`'https://booking.waymakerink.com'`:

- [ ] `n8n/nodes/intake.js` — the `WM_N8N_BASE_URL` line in `FALLBACK`
- [ ] `n8n/nodes/review-page.js` — the `WM_N8N_BASE_URL` line in `FALLBACK`
- [ ] Re-paste both files into their n8n Code nodes.

These only fire when `$env` is unavailable. But if it ever is, you silently
revert to flagged links — so they don't get to keep the old host.

⚠ **Do not paste `nodes/commit.js` from the working tree.** It carries
uncommitted workflow D/E changes that swap the client's booking button from a
working Acuity link to a `/webhook/book` URL that nothing serves yet. Work
from a branch off `HEAD`, or leave that file alone entirely.

## 04 · Flip the base URL · Dokploy (n8n app)

- [ ] Set `WM_N8N_BASE_URL=https://booking.waymakerink.com` (no trailing slash)
- [ ] Restart n8n.
- [ ] Confirm `$env` still resolves in a Code node:
      `return [{ json: { ok: typeof $env !== 'undefined' } }];`

Every tier button in the next request email is rebuilt from this value.

## 05 · Move intake same-origin · Dokploy (form app)

- [ ] Set `WM_WEBHOOK_URL=https://booking.waymakerink.com/webhook/booking-request`
- [ ] Redeploy the form container.

Optional but nearly free: it drops the CORS preflight and removes the flagged
host from the public page source, where it's a client-facing risk too.

## 06 · End-to-end verification

- [ ] Submit a real request through the form **with 3+ images**. This is the
      `client_max_body_size` test — a 413 shows up here or nowhere.
- [ ] Sheet row appears; artist request email arrives.
- [ ] Tier buttons point at `booking.waymakerink.com`. No `fifthstonedev`
      anywhere in the message source.
- [ ] Click a tier button — review page renders clean, no interstitial.
- [ ] Submit the review form — decision commits, row updates, client email sends.
- [ ] Client email's booking button still opens the correct Acuity calendar.
- [ ] Delete `&sig=` from a decision URL — expect **403**.
- [ ] **Old host still answers:** `curl -i https://n8n.fifthstonedev.com/webhook/decide`

---

# Phase B · same day — close the surface, then ask

Both depend on Phase A being verified. The review is one shot.

## 07 · Lock the n8n editor off the public root · Dokploy / Traefik

Order matters here too, or you break the in-flight links from the 30-day tail.

- [ ] Add a **higher-priority** Traefik router for
      ``Host(`n8n.fifthstonedev.com`) && PathPrefix(`/webhook/`)`` with **no**
      middleware.
- [ ] Verify a webhook on the old host still answers.
- [ ] *Then* attach `basicAuth` (or an IP allowlist) to the catch-all host
      router, covering `/` and `/rest/`.
- [ ] Confirm the editor still loads behind the auth prompt.

`/webhook-test/` falls under the catch-all and gets locked. That's correct —
it's an editor feature. Confirm nothing outside this repo calls that host first.

## 08 · Request the blocklist review

- [ ] Confirm Phase A is live and verified first. Requesting earlier just gets
      the domain re-flagged.
- [ ] Google: Search Console → add `fifthstonedev.com` as a **Domain**
      property (DNS TXT verification) → Security & Manual Actions → Security
      Issues → Request Review. Typically 1–3 days.
- [ ] Microsoft, if step 00 pointed there instead:
      `microsoft.com/wdsi/support/report-unsafe-site`.
- [ ] Re-check `waymakerink.com` on Safe Browsing a week later, to confirm the
      pattern didn't follow the links onto the primary domain.

---

# Phase C · only if the flag comes back — sender identity

Not scheduled. Written down so the next move is already decided.

## 09 · Move the sender onto the domain

**Deferred by choice — 2026-08-17.** Google Workspace was considered and
declined; sending volume doesn't justify a seat.

Note the reason to revisit is *not* volume. It's that
`From: thewaymakerink@gmail.com` and links on `waymakerink.com` are two
different identities in one branded message, and sender-domain ≠ link-domain is
a standard phishing heuristic. Gmail's *Report phishing* button feeds Safe
Browsing directly, so one or two artist reports is enough to flag a domain —
which may well be how `fifthstonedev.com` got flagged in the first place.
Phase A takes the message from three identities to two. This step takes it to
one.

**Starting state**, checked 2026-08-17 against 8.8.8.8 — the domain has no mail
infrastructure at all, so any future sender work starts from zero:

```
waymakerink.com          TXT  (none)          no SPF, no DKIM, no DMARC
                         MX   (none)          receives no mail
                         A    198.49.23.144   Squarespace
booking.waymakerink.com  A    76.13.106.94    Dokploy host
```

**The no-cost path, if it's ever needed.** A transactional email provider —
Resend, Postmark, MailerSend, Brevo — verifies `waymakerink.com`, hands you
DKIM and SPF records to publish, and has a free tier well above this workflow's
volume. Full alignment for $0, at the cost of swapping the Gmail node for an
SMTP node on all three Send Email steps (A7, C9a, C9b) and re-testing both
client paths.

Workspace remains the lower-effort option if it's ever wanted for other
reasons — the Gmail node uses OAuth, so that migration is a credential re-auth
with no change to the node's field mapping.

```
; whichever provider — these two are published alongside its DKIM record
waymakerink.com.        TXT  "v=spf1 include:<provider> ~all"
_dmarc.waymakerink.com. TXT  "v=DMARC1; p=none; rua=mailto:you@example.com"
```

If you do this, the word *pass* is not the check. The domain in `header.from=`
must **match** `header.i=` on DKIM and `smtp.mailfrom=` on SPF. A `dkim=pass`
whose `d=` belongs to the provider while `From:` says `waymakerink.com` is a
DMARC **fail** — the usual way people conclude they're fine when they aren't.
Verify with Gmail → ⋮ → Show original, and score the message at mail-tester.com.

---

## The 30-day tail

`TTL_DAYS = 30` in `nodes/intake.js` governs the decision links. Request
emails already sent carry the old host and stay valid for 30 days.

- Artists clicking those keep seeing the warning. Nothing in this cutover
  changes that.
- `n8n.fifthstonedev.com/webhook/` **must stay reachable** for the full window.
- If you need the warnings gone sooner, re-send request emails for every open
  request. That regenerates the links on the new host.

**Keep the old host's `/webhook/` open until:** ____________
*(cutover date + 30 days)*

## Rollback

Under a minute, and the old host stays up throughout, so nothing in flight breaks.

1. Revert `WM_N8N_BASE_URL` to `https://n8n.fifthstonedev.com`, restart n8n.
2. Revert `WM_WEBHOOK_URL`, redeploy the form container.

Leave the nginx block in place — it's additive and costs nothing when unused.

## Out of scope

- **Workflows D and E** (`/webhook/book`, `/webhook/book-go`) are not built.
  The `^~ /webhook/` block already covers them, so no second nginx edit when
  they land.
- **`nodes/booking-page.js`** still has the old host in its `FALLBACK`. Worth
  changing with the D/E work so it doesn't ship pointing at a dead domain.
- **Webhook path namespacing.** The registered paths — `booking-request`,
  `decide`, `decide-commit` — are generic words claimed at the n8n *instance*
  level. The second client who wants a `decide` webhook collides and their
  workflow won't activate. Fix by prefixing (`wm-decide`) when onboarding
  client #2, and narrow each client's nginx block to `^~ /webhook/wm-` at the
  same time. Not now — renaming invalidates every in-flight decision link.
