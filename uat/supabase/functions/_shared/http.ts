/* ==========================================================================
   Shared HTTP plumbing for the Edge Functions.

   CORS is an allowlist, never a reflector. `Access-Control-Allow-Origin: *`
   would be harmless on `intake` (it takes no credentials) and actively unsafe
   on `respond` (it takes the artist's JWT), so both use the same list and
   neither has to remember which it is.

   In production neither function is called cross-origin at all: nginx proxies
   /api/ on the booking domain and on the portal domain straight to the
   functions host, so the browser sees a same-origin request and never sends an
   Origin header. The allowlist exists for `vite dev` on localhost:5173 and for
   curl against a deployed function.
   ========================================================================== */

/* Comma-separated, e.g.
   "https://uat.booking.waymakerink.com,https://uat.portal.waymakerink.com".
   Unset means same-origin only, which is the correct default for a deploy
   that sits behind the nginx proxy. */
const ALLOWED = (Deno.env.get('WM_ALLOWED_ORIGINS') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  if (!origin || !ALLOWED.includes(origin)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    /* Vary matters even on a miss: without it a shared cache can serve the
       headers computed for one origin to a request from another. */
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
}

export function preflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

/* A refusal the caller can act on, told apart from one it cannot.
   public/app.js retries on 5xx and network faults and does NOT retry on 4xx —
   deliberately, because the same bytes would be rejected again. Anything that
   is the submitter's fault therefore has to leave here as a 4xx, or a bad
   request turns into three bad requests and three rows. */
export class BadRequest extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

export function fail(req: Request, err: unknown): Response {
  const status = err instanceof BadRequest ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);

  /* The full reason goes to the function log, where the artist's operator can
     read it. What crosses the wire on a 500 does not: an internal message can
     name a table, a column, or a constraint. A 4xx message is written for the
     person filling in the form and is safe to return verbatim. */
  console.error(`[${status}]`, message, err instanceof Error ? err.stack : '');

  return json(
    req,
    { ok: false, error: status === 500 ? 'Something went wrong on our end.' : message },
    status
  );
}
