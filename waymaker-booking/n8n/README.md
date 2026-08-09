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
- `PASTE_BOOKING_REQUESTS_FOLDER_ID` → the per-request Drive folder from the
  upload node, not the root folder.
- Add the artist's name somewhere visible, and give `toLocaleString` an
  explicit `timeZone` so it doesn't format in the server's zone.

## Still open

- **The client confirmation email.** Workflow A doesn't send one. The form's
  success copy no longer claims otherwise, so this is a missing nicety rather
  than a false statement to every client.
- **Inline reference thumbnails** in the artist email. `cid:` isn't reachable
  through n8n's email nodes; hosting the resized copies on
  `forms.waymakerink.com` and linking them is the route that works. Use the
  `rid` as the path segment so URLs aren't guessable — these are client photos.
