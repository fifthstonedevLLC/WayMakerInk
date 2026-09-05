-- ==========================================================================
-- WayMaker Ink — set the portal profiles for Nic and Laynie
--
-- The signup trigger (handle_new_user, in 20260902000100_schema.sql) creates
-- a bare `profiles` row the instant the auth user exists — display_name from
-- signup metadata, role defaulting to 'artist', artist_key null. It cannot
-- know which artist a person IS, which is what this script tells it.
--
-- Run this AFTER creating the two accounts by hand in the Supabase dashboard
-- (Authentication → Users → Add user) — see DEPLOY.md §1, "The two accounts".
-- Signup is disabled in config.toml on purpose, so that dashboard step is the
-- only way these auth.users rows come to exist on a hosted project.
--
-- Written as an upsert rather than a plain UPDATE so it is not order-
-- dependent on the trigger: `on conflict` lands the same values whether the
-- profiles row already exists or this statement is what creates it.
--
-- ⚠ Fill in the real addresses below before running — do not commit them.
-- role = 'admin' means each sees both queues, with the artist filter
-- defaulting to their own. Change either to 'artist' to scope that person to
-- only their own requests — the RLS policy in 20260902000200_rls.sql already
-- supports it.
-- ==========================================================================

insert into public.profiles (id, display_name, role, artist_key)
select id, 'Nic', 'admin', 'nic'
from auth.users where email = 'nic@…'
on conflict (id) do update
  set display_name = excluded.display_name,
      role         = excluded.role,
      artist_key   = excluded.artist_key;

insert into public.profiles (id, display_name, role, artist_key)
select id, 'Laynie', 'admin', 'laynie'
from auth.users where email = 'laynie@…'
on conflict (id) do update
  set display_name = excluded.display_name,
      role         = excluded.role,
      artist_key   = excluded.artist_key;

-- Each INSERT above is a no-op (0 rows) if the email does not match any
-- auth.users row yet — create the account in the dashboard first, then
-- re-run this script.
