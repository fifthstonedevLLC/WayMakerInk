# The two mail workflows

n8n's entire job in the Supabase build is **sending email**. It holds no data,
no pricing table, no booking links and no signing secret for anything except
proving that a call came from us.

Part of the Supabase initiative — [`../PORTAL-INITIATIVE.md`](../PORTAL-INITIATIVE.md)
has the architecture. This file is the two workflows and how they are secured.

| Path | Called by | Sends |
|---|---|---|
| `/webhook/booking-request-uat` | `intake`, after the row commits | "You have a new request" → the artist |
| `/webhook/wm-respond-uat` | `respond`, after the row is claimed | The estimate + booking link, or the decline → the client |

⚠ Both paths carry the `-uat` suffix. n8n refuses to activate two workflows on
one path, and the suffix is the only thing keeping UAT sends off production's
workflows once production moves over.

---

## The threat, stated plainly

Both URLs are public and unauthenticated by default. **Anyone who learns one
can make the shop send email from its own address, to any recipient, saying
anything** — phishing from a domain the recipient already trusts.

Nothing leaks. n8n has no database credential in this design and every value it
mails is supplied by the caller, which is a real improvement on the old build
where Workflow C read the client's row out of the sheet itself. The exposure is
outbound only.

---

## What secures them

[`verify-signature.js`](verify-signature.js), pasted into a Code node placed
**immediately after** the Webhook node in both workflows.

Every call from the Edge Functions carries three headers:

```
X-WM-Timestamp   unix seconds
X-WM-Signed      the field names the signature covers, comma separated
X-WM-Signature   v1=<hmac-sha256 hex>
```

The signature is HMAC-SHA256 with `WM_N8N_SIGNING_SECRET`, over newline-joined
lines: the literal `v1`, the timestamp, then one `name=value` line per signed
field. The verify node recomputes it and throws if it does not match.

That answers three questions a static token in a header cannot:

| | Answered by |
|---|---|
| Is the caller us? | The signature verifies against a secret only we hold |
| Was the payload altered? | The signature covers the fields that decide who is mailed and what link they get |
| Is this a replay? | The timestamp must be within 5 minutes |

It is also the house standard — `nodes/intake.js` in the booking build already
signs decision links with HMAC-SHA256, and the n8n container already runs with
`NODE_FUNCTION_ALLOW_BUILTIN=crypto` for it.

### ⚠ The HTTP status is the ONLY thing `respond` believes

`respond` claims the row, POSTs here, and decides what happened from **the
status code alone**. A 2xx means "sent" and the request becomes `LINK_SENT`;
anything else rolls the row back to `NEW` so the artist can retry.

n8n does not know that. A Webhook node set to **Respond: Immediately** ACKs with
a 200 the moment the request lands — *before* the workflow runs, and regardless
of whether it later fails. So a workflow that receives the call, throws on the
very first node and sends nothing still reports success, and the request is
marked as answered while the client's inbox stays empty. That is the worst
failure this system can produce: it is invisible from both ends.

Observed, not theoretical — the first live test against
`/webhook-test/decide-commit-uat` did exactly this. The old node rejected the
payload as `missing-signature`, no mail went anywhere, and the row still came
back `LINK_SENT`.

Two rules follow, and both are load-bearing:

1. **Set the Webhook node's Respond mode to `Using 'Respond to Webhook' Node`,**
   not Immediately — so the status code is decided after the send, not before it.
2. **Every failure path must reach a non-2xx.** The verify node throwing is
   enough on its own (an unhandled error makes n8n answer 500). Where a Send
   Email node can fail, leave its *Continue On Fail* OFF, or wire the error
   output to a `Respond to Webhook` node returning 500. A workflow that catches
   its own mail failure and answers 200 is telling `respond` the client was
   emailed.

There is no acknowledgement from the mail server that could prove delivery
anyway — a 2xx here means "n8n accepted responsibility for sending", which is
the strongest claim available. It just has to be an honest one.

### Why it throws instead of branching

An IF node has a false output. Leave it dangling and the canvas looks correct;
wire it wrong and the workflow sends anyway. A Code node that throws stops the
execution with the reason in the log and has no second path to get wrong.

### What the signature does *not* cover

Only the fields named in `X-WM-Signed`. For `wm-respond-uat` that is `rid`,
`action`, `to` and `bookingUrl` — who is mailed and what link they get. The
message body, the subject and the client's name are **not** signed.

