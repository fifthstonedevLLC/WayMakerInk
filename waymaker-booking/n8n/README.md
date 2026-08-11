# n8n wiring — booking request → decision → client email

Three workflows. The split exists because the request email is read hours or
days later, in a different execution, on a device n8n has never seen — so the
decision has to be reconstructable from a URL plus a stored row, and nothing
else.

```
Workflow A  ── the client submits ──────────────────────────────────────────
  Webhook POST /booking-request  →  Code: Intake  →  Drive: upload refs
                                          │              (per-request folder)
                                          ├──────→  Sheets: append row
                                          └──────→  Email: request to artist
                                                        (attachments)

Workflow B  ── the artist taps a button in that email ──────────────────────
  Webhook GET /decide  →  Code: Verify link  →  IF valid
                                                 ├─ true  →  Sheets: lookup rid
                                                 │            →  Code: Review page
                                                 │            →  Respond (HTML)
                                                 └─ false →  Respond (HTML, 403)

Workflow C  ── the artist presses send on that page ────────────────────────
  Webhook POST /decide-commit  →  Code: Verify Link  →  IF valid
                                                         ├─ false →  Respond (403)
                                                         └─ true ─┬───────────────┐
                                                                  │               ▼
                                                     Sheets: lookup rid  →  Merge ▸2
                                                                          Merge ▸1 ◀┘
                                                            →  Code: Commit
                                                            →  IF sendEmail
                                                                ├─ Sheets: update
                                                                ├─ Email: client
                                                                └─ Respond (HTML)
```

