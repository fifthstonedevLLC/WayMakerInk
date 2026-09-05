-- ==========================================================================
-- WayMaker Ink — what is left after a request is deleted
--
-- Deleting a request destroys it: the row, its images, its files, and — via
-- `on delete cascade` on request_events — the entire audit trail of what was
-- decided and when. That is what "cannot be undone" means, and it is what was
-- asked for.
--
-- The cost is that the deletion itself becomes unauditable. A request that
-- existed on Tuesday and does not exist on Wednesday leaves nothing behind
-- saying it ever did, which makes "where did the Chen request go" a question
-- with no answer, and makes an accidental delete indistinguishable from a
-- request that was never submitted.
--
-- This table is the answer to that, and only to that.
--
-- ---------------------------------------------------------- what is NOT here
-- ⚠ No client data. No name, no email, no phone, no description, no photos,
-- no estimate. Keeping any of it would make "permanently deleted" a lie, and a
-- lie of exactly the kind a person is entitled to rely on when they ask for
-- their details to be removed.
--
-- What is here is the shape of the thing that was destroyed and who destroyed
-- it. Enough to answer "was there a request, whose was it, and who deleted
-- it". Not enough to reconstruct one line of what the client wrote.
--
-- `rid` is an opaque minted id, not personal data, and it is what an artist
-- would have in hand from an old email when they come asking.
-- ==========================================================================

create table public.request_tombstones (
  -- Not a foreign key: the request it names is gone, which is the point.
  rid              text primary key,

  -- Also deliberately not a foreign key onto artists(key). A tombstone has to
  -- outlive the artist row — an artist who leaves the shop should not take the
  -- record of their deletions with them.
  artist_key       text not null,

  service          text not null,
  -- The status at the moment of deletion. 'NEW' says nothing had been sent;
  -- 'LINK_SENT' says a client is holding a booking link for a request that no
  -- longer exists, which is the case worth being able to find later.
  status           text not null,

  submitted_at     timestamptz not null,
  reference_count  smallint    not null default 0,

  deleted_at       timestamptz not null default now(),
  -- Null if the account is removed later. The email below is captured as text
  -- for exactly that case — the record of who did it should not evaporate
  -- because they were offboarded.
  deleted_by       uuid references auth.users(id) on delete set null,
  deleted_by_email text        not null default ''
);

create index request_tombstones_by_artist
  on public.request_tombstones (artist_key, deleted_at desc);

comment on table public.request_tombstones is
  'Deliberately carries NO client data — only the shape of a deleted request '
  'and who deleted it. See 20260905000100 for why.';


-- ---------------------------------------------------------------------- RLS ---
-- The belt check in 20260902000200 fails the migration on any public table
-- without RLS. This one would sail past it — that check runs earlier — so it
-- is enabled here on purpose rather than by being caught.
alter table public.request_tombstones enable row level security;

-- Scoped exactly like requests: an artist sees their own deletions, an admin
-- sees both. No insert, update or delete policy at all — the function below is
-- the only writer, and nothing should ever edit or remove a tombstone. That is
-- the one property that makes it worth having.
create policy "staff read tombstones" on public.request_tombstones
  for select to authenticated using (public.can_see_artist(artist_key));


-- ------------------------------------------------------------ the deletion ---
-- Tombstone and delete in ONE statement, so they cannot come apart.
--
-- Doing this from the Edge Function as two calls has two failure modes and
-- both are bad: tombstone-then-delete can leave a "deleted" marker for a row
-- that still exists, and delete-then-tombstone can destroy a request and
-- record nothing. supabase-js cannot open a transaction, so the transaction
-- has to live here.
--
-- ⚠ SECURITY DEFINER, and it does NOT check permissions. It cannot: it is
-- called by the Edge Function through the service-role client, where
-- auth.uid() is null. The caller check happens in delete-request/index.ts,
-- which reads the row through the ARTIST's client first and only reaches this
-- if RLS returned it. Same split as respond: check as them, write as us.
--
-- Execute is revoked from PUBLIC below — not merely from anon and
-- authenticated — so the only way to reach it is through a function holding
-- the service-role key. Read that block before touching it.
create or replace function public.delete_request_permanently(
  p_rid            text,
  p_actor          uuid,
  p_actor_email    text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.requests%rowtype;
begin
  -- Locked for the length of the transaction, so two artists pressing delete
  -- on the same request cannot both get past this line.
  select * into r from public.requests where rid = p_rid for update;

  if not found then
    return false;
  end if;

  insert into public.request_tombstones (
    rid, artist_key, service, status, submitted_at,
    reference_count, deleted_by, deleted_by_email
  )
  values (
    r.rid, r.artist_key, r.service, r.status, r.submitted_at,
    r.reference_count, p_actor, coalesce(p_actor_email, '')
  )
  -- A rid can only come round again if a client resubmitted with one that had
  -- been deleted. Record the most recent deletion rather than failing.
  on conflict (rid) do update
    set artist_key       = excluded.artist_key,
        service          = excluded.service,
        status           = excluded.status,
        submitted_at     = excluded.submitted_at,
        reference_count  = excluded.reference_count,
        deleted_at       = now(),
        deleted_by       = excluded.deleted_by,
        deleted_by_email = excluded.deleted_by_email;

  -- Cascades to request_images and request_events.
  delete from public.requests where id = r.id;

  return true;
end;
$$;

-- 🔴 REVOKE FROM PUBLIC FIRST, and do not shorten this to the two role names.
--
-- Postgres grants EXECUTE on every new function to PUBLIC by default, and
-- `anon` / `authenticated` inherit it from there. Revoking from those two roles
-- alone removes grants made TO them and leaves the PUBLIC grant untouched — so
-- the function stays callable by exactly the people it was meant to exclude,
-- and the revoke reads as though it worked.
--
-- That matters more here than anywhere else in this schema. This function is
-- SECURITY DEFINER and takes the rid as an argument, so a reachable copy is a
-- way for any signed-in artist to delete ANY request by id, with none of the
-- can_see_artist checking that delete-request/index.ts does before calling it.
-- The permission check lives entirely outside this function; the only thing
-- keeping it honest is that nobody but service_role can reach it.
revoke all on function public.delete_request_permanently(text, uuid, text) from public;
revoke all on function public.delete_request_permanently(text, uuid, text) from anon;
revoke all on function public.delete_request_permanently(text, uuid, text) from authenticated;
grant execute on function public.delete_request_permanently(text, uuid, text) to service_role;


-- ------------------------------------------------------------ belt check ---
-- Fails the migration if either browser-facing role can still reach the
-- function. Same spirit as the RLS check in 20260902000200: the revoke above
-- is subtle enough to get "simplified" by someone who has not hit the PUBLIC
-- default, and the failure mode is silent — everything works, and one artist
-- can delete the other's requests with a single RPC call.
do $$
declare
  reachable text;
begin
  select string_agg(role_name, ', ')
    into reachable
  from (
    select r.rolname as role_name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated')) as r(rolname)
    where n.nspname = 'public'
      and p.proname = 'delete_request_permanently'
      and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
  ) s;

  if reachable is not null then
    raise exception
      'delete_request_permanently is still EXECUTEable by: % — the PUBLIC grant was not revoked',
      reachable;
  end if;
end $$;
