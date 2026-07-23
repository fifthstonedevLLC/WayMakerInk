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
      toggle.classList.remove('wm-invalid');
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
    const isBlockedMinor = age != null && age < 18;
    if (minorBlock) {
      minorBlock.hidden = !isBlockedMinor;
      // Disable submitting while the under-18 block notice is showing.
      // Query the DOM here rather than the `submitBtn` const below, which is
      // still in its temporal dead zone during the initial refreshAgeState().
      const submitButton = document.querySelector('.wm-form button[type="submit"]');
      if (submitButton) submitButton.disabled = isBlockedMinor;
    }
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

  // Date of birth entry: Month + Day dropdowns and a typed Year (number keypad)
  // compose into the hidden input[name="dob"] as YYYY-MM-DD, so all the age/minor
  // logic above keeps reading the same value it did from the old date picker.
  document.querySelectorAll('[data-dob]').forEach(setupDobPicker);

  // Draw-to-sign signature pads.
  document.querySelectorAll('.wm-signature').forEach(setupSignaturePad);

  // Driver's license photo capture (required on every waiver).
  document.querySelectorAll('.wm-license-input').forEach(setupLicenseCapture);

  // ---- Submit to n8n --------------------------------------------------------
  // Paste the Production URL from your n8n Webhook node here:
  const WEBHOOK_URL = 'https://n8n.fifthstonedev.com/webhook/5b254e31-9438-4a28-bfbb-8991d8bf1cd0';

  const form = document.querySelector('.wm-form');
  const submitBtn = form ? form.querySelector('button[type="submit"]') : null;

  // In-page red error banner shown on submit (replaces browser alert() popups).
  const errorBanner = form ? form.querySelector('[data-form-error]') : null;
  const clearFormError = () => {
    if (!errorBanner) return;
    errorBanner.hidden = true;
    errorBanner.textContent = '';
  };
  // Show the banner with a message, then take the client to the problem: scroll
  // the offending field into view (so its red highlight is what they land on)
  // and focus it. Falls back to the banner when no specific field is at fault.
  const showFormError = (message, focusEl) => {
    if (errorBanner) {
      errorBanner.textContent = message;
      errorBanner.hidden = false;
    } else {
      // Fallback if the banner markup is ever missing from a form.
      alert(message);
    }
    const scrollTarget = focusEl || errorBanner;
    if (scrollTarget && typeof scrollTarget.scrollIntoView === 'function') {
      scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    // preventScroll so focus doesn't fight the smooth scroll above.
    if (focusEl && typeof focusEl.focus === 'function') {
      try { focusEl.focus({ preventScroll: true }); } catch (_) { focusEl.focus(); }
    }
  };
  // Red highlight on the specific fields that failed validation.
  const clearInvalidMarks = () => {
    if (form) form.querySelectorAll('.wm-invalid').forEach((el) => el.classList.remove('wm-invalid'));
  };
  const markInvalid = (els) => {
    els.forEach((el) => { if (el && el.classList) el.classList.add('wm-invalid'); });
  };
  // Drop a field's red highlight as soon as the client starts fixing it.
  if (form) {
    const dropMark = (e) => { if (e.target && e.target.classList) e.target.classList.remove('wm-invalid'); };
    form.addEventListener('input', dropMark);
    form.addEventListener('change', dropMark);
  }

  // ---- ZIP → City/State auto-fill + State normalization/validation ----------
  // Goal: stop invalid State entries (a client typing "IS" for "IA"). The ZIP
  // drives a convenience auto-fill of City + State, State is normalized to a
  // 2-letter code, and — the actual guarantee — submit rejects any non-real
  // code fully offline. Auto-fill is best-effort and silently no-ops on failure.
  const STATE_NAME_TO_CODE = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
    'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
    'district of columbia': 'DC', 'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI',
    'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
    'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
    'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
    'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
    'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
    'wisconsin': 'WI', 'wyoming': 'WY',
  };
  const STATE_CODES = {};
  Object.values(STATE_NAME_TO_CODE).forEach((code) => { STATE_CODES[code] = true; });

  // "iowa"/"Iowa"/"IOWA" → "IA"; " ia " → "IA". Unknown input is uppercased and
  // trimmed and returned as-is, so submit validation is what ultimately rejects it.
  const normalizeState = (raw) => {
    const v = (raw || '').trim().replace(/\s+/g, ' ');
    if (!v) return '';
    const up = v.toUpperCase();
    if (up.length === 2 && STATE_CODES[up]) return up;
    const byName = STATE_NAME_TO_CODE[v.toLowerCase()];
    if (byName) return byName;
    return up;
  };

  if (form) {
    // Look up a US ZIP with Zippopotam.us (free, no key). Short timeout; any
    // failure/not-found returns null so manual typing is never blocked.
    const lookupZip = async (zip) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      try {
        const res = await fetch('https://api.zippopotam.us/us/' + zip, { signal: controller.signal });
        if (!res.ok) return null;
        const json = await res.json();
        const place = json.places && json.places[0];
        if (!place) return null;
        return { city: place['place name'], state: place['state abbreviation'] };
      } catch (_) {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    // Address fields are paired by their autocomplete "section-*" token, so the
    // client group and the guardian group each wire to their own city/state.
    const sectionOf = (el) => {
      const tokens = (el.getAttribute('autocomplete') || '').split(/\s+/);
      return tokens.find((t) => t.indexOf('section-') === 0) || '';
    };

    const wireZip = (zipEl, cityEl, stateEl) => {
      if (!zipEl || (!cityEl && !stateEl)) return;
      // City/State are derived from the ZIP and locked by default, so the ZIP is
      // the single source of truth (they pick up the read-only styling used for
      // other calculated fields like Age). The lock is lifted only as a safety
      // net when a lookup fails — see run() below.
      const setLocked = (locked) => {
        [cityEl, stateEl].forEach((f) => {
          if (!f) return;
          f.readOnly = locked;
          if (locked) {
            f.setAttribute('aria-readonly', 'true');
            f.placeholder = 'Set by ZIP';
          } else {
            f.removeAttribute('aria-readonly');
            f.placeholder = 'Enter manually';
          }
        });
      };
      setLocked(true);
      let lastLookup = '';
      // The ZIP is authoritative: always overwrite City/State with the lookup
      // result, even if the client typed something else (a wrong city for the
      // right ZIP should correct itself).
      const applyFill = (field, value) => {
        if (!field || !value) return;
        field.value = value;
        field.dataset.wmAutofilled = value;
        field.classList.add('is-filled');
        field.classList.remove('wm-invalid');
      };
      // Clear a field only if it still holds the value we auto-filled — a
      // city/state the client typed themselves is left alone.
      const clearFilled = (field) => {
        if (!field) return;
        if (field.value !== '' && field.dataset.wmAutofilled === field.value) {
          field.value = '';
          field.classList.remove('is-filled');
        }
        delete field.dataset.wmAutofilled;
      };
      const run = async () => {
        const zip = (zipEl.value || '').replace(/\D/g, '').slice(0, 5);
        if (zip.length !== 5 || zip === lastLookup) return;
        lastLookup = zip;
        const info = await lookupZip(zip);
        if (!info) {
          // Lookup failed (offline) or the ZIP wasn't recognized. Drop any stale
          // auto-filled values and unlock City/State so the client can type them
          // by hand — the address is never left un-enterable. Reset lastLookup so
          // a retry (re-blur / re-typing the ZIP) tries the lookup again.
          lastLookup = '';
          clearFilled(cityEl);
          clearFilled(stateEl);
          setLocked(false);
          return;
        }
        // Success → the ZIP owns City/State again: re-lock and overwrite.
        setLocked(true);
        applyFill(cityEl, info.city);
        applyFill(stateEl, normalizeState(info.state));
      };
      zipEl.addEventListener('input', () => {
        const digits = (zipEl.value || '').replace(/\D/g, '');
        // ZIP cleared → nothing to derive from, so fully reset City/State (both
        // auto-filled and any manual fallback text) and restore the locked
        // default, rather than stranding a value with no ZIP behind it.
        if (digits.length === 0) {
          lastLookup = '';
          [cityEl, stateEl].forEach((f) => {
            if (!f) return;
            f.value = '';
            f.classList.remove('is-filled');
            delete f.dataset.wmAutofilled;
          });
          setLocked(true);
          return;
        }
        if (digits.length === 5) run();
      });
      zipEl.addEventListener('blur', run);
    };

    form.querySelectorAll('input[autocomplete~="postal-code"]').forEach((zipEl) => {
      const sec = sectionOf(zipEl);
      const findByLevel = (level) => Array.from(
        form.querySelectorAll('input[autocomplete~="' + level + '"]')
      ).find((el) => sectionOf(el) === sec) || null;
      wireZip(zipEl, findByLevel('address-level2'), findByLevel('address-level1'));
    });

    // Normalize each State field to a 2-letter code the moment it loses focus,
    // so the client sees "IA" before ever reaching submit.
    form.querySelectorAll('input[autocomplete~="address-level1"]').forEach((stateEl) => {
      stateEl.addEventListener('blur', () => {
        const norm = normalizeState(stateEl.value);
        if (norm !== stateEl.value) {
          stateEl.value = norm;
          if (stateEl.dataset.wmAutofilled) stateEl.dataset.wmAutofilled = norm;
        }
      });
    });
  }

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      // Clear any error from a previous attempt so nothing stale lingers.
      clearFormError();
      clearInvalidMarks();

      // Collect all named inputs (firstName, lastName, dob, signature, etc.).
      const data = Object.fromEntries(new FormData(form).entries());

      // Collect each initialed provision so the PDF can show what was agreed to.
      // A provision marked [data-optional] (e.g. the tattoo photo release) may be
      // left un-initialed on purpose and is not required to submit.
      data.provisions = Array.from(document.querySelectorAll('.wm-provision')).map((row, i) => {
        // Read the provision text without the "Optional" badge chip.
        const textEl = row.querySelector('div:last-child');
        let text = '';
        if (textEl) {
          const clone = textEl.cloneNode(true);
          clone.querySelectorAll('.wm-optional-badge').forEach((b) => b.remove());
          text = clone.textContent.trim();
        }
        return {
          index: i + 1,
          text,
          initialed: !!row.querySelector('.wm-toggle.is-checked'),
          optional: row.hasAttribute('data-optional'),
        };
      });

      // Which form this is — helps n8n label the file / pick a template.
      data.formType = form.dataset.formType || 'waiver';

      // Timestamp of the electronic signature (proof for E-SIGN / UETA).
      data.signedAt = new Date().toISOString();
      // Normalize consent to explicit booleans for the record.
      data.electronicConsent = data.electronicConsent === 'yes';
      data.guardianElectronicConsent = data.guardianElectronicConsent === 'yes';

      // Minimal client-side validation. Track the first offending field so the
      // banner can send focus there.
      const missing = [];
      const invalidEls = [];
      let firstMissingEl = null;
      const fieldEl = (name) => (form.elements ? form.elements[name] : null) || null;
      const flagMissing = (label, el) => {
        missing.push(label);
        if (el) {
          invalidEls.push(el);
          if (!firstMissingEl) firstMissingEl = el;
        }
      };
      // Generic required-field check: any control carrying the `required`
      // attribute is validated here, so adding `required` in the HTML is all it
      // takes for a field to be enforced, highlighted, and scrolled to. File and
      // hidden inputs (license photo, signature) are enforced by the dedicated
      // checks below, and controls inside a hidden section are skipped.
      const labelText = (el) => {
        // A friendly name for the banner: explicit data-label wins, then the
        // field's own <label>, then aria-label / placeholder / name.
        if (el.dataset && el.dataset.label) return el.dataset.label;
        let txt = '';
        if (el.id) {
          const sel = 'label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]';
          const lab = form.querySelector(sel);
          if (lab) txt = lab.textContent;
        }
        txt = (txt || el.getAttribute('aria-label') || el.placeholder || el.name || 'This field')
          .replace(/\(required\)/gi, '')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/[:*]+$/, '')
          .trim();
        return txt || 'This field';
      };
      Array.from(form.querySelectorAll('[required]')).forEach((el) => {
        if (el.type === 'hidden' || el.type === 'file') return; // handled specially
        if (el.closest('[hidden]')) return; // e.g. guardian section when adult
        const empty = (el.type === 'checkbox' || el.type === 'radio') ? !el.checked : !(el.value || '').trim();
        if (empty) flagMissing(labelText(el), el);
      });
      // Signature is drawn to a canvas that writes a hidden input — not a native
      // `required` control — so it's checked explicitly. The piercing form adds a
      // separate `guardianSignature` for minors (handled below).
      // Date of birth is composed from the Month/Day/Year controls into the
      // hidden input[name="dob"]; that hidden input is skipped by the generic
      // required check above, so enforce it here and point the client at the
      // Month dropdown, highlighting all three controls if the date is missing.
      if (!data.dob?.trim()) {
        const dobGroup = document.querySelector('[data-dob]');
        flagMissing('Date of Birth', dobGroup ? dobGroup.querySelector('[data-dob-month]') : null);
        if (dobGroup) {
          dobGroup.querySelectorAll('select, input').forEach((el) => {
            if (el !== firstMissingEl) invalidEls.push(el);
          });
        }
      }
      const signature = data.signature || data.clientSignature;
      if (!signature?.trim()) flagMissing('Signature', document.querySelector('.wm-signature'));
      // License photo lands in a hidden input; highlight the visible upload box.
      if (!data.licenseImage?.trim()) flagMissing("Driver's License / ID photo", document.querySelector('.wm-license'));
      // The guardian section is required whenever the client is under 18
      // (per the age dropdown) or a guardian's details were entered anyway.
      const guardianUsed = !!(
        data.ageStatus === 'minor' ||
        data.guardianName?.trim() ||
        data.guardianSignature?.trim()
      );
      if (guardianUsed) {
        if (!data.guardianSignature?.trim()) flagMissing('Parent/Guardian signature', null);
        if (!data.guardianElectronicConsent) flagMissing('Parent/Guardian electronic signature consent', fieldEl('guardianElectronicConsent'));
      }
      // Every required provision must be initialed; [data-optional] ones (the
      // tattoo photo release) may be left blank on purpose. Highlight each one
      // that's still missing, but list it in the banner only once.
      const uninitialed = Array.from(document.querySelectorAll('.wm-provision')).filter(
        (row) => !row.hasAttribute('data-optional') &&
          !row.closest('[hidden]') && // e.g. guardian provision when client is an adult
          !row.querySelector('.wm-toggle.is-checked')
      );
      if (uninitialed.length) {
        flagMissing('Your initials on every provision', uninitialed[0].querySelector('.wm-toggle'));
        uninitialed.slice(1).forEach((row) => {
          const toggle = row.querySelector('.wm-toggle');
          if (toggle) invalidEls.push(toggle);
        });
      }
      // State must be a real US 2-letter code. Normalize first (iowa → IA), sync
      // the normalized value into both the field and the payload, then reject any
      // non-real code. This check is fully offline — the actual anti-typo guard.
      // Empty is allowed (State isn't required); hidden guardian fields are skipped.
      const stateInputs = Array.from(form.querySelectorAll('input[autocomplete~="address-level1"]'))
        .filter((el) => !el.closest('[hidden]'));
      for (const el of stateInputs) {
        const norm = normalizeState(el.value);
        el.value = norm;
        if (el.name) data[el.name] = norm;
        if (norm && !STATE_CODES[norm]) {
          markInvalid([el]);
          showFormError('“' + norm + '” isn\'t a valid US state. Please enter a state like IA or Iowa.', el);
          return;
        }
      }

      // Tattoo services are 18+ only (Iowa) — block minors outright rather
      // than routing them through a guardian flow.
      if (data.formType === 'tattoo-waiver') {
        const age = computeAge(data.dob);
        if (age != null && age < 18) {
          markInvalid([dobEl]);
          showFormError('Tattoo services are available to clients 18 and older only. Based on the date of birth entered, this client cannot proceed.', dobEl);
          return;
        }
      }

      // Stop if the stated age status contradicts the date of birth.
      if (statusConflictsWithDob()) {
        markInvalid([dobEl, minorSelect]);
        showFormError('The age answer selected doesn\'t match the date of birth entered. Please make sure the "18 or older?" question and the date of birth agree before submitting.', dobEl);
        return;
      }

      if (missing.length) {
        markInvalid(invalidEls);
        showFormError('Please complete: ' + missing.join(', '), firstMissingEl);
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
        showFormError('Sorry, something went wrong submitting your waiver. Please try again or ask your artist for help. [debug] ' + err.message);
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
        }
      }
    });
  }

  // Wires one Date-of-Birth group: fills the Month options, keeps the Day list
  // in step with the chosen month/year (so Feb never offers 30/31), and writes
  // the composed YYYY-MM-DD into the hidden input[name="dob"], firing `change`
  // so the age/minor logic recalculates exactly as it did for the date picker.
  function setupDobPicker(group) {
    const monthEl = group.querySelector('[data-dob-month]');
    const dayEl = group.querySelector('[data-dob-day]');
    const yearEl = group.querySelector('[data-dob-year]');
    const scope = group.closest('.wm-field') || group.parentElement || group;
    const hidden = scope.querySelector('input[data-dob-value]');
    if (!monthEl || !dayEl || !yearEl || !hidden) return;

    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    MONTHS.forEach((name, i) => {
      const opt = document.createElement('option');
      opt.value = String(i + 1);
      opt.textContent = name;
      monthEl.appendChild(opt);
    });

    const thisYear = new Date().getFullYear();
    yearEl.max = String(thisYear);

    // Days in the given 1-based month. With no year yet, assume a leap year so
    // Feb 29 stays selectable until a year rules it out.
    const daysInMonth = (m, y) => new Date(y || 2000, m, 0).getDate();

    // Rebuild the Day options to fit the current month/year, preserving the
    // selected day when it still fits (dropping it when it no longer does).
    const rebuildDays = () => {
      const m = parseInt(monthEl.value, 10);
      const y = parseInt(yearEl.value, 10);
      const max = m ? daysInMonth(m, y) : 31;
      const prev = dayEl.value;
      dayEl.innerHTML = '<option value="" selected disabled>Day</option>';
      for (let d = 1; d <= max; d++) {
        const opt = document.createElement('option');
        opt.value = String(d);
        opt.textContent = String(d);
        dayEl.appendChild(opt);
      }
      if (prev && parseInt(prev, 10) <= max) dayEl.value = prev;
    };

    const pad2 = (n) => String(n).padStart(2, '0');
    const compose = () => {
      const m = parseInt(monthEl.value, 10);
      const d = parseInt(dayEl.value, 10);
      const y = parseInt(yearEl.value, 10);
      const complete = m >= 1 && m <= 12 && d >= 1 && y >= 1900 && y <= thisYear &&
        d <= daysInMonth(m, y);
      const next = complete ? y + '-' + pad2(m) + '-' + pad2(d) : '';
      if (hidden.value !== next) {
        hidden.value = next;
        // Fires the same listener the old date input used → age/minor refresh.
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };

    monthEl.addEventListener('change', () => { rebuildDays(); compose(); });
    dayEl.addEventListener('change', compose);
    yearEl.addEventListener('input', () => { rebuildDays(); compose(); });
    yearEl.addEventListener('change', () => { rebuildDays(); compose(); });

    rebuildDays();
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
      // Drop the red validation highlight once something has been drawn.
      if (hasInk) pad.classList.remove('wm-invalid');
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
          // Drop the red validation highlight now that a photo exists.
          const box = input.closest('.wm-license');
          if (box) box.classList.remove('wm-invalid');
        };
        img.onerror = clear;
        img.src = reader.result;
      };
      reader.onerror = clear;
      reader.readAsDataURL(file);
    });
  }
});
