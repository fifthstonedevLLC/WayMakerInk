/* ==========================================================================
   Form payload → `requests` row.

   This is the port of nodes/intake.js, minus the link signing and the tier
   pricing that only existed to build five buttons in an email. The portal is
   the review surface now, so a request no longer has to arrive pre-priced —
   it arrives normalised and validated, and the artist prices it on screen.

   What survived unchanged, and why:

     · The artist/service check throws. public/app.js carries its own copy of
       `services`, but that file is served to the client and is therefore
       advisory — a forged POST does not have to respect it. A piercing filed
       against an artist who does not pierce must fail here, loudly.

     · '' means "not applicable to this service"; 'Not given' means the
       question was asked and skipped. A blank `size` on a piercing row is
       correct; a blank one on a tattoo row is a bug, and the two have to be
       tellable apart in the portal.

     · The piercing price table is authoritative and lives in the database.
       An unrecognised type is a forged POST or a picker that drifted, and both
       are worse quoted at $0 than refused at the door.
   ========================================================================== */
import { BadRequest } from './http.ts';

export type Artist = {
  key: string;
  name: string;
  email: string;
  hourly_rate: number;
  services: string[];
  enabled: boolean;
};

export type PiercingPrice = {
  piercing_type: string;
  single_price: number;
  pair_price: number | null;
};

/* The form submits what a person reads; the database stores what code branches
   on. One place does the translation, and it is this map. */
const SERVICES: Record<string, string> = {
  'tattoo': 'tattoo',
  'piercing': 'piercing',
  'touch up': 'touchup',
  'touchup': 'touchup',
  'touch-up': 'touchup'
};

/* The one picker option with no price behind it, by design — the menu invites
   it: "if you don't see your vision listed, just ask!". Held as one literal
   because the form, this file and the portal all have to agree on it. */
export const PIERCING_CUSTOM = "Something else — I'll describe it";

/* Must match the CHECK constraint on requests.touchup_by_us character for
   character, and the <option value> attributes in public/index.html. */
const TOUCHUP_BY_US = ['Yes', 'No', 'Not sure'];

export const money = (n: number): string =>
  '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

const str = (form: FormData, key: string): string =>
  String(form.get(key) ?? '').trim();

/* Interior whitespace collapsed so "Jane  Doe" and "Jane Doe" land in the same
   bucket when the artist counts referral sources. It does NOT reconcile "Jane"
   against "Jane Doe" — expect some hand-tidying. */
const squish = (v: string): string => v.replace(/\s+/g, ' ').trim();

const yes = (form: FormData, key: string): boolean =>
  ['yes', 'true', 'on', '1'].includes(str(form, key).toLowerCase());

export function makeRid(): string {
  return 'WMI-' + Date.now().toString(36).toUpperCase() + '-' +
    Math.random().toString(36).slice(2, 8).toUpperCase();
}

/* Accepted from the form so a submission that times out and is retried lands
   as one row rather than two. Validated rather than trusted: it becomes a
   storage path segment, so a `../` or a slash in it would write outside the
   request's own folder. */
export function resolveRid(form: FormData): string {
  const given = str(form, 'rid');
  if (!given) return makeRid();
  if (!/^WMI-[A-Z0-9]{1,16}-[A-Z0-9]{1,16}$/.test(given)) {
    throw new BadRequest('That request id is not in a form we recognise.');
  }
  return given;
}

export function resolveService(form: FormData, artist: Artist): string {
  const raw = str(form, 'service').toLowerCase();

  /* Anything unrecognised is a tattoo, so a client with JS disabled posting
     the form natively behaves exactly as they do today. An empty value is the
     same case. */
  const service = SERVICES[raw] || 'tattoo';

  if (!artist.services.includes(service)) {
    throw new BadRequest(
      `${artist.name} does not currently take ${service === 'touchup' ? 'touch up' : service} requests.`
    );
  }
  return service;
}

/* Exactly one priced action, looked up rather than multiplied. The artist's
   hourly rate does not feed this at all: price is fully determined by type and
   count, both of which the client supplies, so the artist approves a number
   rather than picking one.

   ⚠ `price: null` is not `price: 0`. The custom path has NO price and every
   consumer has to tell that apart from a free piercing. */
export function quotePiercing(
  type: string,
  count: string,
  prices: PiercingPrice[]
): { price: number | null; label: string } {
  if (type === PIERCING_CUSTOM) {
    return { price: null, label: 'Quote on request' };
  }

  /* Told apart from an unrecognised type on purpose. Blank means the picker
     was never answered — a native form POST with JS disabled, or a forged one
     — and `Unknown piercing type ""` sends whoever reads the log hunting for a
     naming drift that isn't there. */
  if (!type) {
    throw new BadRequest('Please choose which piercing you\'d like.');
  }

  const row = prices.find((p) => p.piercing_type === type);
  if (!row) throw new BadRequest(`We don't have a price on file for "${type}".`);

  const isPair = count === 'Pair';
  if (isPair && row.pair_price === null) {
    throw new BadRequest(`"${type}" is only done singly.`);
  }

  const amount = isPair ? row.pair_price! : row.single_price;
  const label = isPair ? 'Pair' : 'Single';
  return { price: Number(amount), label: `${label} · ${money(Number(amount))}` };
}

