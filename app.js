/* Creativa CRM — enrollment pipeline for Creativa Academy staff.
   Plain JS, no build step. Data lives in Supabase; see supabase/migrations/001_init.sql. */
(() => {
  'use strict';

  const STAGES = ['new', 'contacted', 'tour_scheduled', 'toured', 'waitlisted', 'enrolled', 'lost'];
  const STAGE_LABEL = {
    new: 'New', contacted: 'Contacted', tour_scheduled: 'Tour scheduled', toured: 'Toured',
    waitlisted: 'Waitlisted', enrolled: 'Enrolled', lost: 'Lost',
  };
  const CLOSED = new Set(['enrolled', 'lost']);
  const SOURCE_LABEL = {
    'schedule-tour': 'Tour request', waitlist: 'Waitlist', contact: 'Contact form',
    'bloom-interest': 'Bloom', 'family-support': 'Family support', manual: 'Added by staff',
  };
  const PROGRAMS = ['15–17 months', '18–23 months', 'Early 2s', 'Late 2s', 'Early 3s', 'Late 3s',
    'VPK', 'Kindergarten', 'Bloom', 'Not sure'];
  const KIND_LABEL = { note: 'Note', call: 'Call', email: 'Email', text: 'Text', stage: 'Stage', system: 'System' };
  const CLOSED_COLUMN_LIMIT = 20;
  const FIELDS = ['parent_name', 'email', 'phone', 'contact_pref', 'child_name', 'child_dob', 'program',
    'desired_start', 'heard_from', 'message', 'stage', 'assigned_to', 'tour_at', 'next_follow_up', 'lost_reason'];

  // Enrollment & finance (supabase/migrations/003_enrollment_finance.sql)
  const STUDENT_STATUS = { enrolled: 'Enrolled', waitlist: 'Waiting list', withdrawn: 'Withdrawn' };
  const DOCS = [['doc_registration', 'Registration packet', 'Packet'], ['doc_blue_form', 'Blue form', 'Blue'],
    ['doc_yellow_form', 'Yellow form', 'Yellow'], ['doc_birth_cert', 'Birth certificate', 'Birth cert.']];
  const REG_FEE = { paid: 'Paid', not_paid: 'Not paid', na: 'N/A' };
  const RBT = { yes: 'RBT', in_process: 'RBT in process' };
  const FUNDING = { private: 'Private pay', sr: 'School Readiness', sr_bpiece: 'SR – BPIECE', fes_ua: 'FES-UA',
    fes_eo: 'FES-EO', vpk: 'VPK' };
  const FREQ = { monthly: 'monthly', biweekly: 'biweekly', weekly: 'weekly' };
  // How many payments of each kind make up a month's tuition on the Tuition page.
  const PER_MONTH = { monthly: 1, biweekly: 2, weekly: 4 };
  const PAYER = { parent: 'Parent', sr: 'School Readiness', fes: 'FES / Step Up', vpk: 'VPK', other: 'Other' };
  const METHOD = { cash: 'Cash', check: 'Check', zelle: 'Zelle', card: 'Card', ach: 'Bank transfer', other: 'Other' };
  const STUDENT_FIELDS = ['name', 'dob', 'classroom_id', 'status', 'start_date', 'withdrawn_on', 'withdraw_reason',
    'parent_name', 'parent_phone', 'parent_email', 'rbt', 'therapy', 'reg_fee', 'notes', ...DOCS.map((d) => d[0])];

  const app = document.getElementById('app');
  const cfg = window.CRM_CONFIG || {};

  // ───────────── helpers ─────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const pad = (n) => String(n).padStart(2, '0');
  const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => localDate(new Date());
  const thisMonth = () => todayStr().slice(0, 7);
  const monthStart = (m) => m + '-01';
  const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return localDate(new Date(y, mo, 0)); };
  const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); return localDate(new Date(y, mo - 1 + n, 1)).slice(0, 7); };
  const fmtMonth = (m) => new Date(m + '-01T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const money = (n) => moneyFmt.format(Number(n) || 0);
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const digits = (s) => String(s || '').replace(/\D/g, '');

  function fmtDate(s) {
    if (!s) return '';
    const d = s.length === 10 ? new Date(s + 'T00:00:00') : new Date(s);
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }
  function fmtDateTime(s) {
    if (!s) return '';
    const d = new Date(s);
    return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  function relDays(s) {
    const days = Math.round((new Date(todayStr() + 'T00:00:00') - new Date(localDate(new Date(s)) + 'T00:00:00')) / 864e5);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return fmtDate(s);
  }
  function ageOf(dob) {
    if (!dob) return '';
    const b = new Date(dob + 'T00:00:00'), now = new Date();
    let m = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
    if (now.getDate() < b.getDate()) m -= 1;
    if (m < 0) return 'due ' + fmtDate(dob);
    if (m < 24) return `${m} mo`;
    const y = Math.floor(m / 12), r = m % 12;
    return y < 4 && r ? `${y} yr ${r} mo` : `${y} yr`;
  }
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function toast(msg, isErr = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.className = ''; }, isErr ? 6000 : 2500);
  }
  const fail = (error, what) => {
    console.error(what, error);
    toast(`${what}: ${error.message || error}`, true);
  };
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem('crm.' + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('crm.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  if (!cfg.supabaseUrl || /YOUR-PROJECT/.test(cfg.supabaseUrl) || !window.supabase) {
    app.innerHTML = `<div class="center-screen"><div class="auth-card"><img src="/assets/logo.png" alt="Creativa Academy">
      <h1>Not connected yet</h1><p class="muted">Add the Supabase project URL and anon key to <code>config.js</code>.</p></div></div>`;
    return;
  }

  // Invite and password-reset links land here with #type=invite|recovery; the client clears the hash.
  const linkType = new URLSearchParams(location.hash.slice(1)).get('type');
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  const state = {
    session: null,
    me: null,
    needPassword: linkType === 'invite' || linkType === 'recovery',
    staff: [],
    inquiries: [],
    classrooms: [],
    students: [],
    finance: {},      // student_id → student_finance row
    payments: [],
    settings: null,
    hasEnrollment: false, // false until 003_enrollment_finance.sql has been run
    month: thisMonth(),
    rosterFilters: { q: '', classroom: '', status: 'enrolled', docs: '', funding: '', ...store.get('rosterFilters', {}) },
    tuitionFilters: { q: '', status: '', funding: '' },
    loadedAt: 0,
    view: store.get('view', 'today'),
    filters: { q: '', stage: '', program: '', source: '', assigned: '', ...store.get('filters', {}) },
    openId: undefined, // undefined = closed, null = new inquiry
  };
  const staffName = (id) => state.staff.find((s) => s.id === id)?.full_name || '';
  const isAdmin = () => state.me?.role === 'admin';
  const canViewFinance = () => isAdmin() || ['view', 'edit'].includes(state.me?.finance);
  const canEditFinance = () => isAdmin() || state.me?.finance === 'edit';
  const classroomName = (id) => state.classrooms.find((c) => c.id === id)?.name || '';

  // ───────────── auth ─────────────
  sb.auth.onAuthStateChange((event, session) => {
    state.session = session;
    if (event === 'PASSWORD_RECOVERY') state.needPassword = true;
    if (event === 'SIGNED_OUT') {
      Object.assign(state, { me: null, inquiries: [], staff: [], students: [], finance: {}, payments: [], settings: null });
    }
    // Don't query from inside the auth callback (supabase-js can deadlock); defer.
    if (['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT', 'PASSWORD_RECOVERY'].includes(event)) setTimeout(route, 0);
  });

  async function route() {
    if (!state.session) return renderLogin();
    if (state.needPassword) return renderSetPassword();
    const { data: me, error } = await sb.from('profiles').select('*').eq('id', state.session.user.id).maybeSingle();
    if (error) return fail(error, 'Could not load your profile');
    state.me = me;
    if (!me || !me.active) return renderPending();
    await loadAll();
    renderShell();
  }

  function authCard(inner) {
    app.innerHTML = `<div class="center-screen"><div class="auth-card">
      <img src="/assets/logo.png" alt="Creativa Academy">${inner}</div></div>`;
  }

  function renderLogin(message = '') {
    authCard(`<h1>Staff sign in</h1><p class="muted small">Creativa CRM</p>
      <form id="login">
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <p class="error" id="auth-msg">${esc(message)}</p>
        <button class="btn primary" type="submit">Sign in</button>
        <button class="btn ghost small" type="button" id="forgot">Forgot password?</button>
      </form>`);
    const form = $('#login');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      const { error } = await sb.auth.signInWithPassword({ email: form.email.value.trim(), password: form.password.value });
      btn.disabled = false;
      if (error) $('#auth-msg').textContent = error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message;
    });
    $('#forgot').addEventListener('click', async () => {
      const email = form.email.value.trim();
      if (!email) { $('#auth-msg').textContent = 'Enter your email first, then tap “Forgot password?”.'; return; }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/' });
      $('#auth-msg').textContent = error ? error.message : 'Check your email for a link to set a new password.';
    });
  }

  function renderSetPassword() {
    authCard(`<h1>Set your password</h1><p class="muted small">${esc(state.session.user.email)}</p>
      <form id="setpw">
        <label>New password<input name="pw" type="password" autocomplete="new-password" minlength="8" required></label>
        <label>Confirm password<input name="pw2" type="password" autocomplete="new-password" minlength="8" required></label>
        <p class="error" id="auth-msg"></p>
        <button class="btn primary" type="submit">Save password</button>
      </form>`);
    $('#setpw').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.pw.value !== f.pw2.value) { $('#auth-msg').textContent = 'The passwords don’t match.'; return; }
      const { error } = await sb.auth.updateUser({ password: f.pw.value });
      if (error) { $('#auth-msg').textContent = error.message; return; }
      state.needPassword = false;
      toast('Password saved');
      route();
    });
  }

  function renderPending() {
    authCard(`<h1>Almost there</h1>
      <p class="muted">You’re signed in as <b>${esc(state.session.user.email)}</b>, but an administrator still needs to turn on your access.</p>
      <p class="muted small">Ask the office to activate your account, then reload this page.</p>
      <button class="btn" id="signout">Sign out</button>`);
    $('#signout').addEventListener('click', () => sb.auth.signOut());
  }

  // ───────────── data ─────────────
  // Supabase returns at most 1000 rows per request; page through bigger tables.
  async function selectAll(table, order, ascending = true) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(table).select('*').order(order, { ascending });
      if (table !== 'student_finance') q = q.order('id');   // stable pages
      const { data, error } = await q.range(from, from + 999);
      if (error) return { error };
      rows.push(...data);
      if (data.length < 1000) return { data: rows };
    }
  }

  async function loadAll() {
    const fin = canViewFinance();
    const none = Promise.resolve({ data: [] });
    const [p, i, c, st, set, f, pay] = await Promise.all([
      sb.from('profiles').select('*').order('full_name'),
      selectAll('inquiries', 'created_at', false),
      sb.from('classrooms').select('*').order('sort').order('name'),
      selectAll('students', 'name'),
      sb.from('settings').select('*').maybeSingle(),
      fin ? selectAll('student_finance', 'student_id') : none,
      fin ? selectAll('payments', 'paid_on', false) : none,
    ]);
    if (p.error) return fail(p.error, 'Could not load staff');
    if (i.error) return fail(i.error, 'Could not load inquiries');
    state.staff = p.data;
    state.inquiries = i.data;
    state.hasEnrollment = !c.error;
    if (!c.error) {
      for (const [res, what] of [[st, 'students'], [set, 'settings'], [f, 'tuition'], [pay, 'payments']]) {
        if (res.error) fail(res.error, `Could not load ${what}`);
      }
      state.classrooms = c.data;
      state.students = st.data || [];
      state.settings = set.data || null;
      state.finance = Object.fromEntries((f.data || []).map((r) => [r.student_id, r]));
      state.payments = pay.data || [];
    }
    state.loadedAt = Date.now();
  }

  window.addEventListener('focus', async () => {
    if (!state.me?.active || Date.now() - state.loadedAt < 60_000 || state.openId !== undefined) return;
    await loadAll();
    renderView();
  });

  function upsertLocal(row) {
    const idx = state.inquiries.findIndex((x) => x.id === row.id);
    if (idx >= 0) state.inquiries[idx] = row; else state.inquiries.unshift(row);
  }

  async function setStage(inq, stage, lostReason) {
    const patch = { stage };
    if (stage === 'lost') patch.lost_reason = lostReason;
    const { data, error } = await sb.from('inquiries').update(patch).eq('id', inq.id).select().single();
    if (error) return fail(error, 'Could not move inquiry');
    upsertLocal(data);
    toast(`${data.parent_name || 'Inquiry'} → ${STAGE_LABEL[stage]}`);
    renderView();
  }

  // ───────────── shell ─────────────
  const VIEWS = { today: 'Today', board: 'Pipeline', list: 'All inquiries' };

  function renderShell() {
    const views = { ...VIEWS,
      ...(state.hasEnrollment ? { roster: 'Enrollment' } : {}),
      ...(state.hasEnrollment && canViewFinance() ? { tuition: 'Tuition', reports: 'Reports' } : {}),
      ...(isAdmin() ? { staff: 'Settings' } : {}) };
    if (!views[state.view]) state.view = 'today';
    app.innerHTML = `
      <header class="top">
        <img src="/assets/logo.png" alt="Creativa Academy">
        <nav>${Object.entries(views).map(([k, v]) =>
          `<button data-view="${k}" ${state.view === k ? 'aria-current="page"' : ''}>${v}</button>`).join('')}</nav>
        <button class="btn primary" id="add">+ Add<span class="hide-sm"> inquiry</span></button>
        <div class="me"><span>${esc(state.me.full_name || state.me.email)}</span>
          <button class="btn ghost small" id="signout">Sign out</button></div>
      </header>
      <main id="view"></main>`;
    $$('header nav button').forEach((b) => b.addEventListener('click', () => {
      state.view = b.dataset.view;
      store.set('view', state.view);
      renderShell();
    }));
    $('#add').addEventListener('click', () => openDrawer(null));
    $('#signout').addEventListener('click', () => sb.auth.signOut());
    renderView();
  }

  function renderView() {
    const el = $('#view');
    if (!el) return;
    ({ today: renderToday, board: renderBoard, list: renderList, staff: renderStaff,
      roster: renderRoster, tuition: renderTuition, reports: renderReports })[state.view](el);
  }

  // ───────────── filters ─────────────
  function filtered({ includeStage = true } = {}) {
    const f = state.filters;
    const q = f.q.trim().toLowerCase(), qd = digits(f.q);
    return state.inquiries.filter((i) => {
      if (includeStage && f.stage && i.stage !== f.stage) return false;
      if (f.program && i.program !== f.program) return false;
      if (f.source && i.source !== f.source) return false;
      if (f.assigned === 'none' ? i.assigned_to : f.assigned && i.assigned_to !== f.assigned) return false;
      if (q) {
        const hay = [i.parent_name, i.child_name, i.email, i.message].join(' ').toLowerCase();
        if (!hay.includes(q) && !(qd.length >= 3 && (i.phone_digits || '').includes(qd))) return false;
      }
      return true;
    });
  }

  function toolbarHtml({ withStage }) {
    const f = state.filters;
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const programs = [...new Set([...PROGRAMS, ...state.inquiries.map((i) => i.program).filter(Boolean)])];
    return `<div class="toolbar">
      <input type="search" id="f-q" placeholder="Search name, email, phone…" value="${esc(f.q)}">
      ${withStage ? `<select id="f-stage">${opt('', 'All stages', f.stage)}${STAGES.map((s) => opt(s, STAGE_LABEL[s], f.stage)).join('')}</select>` : ''}
      <select id="f-program">${opt('', 'All programs', f.program)}${programs.map((p) => opt(p, p, f.program)).join('')}</select>
      <select id="f-source">${opt('', 'All sources', f.source)}${Object.entries(SOURCE_LABEL).map(([k, v]) => opt(k, v, f.source)).join('')}</select>
      <select id="f-assigned">${opt('', 'Anyone', f.assigned)}${opt('none', 'Unassigned', f.assigned)}${state.staff.filter((s) => s.active).map((s) => opt(s.id, s.full_name || s.email, f.assigned)).join('')}</select>
      <span class="spacer"></span>
      <span class="muted small" id="f-count"></span>
    </div>`;
  }

  function bindToolbar(rerender) {
    const map = { 'f-q': 'q', 'f-stage': 'stage', 'f-program': 'program', 'f-source': 'source', 'f-assigned': 'assigned' };
    Object.entries(map).forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener(id === 'f-q' ? 'input' : 'change', () => {
        state.filters[key] = el.value;
        store.set('filters', { ...state.filters, q: '' });
        rerender();
      });
    });
  }

  // ───────────── Today ─────────────
  function renderToday(el) {
    const today = todayStr();
    const open = state.inquiries.filter((i) => !CLOSED.has(i.stage));
    const due = open.filter((i) => i.next_follow_up && i.next_follow_up <= today)
      .sort((a, b) => a.next_follow_up.localeCompare(b.next_follow_up));
    const now = Date.now(), weekOut = now + 7 * 864e5;
    const tours = open.filter((i) => i.tour_at && new Date(i.tour_at) >= new Date(today + 'T00:00:00'))
      .sort((a, b) => a.tour_at.localeCompare(b.tour_at));
    const fresh = open.filter((i) => i.stage === 'new').sort((a, b) => a.created_at.localeCompare(b.created_at));
    const monthStart = today.slice(0, 8) + '01';
    const enrolledMonth = state.inquiries.filter((i) => i.stage === 'enrolled' && localDate(new Date(i.updated_at)) >= monthStart).length;

    const row = (i, when, cls = '') => `<div class="row" data-id="${i.id}">
        <div class="who"><b>${esc(i.parent_name || '(no name)')}</b>
          <div>${esc([i.child_name, ageOf(i.child_dob), i.program].filter(Boolean).join(' · ') || SOURCE_LABEL[i.source] || '')}</div></div>
        <span class="when ${cls}">${when}</span></div>`;

    el.innerHTML = `
      <div class="stats">
        <div class="stat"><b>${fresh.length}</b><span>New, not yet contacted</span></div>
        <div class="stat"><b>${due.length}</b><span>Follow-ups due</span></div>
        <div class="stat"><b>${tours.filter((i) => new Date(i.tour_at) <= weekOut).length}</b><span>Tours in the next 7 days</span></div>
        <div class="stat"><b>${open.length}</b><span>Open inquiries</span></div>
        <div class="stat"><b>${enrolledMonth}</b><span>Enrolled this month</span></div>
        ${state.hasEnrollment ? `<div class="stat"><b>${state.students.filter((s) => s.status === 'enrolled').length}</b><span>Students enrolled now</span></div>` : ''}
      </div>
      <div class="today-grid">
        <section class="panel"><h2>Follow-ups due</h2>
          ${due.map((i) => row(i, i.next_follow_up < today ? `<span class="tag overdue">overdue · ${fmtDate(i.next_follow_up)}</span>` : '<span class="tag due">today</span>')).join('')
            || '<p class="empty">Nothing due. Set a follow-up date on an inquiry to see it here.</p>'}
        </section>
        <section class="panel"><h2>Upcoming tours</h2>
          ${tours.map((i) => row(i, `<span class="tag tour">${esc(fmtDateTime(i.tour_at))}</span>`)).join('')
            || '<p class="empty">No tours scheduled.</p>'}
        </section>
        <section class="panel"><h2>New inquiries</h2>
          ${fresh.map((i) => row(i, `<span class="muted">${esc(relDays(i.created_at))}</span>`)).join('')
            || '<p class="empty">All caught up.</p>'}
        </section>
        ${state.hasEnrollment ? tourEmailsPanel() : ''}
      </div>`;
    $$('a.sms', el).forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
    $$('.row', el).forEach((r) => r.addEventListener('click', () => openDrawer(r.dataset.id)));
  }

  // Day-before reminders and 1-week "how was your visit?" notes. The emails go out from the hourly
  // job (netlify/functions/tour-emails.mjs); families without an email get a ready-made text instead.
  function tourEmailsPanel() {
    const day = (d) => localDate(new Date(d));
    const tomorrow = localDate(new Date(Date.now() + 864e5));
    const wk = (n) => localDate(new Date(Date.now() - n * 864e5));
    const reminders = state.inquiries.filter((i) => i.stage === 'tour_scheduled' && i.tour_at && day(i.tour_at) === tomorrow);
    const followups = state.inquiries.filter((i) => ['tour_scheduled', 'toured'].includes(i.stage) && i.tour_at
      && day(i.tour_at) <= wk(7) && day(i.tour_at) >= wk(10));
    const smsText = (i, kind) => {
      const first = (i.parent_name || '').trim().split(/\s+/)[0];
      const t = new Date(i.tour_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      return kind === 'reminder'
        ? `Hi${first ? ' ' + first : ''}! This is Creativa Academy reminding you of your tour tomorrow at ${t}. See you then! / ¡Hola! Le recordamos su visita mañana a las ${t}.`
        : `Hi${first ? ' ' + first : ''}! This is Creativa Academy. Thank you for visiting us! How was your tour? Any questions about enrolling? / ¡Gracias por visitarnos! ¿Cómo le fue en la visita?`;
    };
    const status = (i, kind) => {
      const sent = kind === 'reminder' ? i.tour_reminder_sent_at : i.followup_sent_at;
      if (sent) return `<span class="tag tour">emailed ${esc(fmtDate(sent))}</span>`;
      const tel = digits(i.phone);
      const text = tel ? `<a class="btn small sms" href="sms:${tel}?&body=${encodeURIComponent(smsText(i, kind))}">Text</a>` : '';
      if (!i.email) return `<span class="tag due">no email</span>${text}`;
      if (i.auto_emails === false || state.settings?.emails_enabled === false) return `<span class="tag">emails off</span>${text}`;
      return `<span class="tag">${kind === 'reminder' ? 'email at 9am' : 'email queued'}</span>${text}`;
    };
    const line = (i, kind) => `<div class="row" data-id="${i.id}"><div class="who"><b>${esc(i.parent_name || '(no name)')}</b>
        <div>${kind === 'reminder' ? 'Tour' : 'Toured'} ${esc(fmtDateTime(i.tour_at))}</div></div>
        <span class="when email-status">${status(i, kind)}</span></div>`;
    return `<section class="panel" id="tour-emails"><h2>Tour reminders</h2>
      <h3 class="sub-h">Tomorrow’s tours: reminder</h3>
      ${reminders.map((i) => line(i, 'reminder')).join('') || '<p class="empty">No tours tomorrow.</p>'}
      <h3 class="sub-h">Toured a week ago: “how was your visit?”</h3>
      ${followups.map((i) => line(i, 'followup')).join('') || '<p class="empty">Nobody to check in with.</p>'}
      <p class="muted small">The follow-up email is skipped if someone logs a call, email or text with the family after the tour.</p>
    </section>`;
  }

  // ───────────── Pipeline board ─────────────
  function cardHtml(i) {
    const today = todayStr();
    const tags = [];
    if (i.next_follow_up && !CLOSED.has(i.stage)) {
      tags.push(i.next_follow_up < today ? `<span class="tag overdue">follow up ${esc(fmtDate(i.next_follow_up))}</span>`
        : i.next_follow_up === today ? '<span class="tag due">follow up today</span>'
          : `<span class="tag">follow up ${esc(fmtDate(i.next_follow_up))}</span>`);
    }
    if (i.tour_at && i.stage === 'tour_scheduled') tags.push(`<span class="tag tour">${esc(fmtDateTime(i.tour_at))}</span>`);
    tags.push(`<span class="tag">${esc(SOURCE_LABEL[i.source] || i.source)}</span>`);
    if (i.assigned_to) tags.push(`<span class="tag">${esc(staffName(i.assigned_to))}</span>`);
    return `<div class="card" draggable="true" data-id="${i.id}">
      <select class="move" aria-label="Move ${esc(i.parent_name || 'this family')} to another stage">
        <option value="" selected disabled>Move to…</option>
        ${STAGES.filter((s) => s !== i.stage).map((s) => `<option value="${s}">${STAGE_LABEL[s]}</option>`).join('')}
      </select>
      <div class="name">${esc(i.parent_name || '(no name)')}</div>
      <div class="meta">${esc([i.child_name, ageOf(i.child_dob)].filter(Boolean).join(', '))}${i.program ? ' · ' + esc(i.program) : ''}</div>
      <div class="meta">${esc(relDays(i.created_at))}</div>
      <div class="tags">${tags.join('')}</div></div>`;
  }

  // Used by drag-and-drop on computers and the "Move to…" picker on phones.
  function moveTo(inq, stage) {
    if (inq.stage === stage) return;
    if (stage === 'lost') {
      const reason = prompt(`Why was ${inq.parent_name || 'this family'} lost? (e.g. chose another school, moved, price)`);
      if (!reason || !reason.trim()) return;
      setStage(inq, stage, reason.trim());
    } else if (stage === 'tour_scheduled' && !inq.tour_at) {
      openDrawer(inq.id, { stage });
      toast('Pick the tour date and time, then Save');
    } else {
      setStage(inq, stage);
    }
  }

  function renderBoard(el) {
    el.innerHTML = toolbarHtml({ withStage: false }) + '<div class="board" id="board"></div>';
    bindToolbar(() => drawBoard());
    drawBoard();

    function drawBoard() {
      const rows = filtered({ includeStage: false });
      $('#f-count').textContent = `${rows.length} inquiries`;
      $('#board').innerHTML = STAGES.map((s) => {
        const items = rows.filter((i) => i.stage === s);
        const shown = CLOSED.has(s) ? items.slice(0, CLOSED_COLUMN_LIMIT) : items;
        return `<section class="col" data-stage="${s}"><h3><span>${STAGE_LABEL[s]}</span><span>${items.length}</span></h3>
          ${shown.map(cardHtml).join('')}
          ${items.length > shown.length ? `<div class="more">+ ${items.length - shown.length} older in “All inquiries”</div>` : ''}</section>`;
      }).join('');
      $$('#board .card').forEach((c) => {
        c.addEventListener('click', (e) => { if (!e.target.closest('.move')) openDrawer(c.dataset.id); });
        c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.dataset.id); e.dataTransfer.effectAllowed = 'move'; });
        const pick = c.querySelector('.move');
        pick.addEventListener('change', () => {
          const inq = state.inquiries.find((x) => x.id === c.dataset.id);
          const stage = pick.value;
          pick.value = '';
          if (inq && stage) moveTo(inq, stage);
        });
      });
      $$('#board .col').forEach((col) => {
        col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
        col.addEventListener('dragleave', () => col.classList.remove('drop'));
        col.addEventListener('drop', (e) => {
          e.preventDefault();
          col.classList.remove('drop');
          const inq = state.inquiries.find((x) => x.id === e.dataTransfer.getData('text/plain'));
          if (inq) moveTo(inq, col.dataset.stage);
        });
      });
    }
  }

  // ───────────── List ─────────────
  function renderList(el) {
    el.innerHTML = toolbarHtml({ withStage: true }) +
      `<div class="toolbar"><span class="spacer"></span><button class="btn small" id="csv">Download CSV</button></div>
       <div class="table-wrap"><table><thead><tr>
         <th>Parent</th><th>Child</th><th>Program</th><th>Stage</th><th>Source</th><th>Received</th><th>Follow-up</th><th>Assigned</th>
       </tr></thead><tbody id="rows"></tbody></table></div>`;
    bindToolbar(draw);
    $('#csv').addEventListener('click', downloadCsv);
    draw();

    function draw() {
      const rows = filtered();
      $('#f-count').textContent = `${rows.length} inquiries`;
      $('#rows').innerHTML = rows.map((i) => `<tr data-id="${i.id}">
          <td><b>${esc(i.parent_name || '(no name)')}</b><div class="muted small">${esc(i.phone || i.email || '')}</div></td>
          <td>${esc(i.child_name || '')}<div class="muted small">${esc(ageOf(i.child_dob))}</div></td>
          <td>${esc(i.program || '')}</td>
          <td><span class="stage-pill s-${i.stage}">${STAGE_LABEL[i.stage]}</span></td>
          <td>${esc(SOURCE_LABEL[i.source] || i.source)}</td>
          <td>${esc(fmtDate(i.created_at))}</td>
          <td>${esc(fmtDate(i.next_follow_up))}</td>
          <td>${esc(staffName(i.assigned_to))}</td></tr>`).join('')
        || '<tr><td colspan="8" class="muted">No inquiries match.</td></tr>';
      $$('#rows tr[data-id]').forEach((r) => r.addEventListener('click', () => openDrawer(r.dataset.id)));
    }
  }

  function downloadCsv() {
    const cols = ['created_at', 'stage', 'source', 'parent_name', 'email', 'phone', 'child_name', 'child_dob', 'program',
      'desired_start', 'heard_from', 'tour_at', 'next_follow_up', 'assigned_to', 'lost_reason', 'message'];
    // Leading = + - @ would run as a formula in Excel/Sheets.
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')].concat(filtered().map((i) =>
      cols.map((c) => cell(c === 'assigned_to' ? staffName(i[c]) : c === 'stage' ? STAGE_LABEL[i[c]] : i[c])).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
    a.download = `creativa-inquiries-${todayStr()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ───────────── Staff (admin) ─────────────
  function renderStaff(el) {
    el.innerHTML = `<div class="panel staff-help">
        <h2>Adding a staff member</h2>
        <p class="muted small">In Supabase, open <b>Authentication → Users → Invite user</b> and enter their email.
        Once they accept the invite and set a password they appear below — switch <b>Active</b> on to let them in.
        Turning Active off removes their access immediately.</p>
        ${state.hasEnrollment ? `<p class="muted small"><b>Finances</b> opens the Tuition and Reports pages: <b>View only</b> sees tuition,
        payments and totals; <b>View &amp; record</b> can also record payments, print receipts and set tuition. Admins always have both.</p>` : ''}</div>
      <div class="table-wrap"><table class="staff-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th>${state.hasEnrollment ? '<th>Finances</th>' : ''}<th>Active</th><th>Joined</th></tr></thead>
      <tbody>${state.staff.map((s) => {
        const self = s.id === state.me.id;
        return `<tr data-id="${s.id}">
          <td>${esc(s.full_name || '')}${self ? ' <span class="muted small">(you)</span>' : ''}</td>
          <td>${esc(s.email)}</td>
          <td><select data-k="role" ${self ? 'disabled' : ''}>
            <option value="staff" ${s.role === 'staff' ? 'selected' : ''}>Staff</option>
            <option value="admin" ${s.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
          ${state.hasEnrollment ? `<td>${s.role === 'admin' ? '<span class="muted small">Full (admin)</span>' : `<select data-k="finance" ${self ? 'disabled' : ''}
            aria-label="Finance access">${optionsHtml([['none', 'No access'], ['view', 'View only'], ['edit', 'View & record']], s.finance)}</select>`}</td>` : ''}
          <td><input type="checkbox" data-k="active" ${s.active ? 'checked' : ''} ${self ? 'disabled' : ''} class="check"></td>
          <td>${esc(fmtDate(s.created_at))}</td></tr>`;
      }).join('')}</tbody></table></div>
      <section class="panel calendar-feed" id="cal-feed">
        <h2>Tour calendar</h2>
        <p class="muted small">Every scheduled tour, as a calendar you can subscribe to in Google Calendar or on a phone.
        In Google Calendar: <b>Other calendars → + → From URL</b>, paste the link, then <b>Add calendar</b>.
        Google refreshes subscribed calendars on its own schedule, usually within a few hours, so a tour booked
        just now may take a while to appear there. The CRM itself is always up to date.</p>
        <p class="muted small">Anyone with this link can see tour names and phone numbers. Share it only with staff,
        and reset it if it reaches the wrong person — the old link stops working immediately.</p>
        <div class="feed-row"><input id="cal-url" readonly value="Loading…" aria-label="Calendar link">
          <button class="btn small" id="cal-copy" type="button" disabled>Copy link</button>
          <button class="btn small danger" id="cal-reset" type="button" disabled>Reset link</button></div>
      </section>
      ${settingsPanelsHtml()}`;
    loadCalendarFeed();
    bindSettingsPanels(el);
    $$('.staff-table [data-k]', el).forEach((input) => input.addEventListener('change', async () => {
      const id = input.closest('tr').dataset.id;
      const patch = { [input.dataset.k]: input.type === 'checkbox' ? input.checked : input.value };
      const { data, error } = await sb.from('profiles').update(patch).eq('id', id).select().single();
      if (error) { fail(error, 'Could not update staff member'); return renderStaff(el); }
      state.staff = state.staff.map((s) => (s.id === id ? data : s));
      toast('Saved');
      if (input.dataset.k === 'role') renderStaff(el);
    }));
  }

  const calendarUrl = (token) => `${cfg.supabaseUrl}/rest/v1/rpc/tours_ics?token=${encodeURIComponent(token)}`
    + `&apikey=${encodeURIComponent(cfg.supabaseAnonKey)}`;

  async function loadCalendarFeed() {
    const input = $('#cal-url'), copy = $('#cal-copy'), reset = $('#cal-reset');
    if (!input) return;
    const { data, error } = await sb.from('calendar_feed').select('token').maybeSingle();
    if (error || !data) {
      input.value = error ? 'Calendar not set up yet (run 002_calendar_feed.sql in Supabase)' : 'Calendar not set up yet';
      return;
    }
    input.value = calendarUrl(data.token);
    copy.disabled = reset.disabled = false;
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(input.value); toast('Calendar link copied'); }
      catch { input.select(); toast('Press Ctrl+C (or ⌘C) to copy'); }
    };
    reset.onclick = async () => {
      if (!confirm('Reset the calendar link? Anyone subscribed with the old link (including Google Calendar) stops getting tours until they add the new one.')) return;
      const { data: token, error: e } = await sb.rpc('rotate_calendar_token');
      if (e) return fail(e, 'Could not reset the link');
      input.value = calendarUrl(token);
      toast('New calendar link ready — re-add it in Google Calendar');
    };
  }

  // ───────────── shared drawer & form bits (enrollment, tuition) ─────────────
  function mountDrawer({ title, sub = '', body, foot }) {
    closeDrawer(true);
    state.openId = 'other';
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    const drawer = document.createElement('aside');
    drawer.className = 'drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.innerHTML = `<div class="drawer-head"><h2>${title}${sub ? `<div class="sub">${sub}</div>` : ''}</h2>
        <button class="btn ghost" data-close aria-label="Close">✕</button></div>
      <form class="drawer-body" novalidate>${body}</form>
      <div class="drawer-foot">${foot}</div>`;
    document.body.append(scrim, drawer);
    document.body.style.overflow = 'hidden';
    const form = $('form', drawer);
    const ctl = { drawer, form, dirty: false };
    form.addEventListener('input', () => { ctl.dirty = true; });
    form.addEventListener('change', () => { ctl.dirty = true; });
    form.addEventListener('submit', (e) => e.preventDefault());
    ctl.tryClose = () => { if (!ctl.dirty || confirm('Discard your changes?')) closeDrawer(); };
    $$('[data-close]', drawer).forEach((b) => b.addEventListener('click', ctl.tryClose));
    scrim.addEventListener('click', ctl.tryClose);
    drawer.addEventListener('keydown', (e) => { if (e.key === 'Escape') ctl.tryClose(); });
    $('[data-close]', drawer).focus();
    return ctl;
  }
  const optionsHtml = (options, cur) => options.map(([val, label]) =>
    `<option value="${esc(val)}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${esc(label)}</option>`).join('');
  const fSelect = (name, label, options, cur, extra = '') =>
    `<label>${label}<select name="${name}" ${extra}>${optionsHtml(options, cur)}</select></label>`;
  const fInput = (name, label, value, type = 'text', extra = '') =>
    `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const formVal = (form, k) => { const v = form[k].value.trim(); return v === '' ? null : v; };
  const fundingTags = (sid) => (state.finance[sid]?.funding || []).map((k) => `<span class="tag f-${k}">${esc(FUNDING[k])}</span>`).join('');
  const missingDocs = (s) => DOCS.filter(([k]) => !s[k]);
  const sortStudents = (a, b) => (classSort(a) - classSort(b)) || a.name.localeCompare(b.name);
  function classSort(s) {
    const i = state.classrooms.findIndex((c) => c.id === s.classroom_id);
    return i < 0 ? 999 : i;
  }
  function upsertStudent(row) {
    const i = state.students.findIndex((x) => x.id === row.id);
    if (i >= 0) state.students[i] = row; else state.students.push(row);
  }
  function csvDownload(name, header, rows) {
    // Leading = + - @ would run as a formula in Excel/Sheets.
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.map(cell).join(',')].concat(rows.map((r) => r.map(cell).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ───────────── Enrollment ─────────────
  function rosterRows() {
    const f = state.rosterFilters;
    const q = f.q.trim().toLowerCase(), qd = digits(f.q);
    return state.students.filter((s) => {
      if (f.status && s.status !== f.status) return false;
      if (f.classroom && (f.classroom === 'none' ? s.classroom_id : s.classroom_id !== f.classroom)) return false;
      if (f.docs === 'missing' && !missingDocs(s).length) return false;
      if (f.docs === 'complete' && missingDocs(s).length) return false;
      if (f.funding && canViewFinance()) {
        const fund = state.finance[s.id]?.funding || [];
        if (f.funding === 'unset' ? fund.length : !fund.includes(f.funding)) return false;
      }
      if (q) {
        const hay = [s.name, s.parent_name, s.parent_email, s.notes, s.therapy, state.finance[s.id]?.award_id].join(' ').toLowerCase();
        if (!hay.includes(q) && !(qd.length >= 3 && digits(s.parent_phone).includes(qd))) return false;
      }
      return true;
    }).sort(sortStudents);
  }

  function renderRoster(el) {
    const f = state.rosterFilters;
    const fin = canViewFinance();
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const enrolled = state.students.filter((s) => s.status === 'enrolled');
    el.innerHTML = `
      <div class="class-grid">${state.classrooms.map((c) => {
        const n = enrolled.filter((s) => s.classroom_id === c.id).length;
        const wait = state.students.filter((s) => s.status === 'waitlist' && s.classroom_id === c.id).length;
        const full = c.capacity && n >= c.capacity;
        return `<button class="class-card ${f.classroom === c.id ? 'on' : ''}" data-class="${c.id}" type="button">
          <span class="c-name">${esc(c.name)}</span>
          <span class="c-count ${full ? 'full' : ''}">${n}${c.capacity ? `<small> / ${c.capacity}</small>` : ''}</span>
          <span class="c-teachers">${esc(c.teachers || '')}</span>
          ${wait ? `<span class="tag">${wait} waiting</span>` : ''}</button>`;
      }).join('')}
        <div class="class-card total"><span class="c-name">Whole school</span><span class="c-count">${enrolled.length}</span>
          <span class="c-teachers">${state.students.filter((s) => s.status === 'waitlist').length} on waiting lists</span></div>
      </div>
      <div class="toolbar">
        <input type="search" id="r-q" placeholder="Search student, parent, phone…" value="${esc(f.q)}">
        <select id="r-classroom">${opt('', 'All classes', f.classroom)}${state.classrooms.map((c) => opt(c.id, c.name, f.classroom)).join('')}${opt('none', 'No class', f.classroom)}</select>
        <select id="r-status">${opt('', 'Every status', f.status)}${Object.entries(STUDENT_STATUS).map(([k, v]) => opt(k, v, f.status)).join('')}</select>
        <select id="r-docs">${opt('', 'Any documents', f.docs)}${opt('missing', 'Missing documents', f.docs)}${opt('complete', 'All documents in', f.docs)}</select>
        ${fin ? `<select id="r-funding">${opt('', 'Any funding', f.funding)}${Object.entries(FUNDING).map(([k, v]) => opt(k, v, f.funding)).join('')}${opt('unset', 'No funding set', f.funding)}</select>` : ''}
        <span class="spacer"></span>
        <span class="muted small" id="r-count"></span>
        <button class="btn small" id="r-csv" type="button">Download CSV</button>
        <button class="btn small primary" id="r-add" type="button">+ Add student</button>
      </div>
      <div class="table-wrap"><table class="roster"><thead><tr>
        <th>Student</th><th>Class</th><th>Age</th>${DOCS.map(([, long, short]) => `<th class="doc" title="${esc(long)}">${esc(short)}</th>`).join('')}
        <th>Reg. fee</th><th>Support</th>${fin ? '<th>Funding</th>' : ''}
      </tr></thead><tbody id="roster-rows"></tbody></table></div>
      <p class="muted small">Tick a document as soon as it comes in; the date is saved. Open a student to change the date or add details.</p>`;

    $$('.class-card[data-class]', el).forEach((b) => b.addEventListener('click', () => {
      f.classroom = f.classroom === b.dataset.class ? '' : b.dataset.class;
      saveFilters();
      renderRoster(el);
    }));
    const map = { 'r-q': 'q', 'r-classroom': 'classroom', 'r-status': 'status', 'r-docs': 'docs', 'r-funding': 'funding' };
    Object.entries(map).forEach(([id, key]) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener(id === 'r-q' ? 'input' : 'change', () => {
        f[key] = input.value;
        saveFilters();
        if (id === 'r-classroom') $$('.class-card[data-class]', el).forEach((c) => c.classList.toggle('on', c.dataset.class === f.classroom));
        draw();
      });
    });
    $('#r-add').addEventListener('click', () => openStudent(null, f.classroom && f.classroom !== 'none' ? { classroom_id: f.classroom } : {}));
    $('#r-csv').addEventListener('click', () => {
      const rows = rosterRows();
      csvDownload(`creativa-students-${todayStr()}.csv`,
        ['Student', 'Date of birth', 'Class', 'Status', 'Start date', 'Withdrawn on', 'Parent', 'Phone', 'Email', ...DOCS.map((d) => d[1]),
          'Registration fee', 'RBT', 'Therapy', ...(fin ? ['Funding', 'Award ID', 'Tuition', 'Frequency'] : []), 'Notes'],
        rows.map((s) => {
          const fr = state.finance[s.id] || {};
          return [s.name, s.dob, classroomName(s.classroom_id), STUDENT_STATUS[s.status], s.start_date, s.withdrawn_on,
            s.parent_name, s.parent_phone, s.parent_email, ...DOCS.map(([k]) => s[k] || 'missing'),
            REG_FEE[s.reg_fee] || '', RBT[s.rbt] || '', s.therapy,
            ...(fin ? [(fr.funding || []).map((k) => FUNDING[k]).join(', '), fr.award_id, fr.tuition_amount, fr.tuition_amount != null ? FREQ[fr.tuition_frequency] : ''] : []),
            s.notes];
        }));
    });
    draw();

    function saveFilters() { store.set('rosterFilters', { ...f, q: '' }); }
    function draw() {
      const rows = rosterRows();
      $('#r-count').textContent = `${rows.length} student${rows.length === 1 ? '' : 's'}`;
      $('#roster-rows').innerHTML = rows.map((s) => `<tr data-id="${s.id}" class="${s.status !== 'enrolled' ? 'st-' + s.status : ''}">
          <td><b>${esc(s.name)}</b>${s.status !== 'enrolled' ? ` <span class="stage-pill st-${s.status}">${STUDENT_STATUS[s.status]}</span>` : ''}
            <div class="muted small">${esc(s.parent_name || '')}</div></td>
          <td>${esc(classroomName(s.classroom_id))}</td>
          <td class="nowrap">${esc(ageOf(s.dob))}</td>
          ${DOCS.map(([k, long]) => `<td class="doc"><input type="checkbox" class="check" data-doc="${k}" ${s[k] ? 'checked' : ''}
            aria-label="${esc(long)} received" title="${esc(s[k] ? 'Received ' + fmtDate(s[k]) : long + ' missing')}"></td>`).join('')}
          <td>${s.reg_fee ? `<span class="tag ${s.reg_fee === 'not_paid' ? 'overdue' : ''}">${REG_FEE[s.reg_fee]}</span>` : ''}</td>
          <td>${[RBT[s.rbt], s.therapy].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</td>
          ${fin ? `<td>${fundingTags(s.id)}</td>` : ''}</tr>`).join('')
        || `<tr><td colspan="${fin ? 10 : 9}" class="muted">No students match.</td></tr>`;
      $$('#roster-rows tr[data-id]').forEach((r) => r.addEventListener('click', (e) => {
        if (!e.target.closest('td.doc')) openStudent(r.dataset.id);
      }));
      $$('#roster-rows input[data-doc]').forEach((box) => box.addEventListener('change', async () => {
        const id = box.closest('tr').dataset.id, k = box.dataset.doc;
        box.disabled = true;
        const { data, error } = await sb.from('students').update({ [k]: box.checked ? todayStr() : null }).eq('id', id).select().single();
        box.disabled = false;
        if (error) { box.checked = !box.checked; return fail(error, 'Could not save'); }
        upsertStudent(data);
        box.title = data[k] ? 'Received ' + fmtDate(data[k]) : 'Missing';
        toast(`${data.name}: ${DOCS.find((d) => d[0] === k)[1]} ${data[k] ? 'received' : 'marked missing'}`);
      }));
    }
  }

  // ───────────── Student drawer ─────────────
  function openStudent(id, preset = {}) {
    const s0 = id ? state.students.find((x) => x.id === id) : { status: 'enrolled', reg_fee: null };
    if (!s0) return;
    const s = { ...s0, ...preset };
    const fin = canViewFinance(), finEdit = canEditFinance();
    const fr = (id && state.finance[id]) || { funding: [], tuition_frequency: 'monthly' };
    const pays = id ? state.payments.filter((p) => p.student_id === id).sort((a, b) => b.paid_on.localeCompare(a.paid_on) || b.receipt_no - a.receipt_no) : [];
    const tel = digits(s.parent_phone);
    const inq = s.inquiry_id && state.inquiries.find((i) => i.id === s.inquiry_id);
    const dis = finEdit ? '' : 'disabled';

    const ctl = mountDrawer({
      title: id ? esc(s.name) : 'New student',
      sub: id ? esc([classroomName(s.classroom_id), STUDENT_STATUS[s.status], ageOf(s.dob)].filter(Boolean).join(' · ')) : '',
      body: `
        ${id && (tel || s.parent_email) ? `<div class="quick section">
          ${tel ? `<a class="btn small" href="tel:${tel}">Call</a><a class="btn small" href="sms:${tel}">Text</a>` : ''}
          ${s.parent_email ? `<a class="btn small" href="mailto:${esc(s.parent_email)}">Email</a>` : ''}</div>` : ''}
        <div class="section"><h3>Student</h3><div class="grid2">
          ${fInput('name', 'Name', s.name, 'text', 'autocomplete="off" required')}
          <label>Date of birth<input name="dob" type="date" value="${esc(s.dob)}">${s.dob ? `<span class="muted small">${esc(ageOf(s.dob))}</span>` : ''}</label>
          ${fSelect('classroom_id', 'Class', [['', '—'], ...state.classrooms.map((c) => [c.id, c.name])], s.classroom_id)}
          ${fSelect('status', 'Status', Object.entries(STUDENT_STATUS), s.status)}
          ${fInput('start_date', 'Start date', s.start_date, 'date')}
          <span></span>
          <div class="full grid2" id="withdraw-wrap" ${s.status === 'withdrawn' ? '' : 'hidden'}>
            ${fInput('withdrawn_on', 'Withdrawn on', s.withdrawn_on, 'date')}
            ${fInput('withdraw_reason', 'Reason', s.withdraw_reason)}
          </div>
        </div></div>
        <div class="section"><h3>Documents</h3><div class="docs-grid">
          ${DOCS.map(([k, long]) => `<label class="doc-line"><input type="checkbox" class="check" data-doc="${k}" ${s[k] ? 'checked' : ''}>
            <span>${esc(long)}</span><input type="date" name="${k}" value="${esc(s[k])}" aria-label="${esc(long)} received on"></label>`).join('')}
        </div></div>
        <div class="section"><h3>Family</h3><div class="grid2">
          ${fInput('parent_name', 'Parent name', s.parent_name)}
          ${fInput('parent_phone', 'Phone', s.parent_phone, 'tel')}
          ${fInput('parent_email', 'Email', s.parent_email, 'email')}
        </div></div>
        <div class="section"><h3>Support & registration</h3><div class="grid2">
          ${fSelect('rbt', 'RBT', [['', 'No'], ['yes', 'Yes'], ['in_process', 'In process']], s.rbt)}
          ${fInput('therapy', 'Therapies', s.therapy, 'text', 'placeholder="Speech, OT…"')}
          ${fSelect('reg_fee', 'Registration fee', [['', '—'], ...Object.entries(REG_FEE)], s.reg_fee)}
          <label class="full">Notes<textarea name="notes" rows="3">${esc(s.notes)}</textarea></label>
        </div></div>
        ${fin ? `<div class="section"><h3>Funding & tuition</h3>
          <div class="funding-boxes">${Object.entries(FUNDING).map(([k, v]) => `<label class="pill-check"><input type="checkbox" class="check" name="fund_${k}" ${(fr.funding || []).includes(k) ? 'checked' : ''} ${dis}> ${esc(v)}</label>`).join('')}</div>
          <div class="grid2">
            ${fInput('tuition_amount', 'Tuition (family pays)', fr.tuition_amount, 'number', `min="0" step="0.01" inputmode="decimal" ${dis}`)}
            ${fSelect('tuition_frequency', 'Every', Object.entries(FREQ).map(([k, v]) => [k, v[0].toUpperCase() + v.slice(1)]), fr.tuition_frequency, dis)}
            ${fInput('award_id', 'Award / scholarship ID', fr.award_id, 'text', dis)}
            <label class="full">Funding notes<textarea name="fin_notes" rows="2" ${dis}>${esc(fr.notes)}</textarea></label>
          </div></div>
          ${id ? `<div class="section"><h3>Payments</h3>
            ${finEdit ? '<button class="btn small" type="button" id="pay-add">+ Record payment</button>' : ''}
            <ul class="pay-list">${pays.map((p) => `<li data-pay="${p.id}">
                <span class="p-date">${esc(fmtDate(p.paid_on))}</span>
                <span class="p-what">${esc(fmtMonth(p.covers_month.slice(0, 7)))} · ${esc(PAYER[p.payer])} · ${esc(METHOD[p.method])}</span>
                <b>${money(p.amount)}</b>
                <button class="btn ghost small" type="button" data-receipt="${p.id}">Receipt #${p.receipt_no}</button>
                ${finEdit ? `<button class="btn ghost small" type="button" data-edit-pay="${p.id}">Edit</button>` : ''}</li>`).join('')
              || '<li class="muted">No payments recorded yet.</li>'}</ul></div>` : ''}` : ''}
        ${inq ? `<p class="small"><a href="#" id="open-inq">Open the original inquiry (${esc(inq.parent_name || 'family')})</a></p>` : ''}`,
      foot: `${id && isAdmin() ? '<button class="btn danger" id="st-del" type="button">Delete</button>' : ''}
        <span class="spacer"></span><button class="btn" data-close type="button">Cancel</button>
        <button class="btn primary" id="st-save" type="button">${id ? 'Save' : 'Add student'}</button>`,
    });
    const { drawer, form } = ctl;
    if (Object.keys(preset).length) ctl.dirty = !id || Object.keys(preset).some((k) => preset[k] !== s0[k]);
    if (!id) form.name.focus();
    form.status.addEventListener('change', () => {
      $('#withdraw-wrap', drawer).hidden = form.status.value !== 'withdrawn';
      if (form.status.value === 'withdrawn' && !form.withdrawn_on.value) form.withdrawn_on.value = todayStr();
    });
    $$('[data-doc]', drawer).forEach((box) => box.addEventListener('change', () => {
      form[box.dataset.doc].value = box.checked ? (form[box.dataset.doc].value || todayStr()) : '';
    }));
    DOCS.forEach(([k]) => form[k].addEventListener('change', () => { $(`[data-doc="${k}"]`, drawer).checked = !!form[k].value; }));
    $('#st-save', drawer).addEventListener('click', save);
    $('#st-del', drawer)?.addEventListener('click', remove);
    $('#open-inq', drawer)?.addEventListener('click', (e) => { e.preventDefault(); if (!ctl.dirty || confirm('Discard your changes?')) openDrawer(inq.id); });
    const back = () => openStudent(id);
    $('#pay-add', drawer)?.addEventListener('click', () => { if (!ctl.dirty || confirm('Discard your changes?')) openPayment({ studentId: id, back }); });
    $$('[data-edit-pay]', drawer).forEach((b) => b.addEventListener('click', () => {
      if (!ctl.dirty || confirm('Discard your changes?')) openPayment({ paymentId: b.dataset.editPay, back });
    }));
    $$('[data-receipt]', drawer).forEach((b) => b.addEventListener('click', () =>
      showReceipts(state.payments.filter((p) => p.id === b.dataset.receipt))));

    async function save() {
      const patch = {};
      STUDENT_FIELDS.forEach((k) => { patch[k] = formVal(form, k); });
      if (!patch.name) { form.name.focus(); return toast('Add the student’s name', true); }
      if (patch.status === 'withdrawn') patch.withdrawn_on = patch.withdrawn_on || todayStr();
      else { patch.withdrawn_on = null; patch.withdraw_reason = null; }
      if (preset.inquiry_id && !id) patch.inquiry_id = preset.inquiry_id;
      let finPatch = null;
      if (finEdit) {
        const amount = form.tuition_amount.value.trim();
        if (amount !== '' && !(Number(amount) >= 0)) { form.tuition_amount.focus(); return toast('Tuition must be a number', true); }
        finPatch = {
          funding: Object.keys(FUNDING).filter((k) => form['fund_' + k].checked),
          tuition_amount: amount === '' ? null : round2(amount),
          tuition_frequency: form.tuition_frequency.value,
          award_id: formVal(form, 'award_id'),
          notes: formVal(form, 'fin_notes'),
        };
        const empty = !finPatch.funding.length && finPatch.tuition_amount == null && !finPatch.award_id && !finPatch.notes;
        if (empty && !(id && state.finance[id])) finPatch = null;
      }
      const btn = $('#st-save', drawer);
      btn.disabled = true;
      const q = id ? sb.from('students').update(patch).eq('id', id) : sb.from('students').insert(patch);
      const { data, error } = await q.select().single();
      if (error) { btn.disabled = false; return fail(error, 'Could not save'); }
      upsertStudent(data);
      if (finPatch) {
        const r = await sb.from('student_finance').upsert({ student_id: data.id, ...finPatch }).select().single();
        if (r.error) { btn.disabled = false; fail(r.error, 'Saved the student, but not the funding/tuition'); return openStudent(data.id); }
        state.finance[data.id] = r.data;
      }
      ctl.dirty = false;
      toast(id ? 'Saved' : `${data.name} added`);
      renderView();
      openStudent(data.id);
    }

    async function remove() {
      if (pays.length) return toast('This student has payments on record. Set the status to Withdrawn instead.', true);
      if (!confirm(`Delete ${s.name} from the enrollment list? To keep their history, set the status to Withdrawn instead.`)) return;
      const { error } = await sb.from('students').delete().eq('id', id);
      if (error) return fail(error, 'Could not delete');
      state.students = state.students.filter((x) => x.id !== id);
      delete state.finance[id];
      closeDrawer();
      renderView();
      toast('Deleted');
    }
  }

  // An inquiry marked Enrolled can be added to the enrollment list in one tap.
  function studentFromInquiry(inq) {
    const cls = state.classrooms.find((c) => c.name === inq.program);
    openStudent(null, {
      name: inq.child_name || '', dob: inq.child_dob, classroom_id: cls?.id || null, status: 'enrolled',
      parent_name: inq.parent_name, parent_phone: inq.phone, parent_email: inq.email, inquiry_id: inq.id,
    });
  }

  // ───────────── Payments & receipts ─────────────
  function monthDue(sid) {
    const f = state.finance[sid];
    if (!f || f.tuition_amount == null) return null;
    return round2(Number(f.tuition_amount) * PER_MONTH[f.tuition_frequency]);
  }
  const paidFor = (sid, m) => round2(state.payments.filter((p) => p.student_id === sid && p.covers_month === monthStart(m))
    .reduce((t, p) => t + Number(p.amount), 0));
  function activeInMonth(s, m) {
    if (s.status === 'waitlist') return false;
    if (s.start_date && s.start_date > monthEnd(m)) return false;
    if (s.status === 'withdrawn') return !!s.withdrawn_on && s.withdrawn_on >= monthStart(m);
    return true;
  }

  function openPayment({ studentId, paymentId, month, back }) {
    const p = paymentId ? state.payments.find((x) => x.id === paymentId) : null;
    const sid = p ? p.student_id : studentId;
    const m = p ? p.covers_month.slice(0, 7) : (month || thisMonth());
    const due = sid ? monthDue(sid) : null;
    const suggested = p ? p.amount : due != null ? Math.max(round2(due - paidFor(sid, m)), 0) || '' : '';
    const fund = (sid && state.finance[sid]?.funding) || [];
    const payer = p ? p.payer : 'parent';
    const students = state.students.filter((s) => s.status !== 'waitlist' || s.id === sid).sort((a, b) => a.name.localeCompare(b.name));
    const st = state.students.find((s) => s.id === sid);
    const ctl = mountDrawer({
      title: p ? `Payment · receipt #${p.receipt_no}` : 'Record payment',
      sub: st ? esc(st.name) : '',
      body: `<div class="section"><div class="grid2">
          <label class="full">Student<select name="student_id" required>${sid ? '' : '<option value="">Choose a student…</option>'}
            ${optionsHtml(students.map((s) => [s.id, `${s.name}${s.classroom_id ? ' · ' + classroomName(s.classroom_id) : ''}`]), sid)}</select></label>
          ${fInput('amount', 'Amount ($)', suggested, 'number', 'min="0.01" step="0.01" inputmode="decimal" required')}
          ${fInput('covers_month', 'For the month of', m, 'month', 'required')}
          ${fInput('paid_on', 'Date received', p ? p.paid_on : todayStr(), 'date', 'required')}
          ${fSelect('payer', 'Paid by', Object.entries(PAYER), payer)}
          ${fSelect('method', 'Method', Object.entries(METHOD), p ? p.method : 'cash')}
          ${fInput('reference', 'Check # / confirmation', p?.reference)}
          <label class="full">Note (printed on the receipt)<input name="note" value="${esc(p?.note)}" placeholder="e.g. Tuition weeks of Oct 6 and Oct 20"></label>
        </div>
        <p class="muted small" id="pay-hint"></p></div>`,
      foot: `${p ? '<button class="btn danger" id="pay-del" type="button">Delete</button>' : ''}<span class="spacer"></span>
        <button class="btn" data-close type="button">Cancel</button>
        <button class="btn" id="pay-save" type="button">Save</button>
        <button class="btn primary" id="pay-save-print" type="button">Save & receipt</button>`,
    });
    const { drawer, form } = ctl;
    const hint = () => {
      const id = form.student_id.value, mo = form.covers_month.value;
      const d = id ? monthDue(id) : null;
      $('#pay-hint', drawer).textContent = id && mo && d != null
        ? `${fmtMonth(mo)}: ${money(d)} due, ${money(paidFor(id, mo) - (p && p.covers_month.slice(0, 7) === mo ? Number(p.amount) : 0))} already paid.` : '';
    };
    form.student_id.addEventListener('change', hint);
    form.covers_month.addEventListener('change', hint);
    hint();
    if (!p && fund.length && !fund.includes('private')) $('#pay-hint', drawer).append(' Funding: ' + fund.map((k) => FUNDING[k]).join(', ') + '.');
    (sid ? form.amount : form.student_id).focus();
    $('#pay-save', drawer).addEventListener('click', () => save(false));
    $('#pay-save-print', drawer).addEventListener('click', () => save(true));
    $('#pay-del', drawer)?.addEventListener('click', async () => {
      if (!confirm(`Delete receipt #${p.receipt_no} (${money(p.amount)})? This can’t be undone.`)) return;
      const { error } = await sb.from('payments').delete().eq('id', p.id);
      if (error) return fail(error, 'Could not delete');
      state.payments = state.payments.filter((x) => x.id !== p.id);
      toast('Payment deleted');
      done();
    });

    function done() { ctl.dirty = false; renderView(); if (back) back(); else closeDrawer(); }

    async function save(print) {
      const amount = Number(form.amount.value);
      if (!form.student_id.value) return toast('Choose the student', true);
      if (!(amount > 0)) { form.amount.focus(); return toast('Enter the amount received', true); }
      if (!/^\d{4}-\d{2}$/.test(form.covers_month.value)) { form.covers_month.focus(); return toast('Pick the month this pays for', true); }
      if (!form.paid_on.value) return toast('Enter the date received', true);
      const row = {
        student_id: form.student_id.value, amount: round2(amount), covers_month: form.covers_month.value + '-01',
        paid_on: form.paid_on.value, payer: form.payer.value, method: form.method.value,
        reference: formVal(form, 'reference'), note: formVal(form, 'note'),
      };
      $$('.drawer-foot .btn', drawer).forEach((b) => { b.disabled = true; });
      const q = p ? sb.from('payments').update(row).eq('id', p.id) : sb.from('payments').insert({ ...row, created_by: state.me.id });
      const { data, error } = await q.select().single();
      $$('.drawer-foot .btn', drawer).forEach((b) => { b.disabled = false; });
      if (error) return fail(error, 'Could not save the payment');
      state.payments = [data, ...state.payments.filter((x) => x.id !== data.id)];
      toast(`Saved · receipt #${data.receipt_no}`);
      done();
      if (print) showReceipts([data]);
    }
  }

  const longDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  function receiptHtml(p) {
    const s = state.students.find((x) => x.id === p.student_id) || { name: '' };
    const f = state.finance[p.student_id] || {};
    const set = state.settings || {};
    const from = p.payer === 'parent' ? (s.parent_name || `Family of ${s.name}`) : PAYER[p.payer];
    return `<article class="receipt">
      <header><img src="/assets/logo.png" alt="">
        <div class="r-school"><h1>${esc(set.school_name || 'Creativa Academy')}</h1><div class="pre">${esc(set.receipt_header || '')}</div></div>
        <div class="r-no"><b>Receipt</b><span>No. ${esc(p.receipt_no)}</span></div></header>
      <dl>
        <dt>Date received</dt><dd>${esc(longDate(p.paid_on))}</dd>
        <dt>Received from</dt><dd>${esc(from)}</dd>
        <dt>Student</dt><dd>${esc(s.name)}${s.dob ? ` · born ${esc(longDate(s.dob))}` : ''}</dd>
        ${s.classroom_id ? `<dt>Class</dt><dd>${esc(classroomName(s.classroom_id))}</dd>` : ''}
        ${f.award_id ? `<dt>Scholarship / award ID</dt><dd>${esc(f.award_id)}</dd>` : ''}
        ${(f.funding || []).length ? `<dt>Program</dt><dd>${esc(f.funding.map((k) => FUNDING[k]).join(', '))}</dd>` : ''}
      </dl>
      <table><thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
        <tbody><tr><td>Tuition for ${esc(fmtMonth(p.covers_month.slice(0, 7)))}${p.note ? `<div class="r-note">${esc(p.note)}</div>` : ''}</td>
          <td class="num">${money(p.amount)}</td></tr></tbody>
        <tfoot><tr><th>Total received</th><th class="num">${money(p.amount)}</th></tr></tfoot></table>
      <p class="r-method">Payment method: ${esc(METHOD[p.method])}${p.reference ? ` (${esc(p.reference)})` : ''}</p>
      <div class="r-sign"><span class="r-line"></span><span>${esc(set.receipt_signer || 'Authorized signature')}</span></div>
    </article>`;
  }

  // Receipts open over the app; Print (or Save as PDF) prints only them, one per page.
  function showReceipts(list) {
    if (!list.length) return toast('No payments to print', true);
    const sheet = document.createElement('div');
    sheet.className = 'print-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.innerHTML = `<div class="print-bar no-print"><b>${list.length} receipt${list.length === 1 ? '' : 's'}</b><span class="spacer"></span>
        <button class="btn primary" type="button" id="rc-print">Print / Save as PDF</button>
        <button class="btn" type="button" id="rc-close">Close</button></div>
      ${list.map(receiptHtml).join('')}`;
    document.body.append(sheet);
    document.body.classList.add('printing');
    const close = () => { sheet.remove(); document.body.classList.remove('printing'); };
    $('#rc-print', sheet).addEventListener('click', () => window.print());
    $('#rc-close', sheet).addEventListener('click', close);
    sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    $('#rc-close', sheet).focus();
  }

  // ───────────── Tuition ─────────────
  function monthBar() {
    return `<div class="month-bar"><button class="btn small" id="m-prev" type="button" aria-label="Previous month">‹</button>
      <input type="month" id="m-pick" value="${state.month}" aria-label="Month">
      <button class="btn small" id="m-next" type="button" aria-label="Next month">›</button>
      <b>${esc(fmtMonth(state.month))}</b></div>`;
  }
  function bindMonthBar(el, rerender) {
    $('#m-prev', el).addEventListener('click', () => { state.month = shiftMonth(state.month, -1); rerender(el); });
    $('#m-next', el).addEventListener('click', () => { state.month = shiftMonth(state.month, 1); rerender(el); });
    $('#m-pick', el).addEventListener('change', (e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { state.month = e.target.value; rerender(el); } });
  }
  const TUITION_STATUS = { paid: 'Paid', partial: 'Partly paid', unpaid: 'Not paid', none: 'Nothing due', unset: 'No tuition set' };

  function tuitionRows(m) {
    return state.students.filter((s) => activeInMonth(s, m)).sort(sortStudents).map((s) => {
      const due = monthDue(s.id), paid = paidFor(s.id, m);
      const status = due == null ? (paid > 0 ? 'paid' : 'unset') : due === 0 ? 'none' : paid >= due ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
      return { s, due, paid, balance: due == null ? 0 : round2(due - paid), status };
    });
  }

  function renderTuition(el) {
    const m = state.month, f = state.tuitionFilters, edit = canEditFinance();
    const all = tuitionRows(m);
    const expected = round2(all.reduce((t, r) => t + (r.due || 0), 0));
    const monthPays = state.payments.filter((p) => p.covers_month === monthStart(m));
    const collected = round2(monthPays.reduce((t, p) => t + Number(p.amount), 0));
    const owed = round2(all.reduce((t, r) => t + Math.max(r.balance, 0), 0));
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    el.innerHTML = `${monthBar()}
      <div class="stats">
        <div class="stat"><b>${money(expected)}</b><span>Tuition due for ${esc(fmtMonth(m))}</span></div>
        <div class="stat"><b>${money(collected)}</b><span>Paid toward ${esc(fmtMonth(m))}</span></div>
        <div class="stat"><b>${money(owed)}</b><span>Still owed</span></div>
        <div class="stat"><b>${all.filter((r) => ['unpaid', 'partial'].includes(r.status)).length}</b><span>Families not fully paid</span></div>
      </div>
      <div class="toolbar">
        <input type="search" id="t-q" placeholder="Search student…" value="${esc(f.q)}">
        <select id="t-status">${opt('', 'Everyone', f.status)}${opt('owing', 'Not fully paid', f.status)}${opt('paid', 'Paid', f.status)}${opt('unset', 'No tuition set', f.status)}</select>
        <select id="t-funding">${opt('', 'Any funding', f.funding)}${Object.entries(FUNDING).map(([k, v]) => opt(k, v, f.funding)).join('')}</select>
        <span class="spacer"></span>
        <button class="btn small" id="t-fes" type="button">Print FES-UA receipts</button>
        <button class="btn small" id="t-csv" type="button">Download CSV</button>
        ${edit ? '<button class="btn small primary" id="t-add" type="button">+ Record payment</button>' : ''}
      </div>
      <div class="table-wrap"><table class="tuition"><thead><tr>
        <th>Student</th><th>Funding</th><th class="num">Tuition</th><th class="num">Due</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th>${edit ? '<th></th>' : ''}
      </tr></thead><tbody id="t-rows"></tbody></table></div>
      <p class="muted small">Due for the month = the student’s tuition (biweekly counts as 2 payments, weekly as 4).
        A payment counts toward the month picked in “For the month of”, whatever day it arrived. Set tuition and funding on each student.</p>
      <section class="panel"><h2>Payments for ${esc(fmtMonth(m))}</h2>
        <div class="table-wrap flat"><table><thead><tr><th>Received</th><th>Student</th><th>Paid by</th><th>Method</th><th class="num">Amount</th><th>Receipt</th></tr></thead>
        <tbody id="t-pays">${monthPays.slice().sort((a, b) => a.paid_on.localeCompare(b.paid_on) || a.receipt_no - b.receipt_no).map((p) => `<tr data-pay="${p.id}">
          <td>${esc(fmtDate(p.paid_on))}</td><td>${esc(state.students.find((s) => s.id === p.student_id)?.name || '')}</td>
          <td>${esc(PAYER[p.payer])}</td><td>${esc(METHOD[p.method])}${p.reference ? ` <span class="muted small">${esc(p.reference)}</span>` : ''}</td>
          <td class="num">${money(p.amount)}</td><td><button class="btn ghost small" type="button" data-receipt="${p.id}">#${p.receipt_no}</button></td></tr>`).join('')
          || '<tr><td colspan="6" class="muted">No payments recorded for this month yet.</td></tr>'}</tbody></table></div>
      </section>`;
    bindMonthBar(el, renderTuition);
    [['t-q', 'q', 'input'], ['t-status', 'status', 'change'], ['t-funding', 'funding', 'change']].forEach(([id, k, ev]) =>
      $('#' + id, el).addEventListener(ev, (e) => { f[k] = e.target.value; draw(); }));
    $('#t-add', el)?.addEventListener('click', () => openPayment({ month: m }));
    $('#t-fes', el).addEventListener('click', () => showReceipts(monthPays
      .filter((p) => (state.finance[p.student_id]?.funding || []).includes('fes_ua'))
      .sort((a, b) => (state.students.find((s) => s.id === a.student_id)?.name || '').localeCompare(state.students.find((s) => s.id === b.student_id)?.name || '') || a.receipt_no - b.receipt_no)));
    $('#t-csv', el).addEventListener('click', () => csvDownload(`creativa-tuition-${m}.csv`,
      ['Student', 'Class', 'Funding', 'Award ID', 'Tuition', 'Frequency', 'Due', 'Paid', 'Balance', 'Status'],
      all.map((r) => {
        const fr = state.finance[r.s.id] || {};
        return [r.s.name, classroomName(r.s.classroom_id), (fr.funding || []).map((k) => FUNDING[k]).join(', '), fr.award_id,
          fr.tuition_amount, fr.tuition_amount != null ? FREQ[fr.tuition_frequency] : '', r.due, r.paid, r.balance, TUITION_STATUS[r.status]];
      })));
    $$('#t-pays [data-receipt]', el).forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      showReceipts(state.payments.filter((p) => p.id === b.dataset.receipt));
    }));
    if (edit) $$('#t-pays tr[data-pay]', el).forEach((r) => r.addEventListener('click', () => openPayment({ paymentId: r.dataset.pay })));
    draw();

    function draw() {
      const q = f.q.trim().toLowerCase();
      const rows = all.filter((r) => {
        if (f.status === 'owing' && !['unpaid', 'partial'].includes(r.status)) return false;
        if (f.status === 'paid' && r.status !== 'paid') return false;
        if (f.status === 'unset' && r.status !== 'unset') return false;
        if (f.funding && !(state.finance[r.s.id]?.funding || []).includes(f.funding)) return false;
        if (q && !`${r.s.name} ${r.s.parent_name || ''}`.toLowerCase().includes(q)) return false;
        return true;
      });
      $('#t-rows', el).innerHTML = rows.map((r) => {
        const fr = state.finance[r.s.id];
        return `<tr data-id="${r.s.id}">
          <td><b>${esc(r.s.name)}</b><div class="muted small">${esc(classroomName(r.s.classroom_id))}</div></td>
          <td>${fundingTags(r.s.id)}</td>
          <td class="num">${fr?.tuition_amount != null ? `${money(fr.tuition_amount)}<div class="muted small">${FREQ[fr.tuition_frequency]}</div>` : ''}</td>
          <td class="num">${r.due != null ? money(r.due) : ''}</td>
          <td class="num">${r.paid ? money(r.paid) : ''}</td>
          <td class="num">${r.due != null && r.balance !== 0 ? money(r.balance) : ''}</td>
          <td><span class="pay-pill ps-${r.status}">${TUITION_STATUS[r.status]}</span></td>
          ${edit ? `<td><button class="btn small" type="button" data-pay-for="${r.s.id}">${['paid', 'none'].includes(r.status) ? '+ Payment' : 'Record payment'}</button></td>` : ''}</tr>`;
      }).join('') || `<tr><td colspan="${edit ? 8 : 7}" class="muted">Nobody matches.</td></tr>`;
      $$('#t-rows tr[data-id]', el).forEach((tr) => tr.addEventListener('click', (e) => {
        const b = e.target.closest('[data-pay-for]');
        if (b) openPayment({ studentId: b.dataset.payFor, month: m });
        else openStudent(tr.dataset.id);
      }));
    }
  }

  // ───────────── Reports ─────────────
  function renderReports(el) {
    const m = state.month;
    const inMonth = (p, mo) => p.paid_on >= monthStart(mo) && p.paid_on <= monthEnd(mo);
    const pays = state.payments.filter((p) => inMonth(p, m));
    const total = round2(pays.reduce((t, p) => t + Number(p.amount), 0));
    const sumBy = (key) => {
      const out = {};
      pays.forEach((p) => { const k = key(p); out[k] = round2((out[k] || 0) + Number(p.amount)); });
      return out;
    };
    const byPayer = sumBy((p) => PAYER[p.payer]);
    const byMethod = sumBy((p) => METHOD[p.method]);
    const byClass = sumBy((p) => classroomName(state.students.find((s) => s.id === p.student_id)?.classroom_id) || 'No class');
    const expectedFor = (mo) => round2(tuitionRows(mo).reduce((t, r) => t + (r.due || 0), 0));
    const rowsFor = tuitionRows(m);
    const owed = round2(rowsFor.reduce((t, r) => t + Math.max(r.balance, 0), 0));
    // School year runs August–July.
    const [y, mo] = m.split('-').map(Number);
    const startYear = mo >= 8 ? y : y - 1;
    const year = Array.from({ length: 12 }, (_, i) => shiftMonth(`${startYear}-08`, i));
    const table = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td class="num">${money(v)}</td><td class="num muted">${total ? Math.round((v / total) * 100) : 0}%</td></tr>`).join('')
      || '<tr><td colspan="3" class="muted">No payments.</td></tr>';
    const enrolled = state.students.filter((s) => s.status === 'enrolled').sort(sortStudents);

    el.innerHTML = `${monthBar()}
      <div class="stats">
        <div class="stat"><b>${money(total)}</b><span>Received in ${esc(fmtMonth(m))}</span></div>
        <div class="stat"><b>${pays.length}</b><span>Payments</span></div>
        <div class="stat"><b>${money(expectedFor(m))}</b><span>Tuition due for the month</span></div>
        <div class="stat"><b>${money(owed)}</b><span>Still owed for the month</span></div>
      </div>
      <div class="today-grid">
        <section class="panel"><h2>By who paid</h2><table class="mini"><tbody>${table(byPayer)}</tbody></table></section>
        <section class="panel"><h2>By method</h2><table class="mini"><tbody>${table(byMethod)}</tbody></table></section>
        <section class="panel"><h2>By class</h2><table class="mini"><tbody>${table(byClass)}</tbody></table></section>
      </div>
      <section class="panel report-year"><h2>School year ${startYear}–${String(startYear + 1).slice(2)}</h2>
        <div class="table-wrap flat"><table><thead><tr><th>Month</th><th class="num">Received</th><th class="num">Tuition due</th><th class="num">Paid toward month</th></tr></thead>
        <tbody>${year.map((ym) => {
          const rec = round2(state.payments.filter((p) => inMonth(p, ym)).reduce((t, p) => t + Number(p.amount), 0));
          const toward = round2(state.payments.filter((p) => p.covers_month === monthStart(ym)).reduce((t, p) => t + Number(p.amount), 0));
          return `<tr class="${ym === m ? 'cur' : ''}" data-month="${ym}"><td>${esc(fmtMonth(ym))}</td><td class="num">${rec ? money(rec) : '—'}</td>
            <td class="num">${money(expectedFor(ym))}</td><td class="num">${toward ? money(toward) : '—'}</td></tr>`;
        }).join('')}</tbody>
        <tfoot><tr><th>Total</th><th class="num">${money(state.payments.filter((p) => p.paid_on >= monthStart(year[0]) && p.paid_on <= monthEnd(year[11])).reduce((t, p) => t + Number(p.amount), 0))}</th><th></th><th></th></tr></tfoot>
        </table></div>
        <p class="muted small">“Received” counts payments by the date they came in; “Paid toward month” by the month they pay for.</p>
      </section>
      <section class="panel"><h2>Funding</h2>
        <p class="muted small">Enrolled students by funding program. Set funding on each student’s page.</p>
        ${[...Object.entries(FUNDING), ['unset', 'No funding set']].map(([k, label]) => {
          const list = enrolled.filter((s) => {
            const fund = state.finance[s.id]?.funding || [];
            return k === 'unset' ? !fund.length : fund.includes(k);
          });
          return `<details class="fund-group"><summary><b>${esc(label)}</b> <span class="muted">${list.length}</span></summary>
            <ul>${list.map((s) => `<li><a href="#" data-student="${s.id}">${esc(s.name)}</a> <span class="muted small">${esc(classroomName(s.classroom_id))}${state.finance[s.id]?.award_id ? ' · ID ' + esc(state.finance[s.id].award_id) : ''}</span></li>`).join('') || '<li class="muted">None</li>'}</ul></details>`;
        }).join('')}
      </section>
      <div class="toolbar"><span class="spacer"></span><button class="btn small" id="rp-csv" type="button">Download ${esc(fmtMonth(m))} payments (CSV)</button></div>`;
    bindMonthBar(el, renderReports);
    $$('.report-year tr[data-month]', el).forEach((tr) => tr.addEventListener('click', () => { state.month = tr.dataset.month; renderReports(el); }));
    $$('[data-student]', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openStudent(a.dataset.student); }));
    $('#rp-csv', el).addEventListener('click', () => csvDownload(`creativa-payments-${m}.csv`,
      ['Receipt', 'Date received', 'For month', 'Student', 'Class', 'Paid by', 'Method', 'Reference', 'Amount', 'Award ID', 'Note'],
      pays.slice().sort((a, b) => a.paid_on.localeCompare(b.paid_on) || a.receipt_no - b.receipt_no).map((p) => {
        const s = state.students.find((x) => x.id === p.student_id) || {};
        return [p.receipt_no, p.paid_on, p.covers_month.slice(0, 7), s.name, classroomName(s.classroom_id), PAYER[p.payer],
          METHOD[p.method], p.reference, p.amount, state.finance[p.student_id]?.award_id, p.note];
      })));
  }

  // ───────────── Settings panels (admin) ─────────────
  function settingsPanelsHtml() {
    if (!state.hasEnrollment) return '';
    const set = state.settings || {};
    return `
      <section class="panel settings-panel"><h2>Classes</h2>
        <p class="muted small">Teachers and capacity show on the Enrollment page. Changes save as you go.</p>
        <div class="table-wrap flat"><table class="class-table"><thead><tr><th>Class</th><th>Teachers</th><th>Capacity</th><th>Order</th></tr></thead>
        <tbody>${state.classrooms.map((c) => `<tr data-cls="${c.id}">
          <td><input data-k="name" value="${esc(c.name)}" aria-label="Class name"></td>
          <td><input data-k="teachers" value="${esc(c.teachers)}" aria-label="Teachers"></td>
          <td><input data-k="capacity" type="number" min="1" max="99" value="${esc(c.capacity)}" aria-label="Capacity"></td>
          <td><input data-k="sort" type="number" value="${esc(c.sort)}" aria-label="Order"></td></tr>`).join('')}</tbody></table></div>
        <button class="btn small" id="cls-add" type="button">+ Add class</button>
      </section>
      <section class="panel settings-panel"><h2>Receipts</h2>
        <form id="set-receipt" class="grid2">
          ${fInput('school_name', 'School name', set.school_name)}
          ${fInput('receipt_signer', 'Signed by', set.receipt_signer, 'text', 'placeholder="Name, Director"')}
          <label class="full">Under the name (address, phone, tax ID)<textarea name="receipt_header" rows="3">${esc(set.receipt_header)}</textarea></label>
          <div class="full"><button class="btn small primary" type="submit">Save receipt details</button></div>
        </form>
      </section>
      <section class="panel settings-panel"><h2>Automatic tour emails</h2>
        <p class="muted small">Sent by the hourly email job: a reminder the day before each tour (from 9am), and a
        “how was your visit?” email a week after it (from 10am) if the family is still at Tour scheduled or Toured and
        nobody has logged a call, email or text since. Each sent email is logged on the family’s timeline.
        You can switch it off for one family in their inquiry.</p>
        <p class="muted small">You can use: <code>{parent}</code> <code>{child}</code> <code>{child_es}</code>
          <code>{tour_date}</code> <code>{tour_date_es}</code> <code>{tour_time}</code></p>
        <form id="set-emails" class="grid2">
          <label class="full pill-check"><input type="checkbox" class="check" name="emails_enabled" ${set.emails_enabled !== false ? 'checked' : ''}> Send automatic tour emails</label>
          <label class="full">Reminder subject<input name="tour_reminder_subject" value="${esc(set.tour_reminder_subject)}"></label>
          <label class="full">Reminder email<textarea name="tour_reminder_body" rows="9">${esc(set.tour_reminder_body)}</textarea></label>
          <label class="full">Follow-up subject<input name="followup_subject" value="${esc(set.followup_subject)}"></label>
          <label class="full">Follow-up email<textarea name="followup_body" rows="9">${esc(set.followup_body)}</textarea></label>
          <div class="full"><button class="btn small primary" type="submit">Save emails</button></div>
        </form>
      </section>`;
  }

  function bindSettingsPanels(el) {
    if (!state.hasEnrollment) return;
    $$('.class-table input', el).forEach((input) => input.addEventListener('change', async () => {
      const id = input.closest('tr').dataset.cls, k = input.dataset.k;
      let v = input.value.trim();
      if (k === 'name' && !v) return renderStaff(el);
      if (k === 'capacity' || k === 'sort') v = v === '' ? (k === 'sort' ? 100 : null) : Number(v);
      const { data, error } = await sb.from('classrooms').update({ [k]: v === '' ? null : v }).eq('id', id).select().single();
      if (error) { fail(error, 'Could not save the class'); return renderStaff(el); }
      state.classrooms = state.classrooms.map((c) => (c.id === id ? data : c)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
      toast('Saved');
    }));
    $('#cls-add', el).addEventListener('click', async () => {
      const name = (prompt('Name of the new class (e.g. 15–17 months)') || '').trim();
      if (!name) return;
      const { data, error } = await sb.from('classrooms').insert({ name, sort: Math.max(0, ...state.classrooms.map((c) => c.sort)) + 10 }).select().single();
      if (error) return fail(error, 'Could not add the class');
      state.classrooms.push(data);
      renderStaff(el);
      toast('Class added');
    });
    const saveSettings = (form, keys) => form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = {};
      keys.forEach((k) => { patch[k] = form[k].type === 'checkbox' ? form[k].checked : (form[k].value.trim() || null); });
      if (['school_name', 'tour_reminder_subject', 'tour_reminder_body', 'followup_subject', 'followup_body'].some((k) => k in patch && !patch[k])) {
        return toast('Subjects, emails and the school name can’t be empty', true);
      }
      const { data, error } = await sb.from('settings').update(patch).eq('id', 1).select().single();
      if (error) return fail(error, 'Could not save');
      state.settings = data;
      toast('Saved');
    });
    saveSettings($('#set-receipt', el), ['school_name', 'receipt_signer', 'receipt_header']);
    saveSettings($('#set-emails', el), ['emails_enabled', 'tour_reminder_subject', 'tour_reminder_body', 'followup_subject', 'followup_body']);
  }

  // ───────────── Inquiry drawer ─────────────
  function openDrawer(id, preset = {}) {
    closeDrawer(true);
    state.openId = id;
    const inq = id ? state.inquiries.find((x) => x.id === id) : { stage: 'new', source: 'manual' };
    if (!inq) return;
    const v = { ...inq, ...preset };
    const others = id ? state.inquiries.filter((x) => x.id !== id && (
      (inq.email && x.email && x.email.toLowerCase() === inq.email.toLowerCase()) ||
      (inq.phone_digits && x.phone_digits === inq.phone_digits))) : [];
    const sel = (name, options, cur) => `<select name="${name}">${options.map(([val, label]) =>
      `<option value="${esc(val)}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    const inp = (name, label, type = 'text', extra = '') =>
      `<label>${label}<input name="${name}" type="${type}" value="${esc(type === 'datetime-local' ? toLocalInput(v[name]) : v[name])}" ${extra}></label>`;
    const tel = digits(inq.phone);
    const student = id && state.hasEnrollment && state.students.find((s) => s.inquiry_id === id);
    const enrollLink = !id || !state.hasEnrollment ? ''
      : student ? `<p class="small enroll-link">On the enrollment list: <a href="#" id="open-student">${esc(student.name)}</a></p>`
        : inq.stage === 'enrolled' ? `<p class="enroll-link"><button class="btn small primary" type="button" id="to-roster">Add ${esc(inq.child_name || 'child')} to the enrollment list</button></p>` : '';

    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    const drawer = document.createElement('aside');
    drawer.className = 'drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.innerHTML = `
      <div class="drawer-head">
        <h2>${id ? esc(inq.parent_name || '(no name)') : 'New inquiry'}
          ${id ? `<div class="sub">${esc(SOURCE_LABEL[inq.source] || inq.source)} · received ${esc(fmtDateTime(inq.created_at))}</div>` : ''}</h2>
        <button class="btn ghost" data-close aria-label="Close">✕</button>
      </div>
      <form class="drawer-body" id="inq-form" novalidate>
        ${id && (tel || inq.email) ? `<div class="quick section">
          ${tel ? `<a class="btn small" href="tel:${tel}">Call</a><a class="btn small" href="sms:${tel}">Text</a>` : ''}
          ${inq.email ? `<a class="btn small" href="mailto:${esc(inq.email)}">Email</a>` : ''}</div>` : ''}
        ${others.length ? `<div class="section panel small"><b>Same family also inquired:</b>
          ${others.map((o) => `<div><a href="#" data-open="${o.id}">${esc(SOURCE_LABEL[o.source] || o.source)}, ${esc(fmtDate(o.created_at))}</a> · ${STAGE_LABEL[o.stage]}</div>`).join('')}</div>` : ''}
        <div class="section"><h3>Pipeline</h3><div class="grid2">
          <label>Stage${sel('stage', STAGES.map((s) => [s, STAGE_LABEL[s]]), v.stage)}</label>
          <label>Assigned to${sel('assigned_to', [['', 'Unassigned'], ...state.staff.filter((s) => s.active || s.id === v.assigned_to).map((s) => [s.id, s.full_name || s.email])], v.assigned_to)}</label>
          ${inp('tour_at', 'Tour date & time', 'datetime-local')}
          ${inp('next_follow_up', 'Next follow-up', 'date')}
          <label class="full" id="lost-wrap" ${v.stage === 'lost' ? '' : 'hidden'}>Reason lost${inp('lost_reason', '').replace(/^<label>|<\/label>$/g, '')}</label>
          ${state.hasEnrollment ? `<label class="full pill-check"><input type="checkbox" class="check" name="auto_emails" ${v.auto_emails !== false ? 'checked' : ''}>
            Automatic tour emails (reminder the day before, check-in a week after)</label>
            ${inq.tour_reminder_sent_at || inq.followup_sent_at ? `<p class="full muted small">${[
              inq.tour_reminder_sent_at && 'Reminder emailed ' + fmtDateTime(inq.tour_reminder_sent_at),
              inq.followup_sent_at && 'Follow-up emailed ' + fmtDateTime(inq.followup_sent_at)].filter(Boolean).map(esc).join(' · ')}</p>` : ''}` : ''}
        </div>
        ${enrollLink}</div>
        <div class="section"><h3>Parent</h3><div class="grid2">
          ${inp('parent_name', 'Name', 'text', 'autocomplete="off"')}
          ${inp('phone', 'Phone', 'tel')}
          ${inp('email', 'Email', 'email')}
          ${inp('contact_pref', 'Prefers', 'text', 'placeholder="Call, text, email…"')}
          ${inp('heard_from', 'Heard about us', 'text')}
        </div></div>
        <div class="section"><h3>Child</h3><div class="grid2">
          ${inp('child_name', 'Name')}
          <label>Date of birth<input name="child_dob" type="date" value="${esc(v.child_dob)}">${v.child_dob ? `<span class="muted small">${esc(ageOf(v.child_dob))}</span>` : ''}</label>
          ${inp('program', 'Program', 'text', 'list="programs"')}
          ${inp('desired_start', 'Wants to start')}
          <label class="full">Message / notes from family<textarea name="message" rows="3">${esc(v.message)}</textarea></label>
        </div></div>
        <datalist id="programs">${PROGRAMS.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
        ${id ? `<div class="section"><h3>Activity</h3>
          <div class="note-form">
            <select id="note-kind">${['note', 'call', 'email', 'text'].map((k) => `<option value="${k}">${KIND_LABEL[k]}</option>`).join('')}</select>
            <span></span>
            <textarea id="note-body" placeholder="Log a call, a note, what was said…"></textarea>
            <button class="btn small" type="button" id="note-add">Add to timeline</button>
          </div>
          <ul class="timeline" id="timeline"><li class="muted">Loading…</li></ul></div>` : ''}
        ${id && inq.source !== 'manual' && Object.keys(inq.raw || {}).length ? `<details class="raw section"><summary>Original website submission</summary><dl>
          ${Object.entries(inq.raw).filter(([k]) => k !== 'form-name').map(([k, val]) =>
            `<dt>${esc(k.replace(/\[\]$/, '').replace(/[-_]/g, ' '))}</dt><dd>${esc(Array.isArray(val) ? val.join(', ') : val)}</dd>`).join('')}</dl></details>` : ''}
      </form>
      <div class="drawer-foot">
        ${id && isAdmin() ? '<button class="btn danger" id="del">Delete</button>' : ''}
        <span class="spacer"></span>
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" id="save">${id ? 'Save' : 'Add inquiry'}</button>
      </div>`;
    document.body.append(scrim, drawer);
    document.body.style.overflow = 'hidden';

    const form = $('#inq-form', drawer);
    let dirty = Object.keys(preset).length > 0;
    form.addEventListener('input', () => { dirty = true; });
    form.stage.addEventListener('change', () => { $('#lost-wrap', drawer).hidden = form.stage.value !== 'lost'; });
    form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    const tryClose = () => { if (!dirty || confirm('Discard your changes?')) closeDrawer(); };
    $$('[data-close]', drawer).forEach((b) => b.addEventListener('click', tryClose));
    scrim.addEventListener('click', tryClose);
    drawer.addEventListener('keydown', (e) => { if (e.key === 'Escape') tryClose(); });
    $$('[data-open]', drawer).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); if (!dirty || confirm('Discard your changes?')) openDrawer(a.dataset.open); }));
    $('#save', drawer).addEventListener('click', save);
    if (id && isAdmin()) $('#del', drawer).addEventListener('click', remove);
    if (id) {
      $('#note-add', drawer).addEventListener('click', addNote);
      loadTimeline();
    }
    const leave = (fn) => (e) => { e.preventDefault(); if (!dirty || confirm('Discard your changes?')) fn(); };
    $('#open-student', drawer)?.addEventListener('click', leave(() => openStudent(student.id)));
    $('#to-roster', drawer)?.addEventListener('click', leave(() => studentFromInquiry(inq)));
    (id ? $('[data-close]', drawer) : form.parent_name).focus();

    async function save() {
      const patch = {};
      FIELDS.forEach((k) => {
        let val = form[k].value.trim();
        if (k === 'tour_at') val = val ? new Date(val).toISOString() : '';
        if (k === 'email') val = val.toLowerCase();
        patch[k] = val === '' ? null : val;
      });
      if (!patch.parent_name && !patch.child_name) return toast('Add the parent’s or child’s name', true);
      if (!patch.phone && !patch.email) return toast('Add a phone number or email', true);
      if (patch.stage === 'lost' && !patch.lost_reason) { form.lost_reason.focus(); return toast('Add the reason this family was lost', true); }
      if (patch.stage !== 'lost') patch.lost_reason = null;
      if (state.hasEnrollment) patch.auto_emails = form.auto_emails.checked;
      const btn = $('#save', drawer);
      btn.disabled = true;
      const q = id
        ? sb.from('inquiries').update(patch).eq('id', id)
        : sb.from('inquiries').insert({ ...patch, source: 'manual', created_by: state.me.id });
      const { data, error } = await q.select().single();
      btn.disabled = false;
      if (error) return fail(error, 'Could not save');
      upsertLocal(data);
      dirty = false;
      toast(id ? 'Saved' : 'Inquiry added');
      renderView();
      openDrawer(data.id);
    }

    async function remove() {
      if (!confirm(`Delete this inquiry from ${inq.parent_name || 'this family'} and its whole timeline? This can’t be undone.`)) return;
      const { error } = await sb.from('inquiries').delete().eq('id', id);
      if (error) return fail(error, 'Could not delete');
      state.inquiries = state.inquiries.filter((x) => x.id !== id);
      closeDrawer();
      renderView();
      toast('Deleted');
    }

    async function loadTimeline() {
      const { data, error } = await sb.from('activities').select('*').eq('inquiry_id', id).order('created_at', { ascending: false });
      const ul = $('#timeline', drawer);
      if (!ul) return;
      if (error) { ul.innerHTML = '<li class="muted">Could not load activity.</li>'; return; }
      ul.innerHTML = data.map((a) => `<li class="k-${a.kind}">
          <div class="t-head"><span class="kind">${KIND_LABEL[a.kind]}</span>
            <span>${esc(fmtDateTime(a.created_at))}${a.author ? ' · ' + esc(staffName(a.author)) : ''}</span>
            ${['note', 'call', 'email', 'text'].includes(a.kind) && (a.author === state.me.id || isAdmin()) ? `<button class="x" data-del="${a.id}" type="button">delete</button>` : ''}</div>
          <div class="t-body">${esc(a.body)}</div></li>`).join('') || '<li class="muted">No activity yet.</li>';
      $$('[data-del]', ul).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this entry?')) return;
        const { error: e } = await sb.from('activities').delete().eq('id', b.dataset.del);
        if (e) return fail(e, 'Could not delete entry');
        loadTimeline();
      }));
    }

    async function addNote() {
      const body = $('#note-body', drawer).value.trim();
      if (!body) return;
      const kind = $('#note-kind', drawer).value;
      const btn = $('#note-add', drawer);
      btn.disabled = true;
      const { error } = await sb.from('activities').insert({ inquiry_id: id, kind, body, author: state.me.id });
      btn.disabled = false;
      if (error) return fail(error, 'Could not add to timeline');
      $('#note-body', drawer).value = '';
      // A logged call/email/text on a brand-new inquiry means the family has been contacted.
      if (kind !== 'note' && inq.stage === 'new' && form.stage.value === 'new') {
        await setStage(inq, 'contacted');
        form.stage.value = 'contacted';
      }
      loadTimeline();
    }
  }

  function closeDrawer(silent) {
    $$('.scrim, .drawer').forEach((n) => n.remove());
    document.body.style.overflow = '';
    if (!silent) state.openId = undefined;
  }
})();
