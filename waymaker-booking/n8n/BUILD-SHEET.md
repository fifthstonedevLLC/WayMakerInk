# n8n build sheet — top-down

Walk this in order. Step 0 first, then Workflow A, B, C.

Node names marked ⚠ are not cosmetic: something elsewhere resolves them by
name at runtime, either a Code file calling `$('Name')` or an expression in a
later node. Case and spacing have to match exactly — n8n also appends a digit
(`Verify link1`) when you paste a node whose name is already taken, which
silently breaks the reference. Unmarked names are yours to change.

### Status vocabulary

`status` records **where the request is**, not what the artist chose:

| Value | Meaning | Written by |
|---|---|---|
| `NEW` | appended, nobody has looked at it | A6 `Append row` |
| `LINK SENT` | priced; client has the estimate and booking link | C8 `Update row` |
| `DECLINED` | artist turned it down | C8 `Update row` |
| `BOOKED` | client actually booked | *nothing yet — see below* |

Which tier was sent lives in its own **`tierSent`** column (`tier1`…`tier5`,
blank on a decline). Keeping it out of `status` means "everything waiting on a
client" is one filter rather than five, and adding a sixth tier doesn't change
what a status filter has to match.

`BOOKED` is not written by any current workflow. Workflow C ends at
`LINK SENT`; something watching Acuity has to move it on. Both gates already
treat `BOOKED` as decided, so that can be added without touching them.

`PENDING` and an empty cell count as undecided too, for rows created before
this was settled. The gates in `nodes/review-page.js` and `nodes/commit.js`
both uppercase before comparing and share the same `OPEN_STATUSES` list — when
the two disagree, one of them locks out every request.

---

## Step 0 — before you open n8n

### 0.1 Environment variables on the n8n container

| Variable | Value | Required |
|---|---|---|
| `WM_SIGNING_SECRET` | output of `openssl rand -base64 32` | ✅ nodes throw if left at the placeholder |
| `WM_N8N_BASE_URL` | `https://booking.waymakerink.com` (no trailing slash) — the booking domain, not the n8n host; see `LINK-CUTOVER.md` | ✅ |
| `WM_ARTIST_NIC_EMAIL` | Nic's real address | ✅ nodes throw on `REPLACE_` |
| `WM_ARTIST_LAYNIE_EMAIL` | Laynie's real address | ✅ nodes throw on `REPLACE_` |
| `WM_BOOKING_LINKS` | JSON: `{"nic":{"tier1":"https://…"},…}` | optional — falls back to the map in `nodes/commit.js` |
| `NODE_FUNCTION_ALLOW_BUILTIN` | `crypto` | ✅ signing uses HMAC-SHA256 |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `false` | ✅ for `$env` to resolve |

Restart n8n after setting these.

**`$env` is not `$vars`.** n8n *Variables* (`$vars`) is an Enterprise feature.
`$env` reads OS environment variables and works on self-hosted Community as
long as `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`. Check which you have:

```js
return [{ json: { envAvailable: typeof $env !== 'undefined', canRead: !!($env && $env.PATH) } }];
```

If `$env` is unavailable, every Code node has a `FALLBACK` block at the top —
edit the values there instead. Nothing else in the node changes.

### 0.2 Google Sheet

One sheet, row 1 = headers, exactly these names:

```
rid  status  tierSent  decidedAt  estimate  artistNote
artistKey  artistName  artistEmail
firstName  lastName  email  phone  firstTattoo
heardFrom  referredBy
idea  placement  size  style
submittedAt  pageUrl  referenceCount  driveFolder
```

**Adding `heardFrom` / `referredBy` to an existing sheet:** append them as new
columns at the far right rather than inserting them mid-table. n8n's *Map Each
Column Manually* matches on the header name, not position, so the order in the
sheet is free — but inserting a column shifts every formula and saved filter
that referenced the old letters.

### 0.2a Referral leaderboard

`referredBy` carries a person's name when `heardFrom` is one of the three
referral sources, and a free-text description when it is `Other` — the source
column is what tells the two apart. Filter before counting or the "Other" rows
land in the leaderboard:

```
=QUERY(A:Z, "select K, count(A) where K is not null and K != ''
             and J matches 'Friend or family|A previous client|Another artist or shop'
             group by K order by count(A) desc label count(A) 'Referrals'", 1)
```

