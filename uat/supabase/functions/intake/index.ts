/* ==========================================================================
   WayMaker Ink — intake
   POST multipart/form-data from public/index.html.

   Replaces Workflow A: the webhook, the Intake code node, Split refs, Create
   folder, Upload refs and Append row. What it does NOT replace is the artist
   notification email — that still belongs to n8n, and this function fires it
   as a fire-and-forget POST at the end. A mail outage must not cost us the
   request; the row is already committed by then.

   ⚠ Deployed with verify_jwt = false (see ../config.toml). It is a public
   endpoint by necessity — the form has no user to authenticate. Its defences
   are the honeypot, the artist/service check, and the fact that it can only
   ever insert a `requests` row with `status = 'NEW'`.
   ========================================================================== */
import { adminClient } from '../_shared/admin.ts';
import { BadRequest, fail, json, preflight } from '../_shared/http.ts';
import { postToN8n } from '../_shared/n8n.ts';
import {
  type Artist,
  type PiercingPrice,
  buildRow,
  resolveRid,
  resolveService
} from '../_shared/request-fields.ts';

const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  try {
    if (req.method !== 'POST') throw new BadRequest('POST only.');

    const form = await req.formData();

    /* Honeypot. Bots fill hidden inputs, so a `company` with anything in it is
       not a person. Fake success and write nothing — an error would tell the
       script it had been spotted, and a retry loop is worse than a silent
       drop.

       ⚠ public/app.js ALSO checks this and deletes the field before sending,
       which meant the server-side check was dead code in the n8n build. The
       form now forwards it (see app.js onSubmit) so this is the check that
       actually runs, and a bot POSTing straight at this URL is filtered too. */
    if (String(form.get('company') ?? '').trim()) {
      return json(req, { ok: true, rid: null });
    }

    const db = adminClient();

    /* Artist first: it decides which services are even legal, and there is no
       point normalising a payload filed against nobody. */
    const artistKey = String(form.get('artist') ?? '').trim().toLowerCase();
    const { data: artist, error: artistErr } = await db
      .from('artists')
      .select('key, name, email, hourly_rate, services, enabled')
      .eq('key', artistKey)
      .maybeSingle<Artist>();

    if (artistErr) throw artistErr;
    if (!artist || !artist.enabled) {
      throw new BadRequest('That artist isn\'t taking requests right now.');
    }

    const service = resolveService(form, artist);
    const rid = resolveRid(form);

    /* Only fetched when a piercing is actually being priced. */
    let prices: PiercingPrice[] = [];
    if (service === 'piercing') {
      const { data, error } = await db
        .from('piercing_prices')
        .select('piercing_type, single_price, pair_price')
        .eq('active', true);
      if (error) throw error;
      prices = (data ?? []) as PiercingPrice[];
    }

    const { row } = buildRow(form, artist, service, rid, prices);

    const { data: inserted, error: insertErr } = await db
      .from('requests')
      .insert(row)
      .select('id, rid')
      .single();

    /* 23505 = unique_violation on `rid`. That is the retry path doing exactly
       what it was designed to do: app.js holds one rid across all three
       attempts, so a submission whose response was lost lands here a second
       time with the same id. Report success — the request IS in — rather than
       an error that would make the client try again. This is the duplicate-row
       problem the sheet had no way to solve. */
    if (insertErr && (insertErr as { code?: string }).code === '23505') {
      return json(req, { ok: true, rid, duplicate: true });
    }
    if (insertErr) throw insertErr;

    const requestId = inserted!.id as string;

    /* ------------------------------------------------------------ images ---
       Uploaded after the row is committed, deliberately. An image that fails
       to upload costs one photo; a row that fails to insert costs the whole
       request, and the client has already been shown a success screen by then.
       A missing image is visible in the portal as a count that does not match;
       a missing row is invisible to everyone. */
    const files = [...form.entries()]
      .filter(([key, value]) => /^reference\d+$/.test(key) && value instanceof File)
      .map(([, value]) => value as File)
      .filter((f) => f.size > 0)
      .slice(0, MAX_FILES);

    const images: Array<Record<string, unknown>> = [];

    for (const [index, file] of files.entries()) {
      if (file.size > MAX_BYTES) continue;
      if (!IMAGE_TYPES.includes(file.type)) continue;

      const ext = file.type === 'image/png' ? 'png'
        : file.type === 'image/webp' ? 'webp'
        : file.type === 'image/heic' ? 'heic'
        : 'jpg';

      /* `<rid>/reference-N.ext`. The rid is the first path segment because the
         storage read policy resolves it back to a request row — see
         "staff read request refs" in the RLS migration. resolveRid() is what
         guarantees it cannot contain a slash or a `..`. */
      const path = `${rid}/reference-${index + 1}.${ext}`;

      const { error: uploadErr } = await db.storage
        .from('request-refs')
        .upload(path, file, { contentType: file.type, upsert: true });

      if (uploadErr) {
        console.error(`upload failed rid=${rid} path=${path}:`, uploadErr.message);
        continue;
      }

      images.push({
        request_id: requestId,
        storage_path: path,
        ordinal: index + 1,
        byte_size: file.size,
        content_type: file.type
      });
    }

    if (images.length) {
      const { error } = await db.from('request_images').upsert(images, {
        onConflict: 'storage_path'
      });
      if (error) console.error(`image rows failed rid=${rid}:`, error.message);

      await db.from('requests')
        .update({ reference_count: images.length })
        .eq('id', requestId);
    }

    await db.from('request_events').insert({
      request_id: requestId,
      event: 'created',
      detail: { service, artist_key: artist.key, images: images.length }
    });

    /* --------------------------------------------------- notify the artist ---
       n8n keeps the mail. Awaited so a failure reaches the log with the rid
       attached, but never rethrown: the request is committed and visible in
       the portal whether or not the email lands. */
    await notifyArtist({ rid, artist, service, row });

    return json(req, { ok: true, rid });
  } catch (err) {
    return fail(req, err);
  }
});

async function notifyArtist(payload: {
  rid: string;
  artist: Artist;
  service: string;
  row: Record<string, unknown>;
}) {
  /* Absent means "not wired up yet", which is a legitimate state: the database
     half of this system can be tested end to end before any n8n workflow
     exists. postToN8n reports it, and the caller only logs. */
  if (!Deno.env.get('WM_N8N_NOTIFY_URL')) return;

  const sent = await postToN8n({
    urlVar: 'WM_N8N_NOTIFY_URL',
    /* This mail goes to the artist, not the client, and carries no booking
       link — so the fields worth protecting are which request it names and
       which mailbox it lands in. */
    canon: ['rid', 'artistEmail'],
    body: {
      rid: payload.rid,
      service: payload.service,
      artistKey: payload.artist.key,
      artistName: payload.artist.name,
      artistEmail: payload.artist.email,
      firstName: payload.row.first_name,
      lastName: payload.row.last_name,
      clientEmail: payload.row.email,
      portalUrl: `${Deno.env.get('WM_PORTAL_URL') ?? ''}/r/${payload.rid}`
    },
    /* Shorter than respond's 20s. Nobody is watching this one — the client has
       already been shown their confirmation — and the request is committed
       whether or not the mail lands. */
    timeoutMs: 10_000
  });

  /* Logged, never thrown. The row is in and visible in the portal; a mail
     outage must not cost us the request. */
  if (!sent.ok) console.error(`notify failed rid=${payload.rid}: ${sent.error}`);
}
