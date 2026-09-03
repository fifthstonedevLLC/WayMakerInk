/* ==========================================================================
   The service-role client.

   ⚠ This key bypasses every policy in 20260902000200_rls.sql. It exists only
   inside a function, never in a browser, and nothing it returns may be handed
   back to a caller unfiltered — `respond` re-checks who is asking before it
   uses this client, and `intake` never returns a row at all.

   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected into every Edge
   Function by the platform; they are not something to set in the dashboard.
   ========================================================================== */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.58.0';

export function adminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. These are injected ' +
      'by the platform — a function missing them is running outside Supabase.'
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

/* A client bound to the CALLER's JWT, so every query runs under their RLS.
   `respond` uses this to answer "who is this and may they touch this row",
   then switches to adminClient() to perform the write — the check and the
   write are deliberately not the same client. */
export function callerClient(req: Request): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const auth = req.headers.get('Authorization') || '';

  return createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
}
