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
  WM_N8N_BASE_URL: 'https://n8n.fifthstonedev.com',
  WM_ARTIST_NIC_EMAIL: 'REPLACE_nic@waymakerink.com',
  WM_ARTIST_LAYNIE_EMAIL: 'REPLACE_laynie@waymakerink.com'
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

const ARTISTS = {
  nic: { name: 'Nic Sinnwell', email: cfg('WM_ARTIST_NIC_EMAIL') },
  laynie: { name: 'Laynie Joy', email: cfg('WM_ARTIST_LAYNIE_EMAIL') }
};

for (const [key, a] of Object.entries(ARTISTS)) {
  if (a.email.startsWith('REPLACE_')) {
    throw new Error(`Artist "${key}" still has a placeholder email (${a.email}). Set WM_ARTIST_${key.toUpperCase()}_EMAIL.`);
  }
}

const TIERS = [
  { key: 'tier1', label: '1 hr', hours: 1, price: 125 },
  { key: 'tier2', label: '2 hr', hours: 2, price: 250 },
  { key: 'tier3', label: '3 hr', hours: 3, price: 375 },
  { key: 'tier4', label: '4 hr', hours: 4, price: 500 },
  { key: 'tier5', label: 'All Day · 7 hr', hours: 7, price: 875 }
];

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
     against it die the moment the tab closes. */
  return `${BASE}/webhook/decide?${qs}`;
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

  const rid = String(
    payload.rid || payload.requestId || payload.request_id || root.rid || root.requestId || root.request_id || ''
  ).trim() || 'WMI-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const exp = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;

  const binaryKeys = Object.keys(item.binary || {});
  const tiers = TIERS.map((t) => ({ ...t, url: decisionUrl(rid, t.key, exp) }));

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
      idea: String(payload.idea || '').trim(),
      placement: String(payload.placement || '').trim(),
      size: String(payload.size || '').trim(),
      style: payload.style || 'Not sure yet',
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
