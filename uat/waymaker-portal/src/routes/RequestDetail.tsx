import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { respond, signedImageUrls, supabase } from '../lib/supabase';
import { dateTime, money, priceLabel } from '../lib/format';
import {
  SERVICE_LABEL,
  STATUS_LABEL,
  type RequestEvent,
  type RequestImage,
  type RequestRow,
  type TierOption
} from '../lib/types';

export default function RequestDetail() {
  const { rid = '' } = useParams();

  const [req, setReq] = useState<RequestRow | null>(null);
  const [tiers, setTiers] = useState<TierOption[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [events, setEvents] = useState<RequestEvent[]>([]);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');

    const { data, error } = await supabase
      .from('requests')
      .select('*')
      .eq('rid', rid)
      .maybeSingle();

    if (error) {
      setLoadError(error.message);
      return;
    }
    if (!data) {
      setLoadError('We can\'t find that request — or it belongs to another artist.');
      return;
    }

    /* `requests` has no artist_name column; the queue view joins it. One extra
       read rather than a second view, because the detail page needs the full
       row anyway and a view would have to repeat all forty columns. */
    const { data: artist } = await supabase
      .from('artists')
      .select('name')
      .eq('key', data.artist_key)
      .maybeSingle();

    const row = { ...data, artist_name: artist?.name ?? data.artist_key } as RequestRow;
    setReq(row);

    const [tierRes, imageRes, eventRes] = await Promise.all([
      supabase
        .from('tier_options')
        .select('*')
        .eq('artist_key', row.artist_key)
        .eq('service', row.service)
        .order('sort')
        .returns<TierOption[]>(),
      supabase
        .from('request_images')
        .select('id, storage_path, ordinal')
        .eq('request_id', row.id)
        .order('ordinal')
        .returns<RequestImage[]>(),
      supabase
        .from('request_events')
        .select('id, event, created_at, detail')
        .eq('request_id', row.id)
        .order('created_at', { ascending: false })
        .returns<RequestEvent[]>()
    ]);

    setTiers(tierRes.data ?? []);
    setEvents(eventRes.data ?? []);

    const paths = (imageRes.data ?? []).map((i) => i.storage_path);
    try {
      setImages(await signedImageUrls(paths));
    } catch {
      /* A signing failure costs the photos, not the page. The artist can still
         read the request and respond to it. */
      setImages([]);
    }
  }, [rid]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) return <p className="wm-error" role="alert">{loadError}</p>;
  if (!req) return <p className="wm-empty">Loading…</p>;

  return (
    <article className="wm-detail">
      <header className="wm-detail-head">
        <div>
          <p className="wm-kicker">
            {SERVICE_LABEL[req.service]} · {req.rid}
          </p>
          <h1>
            {req.first_name} {req.last_name}
          </h1>
          <p className="wm-detail-sub">
            For {req.artist_name} · submitted {dateTime(req.submitted_at)}
          </p>
        </div>
        <span className={`wm-pill wm-pill-status-${req.status} wm-pill-lg`}>
          {STATUS_LABEL[req.status]}
        </span>
      </header>

      <div className="wm-detail-grid">
        <div className="wm-detail-col">
          <Contact req={req} />
          <TheAsk req={req} />
          {req.client_is_minor && req.service === 'piercing' && <Guardian req={req} />}
          <Images urls={images} count={req.reference_count} />
        </div>

        <div className="wm-detail-col">
          {req.status === 'NEW' ? (
            <Responder req={req} tiers={tiers} onDone={load} />
          ) : (
            <>
              <Decided req={req} />
              {req.status === 'LINK_SENT' && req.booking_url && (
                <Resender req={req} onDone={load} />
              )}
            </>
          )}
          <History events={events} />
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ cards --- */

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  /* An empty value is rendered as an em dash rather than skipped. "We asked
     and they left it blank" and "we never asked" look identical in a list that
     hides empties, and only one of those is worth chasing. */
  return (
    <div className="wm-kv">
      <dt>{label}</dt>
      <dd>{value === '' || value === null || value === undefined ? <span className="wm-nil">—</span> : value}</dd>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="wm-card">
      <h2>{title}</h2>
      <dl>{children}</dl>
    </section>
  );
}

