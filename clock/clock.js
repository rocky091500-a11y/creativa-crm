/* Creativa time clock, for the tablet at the front desk. Staff tap their name, type their PIN and
   clock in, go to lunch, come back or clock out. No login: the device key saved when the office set
   this device up (CRM → Payroll → Time clock) lets it call the timeclock_* functions in
   supabase/migrations/008_payroll_timeclock.sql. Every punch uses the server's time. */
(() => {
  'use strict';
  const cfg = window.CRM_CONFIG || {};
  const root = document.getElementById('clock');
  const TZ = 'America/New_York';
  const IDLE_MS = 30000;      // back to the names after 30 seconds without a tap
  const DONE_MS = 6000;       // how long the confirmation stays up
  const ROSTER_MS = 5 * 60000;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const hm = (min) => { const m = Math.round(Number(min) || 0); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  const day = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const dayEs = (d) => new Date(d + 'T00:00:00').toLocaleDateString('es-US', { weekday: 'long', day: 'numeric', month: 'short' });

  let token = null;
  try { token = JSON.parse(localStorage.getItem('crm.clockToken')); } catch { token = null; }
  let roster = [];
  let person = null;    // { id, name } picked from the names
  let pin = '';
  let idle = null;
  let busy = false;

  async function rpc(fn, args) {
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: cfg.supabaseAnonKey, authorization: `Bearer ${cfg.supabaseAnonKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    if (data && data.error === 'device') { forget(); throw Object.assign(new Error('device'), { device: true }); }
    return data;
  }
  function forget() {
    token = null;
    try { localStorage.removeItem('crm.clockToken'); } catch { /* private mode */ }
  }

  function setIdle(ms = IDLE_MS) {
    clearTimeout(idle);
    idle = setTimeout(showNames, ms);
  }

  function header() {
    return `<header class="k-top"><img src="/assets/logo.png" alt="Creativa Academy">
      <div class="k-now"><b id="k-time"></b><span id="k-date"></span></div></header>`;
  }
  function tick() {
    const now = new Date();
    const t = document.getElementById('k-time'), d = document.getElementById('k-date');
    if (t) t.textContent = now.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    if (d) d.textContent = now.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
  }
  setInterval(tick, 10000);

  function showSetup() {
    clearTimeout(idle);
    root.innerHTML = `<div class="center-screen"><div class="auth-card k-setup"><img src="/assets/logo.png" alt="Creativa Academy">
      <h1>This device isn’t a time clock yet</h1>
      <p class="muted">Ask the office to set it up: sign in to the CRM on this device, open <b>Payroll → Time clock</b>
        and tap <b>Use this device as the time clock</b>.</p>
      <a class="btn primary" href="/">Open the CRM</a></div></div>`;
  }

  function showProblem(e, retry) {
    if (e && e.device) return showSetup();
    root.innerHTML = `${header()}<section class="k-panel k-center"><h1>Can’t reach the time clock</h1>
      <p>Check the Wi-Fi and try again. · Sin conexión: revise el Wi-Fi.</p>
      <button class="k-btn primary" id="k-retry" type="button">Try again · Reintentar</button></section>`;
    tick();
    $('#k-retry').addEventListener('click', retry);
  }

  async function loadRoster() {
    const data = await rpc('timeclock_roster', { p_token: token });
    roster = data.people || [];
    return data;
  }

  async function showNames() {
    clearTimeout(idle);
    person = null; pin = ''; busy = false;
    if (!token) return showSetup();
    try { await loadRoster(); } catch (e) { return showProblem(e, showNames); }
    root.innerHTML = `${header()}<section class="k-panel">
        <h1>Tap your name <span class="k-es">· Toque su nombre</span></h1>
        <div class="k-names">${roster.map((p) => `<button class="k-name${p.in ? ' in' : ''}" type="button" data-id="${esc(p.id)}">
          <span>${esc(p.name)}</span>${p.in ? '<span class="k-in">In · Adentro</span>' : ''}</button>`).join('')
          || '<p class="muted">Nobody is set up yet. The office adds staff and PINs in CRM → Payroll.</p>'}</div></section>`;
    tick();
    $$('.k-name').forEach((b) => b.addEventListener('click', () => {
      person = roster.find((p) => p.id === b.dataset.id);
      showPin();
    }));
  }

  function showPin(message = '', bad = false) {
    pin = '';
    setIdle();
    root.innerHTML = `${header()}<section class="k-panel k-center">
        <button class="k-back" type="button" id="k-back">‹ Not you? · ¿No es usted?</button>
        <h1>Hi, ${esc(person.name.split(' ')[0])}</h1>
        <p class="k-sub">Type your PIN · Escriba su PIN</p>
        <div class="k-dots${bad ? ' shake' : ''}" id="k-dots" aria-live="polite">${'<i></i>'.repeat(4)}</div>
        <p class="k-msg${bad ? ' err' : ''}" id="k-msg">${message}</p>
        <div class="k-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-key="${n}">${n}</button>`).join('')}
          <button type="button" data-key="clear" class="k-soft">Clear</button><button type="button" data-key="0">0</button>
          <button type="button" data-key="back" class="k-soft" aria-label="Delete">⌫</button></div></section>`;
    tick();
    $('#k-back').addEventListener('click', showNames);
    $$('[data-key]').forEach((b) => b.addEventListener('click', () => press(b.dataset.key)));
  }

  function drawDots() {
    $$('#k-dots i').forEach((d, i) => d.classList.toggle('on', i < pin.length));
  }

  async function press(key) {
    if (busy) return;
    setIdle();
    if (key === 'clear') pin = '';
    else if (key === 'back') pin = pin.slice(0, -1);
    else if (pin.length < 4) pin += key;
    drawDots();
    if (pin.length < 4) return;
    busy = true;
    let st;
    try { st = await rpc('timeclock_state', { p_token: token, p_employee: person.id, p_pin: pin }); } catch (e) { busy = false; return showProblem(e, showNames); }
    busy = false;
    if (st.error === 'pin') return showPin('Wrong PIN, try again. · PIN incorrecto.', true);
    if (st.error === 'locked') return showPin('Too many tries. Wait 15 minutes or ask the office. · Demasiados intentos: espere 15 minutos.', true);
    if (st.error) return showNames();
    showStatus(st);
  }

  function showStatus(st, note = '') {
    setIdle();
    const first = esc(st.first_name || person.name.split(' ')[0]);
    const line = st.status === 'in' ? `You’re clocked in since <b>${esc(time(st.since))}</b><span class="k-es">Entrada: ${esc(time(st.since))}</span>`
      : st.status === 'lunch' ? `You’re at lunch since <b>${esc(time(st.since))}</b><span class="k-es">En almuerzo desde ${esc(time(st.since))}</span>`
        : `You’re clocked out<span class="k-es">Está fuera</span>`;
    const actions = st.status === 'in'
      ? [['lunch', 'Lunch', 'Salir a almorzar', ''], ['out', 'Clock out', 'Marcar salida', 'primary']]
      : st.status === 'lunch'
        ? [['in', 'Back from lunch', 'Regreso del almuerzo', 'primary'], ['out', 'Done for the day', 'Terminé por hoy', '']]
        : [['in', 'Clock in', 'Marcar entrada', 'primary']];
    root.innerHTML = `${header()}<section class="k-panel k-center">
        <h1>Hi, ${first}</h1>
        <p class="k-state">${line}</p>
        ${st.missed_clock_out ? `<p class="k-warn">You didn’t clock out on ${esc(day(st.missed_clock_out))}. Tell the office what time you left.
          <span class="k-es">No marcó la salida el ${esc(dayEs(st.missed_clock_out))}. Avise a la oficina a qué hora salió.</span></p>` : ''}
        ${note ? `<p class="k-msg err">${note}</p>` : ''}
        <div class="k-actions">${actions.map(([a, en, es, cls]) => `<button class="k-btn ${cls}" type="button" data-act="${a}">${en}<span>${es}</span></button>`).join('')}</div>
        <dl class="k-hours"><div><dt>Today · Hoy</dt><dd>${hm(st.today_minutes)}</dd></div>
          <div><dt>This week · Semana</dt><dd>${hm(st.week_minutes)}</dd></div>
          <div><dt>Pay period · Período</dt><dd>${hm(st.period_minutes)}</dd></div></dl>
        <button class="k-back" type="button" id="k-cancel">Cancel · Cancelar</button></section>`;
    tick();
    $('#k-cancel').addEventListener('click', showNames);
    $$('[data-act]').forEach((b) => b.addEventListener('click', () => punch(b.dataset.act, st.status)));
  }

  async function punch(action, from) {
    if (busy) return;
    busy = true;
    $$('[data-act]').forEach((b) => { b.disabled = true; });
    let r;
    try { r = await rpc('timeclock_punch', { p_token: token, p_employee: person.id, p_pin: pin, p_action: action }); } catch (e) { busy = false; return showProblem(e, showNames); }
    busy = false;
    if (r.error === 'state') return showStatus(r, 'That already happened. Check the time above. · Ya estaba marcado.');
    if (r.error) return showNames();
    const first = esc(r.first_name || '');
    const at = esc(time(r.at));
    const [title, es, bye] = action === 'lunch' ? [`Out for lunch at ${at}`, 'Salida a almorzar', `Enjoy your lunch, ${first}! · ¡Buen provecho!`]
      : action === 'in' && from === 'lunch' ? [`Back from lunch at ${at}`, 'Regreso del almuerzo', `Welcome back, ${first}! · ¡Ya está de regreso!`]
        : action === 'in' && r.tapped && r.at && new Date(r.at) > new Date(r.tapped) ? [`Clocked in: your time starts at ${at}`, `Entrada marcada: su hora empieza a las ${at}`, `Have a great day, ${first}! · ¡Que tenga un buen día!`]
        : action === 'in' ? [`Clocked in at ${at}`, 'Entrada marcada', `Have a great day, ${first}! · ¡Que tenga un buen día!`]
          : [`Clocked out at ${at}`, 'Salida marcada', `See you soon, ${first}! · ¡Hasta pronto!`];
    root.innerHTML = `${header()}<section class="k-panel k-center k-done">
        <div class="k-check" aria-hidden="true">✓</div><h1>${title}</h1><p class="k-es">${es}</p>
        <p class="k-sub">${bye}</p><p class="muted">Today · Hoy: <b>${hm(r.today_minutes)}</b></p>
        <button class="k-btn" type="button" id="k-ok">Done · Listo</button></section>`;
    tick();
    $('#k-ok').addEventListener('click', showNames);
    setIdle(DONE_MS);
  }

  // Keep the screen on while the clock is showing (where the tablet allows it).
  let lock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !lock && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
    if (lock) lock.addEventListener?.('release', () => { lock = null; });
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); if (!person) showNames(); } });
  document.addEventListener('pointerdown', keepAwake, { once: true });
  // Pick up new staff (and recover from a dropped connection) while nobody is using the clock.
  setInterval(() => { if (!person && token) showNames(); }, ROSTER_MS);

  if (!cfg.supabaseUrl) root.innerHTML = '<div class="center-screen"><p class="muted">Not connected: config.js is missing.</p></div>';
  else showNames();
})();
