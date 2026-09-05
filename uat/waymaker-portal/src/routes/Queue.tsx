import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { deleteRequest, supabase } from '../lib/supabase';
import { priceLabel, waitingFor } from '../lib/format';
import {
  SERVICE_LABEL,
  STATUS_LABEL,
  type Profile,
  type QueueRow,
  type Service,
  type Status
} from '../lib/types';

/* 'NEW' first and selected by default: the queue's job is "what is waiting on
   me", and everything else is a lookup.

   ⚠ No 'Booked' tab, deliberately. Nothing in this system learns that a client
   actually booked — Acuity is where that happens and nothing watches it, so a
   Booked filter could only ever return an empty list and would read as "nobody
   is booking" rather than "we cannot see it".

   `BOOKED` is still a legal status: the CHECK constraint accepts it, the label
   map renders it, and `respond` already treats it as decided. So a row that
   gets there some other way — a manual update, or an Acuity watcher added
   later — displays correctly and shows up under All. Restoring the tab is one
   line here once something can actually write it. */
const STATUS_TABS: Array<{ key: Status | 'ALL'; label: string }> = [
  { key: 'NEW', label: 'Needs a response' },
  { key: 'LINK_SENT', label: 'Link sent' },
  { key: 'DECLINED', label: 'Declined' },
  { key: 'ALL', label: 'All' }
];

const SERVICES: Service[] = ['tattoo', 'piercing', 'touchup'];

type ArtistOption = { key: string; name: string };

