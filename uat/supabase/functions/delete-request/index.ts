/* ==========================================================================
   WayMaker Ink — delete a request, permanently

   POST { rid } from the portal, with the artist's JWT attached.

   ⚠ THIS IS THE ONE IRREVERSIBLE OPERATION IN THE SYSTEM. It removes the
   request row, its images (via `on delete cascade`), its whole audit trail
   (same cascade), and the reference photos out of Storage. Nothing here is
   recoverable afterwards by any means the portal has — the only route back is
   a database restore, which takes the entire project back with it.

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

    /* ---------------------------------------------------------- the photos ---
       Listed rather than assumed: intake names them `<rid>/reference-N.<ext>`
       and the extension follows the upload's content type, so guessing the
       filenames would silently miss every PNG and HEIC.

       A failure to remove them is logged and does NOT stop the delete. The
       request row is what the artist asked to be rid of; orphaned files are
       untidy, and refusing the whole operation over them would leave a request
       they have already been told is going. */
    const { data: files, error: listErr } = await db.storage.from(BUCKET).list(rid);

    if (listErr) {
      console.error(`delete ${rid}: could not list storage:`, listErr.message);
    } else if (files?.length) {
      const paths = files.map((f) => `${rid}/${f.name}`);
      const { error: rmErr } = await db.storage.from(BUCKET).remove(paths);
      if (rmErr) console.error(`delete ${rid}: could not remove files:`, rmErr.message);
    }

    /* ------------------------------------------------------------ the row ---
       Cascades to request_images and request_events. There is no soft-delete
       column to set instead: the schema has none, and adding one silently here
       would leave the portal showing "deleted" to an artist while the client's
       name, email and photographs were all still in the table. If the answer
       ever becomes "archive, don't destroy", that is a migration and a filter,
       not a quiet reinterpretation of this endpoint. */
    const { error: delErr } = await db.from('requests').delete().eq('id', request.id);
    if (delErr) throw delErr;

    /* Logged because nothing else records it. The audit rows went with the
       request, so this line is the only trace that it ever existed — worth
       having when someone asks where a request went. */
    console.log(
      `deleted rid=${rid} artist=${request.artist_key} status=${request.status} ` +
      `client="${request.first_name} ${request.last_name}" by=${auth.user.id} (${auth.user.email})`
    );

    return json(req, { ok: true, rid });
  } catch (err) {
    return fail(req, err);
  }
});
