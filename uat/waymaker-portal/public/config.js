/* Local-dev fallback only. Overwritten at container start by
   docker-entrypoint.sh from WM_SUPABASE_URL, WM_SUPABASE_ANON_KEY and
   WM_UAT_LABEL.

   The anon key is safe in a public file — it grants exactly what the policies
   in the RLS migration grant an unauthenticated caller, which is nothing. The
   service-role key is NOT safe here and never appears in this repo. */
window.WM_PORTAL_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  /* Text in the corner flag. Empty string hides it — production sets no label. */
  envLabel: 'UAT'
};
