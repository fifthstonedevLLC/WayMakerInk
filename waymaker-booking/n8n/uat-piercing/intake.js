/* ==========================================================================
   WayMaker Ink — Booking intake
   Workflow A · Code node, placed immediately after the Webhook node.
   Mode: "Run Once for All Items"
   ========================================================================== */

/* --------------------------------------------------------------- config ---
   Values come from the environment where n8n allows it, and from the FALLBACK
   block where it doesn't.

   $env reads OS environment variables and works on self-hosted Community
   provided N8N_BLOCK_ENV_ACCESS_IN_NODE=false. It is NOT the same as $vars
   (n8n "Variables"), which is an Enterprise feature. If $env is unavailable
   in your install, edit FALLBACK below and nothing else changes.

   To check which applies, run this in any Code node:
     return [{ json: { envAvailable: typeof $env !== 'undefined' } }];
   -------------------------------------------------------------------------- */
const FALLBACK = {
  WM_SIGNING_SECRET: 'dev-signing-secret',
  WM_N8N_BASE_URL: 'https://booking.waymakerink.com',
  WM_ARTIST_NIC_EMAIL: 'phil.harberts@fifthstonedev.com',
  WM_ARTIST_LAYNIE_EMAIL: 'phil.harberts@fifthstonedev.com',
  WM_ARTIST_NIC_RATE: '125',
  WM_ARTIST_LAYNIE_RATE: '100'
};

function cfg(name) {
  let fromEnv;
  try {
    fromEnv = typeof $env !== 'undefined' && $env ? $env[name] : undefined;
  } catch (e) {
    fromEnv = undefined;              /* env access blocked by n8n config */
  }
  const value = String(fromEnv || FALLBACK[name] || '').trim();
  if (!value) throw new Error(`Missing config "${name}" — set it in the environment or in FALLBACK.`);
  return value;
}

const SECRET = cfg('WM_SIGNING_SECRET');
const BASE = cfg('WM_N8N_BASE_URL').replace(/\/+$/, '');
const TTL_DAYS = 30;

if (SECRET === 'dev-signing-secret') {
  throw new Error(
    'WM_SIGNING_SECRET is still the development placeholder. Set a real secret ' +
    '(openssl rand -base64 32) before this handles live requests.'
  );
}

/* `rate` is the artist's hourly rate in whole dollars. The five session
   lengths below are the same for everyone; only the multiplier differs, which
   is why there is one request email and not one per artist — the buttons are
   priced from this map at send time.

   nodes/review-page.js carries the same rates and the same tier hours, and it
   has to: that page re-derives the price from the sheet row's artistKey when
   the artist taps a button. If the two drift, the email quotes one number and
   the review screen quotes another.

   `services` is authoritative. public/app.js carries its own copy, but that
   file is served to the client and is therefore advisory only — a forged POST
   does not have to respect it. A piercing filed against an artist who does not
   pierce must fail here, loudly, for the same reason an unknown artistKey
   does: it would otherwise land in the sheet against someone who cannot
   fulfil it. */
const ARTISTS = {
  nic: {
    name: 'Nic Sinnwell',
    email: cfg('WM_ARTIST_NIC_EMAIL'),
    rate: cfg('WM_ARTIST_NIC_RATE'),
    services: ['tattoo']
  },
  laynie: {
    name: 'Laynie Joy',
    email: cfg('WM_ARTIST_LAYNIE_EMAIL'),
    rate: cfg('WM_ARTIST_LAYNIE_RATE'),
    services: ['tattoo', 'piercing']
  }
};

for (const [key, a] of Object.entries(ARTISTS)) {
  if (a.email.startsWith('REPLACE_')) {
    throw new Error(`Artist "${key}" still has a placeholder email (${a.email}). Set WM_ARTIST_${key.toUpperCase()}_EMAIL.`);
  }
  /* Same reasoning as the email check: a rate that silently read as 0 would
     mail the client a $0 estimate, which looks like a working system. */
  a.rate = Number(a.rate);
  if (!Number.isFinite(a.rate) || a.rate <= 0) {
    throw new Error(`Artist "${key}" has no usable hourly rate. Set WM_ARTIST_${key.toUpperCase()}_RATE to a number of dollars.`);
  }
}