Point `J` at `heardFrom` and `K` at `referredBy` — the letters depend on where
the columns landed. `COUNTIF` ignores case, and `intake.js` collapses interior
whitespace, so `jane doe` and `Jane  Doe` group together; it does **not**
reconcile `Jane` against `Jane Doe`, so expect some hand-tidying.

### 0.3 Config that must be real before launch

All of it now lives in 0.1's environment variables — no source editing, unless
`$env` is unavailable in your install, in which case edit each node's
`FALLBACK` block instead.

| What | Where | State |
|---|---|---|
| Signing secret | `WM_SIGNING_SECRET` | ❌ still the `dev-signing-secret` placeholder |
| Artist emails | `WM_ARTIST_*_EMAIL` | ❌ still `REPLACE_nic@` / `REPLACE_laynie@` |
| Acuity booking links | `WM_BOOKING_LINKS` or the map in `nodes/commit.js` | ✅ present for both artists |

Unlike before, these now **fail loudly**: `nodes/intake.js` and
`nodes/verify-link.js` throw on the placeholder secret, and `nodes/intake.js`
throws on any `REPLACE_` artist email. A request can no longer run clean
through Workflow A and mail a non-existent address.

`BOOKING_LINKS` holds the same five appointment-type IDs for both artists.
Correct if Acuity routes by staff member; wrong if each artist has their own
appointment types — confirm before go-live.

### 0.5 Environment variables on the form container

Set in Dokploy on the booking-form app, read by `docker-entrypoint.sh` at
container start and written into `public/config.js`:

| Variable | Value |
|---|---|
| `WM_WEBHOOK_URL` | `https://booking.waymakerink.com/webhook/booking-request` — **`/webhook/`, not `/webhook-test/`** |
| `WM_ARTISTS` | JSON: `{"nic":{"enabled":true,"name":"Nic Sinnwell"},"laynie":{"enabled":false,"name":"Laynie Joy"}}` |
| `WM_HOME_URL` | optional — where the confirmation page returns to. Defaults to `https://waymakerink.com` |
| `WM_REDIRECT_SECONDS` | optional — how long the client gets to read the confirmation first. Defaults to `20`; **`0` switches the auto-return off** |

Enabling an artist is an edit to `WM_ARTISTS` — no code change, no redeploy of
the image. Artist *emails* are deliberately absent: this file is public, and
the intake workflow resolves the artist from its own server-side map anyway.

`docker-entrypoint.sh` validates all four before writing `config.js`, because
anything malformed there is a syntax error that takes the whole form down, not
just the setting it came from. A `WM_HOME_URL` containing a quote or using a
non-`http(s)` scheme is dropped with a warning — the value lands in an `href`,
so `javascript:` is refused rather than rendered. `WM_REDIRECT_SECONDS` must be
digits only. Anything rejected falls back to the app's default, and the
container logs which values it used on boot.

### 0.4 Credentials to create in n8n

Google Sheets OAuth2 · Google Drive OAuth2 · SMTP (or Gmail) for sending.

---

## Workflow A — "Booking Intake"

Trigger: the public form POSTs `multipart/form-data`.

| # | Node type | Name | Key settings |
|---|---|---|---|
| A1 | **Webhook** | `Booking request` | Method `POST` · Path `booking-request` · Respond: **Immediately** · Options → Raw Body **off** |
| A2 | **Code** | `Intake` | Mode **Run Once for All Items** · paste `nodes/intake.js` |
| A3 | **Code** | `Split refs` | Mode **Run Once for All Items** · paste snippet below (one item per uploaded image) |
| A4 | **Google Drive** | `Create folder` | Resource `Folder` · Operation `Create` · Name `={{ $json.rid }}` · Parent: **By ID** → `1skYBp2W8ZLbFdfBDneNQMrMd0WLzQutF` (Booking Requests) |
| A5 | **Google Drive** | `Upload refs` | Resource `File` · Operation `Upload` · Input Data Field Name `data` · File Name `={{ $binary.data.fileName }}` · Parent Folder: **By ID** → `={{ $('Create folder').first().json.id }}` |
| A6 | **Google Sheets** | `Append row` | Operation `Append` · Mapping **Map Each Column Manually** · see field map below |
| A7 | **Send Email** | `Email artist` | see field map below |

### A — wiring

```
A1 Webhook ──▶ A2 Intake ──┬──▶ A3 Split refs ──▶ A4 Create folder ──▶ A5 Upload refs ──▶ A6 Append row
                           │
                           └──▶ A7 Email artist
```

