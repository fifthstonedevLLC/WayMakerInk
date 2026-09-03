/* ==========================================================================
   WayMaker Ink — verify an inbound call from the Edge Functions
   Code node, placed IMMEDIATELY after the Webhook node in both mail workflows.
   Mode: "Run Once for All Items"

   Both webhooks are public URLs that make the shop send email. This is what
   stops anyone who learns one of those URLs from using it.

   It answers three questions, and a shared token in a header only answers the
   first:

     1. Is the caller us?          the signature verifies against our secret
     2. Was the payload altered?   the signature covers the fields that matter
     3. Is this a replay?          the timestamp is within MAX_SKEW_SECONDS

   ⚠ Place this BEFORE anything that sends. On failure it throws, which stops
   the workflow — there is no false branch to mis-wire into a Send Email node.
   That is deliberate: an IF node whose false output is left dangling looks
   correct on the canvas and sends anyway.

   ⚠ Webhook node settings this depends on:
       Raw Body   OFF   — the body must be parsed JSON, not bytes
       Respond    whatever the workflow needs; this node does not respond

   Requires NODE_FUNCTION_ALLOW_BUILTIN to include `crypto`, which the n8n
   container already sets for the decision-link signing in the booking build.
   ========================================================================== */

const crypto = require('crypto');

/* --------------------------------------------------------------- config ---
   Same $env-or-FALLBACK pattern the booking nodes use. $env reads OS
   environment variables and works on self-hosted Community provided
   N8N_BLOCK_ENV_ACCESS_IN_NODE=false. It is NOT $vars, which is Enterprise. */
const FALLBACK = {
  WM_N8N_SIGNING_SECRET: 'dev-signing-secret'
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

const SECRET = cfg('WM_N8N_SIGNING_SECRET');

if (SECRET === 'dev-signing-secret') {
  throw new Error(
    'WM_N8N_SIGNING_SECRET is still the development placeholder. Set the same ' +
    'value here and on the Supabase functions (openssl rand -base64 32).'
  );
}

/* How far apart the two clocks may be. Five minutes is generous for servers
   that both run NTP, and short enough that a captured request is stale long
   before anyone could use it. */
const MAX_SKEW_SECONDS = 300;

/* ⚠ EDIT THIS PER WORKFLOW. The fields that MUST appear in X-WM-Signed for the
   call to be accepted.

     wm-respond-uat        ['rid', 'action', 'to', 'bookingUrl']
     wm-notify-artist-uat  ['rid', 'artistEmail']

   Without it, a caller could sign a canon of just `rid` and leave `to`
   unprotected — the signature would verify, and the recipient would be
   whatever they put in the body. This is the node asserting what the signature
   is required to cover, rather than trusting the sender to say. */
const REQUIRE_SIGNED = ['rid', 'action', 'to', 'bookingUrl'];

/* ---------------------------------------------------------------- verify --- */

const item = items[0];
if (!item) throw new Error('No item on the webhook — nothing to verify.');

const root = item.json || {};
/* n8n lowercases inbound header names. */
const headers = root.headers || {};
const body = root.body && typeof root.body === 'object' ? root.body : {};

const rawSig = String(headers['x-wm-signature'] || '');
const rawTs = String(headers['x-wm-timestamp'] || '');
const rawSigned = String(headers['x-wm-signed'] || '');

if (!rawSig || !rawTs || !rawSigned) {
  throw new Error('Unsigned request — X-WM-Signature, X-WM-Timestamp and X-WM-Signed are all required.');
}

/* Versioned so the scheme can change without every in-flight call failing in a
   way nobody can read. */
if (!rawSig.startsWith('v1=')) {
  throw new Error(`Unsupported signature version: ${rawSig.split('=')[0]}`);
}
const given = rawSig.slice(3);

/* --- replay window -------------------------------------------------------- */
const ts = Number(rawTs);
if (!Number.isFinite(ts)) throw new Error('X-WM-Timestamp is not a number.');

const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
if (skew > MAX_SKEW_SECONDS) {
  /* A future timestamp is as suspicious as an old one, hence the abs(): it is
     either a replay or the two clocks have drifted, and both need looking at. */
  throw new Error(
    `Timestamp is ${skew}s away from now (limit ${MAX_SKEW_SECONDS}s). ` +
    `Either this is a replayed request or the clocks have drifted.`
  );
}

/* --- what the signature claims to cover ----------------------------------- */
const signed = rawSigned.split(',').map((s) => s.trim()).filter(Boolean);

for (const required of REQUIRE_SIGNED) {
  if (!signed.includes(required)) {
    throw new Error(
      `Signature does not cover "${required}". Signed fields were: ${signed.join(', ') || '(none)'}.`
    );
  }
}

/* --- recompute ------------------------------------------------------------
   Must match buildCanon in supabase/functions/_shared/n8n.ts exactly: the
   literal 'v1', the timestamp, then one `name=value` line per signed field in
   the order the header lists them.

   The NAMES are in the string, not just the values. Without them,
   {a:'x', b:'y'} signed as [a,b] and {a:'y', b:'x'} signed as [b,a] hash
   identically, and a captured request could have two fields swapped. */
const lines = ['v1', String(ts)];
for (const name of signed) {
  const value = body[name] === undefined || body[name] === null ? '' : body[name];
  lines.push(`${name}=${value}`);
}

const expected = crypto
  .createHmac('sha256', SECRET)
  .update(lines.join('\n'))
  .digest('hex');

/* timingSafeEqual throws on a length mismatch, so the lengths are compared
   first — and compared on the hex strings, which are fixed-length for a given
   algorithm, so this leaks nothing an attacker does not already know. */
const a = Buffer.from(given, 'utf8');
const b = Buffer.from(expected, 'utf8');

if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
  throw new Error(
    'Bad signature. Either this call did not come from the WayMaker Edge ' +
    'Functions, or WM_N8N_SIGNING_SECRET differs between the two sides.'
  );
}

/* Verified. The body is passed through flat, so every node downstream reads
   $json.to, $json.estimate and so on — not $json.body.to. */
return [{ json: { ...body, wmVerified: true, wmSignedFields: signed } }];
