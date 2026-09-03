/* Local-dev fallback only. Overwritten at container start by
   docker-entrypoint.sh from WM_TURNSTILE_SITE_KEY.

   Production and UAT values belong in the Dokploy environment, not in this
   file — it is served to the public.

   The Turnstile *site* key is public by design (it is visible in the widget
   either way); the matching *secret* key never leaves the n8n host. The site
   key lives here rather than in the HTML because it is domain-bound, so UAT
   and production need different values — this keeps promotion a config change
   rather than a code diff.

   1x00000000000000000000AA is Cloudflare's documented "always passes" test key,
   so the form is usable locally without a Turnstile account. */
window.WM_CONFIG = {
  turnstileSiteKey: '1x00000000000000000000AA',
};