⚠ **A7 must hang directly off A2.** Any node in between drops the binary and
the artist email arrives with no attachments. A Set node with *Keep Only Set*
is the usual killer.

⚠ **Connect A3 before A7.** Both hang off A2, and with Execution Order **v1**
(Workflow Settings) n8n runs branches to completion in connection order. A7's
reference-folder link reads `$('Create folder').first().json.id` from the other
branch, so A4 has to have run by then. Wire A2 → A3 first, A2 → A7 second. If
the email errors with a `Create folder` reference problem, the connections are
in the wrong order — delete both and re-draw them in that sequence.

The same button falls back to the root Booking Requests folder
(`1skYBp2W8ZLbFdfBDneNQMrMd0WLzQutF`) on requests with no images, where A4
never runs at all. That ID is hardcoded in `templates/request-email.html`; if
the Drive folder is ever moved or recreated, it has to change in two places —
there and A4's Parent above.

If you don't want `driveFolder` populated, you can drop A3–A5 and hang A6 off
A2 as a second branch — the ASCII diagram in the README shows it that way.
The chain above exists only so A6 has a folder ID to write.

### A3 — Split refs code

```js
// One item per uploaded image, so the Drive node can upload them one at a time.
const out = [];
for (const item of items) {
  for (const [key, bin] of Object.entries(item.binary || {})) {
    out.push({ json: { ...item.json, binaryKey: key }, binary: { data: bin } });
  }
}
return out;
```

### A6 — Google Sheets column values

| Column | Value |
|---|---|
| rid | `={{ $('Intake').first().json.rid }}` |
| status | `NEW` |
| tierSent | *(leave blank)* |
| decidedAt | *(leave blank)* |
| estimate | *(leave blank)* |
| artistNote | *(leave blank)* |
| artistKey | `={{ $('Intake').first().json.artistKey }}` |
| artistName | `={{ $('Intake').first().json.artistName }}` |
| artistEmail | `={{ $('Intake').first().json.artistEmail }}` |
| firstName | `={{ $('Intake').first().json.firstName }}` |
| lastName | `={{ $('Intake').first().json.lastName }}` |
| email | `={{ $('Intake').first().json.email }}` |
| phone | `={{ $('Intake').first().json.phone }}` |
| firstTattoo | `={{ $('Intake').first().json.firstTattoo }}` |
| heardFrom | `={{ $('Intake').first().json.heardFrom }}` |
| referredBy | `={{ $('Intake').first().json.referredBy }}` |
| idea | `={{ $('Intake').first().json.idea }}` |
| placement | `={{ $('Intake').first().json.placement }}` |
| size | `={{ $('Intake').first().json.size }}` |
| style | `={{ $('Intake').first().json.style }}` |
| submittedAt | `={{ $('Intake').first().json.submittedAt }}` |
| pageUrl | `={{ $('Intake').first().json.pageUrl }}` |
| referenceCount | `={{ $('Intake').first().json.referenceCount }}` |
| driveFolder | `={{ $('Create folder').first().json.id }}` |

Also set **Execute Once = true** on A6 (Settings tab) so multiple reference
images don't append multiple rows.

### A7 — Send Email fields

| Field | Value |
|---|---|
| From | your sending address |
| To | `={{ $json.artistEmail }}` |
| Reply To | `={{ $json.email }}` ← the client, so replying just works |
| Subject | `={{ $json.firstName }} {{ $json.lastName }} — new booking request` |
| Email Format | HTML |
| HTML | contents of `templates/request-email.html` **whole, `<!doctype html>` and `<head>` included** (see C9a/C9b for why), edited per the README's *Changes needed* list |
| Options → Attachments → Attribute Name | `={{ $json.attachmentProps }}` |
| Options → Append n8n Attribution | **off** |

**Append n8n Attribution defaults to ON.** Left on, n8n appends
`--- This email was sent automatically with n8n` (with a link) below the
template on every send. It is a node option, not part of the HTML, so no
amount of editing the template removes it — turn it off on each Send Email
node individually (A7, C9a, C9b). Older n8n builds may label it
*Append n8n Attribution* under Options; if the toggle is missing entirely,
the version predates it and upgrading is the only fix.

---

## Workflow B — "Decision review page" (renders only, never writes)

