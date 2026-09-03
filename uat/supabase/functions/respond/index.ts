/* ==========================================================================
   WayMaker Ink — respond
   POST application/json from the admin portal. Requires the artist's JWT.

   Replaces Workflows B and C: the signed decision link, the review page, the
   verify/merge/commit chain and the two client emails. The portal is the
   review page now, so there is nothing to sign — the artist is logged in.

   ⚠ Why the portal does not call the n8n webhook directly. The portal is a
   browser app; any secret it holds is public, so an n8n webhook it could
   authenticate to is one anyone can authenticate to — and that webhook sends
   mail from the shop's address to an arbitrary recipient. This function holds
   the token instead, and the browser's own credential (a Supabase JWT, short
   lived and revocable) is what it checks first.

   Ordering matters and is deliberate:

     1. Claim the row with a conditional UPDATE on status = 'NEW'.
        Two tabs, two devices, or a double-click all resolve here: exactly one
        of them gets a row back. This is commit.js's "second gate", except it
        is a database predicate rather than a read followed by a write.
     2. Ask n8n to send.
     3. On failure, put the row back.

   Sending first would mail the client from a request that then failed to
   record, and the artist would send again. Claiming first and rolling back
   costs, at worst, a request that looks undecided when the email did go —
   which the audit trail shows and a duplicate email does not.
   ========================================================================== */
import { adminClient, callerClient } from '../_shared/admin.ts';
import { BadRequest, fail, json, preflight } from '../_shared/http.ts';
import { postToN8n } from '../_shared/n8n.ts';

