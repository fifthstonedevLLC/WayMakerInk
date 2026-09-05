# Build sheet — "Portal Response"

The workflow the admin portal calls when an artist presses **Send Response** or
**Decline**. Build it from nothing, in this order.

It replaces Workflows B and C entirely — the signed decision link, the review
page, `Verify link`, `Lookup Rid`, the Merge and `Commit`. All of that existed
to answer "who is this and what did they choose" from a URL in an email. The
artist is logged into a portal now, and the decision is already recorded in
Postgres before this workflow is called. **Five nodes, and every one of them is
about sending an email.**

Node names marked ⚠ are resolved by name somewhere. Everything else is yours.

---

## Step 0 — before you open n8n

### 0.1 On the n8n container

| Variable | Value | Why |
|---|---|---|
| `WM_N8N_SIGNING_SECRET` | output of `openssl rand -base64 32` | ✅ the verify node throws on the placeholder |
| `NODE_FUNCTION_ALLOW_BUILTIN` | `crypto` | ✅ HMAC verification needs it |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `false` | ✅ for `$env` to resolve |

Restart n8n after setting these.

The **same** `WM_N8N_SIGNING_SECRET` goes on the Supabase side. If `$env` is
unavailable in your install, edit the `FALLBACK` block at the top of the verify
node instead — nothing else in the file changes.

### 0.2 On the Supabase functions

```sh
WM_N8N_RESPOND_URL=https://n8n.fifthstonedev.com/webhook/wm-respond-uat
WM_N8N_SIGNING_SECRET=<the same value>
```

⚠ **`/webhook/`, not `/webhook-test/`.** A test URL accepts exactly one request
and only while the editor is open with *Listen for test event* armed. Point the
function at one and the first response works, then every response after it
fails with a 404 — and rolls the request back to `NEW`, so the artist sees
"still open" and tries again.

### 0.3 Credentials

One SMTP credential (or Gmail). Nothing else — this workflow reads no sheet, no
database, no Drive.

---

## The nodes

| # | Type | Name | Key settings |
|---|---|---|---|
| 1 | **Webhook** | `Portal response` | Method `POST` · Path `wm-respond-uat` · Respond **When Last Node Finishes** · Options → Raw Body **OFF** |
| 2 | **Code** ⚠ | `Verify` | Mode **Run Once for All Items** · paste [`verify-signature.js`](verify-signature.js) · set `REQUIRE_SIGNED` (below) |
| 3 | **If** | `Decline?` | Boolean → `={{ $json.isDecline }}` → **is true** |
| 4a | **Send Email** | `Email client — decline` | `Decline?` **true** branch · `client-email-decline.html` |
| 4b | **Send Email** | `Email client — booking` | `Decline?` **false** branch · `client-email-booking.html` |

### Wiring

```
1 Webhook ──▶ 2 Verify ──▶ 3 Decline? ┬─ true ──▶ 4a Email — decline
                                       └─ false ─▶ 4b Email — booking
```

That is the whole graph. No Merge, no lookup, no Respond node.

---

## 1 · Webhook

| Field | Value |
|---|---|
| HTTP Method | `POST` |
| Path | `wm-respond-uat` |
| Authentication | None (see *A second gate* below) |
| Respond | **When Last Node Finishes** |
| Options → Raw Body | **OFF** |

⚠ **Respond mode is the single most important setting in this workflow, and
the default is wrong.**

`respond` on the Supabase side claims the request row, POSTs here, and decides
what happened **from the HTTP status alone**: 2xx means sent and the row becomes
`LINK_SENT`; anything else rolls it back to `NEW` so the artist can retry.

**Respond: Immediately** — the default — ACKs with a 200 the instant the request
lands, *before the workflow runs*. A workflow that then throws on its first node
and sends nothing still reports success. The request is marked answered, the
client's inbox stays empty, and nothing errors anywhere. That is the worst
failure this system can produce, because it is invisible from both ends.

This was observed, not theorised: the first live test returned a clean
`missing-signature` rejection, sent no mail, and still came back `LINK_SENT`.

**When Last Node Finishes** responds after the workflow completes — 200 on
success, 500 if any node threw. That is exactly the signal `respond` needs.

*Using 'Respond to Webhook' Node* also works and lets you control the body, but
it adds a trap: both email branches must reach the Respond node, and if one
does not, that branch returns an error **after the email has already gone out**.
`respond` rolls the row back, the artist sends again, and the client gets two
emails. The mode above has no such branch to forget.

