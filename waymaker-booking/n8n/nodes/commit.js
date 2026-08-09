/* ==========================================================================
   WayMaker Ink — Commit a decision
   Workflow C · Code node, after the Merge on the /decide-commit POST.
   Mode: "Run Once for All Items"

   Runs once the artist has pressed the button on the review page. Decides
   what the client gets, and produces both the row update and the email body
   for the nodes downstream.

   Upstream, a Merge node (mode Combine, by Position, clash handling set to
   prefer input 1) joins the two branches this node needs:
     input 1 — 'Link is Valid?' true → the signed decision
     input 2 — 'Lookup Rid'          → the client's sheet row
   Both branches carry exactly one item, which is what makes combining by
   position safe here.

   The status re-check here is not redundant with the one on the review page.
   Between rendering that page and this POST arriving, the request may have
   been decided in another tab or on another device. This is the check that
   actually holds.
   ========================================================================== */

/* Acuity scheduling links, per artist, per tier — the payload of the whole
   system. Set WM_BOOKING_LINKS in the environment as a JSON object of the same
   shape; the block below is the fallback when $env isn't available. See the
   config comment in nodes/intake.js on $env vs $vars.

   ⚠ Both artists currently point at the SAME five appointment-type IDs. That
   is correct if Acuity routes by staff member on the booking page, and wrong
   if each artist has their own appointment types. Confirm before go-live. */
const FALLBACK_BOOKING_LINKS = {
  nic: {
    tier1: 'https://waymakerink.as.me/?appointmentType=94784680',
    tier2: 'https://waymakerink.as.me/?appointmentType=96303330',
    tier3: 'https://waymakerink.as.me/?appointmentType=96303759',
    tier4: 'https://waymakerink.as.me/?appointmentType=96303791',
    tier5: 'https://waymakerink.as.me/?appointmentType=96347556'
  },
  laynie: {
    tier1: 'https://waymakerink.as.me/?appointmentType=94784680',
    tier2: 'https://waymakerink.as.me/?appointmentType=96303330',
    tier3: 'https://waymakerink.as.me/?appointmentType=96303759',
    tier4: 'https://waymakerink.as.me/?appointmentType=96303791',
    tier5: 'https://waymakerink.as.me/?appointmentType=96347556'
  }
};

const BOOKING_LINKS = (() => {
  let raw;
  try {
    raw = typeof $env !== 'undefined' && $env ? $env.WM_BOOKING_LINKS : undefined;
  } catch (e) {
    raw = undefined;
  }
  if (!raw) return FALLBACK_BOOKING_LINKS;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch (e) {
    /* Loud, not silent: falling back here would send a client the wrong
       artist's booking link, which looks like a working system. */
    throw new Error(`WM_BOOKING_LINKS is not valid JSON (${e.message}). Fix it or unset it to use the built-in map.`);
  }
})();

/* One item off the Merge: the signed decision from 'Verify Link' (input 1)
   combined with the sheet row from 'Lookup Rid' (input 2). Nothing here
   addresses a node by name, so renaming one upstream breaks the connection
   visibly on the canvas rather than silently at runtime in here. */
const merged = $json || {};

/* Client details, artistKey, status. */
const row = merged;

/* What the artist just pressed and typed. `estimate` in particular has to
   win the merge clash — input 2 carries the sheet's estimate column, which
   is still empty at this point, and an empty one would reach the client. */
const link = {
  rid:      String(merged.rid || '').trim(),
  action:   String(merged.action || '').trim(),
  exp:      merged.exp,
  sig:      String(merged.sig || '').trim(),
  estimate: String(merged.estimate || '').trim(),
  note:     String(merged.note || '').trim()
};

if (!link.action) {
  throw new Error(
    `No action on the merged item. Either the Merge node isn't combining ` +
    `'Verify Link' into input 1, or webhook C1 still has Raw Body on and ` +
    `the form-encoded body was never parsed.`
  );
}

/* Second gate. The first was on the GET; this one covers the window between
   the page rendering and the artist pressing send. */
const currentStatus = String(row.status || 'NEW').trim().toUpperCase();
if (currentStatus !== 'NEW' && currentStatus !== 'PENDING') {
  return [{
    json: {
      alreadyDecided: true,
      sendEmail: false,
      html: `<!doctype html><meta charset="utf-8">
             <body style="background:#080808;color:#f7f7f7;
                          font-family:Arial,Helvetica,sans-serif;
                          padding:44px 22px;text-align:center">
             <p style="font-size:11px;letter-spacing:3px;text-transform:uppercase;
                       color:#f5c684">Already Handled</p>
             <p>This request was decided elsewhere. Nothing was sent.</p></body>`
    }
  }];
}

const rawAction = link.action.toLowerCase();

const normalizedAction = rawAction === 'decline'
  ? 'decline'
  : rawAction.replace(/\s+/g, '');

const artist = String(row.artistKey || '')
  .trim()
  .toLowerCase();

const isDecline = normalizedAction === 'decline';

let bookingUrl = '';

if (!isDecline) {
  bookingUrl = BOOKING_LINKS[artist]?.[normalizedAction] || '';

  if (!bookingUrl) {
    throw new Error(
      `No booking link configured. ` +
      `artist="${artist}", ` +
      `action="${rawAction}", ` +
      `normalizedAction="${normalizedAction}"`
    );
  }
}

const decidedAt = new Date().toISOString();

return [{
  json: {
    alreadyDecided: false,
    sendEmail: true,

    /* Straight into the Sheets/Data Table update node. Match on rid. */
    rid:       link.rid,
    status:    isDecline ? 'declined' : link.action,
    decidedAt,
    estimate:  link.estimate,
    artistNote: link.note,

    /* For the client-facing email node. */
    to:          row.email,
    replyTo:     row.artistEmail,
    subject:     isDecline
      ? `About your tattoo request — ${row.artistName}`
      : `Your estimate from ${row.artistName} — ready to book`,
    firstName:   row.firstName,
    artistName:  row.artistName,
    artistEmail: row.artistEmail,
    bookingUrl,
    isDecline,

    /* Confirmation shown back to the artist in the browser. */
    html: `<!doctype html><meta charset="utf-8">
           <meta name="viewport" content="width=device-width,initial-scale=1">
           <body style="background:#080808;color:#f7f7f7;
                        font-family:Arial,Helvetica,sans-serif;
                        padding:44px 22px;text-align:center;line-height:1.6">
           <p style="font-size:11px;letter-spacing:3px;text-transform:uppercase;
                     color:#f5c684;margin:0 0 12px">
             ${isDecline ? 'Declined' : 'Sent'}</p>
           <p style="font-family:Georgia,serif;font-size:24px;margin:0 0 10px">
             ${isDecline
               ? `${row.firstName} has been let down gently.`
               : `${row.firstName} has the booking link.`}</p>
           <p style="color:#8a8a8a;font-size:13px;margin:0">
             ${isDecline ? '' : link.estimate + ' · '}Sent to ${row.email}.
             The other buttons in the request email are now inert.</p>
           </body>`
  }
}];