The IF's true output feeds the Merge twice: once directly (the signed
decision) and once via the sheet lookup (the client's row). `Commit` needs
both, and they only exist on separate branches — see the build sheet's C5 for
the settings, including the clash rule that decides whose `estimate` survives.

## Why B and C are separate

Workflow B's webhook is a `GET` that only ever renders. Mail scanners, link
preview services and corporate URL-rewriters fetch links out of emails without
anyone clicking, so a `GET` that decided a request would fire by itself. All
mutation lives behind the `POST` in C.

## Environment

On the n8n host:

| Variable | Purpose |
|---|---|
| `WM_SIGNING_SECRET` | HMAC key for the decision links. `openssl rand -base64 32`. Rotating it invalidates every unopened request email. The nodes throw rather than run on the placeholder value. |
| `WM_N8N_BASE_URL` | e.g. `https://n8n.fifthstonedev.com`. Used to build the link targets. |
| `WM_ARTIST_NIC_EMAIL` / `WM_ARTIST_LAYNIE_EMAIL` | Where the request email goes. The intake node throws on a `REPLACE_` value. |
| `WM_BOOKING_LINKS` | Optional JSON override for the Acuity links; falls back to the map in `nodes/commit.js`. |
| `NODE_FUNCTION_ALLOW_BUILTIN` | Must include `crypto` — signing is HMAC-SHA256 and the nodes `require('crypto')` outright. There is no non-crypto fallback; the previous 32-bit string hash was forgeable and has been removed. |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | Must be `false` (the default) for `$env` to resolve inside Code nodes. |

**`$env` is not `$vars`.** n8n *Variables* (`$vars`) is Enterprise-only; `$env`
reads OS environment variables and works on self-hosted Community. If `$env`
turns out to be unavailable, every Code node carries a `FALLBACK` block at the
top — edit that instead and nothing else changes.

And in Dokploy, on the form container: `WM_WEBHOOK_URL` pointed at the
**production** path `/webhook/booking-request`, plus `WM_ARTISTS` as a JSON
object controlling which artists are live. `docker-entrypoint.sh` writes both
into `public/config.js` at container start.

## The store

Google Sheets is the low-friction choice since you're already in Drive.
Postgres or n8n Data Tables work identically — the only requirement is a
lookup by `rid` and an update in place.

Columns:

```
rid  status  tierSent  decidedAt  estimate  artistNote
artistKey  artistName  artistEmail
firstName  lastName  email  phone  firstTattoo
idea  placement  size  style
submittedAt  pageUrl  referenceCount  driveFolder
```

`status` starts as `NEW` and becomes `LINK SENT` or `DECLINED`, with `BOOKED`
reserved for a future workflow watching Acuity. Which tier was quoted is a
separate `tierSent` column — the status says where the request is, not what was
chosen, so "waiting on a client" stays one filter however many tiers exist.

That column is the entire mechanism behind *"once you've used one of these
buttons, the rest stop working"* — the links themselves stay cryptographically
valid until `exp`, they just stop doing anything.

Two Code files gate on it, and they have to agree: `nodes/review-page.js`
decides whether to render the form, `nodes/commit.js` decides whether to
send. Both uppercase the value and treat `NEW`, `PENDING`, and an empty cell as
undecided. If one of them is stricter than the other, that workflow rejects
every request while the other keeps working — which is easy to misread as a
signing or lookup problem.

## Node settings that are easy to miss

**Both decision webhooks** need *Respond* set to **Using Respond to Webhook
node**, or n8n answers immediately with its own JSON and the artist sees a
blank page.

**Workflow C's webhook** needs to accept form-encoded bodies — the review page
posts a plain HTML `<form>`, not JSON.

**The artist email node**, Attachments / Attribute Name:

```
={{ $json.attachmentProps }}
```

The intake node reads the real binary keys off the item rather than assuming
`reference1…`, so this survives n8n's version-to-version differences in how it
names multipart uploads.

**Anything between the webhook and that email node drops binary** unless it
carries `binary` through explicitly. A Set node with *Keep Only Set* is the
usual culprit. Safest layout is the branch shown above, where the email node
hangs directly off the intake node.

**Reply-To** on the artist email → the client's address, so replying just
works.

## Changes needed in `templates/request-email.html`

- ~~Every decision `href` becomes the signed URL~~ — **done.** All six buttons
  now use `{{ $json.links.tier1 }}` … `{{ $json.links.decline }}`. They
  previously built their own `/webhook-test/decide?rid=…&action=…` URLs with no
  `sig` and no `exp`, which is exactly what the old "unsigned means valid"
  branch in `nodes/verify-link.js` was propping up. Both are fixed together;
  hand-built URLs are now rejected.
- Every `{{ $execution.id }}` becomes `{{ $json.rid }}`.
- The `body.budget` and `body.timing` rows have no matching form fields —
  delete them or add the inputs to `public/index.html`.
- Field references lose the `body.` prefix: `{{ $json.firstName }}` etc.
- The references button already resolves the per-request Drive folder via
  `$('Create folder').first().json.id`. It needs A3 wired off A2 *before* A7 —
  see the wiring warning in `BUILD-SHEET.md`.
- Add the artist's name somewhere visible, and give `toLocaleString` an
  explicit `timeZone` so it doesn't format in the server's zone.
- ~~The phone number is dead text~~ — **done.** It's a `tel:` link now, with
  `.replace(/[^0-9+]/g,'')` stripping the formatting the form lets clients type,
  so the artist can call straight from the email on a phone.

## Referral tracking

`heardFrom` is a required select on the form; `referredBy` is an optional text
input that only appears once the chosen source implies a person. That split is
the whole design — a count of `heardFrom` proves referrals are working but
names nobody, and naming people is the point.

The three sources that reveal the name field are listed in `REFERRAL_SOURCES`
in `public/app.js` and must match the `<option value>` strings in
`public/index.html` character for character; a mismatch fails silently, with the
name field simply never appearing. `Other` reveals the same input with different
copy, so `referredBy` holds a description rather than a name on those rows —
filter on `heardFrom` before counting. BUILD-SHEET §0.2a has the leaderboard
query.

`app.js` blanks `referredBy` whenever the field is hidden. Without that, a
client who types a name and then changes the source leaves the name inside the
`<form>`, and `FormData` files it against a row that says Instagram.

Adding or renaming a source is two edits — the `<option>` in `index.html`, and
`REFERRAL_SOURCES` if it names a person. Nothing downstream enumerates the
values: `intake.js` passes the string through and the sheet stores it as text.

## Email rendering

All three email templates (`request-email.html`, `client-email-booking.html`,
`client-email-decline.html`) are **complete HTML documents** — paste them whole,
doctype and `<head>` included. BUILD-SHEET's C9a/C9b section explains what
breaks when the head is dropped.

They read as one design: `#080808` page, `#111111` cards, `#f7f7f7` body copy,
`#a8a29a` for anything secondary, `#f5c684` gold for accents and buttons. The
muted tone used to be `#666666`, which is 3.5:1 against the page background —
under the 4.5:1 minimum, and genuinely hard to read on a phone in daylight.
`#a8a29a` is 7.9:1 and clears the stricter 7:1 bar. If you introduce another
grey, check it against `#080808` before it ships.

The layout is fluid to a `max-width:600px` rather than locked at 600px. That
was the actual cause of the white gutter on phones: the content table was wider
than the background-painted area, so scrolling right ran off the end of the
design. Outlook desktop, which ignores `max-width`, is held at 600px by the
`<!--[if mso]-->` ghost table instead.

Type is 16px for body copy and 13–15px for fine print, with buttons at 16px+
and ~50px tall so they are comfortable tap targets. Nothing sits below 12px.

## Still open

- **The client confirmation email.** Workflow A doesn't send one. The form's
  success copy no longer claims otherwise, so this is a missing nicety rather
  than a false statement to every client.
- **Inline reference thumbnails** in the artist email. `cid:` isn't reachable
  through n8n's email nodes; hosting the resized copies on
  `forms.waymakerink.com` and linking them is the route that works. Use the
  `rid` as the path segment so URLs aren't guessable — these are client photos.
