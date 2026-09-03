/* ==========================================================================
   The row shapes the portal reads.

   Hand-written rather than generated. They mirror the migrations in
   ../../supabase/migrations/ and are applied at each query with
   `.returns<T>()`, so a column rename breaks the one query that reads it —
   which is where you want to be told.
   ========================================================================== */

export type Service = 'tattoo' | 'piercing' | 'touchup';
export type Status = 'NEW' | 'LINK_SENT' | 'DECLINED' | 'BOOKED';

/* The portal renders labels; the database stores keys. Every human-readable
   string for these two vocabularies lives here and nowhere else. */
export const SERVICE_LABEL: Record<Service, string> = {
  tattoo: 'Tattoo',
  piercing: 'Piercing',
  touchup: 'Touch Up'
};

export const STATUS_LABEL: Record<Status, string> = {
  NEW: 'New',
  LINK_SENT: 'Link Sent',
  DECLINED: 'Declined',
  BOOKED: 'Booked'
};

/* From public.request_queue. */
export type QueueRow = {
  id: string;
  rid: string;
  status: Status;
  service: Service;
  artist_key: string;
  artist_name: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  client_is_minor: boolean;
  quoted_price: number | null;
  quote_label: string;
  tier_sent: string | null;
  estimate: string;
  submitted_at: string;
  decided_at: string | null;
  summary: string | null;
  image_count: number;
};

/* From public.requests — every column, for the detail page.
   `summary` and `image_count` are computed by the queue VIEW and do not exist
   on the table, so they are dropped here rather than carried as fields that
   would be `undefined` at runtime. `artist_name` is joined on by hand in
   RequestDetail, which is why it survives. */
export type RequestRow = Omit<QueueRow, 'summary' | 'image_count'> & {
  first_time: boolean;
  heard_from: string;
  referred_by: string;

  idea: string;
  placement: string;
  size: string;
  style: string;

  piercing_type: string;
  piercing_count: string;
  piercing_side: string;
  jewelry: string;
  piercing_notes: string;

  touchup_placement: string;
  touchup_age: string;
  touchup_by_us: string;
  touchup_details: string;

  minor_first_name: string;
  minor_last_name: string;
  minor_age: number | null;
  guardian_relationship: string;
  guardian_consent: boolean;

  artist_note: string;
  booking_url: string;
  page_url: string;
  reference_count: number;
};

/* From public.tier_options. `price` is null for quote-on-request — a custom
   piercing, or a tier whose price has not been decided. Rendering that null as
   $0 is how a client gets mailed a free tattoo, so it stays nullable all the
   way to the JSX. */
export type TierOption = {
  id: string;
  artist_key: string;
  service: Service;
  tier_key: string;
  label: string;
  hours: number | null;
  price: number | null;
  acuity_url: string | null;
  bookable: boolean;
  sort: number;
};

export type Profile = {
  id: string;
  display_name: string;
  role: 'artist' | 'admin';
  artist_key: string | null;
};

export type RequestImage = {
  id: string;
  storage_path: string;
  ordinal: number;
};

export type RequestEvent = {
  id: number;
  event: string;
  created_at: string;
  detail: Record<string, unknown>;
};