/* `parts` rather than a finished label so the price can be joined on with the
   same non-breaking separator the other segments use — the tier-5 button reads
   "All Day · 7 hr · $875" and none of those three dots should be a line break
   point on a phone. */
const TIERS = [
  { key: 'tier1', parts: ['1 hr'], hours: 1 },
  { key: 'tier2', parts: ['2 hr'], hours: 2 },
  { key: 'tier3', parts: ['3 hr'], hours: 3 },
  { key: 'tier4', parts: ['4 hr'], hours: 4 },
  { key: 'tier5', parts: ['All Day', '7 hr'], hours: 7 }
];

/* No all-day discount is applied: 7 × $125 is the $875 the buttons have always
   shown. If one is ever wanted it belongs here, as a per-tier override. */
const price = (rate, hours) => rate * hours;

const money = (n) => '$' + Number(n).toLocaleString('en-US');

/* ------------------------------------------------------------- piercing ---
   Flat fees, transcribed from the shop's printed menu. `pair: null` means
   single-only — the form must not offer Pair for that type, and this throws if
   one arrives anyway rather than inventing a price.

   Keys are the picker's option values verbatim. If the two drift, every request
   silently becomes "quote on request" and Laynie prices the whole book by hand,
   so PIERCING_PAIRS in public/app.js and this table have to move together.
   This one holds the money and is authoritative; that one only decides whether
   a chip is selectable. */
const PIERCING_PRICES = {
  'Basic Lobe':    { single: 30, pair: 50 },
  'Helix':         { single: 45, pair: 75 },
  'Forward Helix': { single: 55, pair: null },
  'Rook':          { single: 55, pair: null },
  'Daith':         { single: 65, pair: null },
  'Tragus':        { single: 55, pair: null },
  'Anti-tragus':   { single: 55, pair: null },
  'Conch':         { single: 45, pair: null },
  'Basic Eyebrow': { single: 45, pair: null },
  'Nose':          { single: 45, pair: 75 },
  'Bellybutton':   { single: 50, pair: null },
  'Lip':           { single: 45, pair: 75 }
};

/* The one picker option with no price behind it, by design — the menu invites
   it: "if you don't see your vision listed, just ask!" */
const PIERCING_CUSTOM = "Something else — I'll describe it";

/* Exactly one priced action, looked up rather than multiplied. The artist's
   hourly rate does not feed this at all: price is fully determined by type and
   count, both of which the client supplies, so the artist approves a number
   rather than picking one.

   ⚠ `price: null` is not `price: 0`. The custom path has NO price, and every
   consumer has to tell that apart from a free piercing — money(null) would
   render "$0" and mail a client a free piercing. The email template branches
   on `price == null` and prints "Quote on request" instead. */
function piercingTiers(type, count) {
  if (type === PIERCING_CUSTOM) {
    return [{
      key: 'pierce',
      label: 'Quote on request',
      price: null,
      display: 'Approve &nbsp;·&nbsp; quote on request'
    }];
  }

  /* Told apart from an unrecognised type on purpose. Blank means the picker
     was never answered — a native form POST with JS disabled, or a forged one
     — and "Unknown piercing type """ sends whoever reads the execution log
     hunting for a naming drift that isn't there. */
  if (!type) {
    throw new Error('A piercing request arrived with no piercingType. The form requires one.');
  }

  const row = PIERCING_PRICES[type];
  /* Loud, like the unknown-artist throw. An unrecognised type here is a forged
     POST or a picker that drifted from this table — both are bugs, and both are
     worse quoted at $0 than failed at the webhook. */
  if (!row) throw new Error(`Unknown piercing type "${type}".`);

  const isPair = String(count) === 'Pair';
  if (isPair && row.pair == null) {
    throw new Error(`"${type}" is not offered as a pair.`);
  }

  const amount = isPair ? row.pair : row.single;
  const label = isPair ? 'Pair' : 'Single';
  return [{
    key: 'pierce',
    label,
    price: amount,
    display: [label, money(amount)].join(' &nbsp;·&nbsp; ')
  }];
}

