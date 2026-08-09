/* ==========================================================================
   WayMaker Ink — Build the decision review page
   Workflow B · Code node, after the row lookup, before Respond to Webhook.
   Mode: "Run Once for All Items"

   This is the screen the artist lands on after tapping a button in the
   request email. It renders and nothing else — the GET that reaches here
   must never write. That's the whole point: mail scanners and link-safety
   services prefetch URLs out of emails, so a GET that decided a request
   would fire on its own.

   Committing happens on the form POST from this page (Workflow C).

   Wire the Respond to Webhook node as:
     Respond With: Text
     Response Body: ={{ $json.html }}
     Response Headers: Content-Type = text/html; charset=utf-8
   ========================================================================== */

const BASE = 'https://n8n.fifthstonedev.com';

const TIERS = {
  tier1: { label: '1 hr',           price: 125 },
  tier2: { label: '2 hr',           price: 250 },
  tier3: { label: '3 hr',           price: 375 },
  tier4: { label: '4 hr',           price: 500 },
  tier5: { label: 'All Day · 7 hr', price: 875 }
};

/* The request text is client-submitted and lands inside this HTML. Escaping
   is not optional — an unescaped `idea` field is a script injection straight
   into the artist's browser. */
const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* Row from the lookup node. */
const row  = $json;
/* Signed values from the verify node — trust these, not the row, for action. */
const link = $('Verify link').first().json;

const isDecline = link.action === 'decline';
const tier      = TIERS[link.action] || null;

if (!isDecline && !tier) {
  throw new Error(`Unrecognised action "${link.action}".`);
}

const shell = (inner) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>WayMaker Ink — Booking Decision</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#080808; color:#f7f7f7;
         font-family:Arial,Helvetica,sans-serif; line-height:1.6; }
  .wrap { max-width:600px; margin:0 auto; padding:40px 22px 64px; }
  .kicker { font-size:11px; letter-spacing:3px; text-transform:uppercase;
            color:#f5c684; margin:0 0 10px; }
  h1 { font-family:Georgia,'Times New Roman',serif; font-weight:normal;
       font-size:27px; line-height:1.2; margin:0 0 22px; }
  .card { background:#0b0b0b; border:1px solid #444; padding:20px 22px;
          margin:0 0 20px; }
  .muted { color:#8a8a8a; font-size:13px; }
  dl { display:grid; grid-template-columns:34% 1fr; gap:0; margin:0; }
  dt, dd { padding:7px 0; border-top:1px solid #1f1f1f; margin:0; }
  dt { color:#8a8a8a; font-size:12px; }
  dd { font-size:14px; }
  label { display:block; font-size:11px; letter-spacing:2px;
          text-transform:uppercase; margin:0 0 7px; }
  input, textarea { width:100%; box-sizing:border-box; background:#080808;
                    border:1px solid #999; color:#f7f7f7; padding:13px 14px;
                    font:inherit; border-radius:0; }
  input:focus, textarea:focus { outline:none; border-color:#f5c684; }
  textarea { resize:vertical; }
  .field { margin:0 0 18px; }
  button { width:100%; padding:16px; font:inherit; font-weight:bold;
           font-size:15px; border:0; border-radius:0; cursor:pointer;
           background:#f5c684; color:#080808; }
  button.danger { background:#0b0b0b; border:1px solid #5a2b2b; color:#e6a6a6; }
</style>
</head><body><div class="wrap">${inner}</div></body></html>`;

/* Whoever got here second sees this. The row's status is the only thing
   making "the rest stop working" true — the links themselves stay valid
   until they expire.

   Undecided is NEW (what the append writes), PENDING, or an empty cell.
   Anything else — tier1…tier5, declined — means someone already answered.
   This has to normalise case and match the gate in nodes/commit.js
   exactly; when the two disagree, one of them locks out every request. */
const currentStatus = String(row.status || 'NEW').trim().toUpperCase();
const isOpen = currentStatus === 'NEW' || currentStatus === 'PENDING';

if (!isOpen) {
  return [{ json: { html: shell(`
    <p class="kicker">Already Handled</p>
    <h1>This request has been decided.</h1>
    <div class="card">
      <p style="margin:0">Recorded as <strong>${esc(row.status)}</strong>${
        row.decidedAt ? ` on ${esc(new Date(row.decidedAt).toLocaleString('en-US', {
          dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago'
        }))}` : ''
      }.</p>
      <p class="muted" style="margin:12px 0 0">
        Nothing further was sent. If this was a mistake, handle it by replying
        to ${esc(row.email)} directly.</p>
    </div>`) } }];
}

const heading = isDecline
  ? 'Decline this request?'
  : `Send ${esc(tier.label)} · $${tier.price} to ${esc(row.firstName)}?`;

const decisionFields = isDecline
  ? `<div class="field">
       <label for="note">Note to ${esc(row.firstName)} (optional)</label>
       <textarea id="note" name="note" rows="5"
         placeholder="A short reason, or leave blank for the standard wording."></textarea>
     </div>`
  : `<div class="field">
       <label for="estimate">Estimate shown to the client</label>
       <input id="estimate" name="estimate" value="${esc(tier.label)} · $${tier.price}">
     </div>
     <div class="field">
       <label for="note">Personal note (optional)</label>
       <textarea id="note" name="note" rows="5"
         placeholder="Anything you want said alongside the booking link."></textarea>
     </div>`;

const html = shell(`
  <p class="kicker">${isDecline ? 'Decline' : 'Confirm & Send'}</p>
  <h1>${heading}</h1>

  <div class="card">
    <dl>
      <dt>Client</dt><dd>${esc(row.firstName)} ${esc(row.lastName)}</dd>
      <dt>Email</dt><dd>${esc(row.email)}</dd>
      <dt>Placement</dt><dd>${esc(row.placement)}</dd>
      <dt>Size</dt><dd>${esc(row.size)}</dd>
      <dt>Style</dt><dd>${esc(row.style)}</dd>
    </dl>
    <p class="muted" style="margin:16px 0 0">${esc(row.idea)}</p>
  </div>

  <form method="POST" action="${BASE}/webhook/decide-commit">
    <input type="hidden" name="rid"    value="${esc(link.rid)}">
    <input type="hidden" name="action" value="${esc(link.action)}">
    <input type="hidden" name="exp"    value="${esc(link.exp)}">
    <input type="hidden" name="sig"    value="${esc(link.sig)}">
    ${decisionFields}
    <button type="submit" class="${isDecline ? 'danger' : ''}">
      ${isDecline ? 'Send Decline' : 'Send Booking Link'}
    </button>
    <p class="muted" style="margin:14px 0 0">
      This is the point of no return — pressing the button emails
      ${esc(row.firstName)}.</p>
  </form>`);

return [{ json: { html } }];