function Contact({ req }: { req: RequestRow }) {
  return (
    <Card title="Contact">
      <Field label="Email" value={<a href={`mailto:${req.email}`}>{req.email}</a>} />
      <Field label="Phone" value={req.phone ? <a href={`tel:${req.phone}`}>{req.phone}</a> : ''} />
      <Field label="Heard about us" value={req.heard_from} />
      {/* Only meaningful alongside heard_from: a person's name when the source
          was a referral, a description when it was "Other". */}
      <Field label="Referred by" value={req.referred_by} />
      <Field
        label={req.service === 'piercing' ? 'First piercing' : 'First tattoo'}
        value={req.first_time ? 'Yes' : 'No'}
      />
    </Card>
  );
}

function TheAsk({ req }: { req: RequestRow }) {
  if (req.service === 'piercing') {
    return (
      <Card title="The piercing">
        <Field label="Piercing" value={req.piercing_type} />
        <Field label="How many" value={req.piercing_count} />
        <Field label="Side" value={req.piercing_side} />
        <Field label="Jewelry" value={req.jewelry} />
        <Field label="Notes" value={req.piercing_notes} />
        {/* Fully determined by the two answers above — the artist approves this
            number rather than picking one. Null is a custom piercing. */}
        <Field
          label="Menu price"
          value={<strong>{req.quote_label || priceLabel(req.quoted_price)}</strong>}
        />
      </Card>
    );
  }

  if (req.service === 'touchup') {
    return (
      <Card title="The touch up">
        <Field label="What needs work" value={req.touchup_details} />
        <Field label="Placement" value={req.touchup_placement} />
        <Field label="How old" value={req.touchup_age} />
        <Field label="Done by us" value={req.touchup_by_us} />
      </Card>
    );
  }

  return (
    <Card title="The piece">
      <Field label="Idea" value={<span className="wm-prose">{req.idea}</span>} />
      <Field label="Placement" value={req.placement} />
      <Field label="Size" value={req.size} />
      <Field label="Style" value={req.style} />
    </Card>
  );
}

function Guardian({ req }: { req: RequestRow }) {
  return (
    <Card title="Who's being pierced">
      <Field label="Name" value={`${req.minor_first_name} ${req.minor_last_name}`.trim()} />
      <Field label="Age" value={req.minor_age ?? ''} />
      <Field label="Guardian is their" value={req.guardian_relationship} />
      <Field
        label="Consent given"
        value={req.guardian_consent ? 'Yes' : <strong className="wm-warn">No — do not book</strong>}
      />
    </Card>
  );
}

