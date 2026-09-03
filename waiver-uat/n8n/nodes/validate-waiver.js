/**
 * n8n Code node — "Validate waiver"
 * Mode: Run Once for All Items
 *
 * Sits between the Turnstile check and "Prep metadata". Everything upstream of
 * this node establishes that the *caller* is legitimate (Header Auth proves the
 * request came through our nginx proxy; Turnstile proves a human solved a
 * challenge). This node is the first one that asks whether the *payload* is
 * legitimate.
 *
 * That distinction matters because of what happens downstream: prep-metadata
 * inlines `licenseImage`, `signature` and `guardianSignature` straight into an
 * HTML document that gets rendered to a PDF. An attacker who gets a crafted
 * string into one of those fields is writing markup into a renderer. So the
 * image fields are checked for shape, not merely for presence.
 *
 * Returns one item: { valid, reason, body }. Wire the output into an IF node on
 * `valid`; the false branch should respond 400 and stop. `reason` is for the
 * n8n execution log — do not surface it to the client, it describes internals.
 *
 * Conventions follow waymaker-booking/n8n/nodes/verify-booking-token.js: an
 * ordered ladder of cheap checks before expensive ones, a single `reason`
 * string, and a fail-closed default.
 */

// Every key the two waiver forms can legitimately produce. Anything else is a
// sign the payload was not built by our page, so it is rejected rather than
// passed through — an unknown key that reaches the Sheet append becomes a
// column nobody expected.
//
// Derived from the name= attributes in tattoo-waiver.html and
// piercing-waiver.html plus the four keys waymaker-forms.js adds at submit
// time. Adding a field to a form means adding it here.
const ALLOWED_KEYS = new Set([
  // Client
  'firstName', 'lastName', 'dob', 'age', 'ageStatus', 'email', 'phone',
  'address', 'city', 'state', 'zip',
  // Guardian (piercing form, minors)
  'guardianName', 'guardianRelationship', 'guardianEmail', 'guardianPhone',
  'guardianAddress', 'guardianCity', 'guardianState', 'guardianZip',
  'guardianSignature', 'guardianSignDate', 'guardianElectronicConsent',
  // Procedure
  'artistUsed', 'piercerUsed', 'bodyLocation', 'jewelryType',
  'knownConditions', 'procedureDate',
  // Signing
  'signature', 'clientSignature', 'signDate', 'printNameAgreement',
  'electronicConsent',
  // `license` is the raw file input. Its value is discarded by the browser —
  // the downscaled copy travels in licenseImage — but the key is still emitted
  // by FormData, so it has to be allowed or every submission would fail.
  'license', 'licenseImage',
  // Added by waymaker-forms.js at submit time
  'provisions', 'formType', 'signedAt',
  // Honeypot + Turnstile token
  'company', 'cf-turnstile-response',
]);

const IMAGE_FIELDS = ['signature', 'clientSignature', 'guardianSignature', 'licenseImage'];

// Data-URL prefix. The canvas produces image/png for signatures and image/jpeg
// for the downscaled licence photo; nothing else is ever legitimate here.
const DATA_URL = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/]+=*$/;

// Per-field decoded ceiling. The licence photo is capped client-side at a
// 1400px long edge and JPEG q0.85, which lands well under 1 MB; signatures are
// a few tens of KB. 2 MB is headroom for an unusually large phone photo, not a
// target. nginx already refuses the whole request over 4 MB.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const MAX_PROVISIONS = 40;
const FORM_TYPES = new Set(['tattoo-waiver', 'piercing-waiver']);

// base64 decodes to 3 bytes per 4 characters, less any padding.
function decodedBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

const item = $input.first();
const body = (item && item.json && (item.json.body || item.json)) || {};

let reason = '';

if (typeof body !== 'object' || Array.isArray(body)) {
  reason = 'body-not-an-object';
} else if (String(body.company || '').trim()) {
  // Honeypot. A real client never sees this field, so anything in it means an
  // automated submission.
  //
  // Note this check lives HERE and not in the browser. The booking form checks
  // its honeypot client-side and deletes the field before POSTing, so its
  // server-side check sees nothing and a bot skipping the page entirely is
  // unfiltered — see waymaker-booking/n8n/BUILD-SHEET.md. The waiver form
  // forwards the field untouched and lets this node decide.
  reason = 'honeypot';
} else if (!FORM_TYPES.has(String(body.formType || ''))) {
  reason = 'bad-form-type';
} else if (!Array.isArray(body.provisions)) {
  reason = 'provisions-not-an-array';
} else if (body.provisions.length > MAX_PROVISIONS) {
  reason = 'too-many-provisions';
}

// Unknown keys. Cheap, and a strong signal the payload was hand-built.
if (!reason) {
  const unknown = Object.keys(body).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknown.length) reason = `unknown-keys:${unknown.slice(0, 5).join(',')}`;
}

// Image shape. Empty is allowed at this layer — which fields are *required*
// depends on the form and on whether a guardian is involved, and that rule
// already lives in waymaker-forms.js. This node's job is narrower: if a value
// is present, it must be a real image data URL of a sane size.
if (!reason) {
  for (const field of IMAGE_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !DATA_URL.test(value)) {
      reason = `bad-image:${field}`;
      break;
    }
    if (decodedBytes(value) > MAX_IMAGE_BYTES) {
      reason = `image-too-large:${field}`;
      break;
    }
  }
}

// A waiver with no signature at all is not a waiver. Checked after the shape
// tests so a malformed signature reports as malformed rather than as missing.
if (!reason && !String(body.signature || body.clientSignature || '').trim()) {
  reason = 'missing-signature';
}

const valid = reason === '';

// Drop the honeypot and the Turnstile token before anything downstream sees
// them. Neither belongs in the PDF or the Sheet, and the token is single-use
// and already spent by the time we get here.
let clean = {};
if (valid) {
  clean = { ...body };
  delete clean.company;
  delete clean['cf-turnstile-response'];
  delete clean.license;
}

return [{ json: { valid, reason, body: clean } }];