| # | Node type | Name | Key settings |
|---|---|---|---|
| B1 | **Webhook** | `Decide` | Method `GET` · Path `decide` · **Respond: Using 'Respond to Webhook' Node** |
| B2 | **Code** ⚠ | `Verify link` | `nodes/review-page.js` calls `$('Verify link')` — the name must match that string exactly, lowercase `l` included · Mode **Run Once for All Items** · paste `nodes/verify-link.js` |
| B3 | **If** | `Valid?` | Condition: Boolean → `={{ $json.valid }}` → **is true** |
| B4 | **Google Sheets** | `Lookup rid` | Operation `Get Row(s)` · Filter: Column `rid` = `={{ $json.rid }}` · Options → Return First Match |
| B5 | **Code** | `Review page` | Mode **Run Once for All Items** · paste `nodes/review-page.js` |
| B6 | **Respond to Webhook** | `Respond page` | Respond With **Text** · Body `={{ $json.html }}` · Headers: `Content-Type: text/html; charset=utf-8` **and `Cache-Control: no-store, must-revalidate`** |
| B7 | **Respond to Webhook** | `Respond 403` | Respond With **Text** · Code **403** · Body: HTML below · same two headers |

⚠ **`Cache-Control: no-store` on every decision response is not optional.**
The review page is a snapshot of a row that changes underneath it. Without it,
a browser, a back-button press, or a corporate link-rewriter can re-serve the
decision form for a request that has already been decided — the artist sees a
live-looking form and n8n is never asked, so no status check runs. The commit
gate in Workflow C still catches the submission and nothing is sent, but the
artist has been shown a form that was never going to work. `nginx.conf` sets
the same header on `index.html` for the same reason.

### B — wiring

```
B1 ──▶ B2 ──▶ B3 ┬─ true ──▶ B4 ──▶ B5 ──▶ B6
                 └─ false ─▶ B7
```

### B7 / C12 — the 403 body

Paste `templates/respond-403.html` into both. It is **static** — no
expressions, nothing to adapt — so the same content goes in each node.

It deliberately does not say *which* check failed. A bad signature, an expired
link and an already-decided request all render the same page: distinguishing
them tells anyone probing `rid` values which ones are real.

If you want the minimal version instead of the styled page, this one-liner is
equivalent in function:

```html
={{ '<!doctype html><meta charset="utf-8"><body style="background:#080808;color:#f7f7f7;font-family:Arial,sans-serif;padding:44px 22px;text-align:center"><p>This link is no longer active.</p></body>' }}
```

Note it no longer branches on `$json.reason` — the earlier version leaked
"expired" versus "not valid" for exactly the reason above.

---

## Workflow C — "Commit decision" (the only workflow that writes)

Unlike B, this workflow needs two things in the same node: the artist's
decision (which only exists on the POST) and the client's row (which only
exists after the sheet lookup). They arrive on different branches, so a Merge
node joins them before `Commit`. That is why no Code file here calls
`$('Verify Link')` — `Commit` reads everything off `$json`.

| # | Node type | Name | Key settings |
|---|---|---|---|
| C1 | **Webhook** | `Decide commit` | Method `POST` · Path `decide-commit` · **Respond: Using 'Respond to Webhook' Node** · Raw Body **off** (form-encoded body must be parsed) |
| C2 | **Code** | `Verify Link` | Mode **Run Once for All Items** · same file as B2, pasted again · name is free here, nothing resolves it |
| C3 | **If** | `Link is Valid?` | `={{ $json.valid }}` is true |
| C4 | **Google Sheets** | `Lookup Rid` | `Get Row(s)` · Column `rid` = `={{ $json.rid }}` · Return First Match |
| C5 | **Merge** | `Merge` | Mode **Combine** · Combine By **Position** · Options → Clash Handling **Prefer Input 1** · see below |
| C6 | **Code** ⚠ | `Commit` | Name is read by C10's expression · Mode **Run Once for All Items** · paste `nodes/commit.js` |
| C7 | **If** | `Send email?` | `={{ $json.sendEmail }}` is true |
| C8 | **Google Sheets** | `Update row` | Operation `Update` · Matching column `rid` · fields below |
| C9 | **If** | `Decline?` | `={{ $('Commit').first().json.isDecline }}` is true |
| C9a | **Send Email** | `Email client — decline` | C9 **true** branch · paste `templates/client-email-decline.html` · fields below |
| C9b | **Send Email** | `Email client — booking` | C9 **false** branch · paste `templates/client-email-booking.html` · fields below |
| C10 | **Respond to Webhook** | `Respond done` | Respond With **Text** · Body: paste `templates/respond-done.html` · Content-Type **and `Cache-Control: no-store, must-revalidate`** |
| C11 | **Respond to Webhook** | `Respond already` | same, body `={{ $json.html }}` (the "already handled" page from C6) |
| C12 | **Respond to Webhook** | `Respond 403` | same as B7 |

