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

  var WEBHOOK_URL = CFG.webhookUrl ||
    window.WM_WEBHOOK_URL ||     /* older single-value config.js */
    'https://n8n.fifthstonedev.com/webhook/booking-request';

  var DEFAULT_ARTISTS = {
    nic: {
      enabled: true,
      name: 'Nic Sinnwell',
      headline: 'Tell us about the tattoo you have in mind.',
      blurb: 'Custom tattoo work. Share your idea and Nic will follow up personally with an estimate.'
    },
    laynie: {
      enabled: false, // set WM_ARTISTS in Dokploy to enable, no code change
      name: 'Laynie Flugum',
      headline: 'Tell us about the tattoo you have in mind.',
      blurb: 'Custom tattoo work. Share your idea and Laynie will follow up personally with an estimate.'
    }
  };

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

  var MAX_FILES = 5;
  var MAX_EDGE = 1600;      // px on the long edge
  var JPEG_QUALITY = 0.82;
  var MAX_ATTEMPTS = 3;
  var REQUEST_TIMEOUT_MS = 30000;   // uploads are resized first, so 30s is generous

  var DEFAULT_HINT = 'Up to ' + MAX_FILES + ' photos — inspiration, placement, or existing work.';

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

  var form, els, progressBar, picked = [];

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
      headline: document.querySelector('[data-headline]'),
      doneBody: document.querySelector('[data-done-body]')
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
    bindValidation();
    form.addEventListener('submit', onSubmit);

    show('form');
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
      : DEFAULT_HINT;
  }

  /* ------------------------------------------------------------ validation */

  var REQUIRED = [
    ['first-name', 'first name'],
    ['last-name', 'last name'],
    ['email', 'email address'],
    ['idea', 'description of your idea'],
    ['placement', 'placement'],
    ['size', 'approximate size']
  ];

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

    REQUIRED.forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      var bad = !el || !el.value.trim();
      mark(el, bad);
      if (bad) {
        missing.push(pair[1]);
        firstBad = firstBad || el;
      }
    });

    var email = document.getElementById('email');
    if (email.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
      mark(email, true);
      missing.push('a valid email address');
      firstBad = firstBad || email;
    }

    var age = document.getElementById('age-confirm');
    if (!age.checked) {
      mark(age, true);
      missing.push('confirmation that you are 18 or older');
      firstBad = firstBad || age;
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

    /* Honeypot: bots fill hidden inputs. Fake success, send nothing. */
    if (els.hp.value) { succeed(); return; }

    if (!validate()) {
      setStatus('Some required fields still need attention.', true);
      return;
    }

    els.submittedAt.value = new Date().toISOString();
    els.pageUrl.value = window.location.href;

    var data = new FormData(form);
    data.delete('company');
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
  }
})();