type Body = {
  rid?: string;
  /* 'resend' mails the SAME booking link again to a request that already had
     one — the client lost the email, or it went to spam. It changes nothing
     about the request; see the resend block below. */
  action?: 'send' | 'decline' | 'resend';
  tierKey?: string;
  /* What the artist actually approved or edited, e.g. "3 hr · $375". Free text
     on purpose — it is what the client reads, and a piercing quote, a tattoo
     session and a hand-negotiated number do not share a format. */
  estimate?: string;
  message?: string;
};

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  try {
    if (req.method !== 'POST') throw new BadRequest('POST only.');

    /* ------------------------------------------------------ who is asking ---
       The caller's own client, so this runs under their RLS. A JWT that is
       expired, forged or belongs to somebody with no profile row fails here
       rather than three statements later. */
    const caller = callerClient(req);
    const { data: auth, error: authErr } = await caller.auth.getUser();
    if (authErr || !auth?.user) {
      return json(req, { ok: false, error: 'Not signed in.' }, 401);
    }
    const userId = auth.user.id;

    const body = (await req.json()) as Body;
    const rid = String(body.rid ?? '').trim();
    const action =
      body.action === 'decline' ? 'decline' :
      body.action === 'resend'  ? 'resend'  : 'send';
    const message = String(body.message ?? '').trim();

    if (!rid) throw new BadRequest('No request id.');

    /* Read through the CALLER's client, not the admin one. If `can_see_artist`
       says no, this returns nothing and the artist is told the request does
       not exist — which is the correct answer to give someone asking about a
       row that is not theirs. */
    const { data: request, error: readErr } = await caller
      .from('requests')
      .select('id, rid, status, service, artist_key, first_name, last_name, email, quoted_price, quote_label, tier_sent, estimate, artist_note, booking_url')
      .eq('rid', rid)
      .maybeSingle();

    if (readErr) throw readErr;
    if (!request) throw new BadRequest('We can\'t find that request.');

    const db = adminClient();

    /* ------------------------------------------------------------- resend ---
       A client cannot find the email. Send the same one again.

       ⚠ This deliberately re-sends the STORED `booking_url` and `estimate`
       rather than re-deriving them from `service_tiers`. The row is the record
       of what the client was promised; if the Acuity URL has been edited since,
       quietly sending a different one would make the record a lie and could
       book them onto a different appointment type than the one they were
       quoted. A genuinely dead link is a re-decision, not a resend.

       Nothing about the request changes — no status write, no new decided_at,
       no re-claim. It is already LINK_SENT and stays that way, so there is
       nothing to roll back if the mail fails. */
    if (action === 'resend') {
      if (request.status !== 'LINK_SENT') {
        return json(req, {
          ok: false,
          error: request.status === 'NEW'
            ? 'Nothing has been sent for this request yet, so there is no link to resend.'
            : `This request was ${request.status === 'DECLINED' ? 'declined' : 'closed'}, so there is no booking link to resend.`
        }, 409);
      }
      if (!request.booking_url) {
        return json(req, {
          ok: false,
          error: 'This request has no stored booking link, so there is nothing to resend.'
        }, 409);
      }

      const { data: a } = await db
        .from('artists').select('name, email').eq('key', request.artist_key).single();

      const resent = await postToN8n({
        urlVar: 'WM_N8N_RESPOND_URL',
        canon: ['rid', 'action', 'to', 'bookingUrl'],
        body: {
          rid: request.rid,
          action,
          service: request.service,
          to: request.email,
          firstName: request.first_name,
          lastName: request.last_name,
          artistKey: request.artist_key,
          artistName: a?.name ?? '',
          replyTo: a?.email ?? '',
          /* Named as a resend so it does not read as a second, different quote
             landing in the client's inbox. */
          subject: `Your booking link from ${a?.name ?? 'WayMaker Ink'}`,
          estimate: request.estimate,
          /* The artist may add a line ("sorry, resending — check spam"), but
             the original note is the default so the email reads the same as
             the one it is replacing. */
          message: message || request.artist_note,
          artistNote: message || request.artist_note,
          bookingUrl: request.booking_url,
          tierKey: request.tier_sent,
          isDecline: false
        }
      });

      await db.from('request_events').insert({
        request_id: request.id,
        event: resent.ok ? 'resent' : 'resend_failed',
        actor: userId,
        detail: resent.ok
          ? { to: request.email, booking_url: request.booking_url }
          : { reason: (resent as { error: string }).error }
      });

      if (!resent.ok) {
        return json(req, {
          ok: false,
          error: `The email didn't go out (${(resent as { error: string }).error}). The request is unchanged.`
        }, 502);
      }

      return json(req, { ok: true, rid: request.rid, status: request.status, resent: true });
    }

    if (request.status !== 'NEW') {
      return json(req, {
        ok: false,
        alreadyDecided: true,
        status: request.status,
        error: 'This request was already decided. Nothing was sent.'
      }, 409);
    }

    /* ------------------------------------------------------------- tiers ---
       Resolved from the database rather than from anything the portal sent.
       The portal renders the picker from the same view, but the URL a client
       is mailed must come from the server — a tampered tierKey would otherwise
       book them onto whatever appointment type the browser named. */
    let tierKey = '';
    let bookingUrl = '';
    let estimate = String(body.estimate ?? '').trim();

    if (action === 'send') {
      tierKey = String(body.tierKey ?? '').trim();
      if (!tierKey) throw new BadRequest('Choose which appointment type to send.');

      const { data: tier, error: tierErr } = await db
        .from('tier_options')
        .select('tier_key, label, price, acuity_url, bookable')
        .eq('artist_key', request.artist_key)
        .eq('service', request.service)
        .eq('tier_key', tierKey)
        .maybeSingle();

      if (tierErr) throw tierErr;
      if (!tier) {
        throw new BadRequest(`"${tierKey}" is not an appointment type ${request.artist_key} offers for a ${request.service}.`);
      }
      if (!tier.bookable) {
        /* A tier with no Acuity URL. Named, not generic — "the touch-up types
           need creating in Acuity" is actionable; "could not send" is not. */
        throw new BadRequest(
          `"${tier.label}" has no Acuity booking link yet. Create the appointment ` +
          `type in Acuity, then set acuity_url on that row.`
        );
      }

      bookingUrl = tier.acuity_url as string;

      /* Falls back to what the client's own answers already priced (a piercing)
         or to the tier's own price (a tattoo session), so an artist who accepts
         the number as-is does not have to retype it. */
      if (!estimate) {
        estimate = request.quote_label ||
          (tier.price !== null ? `${tier.label} · $${Number(tier.price).toLocaleString('en-US')}` : tier.label);
      }
    }

    const decidedAt = new Date().toISOString();

    /* ------------------------------------------------------- claim the row ---
       `.eq('status', 'NEW')` is the whole concurrency story. A second caller
       matches zero rows and is told the request was already decided, without a
       read-then-write window for it to slip through. */
    const { data: claimed, error: claimErr } = await db
      .from('requests')
      .update({
        status: action === 'decline' ? 'DECLINED' : 'LINK_SENT',
        tier_sent: action === 'decline' ? null : tierKey,
        estimate: action === 'decline' ? '' : estimate,
        artist_note: message,
        booking_url: action === 'decline' ? '' : bookingUrl,
        decided_at: decidedAt,
        decided_by: userId
      })
      .eq('id', request.id)
      .eq('status', 'NEW')
      .select('id')
      .maybeSingle();

    if (claimErr) throw claimErr;
    if (!claimed) {
      return json(req, {
        ok: false,
        alreadyDecided: true,
        error: 'Someone decided this request a moment ago. Nothing was sent.'
      }, 409);
    }

    /* ------------------------------------------------------------- send it ---
       Everything the email needs, so the n8n workflow stays a mail merge and
       does not have to hold a database credential of its own. */
    const { data: artist } = await db
      .from('artists')
      .select('name, email')
      .eq('key', request.artist_key)
      .single();

    const sent = await postToN8n({
      urlVar: 'WM_N8N_RESPOND_URL',
      /* The four fields an attacker would want to change: which request this
         claims to be, whether it declines or sends, who receives it, and what
         link they get. Everything else in the body is cosmetic by comparison —
         a tampered `firstName` misspells a greeting. */
      canon: ['rid', 'action', 'to', 'bookingUrl'],
      body: {
        rid: request.rid,
        action,
        service: request.service,
        to: request.email,
        firstName: request.first_name,
        lastName: request.last_name,
        artistKey: request.artist_key,
        artistName: artist?.name ?? '',
        replyTo: artist?.email ?? '',
        subject: action === 'decline'
          ? `About your request — ${artist?.name ?? 'WayMaker Ink'}`
          : `Your estimate from ${artist?.name ?? 'WayMaker Ink'} — ready to book`,
        estimate,
        message,
        bookingUrl,
        tierKey,

        /* Aliases, and deliberately redundant with `message` and `action`
           above. templates/client-email-booking.html and -decline.html address
           exactly these two names, and those templates are the artefact that is
           hardest to keep in step — they live as pasted text inside an n8n
           node, where nothing type-checks them and a renamed field shows up as
           a silently blank paragraph in a client's email rather than an error.
           Cheaper to send both names than to edit two HTML files and hope the
           next person pastes the edited copy.

           This is what produced `note: ""` on the first live test: the old
           Workflow C node read $json.note, and nothing by that name was sent. */
        artistNote: message,
        isDecline: action === 'decline'
      }
    });

    if (!sent.ok) {
      /* Put it back. The artist sees a failure and can press send again,
         which is the only outcome here that does not either lose the request
         or mail the client twice. */
      await db.from('requests')
        .update({
          status: 'NEW',
          tier_sent: null,
          estimate: '',
          booking_url: '',
          decided_at: null,
          decided_by: null
        })
        .eq('id', request.id);

      await db.from('request_events').insert({
        request_id: request.id,
        event: 'send_failed',
        actor: userId,
        detail: { action, tier_key: tierKey, reason: sent.error }
      });

      return json(req, {
        ok: false,
        error: `The email didn't go out (${sent.error}). Nothing was sent and the request is still open.`
      }, 502);
    }

    await db.from('request_events').insert({
      request_id: request.id,
      event: action === 'decline' ? 'declined' : 'responded',
      actor: userId,
      detail: { tier_key: tierKey || null, estimate, booking_url: bookingUrl || null }
    });

    return json(req, {
      ok: true,
      rid: request.rid,
      status: action === 'decline' ? 'DECLINED' : 'LINK_SENT',
      estimate,
      bookingUrl
    });
  } catch (err) {
    return fail(req, err);
  }
});

