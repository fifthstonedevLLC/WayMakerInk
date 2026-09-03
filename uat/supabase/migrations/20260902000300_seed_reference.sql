-- ==========================================================================
-- WayMaker Ink — reference data
--
-- The three hardcoded maps, lifted out of the n8n Code nodes and made rows.
-- Idempotent: every statement is an upsert, so re-running the migration
-- against a database that already holds edits does not clobber them back to
-- these values — it only reasserts the keys.
--
-- ⚠ This is the UAT seed. `artists.email` carries the test address on purpose;
-- production's copy of this migration carries the real ones and must not be
-- pasted from here.
-- ==========================================================================


-- ---------------------------------------------------------------- artists ---
-- Rates from WM_ARTIST_*_RATE. Both artists are live in production today, so
-- `enabled` is true for both here as well — UAT is where a switch gets turned
-- on early, not where it gets turned off.
insert into public.artists (key, name, email, hourly_rate, services, enabled, sort) values
  ('nic',    'Nic Sinnwell', 'phil.harberts@fifthstonedev.com', 125.00, array['tattoo', 'touchup'],             true, 10),
  ('laynie', 'Laynie Joy',   'phil.harberts@fifthstonedev.com', 100.00, array['tattoo', 'piercing', 'touchup'], true, 20)
on conflict (key) do update
  set name = excluded.name,
      hourly_rate = excluded.hourly_rate,
      services = excluded.services,
      sort = excluded.sort;


-- ---------------------------------------------------- tattoo session tiers ---
-- The five session lengths, unchanged: 1, 2, 3, 4 hours and All Day at 7.
-- No all-day discount — 7 × $125 is the $875 the buttons have always shown. If
-- one is ever wanted it belongs in `flat_price` on that single row, which is
-- exactly what the two-pricing-rules constraint is for.
--
-- ⚠ Each artist has their OWN five Acuity appointment type IDs. They are not
-- shared. An earlier version of nodes/commit.js had Laynie pointing at Nic's
-- five, which would have booked her clients onto his calendar. Do not
-- "simplify" these into one shared set.
insert into public.service_tiers (artist_key, service, tier_key, label, hours, acuity_url, sort) values
  ('nic', 'tattoo', 'tier1', '1 hr',            1, 'https://waymakerink.as.me/?appointmentType=94784680', 10),
  ('nic', 'tattoo', 'tier2', '2 hr',            2, 'https://waymakerink.as.me/?appointmentType=96303330', 20),
  ('nic', 'tattoo', 'tier3', '3 hr',            3, 'https://waymakerink.as.me/?appointmentType=96303759', 30),
  ('nic', 'tattoo', 'tier4', '4 hr',            4, 'https://waymakerink.as.me/?appointmentType=96303791', 40),
  ('nic', 'tattoo', 'tier5', 'All Day · 7 hr',  7, 'https://waymakerink.as.me/?appointmentType=96347556', 50),

  ('laynie', 'tattoo', 'tier1', '1 hr',           1, 'https://waymakerink.as.me/?appointmentType=96954072', 10),
  ('laynie', 'tattoo', 'tier2', '2 hr',           2, 'https://waymakerink.as.me/?appointmentType=96954082', 20),
  ('laynie', 'tattoo', 'tier3', '3 hr',           3, 'https://waymakerink.as.me/?appointmentType=96954089', 30),
  ('laynie', 'tattoo', 'tier4', '4 hr',           4, 'https://waymakerink.as.me/?appointmentType=96954098', 40),
  ('laynie', 'tattoo', 'tier5', 'All Day · 7 hr', 7, 'https://waymakerink.as.me/?appointmentType=96954102', 50)
on conflict (artist_key, service, tier_key) do update
  set label = excluded.label,
      hours = excluded.hours,
      sort  = excluded.sort;
      -- acuity_url deliberately NOT overwritten: once a type is corrected in
      -- the database it stays corrected, and a stale literal in this file
      -- should not silently win on the next migration run.