/* The email buttons render `display` verbatim, so the &nbsp; entities are
   deliberate — see the .wm-btn note in templates/request-email.html. */
function tiersFor(rate) {
  return TIERS.map((t) => {
    const amount = price(rate, t.hours);
    return {
      key: t.key,
      hours: t.hours,
      label: t.parts.join(' · '),
      price: amount,
      display: [...t.parts, money(amount)].join(' &nbsp;·&nbsp; ')
    };
  });
}

/* HMAC-SHA256, truncated to 32 hex chars (128 bits) to keep the links short.
   Requires NODE_FUNCTION_ALLOW_BUILTIN to include `crypto`.

   The previous scheme was a 32-bit non-cryptographic string hash — a 4-byte
   space, forgeable by brute force in milliseconds once the algorithm is known,
   and the algorithm lives in this repo. verify-link.js must use this
   exact construction or every link fails.

   Changing SECRET or this function invalidates all unopened request emails. */
const crypto = require('crypto');

function buildSig(rid, action, exp) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${rid}.${action}.${exp}`)
    .digest('hex')
    .slice(0, 32);
}

function encodeQueryPart(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\+/g, '%2B')
    .replace(/ /g, '%20');
}

function decisionUrl(rid, action, exp) {
  const sig = buildSig(rid, action, exp);
  const qs = [
    `rid=${encodeQueryPart(rid)}`,
    `action=${encodeQueryPart(action)}`,
    `exp=${encodeQueryPart(String(exp))}`,
    `sig=${encodeQueryPart(sig)}`
  ].join('&');
  /* Production path. /webhook-test/ accepts exactly one request and only while
     the n8n editor is open with "Listen for test event" armed — links built
     against it die the moment the tab closes.

     ⚠ UAT COPY — `-uat` suffix. Production is `/webhook/decide`. n8n refuses
     to activate two workflows on one path, so the UAT copy of Workflow B has
     its own, and this literal is what points at it. Nothing else in the system
     knows these two strings have to agree.

     Revert this on promotion. Left as it is, a production request email links
     every artist decision into the UAT workflow. */
  return `${BASE}/webhook/decide-uat?${qs}`;
}

const out = [];

for (const item of items) {
  const root = item.json || {};
  const body = root.body && typeof root.body === 'object' ? root.body : {};
  const payload = {
    ...root,
    ...body
  };

  if (String(payload.company || '').trim()) continue;

  const artistKey = String(payload.artist || '').toLowerCase();
  const artist = ARTISTS[artistKey];
  if (!artist) {
    throw new Error(`Unknown artist key "${artistKey}"`);
  }

  /* Anything that isn't the literal "piercing" is a tattoo, so a row from
     before this field existed — or a client with JS disabled posting the form
     natively — behaves exactly as it does today.

     ⚠ This deliberately differs from the rule in review-page.js and commit.js.
     Those two DEFAULT a blank service to tattoo because they replay historical
     rows they cannot re-ask. Intake validates fresh client input, so it throws.
     Throwing there would break every in-flight decision link. */
  const service = String(payload.service || 'tattoo').trim().toLowerCase() === 'piercing'
    ? 'piercing'
    : 'tattoo';

  if (!artist.services.includes(service)) {
    throw new Error(
      `Artist "${artistKey}" does not offer ${service}. ` +
      `A ${service} request cannot be filed against them.`
    );
  }

  const isPiercing = service === 'piercing';

  /* Read once, here, so the price lookup and the sheet row cannot disagree
     about what was asked for. */
  const piercingType = String(payload.piercingType || '').trim();
  const piercingCount = String(payload.piercingCount || '').trim() || 'Single';

  const rid = String(
    payload.rid || payload.requestId || payload.request_id || root.rid || root.requestId || root.request_id || ''
  ).trim() || 'WMI-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const exp = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;

  const binaryKeys = Object.keys(item.binary || {});

  /* One action for a piercing (`pierce`), five for a tattoo (`tier1…tier5`).
     A distinct key matters beyond tidiness: it keeps the sheet's `tierSent`
     column self-describing, and makes a mis-routed link fail loudly instead of
     resolving to a tattoo appointment type in Acuity. */
  const priced = isPiercing
    ? piercingTiers(piercingType, piercingCount)
    : tiersFor(artist.rate);

  const tiers = priced.map((t) => ({ ...t, url: decisionUrl(rid, t.key, exp) }));

  out.push({
    json: {
      rid,
      linkRid: rid,
      requestId: rid,
      exp,
      artistKey,
      artistName: artist.name,
      artistEmail: artist.email,
      firstName: String(payload.firstName || '').trim(),
      lastName: String(payload.lastName || '').trim(),
      email: String(payload.email || '').trim(),
      phone: String(payload.phone || '').trim(),
      firstTattoo: payload.firstTattoo || 'No',
      /* Referral tracking. 'Not given' rather than '' so a blank cell in the
         sheet means "this row predates the field", not "they declined to say" —
         the two need telling apart when the artist counts sources. */
      heardFrom: String(payload.heardFrom || '').trim() || 'Not given',
      /* Only meaningful alongside heardFrom: a person's name when the source
         was a referral, a free-text description when it was "Other". Interior
         whitespace is collapsed so "Jane  Doe" and "Jane Doe" land in the same
         bucket — COUNTIF already ignores case, but not double spaces. */
      referredBy: String(payload.referredBy || '').replace(/\s+/g, ' ').trim(),

      /* ⚠ '' means "not applicable to this service"; 'Not given' means the
         question was asked and skipped. The two have to be tellable apart in
         the sheet — a blank `size` on a piercing row is correct, a blank one on
         a tattoo row is a bug. Every field below follows that rule. */

      /* --- tattoo ------------------------------------------------------- */
      idea: isPiercing ? '' : String(payload.idea || '').trim(),
      placement: isPiercing ? '' : String(payload.placement || '').trim(),
      size: isPiercing ? '' : String(payload.size || '').trim(),
      style: isPiercing ? '' : (payload.style || 'Not sure yet'),

      /* --- service ------------------------------------------------------ */
      /* Human-readable: the sheet is read by people. review-page.js and
         commit.js lowercase it before branching. */
      service: isPiercing ? 'Piercing' : 'Tattoo',

      /* --- piercing ------------------------------------------------------
         piercingType and piercingCount are not merely informational: workflow
         B re-derives the quote from these two columns when the artist opens
         the review page, because the signed link deliberately carries no
         price. A row that reaches the sheet with either one blank produces a
         review page that cannot price itself. */
      piercingType: isPiercing ? piercingType : '',
      piercingCount: isPiercing ? piercingCount : '',
      piercingSide: isPiercing ? String(payload.piercingSide || '').trim() : '',
      jewelry: isPiercing ? String(payload.jewelry || '').trim() : '',
      piercingNotes: isPiercing ? String(payload.piercingNotes || '').trim() : '',

      /* --- minors --------------------------------------------------------
         Asked on every request the form serves, so this one carries through
         for tattoos too — there it is the 18+ gate's answer. The guardian
         block below is piercing-only: a minor cannot be tattooed at all. */
      clientIsMinor: String(payload.clientIsMinor || 'No').trim() === 'Yes' ? 'Yes' : 'No',
      minorFirstName: isPiercing ? String(payload.minorFirstName || '').trim() : '',
      minorLastName: isPiercing ? String(payload.minorLastName || '').trim() : '',
      minorAge: isPiercing ? String(payload.minorAge || '').trim() : '',
      guardianRelationship: isPiercing ? String(payload.guardianRelationship || '').trim() : '',
      guardianConsent: isPiercing && String(payload.guardianConsent || '').trim() ? 'Yes' : '',

      submittedAt: payload.submittedAt || new Date().toISOString(),
      pageUrl: payload.pageUrl || '',
      referenceCount: Number(payload.referenceCount) || 0,
      attachmentProps: binaryKeys.join(','),
      tiers,
      links: {
        ...Object.fromEntries(tiers.map((t) => [t.key, t.url])),
        decline: decisionUrl(rid, 'decline', exp)
      },
      /* Must match the undecided value the Append row node writes, and the
         gates in review-page.js and commit.js. */
      status: 'NEW'
    },
    binary: item.binary
  });
}

return out;