⚠ **Raw Body OFF.** The verify node reads the parsed body. With it on,
`$json.body` is bytes, every field reads as `undefined`, and the recomputed
signature covers `rid=`, `to=` — failing with a message that sounds like a
secret mismatch and sends you looking in the wrong place.

---

## 2 · Verify ⚠

Paste [`verify-signature.js`](verify-signature.js). Mode **Run Once for All
Items**.

Edit one line at the top:

```js
const REQUIRE_SIGNED = ['rid', 'action', 'to', 'bookingUrl'];
```

That is the node asserting what the signature must cover, rather than trusting
the caller's own `X-WM-Signed` header. Without it, a caller could sign a canon
of just `rid` and leave the recipient unprotected.

**What it does.** Every call carries three headers:

```
X-WM-Timestamp   unix seconds
X-WM-Signed      the field names covered, comma separated
X-WM-Signature   v1=<hmac-sha256 hex>
```

The node recomputes the HMAC over `v1`, the timestamp, and one `name=value` line
per signed field, and **throws** if it does not match, if the timestamp is more
than 5 minutes from now, or if a required field is unsigned.

It throws rather than branching on purpose. An If node has a false output you
can leave dangling or wire wrong, and the workflow sends anyway. A throw stops
the execution, puts the reason in the log, and — with the Respond mode above —
returns the 500 that makes `respond` roll the request back.

**It also flattens the body.** Everything downstream reads `$json.to`, not
`$json.body.to` and not `$('Commit').first().json.to`.

---

## 3 · Decline?

| Field | Value |
|---|---|
| Conditions | **Boolean** → `={{ $json.isDecline }}` → **is true** |

⚠ Use the **Boolean** comparison, not String. `isDecline` arrives as a real JSON
boolean; comparing it as a string against `"true"` works by accident on some
n8n versions and silently sends every client the wrong email on others.

---

## 4a / 4b · Send Email

Identical on both nodes except the HTML body.

| Field | Value |
|---|---|
| From | your sending address |
| To | `={{ $json.to }}` |
| Reply To | `={{ $json.replyTo }}` ← the artist, so the client's reply reaches them |
| Subject | `={{ $json.subject }}` |
| Email Format | **HTML** |
| HTML (4a) | contents of [`templates/client-email-decline.html`](templates/client-email-decline.html) |
| HTML (4b) | contents of [`templates/client-email-booking.html`](templates/client-email-booking.html) |
| Options → Append n8n Attribution | **OFF** |
| Settings → Continue On Fail | **OFF** |

`respond` computes the right subject for each path, so both nodes use the same
expression.

### The templates are ready to paste

[`templates/client-email-booking.html`](templates/client-email-booking.html) and
[`templates/client-email-decline.html`](templates/client-email-decline.html) are
already converted — all 27 `$('Commit').first().json.` references rewritten to
`$json.`, including the three hidden inside the artist-note ternary. Paste them
as they are.

⚠ **Do not take the copies in `../../waymaker-booking/n8n/templates/`.** Those are
the originals and they are still correct *there* — production runs the old
Workflow C, where the node hangs off the Sheets update and values have to be
addressed through `Commit` by name. Both files are right, for different
workflows. Paste the wrong one and every value renders empty: no greeting, no
estimate, no button destination.

⚠ **Append n8n Attribution defaults to ON.** Left on, n8n appends
`--- This email was sent automatically with n8n` below the template on every
send. It is a node option, not part of the HTML, so no amount of editing the
template removes it. These are the client-facing sends, so it matters most here.

⚠ **Continue On Fail must stay OFF.** A Send Email node that swallows its own
failure lets the workflow finish successfully, which tells `respond` the client
was emailed when the SMTP server refused it.

⚠ **Paste each template whole, `<!doctype html>` and `<head>` included.** They
are complete documents, not body fragments. n8n sends the HTML field verbatim
without wrapping it, so the `<head>` is the only place the viewport meta and the
media queries can live. Dropping it costs three things at once: mobile clients
fall back to desktop width and scale the message down to unreadable, the buttons
stop collapsing to one column, and Outlook/Gmail dark mode inverts the dark
surfaces to white while leaving the light text sitting on top of them.

---

## The payload

Everything the templates need is in the body — this workflow never looks
anything up. From `respond`:

