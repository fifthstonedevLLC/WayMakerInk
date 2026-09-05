-- WayMaker Ink — demo requests for the hosted UAT project.
-- Run manually in the SQL Editor (or psql) — this is NOT a migration and is
-- NOT applied by `db push`. Safe to re-run: upserts on `rid`.
--
-- Fake emails (@example.test, a non-resolving TLD) and fake phone numbers
-- (555-01xx). "Send Response" will attempt to email these — they will bounce,
-- not reach a real person, but don't click it live in front of clients unless
-- that's the point of the demo.

insert into public.requests (
  rid, status, service, artist_key,
  first_name, last_name, email, phone,
  client_is_minor, first_time, heard_from, referred_by,
  idea, placement, size, style,
  piercing_type, piercing_count, piercing_side, jewelry, piercing_notes,
  touchup_placement, touchup_age, touchup_by_us, touchup_details,
  minor_first_name, minor_last_name, minor_age, guardian_relationship, guardian_consent,
  quoted_price, quote_label,
  tier_sent, estimate, artist_note, decided_at, booking_url,
  submitted_at, reference_count
) values

('WMI-DEMO1-AAAA', 'NEW', 'tattoo', 'nic',
 'Marisol', 'Vega', 'marisol.vega@example.test', '(555) 010-4471',
 false, true, 'Friend or family', 'Dana Okoye',
 'A great blue heron mid-landing, wings spread, over cattails. Realism but not photo-real — I like visible linework.',
 'Outer left thigh', '6-8"', 'Black & grey',
 '', '', '', '', '',
 '', '', '', '',
 '', '', null, '', false,
 null, '',
 null, '', '', null, '',
 now() - interval '3 hours', 0),

('WMI-DEMO2-BBBB', 'NEW', 'piercing', 'laynie',
 'Theo', 'Ashworth', 'theo.ashworth@example.test', '(555) 010-2298',
 false, false, 'Instagram', '',
 '', '', '', '',
 'Helix', 'Pair', 'Left', 'Studio', 'I had a helix on the right side years ago that rejected. Worth a look before we start.',
 '', '', '', '',
 '', '', null, '', false,
 75.00, 'Pair · $75',
 null, '', '', null, '',
 now() - interval '9 hours', 0),

('WMI-DEMO3-CCCC', 'NEW', 'piercing', 'laynie',
 'Priya', 'Raman', 'priya.raman@example.test', '',
 false, true, 'Walked by the shop', '',
 '', '', '', '',
 'Something else — I''ll describe it', 'Single', '', 'Own', 'A vertical labret. I have a titanium bar already but don''t know if it can be used for a fresh one.',
 '', '', '', '',
 '', '', null, '', false,
 null, 'Quote on request',
 null, '', '', null, '',
 now() - interval '1 day', 0),

('WMI-DEMO4-DDDD', 'NEW', 'touchup', 'laynie',
 'Gwen', 'Tarrant', 'gwen.tarrant@example.test', '(555) 010-7734',
 false, false, 'A previous client', 'Marisol Vega',
 '', '', '', '',
 '', '', '', '', '',
 'Inner right wrist', '3-10 years', 'No', 'Fine-line script that has spread and gone grey-blue. Some letters have closed up.',
 '', '', null, '', false,
 null, '',
 null, '', '', null, '',
 now() - interval '2 days', 0),

('WMI-DEMO5-EEEE', 'NEW', 'piercing', 'laynie',
 'Robin', 'Delacroix', 'robin.delacroix@example.test', '(555) 010-6612',
 true, false, 'Friend or family', 'Theo Ashworth',
 '', '', '', '',
 'Basic Lobe', 'Pair', 'Both', 'Studio', 'First piercing for her. Nervous about the sound more than the pain.',
 '', '', '', '',
 'Juniper', 'Delacroix', 12, 'Parent', true,
 50.00, 'Pair · $50',
 null, '', '', null, '',
 now() - interval '5 hours', 0),

('WMI-DEMO6-FFFF', 'LINK_SENT', 'tattoo', 'nic',
 'Aurelio', 'Santos', 'aurelio.santos@example.test', '(555) 010-3390',
 false, false, 'Google or web search', '',
 'Compass rose with a ship''s wheel behind it, forearm wrap. Colour, mostly blues and a deep red.',
 'Right forearm', '10"+', 'Color',
 '', '', '', '', '',
 '', '', '', '',
 '', '', null, '', false,
 null, '',
 'tier4', '4 hr · $500', 'Aurelio — this is a great one and I''d love to do it. Four hours should cover the wrap comfortably.',
 now() - interval '1 day', 'https://waymakerink.as.me/?appointmentType=96303791',
 now() - interval '3 days', 0),

('WMI-DEMO7-GGGG', 'DECLINED', 'tattoo', 'laynie',
 'Cassian', 'Nkemdirim', 'cassian.n@example.test', '',
 false, true, 'TikTok', '',
 'Full back piece, Japanese traditional, koi and waves.',
 'Full back', '10"+', 'Color',
 '', '', '', '', '',
 '', '', '', '',
 '', '', null, '', false,
 null, '',
 null, '', 'Cassian — this is beautiful work but a full back piece in Japanese traditional isn''t my style. I''d point you at a specialist rather than take it on halfway.',
 now() - interval '6 days', '',
 now() - interval '6 days', 0)

on conflict (rid) do nothing;


insert into public.request_events (request_id, event, detail, created_at)
select r.id, 'created', jsonb_build_object('service', r.service, 'demo', true), r.submitted_at
from public.requests r where r.rid like 'WMI-DEMO%'
on conflict do nothing;

insert into public.request_events (request_id, event, detail, created_at)
select r.id,
       case when r.status = 'DECLINED' then 'declined' else 'responded' end,
       jsonb_build_object('tier_key', r.tier_sent, 'estimate', r.estimate, 'demo', true),
       r.decided_at
from public.requests r
where r.rid like 'WMI-DEMO%' and r.decided_at is not null
on conflict do nothing;
