-- ==========================================================================
-- WayMaker Ink — booking schema
--
-- Replaces the Google Sheet (`Request Queue`) and the Drive folder tree with
-- Postgres + Storage. Everything the sheet held is here, plus the three things
-- a sheet could not hold: a foreign key to the artist, per-request image rows,
-- and an audit trail of who decided what.
--
-- ⚠ Values changed shape on the way over. The sheet stored what a person
-- reads; this stores what code branches on, and the portal renders the label.
--
--   sheet                     here
--   ------------------------  ----------------------------------------------
--   status  'LINK SENT'       status  'LINK_SENT'      (no spaces, ever)
--   service 'Piercing'        service 'piercing'       (lowercase machine key)
--   firstTattoo 'No'          first_time false         (real boolean)
--   minorAge '12'             minor_age 12             (real integer)
--   tierSent 'tier3'          tier_sent 'tier3'        (unchanged — it is a key)
--
-- The Edge Function does that normalising at the door, so the form keeps
-- submitting the human-readable strings it submits today.
-- ==========================================================================


-- ---------------------------------------------------------------- artists ---
-- Was the ARTISTS map hardcoded in three places: nodes/intake.js (authority),
-- nodes/review-page.js (re-derives the price), public/app.js (advisory). One
-- row per artist here, and the rate lives in exactly one place.
--
-- `services` is still authoritative: a piercing filed against an artist who
-- does not pierce is refused at intake, for the same reason it was before —
-- it would otherwise land against someone who cannot fulfil it.
create table public.artists (
  key           text primary key,
  name          text        not null,
  email         text        not null,
  hourly_rate   numeric(8,2) not null check (hourly_rate > 0),
  services      text[]      not null default '{tattoo}',
  enabled       boolean     not null default false,
  sort          smallint    not null default 100,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Every entry has to be a service this schema knows how to price and render.
  -- A typo'd 'peircing' would silently give an artist no panels at all.
  constraint artists_services_known check (
    services <@ array['tattoo', 'piercing', 'touchup']::text[]
    and array_length(services, 1) >= 1
  )
);

comment on column public.artists.services is
  'Authoritative. public/app.js carries a copy, but that file is served to the '
  'client and is therefore advisory — a forged POST need not respect it.';


-- ----------------------------------------------------------- service tiers ---
-- One row per bookable thing an artist offers. Replaces THREE separate
-- hardcoded structures that had to be kept in step by hand:
--
--   TIERS            in nodes/intake.js   (labels and hours)
--   BOOKING_LINKS    in nodes/commit.js   (Acuity URLs, per artist)
--   the rate maths   in nodes/review-page.js AND nodes/intake.js
--
-- Price is `hours * artist.hourly_rate` when `hours` is set, `flat_price` when
-- that is set instead, and quote-on-request when both are null.
--
-- ⚠ `flat_price` 0 is a free appointment. NULL is "no price yet". money(null)
-- rendering as "$0" is how a client gets mailed a free tattoo, so every
-- consumer has to tell the two apart — hence a nullable numeric rather than a
-- default of 0.
create table public.service_tiers (
  id            uuid primary key default gen_random_uuid(),
  artist_key    text        not null references public.artists(key) on delete cascade,
  service       text        not null check (service in ('tattoo', 'piercing', 'touchup')),

  -- Written to requests.tier_sent, and what the portal posts back when the
  -- artist picks one. 'tier1'…'tier5' for tattoos, 'pierce' for a piercing,
  -- 'touchup30'/'touchup60' for a touch up. A distinct key per service keeps a
  -- mis-routed choice failing loudly instead of resolving to a tattoo
  -- appointment type in Acuity.
  tier_key      text        not null,
  label         text        not null,

  hours         numeric(4,2) check (hours is null or hours > 0),
  flat_price    numeric(8,2) check (flat_price is null or flat_price >= 0),

  -- The payload of the whole system. Nullable so a tier can exist before its
  -- Acuity appointment type does; `respond` refuses to send with it unset
  -- rather than mailing a client a button that goes nowhere.
  acuity_url    text,

  sort          smallint    not null default 100,
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (artist_key, service, tier_key),

  -- Priced by the clock or by the menu, never by both — two prices for one
  -- button is a silent disagreement waiting to be quoted at a client.
  constraint service_tiers_one_pricing_rule check (
    hours is null or flat_price is null
  )
);

create index service_tiers_lookup on public.service_tiers (artist_key, service, active);


