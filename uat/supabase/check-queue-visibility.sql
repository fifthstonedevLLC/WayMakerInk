-- ==========================================================================
-- WayMaker Ink — why is an artist's queue empty when their profile is right?
--
-- READ ONLY. Run as `postgres` in the SQL Editor, whole file, top to bottom.
--
-- check-profiles.sql answers "is the profile configured". This answers the next
-- question: given a correct profile, does the data exist, and does RLS actually
-- let her have it. Those are different failures with the same symptom — an
-- empty queue and no error — and guessing between them wastes a round trip.
--
-- Section 3 is the one that matters. It impersonates her session inside a
-- transaction and asks the view the same question the portal asks, so the
-- answer is not an argument about how RLS ought to behave.
-- ==========================================================================


-- ==========================================================================
-- 1 · GROUND TRUTH — what is in the table, RLS bypassed
-- ==========================================================================
-- As `postgres` you are the table owner, so RLS does not apply here. This is
-- the real content of the table regardless of who can see it.
--
-- If laynie's row reads 0, the import did not run (or did not commit) and no
-- amount of permission fixing will show her anything.
select
  a.key                                                as artist_key,
  count(r.id)                                          as total,
  count(*) filter (where r.status = 'NEW')             as new_,
  count(*) filter (where r.status = 'LINK_SENT')       as link_sent,
  count(*) filter (where r.status = 'DECLINED')        as declined,
  count(*) filter (where r.status = 'BOOKED')          as booked,
  max(r.submitted_at)                                  as newest
from public.artists a
left join public.requests r on r.artist_key = a.key
group by a.key
order by a.key;


-- ==========================================================================
-- 2 · DOES THE VIEW DROP ANYTHING
-- ==========================================================================
-- request_queue INNER JOINs artists. A request whose artist_key has no artists
-- row would vanish from the queue while still sitting in the table — invisible
-- in the portal, present in every count you take against `requests`.
--
-- Both numbers must match. Still as postgres, so this isolates the join from
-- the RLS question.
select
  (select count(*) from public.requests)      as in_table,
  (select count(*) from public.request_queue) as through_view,
  (select count(*) from public.requests r
     where not exists (select 1 from public.artists a where a.key = r.artist_key))
                                              as dropped_by_join;


-- ==========================================================================
-- 3 · IMPERSONATE HER — the definitive test
-- ==========================================================================
-- Runs as the `authenticated` role with her user id in the JWT claim, which is
-- exactly what auth.uid() reads and therefore exactly what can_see_artist()
-- branches on. Whatever this returns is what her portal gets.
--
-- ⚠ Put her real user id in BOTH places below. Get it from:
--     select id, email from auth.users order by created_at;
--
-- (Listing them rather than naming one: the addresses are real and this file is
-- committed. Same reason set-profiles.sql ships with placeholders.)
--
-- Wrapped in a transaction that is rolled back: `set local` reverts at the end
-- of the transaction, so your editor session does not stay impersonated.

begin;

-- ⚠ REPLACE the uuid on the next line.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}';
set local role authenticated;

select
  auth.uid()                                       as sees_itself_as,
  public.is_staff()                                as is_staff,
  public.can_see_artist('laynie')                  as can_see_laynie,
  public.can_see_artist('nic')                     as can_see_nic,
  (select count(*) from public.requests)           as requests_visible,
  (select count(*) from public.request_queue)      as queue_visible,
  (select count(*) from public.request_queue where status = 'NEW')
                                                   as queue_visible_new,
  (select count(*) from public.artists)            as artists_visible;

rollback;

-- How to read section 3:
--
--   sees_itself_as NULL      the claim did not take — you left the placeholder
--                            uuid in, or edited only one of the two lines
--   is_staff false           no profiles row for that id; you have the wrong id
--   can_see_laynie false     profile is not what check-profiles.sql showed
--   requests_visible 0
--     but queue_visible 0    RLS is filtering; compare against section 1
--   requests_visible > 0
--     but queue_visible 0    the view's join is dropping them — section 2
--   queue_visible > 0
--     but queue_visible_new 0    ⭐ NOTHING IS BROKEN. See below.


-- ==========================================================================
-- 4 · THE MOST LIKELY ANSWER, IF SECTIONS 1-3 ALL LOOK FINE
-- ==========================================================================
-- The portal's queue defaults to status = NEW:
--
--     Queue.tsx:47   const status = params.get('status') || 'NEW';
--
-- So the landing page shows ONLY undecided requests. Every imported row that
-- was already answered — 7 of laynie's 13 are LINK_SENT — is filtered out of
-- the default view, not missing.
--
-- She reaches the rest through the status tiles, or directly:
--
--     /?status=ALL
--     /?status=LINK_SENT
--
-- This query shows what each tile will contain for her. If `NEW` here is 0 and
-- the others are not, the queue is working and the default filter is the whole
-- explanation.
select status, service, count(*)
from public.requests
where artist_key = 'laynie'
group by status, service
order by status, service;
