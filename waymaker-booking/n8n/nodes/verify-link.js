/* ==========================================================================
   WayMaker Ink — Verify a decision link
   Used twice: Workflow B (/decide, GET) and Workflow C (/decide-commit, POST).
   Mode: "Run Once for All Items"

   This node is the only thing standing between a guessed `rid` and someone
   else's booking decision. It fails closed: anything not positively verified
   is rejected.

   The signing construction must match buildSig() in nodes/intake.js
   exactly — same secret, same joined string, same truncation.
   ========================================================================== */

/* Must match nodes/intake.js. See the comment there on $env vs $vars. */
const FALLBACK = {
  WM_SIGNING_SECRET: 'dev-signing-secret'
};

function cfg(name) {
  let fromEnv;
  try {
    fromEnv = typeof $env !== 'undefined' && $env ? $env[name] : undefined;
  } catch (e) {
    fromEnv = undefined;
  }
  const value = String(fromEnv || FALLBACK[name] || '').trim();
  if (!value) throw new Error(`Missing config "${name}" — set it in the environment or in FALLBACK.`);
  return value;
}

const SECRET = cfg('WM_SIGNING_SECRET');

if (SECRET === 'dev-signing-secret') {
  throw new Error(
    'WM_SIGNING_SECRET is still the development placeholder. Set a real secret ' +
    'before this verifies live links.'
  );
}

const crypto = require('crypto');

function buildExpected(rid, action, exp) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${rid}.${action}.${exp}`)
    .digest('hex')
    .slice(0, 32);
}

/* Comparing signatures with === leaks how many leading characters matched via
   timing. timingSafeEqual doesn't, and costs nothing here. */
function sigMatches(given, expected) {
  const a = Buffer.from(String(given), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

return items.map((item) => {
  const root = item.json || {};
  const query = root.query && typeof root.query === 'object' ? root.query : {};
  const body = root.body && typeof root.body === 'object' ? root.body : {};
  const params = root.params && typeof root.params === 'object' ? root.params : {};
  const src = {
    ...root,
    ...query,
    ...body,
    ...params
  };

  const rid = String(src.rid || src.requestId || src.request_id || src.id || '').trim();
  const action = String(src.action || '').trim();
  const exp = Number(src.exp || 0);
  const sig = String(src.sig || '').trim();

  const now = Math.floor(Date.now() / 1000);

  /* Every one of these is required. The previous version treated a missing
     signature as "unsigned, therefore fine", which meant stripping the sig
     parameter — or the exp with it — turned any guessed rid into a valid,
     non-expiring decision link. */
  let reason = 'ok';

  if (!rid || !action) {
    reason = 'missing-params';
  } else if (!sig) {
    reason = 'missing-signature';
  } else if (!exp) {
    reason = 'missing-expiry';
  } else if (exp < now) {
    reason = 'expired';
  } else if (!sigMatches(sig, buildExpected(rid, action, exp))) {
    reason = 'bad-signature';
  }

  const valid = reason === 'ok';

  return {
    json: {
      valid,
      reason,
      rid,
      action,
      exp,
      sig,
      estimate: String(src.estimate || '').trim(),
      note: String(src.note || '').trim()
    }
  };
});
