/* ==========================================================================
   WayMaker Ink — delete a request, permanently

   POST { rid } from the portal, with the artist's JWT attached.

   ⚠ THIS IS THE ONE IRREVERSIBLE OPERATION IN THE SYSTEM. It removes the
   request row, its images (via `on delete cascade`), its whole audit trail
   (same cascade), and the reference photos out of Storage. Nothing here is
   recoverable afterwards by any means the portal has — the only route back is
   a database restore, which takes the entire project back with it.

   What survives is a row in `request_tombstones`: rid, artist, service, status
   and who deleted it, with NO client data at all. Enough to answer "was there
   a request and who removed it", not enough to reconstruct a word of it. The
   deletion is real; only the fact of it is kept.

   ---------------------------------------------------- why this is a function
   The schema shipped with NO delete policy on `public.requests`, and said why:
   "a client request is a business record, and 'I meant to click the other one'
   is what the audit table is for."

   That reasoning has not stopped being true, so deleting stays deliberately
   awkward: it goes through here rather than through a policy that would make
   `.delete()` available to every query the portal can build. This is also the
   pattern the other two writes already follow — intake is a function, respond
   is a function, and for the same reason: the browser holds an anon key, so
   anything reachable with it is reachable by anyone who reads the bundle.

   ⚠ Storage is cleaned up FIRST, deliberately. `request_images` rows cascade
   away with the request, so deleting the row first would leave files in the
   bucket with nothing left pointing at them — unreachable, unlistable from the
   portal, and still counting against storage. Better to fail with the row
   still present and be able to try again.
   ========================================================================== */
import { adminClient, callerClient } from '../_shared/admin.ts';
import { BadRequest, fail, json, preflight } from '../_shared/http.ts';

const BUCKET = 'request-refs';

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  try {
    if (req.method !== 'POST') throw new BadRequest('POST only.');

    /* ------------------------------------------------------ who is asking ---
       Same gate as respond: an expired, forged, or profile-less JWT fails here
       rather than after something has already been removed. */
    const caller = callerClient(req);
    const { data: auth, error: authErr } = await caller.auth.getUser();
    if (authErr || !auth?.user) {
      return json(req, { ok: false, error: 'Not signed in.' }, 401);
    }

    const body = await req.json() as { rid?: unknown };
    const rid = String(body.rid ?? '').trim();
    if (!rid) throw new BadRequest('No request id.');

    /* The permission check, and it is the CALLER's client on purpose. RLS
       decides whether this person may see the row at all; if `can_see_artist`
       says no, this returns nothing and they are told it does not exist —
       which is the right answer to give someone asking about a request that is
       not theirs. An admin client here would happily delete either artist's
       requests on anyone's say-so. */
    const { data: request, error: readErr } = await caller
      .from('requests')
      .select('id, rid, artist_key, first_name, last_name, status')
      .eq('rid', rid)
      .maybeSingle();

    if (readErr) throw readErr;
    if (!request) throw new BadRequest('We can\'t find that request.');

    const db = adminClient();

    /* The rid as the DATABASE spells it, not as the caller typed it. They are
       equal — the row was found by matching on it — but the storage path is
       built from this, and building a path out of unvalidated request body is
       the habit worth not having. */
    const safeRid = request.rid;

    /* ---------------------------------------------------------- the photos ---
       Listed rather than assumed: intake names them `<rid>/reference-N.<ext>`
       with the extension following the upload's content type, so guessing the
       filenames would silently miss every PNG and HEIC.

       Removed BEFORE the row. request_images cascades away with the request,
       so deleting the row first would leave files in the bucket with nothing
       pointing at them — unreachable from the portal, unlistable, and still
       counting against storage. Failing with the row still present is the
       recoverable order.

       A failure here is logged and does NOT stop the delete: the request is
       what the artist asked to be rid of, and refusing over a leftover file
       would leave them looking at a request they were told was going.

       The default page size is 100 and intake caps a request at 5 images, so
       one call sees all of them. */
    const { data: files, error: listErr } = await db.storage.from(BUCKET).list(safeRid);

    if (listErr) {
      console.error(`delete ${safeRid}: could not list storage:`, listErr.message);
    } else if (files?.length) {
      const paths = files.map((f) => `${safeRid}/${f.name}`);
      const { error: rmErr } = await db.storage.from(BUCKET).remove(paths);
      if (rmErr) console.error(`delete ${safeRid}: could not remove files:`, rmErr.message);
    }

    /* ------------------------------------------------------------ the row ---
       One RPC, not a delete: it writes the tombstone and removes the request
       inside a single transaction, with the row locked `for update` in
       between. supabase-js cannot open a transaction, so doing this as two
       calls from here would have two ways to come apart — a tombstone marking
       a row that still exists, or a destroyed request with nothing recording
       it. See 20260905000100_request_tombstones.sql.

       There is no soft-delete column to set instead. The schema has none, and
       inventing one here would leave the portal showing "deleted" to an artist
       while the client's name, email and photographs were all still in the
       table. If the answer ever becomes "archive, don't destroy", that is a
       migration and a filter — not a quiet reinterpretation of this endpoint. */
    const { data: removed, error: delErr } = await db.rpc('delete_request_permanently', {
      p_rid: safeRid,
      p_actor: auth.user.id,
      p_actor_email: auth.user.email ?? ''
    });

    if (delErr) throw delErr;

    /* False means the row was gone between the read above and the lock inside
       the function — the other artist deleted it, or a second tab did. Report
       it as success: the caller wanted it gone and it is gone, and an error
       here would send them back to a row that no longer exists. */
    if (removed === false) {
      console.log(`delete ${safeRid}: already gone by the time the lock was taken`);
      return json(req, { ok: true, rid: safeRid, alreadyGone: true });
    }

    /* The tombstone carries no client data on purpose, so the name lives here
       and nowhere else. Function logs age out; that is the trade — the durable
       record is the tombstone, and this is for the week afterwards when
       somebody asks which request went. */
    console.log(
      `deleted rid=${safeRid} artist=${request.artist_key} status=${request.status} ` +
      `client="${request.first_name} ${request.last_name}" ` +
      `by=${auth.user.id} (${auth.user.email ?? 'no email'})`
    );

    return json(req, { ok: true, rid: safeRid });
  } catch (err) {
    return fail(req, err);
  }
});
