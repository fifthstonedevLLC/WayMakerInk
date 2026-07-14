document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('js-ready');

  // ---- Patient name / initials ----------------------------------------------
  // Provisions are initialed with the patient's first + last initial so the
  // generated PDF carries real initials instead of a generic checkmark.
  const firstEl = document.querySelector('[data-firstname]');
  const lastEl = document.querySelector('[data-lastname]');

  const getInitials = () => {
    const f = (firstEl && firstEl.value.trim()) || '';
    const l = (lastEl && lastEl.value.trim()) || '';
    return (f ? f[0].toUpperCase() : '') + (l ? l[0].toUpperCase() : '');
  };
  // The mark shown inside an initialed provision: real initials once the name
  // is entered, otherwise a checkmark so the selection is always visible.
  const getMark = () => getInitials() || '✓';
  const getFullName = () => {
    const f = (firstEl && firstEl.value.trim()) || '';
    const l = (lastEl && lastEl.value.trim()) || '';
    return [f, l].filter(Boolean).join(' ');
  };
  const refreshNames = () => {
    const full = getFullName();
    const initials = getInitials();
    // Fill the name into The Agreement (display + hidden value).
    document.querySelectorAll('[data-fullname]').forEach((el) => {
      if (el.tagName === 'INPUT') el.value = full;
      else el.textContent = full || '—';
    });
    // Keep any already-initialed provisions in sync with the current initials.
    document.querySelectorAll('.wm-toggle.is-checked .wm-toggle-mark').forEach((mark) => {
      mark.textContent = initials || '✓';
    });
  };
  if (firstEl) firstEl.addEventListener('input', refreshNames);
  if (lastEl) lastEl.addEventListener('input', refreshNames);

  document.querySelectorAll('.wm-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('is-checked');
      toggle.classList.remove('is-missing');
      const mark = toggle.querySelector('.wm-toggle-mark');
      if (mark) {
        mark.textContent = toggle.classList.contains('is-checked') ? getMark() : '';
      }
    });
  });

  refreshNames();

  document.querySelectorAll('.wm-field input, .wm-field textarea, .wm-field select').forEach((field) => {
    const setState = () => field.classList.toggle('is-filled', field.value.trim() !== '');
    field.addEventListener('input', setState);
    field.addEventListener('change', setState);
    setState();
  });

  // Signing date is always today — set the hidden value and the display text.
  const today = new Date();
  const iso = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  const pretty = today.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  document.querySelectorAll('input[data-autodate]').forEach((input) => {
    input.value = iso;
  });
  document.querySelectorAll('[data-today]').forEach((el) => {
    el.textContent = pretty;
  });

  // ---- Under-18 / minor consent toggle --------------------------------------
  // The piercing form asks up front whether the client is under 18. The minor
  // consent section stays hidden (and its fields inert) until "Yes" is chosen.
  const minorToggle = document.querySelector('[data-minor-toggle]');
  const minorSection = document.querySelector('[data-minor-section]');
  const syncMinorSection = () => {
    if (!minorSection) return;
    const show = minorToggle && minorToggle.value === 'yes';
    minorSection.hidden = !show;
    // Keep required fields from blocking submit while the section is hidden.
    minorSection.querySelectorAll('[data-req-when-minor]').forEach((el) => {
      if (show) el.setAttribute('required', '');
      else el.removeAttribute('required');
    });
    // The guardian signature canvas is sized from its rendered dimensions.
    // While the section was hidden that measured 0×0, so re-fit the pads now
    // that it's visible — otherwise the canvas can't be drawn on.
    if (show) window.dispatchEvent(new Event('resize'));
  };
  if (minorToggle) {
    minorToggle.addEventListener('change', syncMinorSection);
    syncMinorSection();
  }

  // Draw-to-sign signature pads.
  document.querySelectorAll('.wm-signature').forEach(setupSignaturePad);

  // ---- Submit to n8n --------------------------------------------------------
  // Paste the Production URL from your n8n Webhook node here:
  const WEBHOOK_URL = 'https://n8n.fifthstonedev.com/webhook/5b254e31-9438-4a28-bfbb-8991d8bf1cd0';

  const form = document.querySelector('.wm-form');
  const submitBtn = form ? form.querySelector('button[type="submit"]') : null;

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      // Collect all named inputs (firstName, lastName, dob, signature, etc.).
      const data = Object.fromEntries(new FormData(form).entries());

      // Collect each initialed provision so the PDF can show what was agreed to.
      data.provisions = Array.from(document.querySelectorAll('.wm-provision')).map((row, i) => ({
        index: i + 1,
        text: (row.querySelector('div:last-child')?.textContent || '').trim(),
        initialed: !!row.querySelector('.wm-toggle.is-checked'),
      }));

      // Which form this is — helps n8n label the file / pick a template.
      data.formType = form.dataset.formType || 'waiver';

      // Timestamp of the electronic signature (proof for E-SIGN / UETA).
      data.signedAt = new Date().toISOString();
      // Normalize consent to explicit booleans for the record.
      data.electronicConsent = data.electronicConsent === 'yes';
      data.guardianElectronicConsent = data.guardianElectronicConsent === 'yes';

      // Minimal client-side validation.
      const missing = [];
      if (!data.firstName?.trim()) missing.push('First Name');
      if (!data.lastName?.trim()) missing.push('Last Name');
      if (!data.dob?.trim()) missing.push('Date of Birth');
      if (!data.address?.trim()) missing.push('Address');
      if (!data.city?.trim()) missing.push('City');
      if (!data.state?.trim()) missing.push('State');
      if (!data.zip?.trim()) missing.push('Zip');
      // Tattoo form uses `signature`; piercing form uses `clientSignature`.
      const signature = data.signature || data.clientSignature;
      if (!signature?.trim()) missing.push('Signature');
      if (!data.electronicConsent) missing.push('Electronic signature consent');
      // Guardian consent is required when the client is under 18, or whenever
      // any part of the minor section was filled in.
      const isMinor = data.isMinor === 'yes';
      const guardianUsed = !!(
        isMinor ||
        data.guardianName?.trim() ||
        data.guardianSignature?.trim() ||
        data.minorAge?.trim()
      );
      if (isMinor) {
        if (!data.guardianName?.trim()) missing.push("Parent/Guardian Name");
        if (!data.guardianSignature?.trim()) missing.push('Parent/Guardian Signature');
      }
      if (guardianUsed && !data.guardianElectronicConsent) {
        missing.push('Parent/Guardian electronic signature consent');
      }

      // Every provision the client can see must be initialed. Provisions inside
      // a hidden section (e.g. the minor block when the client is 18+) are skipped.
      const visibleProvisions = Array.from(document.querySelectorAll('.wm-provision'))
        .filter((row) => !row.closest('[hidden]'));
      const uninitialed = visibleProvisions.filter((row) => !row.querySelector('.wm-toggle.is-checked'));
      document.querySelectorAll('.wm-toggle.is-missing').forEach((t) => t.classList.remove('is-missing'));
      if (uninitialed.length) {
        uninitialed.forEach((row) => row.querySelector('.wm-toggle')?.classList.add('is-missing'));
        missing.push('Initials on all provisions (' + uninitialed.length + ' still not initialed)');
      }

      if (missing.length) {
        alert('Please complete: ' + missing.join(', '));
        // Bring the first outstanding provision into view.
        if (uninitialed.length) uninitialed[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      const originalLabel = submitBtn ? submitBtn.textContent : '';
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';
      }

      try {
        console.log('[waiver] POST →', WEBHOOK_URL);
        const res = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          console.error('[waiver] Webhook returned', res.status, res.statusText, bodyText);
          throw new Error('Server responded ' + res.status);
        }

        form.innerHTML =
          '<section class="wm-section"><h3>Thank you — your waiver has been submitted.</h3>' +
          '<p>A copy has been filed with WayMaker Ink. You will be redirected to the forms home page shortly.</p>' +
          '<p><a href="WayMaker Ink Forms.template.html">Return to the forms home page now</a></p></section>';

        window.setTimeout(() => {
          window.location.assign('WayMaker Ink Forms.template.html');
        }, 3000);
      } catch (err) {
        console.error('[waiver] Submit failed:', err);
        alert('Sorry, something went wrong submitting your waiver. Please try again or ask your artist for help.\n\n[debug] ' + err.message);
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
        }
      }
    });
  }

  function setupSignaturePad(pad) {
    const canvas = pad.querySelector('.wm-sig-canvas');
    const clearBtn = pad.querySelector('.wm-sig-clear');
    // The hidden input holding the signature lives just outside the pad,
    // in the enclosing .wm-field — search there, not only inside the pad.
    const scope = pad.closest('.wm-field') || pad.parentElement || pad;
    const hidden = scope.querySelector('input[type="hidden"]');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let drawing = false;
    let hasInk = false;
    let last = null;

    const resize = () => {
      // Preserve any existing drawing across a resize.
      const prev = hasInk ? canvas.toDataURL() : null;
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#f0ede8';
      if (prev) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
        img.src = prev;
      }
    };

    const pos = (event) => {
      const rect = canvas.getBoundingClientRect();
      const point = event.touches ? event.touches[0] : event;
      return { x: point.clientX - rect.left, y: point.clientY - rect.top };
    };

    const start = (event) => {
      event.preventDefault();
      drawing = true;
      last = pos(event);
    };

    const move = (event) => {
      if (!drawing) return;
      event.preventDefault();
      const p = pos(event);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      hasInk = true;
    };

    const end = () => {
      if (!drawing) return;
      drawing = false;
      if (hidden && hasInk) hidden.value = canvas.toDataURL('image/png');
      pad.classList.toggle('is-signed', hasInk);
    };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        hasInk = false;
        if (hidden) hidden.value = '';
        pad.classList.remove('is-signed');
      });
    }

    resize();
    window.addEventListener('resize', resize);
  }
});