| Field | Example | Notes |
|---|---|---|
| `rid` | `WMI-SEED02-BBBB` | signed |
| `action` | `send` \| `decline` | signed |
| `isDecline` | `true` / `false` | what node 3 branches on |
| `to` | `theo.ashworth@example.test` | signed — the recipient |
| `replyTo` | the artist's address | |
| `subject` | `Your estimate from Laynie Joy — ready to book` | |
| `firstName`, `lastName` | `Theo`, `Ashworth` | |
| `artistKey`, `artistName` | `laynie`, `Laynie Joy` | |
| `service` | `tattoo` \| `piercing` \| `touchup` | |
| `estimate` | `Pair · $75` | what the artist approved |
| `message` / `artistNote` | the artist's note | same value under both names |
| `bookingUrl` | `https://waymakerink.as.me/?appointmentType=…` | signed — empty on a decline |
| `tierKey` | `pierce`, `tier3`, `touchup30` | |

`message` and `artistNote` are deliberately the same value under two names: the
templates address `artistNote`, and they are pasted text inside an n8n node
where nothing type-checks them — a renamed field shows up as a blank paragraph
in a client's email rather than an error.

---

## Turning it on

1. **Save**, then **Activate** (toggle, top right). `/webhook/` paths only work
   on an active workflow.
2. Set `WM_N8N_RESPOND_URL` on the Supabase functions to the `/webhook/` path.
3. Deploy: `npx supabase functions deploy respond`.

---

## Test order

| # | Do | Expect |
|---|---|---|
| 1 | Respond to a request from the portal | Client email arrives; execution shows `wmVerified: true`; the row is `LINK_SENT` |
| 2 | Check the email on a phone | Buttons in one column, dark surfaces still dark |
| 3 | Decline a different request | Decline template, **no** price and **no** button; row `DECLINED` |
| 4 | Confirm the artist's note renders | The bordered note block appears, signed with the artist's name |
| 5 | `curl -X POST <webhook url> -d '{"rid":"x"}'` | Fails at `Verify` with *Unsigned request*; no email |
| 6 | Replay a real execution's request ten minutes later | Fails with *Timestamp is …s away from now* |
| 7 | Change `WM_N8N_SIGNING_SECRET` on n8n only, restart, respond again | Portal shows *n8n rejected the signature (403)…*, and the request stays **open** |
| 8 | Point the SMTP credential at a bad host, respond again | Portal reports the failure and the row is still `NEW` — **not** `LINK_SENT` |

Steps 7 and 8 are the ones worth actually running. They prove the rollback: a
failed send leaves the request open for a retry rather than marking it answered
with nothing delivered. Step 4 is the find-and-replace — a blank note means one
of the `$('Commit')` references inside the ternary survived.

---

## A second gate, optional

n8n's Webhook node has built-in **Authentication → Header Auth**, which rejects
with a 401 *before the workflow executes at all* — no execution recorded, no
Code node reached.

Worth adding on top, not instead. It is a static string, so it does nothing
about replay or tampering, but it means a scanner that finds the URL costs
nothing rather than one execution per hit. If you add it, use a header name
other than the three `X-WM-*` ones and give it its own variable — reusing the
signing secret as a plaintext header value would put it in every proxy log
between Supabase and n8n.

---

## The other workflow

`booking-request-uat` — the "you have a new request" mail — is the same shape
minus the If and one email node:

```
Webhook ──▶ Verify ──▶ Send Email (to the artist)
```

Same Respond mode, same Raw Body OFF, same verify node with
`REQUIRE_SIGNED = ['rid', 'artistEmail']`. Its payload is `rid`, `service`,
`artistKey`, `artistName`, `artistEmail`, `firstName`, `lastName`,
`clientEmail`, `portalUrl`.

Its template is [`templates/artist-email-request.html`](templates/artist-email-request.html):
the request number, the client's name, the service, and a button to
`{{ $json.portalUrl }}`. The request is read in the portal now, so the email is
a doorbell, not a briefing. Reference images are deliberately **not** attached:
they are in the portal, and mailing a client's photographs to an inbox is a copy
nobody can revoke.

⚠ **No Acuity link in it, and none should be added.** When this email is sent
the request has not been priced or claimed, so no tier — and therefore no
appointment type — exists yet. The booking link is minted later by `respond`
into `client-email-booking.html`. One here would let a client book a session
nobody has quoted.

⚠ `service` arrives as the machine key (`tattoo` / `piercing` / `touchup`), so
the template carries a ternary to render it. `touchup` has no space and its
label does — that is why it is a map and not a capitalise.

Its failure is also less costly, which is why `intake` logs a failed notify and
carries on: the request is already committed and visible in the portal whether
or not the mail lands.