/* The full row, ready to insert. Nothing here reaches the database that was
   not either validated above or defaulted to a value the schema accepts. */
export function buildRow(
  form: FormData,
  artist: Artist,
  service: string,
  rid: string,
  prices: PiercingPrice[]
) {
  const isTattoo = service === 'tattoo';
  const isPiercing = service === 'piercing';
  const isTouchup = service === 'touchup';

  const firstName = str(form, 'firstName');
  const lastName = str(form, 'lastName');
  const email = str(form, 'email');

  if (!firstName || !lastName) throw new BadRequest('Please give your first and last name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BadRequest('That email address does not look right.');
  }

  const clientIsMinor = str(form, 'clientIsMinor') === 'Yes';

  /* The one rule that is the law rather than a preference, restated
     server-side. The form hides the tattoo path for a minor; a POST that
     bypasses the form must still be refused. */
  if (clientIsMinor && (isTattoo || isTouchup)) {
    throw new BadRequest('We can\'t tattoo under 18. Piercings are available with a parent or legal guardian present.');
  }

  const piercingType = isPiercing ? str(form, 'piercingType') : '';

  /* Pinned to the CHECK constraint's vocabulary, like touchup_by_us below.
     Anything else is a forged POST — quotePiercing() would price it as a
     single and then the insert would fail the constraint, which reaches the
     client as a 500 and is retried three times for a payload that can never be
     accepted. Refuse it here, as a 4xx, once. */
  const rawCount = isPiercing ? (str(form, 'piercingCount') || 'Single') : '';
  if (isPiercing && rawCount !== 'Single' && rawCount !== 'Pair') {
    throw new BadRequest('Choose either a single piercing or a pair.');
  }
  const piercingCount = rawCount;

  if (isTattoo && !str(form, 'idea')) {
    throw new BadRequest('Please describe the tattoo you have in mind.');
  }
  if (isTouchup && !str(form, 'touchupDetails')) {
    throw new BadRequest('Please tell us what needs touching up.');
  }

  const quote = isPiercing
    ? quotePiercing(piercingType, piercingCount, prices)
    : { price: null, label: '' };

  /* Guardian consent is piercing-only — a minor cannot be tattooed at all, so
     there is no guardian branch on the other two services. */
  const guardianConsent = isPiercing && clientIsMinor && yes(form, 'guardianConsent');
  if (isPiercing && clientIsMinor && !guardianConsent) {
    throw new BadRequest('A parent or legal guardian has to consent before we can book this.');
  }

  const minorAgeRaw = isPiercing && clientIsMinor ? str(form, 'minorAge') : '';
  const minorAge = minorAgeRaw === '' ? null : Number.parseInt(minorAgeRaw, 10);
  if (minorAge !== null && (!Number.isInteger(minorAge) || minorAge < 0 || minorAge > 17)) {
    throw new BadRequest('Their age has to be a number under 18.');
  }

  return {
    row: {
      rid,
      status: 'NEW',
      service,
      artist_key: artist.key,

      first_name: firstName,
      last_name: lastName,
      email,
      phone: str(form, 'phone'),
      client_is_minor: clientIsMinor,
      first_time: str(form, 'firstTattoo') === 'Yes',

      /* 'Not given' rather than '' so a blank cell means "this row predates the
         field", not "they declined to say". The two need telling apart when
         the artist counts sources. */
      heard_from: str(form, 'heardFrom') || 'Not given',
      referred_by: squish(str(form, 'referredBy')),

      idea: isTattoo ? str(form, 'idea') : '',
      placement: isTattoo ? str(form, 'placement') : '',
      size: isTattoo ? str(form, 'size') : '',
      style: isTattoo ? (str(form, 'style') || 'Not sure yet') : '',

      piercing_type: piercingType,
      piercing_count: piercingCount,
      piercing_side: isPiercing ? str(form, 'piercingSide') : '',
      jewelry: isPiercing ? str(form, 'jewelry') : '',
      piercing_notes: isPiercing ? str(form, 'piercingNotes') : '',

      touchup_placement: isTouchup ? str(form, 'touchupPlacement') : '',
      touchup_age: isTouchup ? str(form, 'touchupAge') : '',
      /* Pinned to the CHECK constraint's vocabulary rather than passed
         through. An unrecognised value would otherwise fail on insert as a
         constraint violation — a 500 the client is told to retry, three times,
         for a payload that will never be accepted. */
      touchup_by_us: isTouchup && TOUCHUP_BY_US.includes(str(form, 'touchupByUs'))
        ? str(form, 'touchupByUs')
        : '',
      touchup_details: isTouchup ? str(form, 'touchupDetails') : '',

      minor_first_name: isPiercing && clientIsMinor ? str(form, 'minorFirstName') : '',
      minor_last_name: isPiercing && clientIsMinor ? str(form, 'minorLastName') : '',
      minor_age: minorAge,
      guardian_relationship: isPiercing && clientIsMinor ? str(form, 'guardianRelationship') : '',
      guardian_consent: guardianConsent,

      quoted_price: quote.price,
      quote_label: quote.label,

      submitted_at: str(form, 'submittedAt') || new Date().toISOString(),
      page_url: str(form, 'pageUrl'),
      reference_count: 0            /* corrected after the uploads settle */
    }
  };
}
