-- ==========================================================================
-- Sample requests, for a local stack only.
--
-- ⚠ This file is applied by `supabase db reset` and by `supabase start` on a
-- fresh local stack. It is NOT applied by `supabase db push`, which is the
-- only command that touches a hosted project — so these rows cannot reach UAT
-- or production by running the normal deploy path.
--
-- Everything here is obviously fake: `.test` is a reserved TLD that can never
-- resolve, and the 555-01xx phone range is reserved for fiction. That is
-- deliberate — seed data that looks real is seed data someone eventually
-- emails.
--
-- One row per state the portal renders differently, because the point of a
-- seed is to make the UI's branches visible without filling in the form five
-- times:
--
--   tattoo   · NEW        the ordinary case
--   piercing · NEW        arrives already priced from the menu
--   piercing · NEW        custom — quote on request, price is NULL not 0
--   touchup  · NEW        tiers exist but have no Acuity link yet
--   piercing · NEW        a minor, with the guardian block filled in
--   tattoo   · LINK_SENT  decided, so the responder is replaced by the receipt
--   tattoo   · DECLINED   decided the other way
--
-- ⚠ No reference images here, and there cannot be. An image is an object in
-- Storage — an HTTP API, not a table — so SQL can write the `request_images`
-- row but never the file it points at, and the portal would render a
-- References card full of broken thumbnails. `bootstrap-local.sh` attaches
-- them afterwards, uploading the fixtures and setting `reference_count` in the
-- same step. Every row below therefore starts at 0, which is also what makes
-- the References card correctly absent until it isn't.
-- ==========================================================================

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

-- ---------------------------------------------------------------- tattoo ---
('WMI-SEED01-AAAA', 'NEW', 'tattoo', 'nic',
 'Marisol', 'Vega', 'marisol.vega@example.test', '(555) 010-4471',
 false, true, 'Friend or family', 'Dana Okoye',
 'A great blue heron mid-landing, wings spread, over cattails. Realism but not photo-real — I like visible linework. It would sit over a small scar I''d rather not hide completely.',
 'Outer left thigh', '6-8"', 'Black & grey',
 '', '', '', '', '',
 '', '', '', '',
 '', '', null, '', false,
 null, '',
 null, '', '', null, '',
 now() - interval '3 hours', 0),

-- ------------------------------------------------- piercing, menu-priced ---
('WMI-SEED02-BBBB', 'NEW', 'piercing', 'laynie',
 'Theo', 'Ashworth', 'theo.ashworth@example.test', '(555) 010-2298',
 false, false, 'Instagram', '',
 '', '', '', '',
 'Helix', 'Pair', 'Left', 'Studio', 'I had a helix on the right side years ago that rejected. Same ear anatomy, so worth a look before we start.',
 '', '', '', '',
 '', '', null, '', false,
 75.00, 'Pair · $75',
 null, '', '', null, '',
 now() - interval '9 hours', 0),

-- -------------------------------------------- piercing, quote on request ---
-- ⚠ quoted_price is NULL, not 0. The portal must render "Quote on request";
-- anything that coerces this to a number mails a client a free piercing.
('WMI-SEED03-CCCC', 'NEW', 'piercing', 'laynie',
 'Priya', 'Raman', 'priya.raman@example.test', '',
 false, true, 'Walked by the shop', '',
 '', '', '', '',
 'Something else — I''ll describe it', 'Single', '', 'Own', 'A vertical labret, if that''s something you do. I have a titanium bar already but I don''t know if it can be used for a fresh one.',
 '', '', '', '',
 '', '', null, '', false,
 null, 'Quote on request',
 null, '', '', null, '',
 now() - interval '1 day', 0),

-- --------------------------------------------------------------- touchup ---
('WMI-SEED04-DDDD', 'NEW', 'touchup', 'laynie',
 'Gwen', 'Tarrant', 'gwen.tarrant@example.test', '(555) 010-7734',
 false, false, 'A previous client', 'Marisol Vega',
 '', '', '', '',
 '', '', '', '', '',
 'Inner right wrist', '3-10 years', 'No', 'Fine-line script that has spread and gone grey-blue. Some letters have closed up. I''d rather rework it than cover it.',
 '', '', null, '', false,
 null, '',
 null, '', '', null, '',
 now() - interval '2 days', 0),

-- ----------------------------------------------------- piercing, a minor ---
('WMI-SEED05-EEEE', 'NEW', 'piercing', 'laynie',
 'Robin', 'Delacroix', 'robin.delacroix@example.test', '(555) 010-6612',
 true, false, 'Friend or family', 'Theo Ashworth',
 '', '', '', '',
 'Basic Lobe', 'Pair', 'Both', 'Studio', 'First piercing for her. She''s nervous about the sound more than the pain.',
 '', '', '', '',
 'Juniper', 'Delacroix', 12, 'Parent', true,
 50.00, 'Pair · $50',
 null, '', '', null, '',
 now() - interval '5 hours', 0),

-- ------------------------------------------------------ already responded ---
('WMI-SEED06-FFFF', 'LINK_SENT', 'tattoo', 'nic',
 'Aurelio', 'Santos', 'aurelio.santos@example.test', '(555) 010-3390',
 false, false, 'Google or web search', '',
 'Compass rose with a ship''s wheel behind it, forearm wrap. Colour, mostly blues and a deep red.',
 'Right forearm', '10"+', 'Color',
 '', '', '', '', '',
 '', '', '', '',
 '', '', null, '', false,
 null, '',
 'tier4', '4 hr · $500', 'Aurelio — this is a great one and I''d love to do it. Four hours should cover the wrap comfortably. Grab whichever slot suits you.',
 now() - interval '1 day', 'https://waymakerink.as.me/?appointmentType=96303791',
 now() - interval '3 days', 0),

-- --------------------------------------------------------------- declined ---
('WMI-SEED07-GGGG', 'DECLINED', 'tattoo', 'laynie',
 'Cassian', 'Nkemdirim', 'cassian.n@example.test', '',
 false, true, 'TikTok', '',
 'Full back piece, Japanese traditional, koi and waves.',
 'Full back', '10"+', 'Color',
 '', '', '', '', '',
 '', '', '', '',
 '', '', null, '', false,
 null, '',
 null, '', 'Cassian — this is beautiful work but a full back piece in Japanese traditional isn''t my style, and you deserve someone who lives in it. I''d point you at a specialist rather than take it on halfway.',
 now() - interval '4 days', '',
 now() - interval '6 days', 0)

on conflict (rid) do nothing;


-- The audit trail the portal's History card reads. Only 'created' for the open
-- ones; the two decided rows get the event that decided them.
insert into public.request_events (request_id, event, detail, created_at)
select r.id, 'created', jsonb_build_object('service', r.service, 'seed', true), r.submitted_at
from public.requests r where r.rid like 'WMI-SEED%'
on conflict do nothing;

insert into public.request_events (request_id, event, detail, created_at)
select r.id,
       case when r.status = 'DECLINED' then 'declined' else 'responded' end,
       jsonb_build_object('tier_key', r.tier_sent, 'estimate', r.estimate, 'seed', true),
       r.decided_at
from public.requests r
where r.rid like 'WMI-SEED%' and r.decided_at is not null
on conflict do nothing;
