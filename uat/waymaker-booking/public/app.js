/* ==========================================================================
   WayMaker Ink — Appointment Request
   Standalone static app. No build step, no dependencies.

   Routes
     /            → artist chooser (only rendered when >1 artist is enabled)
     /nic         → Nic's request form
     /laynie      → Laynie's request form (enable in ARTISTS below)
     ?artist=nic  → also honoured, for testing

   Adding an artist = one entry in ARTISTS. Nothing else changes.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ config */

  /* config.js is rewritten at container start from the Dokploy environment —
     see docker-entrypoint.sh. The literals below are the local-dev fallback
     and the shape reference; production values never live in this file.

     Artist *emails* are deliberately absent. This file is public, and the
     intake workflow resolves the artist from its own server-side map anyway,
     so a posted artistEmail would be both exposed and ignored. */
  var CFG = window.WM_CONFIG || {};

  /* ⚠ This no longer points at n8n. Requests go to the Supabase `intake` Edge
     Function, proxied same-origin by nginx at /api/intake so the browser never
     makes a cross-origin POST — see nginx.conf.template.

     Keeping it same-origin is not tidiness. app.js posts FormData and reads
     res.ok; a response with no Access-Control-Allow-Origin is unreadable, so
     fetch rejects and the retry path below fires three times while the server
     processes every one of them. Three rows, three emails, and a form showing
     an error. There is no preflight and nothing to configure on this path. */
  var WEBHOOK_URL = CFG.webhookUrl ||
    window.WM_WEBHOOK_URL ||     /* older single-value config.js */
    '/api/intake';

  var DEFAULT_ARTISTS = {
    nic: {
      enabled: true,
      name: 'Nic Sinnwell',
      services: ['tattoo'],
      headline: 'Tell us about the tattoo you have in mind.',
      blurb: 'Custom tattoo work. Share your idea and Nic will follow up personally with an estimate.'
    },
    laynie: {
      enabled: false, // set WM_ARTISTS in Dokploy to enable, no code change
      name: 'Laynie Joy',
      services: ['tattoo', 'piercing'],
      headline: 'Tell us about the tattoo you have in mind.',
      blurb: 'Custom tattoo work. Share your idea and Laynie will follow up personally with an estimate.'
    }
  };

  var ALL_SERVICES = ['tattoo', 'piercing', 'touchup'];

  /* Machine key → what gets submitted. The two differ for exactly one service
     and that is the whole reason this map exists: 'touchup' has no space and
     the label does, so neither can be derived from the other by casing. The
     intake function normalises whatever arrives, but the value that reaches
     the database should already read the way a person would write it. */
  var SERVICE_SUBMIT = {
    tattoo: 'Tattoo',
    piercing: 'Piercing',
    touchup: 'Touch Up'
  };

  /* Services that put ink under skin, and are therefore 18+ with no consent
     form that changes it. Piercing is the exception, not the rule, so the list
     names the rule. */
  var INK_SERVICES = ['tattoo', 'touchup'];

  /* Default to tattoo-only, deliberately. WM_ARTISTS in Dokploy has no
     `services` key and will not gain one by deploying code, so every live
     artist keeps behaving exactly as they do today until someone edits that
     variable on purpose. Do not make ['tattoo','piercing'] the default and
     rely on the environment to hold it back — that inverts which way a
     mistake fails. */
  function normaliseServices(value) {
    if (!value || !value.length) return ['tattoo'];

    var out = [];
    [].concat(value).forEach(function (s) {
      var key = String(s).trim().toLowerCase();
      if (ALL_SERVICES.indexOf(key) !== -1 && out.indexOf(key) === -1) out.push(key);
    });

    /* An artist configured with nothing recognisable still gets a working
       form rather than a page with no panels on it. */
    return out.length ? out : ['tattoo'];
  }

  /* An env-supplied artist may carry only the fields that vary (enabled, name),
     so fill the rest rather than rendering "undefined" at people. */
  function normaliseArtists(source) {
    var out = {};
    Object.keys(source).forEach(function (key) {
      var a = source[key] || {};
      var base = DEFAULT_ARTISTS[key] || {};
      var name = a.name || base.name || key;
      out[key] = {
        enabled: a.enabled !== undefined ? !!a.enabled : !!base.enabled,
        name: name,
        services: normaliseServices(a.services || base.services),
        headline: a.headline || base.headline || 'Tell us about the tattoo you have in mind.',
        blurb: a.blurb || base.blurb ||
          'Custom tattoo work. Share your idea and ' + name.split(' ')[0] +
          ' will follow up personally with an estimate.'
      };
    });
    return out;
  }

  var ARTISTS = normaliseArtists(
    (CFG.artists && Object.keys(CFG.artists).length) ? CFG.artists : DEFAULT_ARTISTS
  );

  /* Referral tracking. These are the `heardFrom` values that name a *person*,
     and picking one reveals the "who can we thank" input. Keep them character
     for character in sync with the <option value> attributes in index.html —
     the match is exact, and a typo here silently stops the name field from
     ever appearing.

     The artist's question is "who is sending us the most people", which a
     count of `heardFrom` cannot answer on its own: fifty rows reading
     "Friend or family" prove referrals work and name nobody. The follow-up
     field is the part that earns its place. */
  var REFERRAL_SOURCES = ['Friend or family', 'A previous client', 'Another artist or shop'];
  var OTHER_SOURCE = 'Other';

  /* Which piercings the menu prices as a pair. Everything else is sold single
     only, and offering Pair for one of those would let a client pick a
     combination with no price behind it — intake.js would then have nothing to
     quote. Keep this in step with PIERCING_PRICES in nodes/intake.js: that one
     is authoritative and holds the money, this one only decides whether a chip
     is selectable.

     The values here must match the <option value> attributes in index.html
     character for character, and both must match the framed price list in the
     shop, which is what a client compares the site against. */
  var PIERCING_PAIRS = ['Basic Lobe', 'Helix', 'Nose', 'Lip'];

  /* The menu invites "if you don't see your vision listed, just ask!", so this
     option has no price and no pair rule — Laynie quotes it by hand on the
     review page. Kept as one literal because three files have to agree on it. */
  var PIERCING_CUSTOM = 'Something else — I\'ll describe it';

  /* Where the confirmation view sends people once they've had time to read it,
     and how long that is. Both come from the environment via config.js so the
     wait can be tuned, or the redirect switched off with 0, without a deploy.

     20s is the read-then-leave budget for the confirmation copy — long enough
     to finish it twice, short enough that an abandoned tab doesn't sit on a
     dead end. Anyone who wants longer presses Stay On This Page; anyone who
     wants sooner presses the other button.

     null counts as "not set" as well as undefined: docker-entrypoint.sh writes
     `redirectSeconds: null` when the env var is absent, the same way it does
     for artists, and Number(null) is 0 — which would read as "never redirect"
     when what was meant is "no preference". */
  var HOME_URL = CFG.homeUrl || 'https://waymakerink.com';
  var REDIRECT_SECONDS = (CFG.redirectSeconds === undefined || CFG.redirectSeconds === null)
    ? 20
    : Number(CFG.redirectSeconds);

  var MAX_FILES = 5;
  var MAX_EDGE = 1600;      // px on the long edge
  var JPEG_QUALITY = 0.82;
  var MAX_ATTEMPTS = 3;
  var REQUEST_TIMEOUT_MS = 30000;   // uploads are resized first, so 30s is generous

  var DEFAULT_HINT = 'Up to ' + MAX_FILES + ' photos — inspiration, placement, or existing work.';
  var PIERCING_HINT = 'Optional — a photo of the spot, or a piercing you like the look of.';
  /* Not phrased as optional, because for a touch up it effectively is not:
     the artist is being asked to price work they cannot see. The form still
     accepts a submission without one — refusing would just lose the request —
     but the copy stops short of calling it optional. */
  var TOUCHUP_HINT = 'Please add a clear, well-lit photo of the tattoo as it looks now.';

  /* Chosen reference images, resized and ready to send. Declared up here
     rather than beside the other form state further down because initForm()
     runs before that statement does, and the hint copy reads its length. */
  var picked = [];

  /* ------------------------------------------------------------------ views */

  var views = {
    chooser: document.querySelector('[data-view="chooser"]'),
    form: document.querySelector('[data-view="form"]'),
    unavailable: document.querySelector('[data-view="unavailable"]'),
    done: document.querySelector('[data-view="done"]')
  };

  function show(name) {
    Object.keys(views).forEach(function (k) {
      if (views[k]) views[k].hidden = k !== name;
    });
  }

  /* ---------------------------------------------------------------- routing */

  function enabledKeys() {
    return Object.keys(ARTISTS).filter(function (k) { return ARTISTS[k].enabled; });
  }

  /* What the URL asked for, whether or not it's a real or live artist.
     Distinguishing "asked for nobody" from "asked for someone unavailable" is
     the whole point — see the routing block below. */
  function requestedKey() {
    var seg = window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
    seg = seg.replace(/\.html?$/i, '').toLowerCase();
    if (seg) return seg;

    var qs = new URLSearchParams(window.location.search).get('artist');
    return qs ? qs.toLowerCase() : '';
  }

  var keys = enabledKeys();
  var requested = requestedKey();
  var artistKey = null;

  if (requested) {
    /* The URL named someone. Honour it only if they're live — never redirect
       to a different artist. Falling through to "the only enabled artist"
       is how /laynie ends up filing requests against Nic, silently. */
    if (ARTISTS[requested] && ARTISTS[requested].enabled) {
      artistKey = requested;
    } else {
      renderUnavailable(requested);
      return;
    }
  } else if (keys.length === 1) {
    /* Bare "/" with a single artist live goes straight to them rather than
       showing a one-card chooser. Nobody was named, so nothing is overridden. */
    artistKey = keys[0];
  } else {
    renderChooser();
    return;
  }

  var artist = ARTISTS[artistKey];
  initForm();

  /* ----------------------------------------------------------- unavailable */

  function renderUnavailable(requestedName) {
    var known = ARTISTS[requestedName];
    var title = document.querySelector('[data-unavailable-title]');
    var body = document.querySelector('[data-unavailable-body]');

    if (title) {
      title.textContent = known
        ? known.name + ' isn\'t taking requests right now.'
        : 'We couldn\'t find that artist.';
    }

    /* Built as nodes rather than a string: the names come from WM_ARTISTS,
       and a link the visitor can actually follow is the difference between
       a redirect they didn't ask for and a dead end. */
    if (body) {
      body.textContent = '';

      if (!keys.length) {
        body.textContent = 'Appointment requests are closed at the moment. Please check back soon.';
      } else {
        body.appendChild(document.createTextNode('You can request an appointment with '));
        keys.forEach(function (k, i) {
          if (i > 0) {
            body.appendChild(document.createTextNode(i === keys.length - 1 ? ' or ' : ', '));
          }
          var a = document.createElement('a');
          a.href = '/' + k;
          a.textContent = ARTISTS[k].name;
          body.appendChild(a);
        });
        body.appendChild(document.createTextNode(' instead.'));
      }
    }

    document.title = 'WayMaker Ink Appointment Request — Not Available';
    show('unavailable');
  }

  /* --------------------------------------------------------------- chooser */

  function renderChooser() {
    var grid = document.querySelector('[data-chooser-grid]');
    grid.innerHTML = '';
    keys.forEach(function (key, i) {
      var a = document.createElement('a');
      a.className = 'wm-card';
      a.href = '/' + key;
      a.innerHTML =
        '<h2></h2><p></p>' +
        '<div class="wm-card-meta"><span>Begin Request</span><span>0' + (i + 1) + ' / Artist</span></div>';
      a.querySelector('h2').textContent = ARTISTS[key].name;
      a.querySelector('p').textContent = ARTISTS[key].blurb;
      grid.appendChild(a);
    });
    show('chooser');
  }

  /* ------------------------------------------------------------------ form */

  var form, els, progressBar;

  function makeRequestRid() {
    return 'WMI-' + Date.now().toString(36).toUpperCase() + '-' +
           Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  function initForm() {
    form = document.querySelector('[data-booking-form]');

    els = {
      error: form.querySelector('[data-form-error]'),
      status: form.querySelector('[data-status]'),
      submit: form.querySelector('[data-submit]'),
      progress: form.querySelector('[data-progress]'),
      artistKey: form.querySelector('[data-artist-key]'),
      artistName: form.querySelector('[data-artist-name]'),
      artistDisplay: form.querySelector('[data-artist-display]'),
      submittedAt: form.querySelector('[data-submitted-at]'),
      pageUrl: form.querySelector('[data-page-url]'),
      requestRid: form.querySelector('[data-request-rid]'),
      hp: form.querySelector('[data-hp]'),
      refs: form.querySelector('[data-refs]'),
      refsInput: form.querySelector('[data-refs-input]'),
      refsGrid: form.querySelector('[data-refs-grid]'),
      refsHint: form.querySelector('[data-refs-hint]'),
      redirect: document.querySelector('[data-redirect]'),
      redirectNote: document.querySelector('[data-redirect-note]'),
      redirectSr: document.querySelector('[data-redirect-sr]'),
      redirectNow: document.querySelector('[data-redirect-now]'),
      redirectCancel: document.querySelector('[data-redirect-cancel]'),
      heardFrom: form.querySelector('[data-heard-from]'),
      referralField: form.querySelector('[data-referral-field]'),
      referredBy: form.querySelector('[data-referred-by]'),
      referralLabel: form.querySelector('[data-referral-label]'),
      referralNote: form.querySelector('[data-referral-note]'),
      headline: document.querySelector('[data-headline]'),
      subtitle: document.querySelector('[data-subtitle]'),
      doneBody: document.querySelector('[data-done-body]'),

      /* service */
      /* document, not form: the hero and its chips are a sibling of the
         <form>, so a form-scoped query finds nothing. */
      serviceField: document.querySelector('[data-service-field]'),
      serviceInputs: [].slice.call(document.querySelectorAll('[data-service]')),
      serviceValue: form.querySelector('[data-service-value]'),
      serviceEchoField: form.querySelector('[data-service-echo-field]'),
      serviceEcho: form.querySelector('[data-service-echo]'),
      panels: {
        tattoo: form.querySelector('[data-panel="tattoo"]'),
        piercing: form.querySelector('[data-panel="piercing"]'),
        touchup: form.querySelector('[data-panel="touchup"]'),
        guardian: form.querySelector('[data-panel="guardian"]'),
        references: form.querySelector('[data-panel="references"]')
      },

      /* age and the guardian branch */
      ageField: form.querySelector('[data-age-field]'),
      ageInputs: [].slice.call(form.querySelectorAll('[data-age]')),
      ageNote: form.querySelector('[data-age-note]'),
      tattooMinorStop: form.querySelector('[data-tattoo-minor-stop]'),
      minorPiercingLine: form.querySelector('[data-minor-piercing-line]'),
      switchToPiercing: form.querySelector('[data-switch-to-piercing]'),
      firstTimeField: form.querySelector('[data-first-time-field]'),
      firstTimeLabel: form.querySelector('[data-first-time-label]'),
      adultConsent: form.querySelector('[data-adult-consent]'),
      ageConfirm: form.querySelector('#age-confirm'),
      guardianConsent: form.querySelector('#guardian-consent'),

      /* piercing */
      piercingType: form.querySelector('[data-piercing-type]'),
      pairChip: form.querySelector('[data-pair-chip]'),
      pairInput: form.querySelector('[data-pair]'),
      countInputs: [].slice.call(form.querySelectorAll('[data-count]')),
      countNote: form.querySelector('[data-count-note]'),
      refsLabel: form.querySelector('[data-refs-label]'),
      actions: form.querySelector('[data-actions]')
    };
    progressBar = els.progress.querySelector('i');

    /* One id per page load, held across retries. Without it the intake node
       mints a fresh rid per request, so a resent submission appends a second
       row under a different id rather than a detectable duplicate. */
    if (els.requestRid && !els.requestRid.value) {
      els.requestRid.value = makeRequestRid();
    }

    els.artistKey.value = artistKey;
    els.artistName.value = artist.name;
    els.artistDisplay.textContent = artist.name;
    els.headline.textContent = artist.headline;
    els.refsHint.textContent = DEFAULT_HINT;
    document.title = 'WayMaker Ink Appointment Request — ' + artist.name;

    /* Progressive enhancement: a plain POST still lands if this script fails. */
    form.setAttribute('action', WEBHOOK_URL);
    form.setAttribute('method', 'post');
    form.setAttribute('enctype', 'multipart/form-data');

    bindUploads();
    bindReferral();
    bindService();
    bindValidation();
    form.addEventListener('submit', onSubmit);

    show('form');
  }

  /* --------------------------------------------------------------- service */

  /* 'tattoo' or 'piercing'. Only ever written by syncService(), which is the
     single place that decides what the form currently is. */
  var service = 'tattoo';

  function offers(name) {
    return artist.services.indexOf(name) !== -1;
  }

  /* The URL may ask for a service, so a piercing-specific link can go in a bio.
     An artist who doesn't offer it gets their default rather than an error —
     the request would be refused by intake anyway, and a stale link in a bio
     should land somewhere usable. */
  function requestedService() {
    var asked = String(new URLSearchParams(window.location.search).get('service') || '')
      .trim().toLowerCase().replace(/[\s-]/g, '');
    /* `?service=touch-up` and `?service=touch%20up` both land on 'touchup'
       after that replace — the hyphenated spelling is what anyone writing a
       link by hand reaches for. */
    if (ALL_SERVICES.indexOf(asked) !== -1 && offers(asked)) return asked;
    return artist.services[0];
  }

  function bindService() {
    var multi = artist.services.length > 1;

    /* One service means the page looks exactly as it does today: no chips, no
       echo, no age row, and the artist's own headline. This is the regression
       surface for Nic, so it is a visibility decision made once, here. */
    els.serviceField.hidden = !multi;
    els.serviceEchoField.hidden = !multi;
    els.ageField.hidden = !offers('piercing');

    els.serviceInputs.forEach(function (input) {
      /* The machine key off the data attribute, NOT the label lowercased —
         "Touch Up" would give 'touch up', which matches no artist's services
         entry and would hide a chip the artist actually offers. */
      var value = input.getAttribute('data-service');
      var offered = offers(value);

      /* Removed from the page, not greyed out. The same rule the under-18 ink
         path follows below: a control you are not allowed to use is worse to
         read past than one that isn't there. Pair is the deliberate exception
         — it is disabled rather than hidden because a note points at it and
         the row would reflow under the thumb every time the picker changes.
         Neither applies here: `services` is fixed for the whole visit, so
         there is nothing to reflow, and "Laynie doesn't do touch ups" is not
         a sentence worth putting on her form.

         The markup carries all three chips because it is static; which of
         them is real is an artist-by-artist question only this can answer. */
      if (input.parentNode) input.parentNode.hidden = !offered;
      /* Belt and braces: also keeps it out of tab order and off the
         radiogroup as far as assistive tech is concerned. */
      input.disabled = !offered;

      input.addEventListener('change', function () {
        if (input.checked) syncService(value);
      });
    });

    els.ageInputs.forEach(function (input) {
      input.addEventListener('change', function () { if (input.checked) syncService(service); });
    });

    if (els.switchToPiercing) {
      els.switchToPiercing.addEventListener('click', function () {
        setService('piercing');
        if (els.serviceField && !els.serviceField.hidden) {
          els.serviceField.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }

    if (els.piercingType) {
      els.piercingType.addEventListener('change', syncPairAvailability);
    }

    /* The markup ships with the piercing and guardian panels hidden but their
       inputs enabled, so without this first pass a tattoo request would carry
       `jewelry=Studio` and `piercingCount=Single`. setPanel() only acts on a
       change of visibility, and for these two there is none. */
    Object.keys(els.panels).forEach(function (name) {
      var panel = els.panels[name];
      if (!panel) return;
      panelInputs(panel).forEach(function (el) { el.disabled = panel.hidden; });
    });

    setService(requestedService());
  }

  function setService(next) {
    /* Resolve before painting the chips, not after. syncService() clamps to
       what the artist offers, so passing it a service they don't would leave
       every chip unchecked while `service` quietly held something else — the
       markup hardcodes `checked` on Tattoo, which is the wrong one to fall
       back to for a piercing-only artist. */
    var resolved = offers(next) ? next : artist.services[0];
    els.serviceInputs.forEach(function (input) {
      input.checked = input.getAttribute('data-service') === resolved;
    });
    syncService(resolved);
  }

  function isMinor() {
    var checked = els.ageInputs.filter(function (i) { return i.checked; })[0];
    return !!checked && checked.value === 'Yes';
  }

  function syncService(next) {
    /* Clamped to what THIS artist offers, not merely to a service that exists.
       The hero radios live outside the <form> (see index.html) so they are
       never serialised — the hidden `service` input written below is the only
       value the request carries, which makes this the one place an unoffered
       service can be kept out of it. Falling back to the artist's own default
       rather than the literal 'tattoo': that assumption breaks on the first
       piercing-only artist. */
    service = offers(next) ? next : artist.services[0];

    /* The submitted value. Written the way a person writes it because the
       portal shows it to one — the intake function normalises it back to a key
       before it reaches the database. */
    els.serviceValue.value = SERVICE_SUBMIT[service];

    var minor = !els.ageField.hidden && isMinor();
    /* Under 18 blocks tattoo AND touch up. A touch up is still a tattoo; the
       needle does not care that the work is already there. */
    var blockedInk = INK_SERVICES.indexOf(service) !== -1 && minor;

    /* Panels. Hiding is not enough on its own — a hidden input is still inside
       the <form>, so FormData ships it and a piercing row lands carrying a
       tattoo size. Same rule syncReferral() already applies to referredBy, and
       the same bug it was fixed for. */
    setPanel(els.panels.tattoo, service === 'tattoo' && !blockedInk);
    setPanel(els.panels.piercing, service === 'piercing');
    setPanel(els.panels.touchup, service === 'touchup' && !blockedInk);
    setPanel(els.panels.guardian, service === 'piercing' && minor);

    /* Under 18 + ink is a hard no. Hide the rest of the form rather than
       disabling it: a form you are not allowed to submit is worse to scroll
       than one that isn't there. */
    els.tattooMinorStop.hidden = !blockedInk;
    /* A touch up is by definition not anyone's first tattoo. Asking is noise,
       and an answer of "No" that nobody chose is worse than no answer. */
    els.firstTimeField.hidden = blockedInk || service === 'touchup';
    setPanel(els.panels.references, !blockedInk);
    els.actions.hidden = blockedInk;

    /* The door only exists if she actually offers it. */
    if (els.minorPiercingLine) els.minorPiercingLine.hidden = !offers('piercing');
    if (els.switchToPiercing) els.switchToPiercing.hidden = !offers('piercing');

    /* One consent, not two: a guardian who has signed for a minor is not also
       asked to confirm their own age. */
    var guardianCovers = service === 'piercing' && minor;
    els.adultConsent.hidden = guardianCovers;
    els.ageConfirm.required = !guardianCovers;
    if (guardianCovers) {
      els.ageConfirm.checked = false;
      mark(els.ageConfirm, false);
    }

    syncCopy(minor, blockedInk);
    syncPairAvailability();
  }

  /* Hide a panel, empty it, and take it out of the submission.
     Emptying alone is not enough for the chip rows: a radio with a checked
     default still serialises while hidden, so a piercing request would carry
     `style=Black & grey` and a tattoo request `jewelry=Studio`. Disabling is
     what actually removes a control from FormData. */
  function setPanel(panel, visible) {
    if (!panel) return;
    if (panel.hidden === !visible) return;   /* no change, nothing to do */
    panel.hidden = !visible;

    panelInputs(panel).forEach(function (el) {
      if (!visible) {
        if (el.type === 'radio' || el.type === 'checkbox') {
          /* defaultChecked rather than false, so a re-shown panel reads the
             way a fresh page does instead of arriving with nothing picked. */
          el.checked = el.defaultChecked;
        } else {
          el.value = '';
        }
        mark(el, false);
      }
      el.disabled = !visible;
    });

    /* Re-applying the menu's single-only rule, which the blanket re-enable
       above would otherwise undo. */
    if (visible) syncPairAvailability();
  }

  function panelInputs(panel) {
    return [].slice.call(panel.querySelectorAll('input, select, textarea'))
      .filter(function (el) { return el.type !== 'hidden'; });
  }

  function syncCopy(minor, blockedInk) {
    var piercing = service === 'piercing';
    var touchup = service === 'touchup';
    var first = artist.name.split(' ')[0];

    if (els.serviceEcho) els.serviceEcho.textContent = SERVICE_SUBMIT[service];

    /* The headline never moves for a single-service artist. */
    if (artist.services.length > 1) {
      els.headline.textContent = 'What brings you in?';
      els.subtitle.textContent = piercing
        ? 'Tell ' + first + ' what you\'d like pierced and she\'ll follow up by email with the price and a link to book.'
        : touchup
          ? 'Show ' + first + ' the work that needs freshening up and she\'ll follow up by email with what it takes and a link to book.'
          : 'Every piece starts with a conversation. Share your idea below and ' + first +
            ' will review it personally, then follow up by email with a time estimate, a price, and a link to book.';
    }

    document.title = 'WayMaker Ink ' +
      (piercing ? 'Piercing' : touchup ? 'Touch Up' : 'Appointment') +
      ' Request — ' + artist.name;

    els.firstTimeLabel.textContent = piercing
      ? (minor ? 'Is This Their First Piercing?' : 'Is This Your First Piercing?')
      : 'Is This Your First Tattoo?';

    els.ageNote.textContent = piercing
      ? 'Under 18 is welcome for piercings with a parent or legal guardian present.'
      : 'Tattoo services are available to clients 18 and older only.';
    els.ageNote.hidden = blockedInk;

    els.refsHint.textContent = picked.length
      ? picked.length + ' of ' + MAX_FILES + ' added. Photos are resized before sending.'
      : emptyRefsHint();
  }

  /* Pair is selectable only for the piercings the menu prices as a pair. */
  function syncPairAvailability() {
    if (!els.piercingType || !els.pairInput) return;

    /* A hidden panel's inputs are disabled to keep them out of FormData, and
       re-enabling one here would put `piercingCount` on every tattoo row. */
    if (els.panels.piercing.hidden) return;

    var type = els.piercingType.value;
    var pairable = !type || type === PIERCING_CUSTOM || PIERCING_PAIRS.indexOf(type) !== -1;

    els.pairInput.disabled = !pairable;
    els.pairChip.classList.toggle('is-disabled', !pairable);
    els.countNote.hidden = pairable;

    /* Falling back to Single rather than leaving a disabled radio checked: a
       disabled input is not serialised, so the row would reach the sheet with
       no piercingCount and the review page could not price itself. */
    if (!pairable && els.pairInput.checked) {
      els.countInputs.forEach(function (i) { i.checked = i.value === 'Single'; });
    }
  }

  /* -------------------------------------------------------------- referral */

  /* What the referral input last meant: 'person', 'other', or 'none'. */
  var referralMode = 'none';

  function bindReferral() {
    els.heardFrom.addEventListener('change', syncReferral);
    syncReferral();   /* also covers a browser restoring a value on reload */
  }

  function syncReferral() {
    var value = els.heardFrom.value;
    var isPerson = REFERRAL_SOURCES.indexOf(value) !== -1;
    var mode = isPerson ? 'person' : (value === OTHER_SOURCE ? 'other' : 'none');

    /* Clear whenever the box stops meaning what it meant, which is a wider net
       than "whenever it hides":

         person → none    someone types "Marisol", switches to Instagram. The
                          input is out of sight but still inside the <form>, so
                          FormData files that name against an Instagram row.
         other  → person  "heard it on a podcast" stays on screen and becomes
                          the answer to "who can we thank" — a sentence lands in
                          the referral column and shows up in the leaderboard as
                          a person who does not exist.

       person → person is deliberately kept: same name, different relationship,
       and retyping it would just be rude. */
    if (mode !== referralMode && !(mode === 'person' && referralMode === 'person')) {
      els.referredBy.value = '';
      mark(els.referredBy, false);
    }
    referralMode = mode;

    els.referralField.hidden = mode === 'none';

    /* Required exactly while it is on screen. Asking a question and accepting
       no answer is what let 'A previous client' through with an empty name;
       carrying `required` on a hidden input is the other failure, so the two
       are tied to the same condition rather than set independently.

       validate() reads `hidden`, not this attribute — the form is `novalidate`,
       so this is for assistive tech and for anything that inspects the DOM. */
    els.referredBy.required = !els.referralField.hidden;

    if (els.referralField.hidden) return;

    /* One input, two jobs — heardFrom is what tells them apart downstream. */
    els.referralLabel.textContent = isPerson ? 'Who Can We Thank?' : 'Where Did You Find Us?';
    els.referredBy.placeholder = isPerson ? 'Their name' : 'Podcast, magazine, someone’s recommendation…';
    els.referralNote.textContent = isPerson
      ? 'It’s how we thank the people who send folks our way.'
      : 'It helps us know where to show up next.';
  }

  /* --------------------------------------------------------------- uploads */

  function bindUploads() {
    els.refsInput.addEventListener('change', function () {
      accept(els.refsInput.files);
      els.refsInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (t) {
      els.refs.addEventListener(t, function (e) {
        e.preventDefault();
        els.refs.classList.add('is-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      els.refs.addEventListener(t, function (e) {
        e.preventDefault();
        els.refs.classList.remove('is-over');
      });
    });
    els.refs.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) accept(e.dataTransfer.files);
    });
  }

  function accept(list) {
    var images = Array.prototype.slice.call(list).filter(function (f) {
      return /^image\//.test(f.type);
    });

    var room = MAX_FILES - picked.length;
    if (room <= 0) {
      setStatus('You can attach up to ' + MAX_FILES + ' images.', true);
      return;
    }

    images.slice(0, room).forEach(function (file) {
      resize(file)
        .then(add)
        .catch(function () { add(file); }); // keep the original if canvas fails
    });
  }

  function resize(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();

      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale);
        var h = Math.round(img.height * scale);

        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);

        canvas.toBlob(function (blob) {
          blob ? resolve(blob) : reject(new Error('encode'));
        }, 'image/jpeg', JPEG_QUALITY);
      };

      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('decode'));
      };

      img.src = url;
    });
  }

  function add(blob) {
    picked.push({ blob: blob, url: URL.createObjectURL(blob), size: blob.size });
    renderRefs();
  }

  function humanSize(bytes) {
    return bytes < 1024 * 1000
      ? Math.round(bytes / 1024) + ' KB'
      : (bytes / 1048576).toFixed(1) + ' MB';
  }

  function renderRefs() {
    els.refsGrid.innerHTML = '';

    picked.forEach(function (item, index) {
      var cell = document.createElement('div');
      cell.className = 'wm-ref-item';

      var img = document.createElement('img');
      img.src = item.url;
      img.alt = 'Reference image ' + (index + 1);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'wm-ref-remove';
      remove.setAttribute('aria-label', 'Remove reference image ' + (index + 1));
      remove.textContent = '×';
      remove.addEventListener('click', function () {
        URL.revokeObjectURL(item.url);
        picked.splice(index, 1);
        renderRefs();
      });

      var size = document.createElement('span');
      size.className = 'wm-ref-size';
      size.textContent = humanSize(item.size);

      cell.appendChild(img);
      cell.appendChild(remove);
      cell.appendChild(size);
      els.refsGrid.appendChild(cell);
    });

    els.refsHint.textContent = picked.length
      ? picked.length + ' of ' + MAX_FILES + ' added. Photos are resized before sending.'
      : emptyRefsHint();
  }

  /* Removing the last photo has to restore the hint the CURRENT service asked
     for, not the tattoo one. This used to hardcode DEFAULT_HINT, so a piercing
     client who added a photo and thought better of it was told to attach
     inspiration for a tattoo. */
  function emptyRefsHint() {
    if (service === 'piercing') return PIERCING_HINT;
    if (service === 'touchup') return TOUCHUP_HINT;
    return DEFAULT_HINT;
  }

  /* ------------------------------------------------------------ validation */

  /* Asked on every request, whatever the service. */
  var REQUIRED_ALWAYS = [
    ['first-name', 'first name'],
    ['last-name', 'last name'],
    ['email', 'email address'],
    ['heard-from', 'how you heard about us']
  ];

  var REQUIRED_TATTOO = [
    ['idea', 'description of your idea'],
    ['placement', 'placement'],
    ['size', 'approximate size']
  ];

  var REQUIRED_PIERCING = [
    ['piercing-type', 'which piercing you\'d like']
  ];

  /* Placement and age are not required: the photo usually answers both, and an
     extra required field on a form someone is filling in one-handed at the end
     of the day costs more requests than it saves questions. */
  var REQUIRED_TOUCHUP = [
    ['touchup-details', 'what needs touching up']
  ];

  var REQUIRED_GUARDIAN = [
    ['minor-first', 'their first name'],
    ['minor-last', 'their last name'],
    ['minor-age', 'their age'],
    ['guardian-rel', 'your relationship to them']
  ];

  /* Which lists apply right now. Driven by what is on screen rather than by
     `service` directly, so this and syncService() cannot drift: one of them
     decides what the form is asking, the other just reads that decision. */
  function requiredNow() {
    var list = REQUIRED_ALWAYS.slice();
    if (!els.panels.tattoo.hidden) list = list.concat(REQUIRED_TATTOO);
    if (!els.panels.piercing.hidden) list = list.concat(REQUIRED_PIERCING);
    if (!els.panels.touchup.hidden) list = list.concat(REQUIRED_TOUCHUP);
    if (!els.panels.guardian.hidden) list = list.concat(REQUIRED_GUARDIAN);
    return list;
  }

  function mark(el, on) {
    if (!el) return;
    el.classList.toggle('wm-invalid', on);
    el.setAttribute('aria-invalid', on ? 'true' : 'false');
  }

  function bindValidation() {
    ['input', 'change'].forEach(function (evt) {
      form.addEventListener(evt, function (e) {
        if (e.target.classList && e.target.classList.contains('wm-invalid')) mark(e.target, false);
      });
    });
  }

  function validate() {
    var missing = [];
    var firstBad = null;

    requiredNow().forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      var bad = !el || !el.value.trim();
      mark(el, bad);
      if (bad) {
        missing.push(pair[1]);
        firstBad = firstBad || el;
      }
    });

    /* Conditional, so it can't sit in REQUIRED with the rest. The test is
       "is the box on screen", not "is heardFrom a person source", so this and
       syncReferral can't drift apart — one of them decides when the field is a
       question and the other just reads that decision. */
    var referralMissing = !els.referralField.hidden && !els.referredBy.value.trim();
    mark(els.referredBy, referralMissing);
    if (referralMissing) {
      missing.push(referralMode === 'person' ? 'the name of whoever sent you' : 'where you found us');
      firstBad = firstBad || els.referredBy;
    }

    var email = document.getElementById('email');
    if (email.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
      mark(email, true);
      missing.push('a valid email address');
      firstBad = firstBad || email;
    }

    /* Exactly one consent is ever on screen: the adult's own 18+ box, or the
       guardian's. Testing visibility rather than service keeps this tied to
       the same decision syncService() already made. */
    if (!els.adultConsent.hidden && !els.ageConfirm.checked) {
      mark(els.ageConfirm, true);
      missing.push('confirmation that you are 18 or older');
      firstBad = firstBad || els.ageConfirm;
    }

    if (!els.panels.guardian.hidden && !els.guardianConsent.checked) {
      mark(els.guardianConsent, true);
      missing.push('your consent as their parent or legal guardian');
      firstBad = firstBad || els.guardianConsent;
    }

    if (missing.length) {
      els.error.textContent = 'Please complete the following before submitting: ' + missing.join(', ') + '.';
      els.error.hidden = false;
      if (firstBad) firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }

    els.error.hidden = true;
    return true;
  }

  /* ---------------------------------------------------------------- submit */

  function setStatus(msg, isError) {
    els.status.textContent = msg || '';
    els.status.classList.toggle('is-error', !!isError);
  }

  function setProgress(pct) {
    els.progress.hidden = false;
    progressBar.style.width = pct + '%';
  }

  function onSubmit(e) {
    e.preventDefault();

    /* ⚠ The honeypot is NOT checked here any more, and `company` is no longer
       deleted from the payload below.

       It used to be both: app.js faked success and stripped the field, so the
       server-side check never saw anything and a bot POSTing straight at the
       endpoint was unfiltered — the one defence that mattered was the one that
       could not run. The field now travels, and the intake function decides.
       It returns a 200 with no row written, so a bot sees exactly what it saw
       before. */

    if (!validate()) {
      setStatus('Some required fields still need attention.', true);
      return;
    }

    els.submittedAt.value = new Date().toISOString();
    els.pageUrl.value = window.location.href;

    var data = new FormData(form);
    picked.forEach(function (item, i) {
      data.append('reference' + (i + 1), item.blob, 'reference-' + (i + 1) + '.jpg');
    });
    data.append('referenceCount', String(picked.length));

    els.submit.disabled = true;
    setProgress(15);
    setStatus('Sending your request…');

    send(data, 0);
  }

  function send(data, attempt) {
    setProgress(30 + attempt * 20);

    /* Without a deadline a stalled connection never settles the promise: no
       success, no catch, and the client sits on "Sending…" with the button
       disabled indefinitely. AbortController turns that into an ordinary
       failure the retry path can handle. */
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = window.setTimeout(function () {
      if (controller) controller.abort();
    }, REQUEST_TIMEOUT_MS);

    var opts = { method: 'POST', body: data };
    if (controller) opts.signal = controller.signal;

    fetch(WEBHOOK_URL, opts)
      .then(function (res) {
        window.clearTimeout(timer);
        if (!res.ok) {
          var err = new Error('HTTP ' + res.status);
          err.status = res.status;
          throw err;
        }
        setProgress(100);
        window.setTimeout(succeed, 280);
      })
      .catch(function (err) {
        window.clearTimeout(timer);

        /* A 4xx is the server rejecting the payload — the same bytes will be
           rejected again. Only network faults, timeouts and 5xx are worth a
           second attempt. */
        var worthRetrying = !err || !err.status || err.status >= 500;

        if (worthRetrying && attempt < MAX_ATTEMPTS - 1) {
          setStatus('Connection hiccup — retrying…');
          window.setTimeout(function () { send(data, attempt + 1); }, Math.pow(2, attempt) * 1200);
          return;
        }

        els.progress.hidden = true;
        els.submit.disabled = false;
        setStatus(worthRetrying
          ? 'We couldn\'t send that request. Check your connection and try again.'
          : 'Something in that request wasn\'t accepted. Please review your details and try again.', true);
      });
  }

  function succeed() {
    /* Says only what actually happens. Workflow A emails the artist, not the
       client — promising the client a confirmation they never receive sends
       them to their spam folder looking for nothing. */
    els.doneBody.textContent =
      artist.name + ' will review your idea personally and follow up by email ' +
      'with a time estimate, a price, and a link to book.';
    show('done');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    startRedirect();
  }

  /* ------------------------------------------------------- auto-return home */

  var redirectTimer = null;

  function hostOf(url) {
    /* Shown to the client, so "waymakerink.com" rather than the full URL.
       URL() is unavailable in a few older mobile browsers this form still
       loads in, hence the fallback rather than a bare constructor call. */
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }
  }

  function startRedirect() {
    var remaining = REDIRECT_SECONDS;
    var host = hostOf(HOME_URL);

    els.redirectNow.href = HOME_URL;

    /* A non-finite or non-positive value means "don't". Covers
       WM_REDIRECT_SECONDS=0 as an explicit off switch, and also a typo'd value
       that arrives as NaN — leaving people on the confirmation is the safe
       failure, so it is what an unreadable setting gets. */
    if (!isFinite(remaining) || remaining <= 0) return;

    els.redirect.hidden = false;

    /* Announced once. The visible line below re-renders every second, which is
       why it is aria-hidden — a screen reader reciting a countdown drowns out
       everything else on the page. */
    els.redirectSr.textContent =
      'This page will return to ' + host + ' automatically. ' +
      'Use the Stay On This Page button to remain here.';

    els.redirectCancel.addEventListener('click', stopRedirect);
    /* Leaving early should not leave a timer running behind the click. */
    els.redirectNow.addEventListener('click', stopRedirect);

    render();
    redirectTimer = window.setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) {
        stopRedirect();
        /* replace() rather than assign(): the confirmation lives at the form's
           own URL, so a history entry would send Back to a blank form that
           looks like the submission was lost. */
        window.location.replace(HOME_URL);
        return;
      }
      render();
    }, 1000);

    function render() {
      els.redirectNote.textContent =
        'Returning to ' + host + ' in ' + remaining + ' second' + (remaining === 1 ? '' : 's') + '.';
    }
  }

  function stopRedirect() {
    if (redirectTimer === null) return;
    window.clearInterval(redirectTimer);
    redirectTimer = null;
    els.redirectNote.textContent = '';
    els.redirectSr.textContent = '';
    els.redirectCancel.hidden = true;   /* nothing left to cancel */
  }
})();
