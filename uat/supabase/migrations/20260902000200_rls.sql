-- ==========================================================================
-- WayMaker Ink — row level security
--
-- The governing rule: **`anon` can do nothing, anywhere.** The booking form
-- holds no key and talks to no table. It POSTs to the `intake` Edge Function,
-- which runs with the service_role key server-side and bypasses everything
-- here. That is the whole reason intake is a function and not a direct insert
-- with an insert-only policy — a public anon key on the form page is a write
-- endpoint that anyone can point a script at, and no RLS policy can tell a
-- real submission from a scripted one.
--
-- `authenticated` is Nic and Laynie in the portal. They READ. Every write goes
-- through the `respond` function, which re-checks the caller's JWT and then
-- writes as service_role — so a status transition, its audit row and the n8n
-- call cannot half-happen because a client-side policy let one of the three
-- through.
--
-- ⚠ RLS is default-deny only once it is ENABLED. A table created without the
-- `enable row level security` line below is world-readable to anyone holding
-- the anon key. Every new table needs a line here, and the check at the bottom
-- of this file fails the migration if one is missed.
-- ==========================================================================

alter table public.artists         enable row level security;
alter table public.service_tiers   enable row level security;
alter table public.piercing_prices enable row level security;
alter table public.requests        enable row level security;
alter table public.request_images  enable row level security;
alter table public.profiles        enable row level security;
alter table public.request_events  enable row level security;


-- ---------------------------------------------------------------- helpers ---
-- SECURITY DEFINER so the policy can read `profiles` without the caller having
-- a policy on `profiles` that would itself need to read `profiles` — that
-- recursion is the classic way an RLS setup deadlocks into "permission denied"
-- on every query.
--
-- STABLE, not VOLATILE: Postgres may then evaluate it once per statement
-- instead of once per row, which is the difference between a fast queue page
-- and a sequential scan calling a function 400 times.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid());
$$;

-- Scope. Today both artists are also both admins — a two-person shop wants to
-- see each other's queue — but the scoping is built in rather than bolted on
-- later, so tightening it is one UPDATE on `profiles`, not a migration.
create or replace function public.can_see_artist(k text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.role = 'admin' or p.artist_key = k)
  );
$$;

revoke execute on function public.is_staff() from anon;
revoke execute on function public.can_see_artist(text) from anon;


-- ------------------------------------------------------- reference tables ---
-- The portal needs the tier list and its prices to render the picker, and the
-- artist list to render names. None of it is sensitive except one column.
--
-- ⚠ `artists.email` is NOT public. It is an address on a page that a logged-in
-- user can read, which is fine; it must never be reachable with the anon key.
-- The policies below are `to authenticated`, so it is not.
create policy "staff read artists" on public.artists
  for select to authenticated using (public.is_staff());

create policy "staff read tiers" on public.service_tiers
  for select to authenticated using (public.is_staff());

create policy "staff read piercing prices" on public.piercing_prices
  for select to authenticated using (public.is_staff());


-- --------------------------------------------------------------- profiles ---
-- Own row only. The portal reads it once at login to learn role and
-- artist_key; nobody needs to enumerate the staff list.
create policy "read own profile" on public.profiles
  for select to authenticated using (id = auth.uid());

-- display_name is the one field a person may change about themselves. Role and
-- artist_key are deliberately not writable here — a user who can grant
-- themselves `role = 'admin'` has just granted themselves every other artist's
-- client list. The USING/WITH CHECK pair pins them to their current values.
create policy "update own display name" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select p.role from public.profiles p where p.id = auth.uid())
    and artist_key is not distinct from (select p.artist_key from public.profiles p where p.id = auth.uid())
  );


-- --------------------------------------------------------------- requests ---
-- Read only, and scoped. No insert policy: intake is a function.
-- No update policy: respond is a function. No delete policy either — and that
-- is still true, but it no longer means requests cannot be deleted.
--
-- ⚠ The `delete-request` function removes them, as service_role, after
-- checking the caller can see the row through THIS policy. Deleting stayed off
-- RLS on purpose: a delete policy would make `.delete()` available to every
-- query the portal can build, and the browser holds an anon key. Routing it
-- through a function keeps the one irreversible operation in the system behind
-- something that can be read, reasoned about, and revoked in one place.
--
-- What the original note said still holds as a warning rather than as a
-- guarantee: a client request is a business record, the delete cascades the
-- audit trail away with it, and there is nothing to restore from.
create policy "staff read requests" on public.requests
  for select to authenticated using (public.can_see_artist(artist_key));

create policy "staff read request images" on public.request_images
  for select to authenticated using (
    exists (
      select 1 from public.requests r
      where r.id = request_images.request_id
        and public.can_see_artist(r.artist_key)
    )
  );

create policy "staff read request events" on public.request_events
  for select to authenticated using (
    exists (
      select 1 from public.requests r
      where r.id = request_events.request_id
        and public.can_see_artist(r.artist_key)
    )
  );


-- ---------------------------------------------------------------- storage ---
-- Private bucket. `public = false` means an object URL is a 400 without a
-- token — the portal calls createSignedUrl() per view and the link expires.
--
-- ⚠ Making this bucket public would put every client's reference photos on a
-- guessable URL. The paths are `<rid>/reference-1.jpg` and rids are visible in
-- any artist's inbox.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'request-refs',
  'request-refs',
  false,
  10485760,                                    -- 10 MB; the form resizes to ~1600px first
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Reads are scoped the same way the rows are: the first path segment is the
-- rid, and the request that owns it decides who may look.
--
-- `storage.foldername(name)` returns the path segments as an array, and
-- Postgres arrays are 1-indexed — so [1] is the rid in `WMI-ABC123/ref-1.jpg`.
--
-- Uploads have no policy — intake writes them as service_role. A logged-in
-- artist cannot add an image to a client's request, which is correct: the
-- reference photos are what the client actually sent.
--
-- ⚠ `storage.objects` is owned by `supabase_storage_admin`, not by the role
-- that runs migrations. This normally succeeds because `postgres` is a member
-- of that role, but on a project where it is not, `db push` fails here with
-- "must be owner of table objects". If that happens, run this one statement
-- from the dashboard SQL editor instead and comment it out here — everything
-- above it has already applied.
create policy "staff read request refs" on storage.objects
  for select to authenticated using (
    bucket_id = 'request-refs'
    and exists (
      select 1 from public.requests r
      where r.rid = (storage.foldername(name))[1]
        and public.can_see_artist(r.artist_key)
    )
  );


-- ------------------------------------------------------------- belt check ---
-- Fails the migration if a table in `public` ever ships without RLS enabled.
-- Cheap here; expensive to discover from a leaked client list.
do $$
declare
  unprotected text;
begin
  select string_agg(c.relname, ', ')
    into unprotected
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;

  if unprotected is not null then
    raise exception 'Tables in public without RLS enabled: %', unprotected;
  end if;
end;
$$;
