/* Local-dev fallback only. Overwritten at container start by
   docker-entrypoint.sh from WM_WEBHOOK_URL, WM_ARTISTS, WM_HOME_URL and
   WM_REDIRECT_SECONDS.

   Production values belong in the Dokploy environment, not in this file —
   it is served to the public. */
window.WM_CONFIG = {
  /* ⚠ Was 'https://booking.waymakerink.com/webhook/booking-request' — PRODUCTION's
     n8n intake webhook. This file is the fallback used when the container starts
     without WM_WEBHOOK_URL set, so a UAT image missing that variable would have
     filed live rows against the production Sheet.

     Relative on purpose: nginx proxies /api/intake to the Supabase intake
     function, which keeps the POST same-origin. */
  webhookUrl: '/api/intake',
  artists: null,          // null → app.js uses its built-in DEFAULT_ARTISTS
  homeUrl: 'https://waymakerink.com',
  redirectSeconds: 20     // 0 → stay on the confirmation, no auto-return
};
