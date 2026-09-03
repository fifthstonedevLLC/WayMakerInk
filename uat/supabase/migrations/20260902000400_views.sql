-- ==========================================================================
-- WayMaker Ink — derived reads
--
-- The price maths lived in two n8n Code nodes that had to agree: intake.js
-- priced the buttons in the request email, review-page.js re-priced the tapped
-- tier from the sheet row. They drifted once already. There is one copy now,
-- and it is here — the portal renders it and `respond` re-reads it, so the
-- number on the button and the number in the email cannot disagree.
-- ==========================================================================


-- ----------------------------------------------------------- tier options ---
-- What the portal's tier picker renders. `price` is NULL for quote-on-request
-- (a piercing, whose price comes from the menu and not from the clock), and
-- that NULL has to survive to the UI — rendering it as $0 is how a client gets
-- mailed a free tattoo.
--
-- ⚠ security_invoker. Without it a view runs as its OWNER and silently
-- bypasses the RLS on artists and service_tiers underneath — which would make
-- this view readable by anyone holding the anon key, artist emails and all.
create view public.tier_options
with (security_invoker = true)
as
select
  st.id,
  st.artist_key,
  a.name          as artist_name,
  st.service,
  st.tier_key,
  st.label,
  st.hours,
  st.acuity_url,
  st.sort,
  -- Priced by the clock, or by the menu, or not yet at all. The constraint on
  -- service_tiers guarantees hours and flat_price are never both set, so this
  -- CASE has no ambiguous arm.
  case
    when st.hours is not null then round(st.hours * a.hourly_rate, 2)
    else st.flat_price
  end             as price,
  -- Whether this tier can actually be sent. A tier with no Acuity URL renders
  -- in the portal as unavailable-with-a-reason rather than not rendering at
  -- all — "the touch-up tiers are missing" is a worse bug report than "the
  -- touch-up tiers say they need an Acuity type".
  (st.acuity_url is not null and st.acuity_url <> '') as bookable
from public.service_tiers st
join public.artists a on a.key = st.artist_key
where st.active
  and a.enabled;


-- --------------------------------------------------------- the queue view ---
-- One row per request with the things the list needs joined on, so the portal
-- makes one request for the queue instead of N+1 for image counts.
create view public.request_queue
with (security_invoker = true)
as
select
  r.id,
  r.rid,
  r.status,
  r.service,
  r.artist_key,
  a.name as artist_name,
  r.first_name,
  r.last_name,
  r.email,
  r.phone,
  r.client_is_minor,
  r.quoted_price,
  r.quote_label,
  r.tier_sent,
  r.estimate,
  r.submitted_at,
  r.decided_at,
  -- A one-line gist for the list, so the queue reads as requests rather than
  -- as names. Each service's own first question, truncated at the card width.
  case r.service
    when 'tattoo'   then r.idea
    when 'piercing' then trim(r.piercing_count || ' ' || r.piercing_type)
    when 'touchup'  then r.touchup_details
  end as summary,
  (select count(*) from public.request_images i where i.request_id = r.id) as image_count
from public.requests r
join public.artists a on a.key = r.artist_key;


-- Views are not covered by the owning tables' grants. `anon` must not appear
-- in either list — the tables underneath have no anon policy, so a leak here
-- would return zero rows rather than data, but revoking is cheaper than
-- relying on that.
revoke all on public.tier_options   from anon;
revoke all on public.request_queue  from anon;
grant select on public.tier_options  to authenticated;
grant select on public.request_queue to authenticated;
