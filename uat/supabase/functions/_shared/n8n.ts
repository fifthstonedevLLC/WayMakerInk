/* ==========================================================================
   Calling n8n.

   n8n holds no data any more — it is a mail merge with a public URL. That
   makes the threat exactly one thing: **anyone who learns the URL can make the
   shop send email from its own address, to any recipient, saying anything.**
   Phishing from a domain the recipient already trusts. Nothing leaks, because
   n8n has no database credential in this design and every value it mails comes
   from the caller — which is a real improvement on the old build, where the
   workflow read the client's row out of the sheet itself.

   Three things are needed to close that, and a bare shared token in a header
   only does the first:

     1. Prove the caller is us.              → the signature
     2. Prove the payload was not altered.   → the signature covers the fields
     3. Stop a captured call being replayed. → the timestamp

   So this signs, rather than authenticating with a static string. It is also
   the house standard: nodes/intake.js already signs decision links with
   HMAC-SHA256, and n8n is already configured with
   NODE_FUNCTION_ALLOW_BUILTIN=crypto for it.

   ---------------------------------------------------------------- the scheme

   Three headers travel with every call:

     X-WM-Timestamp  unix seconds
     X-WM-Signed     the field names covered, comma separated
     X-WM-Signature  v1=<hex>

   The signature is HMAC-SHA256, over newline-joined lines:

     v1
     <timestamp>
     <name>=<value>          ← one line per name in X-WM-Signed, in that order

   ⚠ The field NAMES are in the signed string, not just their values. Without
   them, `{a: "x", b: "y"}` signed as [a,b] and `{a: "y", b: "x"}` signed as
   [b,a] produce identical bytes — an attacker holding one legitimate request
   could swap two fields' meanings and keep the signature valid.

   ⚠ Newline is the separator because no signed value can contain one: `rid` is
   regex-constrained, `action` is an enum, `to` passed an email regex that
   rejects all whitespace, and the URLs come out of our own database. Adding a
   free-text field to a canon (a message body, an artist note) would break that
   assumption and needs a different encoding — which is one reason the canon is
   deliberately small.

   ---------------------------------------------------- why not the whole body

   Signing the raw request bytes would cover every field, but n8n would then
   need Raw Body ON to see those exact bytes, and the workflow would have to
   JSON.parse the body itself. The BUILD-SHEET already documents how much
   trouble that setting causes. Signing a named subset costs nothing at the
   n8n end and covers what actually matters: WHO gets mailed and WHAT LINK they
   are given. A tampered `firstName` misspells a greeting; a tampered `to` or
   `bookingUrl` is the attack.
   ========================================================================== */

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sign(secret: string, canon: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(canon)));
}

export type N8nResult = { ok: true } | { ok: false; error: string };

export async function postToN8n(opts: {
  /* The env var NAME, not its value — so a missing one is reported as
     "WM_N8N_RESPOND_URL is not set" rather than as "undefined". */
  urlVar: 'WM_N8N_NOTIFY_URL' | 'WM_N8N_RESPOND_URL';
  /* Field names from `body` whose integrity the signature guarantees. Keep it
     to the fields that decide who is mailed and what they are sent. */
  canon: string[];
  body: Record<string, unknown>;
  /* n8n on a cold workflow takes a few seconds; a hung one must not hold the
     artist's browser open indefinitely. */
  timeoutMs?: number;
}): Promise<N8nResult> {
  const url = Deno.env.get(opts.urlVar);
  if (!url) return { ok: false, error: `${opts.urlVar} is not set` };

  const secret = Deno.env.get('WM_N8N_SIGNING_SECRET');
  if (!secret) {
    /* Refuse rather than send unsigned. An unsigned call would be accepted by
       an n8n workflow whose verify node had also been skipped, and the two
       omissions would cancel out into a system that looks like it works. */
    return { ok: false, error: 'WM_N8N_SIGNING_SECRET is not set — refusing to send unsigned' };
  }

  const ts = Math.floor(Date.now() / 1000);

  const lines = ['v1', String(ts)];
  for (const name of opts.canon) {
    /* '' for a missing field, not 'undefined'. The verifier builds the same
       string from the parsed body, where an absent key also reads as ''. */
    lines.push(`${name}=${opts.body[name] ?? ''}`);
  }

  const signature = await sign(secret, lines.join('\n'));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WM-Timestamp': String(ts),
        'X-WM-Signed': opts.canon.join(','),
        'X-WM-Signature': `v1=${signature}`
      },
      body: JSON.stringify(opts.body),
      signal: controller.signal
    });

    /* 403 is what the verify node returns on a bad signature, and it is worth
       naming — "HTTP 403" sends someone hunting through mail logs, when the
       answer is that the two secrets do not match. */
    if (res.status === 403) {
      return { ok: false, error: 'n8n rejected the signature (403) — check WM_N8N_SIGNING_SECRET matches on both sides' };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}
