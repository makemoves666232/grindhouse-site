/* StumpsRx quote form helper. Plain JavaScript, no libraries.
   - Remembers how the visitor arrived: Google click ids, utm values, first page, first referrer.
   - Writes those into the hidden inputs of every quote form.
   - On a valid submit: sends the request to the email service and to the CRM, tells Tag
     Manager, sets a one-time flag, and takes the visitor to our own /thanks.html.
   - On /thanks.html: tells Tag Manager once, only if this browser just sent the form.
   If neither copy is confirmed, or anything here breaks, the normal form post goes ahead,
   so a request is never lost to a script problem. Storage steps may fail quietly. */
(function () {
  'use strict';

  var CRM_URL = 'https://stumpsrx-api-26201077600.us-east1.run.app/api/public/quote';
  var CLICK_IDS = ['gclid', 'gbraid', 'wbraid'];
  var UTMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var VISIT_KEY = 'srx_visit';      // session storage: this visit
  var CLICK_KEY = 'srx_click';      // local storage: click ids, 90 days
  var SENT_KEY = 'srx_quote_sent';  // session storage: one-time flag for the thanks page
  var CLICK_MAX_AGE = 90 * 24 * 60 * 60 * 1000;
  var SENT_MAX_AGE = 60 * 60 * 1000;
  var CAPS = { name: 120, phone: 40, email: 160, address: 240, service: 80, stumps: 12, message: 2000 };

  function store(kind) {
    try { return window[kind] || null; } catch (e) { return null; }
  }
  function readJson(kind, key) {
    try {
      var s = store(kind);
      var raw = s && s.getItem(key);
      var value = raw ? JSON.parse(raw) : null;
      return value && typeof value === 'object' ? value : null;
    } catch (e) { return null; }
  }
  function writeJson(kind, key, value) {
    try { var s = store(kind); if (s) { s.setItem(key, JSON.stringify(value)); return true; } } catch (e) {}
    return false;
  }
  function remove(kind, key) {
    try { var s = store(kind); if (s) { s.removeItem(key); } } catch (e) {}
  }
  function clip(value, max) {
    return String(value == null ? '' : value).slice(0, max);
  }

  /* The page the visitor came from, unless it was another page of this site. */
  function outsideReferrer() {
    try {
      var ref = document.referrer || '';
      var host = /^https?:\/\/([^\/?#]+)/i.exec(ref);
      if (host && host[1].toLowerCase() === window.location.host.toLowerCase()) { return ''; }
      return clip(ref, 500);
    } catch (e) { return ''; }
  }

  function queryParams() {
    var out = {};
    try {
      var pairs = window.location.search.replace(/^\?/, '').split('&');
      for (var i = 0; i < pairs.length; i++) {
        if (!pairs[i]) { continue; }
        var cut = pairs[i].indexOf('=');
        var key = cut < 0 ? pairs[i] : pairs[i].slice(0, cut);
        var val = cut < 0 ? '' : pairs[i].slice(cut + 1);
        try {
          key = decodeURIComponent(key.replace(/\+/g, ' '));
          val = decodeURIComponent(val.replace(/\+/g, ' '));
        } catch (e) { continue; }
        if (!(key in out)) { out[key] = val; }
      }
    } catch (e) {}
    return out;
  }

  /* Work out how this visitor arrived. Read from the landing address once, then kept for the visit. */
  function attribution() {
    var params = queryParams();
    var fromUrl = {};
    var tagged = false;
    var hasClickId = false;
    var i, key;
    for (i = 0; i < CLICK_IDS.length; i++) {
      key = CLICK_IDS[i];
      fromUrl[key] = clip(params[key], 512);
      if (fromUrl[key]) { tagged = true; hasClickId = true; }
    }
    for (i = 0; i < UTMS.length; i++) {
      key = UTMS[i];
      fromUrl[key] = clip(params[key], 200);
      if (fromUrl[key]) { tagged = true; }
    }

    var visit = readJson('sessionStorage', VISIT_KEY);
    if (!visit || tagged) {
      /* First page of the visit, or a fresh arrival from a tagged link or ad. */
      visit = fromUrl;
      visit.landing_page = clip(window.location.pathname + window.location.search, 500);
      visit.referrer = outsideReferrer();
      writeJson('sessionStorage', VISIT_KEY, visit);
    }

    if (hasClickId) {
      writeJson('localStorage', CLICK_KEY, {
        gclid: fromUrl.gclid, gbraid: fromUrl.gbraid, wbraid: fromUrl.wbraid, t: new Date().getTime()
      });
    }

    var data = { landing_page: visit.landing_page || '', referrer: visit.referrer || '' };
    var visitHasClickId = false;
    for (i = 0; i < CLICK_IDS.length; i++) {
      data[CLICK_IDS[i]] = visit[CLICK_IDS[i]] || '';
      if (data[CLICK_IDS[i]]) { visitHasClickId = true; }
    }
    for (i = 0; i < UTMS.length; i++) { data[UTMS[i]] = visit[UTMS[i]] || ''; }

    if (!visitHasClickId) {
      /* A return visit within 90 days of an ad click keeps that click's id. */
      var saved = readJson('localStorage', CLICK_KEY);
      if (saved) {
        if (typeof saved.t === 'number' && new Date().getTime() - saved.t < CLICK_MAX_AGE) {
          for (i = 0; i < CLICK_IDS.length; i++) { data[CLICK_IDS[i]] = clip(saved[CLICK_IDS[i]], 512); }
        } else {
          remove('localStorage', CLICK_KEY);
        }
      }
    }
    data.page = window.location.pathname;
    return data;
  }

  function field(form, name) {
    var el = form.elements ? form.elements[name] : null;
    return el && typeof el.value === 'string' ? el.value : '';
  }

  function fillHidden(form, data) {
    var names = ['page', 'landing_page', 'referrer'].concat(CLICK_IDS, UTMS);
    for (var i = 0; i < names.length; i++) {
      var el = form.querySelector('input[type="hidden"][name="' + names[i] + '"]');
      if (!el) { continue; }
      el.value = data[names[i]] || '';
      /* An empty tracking field is left out of the post, so the email stays short. */
      el.disabled = !el.value;
    }
  }

  /* Google matches leads on a phone number with a country code: +1 and ten digits. */
  function e164(phone) {
    var raw = String(phone || '').replace(/^\s+|\s+$/g, '');
    var digits = raw.replace(/\D/g, '');
    if (!digits) { return ''; }
    if (raw.charAt(0) === '+') { return '+' + digits; }
    if (digits.length === 10) { return '+1' + digits; }
    if (digits.length === 11 && digits.charAt(0) === '1') { return '+' + digits; }
    return digits;
  }

  function pushEvent(name, extra) {
    try {
      window.dataLayer = window.dataLayer || [];
      extra.event = name;
      window.dataLayer.push(extra);
    } catch (e) {}
  }

  function crmBody(form, data) {
    var body = new URLSearchParams();
    var name;
    for (name in CAPS) {
      if (Object.prototype.hasOwnProperty.call(CAPS, name)) { body.append(name, clip(field(form, name), CAPS[name])); }
    }
    body.append('page', data.page);
    body.append('landing_page', data.landing_page);
    body.append('referrer', data.referrer);
    var i;
    for (i = 0; i < CLICK_IDS.length; i++) { body.append(CLICK_IDS[i], data[CLICK_IDS[i]]); }
    for (i = 0; i < UTMS.length; i++) { body.append(UTMS[i], data[UTMS[i]]); }
    body.append('_honey', clip(field(form, '_honey'), 200));
    return body;
  }

  /* Old browsers only: copy to the CRM without waiting, then let the normal form post go. */
  function sendToCrmBlind(form, data) {
    try {
      if (typeof URLSearchParams !== 'function') { return; }
      var body = crmBody(form, data);
      if (window.fetch && window.Request && 'keepalive' in window.Request.prototype) {
        window.fetch(CRM_URL, { method: 'POST', mode: 'no-cors', keepalive: true, body: body }).catch(function () {});
      } else if (navigator.sendBeacon) {
        navigator.sendBeacon(CRM_URL, body);
      }
    } catch (e) {}
  }

  /* Every named, switched-on field of the form except the redirect address, for the email copy. */
  function emailFields(form) {
    var out = {};
    var els = form.elements;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.name || el.disabled || el.name === '_next') { continue; }
      if (el.type === 'submit' || el.type === 'button') { continue; }
      out[el.name] = el.value;
    }
    return out;
  }

  /* POST and read a JSON answer. Resolves with null on any failure or after `ms`. Never rejects. */
  function postJson(url, options, ms) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(value) { if (!done) { done = true; clearTimeout(timer); resolve(value); } }
      var timer = setTimeout(function () { finish(null); }, ms);
      try {
        window.fetch(url, options).then(function (res) {
          return res.json().then(function (body) { finish({ ok: res.ok, body: body }); });
        }).catch(function () { finish(null); });
      } catch (e) { finish(null); }
    });
  }

  /* The form service silently drops a normal form post that carries ad-click fields (seen in
     testing on 2026-11-23), so the normal post goes without them. The CRM copy keeps them. */
  function stripTracking(form) {
    var names = ['landing_page', 'referrer'].concat(CLICK_IDS, UTMS);
    for (var i = 0; i < names.length; i++) {
      var el = form.querySelector('input[type="hidden"][name="' + names[i] + '"]');
      if (el) { el.disabled = true; }
    }
  }

  /* Remember that this browser just sent the form, so the thanks page can count it once. */
  function markSent(form, data, now) {
    var phone = e164(field(form, 'phone'));
    var email = field(form, 'email').replace(/^\s+|\s+$/g, '').toLowerCase();
    pushEvent('quote_form_submit', {
      form_page: data.page,
      lead_phone: phone || undefined,
      lead_email: email || undefined
    });
    return writeJson('sessionStorage', SENT_KEY, { t: now, phone: phone, email: email });
  }

  function setBusy(form, busy) {
    try {
      var button = form.querySelector('button[type="submit"]');
      if (!button) { return; }
      if (busy) {
        button.srxLabel = button.textContent;
        button.textContent = 'Sending…';
        button.disabled = true;
      } else {
        if (button.srxLabel) { button.textContent = button.srxLabel; }
        button.disabled = false;
      }
    } catch (e) {}
  }

  function onSubmit(event) {
    var form = event.target;
    var took = false;      /* true once we have stopped the normal form post */
    var leaving = false;   /* true once the visitor is being sent on */
    try {
      if (!form || event.defaultPrevented) { return; }
      if (typeof form.checkValidity === 'function' && !form.checkValidity()) { return; }
      var now = new Date().getTime();
      var data = attribution();
      fillHidden(form, data);

      var action = form.getAttribute('action') || '';
      var modern = window.fetch && window.Promise && typeof URLSearchParams === 'function' &&
        /^https:\/\/formsubmit\.co\/[^\/?#]+$/.test(action);

      if (!modern) {
        /* Old browser: the normal form post carries the request; the form service sends the visitor on. */
        if (form.srxSentAt && now - form.srxSentAt < 5000) { return; }
        form.srxSentAt = now;
        sendToCrmBlind(form, data);
        stripTracking(form);
        if (!field(form, '_honey')) { markSent(form, data, now); }
        return;
      }

      /* We send the request ourselves and take the visitor to our own thanks page, so the
         visitor never lands on the form service's page and the thanks page always counts it. */
      event.preventDefault();
      if (form.srxBusy) { return; }
      took = true;
      form.srxBusy = true;
      setBusy(form, true);

      if (field(form, '_honey')) { leaving = true; window.location.assign('/thanks.html'); return; }

      var emailJob = postJson(action.replace('formsubmit.co/', 'formsubmit.co/ajax/'), {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(emailFields(form))
      }, 8000);
      var crmJob = postJson(CRM_URL, { method: 'POST', keepalive: true, body: crmBody(form, data) }, 12000);

      function thanks() {
        if (leaving) { return; }
        leaving = true;
        var stored = markSent(form, data, now);
        window.location.assign(stored ? '/thanks.html' : '/thanks.html#sent');
      }
      function fallBack() {
        /* Neither copy was confirmed: hand over to the normal form post so the request is not lost. */
        if (leaving) { return; }
        leaving = true;
        markSent(form, data, now);
        setBusy(form, false);
        form.srxBusy = false;
        stripTracking(form);
        HTMLFormElement.prototype.submit.call(form);
      }

      emailJob.then(function (emailResult) {
        var emailOk = !!(emailResult && emailResult.ok && emailResult.body && String(emailResult.body.success) === 'true');
        if (emailOk) { thanks(); return; }
        /* The email copy failed or timed out; go ahead only if the CRM confirms it has the request. */
        crmJob.then(function (crmResult) {
          var crmOk = !!(crmResult && crmResult.ok && crmResult.body && crmResult.body.ok === true);
          if (crmOk) { thanks(); } else { fallBack(); }
        });
      });
    } catch (e) {
      /* Something unexpected broke after we stopped the normal post: let the normal post go. */
      if (took && !leaving) {
        try { setBusy(form, false); form.srxBusy = false; stripTracking(form); HTMLFormElement.prototype.submit.call(form); } catch (e2) {}
      }
    }
  }

  /* Coming back with the browser's Back button restores the page as it was left: un-stick the button. */
  function onPageShow(event) {
    if (!event || !event.persisted) { return; }
    try {
      var forms = document.querySelectorAll('form[name="quote"]');
      for (var i = 0; i < forms.length; i++) { forms[i].srxBusy = false; setBusy(forms[i], false); }
    } catch (e) {}
  }

  function thanksPage() {
    var sent = readJson('sessionStorage', SENT_KEY);
    if (!sent && window.location.hash === '#sent') {
      /* Storage was blocked on the form page; the address carries the one-time marker instead. */
      sent = { t: new Date().getTime() };
      try { window.history.replaceState(null, '', window.location.pathname); } catch (e) {}
    }
    if (!sent) { return; }
    remove('sessionStorage', SENT_KEY);
    if (typeof sent.t !== 'number' || new Date().getTime() - sent.t > SENT_MAX_AGE) { return; }
    pushEvent('quote_form_thanks', {
      lead_phone: sent.phone || undefined,
      lead_email: sent.email || undefined
    });
  }

  function start() {
    try {
      var data = attribution();
      var forms = document.querySelectorAll('form[name="quote"]');
      for (var i = 0; i < forms.length; i++) {
        fillHidden(forms[i], data);
        forms[i].addEventListener('submit', onSubmit);
      }
      if (/\/thanks(\.html)?$/.test(window.location.pathname)) { thanksPage(); }
      window.addEventListener('pageshow', onPageShow);
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