### C — wiring

```
                          ┌──────────────────────▶ ▸1 ┐                              ┌─ true ──▶ C9a decline ─┐
C1 ──▶ C2 ──▶ C3 ┬─ true ─┤                           C5 ──▶ C6 ──▶ C7 ┬─ true ─▶ C8 ─▶ C9 ┤                        ├─▶ C10
                 │        └─▶ C4 Lookup Rid ─────▶ ▸2 ┘  Merge         │            └─ false ─▶ C9b booking ─┘
                 │                                                      └─ false ─▶ C11
                 └─ false ─▶ C12
```

Both C9a and C9b feed C10, so the artist gets the same confirmation page
either way — the page itself already says "Declined" or "Sent" based on what
`Commit` decided.

⚠ **C3's true output feeds two nodes.** One edge goes straight to Merge input
1, the other goes through `Lookup Rid` into input 2. Miss the direct edge and
`Commit` throws *"No action on the merged item"*.

### C5 — Merge settings

| Setting | Value |
|---|---|
| Mode | **Combine** |
| Combine By | **Position** |
| Input 1 | `Link is Valid?` → true — carries `rid`, `action`, `exp`, `sig`, `estimate`, `note` |
| Input 2 | `Lookup Rid` — carries the sheet row: client details, `artistKey`, `status` |
| Options → Clash Handling | **Prefer Input 1** |

Both branches carry exactly one item, so **Position** cannot mismatch. Matching
Fields on `rid` joins correctly too, but yields zero items on any mismatch —
and zero items means `Commit` never runs and the artist gets a blank page.

⚠ **Clash Handling is not optional.** Both inputs have an `estimate` field. On
input 1 it is what the artist just typed; on input 2 it is the sheet's
`estimate` column, still empty until C8 writes it one node later. If input 2
wins, the artist's estimate is silently replaced with an empty string and the
client's email goes out with no price. Nothing errors. `rid` and `exp` collide
too, but hold the same value on both sides.

### C8 — columns to update

| Column | Value |
|---|---|
| rid *(match on this)* | `={{ $json.rid }}` |
| status | `={{ $json.status }}` → `LINK SENT` or `DECLINED` |
| tierSent | `={{ $json.tierSent }}` → `tier1`…`tier5`, blank on a decline |
| decidedAt | `={{ $json.decidedAt }}` |
| estimate | `={{ $json.estimate }}` |
| artistNote | `={{ $json.artistNote }}` |

### C9a / C9b — Send Email fields

Identical on both nodes except the HTML body:

| Field | Value |
|---|---|
| From | your sending address |
| To | `={{ $('Commit').first().json.to }}` |
| Reply To | `={{ $('Commit').first().json.replyTo }}` ← the artist, so the client's reply reaches them |
| Subject | `={{ $('Commit').first().json.subject }}` |
| Email Format | HTML |
| HTML (C9a) | contents of `templates/client-email-decline.html` |
| HTML (C9b) | contents of `templates/client-email-booking.html` |
| Options → Append n8n Attribution | **off** — see A7; these are the client-facing sends, so it matters most here |

`Commit` already computes the right subject line for each path, so both nodes
use the same expression.

Every value in these templates is addressed as `$('Commit').first().json.X`
rather than `$json`. That is deliberate — these nodes hang off `Update row`,
so `$json` there is the Google Sheets response, not the decision.

Both templates hide the artist's note when it's blank, so an unwritten note
leaves no empty bordered box behind. The decline template has no button and no
estimate: `bookingUrl` is empty on that path, and rendering a button that goes
nowhere is worse than rendering none.