-- --------------------------------------------------------- piercing prices ---
-- Transcribed from the shop's printed menu. Was PIERCING_PRICES in
-- nodes/intake.js, with PIERCING_PAIRS in public/app.js as a second, partial
-- copy that only decided whether a chip was selectable.
--
-- Piercing price is a function of type and count, not of the artist — which is
-- why it is here and not in service_tiers. The artist approves a number rather
-- than picking one.
--
-- `pair_price is null` means single-only. The form must not offer Pair for
-- that type, and intake refuses one that arrives anyway rather than inventing
-- a price.
create table public.piercing_prices (
  piercing_type text primary key,
  single_price  numeric(8,2) not null check (single_price >= 0),
  pair_price    numeric(8,2) check (pair_price is null or pair_price >= 0),
  body_area     text not null check (body_area in ('ear', 'face', 'body')),
  sort          smallint not null default 100,
  active        boolean  not null default true,
  updated_at    timestamptz not null default now()
);


-- --------------------------------------------------------------- requests ---
-- One row per submitted request. Column-for-column the sheet, minus the three
-- Drive/Sheets artefacts (driveFolder, referenceCount, pageUrl stays), plus
-- the touch-up block and a real decision audit.
create table public.requests (
  id            uuid primary key default gen_random_uuid(),

  -- The human-facing id, minted by the form so a submission that times out and
  -- is retried lands as ONE row. The unique constraint is what enforces that —
  -- intake turns a conflict into a 200, not a second row. The sheet had no way
  -- to do this and duplicate rows were the result.
  rid           text        not null unique,

  status        text        not null default 'NEW'
                  check (status in ('NEW', 'LINK_SENT', 'DECLINED', 'BOOKED')),
  service       text        not null check (service in ('tattoo', 'piercing', 'touchup')),
  artist_key    text        not null references public.artists(key),

  -- --- the client we email -------------------------------------------------
  first_name    text not null,
  last_name     text not null,
  email         text not null,
  phone         text not null default '',

  -- Asked on every service. For a tattoo it is the 18+ gate's answer; for a
  -- piercing it opens the guardian block below.
  client_is_minor boolean not null default false,

  -- Was `firstTattoo` in the sheet and is still labelled per service on the
  -- form ("first tattoo" / "first piercing"). One column, because the answer
  -- means the same thing either way and two would have to be joined to count.
  first_time    boolean not null default false,

  heard_from    text not null default 'Not given',
  -- A person's name when heard_from names a referral source, a free-text
  -- description when it was 'Other'. heard_from is what tells the two apart —
  -- count without filtering on it and the "Other" rows land in the referral
  -- leaderboard as people who do not exist.
  referred_by   text not null default '',

  -- --- tattoo --------------------------------------------------------------
  -- ⚠ '' means "not applicable to this service". NULL means the question was
  -- asked and skipped. The two have to be tellable apart: a blank `size` on a
  -- piercing row is correct, a blank one on a tattoo row is a bug.
  idea          text not null default '',
  placement     text not null default '',
  size          text not null default '',
  style         text not null default '',

  -- --- piercing ------------------------------------------------------------
  piercing_type  text not null default '',
  piercing_count text not null default '' check (piercing_count in ('', 'Single', 'Pair')),
  piercing_side  text not null default '',
  jewelry        text not null default '',
  piercing_notes text not null default '',

  -- --- touch up ------------------------------------------------------------
  -- New in this build. A touch-up is its own service rather than a flag on a
  -- tattoo: it has its own Acuity appointment types, its own (shorter) session
  -- lengths, and the artist's first question is about work that already
  -- exists, not about an idea.
  touchup_placement text not null default '',
  touchup_age       text not null default '',
  -- 'Yes' / 'No' / 'Not sure' — whether WayMaker did the original. It changes
  -- the answer, not just the record: shops price and accept other people's
  -- work differently.
  touchup_by_us     text not null default '' check (touchup_by_us in ('', 'Yes', 'No', 'Not sure')),
  touchup_details   text not null default '',

  -- --- the minor being pierced ---------------------------------------------
  -- Deliberately separate from the client columns above. The client is the
  -- adult we email; these are the person on the table. Collapsing them is how
  -- an estimate ends up addressed to a twelve-year-old.
  minor_first_name      text not null default '',
  minor_last_name       text not null default '',
  minor_age             smallint check (minor_age is null or (minor_age >= 0 and minor_age < 18)),
  guardian_relationship text not null default '',
  guardian_consent      boolean not null default false,

  -- --- what the client asked for, priced at intake -------------------------
  -- The suggested number, computed once at submission from the tables above so
  -- the portal shows the artist a figure rather than a blank box. NULL is
  -- quote-on-request — a custom piercing, or a touch up. Not 0.
  quoted_price  numeric(8,2),
  quote_label   text not null default '',

  -- --- meta ----------------------------------------------------------------
  submitted_at  timestamptz not null default now(),
  page_url      text not null default '',
  reference_count smallint not null default 0,

  -- --- the decision, written by the portal ---------------------------------
  tier_sent     text,
  -- The human-readable estimate the artist actually approved or edited
  -- ("3 hr · $375"). Kept apart from tier_sent, which is the machine key that
  -- resolves to an Acuity URL.
  estimate      text not null default '',
  artist_note   text not null default '',
  decided_at    timestamptz,
  decided_by    uuid references auth.users(id) on delete set null,
  -- Snapshotted rather than looked up on read: service_tiers.acuity_url can be
  -- edited afterwards, and what the client was actually sent must not change
  -- underneath the record of having sent it.
  booking_url   text not null default '',

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A decided row has to carry its decision. Catches a partial write from a
  -- respond call that failed halfway rather than leaving a row that reads
  -- "LINK_SENT" with nothing sent.
  constraint requests_decided_has_decision check (
    status in ('NEW', 'BOOKED')
    or (decided_at is not null and (status = 'DECLINED' or tier_sent is not null))
  )
);

