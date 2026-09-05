-- ==========================================================================
-- WayMaker Ink — why can this person not see any requests?
--
-- READ ONLY. Run as `postgres` in the SQL Editor — `auth.users` is not
-- readable by an ordinary session, and the profiles policy is "own row only",
-- so neither artist can run this for themselves.
--
-- ---------------------------------------------------------------- the rule ---
-- Everything the portal shows is gated by can_see_artist() in
-- migrations/20260902000200_rls.sql:
--
--     p.role = 'admin' or p.artist_key = k
--
-- For a NON-admin that reduces to `artist_key = 'laynie'`. And `artist_key`
-- defaults to NULL, because the signup trigger (handle_new_user) sets only
-- display_name — it cannot know which artist a new account belongs to.
--
-- `NULL = 'laynie'` is NULL, not false, and certainly not true. So the policy
-- filters out every row and the portal renders an empty queue with no error:
-- the account is authenticated, the page works, there is simply nothing it is
-- permitted to see. The schema calls this "the correct failure for a
-- half-configured account" — correct, and indistinguishable from a bug unless
-- you know to look here.
--
-- ⚠ An artist cannot fix this themselves. The profiles update policy pins both
-- `role` and `artist_key` to their existing values, so a logged-in user can
-- change their display name and nothing else. This is deliberate — otherwise
-- any artist could promote themselves to admin and read the other's queue.
-- ==========================================================================

-- 1 · WHO EXISTS, AND WHAT CAN THEY ACTUALLY SEE
select
  u.email,
  u.created_at::date              as user_created,
  u.last_sign_in_at is not null   as has_signed_in,
  p.display_name,
  p.role,
  p.artist_key,
  case
    when p.id is null
      then '*** NO PROFILE ROW — the signup trigger did not fire ***'
    when p.role = 'admin'
      then 'sees every artist'
    when p.artist_key is null
      then '*** SEES NOTHING — role is artist and artist_key is NULL ***'
    when not exists (select 1 from public.artists a where a.key = p.artist_key)
      then '*** SEES NOTHING — artist_key "' || p.artist_key || '" is not an artists row ***'
    else 'sees ' || p.artist_key || ' only'
  end                             as effective_access
from auth.users u
left join public.profiles p on p.id = u.id
order by u.created_at;

-- 2 · HOW MANY REQUESTS EACH KEY WOULD SHOW
--    If a key here reads 0, the problem is the import, not the profile. If it
--    reads 40-ish and the artist still sees nothing, the problem is query 1.
select
  a.key           as artist_key,
  a.name,
  count(r.id)     as requests,
  count(*) filter (where r.status = 'NEW') as new_requests
from public.artists a
left join public.requests r on r.artist_key = a.key
group by a.key, a.name
order by a.key;

-- 3 · ORPHANED PROFILES
--    A profile whose artist_key names no artist. Should return nothing.
select p.id, p.display_name, p.role, p.artist_key
from public.profiles p
where p.artist_key is not null
  and not exists (select 1 from public.artists a where a.key = p.artist_key);


-- ==========================================================================
-- THE FIX
-- ==========================================================================
-- Take the real addresses out of query 1 above and put them in below, then run
-- set-profiles.sql — or just run this, which is the same upsert.
--
-- ⚠ Each statement matches on email and is a silent no-op (0 rows) if nothing
-- matches. That is almost certainly what happened the first time: the script
-- shipped with `nic@…` / `laynie@…` placeholders, which match no account, so it
-- reported success and changed nothing.
--
-- ⚠ Re-run query 1 afterwards. "0 rows affected" is the failure mode here and
-- it looks exactly like success.
--
-- role: 'admin' sees both queues (what a two-person shop usually wants);
--       'artist' scopes them to their own. Either way artist_key must be set —
--       it is what the portal defaults its filter to, and for an 'artist' it is
--       the only thing granting any access at all.
--
--   insert into public.profiles (id, display_name, role, artist_key)
--   select id, 'Laynie', 'artist', 'laynie'
--   from auth.users where email = 'REPLACE-WITH-LAYNIE-REAL-EMAIL'
--   on conflict (id) do update
--     set display_name = excluded.display_name,
--         role         = excluded.role,
--         artist_key   = excluded.artist_key;
--
--   insert into public.profiles (id, display_name, role, artist_key)
--   select id, 'Nic', 'artist', 'nic'
--   from auth.users where email = 'REPLACE-WITH-NIC-REAL-EMAIL'
--   on conflict (id) do update
--     set display_name = excluded.display_name,
--         role         = excluded.role,
--         artist_key   = excluded.artist_key;
--
-- After the update the artist must reload the portal. It reads role and
-- artist_key once at login, so a session opened before the fix keeps the old
-- empty scope until the page is refreshed.
