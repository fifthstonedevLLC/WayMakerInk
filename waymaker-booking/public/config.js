/* Local-dev fallback only. Overwritten at container start by
   docker-entrypoint.sh from WM_WEBHOOK_URL and WM_ARTISTS.

   Production values belong in the Dokploy environment, not in this file —
   it is served to the public. */
window.WM_CONFIG = {
  webhookUrl: 'https://n8n.fifthstonedev.com/webhook/booking-request',
  artists: null   // null → app.js uses its built-in DEFAULT_ARTISTS
};