function Images({ urls, count }: { urls: string[]; count: number }) {
  if (count === 0) return null;

  return (
    <section className="wm-card">
      <h2>
        References
        {/* A mismatch is worth showing. The row records how many the client
            sent; a short gallery means an upload failed, and silently rendering
            two of three photos is how that goes unnoticed. */}
        {urls.length !== count && (
          <span className="wm-warn"> · {urls.length} of {count} loaded</span>
        )}
      </h2>
      <div className="wm-gallery">
        {urls.map((url, i) => (
          <a key={url} href={url} target="_blank" rel="noreferrer">
            <img src={url} alt={`Reference ${i + 1}`} loading="lazy" />
          </a>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- responding --- */

function defaultMessage(req: RequestRow): string {
  const first = req.first_name || 'there';
  if (req.service === 'piercing') {
    return `Hi ${first} — thanks for sending this over. Everything looks good on my end, ` +
      `so grab whichever time works for you with the link below and I'll see you then.`;
  }
  if (req.service === 'touchup') {
    return `Hi ${first} — thanks for sending this over. I've had a look at the photos and ` +
      `this is a straightforward one. Use the link below to pick a time.`;
  }
  return `Hi ${first} — thanks for sending this over. I've read through your idea and ` +
    `I'd love to take it on. Here's what I'm estimating for the session, and a link to book it.`;
}

function Responder({
  req,
  tiers,
  onDone
}: {
  req: RequestRow;
  tiers: TierOption[];
  onDone: () => void;
}) {
  const [tierKey, setTierKey] = useState('');
  const [estimate, setEstimate] = useState('');
  const [message, setMessage] = useState(() => defaultMessage(req));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDecline, setConfirmDecline] = useState(false);

  const chosen = useMemo(() => tiers.find((t) => t.tier_key === tierKey), [tiers, tierKey]);

  /* The estimate box follows the picked tier until the artist types in it, at
     which point it stops moving underneath them. `touched` is what tells the
     two apart — without it, editing "3 hr · $375" and then changing your mind
     about the tier silently discards the edit, and with a naive guard the box
     never updates at all. */
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched) return;
    if (!chosen) {
      setEstimate(req.quote_label);
      return;
    }
    const price = money(chosen.price);
    setEstimate(
      req.service === 'piercing' && req.quote_label
        ? req.quote_label
        : price
          ? `${chosen.label} · ${price}`
          : chosen.label
    );
  }, [chosen, touched, req.quote_label, req.service]);

  async function send(action: 'send' | 'decline') {
    setBusy(true);
    setError('');

    const result = await respond({
      rid: req.rid,
      action,
      tierKey: action === 'send' ? tierKey : undefined,
      estimate: action === 'send' ? estimate : undefined,
      message
    });

    if (!result.ok) {
      setError(result.error ?? 'Something went wrong.');
      setBusy(false);
      /* An already-decided request is not an error to sit on — reload so the
         page stops offering a form that cannot work. */
      if (result.alreadyDecided) onDone();
      return;
    }

    onDone();
  }

  const unbookable = tiers.filter((t) => !t.bookable);

  return (
    <section className="wm-card wm-respond">
      <h2>Respond</h2>

      <fieldset disabled={busy}>
        <legend>Appointment type</legend>
        {tiers.length === 0 && (
          <p className="wm-warn">
            {req.artist_name} has no {SERVICE_LABEL[req.service].toLowerCase()} appointment
            types set up. Add rows to <code>service_tiers</code> before responding.
          </p>
        )}

        <div className="wm-tiers">
          {tiers.map((t) => (
            <label
              key={t.tier_key}
              className={`wm-tier ${tierKey === t.tier_key ? 'is-on' : ''} ${t.bookable ? '' : 'is-off'}`}
            >
              <input
                type="radio"
                name="tier"
                value={t.tier_key}
                checked={tierKey === t.tier_key}
                disabled={!t.bookable}
                onChange={() => setTierKey(t.tier_key)}
              />
              <span className="wm-tier-label">{t.label}</span>
              <span className="wm-tier-price">{priceLabel(t.price)}</span>
            </label>
          ))}
        </div>

        {unbookable.length > 0 && (
          <p className="wm-note">
            {unbookable.map((t) => t.label).join(', ')}{' '}
            {unbookable.length === 1 ? 'has' : 'have'} no Acuity booking link yet — create the
            appointment type in Acuity, then set <code>acuity_url</code> on that row.
          </p>
        )}

        <label className="wm-label" htmlFor="estimate">
          Estimate the client sees
        </label>
        <input
          id="estimate"
          value={estimate}
          onChange={(e) => {
            setTouched(true);
            setEstimate(e.target.value);
          }}
          placeholder="e.g. 3 hr · $375"
        />

        <label className="wm-label" htmlFor="message">
          Message
        </label>
        <textarea
          id="message"
          rows={7}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />

        {error && <p className="wm-error" role="alert">{error}</p>}

        <div className="wm-respond-actions">
          <button
            type="button"
            className="wm-btn-primary"
            disabled={busy || !tierKey}
            onClick={() => void send('send')}
          >
            {busy ? 'Sending…' : 'Send Response'}
          </button>

          {/* Two presses, because there is no undo. The row is claimed and the
              client is mailed the moment this succeeds. */}
          {confirmDecline ? (
            <>
              <button
                type="button"
                className="wm-btn-danger"
                disabled={busy}
                onClick={() => void send('decline')}
              >
                Confirm decline
              </button>
              <button type="button" className="wm-btn-quiet" onClick={() => setConfirmDecline(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="wm-btn-quiet"
              disabled={busy}
              onClick={() => setConfirmDecline(true)}
            >
              Decline
            </button>
          )}
        </div>

        <p className="wm-note">
          Declining sends the message above with no price and no booking link.
        </p>
      </fieldset>
    </section>
  );
}

function Decided({ req }: { req: RequestRow }) {
  return (
    <Card title={req.status === 'DECLINED' ? 'Declined' : 'Response sent'}>
      <Field label="When" value={dateTime(req.decided_at)} />
      {req.status !== 'DECLINED' && (
        <>
          <Field label="Appointment type" value={req.tier_sent} />
          <Field label="Estimate sent" value={req.estimate} />
          <Field
            label="Booking link"
            value={
              req.booking_url ? (
                <a href={req.booking_url} target="_blank" rel="noreferrer">
                  Open in Acuity
                </a>
              ) : (
                ''
              )
            }
          />
        </>
      )}
      <Field label="Message" value={<span className="wm-prose">{req.artist_note}</span>} />
    </Card>
  );
}

/* Clients lose emails. This sends the same one again — same link, same
   estimate, same note unless the artist adds a line — without touching the
   request. It stays LINK_SENT, keeps its original decided_at, and the resend
   is recorded in History rather than overwriting the decision.

   ⚠ Collapsed until asked for. An always-visible textarea makes a settled
   record look like it is waiting to be filled in — indistinguishable at a
   glance from the compose box on a request that still needs a response. Most
   visits to a decided request are someone reading it, so the default state is
   a single line of text. */
function Resender({ req, onDone }: { req: RequestRow; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState('');

  async function send() {
    setBusy(true);
    setError('');

    const result = await respond({
      rid: req.rid,
      action: 'resend',
      message: note.trim() || req.artist_note
    });

    setBusy(false);

    if (!result.ok) {
      setError(result.error ?? 'Something went wrong.');
      return;
    }

    /* Collapse on success. The panel has done its job, and leaving it open
       invites a second press. */
    setSentTo(req.email);
    setNote('');
    setOpen(false);
    onDone();
  }

  function cancel() {
    setOpen(false);
    setNote('');
    setError('');
  }

  if (!open) {
    return (
      <section className={`wm-card wm-resend${sentTo ? ' has-receipt' : ''}`}>
        <button
          type="button"
          className="wm-btn-link"
          aria-expanded="false"
          onClick={() => { setSentTo(''); setOpen(true); }}
        >
          Resend booking link
        </button>
        {sentTo && (
          <p className="wm-resend-ok" role="status">Sent again to {sentTo}.</p>
        )}
      </section>
    );
  }

  return (
    <section className="wm-card wm-resend is-open">
      <button
        type="button"
        className="wm-btn-link is-open"
        aria-expanded="true"
        onClick={cancel}
      >
        Resend booking link
      </button>

      <div className="wm-resend-body">
        <p className="wm-note wm-resend-lead">
          Sends the same booking link and estimate to <strong>{req.email}</strong> again.
          Nothing about the request changes.
        </p>

        <fieldset disabled={busy}>
          <label className="wm-label" htmlFor="resend-note">Add a line (optional)</label>
          <textarea
            id="resend-note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Resending this — it may have landed in your spam folder."
          />
          <p className="wm-note">Leave it blank to send your original message unchanged.</p>

          {error && <p className="wm-error" role="alert">{error}</p>}

          <div className="wm-respond-actions">
            {/* Two presses: opening this panel is one, confirming is the other.
                Neither a stray click nor a stray Enter should put a second
                email in a client's inbox. */}
            <button type="button" className="wm-btn-primary" disabled={busy} onClick={() => void send()}>
              {busy ? 'Sending…' : 'Confirm resend'}
            </button>
            <button type="button" className="wm-btn-quiet" disabled={busy} onClick={cancel}>
              Cancel
            </button>
          </div>
        </fieldset>
      </div>
    </section>
  );
}

function History({ events }: { events: RequestEvent[] }) {
  if (!events.length) return null;
  return (
    <section className="wm-card">
      <h2>History</h2>
      <ul className="wm-history">
        {events.map((e) => (
          <li key={e.id}>
            <span className="wm-history-event">{e.event.replace(/_/g, ' ')}</span>
            <span className="wm-history-when">{dateTime(e.created_at)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
