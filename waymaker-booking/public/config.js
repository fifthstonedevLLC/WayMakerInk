/* Local-dev fallback only. Overwritten at container start by
   docker-entrypoint.sh from WM_WEBHOOK_URL, WM_ARTISTS, WM_HOME_URL and
   WM_REDIRECT_SECONDS.

   Production values belong in the Dokploy environment, not in this file —
   it is served to the public. */
window.WM_CONFIG = {
  webhookUrl: 'https://booking.waymakerink.com/webhook/booking-request',
  artists: null,          // null → app.js uses its built-in DEFAULT_ARTISTS
  homeUrl: 'https://waymakerink.com',
  redirectSeconds: 20     // 0 → stay on the confirmation, no auto-return
};
