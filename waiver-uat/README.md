# WayMaker Ink — Client Consent Forms

Tattoo and piercing waivers. A static site plus one authenticated proxy route,
served by nginx in a container. No build step, no framework, no dependencies.

Split out of the combined `WayMakerInk` repo, which also held the appointment
booking app (`waymaker-booking/`). That app is unrelated to this one and stays
where it is — with one exception, noted under [Cross-repo
dependency](#cross-repo-dependency).

---

## How a submission travels

```
browser  ──POST /api/waiver──▶  nginx (this container)  ──POST──▶  n8n webhook
          same origin,                adds X-WM-Form-Key           Header Auth
          no credential                                            verifies it
```

The browser posts to a **same-origin** path. nginx adds the shared secret and
forwards to n8n. This is the whole design, and the reason for it is worth
stating plainly:

> **A public web form cannot authenticate itself.** Basic Auth, Header Auth and
> JWT Auth all require the caller to hold a credential, and our caller is
> JavaScript in a stranger's browser — anything given to it is readable in
> view-source. Putting a key in the page would be theatre.

Making nginx the caller is what turns Header Auth into a real control. The
secret exists only in the Dokploy environment and in n8n; a request that did not
come through our proxy cannot produce it, and n8n rejects it with a 403 *before
the workflow executes*, so scanning the endpoint costs zero executions.

Same-origin also means no CORS preflight and no reliance on n8n's "Allowed
Origins" setting, which is browser-enforced and ignored entirely by `curl`.

### The four layers

| Layer | Stops | Where |
|---|---|---|
| Header Auth | Anything not proxied by us — direct `curl` at the webhook | n8n webhook node |
| Turnstile | Bots that would otherwise POST through the proxy | HTTP Request node → Cloudflare siteverify |
| Honeypot | Naive form-fillers | [`n8n/nodes/validate-waiver.js`](n8n/nodes/validate-waiver.js) |
| Size + rate caps | Oversized and repeated writes | [`nginx.conf.template`](nginx.conf.template) |

No single layer is sufficient. Header Auth does nothing about a bot driving a
real browser; Turnstile does nothing about a leaked secret. Together they cover
the realistic cases.

---

## Layout

```
public/                        nginx document root — everything here is public
├── index.html                 form picker / home
├── tattoo-waiver.html
├── piercing-waiver.html
├── waymaker-forms.js          all form behaviour, both waivers
├── waymaker-forms.css
├── config.js                  ⚠ regenerated at container start
├── WaymakerInk_Logo_transparent.png
├── tattoo-waiver/             0-second redirect stubs → /tattoo-waiver.html
├── piercing-waiver/
├── tatto-waiver/              misspelled; kept because live links exist
└── peircing-waiver/           misspelled; kept because live links exist
n8n/nodes/                     Code node sources — pasted into the n8n editor,
├── validate-waiver.js         never executed from this repo
└── prep-metadata.js
Dockerfile
nginx.conf.template
docker-entrypoint.sh
.env.example
```

`public/config.js` is committed with Cloudflare's public "always passes" test
key so the forms work when opened locally. **The container overwrites it at
start-up** from `WM_TURNSTILE_SITE_KEY`; it is never served as committed.

---

## Environment

Set in the Dokploy panel. See [`.env.example`](.env.example) for the annotated
template. UAT and production each get a **complete, separate set** — sharing
`WM_FORM_KEY` or a Turnstile key between them defeats having two environments.

| Variable | Required | Notes |
|---|---|---|
| `WM_WAIVER_WEBHOOK_URL` | yes | Full n8n `/webhook/` URL. `/webhook-test/` is refused at start-up. |
| `WM_FORM_KEY` | yes | Shared secret; must match the n8n Header Auth credential. `openssl rand -base64 32`. |
| `WM_TURNSTILE_SITE_KEY` | recommended | Public, but domain-bound — one per host. |
| `WM_ROBOTS_TAG` | no | Defaults to `noindex, nofollow`. Production sets `all`. |

Two more live on the **n8n host**, not here: `WM_TURNSTILE_SECRET`, and the
Header Auth credential holding `WM_FORM_KEY`'s value.

### Fail-closed

If `WM_WAIVER_WEBHOOK_URL` or `WM_FORM_KEY` is missing or malformed,
`docker-entrypoint.sh` exits non-zero **without writing the nginx config**. The
stock nginx welcome-page config stays in place and has no `/api/waiver` route,
so a misconfigured deploy serves a 404 rather than an unauthenticated open
proxy. A failed deploy is the intended outcome — do not "fix" it by relaxing the
validation.

---

## Deploying

1. **Create the DNS `A` record first**, pointing at the Dokploy host — the same
   IP as n8n. Adding the domain in Dokploy before the record resolves leaves
   the app stuck without a certificate.
   - UAT: `uat.forms` → …
   - Production: `forms` → …
2. In Dokploy, create the app with build type **Dockerfile** (not the static or
   Nixpacks preset — this image needs its entrypoint).
3. Set the environment variables above.
4. Deploy, then run the smoke tests below.

### n8n side

Each environment needs **its own workflow**, not a shared one.

1. **Webhook node** — `POST`, a fresh path, Respond: Immediately.
   Set **Authentication → Header Auth** and create a credential with name
   `X-WM-Form-Key` and value = this environment's `WM_FORM_KEY`.
2. **HTTP Request node** — `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`
   with `secret` = `$env.WM_TURNSTILE_SECRET` and `response` =
   `{{ $json.body['cf-turnstile-response'] }}`. Follow with an IF on
   `success === true`; the false branch responds 403 and stops.
3. **Code node "Validate waiver"** — paste
   [`n8n/nodes/validate-waiver.js`](n8n/nodes/validate-waiver.js), mode *Run
   Once for All Items*. Follow with an IF on `valid`; the false branch responds
   400 and stops.
4. **Code node "Prep metadata"** — paste
   [`n8n/nodes/prep-metadata.js`](n8n/nodes/prep-metadata.js), mode *Run Once
   for Each Item*.

> ⚠ **UAT must write to its own Drive folder and its own Sheet.** Pointing the
> UAT workflow at production's storage puts test waivers carrying fake
> signatures into the real client record — a records-integrity problem, not
> just noise.

`$env` access requires `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` and
`NODE_FUNCTION_ALLOW_BUILTIN=crypto` on the n8n host; both are already set for
the booking workflows.

---

## Local development

`public/` is plain static files — open `public/index.html` directly, or serve
the folder with anything. Committed `config.js` supplies a working Turnstile
test key.

`/api/waiver` does not exist outside the container, so **submitting will fail
locally**. That is expected. To exercise the full path, build the image:

```sh
docker build -t wm-waiver .
docker run --rm -p 8080:80 \
  -e WM_WAIVER_WEBHOOK_URL="https://n8n.fifthstonedev.com/webhook/<uat-path>" \
  -e WM_FORM_KEY="$(openssl rand -base64 32 | tr -d '=+/ ')" \
  -e WM_TURNSTILE_SITE_KEY="1x00000000000000000000AA" \
  wm-waiver
```

---

## Smoke tests

Replace `HOST` with `uat.forms.waymakerink.com` or `forms.waymakerink.com`.

```sh
# The core assertion: the webhook refuses anything not carrying the secret.
curl -i -X POST https://n8n.fifthstonedev.com/webhook/<path> \
  -H 'Content-Type: application/json' -d '{}'
# expect 403 — and NO entry in the n8n executions list

# Through the proxy the header is injected, so this gets past auth and is
# then refused by Turnstile. Reaching the Turnstile rejection is success.
curl -i -X POST https://HOST/api/waiver \
  -H 'Content-Type: application/json' -d '{"formType":"tattoo-waiver"}'

curl -i https://HOST/api/waiver                    # expect 403 (non-POST)
curl -sI https://HOST/ | grep -i x-robots-tag      # UAT: noindex, nofollow

# The secret must not appear in anything we serve.
curl -s https://HOST/waymaker-forms.js | grep -iE 'n8n|webhook|form-key'
# expect no match other than the literal /api/waiver

# Oversized body dies at the edge, not in n8n.
head -c 6000000 /dev/urandom | base64 > /tmp/big
curl -i -X POST https://HOST/api/waiver \
  -H 'Content-Type: application/json' --data-binary @/tmp/big   # expect 413

# Rate limit engages.
for i in $(seq 1 12); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST https://HOST/api/waiver \
    -H 'Content-Type: application/json' -d '{}'
done                                               # expect 403s, then 429s
```

**In a browser**, on both forms:

1. Turnstile renders; the honeypot is invisible and causes no layout shift.
2. A complete waiver — real drawn signature, phone-camera ID photo — produces a
   PDF with the signature, initials and ID image intact. The image validation in
   `validate-waiver.js` is the most likely thing to over-reject.
3. The piercing form as a minor, to exercise the guardian branch (second
   signature, relocated licence field, `guardianSignature`).
4. **Fail, then retry without reloading.** Throttle the network to force the
   error path, then submit again. It must succeed — if it 403s,
   `turnstile.reset()` is not firing and every retry is replaying a spent token.
5. Fill the honeypot via devtools and submit: the client sees success, and no
   row is written.

---

## Promotion, UAT → production

Environments differ only by configuration, so promotion is a deploy of the same
commit with production's variables — never a code edit. Before promoting:

- [ ] Production has its own `WM_FORM_KEY`, Turnstile key pair, and webhook path
- [ ] `WM_ROBOTS_TAG=all` set on production only
- [ ] Production workflow points at the production Drive folder and Sheet
- [ ] Smoke tests pass against UAT
- [ ] The old production webhook path is deleted in n8n — the previous URL
      (`…/webhook/5b254e31-…`) was hardcoded in a publicly served script for the
      life of the old form and should be treated as burned

---

## Cross-repo dependency

The **booking** app's n8n email templates hotlink this site's logo:

```
https://forms.waymakerink.com/WaymakerInk_Logo_transparent.png
```

referenced from `n8n/templates/respond-403.html` and
`n8n/templates/request-email.html` in the booking repo. Keep the file at the
document root under that exact name. Moving it into an `assets/` folder breaks
images in the booking app's outbound email, and nothing in *this* repo would
show a failure.