export default function Queue({ profile }: { profile: Profile }) {
  /* Filters live in the URL rather than in component state. That is what makes
     the tiles real links: middle-clickable, bookmarkable, reachable with the
     back button, and "Laynie's new piercings" becomes a URL one artist can send
     the other.

     Search is deliberately NOT in the URL — a history entry per keystroke makes
     the back button useless. */
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as Status | 'ALL') || 'NEW';
  const service = (params.get('service') as Service | null) || 'all';

  /* Signing in lands you on YOUR queue, not on everyone's. Laynie opens the
     portal to her own piercings; Nic opens it to his own tattoos. Seeing the
     other artist's requests is a deliberate click, not the default view.

     ?? not ||, so an explicit `artist=all` in the URL survives — with || the
     empty-ish 'all' would be overwritten by the profile default and the Both
     button could never win.

     `artist_key` is null for an admin who is not themselves an artist; they
     get Both, which is the right default for a person with no queue.

     ⚠ Honoured for an ADMIN only. RLS already stops a scoped artist reading
     anyone else's requests, so `?artist=nic` on Laynie's session was never a
     leak — it was worse in a quieter way. The param survives a re-login in the
     same tab, href() copies every existing param into every filter link, and
     the artist picker that would clear it renders for admins only. So one
     account signing out and another signing in on the same machine strands the
     second on a permanently empty queue, with every filter they touch carrying
     the stale param forward and no control anywhere on the page that changes
     it. Read as "the migration lost my requests"; actually a query string.

     Clamped rather than trusted: a non-admin's queue is their own, whatever the
     URL says. */
  const artistParam = profile.role === 'admin' ? params.get('artist') : null;
  const artist = artistParam ?? profile.artist_key ?? 'all';

  /* And drop it from the URL, so href() stops propagating a filter this account
     cannot act on and the address bar stops describing a view they are not
     looking at. `replace` because it is a correction, not a navigation — Back
     should leave the queue, not step through params being cleaned up. */
  useEffect(() => {
    if (profile.role === 'admin' || !params.has('artist')) return;
    const cleaned = new URLSearchParams(params);
    cleaned.delete('artist');
    setParams(cleaned, { replace: true });
  }, [profile.role, params, setParams]);

  const [rows, setRows] = useState<QueueRow[] | null>(null);
  /* Every request's status and service for the chosen artist — two short
     columns, read once and tallied twice: the tiles want NEW grouped by
     service, the tabs want everything grouped by status. Two reads would be two
     snapshots, and the tiles and tabs would sometimes disagree by one. */
  const [tally, setTally] = useState<Array<{ status: Status; service: Service }> | null>(null);
  const [artists, setArtists] = useState<ArtistOption[]>([]);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  /* Which row is asking to be confirmed, which is mid-flight, and what went
     wrong. One at a time on purpose: `confirmId` holding a single id means
     opening a second confirmation closes the first, so there is never more than
     one armed delete on screen. */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');

  /* Focus lands on Keep it when a confirmation opens. Two reasons, and the
     second is the one that matters: `role="alertdialog"` promises a screen
     reader that focus is inside the dialog, and leaving it on the Delete
     button behind would make that a lie. It also puts the SAFE choice under
     the return key of anyone driving this from the keyboard. */
  const keepItRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirmId) keepItRef.current?.focus();
  }, [confirmId]);

  /* Escape closes it, as any dialog should — and never while the delete is
     in flight, where dismissing the only progress indicator would leave
     somebody unsure whether it happened. */
  useEffect(() => {
    if (!confirmId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) setConfirmId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmId, deleting]);

  /* Bumped to re-read the queue without changing a filter. Both the tiles and
     the list depend on it, so they refresh together and cannot disagree about
     how many NEW requests there are.

     Nothing pushed a new request into an open tab before this: both reads were
     keyed on the filters alone, so a request that arrived after the page loaded
     stayed invisible until a manual reload. The artist gets the notification
     email, switches to the tab that is already open, and sees the count from
     whenever they last loaded it.

     Refetch on returning to the tab, plus a slow timer for a tab left open on a
     second monitor. Focus is what actually makes it feel immediate — the email
     lands, they click over, it is already right.

     ⚠ Realtime would be the direct answer and is deliberately not used. The
     `requests` table is in no publication and `config.toml` enables nothing, so
     it would need a migration plus a subscription that silently returns nothing
     if the publication is missing. For a two-person shop reading a queue in
     minutes, a poll that cannot fail quietly is the better trade. */
  const [refresh, setRefresh] = useState(0);

  /* Which filters the currently-rendered list belongs to, so a refresh tick can
     be told apart from a filter change. A ref rather than state: it is read and
     written inside the fetch effect and must not itself cause a render. */
  const filterKey = useRef(`${status}|${service}|${artist}`);

  useEffect(() => {
    /* Guarded on visibility so a background tab is not polling all day, and so
       returning to it reads once rather than firing focus and visibilitychange
       as two separate rounds. */
    const bump = () => {
      if (document.visibilityState === 'visible') setRefresh((n) => n + 1);
    };
    const timer = window.setInterval(bump, 60_000);
    document.addEventListener('visibilitychange', bump);
    window.addEventListener('focus', bump);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', bump);
      window.removeEventListener('focus', bump);
    };
  }, []);

  async function onDelete(r: QueueRow) {
    setDeleting(r.id);
    setDeleteError('');

    const res = await deleteRequest(r.rid);

    setDeleting(null);
    if (!res.ok) {
      /* Keep the confirmation open. Closing it on failure would look like the
         delete worked until the row reappeared on the next refresh. */
      setDeleteError(res.error ?? 'Could not delete that request.');
      return;
    }

    setConfirmId(null);
    /* Refetch rather than splice the row out locally: the tiles and the tab
       counts are derived from a separate read, and dropping the row without
       re-reading them would leave the numbers one too high. */
    setRefresh((n) => n + 1);
  }

  /* Change some filters, keep the rest. */
  function href(next: Record<string, string | null>): string {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    const q = p.toString();
    return q ? `/?${q}` : '/';
  }

  /* Only somebody who can see more than one artist gets the picker. An
     artist-scoped account sees exactly their own queue, and offering them a
     button for the other artist would be a lie about their access — it would
     return nothing, because RLS decides this, not the filter. */
  useEffect(() => {
    if (profile.role !== 'admin') return;
    supabase
      .from('artists')
      .select('key, name')
      .eq('enabled', true)
      .order('sort')
      .returns<ArtistOption[]>()
      .then(({ data }) => setArtists(data ?? []));
  }, [profile.role]);

  /* The tile counts. Always NEW, and always the whole set for the chosen
     artist — they must not move when a tile is selected, or the number you are
     reaching for changes as you click it.

     Counted from a one-column read rather than three HEAD requests or a
     database view: the NEW set is small and capped, and one read keeps the
     tiles and the list on the same snapshot. */
  useEffect(() => {
    let live = true;
    /* No status filter: the tabs need the counts for statuses you are not
       currently looking at, which is the whole point of putting numbers on
       them. Scoped by artist only — the service filter is applied below in JS,
       so switching service re-labels the tabs without another round trip. */
    let q = supabase.from('request_queue').select('status, service');
    if (artist !== 'all') q = q.eq('artist_key', artist);

    q.returns<Array<{ status: Status; service: Service }>>().then(({ data }) => {
      if (!live) return;
      setTally(data ?? []);
    });

    return () => {
      live = false;
    };
  }, [artist, refresh]);

  /* Waiting-on-us, by service. NEW only and never narrowed by the status tab —
     they must not move when a tile is selected, or the number you are reaching
     for changes as you click it. */
  const counts = useMemo(() => {
    if (!tally) return null;
    const t: Record<Service, number> = { tattoo: 0, piercing: 0, touchup: 0 };
    for (const r of tally) if (r.status === 'NEW') t[r.service] += 1;
    return t;
  }, [tally]);

  /* Per status, and DOES follow the service filter — the tabs sit below the
     tiles and read as narrowing what the tiles selected, so a Piercing tile
     with "Link sent" beside it should mean piercings that were answered, not
     every answered request in the shop. */
  const statusCounts = useMemo(() => {
    if (!tally) return null;
    const scoped = service === 'all' ? tally : tally.filter((r) => r.service === service);
    const t: Record<string, number> = { ALL: scoped.length };
    for (const r of scoped) t[r.status] = (t[r.status] ?? 0) + 1;
    return t;
  }, [tally, service]);

  useEffect(() => {
    let live = true;
    setError('');

    /* Blank the list only when the FILTERS changed, never on a background
       refresh. `setRows(null)` is what renders the loading state, so doing it
       on every tick would flash the queue empty once a minute and throw away
       the scroll position under someone reading it. */
    if (filterKey.current !== `${status}|${service}|${artist}`) {
      filterKey.current = `${status}|${service}|${artist}`;
      setRows(null);
    }

    /* RLS already scopes this to what the signed-in person may see. The artist
       filter narrows that further; it cannot widen it. */
    let q = supabase
      .from('request_queue')
      .select('*')
      .order('submitted_at', { ascending: false })
      .limit(300);

    if (status !== 'ALL') q = q.eq('status', status);
    if (service !== 'all') q = q.eq('service', service);
    if (artist !== 'all') q = q.eq('artist_key', artist);

    q.returns<QueueRow[]>().then(({ data, error: err }) => {
      if (!live) return;
      if (err) setError(err.message);
      setRows(data ?? []);
    });

    return () => {
      live = false;
    };
  }, [status, service, artist, refresh]);

  const visible = useMemo(() => {
    if (!rows) return null;
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
      [r.rid, r.first_name, r.last_name, r.email, r.phone, r.summary ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [rows, search]);

  const showArtistPicker = profile.role === 'admin' && artists.length > 1;
  const artistFirstName = artists.find((a) => a.key === artist)?.name.split(' ')[0];

  return (
    <>
      <div className="wm-queue-head">
        <h1>Requests</h1>
        <input
          className="wm-search"
          type="search"
          placeholder="Name, email, phone, or request id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search requests"
        />
      </div>

      {showArtistPicker && (
        <nav className="wm-artists" aria-label="Artist">
          <Link
            to={href({ artist: 'all' })}
            className={artist === 'all' ? 'is-on' : ''}
            aria-current={artist === 'all' ? 'page' : undefined}
          >
            Both
          </Link>
          {artists.map((a) => (
            <Link
              key={a.key}
              to={href({ artist: a.key })}
              className={artist === a.key ? 'is-on' : ''}
              aria-current={artist === a.key ? 'page' : undefined}
            >
              {a.name.split(' ')[0]}
            </Link>
          ))}
        </nav>
      )}

      {/* Waiting-on-us counts, one tile per service. Each is a link to its own
          filtered view, so it can be bookmarked or sent to the other artist.
          Clicking the tile you are already on clears back to all services.

          The service name is written on every tile, so identity never rests on
          the accent colour alone. */}
      <div className="wm-tiles">
        {SERVICES.map((s) => {
          const on = service === s && status === 'NEW';
          const n = counts?.[s];
          return (
            <Link
              key={s}
              to={href(on ? { status: 'NEW', service: null } : { status: 'NEW', service: s })}
              className={`wm-tile wm-tile-${s}${on ? ' is-on' : ''}${n === 0 ? ' is-empty' : ''}`}
              aria-current={on ? 'page' : undefined}
            >
              <span className="wm-tile-n">{n === undefined ? '—' : n}</span>
              <span className="wm-tile-label">
                New {SERVICE_LABEL[s].toLowerCase()} {n === 1 ? 'request' : 'requests'}
                {artistFirstName ? ` · ${artistFirstName}` : ''}
              </span>
              <span className="wm-tile-go">{on ? 'Showing — clear' : 'Review'}</span>
            </Link>
          );
        })}
      </div>

      {/* The counts follow the service filter above, so these read as "of the
          piercings, 3 are waiting". A tab at zero is dimmed rather than hidden:
          removing it would make the row of tabs move under the pointer, and
          "Declined: 0" is a useful answer to "did I decline that one". */}
      <nav className="wm-tabs" aria-label="Status">
        {STATUS_TABS.map((tab) => {
          const n = statusCounts?.[tab.key];
          return (
            <Link
              key={tab.key}
              to={href({ status: tab.key })}
              className={`${status === tab.key ? 'is-on' : ''}${n === 0 ? ' is-empty' : ''}`}
              aria-current={status === tab.key ? 'page' : undefined}
            >
              {tab.label}
              {/* aria-hidden and a spelled-out label: a screen reader reading
                  "Link sent 7" runs the count into the name as though it were
                  part of it. */}
              {n !== undefined && (
                <>
                  <span className="wm-tab-n" aria-hidden="true">{n}</span>
                  <span className="wm-sr-only">
                    {n} {n === 1 ? 'request' : 'requests'}
                  </span>
                </>
              )}
            </Link>
          );
        })}
        {service !== 'all' && (
          <Link to={href({ service: null })} className="wm-clear">
            {SERVICE_LABEL[service as Service]} ×
          </Link>
        )}
      </nav>

      {error && <p className="wm-error" role="alert">{error}</p>}
      {visible === null && !error && <p className="wm-empty">Loading…</p>}
      {visible?.length === 0 && (
        <p className="wm-empty">
          {search ? 'Nothing matches that search.' : 'Nothing here right now.'}
        </p>
      )}

      <ul className="wm-queue">
        {visible?.map((r) => (
          <li key={r.id} className="wm-queue-item">
            <Link to={`/r/${r.rid}`} className={`wm-row wm-row-${r.service}`}>
              <div className="wm-row-main">
                <div className="wm-row-top">
                  <span className="wm-row-name">
                    {r.first_name} {r.last_name}
                  </span>
                  <span className={`wm-pill wm-pill-${r.service}`}>
                    {SERVICE_LABEL[r.service]}
                  </span>
                  {r.client_is_minor && <span className="wm-pill wm-pill-minor">Minor</span>}
                  {r.status !== 'NEW' && (
                    <span className={`wm-pill wm-pill-status-${r.status}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                  )}
                </div>
                <p className="wm-row-summary">{r.summary || <em>No description given</em>}</p>
                <p className="wm-row-meta">
                  {r.artist_name} · {r.rid}
                  {r.image_count > 0 && ` · ${r.image_count} photo${r.image_count === 1 ? '' : 's'}`}
                </p>
              </div>

              <div className="wm-row-side">
                {/* A piercing arrives already priced by the client's own
                    answers; a tattoo does not, and showing "$0" for one would
                    be a lie the artist might not catch. */}
                {r.quoted_price !== null && (
                  <span className="wm-row-price">{priceLabel(r.quoted_price)}</span>
                )}
                {r.status === 'LINK_SENT' && r.estimate && (
                  <span className="wm-row-price wm-row-price-sent">{r.estimate}</span>
                )}
                <span className="wm-row-age">{waitingFor(r.submitted_at)}</span>
              </div>
            </Link>

            {/* Outside the <Link>, not inside it: a button nested in an anchor
                is invalid, and every click would navigate before it deleted
                anything. */}
            <button
              type="button"
              className="wm-row-delete"
              onClick={() => {
                setConfirmId(r.id);
                setDeleteError('');
              }}
              aria-label={`Delete the request from ${r.first_name} ${r.last_name}`}
            >
              Delete
            </button>

            {/* alertdialog rather than dialog: this interrupts to warn, and the
                distinction is what makes a screen reader announce the whole
                thing on open instead of just the focused button. */}
            {confirmId === r.id && (
              <div
                className="wm-confirm"
                role="alertdialog"
                aria-labelledby={`wm-del-h-${r.id}`}
                aria-describedby={`wm-del-b-${r.id}`}
              >
                <h3 id={`wm-del-h-${r.id}`}>Delete this request permanently?</h3>

                <div id={`wm-del-b-${r.id}`}>
                  {/* Names what actually goes, rather than "are you sure". The
                      photographs are the part people do not expect, because
                      they live in storage rather than in the row. */}
                  <p>
                    <strong>This cannot be undone.</strong> {r.first_name} {r.last_name}'s
                    request, their contact details, everything they wrote
                    {r.image_count > 0 &&
                      `, their ${r.image_count} reference photo${r.image_count === 1 ? '' : 's'}`}
                    {' '}and the record of what was sent to them are all destroyed. There is no
                    archive and nothing to restore from.
                  </p>

                  {/* Deleting the row does not reach into Acuity. Somebody who
                      already has a booking link keeps it, and the request that
                      explained who they are will be gone. */}
                  {r.status === 'LINK_SENT' && (
                    <p className="wm-confirm-note">
                      A booking link was already sent to this client. Deleting the request does
                      not cancel it — they can still book, and you will have nothing here saying
                      who they are or what they asked for.
                    </p>
                  )}
                </div>

                {deleteError && <p className="wm-error" role="alert">{deleteError}</p>}

                <div className="wm-confirm-actions">
                  <button
                    ref={keepItRef}
                    type="button"
                    className="wm-btn-quiet"
                    onClick={() => setConfirmId(null)}
                    disabled={deleting === r.id}
                  >
                    Keep it
                  </button>
                  <button
                    type="button"
                    className="wm-btn-danger"
                    onClick={() => void onDelete(r)}
                    disabled={deleting === r.id}
                  >
                    {deleting === r.id ? 'Deleting…' : 'Delete permanently'}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
