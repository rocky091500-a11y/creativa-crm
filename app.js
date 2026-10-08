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
    loadedAt: 0,
    view: store.get('view', 'today'),
    filters: { q: '', stage: '', program: '', source: '', assigned: '', ...store.get('filters', {}) },
    openId: undefined, // undefined = closed, null = new inquiry
  };
  const staffName = (id) => state.staff.find((s) => s.id === id)?.full_name || '';
  const isAdmin = () => state.me?.role === 'admin';

  // ───────────── auth ─────────────
  sb.auth.onAuthStateChange((event, session) => {
    state.session = session;
    if (event === 'PASSWORD_RECOVERY') state.needPassword = true;
    if (event === 'SIGNED_OUT') { state.me = null; state.inquiries = []; state.staff = []; }
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
  async function loadAll() {
    const [p, i] = await Promise.all([
      sb.from('profiles').select('*').order('full_name'),
      sb.from('inquiries').select('*').order('created_at', { ascending: false }).limit(5000),
    ]);
    if (p.error) return fail(p.error, 'Could not load staff');
    if (i.error) return fail(i.error, 'Could not load inquiries');
    state.staff = p.data;
    state.inquiries = i.data;
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
    const views = { ...VIEWS, ...(isAdmin() ? { staff: 'Staff' } : {}) };
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
    ({ today: renderToday, board: renderBoard, list: renderList, staff: renderStaff })[state.view](el);
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
      </div>`;
    $$('.row', el).forEach((r) => r.addEventListener('click', () => openDrawer(r.dataset.id)));
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
        Turning Active off removes their access immediately.</p></div>
      <div class="table-wrap"><table class="staff-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th>Joined</th></tr></thead>
      <tbody>${state.staff.map((s) => {
        const self = s.id === state.me.id;
        return `<tr data-id="${s.id}">
          <td>${esc(s.full_name || '')}${self ? ' <span class="muted small">(you)</span>' : ''}</td>
          <td>${esc(s.email)}</td>
          <td><select data-k="role" ${self ? 'disabled' : ''}>
            <option value="staff" ${s.role === 'staff' ? 'selected' : ''}>Staff</option>
            <option value="admin" ${s.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
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
      </section>`;
    loadCalendarFeed();
    $$('.staff-table [data-k]', el).forEach((input) => input.addEventListener('change', async () => {
      const id = input.closest('tr').dataset.id;
      const patch = { [input.dataset.k]: input.type === 'checkbox' ? input.checked : input.value };
      const { data, error } = await sb.from('profiles').update(patch).eq('id', id).select().single();
      if (error) { fail(error, 'Could not update staff member'); return renderStaff(el); }
      state.staff = state.staff.map((s) => (s.id === id ? data : s));
      toast('Saved');
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
        </div></div>
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