-- The portal's default view: newest undecided first, per artist.
create index requests_queue on public.requests (status, submitted_at desc);
create index requests_by_artist on public.requests (artist_key, status, submitted_at desc);
create index requests_by_email on public.requests (lower(email));


-- ---------------------------------------------------------- request images ---
-- Was a Drive folder and a `referenceCount` integer. One row per image, so the
-- portal can render them in order and a failed upload is visible as a missing
-- row rather than as a count that does not match the folder.
create table public.request_images (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.requests(id) on delete cascade,
  -- Path within the `request-refs` bucket, e.g. 'WMI-ABC123/reference-1.jpg'.
  -- The bucket is private; the portal mints a short-lived signed URL per view.
  storage_path text not null unique,
  ordinal     smallint not null,
  byte_size   integer,
  content_type text not null default 'image/jpeg',
  created_at  timestamptz not null default now(),

  unique (request_id, ordinal)
);

create index request_images_by_request on public.request_images (request_id, ordinal);


-- ---------------------------------------------------------------- profiles ---
-- Supabase Auth holds the credentials; this holds what the person is allowed
-- to see. Created by a trigger on signup so a user can never exist without one
-- — an authenticated user with no profile row would pass `authenticated` and
-- fail every policy, which reads as "the portal is broken" rather than as
-- "you have no access".
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role        text not null default 'artist' check (role in ('artist', 'admin')),
  -- Which artist this person IS. NULL for an admin who is not an artist.
  -- An 'artist' row with a null artist_key sees nothing, which is the correct
  -- failure for a half-configured account.
  artist_key  text references public.artists(key) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);


-- ------------------------------------------------------------ audit trail ---
-- Every state change, append-only. The sheet had `decidedAt` and nothing else,
-- so "why does this say DECLINED when I sent a link" had no answer.
create table public.request_events (
  id          bigserial primary key,
  request_id  uuid not null references public.requests(id) on delete cascade,
  event       text not null,           -- 'created' | 'responded' | 'declined' | 'booked' | 'note'
  actor       uuid references auth.users(id) on delete set null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index request_events_by_request on public.request_events (request_id, created_at desc);


-- --------------------------------------------------------------- updated_at ---
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger artists_touch        before update on public.artists        for each row execute function public.touch_updated_at();
create trigger service_tiers_touch  before update on public.service_tiers  for each row execute function public.touch_updated_at();
create trigger requests_touch       before update on public.requests       for each row execute function public.touch_updated_at();
create trigger profiles_touch       before update on public.profiles       for each row execute function public.touch_updated_at();


-- ------------------------------------------------------- profile on signup ---
-- SECURITY DEFINER because it writes public.profiles from an auth trigger,
-- where the executing role has no rights on that table.
--
-- `search_path` pinned for the same reason every SECURITY DEFINER function
-- here pins it: without it, a schema earlier on the caller's search_path can
-- shadow `profiles` and the function writes somewhere else entirely.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
