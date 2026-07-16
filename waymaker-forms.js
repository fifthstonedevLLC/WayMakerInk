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
      mark.textContent = initials;
    });
  };
  if (firstEl) firstEl.addEventListener('input', refreshNames);
  if (lastEl) lastEl.addEventListener('input', refreshNames);

  document.querySelectorAll('.wm-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('is-checked');
      const mark = toggle.querySelector('.wm-toggle-mark');
      if (mark) {
        mark.textContent = toggle.classList.contains('is-checked') ? getInitials() : '';
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
  // Date-of-work fields default to today so staff/clients don't pick it, but
  // stay editable in case the procedure is scheduled for another day.
  document.querySelectorAll('input[data-defaulttoday]').forEach((input) => {
    if (!input.value) input.value = iso;
  });

  // ---- Age (calculated from DOB) + minor status -----------------------------
  // Age is never typed — it's derived from the date of birth as of today and
  // written into every read-only [data-age] field. The under-18 dropdown and
  // the guardian section follow from the same calculation.
  const computeAge = (dobStr) => {
    if (!dobStr) return null;
    const born = new Date(dobStr.length === 10 ? dobStr + 'T00:00:00' : dobStr);
    if (isNaN(born)) return null;
    const ref = new Date();
    let a = ref.getFullYear() - born.getFullYear();
    const m = ref.getMonth() - born.getMonth();
    if (m < 0 || (m === 0 && ref.getDate() < born.getDate())) a--;
    return a;
  };

  const dobEl = document.querySelector('input[name="dob"]');
  const ageEls = document.querySelectorAll('[data-age]');
  const minorSelect = document.querySelector('[data-minor-select]');
  const minorSection = document.querySelector('[data-minor-section]');
  // Tattoo form: 18+ only, so instead of a guardian section it shows a block
  // notice and refuses to submit for minors.
  const minorBlock = document.querySelector('[data-minor-block]');

  // The single license-upload field is relocated between the client section
  // (adults) and the guardian section (minors); moving the one node keeps the
  // captured photo and avoids duplicate `licenseImage` inputs.
  const licenseField = document.querySelector('[data-license-field]');
  const clientLicenseSlot = document.querySelector('[data-license-slot="client"]');
  const guardianLicenseSlot = document.querySelector('[data-license-slot="guardian"]');

  const placeLicense = (minor) => {
    if (!licenseField) return;
    const target = minor ? guardianLicenseSlot : clientLicenseSlot;
    if (target && licenseField.parentElement !== target) target.appendChild(licenseField);
  };

  // Stop message shown when the stated age status contradicts the DOB.
  const ageMismatch = document.querySelector('[data-age-mismatch]');

  let minorVisiblePrev = false;
  const setMinorVisible = (visible) => {
    const v = !!visible;
    if (minorSection) minorSection.hidden = !v;
    placeLicense(v);
    // A signature canvas sized while its section was hidden has a 1px backing
    // store and renders nothing; re-fit every pad the moment it's revealed.
    if (v && !minorVisiblePrev) {
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }
    minorVisiblePrev = v;
  };

  // True when the stated "18 or older?" answer disagrees with the DOB.
  const statusConflictsWithDob = () => {
    const age = computeAge(dobEl ? dobEl.value : '');
    const selected = minorSelect ? minorSelect.value : '';
    if (age == null || !selected) return false;
    return (selected === 'minor') !== (age < 18);
  };

  const refreshAgeState = () => {
    const age = computeAge(dobEl ? dobEl.value : '');
    ageEls.forEach((el) => {
      el.value = age == null ? '' : String(age);
      el.classList.toggle('is-filled', el.value !== '');
    });
    // Pre-select the status from the DOB only when nothing is chosen yet —
    // never silently overwrite an explicit choice; conflicts are flagged.
    if (age != null && minorSelect && !minorSelect.value) {
      minorSelect.value = age < 18 ? 'minor' : 'adult';
      minorSelect.classList.add('is-filled');
    }
    // Guardian section follows the stated status (piercing form).
    if (minorSelect) setMinorVisible(minorSelect.value === 'minor');
    // Under-18 block notice (tattoo form).
    if (minorBlock) minorBlock.hidden = !(age != null && age < 18);
    // Stop message when the stated status and the DOB disagree.
    if (ageMismatch) ageMismatch.hidden = !statusConflictsWithDob();
  };

  if (dobEl) {
    dobEl.addEventListener('input', refreshAgeState);
    dobEl.addEventListener('change', refreshAgeState);
  }
  if (minorSelect) {
    minorSelect.addEventListener('change', refreshAgeState);
  }
  refreshAgeState();

  // Draw-to-sign signature pads.
  document.querySelectorAll('.wm-signature').forEach(setupSignaturePad);

  // Driver's license photo capture (required on every waiver).
  document.querySelectorAll('.wm-license-input').forEach(setupLicenseCapture);

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
      // Both forms use `signature` for the primary signer; the piercing form
      // adds a separate `guardianSignature` for minors (handled below).
      const signature = data.signature || data.clientSignature;
      if (!signature?.trim()) missing.push('Signature');
      if (!data.licenseImage?.trim()) missing.push("Driver's License / ID photo");
      if (!data.electronicConsent) missing.push('Electronic signature consent');
      // The guardian section is required whenever the client is under 18
      // (per the age dropdown) or a guardian's details were entered anyway.
      const guardianUsed = !!(
        data.ageStatus === 'minor' ||
        data.guardianName?.trim() ||
        data.guardianSignature?.trim()
      );
      if (guardianUsed) {
        if (!data.guardianSignature?.trim()) missing.push('Parent/Guardian signature');
        if (!data.guardianElectronicConsent) missing.push('Parent/Guardian electronic signature consent');
      }
      // Tattoo services are 18+ only (Iowa) — block minors outright rather
      // than routing them through a guardian flow.
      if (data.formType === 'tattoo-waiver') {
        const age = computeAge(data.dob);
        if (age != null && age < 18) {
          alert('Tattoo services are available to clients 18 and older only. Based on the date of birth entered, this client cannot proceed.');
          return;
        }
      }

      // Stop if the stated age status contradicts the date of birth.
      if (statusConflictsWithDob()) {
        alert('The age answer selected doesn\'t match the date of birth entered. Please make sure the "18 or older?" question and the date of birth agree before submitting.');
        return;
      }

      if (missing.length) {
        alert('Please complete: ' + missing.join(', '));
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

  // Reads the chosen license photo, downscales it (phone photos are several MB
  // raw — too large to POST as base64), and stores a JPEG data URL in the
  // hidden `licenseImage` input so it rides along in the JSON payload.
  function setupLicenseCapture(input) {
    const scope = input.closest('.wm-field') || input.parentElement || input;
    const hidden = scope.querySelector('input[type="hidden"]');
    const preview = scope.querySelector('.wm-license-preview');

    const clear = () => {
      if (hidden) hidden.value = '';
      if (preview) {
        preview.hidden = true;
        preview.removeAttribute('src');
      }
    };

    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) {
        clear();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          // Cap the long edge so IDs stay legible without huge payloads.
          const maxEdge = 1400;
          const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          if (hidden) hidden.value = dataUrl;
          if (preview) {
            preview.src = dataUrl;
            preview.hidden = false;
          }
        };
        img.onerror = clear;
        img.src = reader.result;
      };
      reader.onerror = clear;
      reader.readAsDataURL(file);
    });
  }
});