⚠ **Paste each template whole, `<!doctype html>` and `<head>` included.** All
three email templates are complete documents rather than body fragments. n8n
sends the HTML field verbatim without wrapping it, so the `<head>` is the only
place the viewport meta and the media queries can live, and dropping it costs
three things at once: mobile clients fall back to desktop width and scale the
whole message down to unreadable, the tier buttons stop collapsing to one
column, and Outlook/Gmail dark mode inverts the dark surfaces to white while
leaving the light text sitting on top of them — which is what "the emails have
white backgrounds" turned out to be. Every element still carries its inline
styles as well, so a client that strips the `<style>` block degrades to the
old fixed layout rather than to nothing.

---

## Step 4 — activate and cut over to production URLs

1. **Activate** all three workflows (toggle, top right). Test URLs
   (`/webhook-test/…`) only accept one request and only while the editor is open.
2. Set the n8n env vars from 0.1 and restart the container.
3. Set the form env vars from 0.5 in Dokploy and redeploy the form app.
4. **Verify no `/webhook-test/` survives anywhere.** There were three separate
   places holding one, and each fails differently:

   | Where | Symptom if missed |
   |---|---|
   | `WM_WEBHOOK_URL` / `public/config.js` | form submits once, then silently fails for every visitor |
   | `decisionUrl()` in `nodes/intake.js` | artist email buttons 404 after the first click |
   | button `href`s in `templates/request-email.html` | same, and unsigned — now rejected outright |

   The template's buttons must be `{{ $json.links.tier1 }}` … `{{ $json.links.decline }}`.
   Hand-built URLs carry no signature and `nodes/verify-link.js` rejects them.

---

## Smoke test order

| # | Do | Expect |
|---|---|---|
| 1 | Submit the form with 2 reference images | New row, `status = NEW`, folder in Drive, artist email with 2 attachments |
| 2 | Tap a tier button in that email | Review page renders **the form**, no row change |
| 3 | Reload the review page | Still renders, still no row change |
| 4 | Edit the estimate on the page, then press the button | Client email arrives **carrying the edited estimate**, `status = LINK SENT` and `tierSent = tier3`, confirmation page |
| 4b | Press Decline on a different request | `status = DECLINED`, `tierSent` blank, no booking link in the email |
| 5 | Tap a *different* button from the original email | "Already handled" page, no second email |
| 6 | Edit `sig` in a URL by one character | 403 page |
| 7 | Delete `&sig=…` from a URL entirely | 403 page — **not** the review page |
| 8 | Visit `/laynie` on the form while she's disabled | "Not taking requests" — **not** Nic's form |
| 9 | Pick "Friend or family", name someone, submit | `heardFrom` and `referredBy` both land; artist email shows **Referred by** in gold |
| 10 | Pick "Friend or family", type a name, then switch to Instagram, submit | `heardFrom = Instagram` and `referredBy` **blank** — not the abandoned name |
| 11 | Pick "Other", describe it, then switch to "A previous client", submit | `referredBy` blank, not the "Other" sentence — it would otherwise rank in the leaderboard as a person |

Step 2 is the status gate: if it shows "already decided" instead of the form,
the review page and the sheet disagree about what undecided looks like. Step 4
is the Merge clash: a blank price in the client's email means C5 is set to
prefer input 2. Step 7 is the one that used to fail — an unsigned link was
treated as valid.

---

## Known gaps (not blockers, but true today)

- **No client confirmation email in Workflow A.** The form no longer claims one
  was sent, so this is now a missing nicety rather than a false statement.
- **`templates/request-email.html` still uses `$execution.id` and `body.*`
  field references.** The decision buttons are fixed (they use the signed
  `$json.links.*`), but the remaining edit list in `README.md` → *Changes needed*
  still applies before step 1 of the smoke test.
- **`budget` / `timing`** rows in the email template have no form field behind
  them. Delete the rows or add the inputs.
- ~~**`PASTE_BOOKING_REQUESTS_FOLDER_ID`** in the email template is still a
  literal placeholder.~~ Resolved: the button now reads
  `$('Create folder').first().json.id` and links to the per-request folder,
  falling back to the root folder when a request has no images. It still can't
  be `$json.driveFolder` — the intake node never sees the ID — so it depends on
  the A3-before-A7 connection order noted in *A — wiring*.
- **The honeypot never reaches n8n.** `public/app.js` checks `company` itself
  and fakes success, then deletes the field from the payload — so the check in
  `nodes/intake.js` sees nothing and a bot POSTing straight at the webhook is
  unfiltered. Either forward the field and let the server decide, or drop the
  dead server-side check.