That is a deliberate trade, not an oversight. Signing the raw request bytes
would cover everything, but n8n would need **Raw Body ON** to see those exact
bytes and the workflow would have to `JSON.parse` the body itself. Tampering
with an unsigned field also requires breaking TLS first, at which point the
worst available outcome is a misspelled greeting. Redirecting the email or
swapping the booking link is the attack, and both are covered.

⚠ `REQUIRE_SIGNED` at the top of the verify node **has to be edited per
workflow** — it is the node asserting what the signature must cover rather than
trusting the caller's own `X-WM-Signed` header. The two values are in the file.

---

## Building each workflow

**[`BUILD-RESPONSE.md`](BUILD-RESPONSE.md) is the node-by-node build sheet** —
every setting, the wiring, the payload table, the find-and-replace the client
templates need, and the eight tests that prove it. Follow it rather than
reconstructing the workflow from this file; this one is the *why*, that one is
the *what to click*.

The shape, for orientation only:

```
wm-respond-uat:         Webhook -> Verify -> If isDecline? +- true --> Email - decline
                                                           +- false -> Email - booking

booking-request-uat:    Webhook -> Verify -> Email artist
```

| Workflow | Template |
|---|---|
| `wm-respond-uat` · booking | [`templates/client-email-booking.html`](templates/client-email-booking.html) |
| `wm-respond-uat` · decline | [`templates/client-email-decline.html`](templates/client-email-decline.html) |
| `booking-request-uat` | [`templates/artist-email-request.html`](templates/artist-email-request.html) |

Three settings carry almost all the risk, and all three are covered there:

| Setting | Default | Must be |
|---|---|---|
| Webhook -> **Respond** | Immediately | **When Last Node Finishes** |
| Webhook -> Options -> **Raw Body** | Off | **Off** (leave it) |
| Send Email -> **Append n8n Attribution** | **On** | Off |

The first is the one that bites: *Immediately* ACKs 200 before the workflow
runs, so a workflow that sends nothing still reports success and the request is
marked answered with the client's inbox empty.

---

## Setting the secret

One value, both sides, generated once:

```sh
openssl rand -base64 32
```

| Where | How |
|---|---|
| Supabase | `WM_N8N_SIGNING_SECRET` in `supabase/.env`, then `npx supabase secrets set --env-file supabase/.env` |
| n8n | `WM_N8N_SIGNING_SECRET` on the n8n container, then restart it |

Both sides refuse to run on the placeholder `dev-signing-secret`. The Edge
Functions refuse to send **unsigned** if the variable is missing entirely,
rather than sending a call that an n8n whose verify node was also skipped would
happily accept — two omissions that would otherwise cancel out into a system
that looks like it works.

If n8n cannot read `$env` (`N8N_BLOCK_ENV_ACCESS_IN_NODE` is not `false`), edit
the `FALLBACK` block at the top of the verify node instead. Nothing else in the
file changes. Check which applies with, in any Code node:

```js
return [{ json: { envAvailable: typeof $env !== 'undefined', canRead: !!($env && $env.PATH) } }];
```

---

## Testing it

| # | Do | Expect |
|---|---|---|
| 1 | Respond to a request from the portal | Client email arrives; n8n execution shows `wmVerified: true` |
| 2 | `curl -X POST <webhook url> -d '{"rid":"x"}'` | Execution fails at `Verify` with *Unsigned request*; no email |
| 3 | Replay a real request from the n8n execution log, unchanged, ten minutes later | Fails with *Timestamp is …s away from now* |
| 4 | Change `WM_N8N_SIGNING_SECRET` on n8n only, restart, respond again | The portal shows *n8n rejected the signature (403) — check WM_N8N_SIGNING_SECRET matches on both sides*, and the request stays **open** rather than being marked sent |

Step 4 is the one worth actually running. It proves the rollback in `respond`
works: a failed send puts the row back to `NEW` so the artist can retry, rather
than leaving a request marked `LINK_SENT` that nobody received.

---

## Optional: a second gate in front

n8n's Webhook node has built-in **Authentication → Header Auth**, which rejects
with a 401 *before the workflow executes at all* — no execution recorded, no
Code node reached.

It is worth adding on top, not instead: it is a static string, so it does
nothing about replay or tampering, but it means a scanner hitting the URL costs
nothing rather than one execution each time. If you add it, set the header to
something other than the three `X-WM-*` names above and put its value in a
separate variable — reusing the signing secret as a plaintext header value
would put it in every proxy log between here and n8n.
