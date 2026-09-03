import { createClient } from '@supabase/supabase-js';

/* Deliberately not parameterised with a generated `Database` type. That file
   has to be regenerated after every migration, and a stale one is worse than
   none — it type-checks against a schema that no longer exists. The row shapes
   the portal actually reads are declared by hand in ./types and applied at the
   query with `.returns<T>()`, so a column rename fails at the one query that
   reads it instead of silently everywhere. */

declare global {
  interface Window {
    WM_PORTAL_CONFIG?: {
      supabaseUrl?: string;
      supabaseAnonKey?: string;
      envLabel?: string;
    };
  }
}

const cfg = window.WM_PORTAL_CONFIG ?? {};

export const ENV_LABEL = cfg.envLabel ?? '';

/* A missing config is a deployment fault, not a runtime condition to degrade
   through. Throwing here surfaces it as one clear message on a blank page
   rather than as "Failed to fetch" on every query. */
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  throw new Error(
    'config.js has no Supabase URL or anon key. Set WM_SUPABASE_URL and ' +
    'WM_SUPABASE_ANON_KEY in the environment — docker-entrypoint.sh writes them ' +
    'into /config.js at container start.'
  );
}

export const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    /* The portal has no email-link or OAuth flow — Nic and Laynie sign in with
       a password. Parsing the URL for a session would only give a stray
       `#access_token` in a pasted link a way to become a session. */
    detectSessionInUrl: false
  }
});

/* Calls the `respond` Edge Function with the signed-in user's JWT attached.
   supabase.functions.invoke does that automatically, which is the reason the
   portal talks to a function rather than to the n8n webhook directly — the
   browser has a credential that can be checked and revoked, and n8n's shared
   token stays server-side. */
export async function respond(payload: {
  rid: string;
  action: 'send' | 'decline' | 'resend';
  tierKey?: string;
  estimate?: string;
  message: string;
}): Promise<{ ok: boolean; error?: string; alreadyDecided?: boolean }> {
  const { data, error } = await supabase.functions.invoke('respond', { body: payload });

  /* A non-2xx from a function arrives as a FunctionsHttpError whose body holds
     the message the function meant to give. Reading it is what turns "Edge
     Function returned a non-2xx status code" into "the touch-up types need
     creating in Acuity". */
  if (error) {
    let message = error.message;
    const res = (error as { context?: Response }).context;
    if (res && typeof res.json === 'function') {
      try {
        const body = await res.clone().json();
        if (body?.error) message = body.error;
        if (body?.alreadyDecided) return { ok: false, error: message, alreadyDecided: true };
      } catch {
        /* Not JSON. The generic message is what there is. */
      }
    }
    return { ok: false, error: message };
  }

  if (data && data.ok === false) {
    return { ok: false, error: data.error, alreadyDecided: data.alreadyDecided };
  }
  return { ok: true };
}

/* The reference bucket is private, so every image needs a token. One hour is
   long enough to read a request and short enough that a URL pasted into a
   group chat stops working. */
export async function signedImageUrls(paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  const { data, error } = await supabase.storage
    .from('request-refs')
    .createSignedUrls(paths, 3600);
  if (error) throw error;
  return (data ?? []).map((d) => d.signedUrl).filter(Boolean);
}