-- ------------------------------------------------------------ piercing tier ---
-- One bookable thing, priced from piercing_prices rather than from hours — the
-- artist's rate does not feed a piercing at all. 30 minutes in Acuity.
--
-- Laynie only: she is the only artist whose `services` includes piercing, and
-- the tier list is what the portal renders for a request, so a row here for
-- Nic would offer an appointment type he cannot fulfil.
insert into public.service_tiers (artist_key, service, tier_key, label, hours, flat_price, acuity_url, sort) values
  ('laynie', 'piercing', 'pierce', 'Piercing appointment', null, null,
   'https://waymakerink.as.me/?appointmentType=97682822', 10)
on conflict (artist_key, service, tier_key) do nothing;

-- ⚠ `do nothing` above means this URL lands on a FRESH project only. On a
-- database that already holds the row — including one seeded before the Acuity
-- type existed — the insert is skipped and acuity_url stays NULL, so the portal
-- goes on greying the tier out. Same reasoning as the tattoo block: a literal
-- in this file must never silently overwrite a value corrected in the
-- database. Backfilling the one case where NULL is not a correction:
update public.service_tiers
   set acuity_url = 'https://waymakerink.as.me/?appointmentType=97682822'
 where artist_key = 'laynie'
   and service = 'piercing'
   and tier_key = 'pierce'
   and (acuity_url is null or acuity_url = '');


-- ------------------------------------------------------------ touch-up tiers ---
-- New service. Priced off the hourly rate like a tattoo, at the two lengths a
-- touch-up actually takes — most are well under an hour, and offering the
-- 4-hour and All Day tiers here would only invite a misbooking.
--
-- ⚠ Both acuity_url values are NULL: the Acuity appointment types do not exist
-- yet. Creating them is a checklist item in PORTAL-INITIATIVE.md, not a code
-- change — set the URL on the row and touch-ups become sendable.
insert into public.service_tiers (artist_key, service, tier_key, label, hours, acuity_url, sort) values
  ('nic',    'touchup', 'touchup30', 'Touch up · 30 min', 0.5, null, 10),
  ('nic',    'touchup', 'touchup60', 'Touch up · 1 hr',   1.0, null, 20),
  ('laynie', 'touchup', 'touchup30', 'Touch up · 30 min', 0.5, null, 10),
  ('laynie', 'touchup', 'touchup60', 'Touch up · 1 hr',   1.0, null, 20)
on conflict (artist_key, service, tier_key) do nothing;


-- -------------------------------------------------------- the piercing menu ---
-- Transcribed from the shop's framed price list, which is what a client
-- compares the site against. Four piercings Laynie does not perform were
-- removed from the picker in PIERCING-BUILD 1.3a; their absence here is the
-- whole of the "we don't do that" rule.
--
-- `pair_price` NULL = single only. The form greys the Pair chip for these, and
-- intake refuses a Pair that arrives anyway rather than inventing a price.
insert into public.piercing_prices (piercing_type, single_price, pair_price, body_area, sort) values
  ('Basic Lobe',    30, 50,   'ear',  10),
  ('Helix',         45, 75,   'ear',  20),
  ('Forward Helix', 55, null, 'ear',  30),
  ('Rook',          55, null, 'ear',  40),
  ('Daith',         65, null, 'ear',  50),
  ('Tragus',        55, null, 'ear',  60),
  ('Anti-tragus',   55, null, 'ear',  70),
  ('Conch',         45, null, 'ear',  80),
  ('Basic Eyebrow', 45, null, 'face', 90),
  ('Nose',          45, 75,   'face', 100),
  ('Lip',           45, 75,   'face', 110),
  ('Bellybutton',   50, null, 'body', 120)
on conflict (piercing_type) do update
  set single_price = excluded.single_price,
      pair_price   = excluded.pair_price,
      body_area    = excluded.body_area,
      sort         = excluded.sort,
      active       = true;
