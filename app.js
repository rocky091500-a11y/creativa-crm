/* Creativa CRM — enrollment pipeline for Creativa Academy staff.
   Plain JS, no build step. Data lives in Supabase; see supabase/migrations/001_init.sql. */
(() => {
  'use strict';

  const STAGES = ['new', 'contacted', 'tour_scheduled', 'reschedule', 'toured', 'waitlisted', 'enrolled', 'lost'];
  const STAGE_LABEL = {
    new: 'New', contacted: 'Contacted', tour_scheduled: 'Tour scheduled', reschedule: 'Reschedule', toured: 'Toured',
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
  const STUDENT_STATUS = { enrolled: 'Enrolled', waitlist: 'Waiting list', withdrawn: 'Withdrawn', graduated: 'Graduated' };
  const LEFT = new Set(['withdrawn', 'graduated']);   // no longer at the school; withdrawn_on is their last day
  const DOCS = [['doc_registration', 'Registration packet', 'Packet'], ['doc_blue_form', 'Blue form', 'Blue'],
    ['doc_yellow_form', 'Yellow form', 'Yellow'], ['doc_birth_cert', 'Birth certificate', 'Birth cert.']];
  const REG_FEE = { paid: 'Paid', not_paid: 'Not paid', na: 'N/A' };
  const RBT = { yes: 'RBT', in_process: 'RBT in process' };
  // Funding programs a student can be on. A student on none of them is private pay.
  const PROGRAMS_FUNDING = { sr: 'School Readiness', sr_bpiece: 'SR – BPIECE', fes_ua: 'FES-UA', fes_eo: 'FES-EO', vpk: 'VPK',
    stepup_pending: 'Step Up (pending)' };
  // Biweekly billing (007_billing_contacts.sql)
  const CONTACT_ROLE = { primary: 'Primary', secondary: 'Secondary', emergency: 'Emergency / authorized' };
  const INV_STATUS = { paid: 'Paid', partial: 'Partly paid', open: 'Open', overdue: 'Late', void: 'Void',
    check: 'Check amount', missing: 'Not on the sheet',
    not_invoiced: 'Not billed yet', stepup: 'Step Up pending', school_year: 'School-year tuition', not_billed: 'Not billed to family', unset: 'No rate set',
    none: 'Nothing due' };
  const FUNDING = { ...PROGRAMS_FUNDING, private: 'Private pay' };
  const FREQ = { monthly: 'monthly', biweekly: 'biweekly', weekly: 'weekly', school_year: 'a school year' };
  // How many payments of each kind make up a month's tuition on the Tuition page (a school year: 10 months).
  const PER_MONTH = { monthly: 1, biweekly: 2, weekly: 4, school_year: 0.1 };
  const PAYER = { parent: 'Parent', sr: 'School Readiness', fes: 'FES / Step Up', vpk: 'VPK', other: 'Other' };
  const METHOD = { cash: 'Cash', check: 'Check', zelle: 'Zelle', card: 'Credit / debit card', ach: 'Bank transfer', other: 'Other' };
  // Payroll time clock (008_payroll_timeclock.sql). Times are the school's (Miami) time.
  const TZ = 'America/New_York';
  const PAY_FREQ = { weekly: 'Every week', biweekly: 'Every two weeks', semimonthly: 'Twice a month (1st–15th and 16th–end)', monthly: 'Once a month' };
  const LUNCH = [[0, 'None'], [15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour']];
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
  // Same rule as public._e164(): only US numbers get automatic texts.
  const e164 = (s) => {
    const d = digits(s);
    if (d.length === 10 && d[0] >= '2') return '+1' + d;
    if (d.length === 11 && d[0] === '1' && d[1] >= '2') return '+' + d;
    return null;
  };
  const textsOn = () => state.settings?.texts_enabled === true;
  const textsStopped = (phone) => { const n = e164(phone); return Boolean(n && state.optOuts?.has(n)); };

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
  // ───── Español: the CRM's own words in Spanish on screen (es.js), for staff who prefer it. Names and anything people type
  // stay as written, and printed papers (receipts, statements, the food program record) stay in English. Text is translated
  // as it appears, whole or with its numbers and month/day names in place ({n}).
  const ES = window.CRM_ES || {}, ES_DATES = window.CRM_ES_DATES || {};
  const ES_TOKEN = new RegExp(`\\$?-?\\d[\\d,]*(?:\\.\\d+)?(?::\\d\\d)?%?|\\b(?:${Object.keys(ES_DATES).join('|')})\\b`, 'g');
  function esText(text) {
    const core = text.replace(/\s+/g, ' ').trim();
    if (!core || !/[A-Za-z]/.test(core)) return null;
    const wrap = (t) => text.replace(/^(\s*)[\s\S]*?(\s*)$/, (m, a, b) => a + t + b);
    if (ES[core]) return wrap(ES[core]);
    const toks = core.match(ES_TOKEN) || [], key = core.replace(ES_TOKEN, '{n}');
    const tr = (t) => ES_DATES[t] || t;
    if (toks.length && ES[key]) { let k = 0; return wrap(ES[key].replace(/\{n\}/g, () => tr(toks[k++] ?? ''))); }
    const c = core.indexOf(': ');   // "Saved: Rent $1,000.00", "New tour request: (name)": the words before the colon
    if (c > 0 && ES[core.slice(0, c)]) return wrap(`${ES[core.slice(0, c)]}: ${core.slice(c + 2).replace(ES_TOKEN, tr)}`);
    return toks.length && /\d/.test(core) ? wrap(core.replace(ES_TOKEN, tr)) : null;   // a date: just its month and day names
  }
  const esSkip = (el) => !!el?.closest('[data-no-es], .print-sheet, textarea, script, style, [contenteditable]');
  const esDone = new WeakMap();
  function esNode(node) {
    if (node.nodeType === 3) {
      if (esDone.get(node) === node.nodeValue || esSkip(node.parentElement)) return;
      const v = esText(node.nodeValue);
      if (v != null && v !== node.nodeValue) node.nodeValue = v;
      esDone.set(node, node.nodeValue);
      return;
    }
    if (node.nodeType !== 1 || esSkip(node)) return;
    [node, ...node.querySelectorAll('[placeholder], [aria-label], [title]')].forEach((el) => ['placeholder', 'aria-label', 'title'].forEach((a) => {
      const v = el.getAttribute?.(a), t = v && !esSkip(el) && esText(v);
      if (t && t !== v) el.setAttribute(a, t);
    }));
    const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) esNode(n);
  }
  const esObserver = new MutationObserver((ms) => ms.forEach((m) => (m.type === 'characterData' ? esNode(m.target) : m.addedNodes.forEach(esNode))));
  const nativeAsk = { confirm: window.confirm.bind(window), prompt: window.prompt.bind(window), alert: window.alert.bind(window) };
  ['confirm', 'prompt', 'alert'].forEach((k) => { window[k] = (msg, ...rest) => nativeAsk[k](state.lang === 'es' && msg ? esText(String(msg)) ?? msg : msg, ...rest); });
  function setLang(lang) {
    state.lang = lang === 'es' ? 'es' : 'en';
    store.set('lang', state.lang);
    document.documentElement.lang = state.lang;
    esObserver.disconnect();
    if (state.lang === 'es') {
      esNode(document.body);
      esObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
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
    hasV5: false,         // false until 006_reschedule_telegram_spam.sql has been run
    hasV6: false,         // false until 007_billing_contacts.sql has been run
    hasV7: false,         // false until 008_payroll_timeclock.sql has been run
    signature: null,      // receipt signature image (data: URL), finance only
    history: [],          // balances from the billing system's sheets (010), finance only
    hasLog: false,        // false until 012_change_log.sql has been run
    hasMsgs: false,       // false until 013_family_texts.sql has been run (and only for those who can text)
    msgDraft: null,
    unseen: [],           // changes by other people since I last opened Changes (012)
    changeFilters: { who: '', area: '', q: '' },
    pay: null,            // Payroll page data for payPeriod
    payPeriod: null,
    payTab: store.get('payTab', 'hours'),
    invoices: [],
    contacts: [],
    period: null,         // billing Monday shown on the Tuition page
    month: thisMonth(),
    rosterFilters: { q: '', classroom: '', status: 'enrolled', docs: '', funding: '', ...store.get('rosterFilters', {}) },
    tuitionFilters: { q: '', status: '', funding: '' },
    loadedAt: 0,
    view: store.get('view', 'today'),
    moneyTab: store.get('moneyTab', 'overview'),
    lang: store.get('lang', 'en'),
    rosterTab: store.get('rosterTab', 'children'),
    regFilters: { q: '', cls: '', status: '' },
    todoFilter: store.get('todoFilter', 'all'),
    projMonths: store.get('projMonths', 6),
    filters: { q: '', stage: '', program: '', source: '', assigned: '', ...store.get('filters', {}) },
    openId: undefined, // undefined = closed, null = new inquiry
  };
  setLang(state.lang);   // Español, if this device chose it
  const staffName = (id) => state.staff.find((s) => s.id === id)?.full_name || '';
  const isAdmin = () => state.me?.role === 'admin';
  const canViewFinance = () => isAdmin() || ['view', 'edit'].includes(state.me?.finance);
  const canEditFinance = () => isAdmin() || state.me?.finance === 'edit';
  const canPayroll = () => state.hasV7 && (isAdmin() || state.me?.payroll === true);
  const classroomName = (id) => state.classrooms.find((c) => c.id === id)?.name || '';
  // The Reschedule stage exists once 006_reschedule_telegram_spam.sql has been run.
  const stages = () => (state.hasV5 ? STAGES : STAGES.filter((s) => s !== 'reschedule'));
  // A student's funding programs, or ['private'] when they are on none.
  function fundingOf(sid) {
    const programs = (state.finance[sid]?.funding || []).filter((k) => PROGRAMS_FUNDING[k]);
    if (programs.includes('sr_bpiece') && !programs.includes('sr')) programs.unshift('sr');   // BPIECE is School Readiness
    return programs.length ? programs : ['private'];
  }
  const hasFunding = (sid, k) => fundingOf(sid).includes(k);

  // ── billing periods: every billing_period_days (14) from billing_anchor, a Monday ──
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return localDate(x); };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
  const billing = () => ({ anchor: state.settings?.billing_anchor || '2026-10-05', days: state.settings?.billing_period_days || 14 });
  function periodOf(day) {
    const { anchor, days } = billing();
    return addDays(anchor, Math.floor(daysBetween(anchor, day) / days) * days);
  }
  const periodEnd = (p) => addDays(p, billing().days - 3);          // Friday of the second week
  const fmtPeriod = (p) => `${fmtDate(p)} – ${fmtDate(periodEnd(p))}`;
  const longPeriod = (p) => `${new Date(p + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${longDate(periodEnd(p))}`;
  const invoicePaid = (inv) => round2(state.payments.filter((x) => x.invoice_id === inv.id).reduce((t, x) => t + Number(x.amount), 0));
  function invoiceStatus(inv) {
    if (inv.void) return 'void';
    const paid = invoicePaid(inv);
    if (paid >= Number(inv.amount)) return 'paid';
    if (paid > 0) return 'partial';
    return todayStr() > addDays(inv.due_date, 4) ? 'overdue' : 'open';   // the billing system allows until Friday
  }
  const invoiceBalance = (inv) => (inv.void ? 0 : Math.max(round2(Number(inv.amount) - invoicePaid(inv)), 0));
  // Late: money still owed after the Friday grace day. A weekly payer's two-week bill has a second Friday for its second
  // week (018), so paying the first week on time isn't late.
  function invoiceLate(inv) {
    if (inv.void || invoiceBalance(inv) <= 0 || todayStr() <= addDays(inv.due_date, 4)) return false;
    return !(inv.kind === 'tuition' && state.finance[inv.student_id]?.tuition_frequency === 'weekly'
      && todayStr() <= addDays(inv.due_date, 11) && invoicePaid(inv) >= Number(inv.amount) / 2);
  }
  const openInvoices = (sid) => state.invoices.filter((i) => i.student_id === sid && !i.void && invoiceBalance(i) > 0)
    .sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
  const lateFeeFor = (inv) => (inv.late_fee_for && state.invoices.find((i) => i.id === inv.late_fee_for)) || null;   // the tuition it's for
  const lateFeeOf = (inv) => state.invoices.find((i) => i.late_fee_for === inv.id && !i.void) || null;
  // Take a late fee off (added by mistake, or let go). If anything was paid toward it, that money stays as a credit.
  async function removeLateFee(feeId, after) {
    const inv = state.invoices.find((i) => i.id === feeId);
    if (!inv) return;
    const who = state.students.find((s) => s.id === inv.student_id)?.name || 'this child', paid = invoicePaid(inv);
    if (!confirm(`Take off the ${money(inv.amount)} late fee for ${who}?${paid ? ` The ${money(paid)} paid toward it stays as a credit.` : ''}`)) return;
    if (paid) {
      const { error } = await sb.from('payments').update({ invoice_id: null }).eq('invoice_id', inv.id);
      if (error) return fail(error, 'Could not take off the late fee');
      state.payments = state.payments.map((x) => (x.invoice_id === inv.id ? { ...x, invoice_id: null } : x));
    }
    const { data, error } = await sb.from('invoices').update({ void: true,
      note: [inv.note, `Taken off ${fmtDate(todayStr())} by ${state.me.full_name || state.me.email}`].filter(Boolean).join(' · ') }).eq('id', inv.id).select().single();
    if (error) return fail(error, 'Could not take off the late fee');
    state.invoices = state.invoices.map((i) => (i.id === data.id ? data : i));
    toast(`Late fee taken off${paid ? `; ${money(paid)} kept as a credit` : ''}`);
    after();
  }
  function invoiceLabel(inv) {
    if (inv.kind === 'tuition') return `${inv.description} · ${fmtPeriod(inv.period_start)}`;
    const t = lateFeeFor(inv);
    return t ? `${inv.description} · ${fmtPeriod(t.period_start)}` : `${inv.description} · ${fmtDate(inv.invoice_date)}`;
  }
  const contactName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ');
  // Registration is what holds a spot on the waiting list: marked Paid on the student, or a registration bill paid in full.
  const regPaid = (s) => s.reg_fee === 'paid' || (state.invoices || []).some((i) => i.student_id === s.id && i.kind !== 'tuition' && !i.void
    && /regist/i.test(i.description) && Number(i.amount) > 0 && invoiceBalance(i) <= 0
    && !(state.registrations || []).some((r) => r.invoice_id === i.id));   // next year's registration (023) is tracked on its own
  // A family in the Pipeline: from their student record once they have one, or the day it was recorded on the inquiry.
  const inqRegPaid = (i) => {
    const s = state.students.find((x) => x.inquiry_id === i.id);
    return s ? regPaid(s) : !!i.reg_paid_on;
  };
  // The school's rates for a class (020): full time and with after care, a week (Kindergarten: a school year).
  const RATE_KIND = { full: 'Full time', after_care: 'Full time + After care' };
  function classRates(classId) {
    const c = state.classrooms.find((x) => x.id === classId);
    if (!c || !(Number(c.rate_full) > 0)) return [];
    return Object.keys(RATE_KIND).map((k) => ({ k, label: RATE_KIND[k], amt: Number(k === 'full' ? c.rate_full : c.rate_after_care), year: c.rate_per === 'school_year' }))
      .filter((r) => r.amt > 0);
  }
  const rateText = (r) => `${money(r.amt)} ${r.year ? 'a school year' : 'a week'}`;
  // The class rates as a list to pick from: "Until 3:00 — $540.00 every 2 weeks ($270.00 a week)", kept to how the family pays.
  const rateUntil = (r) => (r.k === 'full' ? (r.year ? 'Until 2:30' : 'Until 3:00') : (r.year ? 'Until 5:45 (after care & multisports)' : 'Until 5:45 (after care)'));
  function rateOption(r, freq) {
    const a = rateAs(r, freq);
    return `${rateUntil(r)} — ${money(a.amount)} ${a.freq === 'biweekly' ? 'every 2 weeks' : a.freq === 'weekly' ? 'a week' : 'a school year'}${a.freq === 'biweekly' ? ` (${money(r.amt)} a week)` : ''}`;
  }
  const rateSelect = (id, rs, freq, chosen, dis = '') => `<label class="full">Class rate<select id="${id}" ${dis}><option value="">Pick a class rate…</option>
    ${rs.map((r) => `<option value="${r.k}" ${chosen === r.k ? 'selected' : ''}>${esc(rateOption(r, freq))}</option>`).join('')}
    <option value="other" ${chosen === 'other' ? 'selected' : ''}>Other amount (type it in Rate)</option></select></label>`;
  // A class rate as a child's rate, kept to how the family pays: weekly, or every 2 weeks (Kindergarten: the school year).
  const rateAs = (r, freq) => (r.year ? { amount: r.amt, freq: 'school_year' } : freq === 'weekly' ? { amount: r.amt, freq: 'weekly' } : { amount: round2(r.amt * 2), freq: 'biweekly' });
  // A child's rate next to their class's: which class rate it is, or how far from the nearest one. Null when the class has
  // no rates, or for School Readiness (the rate there is the family's share).
  function rateCheck(classId, fr) {
    const rs = classRates(classId);
    if (!rs.length || (fr.funding || []).includes('sr')) return null;
    if (fr.tuition_amount == null || fr.tuition_amount === '') return { none: true, rs };
    const amt = Number(fr.tuition_amount);
    const match = rs.find((r) => { const a = rateAs(r, fr.tuition_frequency); return a.freq === fr.tuition_frequency && a.amount === amt; });
    if (match) return { match, rs };
    const per = rs[0].year ? (fr.tuition_frequency === 'school_year' ? amt : null)
      : ({ weekly: amt, biweekly: amt / 2, monthly: (amt * 12) / 52 })[fr.tuition_frequency] ?? null;
    if (per == null) return { diff: true, rs, text: 'not on the class’s rates' };
    const near = rs.reduce((a, r) => (Math.abs(r.amt - per) < Math.abs(a.amt - per) ? r : a));
    const pct = Math.round(((per - near.amt) / near.amt) * 100);
    return { diff: true, rs, near, text: pct ? `${Math.abs(pct)}% ${pct < 0 ? 'less' : 'more'} than ${near.label.toLowerCase()} (${rateText(near)})` : `close to ${near.label.toLowerCase()} (${rateText(near)})` };
  }
  const rateCheckText = (c) => (!c ? '' : c.none ? 'No rate yet' : c.match ? `${c.match.label}, the class rate` : `Not the class rate: ${c.text}`);

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
    $('#lang')?.addEventListener('click', () => { const es = state.lang !== 'es'; setLang(es ? 'es' : 'en'); renderShell(); });
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
    const [p, i, c, st, set, f, pay, inv, con, oo, sig, hist, chg, msg, gt, mon, td, so, cl, rg] = await Promise.all([
      sb.from('profiles').select('*').order('full_name'),
      selectAll('inquiries', 'created_at', false),
      sb.from('classrooms').select('*').order('sort').order('name'),
      selectAll('students', 'name'),
      sb.from('settings').select('*').maybeSingle(),
      fin ? selectAll('student_finance', 'student_id') : none,
      fin ? selectAll('payments', 'paid_on', false) : none,
      fin ? selectAll('invoices', 'invoice_date', false) : none,
      selectAll('student_contacts', 'created_at'),
      sb.from('text_opt_outs').select('phone'), // missing until 005_text_reminders.sql is run
      fin ? sb.from('receipt_signature').select('image').maybeSingle() : none, // missing until 008
      fin ? selectAll('billing_history', 'as_of') : none,                      // missing until 010
      sb.from('change_log').select('id, at, actor').neq('actor', state.me.id)  // missing until 012
        .gt('at', state.me.changes_seen_at || '1970-01-01').order('at', { ascending: false }).limit(200),
      isAdmin() || state.me.finance === 'edit' ? sb.from('messages').select('id').limit(1) : none,   // missing until 013
      sb.from('student_contacts').select('group_texts').limit(1),                                     // missing until 015
      fin ? sb.from('money_entries').select('id').limit(1) : Promise.resolve({ error: true }),        // missing until 017
      canOffice() ? selectAll('todos', 'due_on') : Promise.resolve({ error: true }),
      sb.from('inquiries').select('start_on,reg_paid_on').limit(1),                                   // missing until 019
      sb.from('school_closures').select('*').order('starts_on'),                                       // missing until 021
      fin ? selectAll('registrations', 'created_at') : Promise.resolve({ error: true }),              // missing until 023
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
      state.hasClassRates = c.data.length > 0 && 'rate_full' in c.data[0];   // 020
      state.students = st.data || [];
      state.settings = set.data || null;
      state.hasV5 = !!state.settings && 'telegram_forms' in state.settings;
      state.hasV6 = !!state.settings && 'billing_anchor' in state.settings;
      state.hasV7 = !!state.settings && 'payroll_frequency' in state.settings;
      state.signature = (state.hasV7 && !sig.error && sig.data?.image) || null;
      if (state.hasV6) {
        for (const [res, what] of [[inv, 'invoices'], [con, 'contacts']]) if (res.error) fail(res.error, `Could not load ${what}`);
        state.invoices = inv.data || [];
        state.contacts = con.data || [];
      }
      state.finance = Object.fromEntries((f.data || []).map((r) => [r.student_id, r]));
      state.payments = pay.data || [];
    }
    state.optOuts = new Set((oo.error ? [] : oo.data || []).map((r) => r.phone));
    state.history = hist.error ? [] : hist.data || [];
    state.hasLog = !chg.error;
    state.unseen = chg.error ? [] : chg.data || [];
    state.hasMsgs = (isAdmin() || state.me.finance === 'edit') && !msg.error;
    state.msgTpls = undefined;   // My messages and lists: loaded when Messages opens
    state.hasGroupTexts = !gt.error;
    state.hasMoney = fin && !mon.error;
    state.money = undefined;   // Money page data: loaded when it opens
    state.hasTodos = !td.error;
    state.hasStartOn = !so.error;
    state.closures = cl.error ? null : cl.data;
    state.registrations = rg.error ? null : rg.data;
    state.todos = td.error ? [] : td.data;
    watchInquiries();
    state.loadedAt = Date.now();
  }

  window.addEventListener('focus', async () => {
    if (!state.me?.active || Date.now() - state.loadedAt < 60_000 || state.openId !== undefined) return;
    await loadAll();
    renderView();
  });

  // New website requests while the CRM is open: checked every minute and when you come back to the tab, so they show
  // up here as well as on Telegram without reloading. Today gets a count until you open Today, Pipeline or All inquiries.
  let inqTimer = null;
  const TITLE = document.title;
  function watchInquiries() {
    if (inqTimer) return;
    inqTimer = setInterval(checkNewInquiries, 60_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNewInquiries(); });
  }
  async function checkNewInquiries() {
    if (!state.me?.active || document.hidden || !state.inquiries || state.checkingInq) return;
    state.checkingInq = true;
    try {
      const latest = state.inquiries.reduce((m, i) => (i.created_at > m ? i.created_at : m), '1970-01-01T00:00:00Z');
      const { data, error } = await sb.from('inquiries').select('*').gt('created_at', latest).order('created_at', { ascending: false });
      const fresh = error ? [] : (data || []).filter((i) => !state.inquiries.some((x) => x.id === i.id));
      if (!fresh.length) return;
      state.inquiries = [...fresh, ...state.inquiries];
      const web = fresh.filter((i) => i.source !== 'manual');
      if (web.length) {
        state.newInq = (state.newInq || 0) + web.length;
        const w = web[0];
        toast(web.length === 1 ? `New ${(SOURCE_LABEL[w.source] || 'website request').toLowerCase()}: ${w.parent_name || w.child_name || 'a family'}`
          : `${web.length} new website requests`);
        drawInqBadge();
      }
      if (state.openId === undefined && ['today', 'board', 'list'].includes(state.view)) renderView();
    } finally { state.checkingInq = false; }
  }
  function drawInqBadge() {
    const n = state.newInq || 0, b = $('header nav button[data-view=today]');
    document.title = n ? `(${n}) ${TITLE}` : TITLE;
    if (!b) return;
    $('.nav-badge', b)?.remove();
    if (n) b.insertAdjacentHTML('beforeend', ` <span class="nav-badge" aria-label="${n} new">${n > 99 ? '99+' : n}</span>`);
  }

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
      ...(canPayroll() ? { payroll: 'Payroll' } : {}),
      ...(state.hasMoney ? { money: 'Money' } : {}),
      ...(state.hasMsgs ? { messages: 'Messages' } : {}),
      ...(state.hasTodos ? { todo: 'To do' } : {}),
      ...(state.hasLog ? { changes: 'Changes' } : {}),
      ...(isAdmin() ? { staff: 'Settings' } : {}) };
    if (!views[state.view]) state.view = 'today';
    app.innerHTML = `
      <header class="top">
        <img src="/assets/logo.png" alt="Creativa Academy">
        <nav>${Object.entries(views).map(([k, v]) =>
          `<button data-view="${k}" ${state.view === k ? 'aria-current="page"' : ''}>${v}${k === 'changes' && state.unseen.length
            ? ` <span class="nav-badge" aria-label="${state.unseen.length} new">${state.unseen.length > 99 ? '99+' : state.unseen.length}</span>` : ''}</button>`).join('')}</nav>
        <button class="btn primary" id="add">+ Add<span class="hide-sm"> inquiry</span></button>
        <div class="me"><span>${esc(state.me.full_name || state.me.email)}</span>
          <button class="btn ghost small" id="lang" type="button" data-no-es title="${state.lang === 'es' ? 'Show the CRM in English' : 'Ver el CRM en español'}">${state.lang === 'es' ? 'English' : 'Español'}</button>
          <button class="btn ghost small" id="signout">Sign out</button></div>
      </header>
      <main id="view"></main>`;
    $$('header nav button').forEach((b) => b.addEventListener('click', () => {
      state.view = b.dataset.view;
      store.set('view', state.view);
      if (['today', 'board', 'list'].includes(state.view)) state.newInq = 0;
      renderShell();
    }));
    drawInqBadge();
    drawTodoBadge();
    $('#add').addEventListener('click', () => openDrawer(null));
    $('#signout').addEventListener('click', () => sb.auth.signOut());
    $('#lang')?.addEventListener('click', () => { const es = state.lang !== 'es'; setLang(es ? 'es' : 'en'); renderShell(); });
    renderView();
  }

  function renderView() {
    const el = $('#view');
    if (!el) return;
    ({ today: renderToday, board: renderBoard, list: renderList, staff: renderStaff,
      roster: renderRoster, tuition: renderTuition, reports: renderReports, payroll: renderPayroll, changes: renderChanges, messages: renderMessages,
      money: renderMoney, todo: renderTodo })[state.view](el);
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
      ${withStage ? `<select id="f-stage">${opt('', 'All stages', f.stage)}${stages().map((s) => opt(s, STAGE_LABEL[s], f.stage)).join('')}</select>` : ''}
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
    el.onclick = (e) => {
      if (e.target.closest('#see-changes')) { state.view = 'changes'; store.set('view', 'changes'); renderShell(); }
      if (e.target.closest('#see-pay-guide, #pay-guide-ok')) store.set('payGuideSeen', true);
      if (e.target.closest('#pay-guide-ok')) e.target.closest('.pay-note').remove();
      if (e.target.closest('#see-pay-guide')) {
        store.set('payGuideOpen', true);
        state.view = 'payroll'; state.payTab = 'hours'; store.set('view', 'payroll'); store.set('payTab', 'hours');
        renderShell();
      }
    };
    const today = todayStr();
    const open = state.inquiries.filter((i) => !CLOSED.has(i.stage));
    const due = open.filter((i) => i.next_follow_up && i.next_follow_up <= today)
      .sort((a, b) => a.next_follow_up.localeCompare(b.next_follow_up));
    const now = Date.now(), weekOut = now + 7 * 864e5;
    const tours = open.filter((i) => i.stage !== 'reschedule' && i.tour_at && new Date(i.tour_at) >= new Date(today + 'T00:00:00'))
      .sort((a, b) => a.tour_at.localeCompare(b.tour_at));
    const resched = open.filter((i) => i.stage === 'reschedule')
      .sort((a, b) => (a.tour_at || a.updated_at).localeCompare(b.tour_at || b.updated_at));
    const fresh = open.filter((i) => i.stage === 'new').sort((a, b) => a.created_at.localeCompare(b.created_at));
    const monthStart = today.slice(0, 8) + '01';
    const enrolledMonth = state.inquiries.filter((i) => i.stage === 'enrolled' && localDate(new Date(i.updated_at)) >= monthStart).length;

    const row = (i, when, cls = '') => `<div class="row" data-id="${i.id}">
        <div class="who"><b>${esc(i.parent_name || '(no name)')}</b>
          <div>${esc([i.child_name, ageOf(i.child_dob), i.program].filter(Boolean).join(' · ') || SOURCE_LABEL[i.source] || '')}</div></div>
        <span class="when ${cls}">${when}</span></div>`;

    const unseenBy = [...new Set(state.unseen.map((c) => staffName(c.actor) || 'Someone'))];
    const toDo = state.hasTodos ? todoSoon() : [];
    el.innerHTML = `${toDo.length ? `<section class="panel today-todo"><h2>To do <span class="muted small">${toDo.length}</span>
        <button class="btn ghost small" type="button" id="see-todo">All to-dos</button></h2>
        <ul class="todo-list">${toDo.map(todoItem).join('')}</ul></section>` : ''}
      ${canPayroll() && !store.get('payGuideSeen') ? `<div class="panel changes-note pay-note"><b>Payroll</b>
        Step-by-step instructions for payroll and pay stubs are on the Payroll page.
        <button class="btn small" type="button" id="see-pay-guide">Show me</button>
        <button class="btn ghost small" type="button" id="pay-guide-ok">Got it</button></div>` : ''}
      ${state.unseen.length ? `<div class="panel changes-note"><b>${state.unseen.length} change${state.unseen.length === 1 ? '' : 's'}</b>
        by ${esc(unseenBy.join(', '))} since you last looked. <button class="btn small" type="button" id="see-changes">See changes</button></div>` : ''}
      <div class="stats">
        <div class="stat"><b>${fresh.length}</b><span>New, not yet contacted</span></div>
        <div class="stat"><b>${due.length}</b><span>Follow-ups due</span></div>
        <div class="stat"><b>${tours.filter((i) => new Date(i.tour_at) <= weekOut).length}</b><span>Tours in the next 7 days</span></div>
        <div class="stat"><b>${open.length}</b><span>Open inquiries</span></div>
        <div class="stat"><b>${enrolledMonth}</b><span>Enrolled this month</span></div>
        ${state.hasEnrollment ? `<div class="stat"><b>${state.students.filter((s) => s.status === 'enrolled').length}</b><span>Students enrolled now</span></div>` : ''}
      </div>
      <div class="today-grid">
        ${canPayroll() ? '<section class="panel staff-today" id="staff-today"><h2>Staff today</h2><p class="muted small">Loading…</p></section>' : ''}
        <section class="panel"><h2>Follow-ups due</h2>
          ${due.map((i) => row(i, i.next_follow_up < today ? `<span class="tag overdue">overdue · ${fmtDate(i.next_follow_up)}</span>` : '<span class="tag due">today</span>')).join('')
            || '<p class="empty">Nothing due. Set a follow-up date on an inquiry to see it here.</p>'}
        </section>
        <section class="panel"><h2>Upcoming tours</h2>
          ${tours.map((i) => row(i, `<span class="tag tour">${esc(fmtDateTime(i.tour_at))}</span>`)).join('')
            || '<p class="empty">No tours scheduled.</p>'}
        </section>
        ${state.hasV5 ? `<section class="panel" id="resched-panel"><h2>Tours to reschedule</h2>
          ${resched.map((i) => {
            const tel = digits(i.phone);
            return row(i, `<span class="email-status">${i.tour_at ? `<span class="tag due">was ${esc(fmtDateTime(i.tour_at))}</span>` : ''}
              ${tel ? `<a class="btn small sms" href="tel:${tel}">Call</a><a class="btn small sms" href="sms:${tel}">Text</a>` : ''}</span>`);
          }).join('') || '<p class="empty">No tours waiting for a new time. Move a family to “Reschedule” on the Pipeline to list them here.</p>'}
        </section>` : ''}
        <section class="panel"><h2>New inquiries</h2>
          ${fresh.map((i) => row(i, `<span class="muted">${esc(relDays(i.created_at))}</span>`)).join('')
            || '<p class="empty">All caught up.</p>'}
        </section>
        ${state.hasEnrollment ? tourEmailsPanel() : ''}
      </div>`;
    $$('a.sms', el).forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
    $$('.row', el).forEach((r) => r.addEventListener('click', () => openDrawer(r.dataset.id)));
    if (canPayroll()) drawStaffToday(el);
    const todoBox = $('.today-todo', el);
    if (todoBox) bindTodos(todoBox, renderView);
    $('#see-todo', el)?.addEventListener('click', () => { state.view = 'todo'; store.set('view', 'todo'); renderShell(); });
  }

  // Who's at work right now, from the time clock: in (since when), at lunch, gone for the day, not in yet (and how late).
  // Payroll access only; refreshed every 2 minutes while Today is open.
  async function drawStaffToday(el) {
    const box = $('#staff-today', el);
    if (!box) return;
    const day = nyToday();
    const [emp, te] = await Promise.all([sb.from('employees').select('*').eq('active', true).order('first_name'),
      sb.from('time_entries').select('*').eq('work_date', day).order('clock_in')]);
    if (!box.isConnected) return;
    if (emp.error || te.error) { box.innerHTML = '<h2>Staff today</h2><p class="muted small">Couldn’t load the time clock.</p>'; return; }
    const now = new Date(), nowHM = clockTime(now.toISOString());
    const rows = emp.data.map((e) => {
      const xs = te.data.filter((x) => x.employee_id === e.id), open = xs.find((x) => !x.clock_out), last = xs[xs.length - 1];
      const first = xs[0], start = e.start_time ? new Date(nyIso(day, e.start_time.slice(0, 5))) : null;
      const st = open ? 'in' : last?.out_reason === 'lunch' ? 'lunch' : last ? 'gone' : 'notin';
      const late = st === 'notin' && start && now > start ? Math.round((now - start) / 60000) : 0;
      return { e, xs, open, last, first, start, st, late };
    });
    const dow = new Date(`${day}T12:00:00`).getDay(), weekend = dow === 0 || dow === 6;
    const line = (r) => {
      const name = `<b>${esc(empName(r.e))}</b>`;
      if (r.st === 'in') return `<li class="sw-in-row">${name} <span class="muted small">in since ${esc(clockTime(r.open.clock_in))}${r.open.punched_in ? ` (tapped ${esc(clockTime(r.open.punched_in))})` : ''}${r.xs.length > 1 ? ` · first in ${esc(clockTime(r.first.clock_in))}` : ''}</span></li>`;
      if (r.st === 'lunch') return `<li>${name} <span class="muted small">at lunch since ${esc(clockTime(r.last.clock_out))}</span></li>`;
      if (r.st === 'gone') return `<li>${name} <span class="muted small">${esc(clockTime(r.first.clock_in))} – ${esc(clockTime(r.last.clock_out))}, gone for the day</span></li>`;
      return `<li>${name} <span class="small ${r.late > 5 ? 'rate-off' : 'muted'}">${r.start ? `starts ${esc(clockTime(r.start.toISOString()))}${r.late > 5 ? ` · not in yet, ${r.late} min late` : ''}` : 'not clocked in'}</span></li>`;
    };
    const group = (k, title) => { const xs = rows.filter((r) => r.st === k); return xs.length ? `<h3 class="sub-h">${title} (${xs.length})</h3><ul class="plain staff-list">${xs.map(line).join('')}</ul>` : ''; };
    const lateN = rows.filter((r) => r.late > 5).length;
    box.innerHTML = `<h2 class="h-row">Staff today <span class="muted small">as of ${esc(nowHM)} · <a href="#" id="st-refresh">refresh</a></span></h2>
      <p class="small"><b>${rows.filter((r) => r.st === 'in').length}</b> at work · ${rows.filter((r) => r.st === 'lunch').length} at lunch ·
        ${rows.filter((r) => r.st === 'gone').length} gone${lateN && !weekend ? ` · <span class="rate-off">${lateN} late</span>` : ''}</p>
      ${group('in', 'At work')}${group('lunch', 'At lunch')}${weekend && !te.data.length ? '<p class="muted small">Nobody clocked in today.</p>' : group('notin', 'Not in yet')}${group('gone', 'Gone for the day')}`;
    $('#st-refresh', box)?.addEventListener('click', (e) => { e.preventDefault(); drawStaffToday(el); });
    clearTimeout(state.staffTodayTimer);
    state.staffTodayTimer = setTimeout(() => { if (state.view === 'today' && box.isConnected) drawStaffToday(el); }, 120000);
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
    // Automatic text (Twilio job, netlify/functions/tour-texts.mjs): sent, stopped, or queued.
    const textTag = (i, kind) => {
      const texted = kind === 'reminder' ? i.reminder_texted_at : i.followup_texted_at;
      if (texted) return `<span class="tag tour">texted ${esc(fmtDate(texted))}</span>`;
      if (!textsOn() || i.auto_emails === false || !e164(i.phone)) return '';
      if (textsStopped(i.phone)) return '<span class="tag">texts stopped</span>';
      if (kind === 'followup' && i.email && state.settings?.emails_enabled !== false) return '';
      return `<span class="tag">${kind === 'reminder' ? 'text at 9am' : 'text queued'}</span>`;
    };
    const status = (i, kind) => {
      const auto = textTag(i, kind);
      const sent = kind === 'reminder' ? i.tour_reminder_sent_at : i.followup_sent_at;
      if (sent) return `<span class="tag tour">emailed ${esc(fmtDate(sent))}</span>${auto}`;
      const tel = digits(i.phone);
      const text = tel && !auto ? `<a class="btn small sms" href="sms:${tel}?&body=${encodeURIComponent(smsText(i, kind))}">Text</a>` : '';
      if (!i.email) return `${auto || '<span class="tag due">no email</span>'}${text}`;
      if (i.auto_emails === false || state.settings?.emails_enabled === false) return `<span class="tag">emails off</span>${auto}${text}`;
      return `<span class="tag">${kind === 'reminder' ? 'email at 9am' : 'email queued'}</span>${auto}${text}`;
    };
    const line = (i, kind) => `<div class="row" data-id="${i.id}"><div class="who"><b>${esc(i.parent_name || '(no name)')}</b>
        <div>${kind === 'reminder' ? 'Tour' : 'Toured'} ${esc(fmtDateTime(i.tour_at))}</div></div>
        <span class="when email-status">${status(i, kind)}</span></div>`;
    return `<section class="panel" id="tour-emails"><h2>Tour reminders</h2>
      <h3 class="sub-h">Tomorrow’s tours: reminder</h3>
      ${reminders.map((i) => line(i, 'reminder')).join('') || '<p class="empty">No tours tomorrow.</p>'}
      <h3 class="sub-h">Toured a week ago: “how was your visit?”</h3>
      ${followups.map((i) => line(i, 'followup')).join('') || '<p class="empty">Nobody to check in with.</p>'}
      <p class="muted small">The follow-up is skipped if someone logs a call, email or text with the family after the tour${textsOn() ? ' (a reply by text counts)' : ''}.</p>
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
    if (i.tour_at && i.stage === 'reschedule') tags.push(`<span class="tag due">was ${esc(fmtDateTime(i.tour_at))}</span>`);
    if (i.start_on && !CLOSED.has(i.stage)) tags.push(`<span class="tag start">starts ${esc(fmtDate(i.start_on))}${canViewFinance() && Number(i.expected_tuition) > 0
      ? ` · ${esc(money(i.expected_tuition))}` : ''}</span>`);
    if (state.hasStartOn && !CLOSED.has(i.stage)) {
      if (inqRegPaid(i)) tags.push('<span class="tag paid">registration paid</span>');
      else if (i.stage === 'waitlisted') tags.push('<span class="tag due">registration not paid</span>');
    }
    tags.push(`<span class="tag">${esc(SOURCE_LABEL[i.source] || i.source)}</span>`);
    if (i.assigned_to) tags.push(`<span class="tag">${esc(staffName(i.assigned_to))}</span>`);
    return `<div class="card" draggable="true" data-id="${i.id}">
      <select class="move" aria-label="Move ${esc(i.parent_name || 'this family')} to another stage">
        <option value="" selected disabled>Move to…</option>
        ${stages().filter((s) => s !== i.stage).map((s) => `<option value="${s}">${STAGE_LABEL[s]}</option>`).join('')}
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
    } else if (stage === 'tour_scheduled' && inq.stage === 'reschedule') {
      openDrawer(inq.id, { stage, tour_at: null });
      toast('Pick the new tour date and time, then Save');
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
      $('#board').innerHTML = stages().map((s) => {
        const items = rows.filter((i) => i.stage === s);
        const shown = CLOSED.has(s) ? items.slice(0, CLOSED_COLUMN_LIMIT) : items;
        return `<section class="col" data-stage="${s}"><h3><span>${STAGE_LABEL[s]}</span><span>${items.length}</span></h3>
          ${s === 'waitlisted' && state.hasStartOn && items.length ? `<p class="col-note">${items.filter(inqRegPaid).length} of ${items.length} paid registration</p>` : ''}
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
  // The guide (guide.js): everything the CRM does, by area, in English or Spanish. Written in both, so not run through es.js.
  function guideHtml() {
    const G = window.CRM_GUIDE?.[state.lang === 'es' ? 'es' : 'en'];
    if (!G) return '';
    return `<section class="panel guide" id="guide" data-no-es><h2>${esc(G.title)}</h2><p class="muted small">${esc(G.intro)}</p>
      ${G.sections.map(([title, what, steps]) => `<details class="guide-sec"><summary>${esc(title)}</summary><p class="small">${esc(what)}</p>
        <ul class="small">${steps.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>`).join('')}</section>`;
  }
  function renderStaff(el) {
    el.innerHTML = `${guideHtml()}<div class="panel staff-help">
        <h2>Adding a staff member</h2>
        <p class="muted small">In Supabase, open <b>Authentication → Users → Invite user</b> and enter their email.
        Once they accept the invite and set a password they appear below — switch <b>Active</b> on to let them in.
        Turning Active off removes their access immediately.</p>
        ${state.hasEnrollment ? `<p class="muted small"><b>Finances</b> opens the Tuition and Reports pages: <b>View only</b> sees tuition,
        payments and totals; <b>View &amp; record</b> can also record payments, print receipts and set tuition. Admins always have both.</p>` : ''}
        ${state.hasV7 ? `<p class="muted small"><b>Payroll</b> opens the Payroll page: everyone’s hours, pay rates and time clock PINs.
        Admins always have it.</p>` : ''}</div>
      <div class="table-wrap"><table class="staff-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th>${state.hasEnrollment ? '<th>Finances</th>' : ''}${state.hasV7 ? '<th>Payroll</th>' : ''}<th>Active</th><th>Joined</th></tr></thead>
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
          ${state.hasV7 ? `<td>${s.role === 'admin' ? '<span class="muted small">Yes (admin)</span>' : `<select data-k="payroll" ${self ? 'disabled' : ''}
            aria-label="Payroll access">${optionsHtml([['no', 'No access'], ['yes', 'Yes']], s.payroll ? 'yes' : 'no')}</select>`}</td>` : ''}
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
      const patch = { [input.dataset.k]: input.type === 'checkbox' ? input.checked : input.dataset.k === 'payroll' ? input.value === 'yes' : input.value };
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
  const fundingTags = (sid) => fundingOf(sid).map((k) => `<span class="tag f-${k}">${esc(FUNDING[k])}</span>`).join('');
  const fundingText = (sid) => fundingOf(sid).map((k) => FUNDING[k]).join(', ');
  const missingDocs = (s) => DOCS.filter(([k]) => !s[k]);
  // Children by last name, then first name ("Ana de la Cruz" files under "de la Cruz").
  const PARTICLES = new Set(['de', 'del', 'da', 'das', 'do', 'dos', 'di', 'du', 'la', 'las', 'los', 'van', 'von']);
  function lastFirst(name) {
    const w = String(name || '').trim().split(/\s+/);
    let i = w.length - 1;
    while (i > 1 && PARTICLES.has(w[i - 1].toLowerCase())) i--;
    return `${w.slice(i).join(' ')} ${w.slice(0, i).join(' ')}`;
  }
  const byLastName = (a, b) => lastFirst(a).localeCompare(lastFirst(b), undefined, { sensitivity: 'base' }) || String(a).localeCompare(String(b));
  const sortStudents = (a, b) => byLastName(a.name, b.name);
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
      if (f.funding && canViewFinance() && !hasFunding(s.id, f.funding === 'unset' ? 'private' : f.funding)) return false;
      if (q) {
        const hay = [s.name, s.parent_name, s.parent_email, s.notes, s.therapy, state.finance[s.id]?.award_id].join(' ').toLowerCase();
        if (!hay.includes(q) && !(qd.length >= 3 && digits(s.parent_phone).includes(qd))) return false;
      }
      return true;
    }).sort(sortStudents);
  }

  function renderRoster(el) {
    if (state.registrations && canViewFinance() && state.rosterTab === 'reg') return renderRegistration(el);
    const f = state.rosterFilters;
    const fin = canViewFinance();
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const enrolled = state.students.filter((s) => s.status === 'enrolled'), waitAll = state.students.filter((s) => s.status === 'waitlist');
    el.innerHTML = `${rosterTabs()}
      <div class="class-grid">${state.classrooms.map((c) => {
        const n = enrolled.filter((s) => s.classroom_id === c.id).length;
        const waitL = state.students.filter((s) => s.status === 'waitlist' && s.classroom_id === c.id), wait = waitL.length;
        const full = c.capacity && n >= c.capacity;
        return `<button class="class-card ${f.classroom === c.id ? 'on' : ''}" data-class="${c.id}" type="button">
          <span class="c-name">${esc(c.name)}</span>
          <span class="c-count ${full ? 'full' : ''}">${n}${c.capacity ? `<small> / ${c.capacity}</small>` : ''}</span>
          <span class="c-teachers">${esc(c.teachers || '')}</span>
          ${wait ? `<span class="tag">${wait} waiting · ${waitL.filter(regPaid).length} paid</span>` : ''}</button>`;
      }).join('')}
        <div class="class-card total"><span class="c-name">Whole school</span><span class="c-count">${enrolled.length}</span>
          <span class="c-teachers">${waitAll.length} on waiting lists${waitAll.length ? ` (${waitAll.filter(regPaid).length} paid registration)` : ''}</span></div>
      </div>
      <div class="toolbar">
        <input type="search" id="r-q" placeholder="Search student, parent, phone…" value="${esc(f.q)}">
        <select id="r-classroom">${opt('', 'All classes', f.classroom)}${state.classrooms.map((c) => opt(c.id, c.name, f.classroom)).join('')}${opt('none', 'No class', f.classroom)}</select>
        <select id="r-status">${opt('', 'Every status', f.status)}${Object.entries(STUDENT_STATUS).map(([k, v]) => opt(k, v, f.status)).join('')}</select>
        <select id="r-docs">${opt('', 'Any documents', f.docs)}${opt('missing', 'Missing documents', f.docs)}${opt('complete', 'All documents in', f.docs)}</select>
        ${fin ? `<select id="r-funding">${opt('', 'Any funding', f.funding)}${Object.entries(FUNDING).map(([k, v]) => opt(k, v, f.funding === 'unset' ? 'private' : f.funding)).join('')}</select>` : ''}
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
    bindRosterTabs(el);
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
            regPaid(s) ? REG_FEE.paid : REG_FEE[s.reg_fee] || (s.status === 'waitlist' ? REG_FEE.not_paid : ''), RBT[s.rbt] || '', s.therapy,
            ...(fin ? [fundingText(s.id), fr.award_id, fr.tuition_amount, fr.tuition_amount != null ? FREQ[fr.tuition_frequency] : ''] : []),
            s.notes];
        }));
    });
    draw();

    function saveFilters() { store.set('rosterFilters', { ...f, q: '' }); }
    // On the waiting list, registration not recorded counts as not paid (it's what holds the spot).
    function regTag(s) {
      const k = regPaid(s) ? 'paid' : s.reg_fee || (s.status === 'waitlist' ? 'not_paid' : '');
      return k ? `<span class="tag ${k === 'not_paid' ? 'overdue' : k === 'paid' && s.status === 'waitlist' ? 'paid' : ''}">${REG_FEE[k]}</span>` : '';
    }
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
          <td>${regTag(s)}</td>
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
    const fr = (id && state.finance[id]) || { funding: [], tuition_frequency: state.hasV6 ? 'biweekly' : 'monthly', bill_family: true, ...(preset.finance || {}) };
    const contacts = id ? state.contacts.filter((c) => c.student_id === id)
      .sort((a, b) => Object.keys(CONTACT_ROLE).indexOf(a.role) - Object.keys(CONTACT_ROLE).indexOf(b.role)) : [];
    const invs = id ? state.invoices.filter((i) => i.student_id === id).sort((a, b) => b.invoice_date.localeCompare(a.invoice_date)) : [];
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
          <div class="full grid2" id="withdraw-wrap" ${LEFT.has(s.status) ? '' : 'hidden'}>
            ${fInput('withdrawn_on', 'Last day at school', s.withdrawn_on, 'date')}
            ${fInput('withdraw_reason', 'Reason / notes', s.withdraw_reason, 'text', 'placeholder="e.g. Moved, went to kindergarten"')}
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
          ${state.hasV6 ? fInput('family_account', 'Family account (billing)', s.family_account, 'text', 'placeholder="e.g. LOPEZ, MARIA"') : ''}
        </div>
        ${state.hasV6 && id ? `<ul class="contact-list">${contacts.map((c) => {
          const phones = [['Cell', c.cell_phone], ['Text', c.sms_phone], ['Work', c.work_phone], ['Home', c.home_phone]].filter(([, v]) => v);
          return `<li><div class="c-head"><b>${esc(contactName(c) || '(no name)')}</b>
              <span class="tag">${esc(CONTACT_ROLE[c.role])}${c.relationship ? ' · ' + esc(c.relationship) : ''}</span>
              ${c.group_texts === true && c.role !== 'primary' ? '<span class="tag">gets group texts</span>' : ''}
              ${c.group_texts === false && c.role === 'primary' ? '<span class="tag">no group texts</span>' : ''}
              <button class="btn ghost small" type="button" data-contact="${c.id}">Edit</button></div>
            ${phones.length ? `<div class="c-phones">${phones.map(([l, v]) => `<span>${l} <a href="tel:${digits(v)}">${esc(v)}</a>${l !== 'Work' && l !== 'Home' ? ` <a class="sms-link" href="sms:${digits(v)}">text</a>` : ''}</span>`).join('')}</div>` : ''}
            ${c.email ? `<div class="c-phones"><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ''}
            ${c.notes ? `<div class="muted small">${esc(c.notes)}</div>` : ''}</li>`;
        }).join('') || '<li class="muted small">No contacts yet.</li>'}</ul>
          <button class="btn small" type="button" id="contact-add">+ Add contact</button>
          <button class="btn ghost small" type="button" id="contact-copy">Copy from a brother or sister</button>
          <div id="contact-copy-box" hidden><input type="search" id="cc-q" placeholder="Brother’s or sister’s name…" autocomplete="off">
            <div class="msg-pick" id="cc-found" hidden></div></div>` : ''}</div>
        <div class="section"><h3>Support & registration</h3><div class="grid2">
          ${fSelect('rbt', 'RBT', [['', 'No'], ['yes', 'Yes'], ['in_process', 'In process']], s.rbt)}
          ${fInput('therapy', 'Therapies', s.therapy, 'text', 'placeholder="Speech, OT…"')}
          ${fSelect('reg_fee', 'Registration fee', [['', '—'], ...Object.entries(REG_FEE)], s.reg_fee)}
          <label class="full">Notes<textarea name="notes" rows="3">${esc(s.notes)}</textarea></label>
        </div></div>
        ${fin ? `<div class="section"><h3>Funding & tuition</h3>
          <div class="funding-boxes">${Object.entries(PROGRAMS_FUNDING).map(([k, v]) => `<label class="pill-check"><input type="checkbox" class="check" name="fund_${k}" ${(fr.funding || []).includes(k) ? 'checked' : ''} ${dis}> ${esc(v)}</label>`).join('')}</div>
          <p class="muted small fund-hint">No program ticked = <b>Private pay</b>. SR – BPIECE students are also School Readiness.
            Step Up (pending) = Kindergarten waiting on Step Up: nothing is billed and it doesn’t count as late.</p>
          <div class="grid2">
            ${fInput('tuition_amount', state.hasV6 ? 'Rate (family pays)' : 'Tuition (family pays)', fr.tuition_amount, 'number', `min="0" step="0.01" inputmode="decimal" ${dis}`)}
            ${fSelect('tuition_frequency', 'Every', Object.entries(FREQ).filter(([k]) => k !== 'school_year' || state.hasClassRates || fr.tuition_frequency === k)
              .map(([k, v]) => [k, k === 'school_year' ? 'School year' : v[0].toUpperCase() + v.slice(1)]), fr.tuition_frequency, dis)}
            ${state.hasClassRates ? `<div class="full rate-opts" id="rate-opts"></div>
              ${fInput('rate_note', 'Why the rate is different (if it is)', fr.rate_note, 'text', `placeholder="e.g. 10% sibling discount" maxlength="200" ${dis}`)}` : ''}
            ${state.hasV6 ? `${fInput('billing_program', 'Billing item', fr.billing_program, 'text', `placeholder="Preschool Full-Time" ${dis}`)}
              <label class="pill-check bill-family"><input type="checkbox" class="check" name="bill_family" ${fr.bill_family !== false ? 'checked' : ''} ${dis}>
                Bill the family every period</label>` : ''}
            ${fInput('award_id', 'Award / scholarship ID', fr.award_id, 'text', dis)}
            <label class="full">Funding notes<textarea name="fin_notes" rows="2" ${dis}>${esc(fr.notes)}</textarea></label>
          </div></div>
          ${id && state.hasV6 ? `<div class="section"><h3>Invoices</h3>
            <ul class="pay-list">${invs.map((i) => {
              const st = invoiceStatus(i);
              return `<li><span class="p-date">${esc(fmtDate(i.invoice_date))}</span>
                <span class="p-what">${esc(invoiceLabel(i))}</span><b>${money(i.amount)}</b>
                <span class="pay-pill ps-${st}">${INV_STATUS[st]}${['partial', 'overdue', 'open'].includes(st) ? ' · ' + money(invoiceBalance(i)) + ' due' : ''}</span>
                ${finEdit && invoiceBalance(i) > 0 ? `<button class="btn ghost small" type="button" data-pay-inv="${i.id}">Record payment</button>` : ''}
                ${finEdit && i.late_fee_for && !i.void ? `<button class="btn ghost small" type="button" data-rm-fee="${i.id}">Take off</button>` : ''}</li>`;
            }).join('') || '<li class="muted">No invoices yet. Bill from the Tuition page.</li>'}</ul></div>` : ''}
          ${id ? `<div class="section"><h3>Payments</h3>
            ${finEdit ? '<button class="btn small" type="button" id="pay-add">+ Record payment</button>' : ''}
            <button class="btn small" type="button" id="stmt-one">Annual statement ${taxYearDefault()}</button>
            <ul class="pay-list">${pays.map((p) => `<li data-pay="${p.id}">
                <span class="p-date">${esc(fmtDate(p.paid_on))}</span>
                <span class="p-what">${esc(paymentFor(p))} · ${esc(PAYER[p.payer])} · ${esc(METHOD[p.method])}</span>
                <b>${money(p.amount)}</b>
                <button class="btn ghost small" type="button" data-receipt="${p.id}">Receipt #${p.receipt_no}</button>
                ${finEdit ? `<button class="btn ghost small" type="button" data-edit-pay="${p.id}">Edit</button>` : ''}</li>`).join('')
              || '<li class="muted">No payments recorded yet.</li>'}</ul></div>` : ''}
          ${id && historyFor(s0).length ? `<div class="section"><h3>Earlier billing (billing system, paid)</h3>
            <ul class="pay-list">${historyFor(s0).map((h) => `<li><span class="p-date">${esc(fmtDate(h.as_of))}</span>
              <span class="p-what">Tuition ${esc(fmtDate(h.period_start))} – ${esc(fmtDate(h.period_end))} · sheet ${money(h.balance)}${h.needs_check ? ' · to check' : ''}${h.note ? ` · ${esc(h.note)}` : ''}</span>
              <b>${money(earlierPaid(h))}</b></li>`).join('')}</ul>
            <p class="muted small">From the Balance Summary sheets before the CRM, all paid there (a minus is a credit). For reference only.</p></div>` : ''}` : ''}
        ${inq ? `<p class="small"><a href="#" id="open-inq">Open the original inquiry (${esc(inq.parent_name || 'family')})</a></p>` : ''}
        ${id && state.hasMsgs ? `<div class="section"><h3 class="h-row">Texts <button class="btn small" type="button" id="st-text">Text this family</button></h3>
          <ul class="chg-list mini" id="st-texts"><li class="muted small">Loading…</li></ul></div>` : ''}
        ${id && state.hasLog ? '<div class="section"><h3>Recent changes</h3><ul class="chg-list mini" id="st-changes"><li class="muted small">Loading…</li></ul></div>' : ''}`,
      foot: `${id && isAdmin() ? '<button class="btn danger" id="st-del" type="button">Delete</button>' : ''}
        <span class="spacer"></span><button class="btn" data-close type="button">Cancel</button>
        <button class="btn primary" id="st-save" type="button">${id ? 'Save' : 'Add student'}</button>`,
    });
    const { drawer, form } = ctl;
    if (Object.keys(preset).length) ctl.dirty = !id || Object.keys(preset).some((k) => preset[k] !== s0[k]);
    if (!id) form.name.focus();
    form.status.addEventListener('change', () => {
      $('#withdraw-wrap', drawer).hidden = !LEFT.has(form.status.value);
      if (LEFT.has(form.status.value) && !form.withdrawn_on.value) form.withdrawn_on.value = todayStr();
    });
    $$('[data-doc]', drawer).forEach((box) => box.addEventListener('change', () => {
      form[box.dataset.doc].value = box.checked ? (form[box.dataset.doc].value || todayStr()) : '';
    }));
    DOCS.forEach(([k]) => form[k].addEventListener('change', () => { $(`[data-doc="${k}"]`, drawer).checked = !!form[k].value; }));
    // BPIECE is a kind of School Readiness: ticking it ticks SR, unticking SR unticks it.
    form.fund_sr_bpiece?.addEventListener('change', () => { if (form.fund_sr_bpiece.checked) form.fund_sr.checked = true; });
    form.fund_sr?.addEventListener('change', () => { if (!form.fund_sr.checked) form.fund_sr_bpiece.checked = false; });
    // The class's rates, one tap to use one (020).
    const rateBox = $('#rate-opts', drawer);
    const drawRates = () => {
      if (!rateBox) return;
      const rs = classRates(form.classroom_id.value);
      const chk = rateCheck(form.classroom_id.value, { tuition_amount: form.tuition_amount.value.trim(), tuition_frequency: form.tuition_frequency.value,
        funding: form.fund_sr?.checked ? ['sr'] : [] });
      rateBox.innerHTML = rs.length ? `${rateSelect('rate-pick', rs, form.tuition_frequency.value, chk?.match?.k || (chk && !chk.none ? 'other' : ''), dis)}
        ${chk && !chk.match ? `<span class="small rate-off">${esc(rateCheckText(chk))}</span>` : ''}` : '';
      $('#rate-pick', rateBox)?.addEventListener('change', (e) => {
        const r = rs.find((x) => x.k === e.target.value);
        if (r) {
          const a = rateAs(r, form.tuition_frequency.value);
          form.tuition_amount.value = a.amount;
          form.tuition_frequency.value = a.freq;
        } else if (e.target.value === 'other') form.tuition_amount.focus();
        ctl.dirty = true;
        drawRates();
      });
    };
    if (rateBox) {
      drawRates();
      ['classroom_id', 'tuition_amount', 'tuition_frequency', 'fund_sr'].forEach((k) => form[k]?.addEventListener(k === 'tuition_amount' ? 'input' : 'change', drawRates));
    }
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
    $('#st-text', drawer)?.addEventListener('click', () => {
      if (ctl.dirty && !confirm('Discard your changes?')) return;
      closeDrawer();
      state.msgDraft = { ...newMsgDraft(), who: 'pick', picked: [familyKey(s0)] };
      state.view = 'messages';
      store.set('view', state.view);
      renderShell();
    });
    if (id && state.hasMsgs) {
      sb.from('message_recipients').select('status, body, sent_at, name, messages(created_at, created_by)').eq('student_id', id).limit(300).then(({ data, error }) => {
        const ul = $('#st-texts', drawer);
        if (!ul) return;
        const list = (data || []).sort((a, b) => (b.messages?.created_at || '').localeCompare(a.messages?.created_at || '')).slice(0, 6);
        ul.innerHTML = error ? '<li class="muted small">Could not load texts.</li>' : list.map((r) => `<li><span class="chg-time">${esc(fmtDateTime(r.sent_at || r.messages?.created_at))}</span>
          <span><span class="pay-pill ps-${MSG_PILL[r.status]}">${esc(MSG_STATUS[r.status])}</span> ${esc(r.body)}
          <span class="muted small">· to ${esc(r.name || '')}, by ${esc(staffName(r.messages?.created_by) || 'staff')}</span></span></li>`).join('')
          || '<li class="muted small">No texts sent yet.</li>';
      });
    }
    if (id && state.hasLog) {
      sb.from('change_log').select('*').eq('student_id', id).order('at', { ascending: false }).limit(10).then(({ data, error }) => {
        const ul = $('#st-changes', drawer);
        if (!ul) return;
        ul.innerHTML = error ? '<li class="muted small">Could not load changes.</li>' : (data || []).map((c) => `<li><span class="chg-time">${esc(fmtDateTime(c.at))}</span>
          <span><b>${esc(staffName(c.actor) || 'Someone')}</b> ${esc(describeChange(c))}</span></li>`).join('') || '<li class="muted small">No changes recorded yet.</li>';
      });
    }
    $('#stmt-one', drawer)?.addEventListener('click', () => {
      const year = taxYearDefault();
      showStatements(statementGroups(year).filter((g) => g.key === familyKey(s0)), year);
    });
    $$('[data-pay-inv]', drawer).forEach((b) => b.addEventListener('click', () => {
      if (!ctl.dirty || confirm('Discard your changes?')) openPayment({ studentId: id, invoiceId: b.dataset.payInv, back });
    }));
    $$('[data-rm-fee]', drawer).forEach((b) => b.addEventListener('click', () => {
      if (!ctl.dirty || confirm('Discard your changes?')) removeLateFee(b.dataset.rmFee, () => { renderView(); back(); });
    }));
    $('#contact-add', drawer)?.addEventListener('click', () => { if (!ctl.dirty || confirm('Discard your changes?')) openContact({ studentId: id, back }); });
    // Brothers and sisters: copy the parents from a sibling's page (their Primary and Secondary contacts) onto this one.
    $('#contact-copy', drawer)?.addEventListener('click', () => {
      $('#contact-copy-box', drawer).hidden = false;
      $('#cc-q', drawer).focus();
    });
    $('#cc-q', drawer)?.addEventListener('input', () => {
      const q = $('#cc-q', drawer).value.trim().toLowerCase(), found = $('#cc-found', drawer);
      const hits = q.length < 2 ? [] : state.students.filter((x) => x.id !== id && x.name.toLowerCase().includes(q)
        && state.contacts.some((c) => c.student_id === x.id && c.role !== 'emergency')).slice(0, 8);
      found.hidden = !hits.length;
      found.innerHTML = hits.map((x) => `<button class="btn ghost small" type="button" data-cc="${x.id}">${esc(x.name)}
        <span class="muted small">${esc(state.contacts.filter((c) => c.student_id === x.id && c.role !== 'emergency').map(contactName).join(', '))}</span></button>`).join('');
      $$('[data-cc]', found).forEach((b) => b.addEventListener('click', async () => {
        const have = new Set(contacts.map((c) => digits(c.sms_phone || c.cell_phone)).filter(Boolean));
        const copy = state.contacts.filter((c) => c.student_id === b.dataset.cc && c.role !== 'emergency' && !have.has(digits(c.sms_phone || c.cell_phone)))
          .map(({ id: _, created_at: __, student_id: ___, ...c }) => ({ ...c, student_id: id }));
        if (!copy.length) return toast('Those parents are already on this page', true);
        if (ctl.dirty && !confirm('Discard your changes?')) return;
        const { data, error } = await sb.from('student_contacts').insert(copy).select();
        if (error) return fail(error, 'Could not copy the contacts');
        state.contacts = [...state.contacts, ...data];
        toast(`Copied ${data.map(contactName).join(' and ')}`);
        ctl.dirty = false;
        openStudent(id);
      }));
    });
    $$('[data-contact]', drawer).forEach((b) => b.addEventListener('click', () => {
      if (!ctl.dirty || confirm('Discard your changes?')) openContact({ contactId: b.dataset.contact, back });
    }));

    async function save() {
      const patch = {};
      STUDENT_FIELDS.forEach((k) => { patch[k] = formVal(form, k); });
      if (state.hasV6) patch.family_account = formVal(form, 'family_account');
      if (!patch.name) { form.name.focus(); return toast('Add the student’s name', true); }
      if (LEFT.has(patch.status)) patch.withdrawn_on = patch.withdrawn_on || todayStr();
      else { patch.withdrawn_on = null; patch.withdraw_reason = null; }
      if (preset.inquiry_id && !id) patch.inquiry_id = preset.inquiry_id;
      let finPatch = null;
      if (finEdit) {
        const amount = form.tuition_amount.value.trim();
        if (amount !== '' && !(Number(amount) >= 0)) { form.tuition_amount.focus(); return toast('Tuition must be a number', true); }
        finPatch = {
          funding: Object.keys(PROGRAMS_FUNDING).filter((k) => form['fund_' + k].checked || (k === 'sr' && form.fund_sr_bpiece.checked)),
          tuition_amount: amount === '' ? null : round2(amount),
          tuition_frequency: form.tuition_frequency.value,
          award_id: formVal(form, 'award_id'),
          notes: formVal(form, 'fin_notes'),
          ...(state.hasV6 ? { billing_program: formVal(form, 'billing_program'), bill_family: form.bill_family.checked } : {}),
          ...(state.hasClassRates ? { rate_note: formVal(form, 'rate_note') } : {}),
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
      if (pays.length || invs.length) return toast('This student has invoices or payments on record. Set the status to Withdrawn instead.', true);
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

  // ───── Registration for next school year (023): who's returning, the class they move up to, and their registration paid ─────
  const rosterTabs = () => (state.registrations && canViewFinance() ? `<div class="seg" role="tablist" aria-label="Enrollment">
      ${[['children', 'Children'], ['reg', `Registration ${regYearLabel()}`]].map(([k, v]) => `<button type="button" role="tab" data-rtab="${k}" aria-selected="${(state.rosterTab === 'reg') === (k === 'reg')}">${esc(v)}</button>`).join('')}</div>` : '');
  const regYear = () => state.settings?.reg_year || '2027-28';
  const regYearLabel = () => regYear().replace('-', '–');
  function bindRosterTabs(el) {
    $$('[data-rtab]', el).forEach((b) => b.addEventListener('click', () => { state.rosterTab = b.dataset.rtab; store.set('rosterTab', state.rosterTab); renderRoster(el); }));
  }
  // Each child now at the school or waiting, with next year's plan: a saved row, or the default (the next class up; waiting
  // children keep their class; Kindergarten moves on to 1st grade). The fee is that class's registration fee.
  function regRows() {
    const year = regYear(), classes = state.classrooms.slice().sort((a, b) => a.sort - b.sort);
    const start = `${year.slice(0, 4)}-08-01`;
    return state.students.filter((s) => s.status === 'enrolled' || s.status === 'waitlist'
      || state.registrations.some((x) => x.student_id === s.id && x.school_year === year)).map((s) => {
      const r = state.registrations.find((x) => x.student_id === s.id && x.school_year === year);
      const i = classes.findIndex((c) => c.id === s.classroom_id);
      const nextDefault = s.status === 'waitlist' ? s.classroom_id : i >= 0 && i < classes.length - 1 ? classes[i + 1].id : null;
      const next = r ? r.next_classroom_id : nextDefault;
      const status = r ? r.status : next ? 'returning' : 'not_returning';
      const cls = state.classrooms.find((c) => c.id === next);
      const inv = r?.invoice_id && state.invoices.find((x) => x.id === r.invoice_id && !x.void);
      const fee = inv ? Number(inv.amount) : Number(cls?.registration_fee) || 0;
      const paid = inv ? invoicePaid(inv) : 0;
      const pays = inv ? state.payments.filter((p) => p.invoice_id === inv.id).sort((a, b) => b.paid_on.localeCompare(a.paid_on)) : [];
      // Waiting (or not started) for next year with registration already paid: nothing more to collect.
      const onFile = !inv && status === 'returning' && regPaid(s) && (s.status === 'waitlist' || (s.start_date && s.start_date >= start));
      const state_ = status !== 'returning' ? status : onFile ? 'on_file' : inv && paid >= fee && fee > 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
      return { s, r, next, cls, status, inv, fee, paid, pays, st: state_ };
    }).sort((a, b) => (classes.findIndex((c) => c.id === a.next) - classes.findIndex((c) => c.id === b.next)) || byLastName(a.s.name, b.s.name));
  }
  const REG_ST = { paid: 'Paid', on_file: 'Paid (on file)', partial: 'Partly paid', unpaid: 'Not paid yet', not_returning: 'Not returning', undecided: 'Not sure yet' };
  // Next year's class and "coming back?" (023's registration_save keeps the bill in step) and the bill as it is now.
  async function saveReg(x, patch) {
    const { data, error } = await sb.rpc('registration_save', { p_student: x.s.id, p_year: regYear(),
      p_next: 'next' in patch ? patch.next : x.next, p_status: patch.status || x.status });
    if (error) { fail(error, 'Could not save the registration'); return null; }
    await syncReg(data, x.r?.invoice_id);
    return data;
  }
  async function syncReg(row, oldInvoice) {
    state.registrations = [...state.registrations.filter((r) => r.id !== row.id), row];
    const ids = [...new Set([row.invoice_id, oldInvoice].filter(Boolean))];
    if (!ids.length) return;
    const { data } = await sb.from('invoices').select('*').in('id', ids);
    state.invoices = [...state.invoices.filter((i) => !ids.includes(i.id)), ...(data || [])];   // a removed bill is gone
  }
  // A registration payment: the bill is made and paid in one step when it's saved (023's registration_pay), with a receipt.
  function openRegPayment(x, after) {
    const year = regYearLabel(), due = round2(Math.max(x.fee - x.paid, 0)) || '';
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const ctl = mountDrawer({
      title: `Registration ${esc(year)}`,
      sub: esc(`${x.s.name} · ${x.cls?.name || 'No class'} · ${money(x.fee)}${x.paid ? ` · ${money(x.paid)} paid` : ''}`),
      body: `<div class="section grid2">
          ${fInput('amount', 'Amount', due, 'number', 'min="0.01" step="0.01" inputmode="decimal"')}
          ${fInput('paid_on', 'Date received', todayStr(), 'date')}
          <label>Method<select name="method">${Object.entries(METHOD).map(([k, v]) => opt(k, v, 'cash')).join('')}</select></label>
          <label>Paid by<select name="payer">${Object.entries(PAYER).map(([k, v]) => opt(k, v, 'parent')).join('')}</select></label>
          ${fInput('reference', 'Check no. / confirmation', '', 'text', 'maxlength="80"')}
          ${fInput('note', 'Note', '', 'text', 'maxlength="500"')}
        </div>`,
      foot: `<span class="spacer"></span><button class="btn" data-close type="button">Cancel</button>
        <button class="btn" id="rp-save" type="button">Save</button><button class="btn primary" id="rp-print" type="button">Save and print receipt</button>`,
    });
    const { drawer, form } = ctl;
    form.amount.focus();
    const save = async (print) => {
      const amount = round2(form.amount.value);
      if (!(amount > 0)) { form.amount.focus(); return toast('Type the amount', true); }
      if (!form.paid_on.value) return toast('Enter the date received', true);
      $$('#rp-save, #rp-print', drawer).forEach((b) => { b.disabled = true; });
      const { data, error } = await sb.rpc('registration_pay', { p_student: x.s.id, p_year: regYear(), p_next: x.next, p_amount: amount,
        p_paid_on: form.paid_on.value, p_method: form.method.value, p_payer: form.payer.value, p_reference: form.reference.value, p_note: form.note.value });
      if (error) { $$('#rp-save, #rp-print', drawer).forEach((b) => { b.disabled = false; }); return fail(error, 'Could not save the payment'); }
      state.payments = [...state.payments, data];
      const { data: row } = await sb.from('registrations').select('*').eq('school_year', regYear()).eq('student_id', x.s.id).single();
      if (row) await syncReg(row, data.invoice_id);
      ctl.dirty = false;
      closeDrawer();
      toast(`Saved · receipt #${data.receipt_no}`);
      after();
      if (print) showReceipts([data]);
    };
    $('#rp-save', drawer).addEventListener('click', () => save(false));
    $('#rp-print', drawer).addEventListener('click', () => save(true));
  }
  function renderRegistration(el) {
    const f = state.regFilters, edit = canEditFinance(), all = regRows(), year = regYearLabel();
    const opens = state.settings?.reg_opens, before = opens && todayStr() < opens;
    const back = all.filter((x) => x.status === 'returning');
    const collected = round2(all.reduce((t, x) => t + x.paid, 0)), toCollect = round2(back.filter((x) => x.st !== 'on_file').reduce((t, x) => t + Math.max(x.fee - x.paid, 0), 0));
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const lastId = state.classrooms.slice().sort((a, b) => b.sort - a.sort)[0]?.id;
    const noClass = (s) => (s.classroom_id === lastId ? '1st grade (leaving)' : 'No class');
    const nextName = (x) => x.cls?.name || noClass(x.s);
    el.innerHTML = `${rosterTabs()}
      ${before ? `<p class="panel small">Registration for ${esc(year)} opens <b>${esc(longDate(opens))}</b>. You can already record anyone who pays early.</p>` : ''}
      <div class="stats">
        <div class="stat"><b>${all.filter((x) => ['paid', 'on_file'].includes(x.st)).length} of ${back.length}</b><span>Returning children registered for ${esc(year)}</span></div>
        <div class="stat"><b>${money(collected)}</b><span>Registration collected</span></div>
        <div class="stat"><b>${money(toCollect)}</b><span>Still to collect</span></div>
        <div class="stat"><b>${all.filter((x) => x.status === 'not_returning').length}</b><span>Not returning · ${all.filter((x) => x.status === 'undecided').length} not sure</span></div>
      </div>
      <div class="toolbar">
        <input type="search" id="rg-q" placeholder="Search student or family…" value="${esc(f.q)}">
        <select id="rg-cls">${opt('', 'Every class next year', f.cls)}${state.classrooms.map((c) => opt(c.id, c.name, f.cls)).join('')}</select>
        <select id="rg-st">${opt('', 'Everyone', f.status)}${Object.entries(REG_ST).map(([k, v]) => opt(k, v, f.status)).join('')}</select>
        <span class="spacer"></span><span class="muted small" id="rg-count"></span>
        <button class="btn small" id="rg-csv" type="button">Download CSV</button></div>
      <div class="table-wrap"><table class="reg-table"><thead><tr><th>Child</th><th>${esc(year)}</th><th>Coming back?</th><th class="num">Registration</th><th>Paid</th>${edit ? '<th></th>' : ''}</tr></thead>
        <tbody id="rg-rows"></tbody></table></div>
      <p class="muted small">Each child is shown moving up to the next class (children on the waiting list keep theirs; Kindergarten moves on to 1st grade).
        Change it if they’ll be in a different class. The registration fee is that class’s (Settings → Classes). Recording a payment makes a
        “Registration ${esc(year)}” bill for the child and pays it, with a receipt, and it counts in Money and Reports like any payment.</p>`;
    bindRosterTabs(el);
    const draw = () => {
      const q = f.q.trim().toLowerCase();
      const rows = all.filter((x) => (!f.cls || x.next === f.cls) && (!f.status || x.st === f.status)
        && (!q || [x.s.name, x.s.parent_name, x.s.family_account].some((v) => (v || '').toLowerCase().includes(q))));
      $('#rg-count', el).textContent = `${rows.length} child${rows.length === 1 ? '' : 'ren'}`;
      $('#rg-rows', el).innerHTML = rows.map((x) => `<tr data-sid="${x.s.id}" class="${x.status !== 'returning' ? 'reg-off' : ''}">
          <td><a href="#" data-open-sid="${x.s.id}"><b>${esc(x.s.name)}</b></a><div class="muted small">${esc([classroomName(x.s.classroom_id) || 'No class',
            x.s.status === 'waitlist' ? 'waiting list' : LEFT.has(x.s.status) ? STUDENT_STATUS[x.s.status].toLowerCase() : ''].filter(Boolean).join(' · '))}</div></td>
          <td>${edit ? `<select data-next aria-label="Class in ${esc(year)}">${opt('', noClass(x.s), x.next || '')}
            ${state.classrooms.map((c) => opt(c.id, c.name, x.next || '')).join('')}</select>` : esc(nextName(x))}</td>
          <td>${edit ? `<select data-status aria-label="Coming back in ${esc(year)}">${opt('returning', 'Yes', x.status)}${opt('undecided', 'Not sure', x.status)}${opt('not_returning', 'No', x.status)}</select>`
            : esc(x.status === 'returning' ? 'Yes' : x.status === 'undecided' ? 'Not sure' : 'No')}</td>
          <td class="num">${x.status === 'returning' && x.fee ? money(x.fee) : ''}</td>
          <td><span class="pay-pill ps-${['paid', 'on_file'].includes(x.st) ? 'paid' : x.st === 'partial' ? 'partial' : x.st === 'unpaid' ? 'open' : 'none'}">${esc(REG_ST[x.st])}</span>
            ${x.pays.length ? `<div class="muted small">${esc(x.pays.map((p) => `${money(p.amount)} ${fmtDate(p.paid_on)}${p.method ? ` · ${METHOD[p.method] || p.method}` : ''}`).join(', '))}</div>` : ''}</td>
          ${edit ? `<td>${x.status === 'returning' && ['unpaid', 'partial'].includes(x.st) && x.fee ? '<button class="btn small" type="button" data-reg-pay>Record payment</button>' : ''}
            ${x.pays.length ? '<button class="btn small ghost" type="button" data-reg-receipt>Receipt</button>' : ''}</td>` : ''}</tr>`).join('')
        || `<tr><td colspan="${edit ? 6 : 5}" class="muted">Nobody matches.</td></tr>`;
      $$('#rg-rows [data-open-sid]', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openStudent(a.dataset.openSid); }));
      const rowOf = (n) => all.find((x) => x.s.id === n.closest('tr').dataset.sid);
      $$('#rg-rows [data-next]', el).forEach((sel) => sel.addEventListener('change', async () => {
        sel.disabled = true;
        const ok = await saveReg(rowOf(sel), { next: sel.value || null, status: sel.value ? 'returning' : 'not_returning' });
        if (ok) toast('Saved');
        renderRegistration(el);
      }));
      $$('#rg-rows [data-status]', el).forEach((sel) => sel.addEventListener('change', async () => {
        sel.disabled = true;
        const ok = await saveReg(rowOf(sel), { status: sel.value });
        if (ok) toast('Saved');
        renderRegistration(el);
      }));
      $$('#rg-rows [data-reg-pay]', el).forEach((b) => b.addEventListener('click', () => openRegPayment(rowOf(b), () => renderRegistration(el))));
      $$('#rg-rows [data-reg-receipt]', el).forEach((b) => b.addEventListener('click', () => showReceipts(rowOf(b).pays)));
    };
    ['q', 'cls', 'st'].forEach((k) => {
      const input = $(`#rg-${k}`, el);
      input.addEventListener(k === 'q' ? 'input' : 'change', () => { f[k === 'st' ? 'status' : k] = input.value; draw(); });
    });
    $('#rg-csv', el).addEventListener('click', () => csvDownload(`creativa-registration-${regYear()}.csv`,
      ['Student', 'Class now', `Class ${year}`, 'Coming back', 'Registration fee', 'Paid', 'Status', 'Parent', 'Phone'],
      all.map((x) => [x.s.name, classroomName(x.s.classroom_id), x.cls?.name || '', x.status, x.status === 'returning' ? x.fee : '', x.paid, REG_ST[x.st], x.s.parent_name, x.s.parent_phone])));
    draw();
  }

  // An inquiry marked Enrolled (or Waitlisted) can be added to the enrollment list (or the waiting list) in one tap.
  function studentFromInquiry(inq) {
    const cls = state.classrooms.find((c) => c.name === inq.program);
    openStudent(null, {
      name: inq.child_name || '', dob: inq.child_dob, classroom_id: cls?.id || null, status: inq.stage === 'waitlisted' ? 'waitlist' : 'enrolled',
      ...(inq.reg_paid_on ? { reg_fee: 'paid' } : {}),
      parent_name: inq.parent_name, parent_phone: inq.phone, parent_email: inq.email, inquiry_id: inq.id, start_date: inq.start_on || null,
      ...(Number(inq.expected_tuition) > 0 ? { finance: { tuition_amount: inq.expected_tuition, tuition_frequency: inq.expected_freq || 'biweekly' } } : {}),
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
    if (LEFT.has(s.status)) return !!s.withdrawn_on && s.withdrawn_on >= monthStart(m);
    return true;
  }

  // What a payment was for: its invoice, a credit not yet applied, or (before 007) a month.
  function paymentFor(p) {
    if (p.invoice_id) {
      const inv = state.invoices.find((i) => i.id === p.invoice_id);
      return inv ? invoiceLabel(inv) : 'Invoice';
    }
    return state.hasV6 ? 'Credit (not applied)' : fmtMonth(p.covers_month.slice(0, 7));
  }

  function openPayment({ studentId, paymentId, invoiceId, month, back }) {
    const p = paymentId ? state.payments.find((x) => x.id === paymentId) : null;
    const sid = p ? p.student_id : studentId;
    const v6 = state.hasV6;
    const m = p ? p.covers_month.slice(0, 7) : (month || thisMonth());
    // With billing: suggest the chosen (or oldest open) invoice and its balance. Before 007: the month's tuition.
    const invId = p ? p.invoice_id : invoiceId || (sid && v6 && !month ? openInvoices(sid)[0]?.id : null);
    const due = sid && !v6 ? monthDue(sid) : null;
    const inv0 = invId && state.invoices.find((i) => i.id === invId);
    const suggested = p ? p.amount : inv0 ? invoiceBalance(inv0) || '' : due != null ? Math.max(round2(due - paidFor(sid, m)), 0) || '' : '';
    const payer = p ? p.payer : 'parent';
    const students = state.students.filter((s) => s.status !== 'waitlist' || s.id === sid).sort(sortStudents);
    const st = state.students.find((s) => s.id === sid);
    const invoiceOptions = (studentIdNow) => {
      const list = state.invoices.filter((i) => i.student_id === studentIdNow && !i.void && (invoiceBalance(i) > 0 || i.id === invId))
        .sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
      return optionsHtml([['', 'None: keep as a credit'], ...list.map((i) => [i.id, `${invoiceLabel(i)} · ${money(invoiceBalance(i))} due`])], invId || '');
    };
    const ctl = mountDrawer({
      title: p ? `Payment · receipt #${p.receipt_no}` : 'Record payment',
      sub: st ? esc(st.name) : '',
      body: `<div class="section"><div class="grid2">
          <label class="full">Student<select name="student_id" required>${sid ? '' : '<option value="">Choose a student…</option>'}
            ${optionsHtml(students.map((s) => [s.id, `${s.name}${s.classroom_id ? ' · ' + classroomName(s.classroom_id) : ''}`]), sid)}</select></label>
          ${v6 ? `<label class="full">Pays invoice<select name="invoice_id">${sid ? invoiceOptions(sid) : '<option value="">None: keep as a credit</option>'}</select></label>` : ''}
          ${fInput('amount', 'Amount ($)', suggested, 'number', 'min="0.01" step="0.01" inputmode="decimal" required')}
          ${v6 ? '' : fInput('covers_month', 'For the month of', m, 'month', 'required')}
          ${fInput('paid_on', 'Date received', p ? p.paid_on : todayStr(), 'date', 'required')}
          ${fSelect('payer', 'Paid by', Object.entries(PAYER), payer)}
          ${fSelect('method', 'Method', Object.entries(METHOD), p ? p.method : 'cash')}
          ${fInput('reference', 'Check # / confirmation', p?.reference)}
          <label class="full">Note (printed on the receipt)<input name="note" value="${esc(p?.note)}" placeholder="e.g. Zelle confirmation 1234"></label>
        </div>
        <p class="muted small" id="pay-hint"></p></div>`,
      foot: `${p ? '<button class="btn danger" id="pay-del" type="button">Delete</button>' : ''}<span class="spacer"></span>
        <button class="btn" data-close type="button">Cancel</button>
        <button class="btn" id="pay-save" type="button">Save</button>
        <button class="btn primary" id="pay-save-print" type="button">Save & receipt</button>`,
    });
    const { drawer, form } = ctl;
    const hint = () => {
      const id = form.student_id.value;
      if (v6) {
        const inv = form.invoice_id.value && state.invoices.find((i) => i.id === form.invoice_id.value);
        const own = p && inv && p.invoice_id === inv.id ? Number(p.amount) : 0;
        $('#pay-hint', drawer).textContent = inv
          ? `${invoiceLabel(inv)}: ${money(inv.amount)} billed, ${money(invoicePaid(inv) - own)} already paid.`
          : id ? 'Not applied to an invoice: it stays as a credit you can apply later on the Tuition page.' : '';
        return;
      }
      const mo = form.covers_month.value;
      const d = id ? monthDue(id) : null;
      $('#pay-hint', drawer).textContent = id && mo && d != null
        ? `${fmtMonth(mo)}: ${money(d)} due, ${money(paidFor(id, mo) - (p && p.covers_month.slice(0, 7) === mo ? Number(p.amount) : 0))} already paid.` : '';
    };
    form.student_id.addEventListener('change', () => {
      if (v6) {
        form.invoice_id.innerHTML = invoiceOptions(form.student_id.value);
        const first = openInvoices(form.student_id.value)[0];
        if (first && !p) { form.invoice_id.value = first.id; form.amount.value = invoiceBalance(first); }
      }
      hint();
    });
    if (v6) {
      form.invoice_id.addEventListener('change', () => {
        const inv = state.invoices.find((i) => i.id === form.invoice_id.value);
        if (inv && !p) form.amount.value = invoiceBalance(inv) || form.amount.value;
        hint();
      });
    } else {
      form.covers_month.addEventListener('change', hint);
    }
    hint();
    if (!p && sid && !hasFunding(sid, 'private')) $('#pay-hint', drawer).append(' Funding: ' + fundingText(sid) + '.');
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
      if (!v6 && !/^\d{4}-\d{2}$/.test(form.covers_month.value)) { form.covers_month.focus(); return toast('Pick the month this pays for', true); }
      if (!form.paid_on.value) return toast('Enter the date received', true);
      const inv = v6 && form.invoice_id.value ? state.invoices.find((i) => i.id === form.invoice_id.value) : null;
      const row = {
        student_id: form.student_id.value, amount: round2(amount),
        covers_month: v6 ? (inv ? inv.invoice_date : form.paid_on.value).slice(0, 7) + '-01' : form.covers_month.value + '-01',
        paid_on: form.paid_on.value, payer: form.payer.value, method: form.method.value,
        reference: formVal(form, 'reference'), note: formVal(form, 'note'),
        ...(v6 ? { invoice_id: inv ? inv.id : null } : {}),
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

  // Contacts: parents, guardians and emergency/authorized pick-up people.
  function openContact({ studentId, contactId, back }) {
    const c = contactId ? state.contacts.find((x) => x.id === contactId) : { role: 'primary' };
    if (!c) return;
    const sid = c.student_id || studentId;
    const st = state.students.find((s) => s.id === sid);
    const ctl = mountDrawer({
      title: contactId ? esc(contactName(c) || 'Contact') : 'New contact',
      sub: st ? esc(st.name) : '',
      body: `<div class="section"><div class="grid2">
          ${fSelect('role', 'Role', Object.entries(CONTACT_ROLE), c.role)}
          ${fInput('relationship', 'Relationship', c.relationship, 'text', 'placeholder="Mother, Father, Grandmother…"')}
          ${fInput('first_name', 'First name', c.first_name)}
          ${fInput('last_name', 'Last name', c.last_name)}
          ${fInput('cell_phone', 'Cell phone', c.cell_phone, 'tel')}
          ${fInput('sms_phone', 'Text (SMS) phone', c.sms_phone, 'tel')}
          ${fInput('work_phone', 'Work phone', c.work_phone, 'tel')}
          ${fInput('home_phone', 'Home phone', c.home_phone, 'tel')}
          ${fInput('email', 'Email', c.email, 'email')}
          <label class="full">Notes<input name="notes" value="${esc(c.notes)}" placeholder="e.g. Call mom first"></label>
          ${state.hasGroupTexts ? `<label class="full pill-check"><input type="checkbox" class="check" name="group_texts" ${getsGroupTexts(c) ? 'checked' : ''}>
            Gets group texts (lists, classes, all families, reminders)</label>` : ''}
        </div></div>`,
      foot: `${contactId ? '<button class="btn danger" id="ct-del" type="button">Remove</button>' : ''}<span class="spacer"></span>
        <button class="btn" data-close type="button">Cancel</button>
        <button class="btn primary" id="ct-save" type="button">Save</button>`,
    });
    const { drawer, form } = ctl;
    form.first_name.focus();
    let gtTouched = c.group_texts != null;   // until ticked by hand, group texts follow the role (Primary yes, others no)
    form.group_texts?.addEventListener('change', () => { gtTouched = true; });
    form.role.addEventListener('change', () => { if (form.group_texts && !gtTouched) form.group_texts.checked = form.role.value === 'primary'; });
    const done = () => { ctl.dirty = false; renderView(); if (back) back(); else closeDrawer(); };
    $('#ct-save', drawer).addEventListener('click', async () => {
      const row = { student_id: sid };
      ['role', 'relationship', 'first_name', 'last_name', 'cell_phone', 'sms_phone', 'work_phone', 'home_phone', 'email', 'notes']
        .forEach((k) => { row[k] = formVal(form, k); });
      if (!row.first_name && !row.last_name) { form.first_name.focus(); return toast('Add the contact’s name', true); }
      if (form.group_texts) row.group_texts = form.group_texts.checked === (row.role === 'primary') ? null : form.group_texts.checked;
      const q = contactId ? sb.from('student_contacts').update(row).eq('id', contactId) : sb.from('student_contacts').insert(row);
      const { data, error } = await q.select().single();
      if (error) return fail(error, 'Could not save the contact');
      state.contacts = [...state.contacts.filter((x) => x.id !== data.id), data];
      toast('Contact saved');
      done();
    });
    $('#ct-del', drawer)?.addEventListener('click', async () => {
      if (!confirm(`Remove ${contactName(c) || 'this contact'}?`)) return;
      const { error } = await sb.from('student_contacts').delete().eq('id', contactId);
      if (error) return fail(error, 'Could not remove');
      state.contacts = state.contacts.filter((x) => x.id !== contactId);
      toast('Contact removed');
      done();
    });
  }

  const longDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const schoolYear = (ym) => { const [y, m] = ym.split('-').map(Number); const a = m >= 8 ? y : y - 1; return `${a} – ${a + 1}`; };

  function receiptLine(p) {
    if (p.old) return `Tuition — ${longPeriod(p.old)}`;
    const inv = p.invoice_id && state.invoices.find((i) => i.id === p.invoice_id);
    const t = inv && lateFeeFor(inv);
    if (t) return `${inv.description} — tuition ${longPeriod(t.period_start)}`;
    if (inv) return inv.kind === 'tuition' ? `Tuition (${inv.description}) — ${longPeriod(inv.period_start)}` : inv.description;
    return state.hasV6 ? 'Payment on account' : `Tuition — ${fmtMonth(p.covers_month.slice(0, 7))}`;
  }

  // Laid out like the school's Programs & Hours sheet: logo band, section headings, beige table
  // headers, a rounded scholarship box and the address line at the foot of the page.
  function receiptHtml(p) {
    const s = state.students.find((x) => x.id === p.student_id) || { name: '' };
    const f = state.finance[p.student_id] || {};
    const set = state.settings || {};
    const from = p.payer === 'parent' ? (s.parent_name || `Family of ${s.name}`) : PAYER[p.payer];
    const programs = fundingOf(p.student_id).filter((k) => k !== 'private');
    const programLabel = programs.map((k) => (k === 'fes_ua' ? 'FES-UA (Unique Abilities)' : FUNDING[k])).join(' · ');
    return `<article class="receipt">
      <header class="r-band"><img src="/assets/logo.png" alt="${esc(set.school_name || 'Creativa Academy')}">
        <div class="r-title"><h1>Payment Receipt</h1><span class="r-year">School year ${esc(schoolYear(p.covers_month.slice(0, 7)))}</span>
          ${set.receipt_license ? `<span class="r-license">License No. ${esc(set.receipt_license)}</span>` : ''}
          ${set.receipt_tax_id ? `<span class="r-license">Tax ID (EIN) ${esc(set.receipt_tax_id)}</span>` : ''}</div></header>
      <p class="r-intro">${p.old ? '<span>Paid through <b>the billing system</b></span>' : `<span>Receipt No. <b>${esc(p.receipt_no)}</b></span>`}<span>Date <b>${esc(longDate(p.paid_on))}</b></span></p>
      <h2 class="r-h">Student</h2>
      <table class="r-table"><thead><tr><th>Student</th><th>Date of birth</th><th>Class</th><th>Received from</th></tr></thead>
        <tbody><tr><td>${esc(s.name)}</td><td>${esc(s.dob ? longDate(s.dob) : '')}</td>
          <td>${esc(classroomName(s.classroom_id))}</td><td>${esc(from)}</td></tr></tbody></table>
      <h2 class="r-h">Payment</h2>
      <table class="r-table"><thead><tr><th>Description</th><th>Date received</th><th>Method</th><th class="num">Amount</th></tr></thead>
        <tbody><tr><td>${esc(receiptLine(p))}${p.note ? `<div class="r-note">${esc(p.note)}</div>` : ''}</td>
          <td>${p.old ? 'Billing system' : esc(longDate(p.paid_on))}</td><td>${p.old ? 'Billing system' : esc(METHOD[p.method])}${p.reference ? `<div class="r-note">${esc(p.reference)}</div>` : ''}</td>
          <td class="num"><b>${money(p.amount)}</b></td></tr></tbody>
        <tfoot><tr><th colspan="3">Total received</th><th class="num">${money(p.amount)}</th></tr></tfoot></table>
      ${programs.length || f.award_id ? `<div class="r-box"><h3>${esc(programLabel || 'Scholarship')}</h3>
        ${f.award_id ? `<p>Scholarship / award ID <b>${esc(f.award_id)}</b></p>` : ''}</div>` : ''}
      <div class="r-sign"><span class="r-line">${state.signature ? `<img class="r-sig" src="${esc(state.signature)}" alt="Signature">` : ''}</span>
        <span>${esc(set.receipt_signer || 'Authorized signature')}</span></div>
      <footer class="r-foot"><b>${esc(set.school_name || 'Creativa Academy')}</b>${set.receipt_header ? `\n${esc(set.receipt_header)}` : ''}</footer>
    </article>`;
  }

  // Receipts and statements open over the app; Print (or Save as PDF) prints only them, one per page.
  function showReceipts(list) {
    if (!list.length) return toast('No payments to print', true);
    showSheet(`${list.length} receipt${list.length === 1 ? '' : 's'}`, list.map(receiptHtml));
  }
  function showSheet(label, pages) {
    const sheet = document.createElement('div');
    sheet.className = 'print-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.innerHTML = `<div class="print-bar no-print"><b>${esc(label)}</b><span class="spacer"></span>
        <button class="btn primary" type="button" id="rc-print">Print / Save as PDF</button>
        <button class="btn" type="button" id="rc-close">Close</button></div>
      ${pages.join('')}`;
    document.body.append(sheet);
    document.body.classList.add('printing');
    const close = () => { sheet.remove(); document.body.classList.remove('printing'); };
    $('#rc-print', sheet).addEventListener('click', () => window.print());
    $('#rc-close', sheet).addEventListener('click', close);
    sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    $('#rc-close', sheet).focus();
  }

  // ───────────── Annual statements (tax time) ─────────────
  // What a family paid in a calendar year, for the child and dependent care credit (IRS Form 2441 asks for the
  // provider's name, address and tax ID and the amount paid). Payments from School Readiness, Step Up (FES) and VPK
  // are left out: the family didn't pay those. Siblings on the same billing family account share one statement.
  const FAMILY_PAYERS = new Set(['parent', 'other']);
  const taxYearDefault = () => { const d = new Date(); return d.getMonth() < 4 ? d.getFullYear() - 1 : d.getFullYear(); };   // Jan–Apr: last year
  const familyKey = (s) => (s.family_account?.trim() ? 'f:' + s.family_account.trim().toLowerCase() : 's:' + s.id);
  function familyName(students) {
    for (const s of students) {
      const c = state.contacts.find((x) => x.student_id === s.id && x.role === 'primary');
      if (c && contactName(c)) return contactName(c);
    }
    const p = students.find((s) => s.parent_name);
    return p ? p.parent_name : `Family of ${students.map((s) => s.name).join(' & ')}`;
  }
  // The school year began Aug 10, before the CRM: those periods were billed and paid in the old billing system, and
  // statements include what each family paid for them (billing_history.paid, 011). Until 011 is run they're left out.
  const histReady = () => state.history.length > 0 && 'needs_check' in state.history[0];
  const earlierFor = (year) => (histReady() ? state.history.filter((h) => h.period_start && h.period_start < billing().anchor
    && h.period_start.startsWith(`${year}-`) && earlierPaid(h) > 0) : []);
  const histFamilyKey = (h) => 'f:' + (h.family_account || h.customer).trim().toLowerCase();
  function statementGroups(year) {
    const groups = new Map();
    const group = (k) => { if (!groups.has(k)) groups.set(k, { key: k, students: [], payments: [], earlier: [] }); return groups.get(k); };
    state.payments.filter((p) => FAMILY_PAYERS.has(p.payer) && p.paid_on.startsWith(`${year}-`)).forEach((p) => {
      const s = state.students.find((x) => x.id === p.student_id);
      if (!s) return;
      const g = group(familyKey(s));
      if (!g.students.includes(s)) g.students.push(s);
      g.payments.push(p);
    });
    earlierFor(year).forEach((h) => {
      const g = group(histFamilyKey(h));
      state.students.filter((s) => familyKey(s) === g.key).forEach((s) => { if (!g.students.includes(s)) g.students.push(s); });
      g.customer = g.customer || h.customer;
      g.earlier.push(h);
    });
    return [...groups.values()].map((g) => ({ ...g, name: g.students.length ? familyName(g.students) : g.customer,
      students: g.students.sort(sortStudents),
      total: round2(g.payments.reduce((t, p) => t + Number(p.amount), 0) + g.earlier.reduce((t, h) => t + earlierPaid(h), 0)),
      count: g.payments.length + g.earlier.length,
      needsCheck: g.earlier.some((h) => h.needs_check),
      earlier: g.earlier.sort((a, b) => a.period_start.localeCompare(b.period_start)),
      payments: g.payments.sort((a, b) => a.paid_on.localeCompare(b.paid_on) || a.receipt_no - b.receipt_no) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  function statementHtml(g, year) {
    const set = state.settings || {};
    const school = set.school_name || 'Creativa Academy';
    const address = (set.receipt_header || '').split(' · ')[0];
    const many = g.students.length > 1;
    const partial = String(year) === todayStr().slice(0, 4);
    const nameOf = (sid) => state.students.find((s) => s.id === sid)?.name || '';
    return `<article class="receipt statement">
      <header class="r-band"><img src="/assets/logo.png" alt="${esc(school)}">
        <div class="r-title"><h1>Annual Statement</h1><span class="r-year">Tax year ${year}</span>
          ${set.receipt_license ? `<span class="r-license">License No. ${esc(set.receipt_license)}</span>` : ''}</div></header>
      <p class="r-intro"><span>For <b>${esc(g.name)}</b></span><span>Date <b>${esc(longDate(todayStr()))}</b></span></p>
      <h2 class="r-h">Child care provider</h2>
      <table class="r-table"><thead><tr><th>Name</th><th>Address</th><th>Tax ID (EIN)</th></tr></thead>
        <tbody><tr><td><b>${esc(school)}</b></td><td>${esc(address)}</td><td><b>${esc(set.receipt_tax_id || '')}</b></td></tr></tbody></table>
      <h2 class="r-h">Child${many ? 'ren' : ''}</h2>
      <table class="r-table"><thead><tr><th>Name</th><th>Date of birth</th><th>Class</th></tr></thead>
        <tbody>${g.students.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.dob ? longDate(s.dob) : '')}</td>
          <td>${esc(classroomName(s.classroom_id))}</td></tr>`).join('') || `<tr><td colspan="3"><b>${esc(g.customer || '')}</b></td></tr>`}</tbody></table>
      <h2 class="r-h">Payments in ${year}${partial ? ` (through ${esc(longDate(todayStr()))})` : ''}</h2>
      <table class="r-table"><thead><tr><th>Date</th><th>Receipt</th>${many ? '<th>Child</th>' : ''}<th>For</th><th>Method</th><th class="num">Amount</th></tr></thead>
        <tbody>${g.earlier.map((h) => `<tr><td>${esc(fmtDate(h.period_start))} – ${esc(fmtDate(h.period_end))}</td><td>—</td>${many ? '<td>—</td>' : ''}
          <td>Tuition ${esc(longPeriod(h.period_start))}</td><td>Billing system</td><td class="num">${money(earlierPaid(h))}</td></tr>`).join('')}
        ${g.payments.map((p) => `<tr><td>${esc(fmtDate(p.paid_on))}</td><td>#${esc(p.receipt_no)}</td>
          ${many ? `<td>${esc(nameOf(p.student_id))}</td>` : ''}<td>${esc(receiptLine(p))}</td><td>${esc(METHOD[p.method])}</td>
          <td class="num">${money(p.amount)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th colspan="${many ? 5 : 4}">Total paid in ${year}</th><th class="num">${money(g.total)}</th></tr></tfoot></table>
      <p class="r-note">${esc(school)} received the payments above from this family for child care between January 1 and
        ${partial ? esc(longDate(todayStr())) : `December 31, ${year}`}.${g.earlier.length ? ` Tuition for ${esc(fmtDate(g.earlier[0].period_start))} –
        ${esc(longDate(g.earlier[g.earlier.length - 1].period_end))} was billed and paid through the school’s previous billing system; those lines show
        the amount paid for each billing period.` : ''} Payments made by School Readiness, Step Up For Students or VPK are not included.</p>
      <div class="r-sign"><span class="r-line">${state.signature ? `<img class="r-sig" src="${esc(state.signature)}" alt="Signature">` : ''}</span>
        <span>${esc(set.receipt_signer || 'Authorized signature')}</span></div>
      <footer class="r-foot"><b>${esc(school)}</b>${set.receipt_header ? `\n${esc(set.receipt_header)}` : ''}</footer>
    </article>`;
  }
  function showStatements(groups, year) {
    if (!groups.length) return toast(`No family payments in ${year}`, true);
    const unchecked = groups.filter((g) => g.needsCheck);
    if (unchecked.length && !confirm(`${unchecked.length === 1 ? `${unchecked[0].name}’s` : `${unchecked.length} families’`} Aug–Sep amounts are still a best guess `
      + '(check them on Reports → Annual statements). Print anyway?')) return;
    if (!state.settings?.receipt_tax_id) toast('Tip: add the school’s tax ID on Settings → Receipts so it prints on statements');
    showSheet(`${groups.length} annual statement${groups.length === 1 ? '' : 's'} · ${year}`, groups.map((g) => statementHtml(g, year)));
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

  function renderTuitionMonthly(el) {
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
    bindMonthBar(el, renderTuitionMonthly);
    [['t-q', 'q', 'input'], ['t-status', 'status', 'change'], ['t-funding', 'funding', 'change']].forEach(([id, k, ev]) =>
      $('#' + id, el).addEventListener(ev, (e) => { f[k] = e.target.value; draw(); }));
    $('#t-add', el)?.addEventListener('click', () => openPayment({ month: m }));
    // Receipts for FES-UA reimbursement: only money the family paid, not payments from Step Up or other programs.
    $('#t-fes', el).addEventListener('click', () => {
      const fes = monthPays.filter((p) => hasFunding(p.student_id, 'fes_ua'));
      const family = fes.filter((p) => p.payer === 'parent');
      const nameOf = (p) => state.students.find((s) => s.id === p.student_id)?.name || '';
      showReceipts(family.sort((a, b) => byLastName(nameOf(a), nameOf(b)) || a.receipt_no - b.receipt_no));
      if (family.length && fes.length > family.length) toast(`${fes.length - family.length} payment(s) from programs left out (only family payments are reimbursed)`);
    });
    $('#t-csv', el).addEventListener('click', () => csvDownload(`creativa-tuition-${m}.csv`,
      ['Student', 'Class', 'Funding', 'Award ID', 'Tuition', 'Frequency', 'Due', 'Paid', 'Balance', 'Status'],
      all.map((r) => {
        const fr = state.finance[r.s.id] || {};
        return [r.s.name, classroomName(r.s.classroom_id), fundingText(r.s.id), fr.award_id,
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
        if (f.funding && !hasFunding(r.s.id, f.funding)) return false;
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

  // ───────────── Tuition, billed every two weeks (007) ─────────────
  function activeInPeriod(s, p) {
    if (s.status === 'waitlist') return false;
    if (s.start_date && s.start_date > periodEnd(p)) return false;
    if (LEFT.has(s.status)) return !!s.withdrawn_on && s.withdrawn_on >= p;
    return true;
  }
  function billRows(p) {
    return state.students.filter((s) => activeInPeriod(s, p)).sort(sortStudents).map((s) => {
      const fr = state.finance[s.id] || {};
      const inv = state.invoices.find((i) => i.student_id === s.id && i.kind === 'tuition' && i.period_start === p && !i.void);
      let status;
      if (inv) status = invoiceStatus(inv);
      else if (hasFunding(s.id, 'stepup_pending')) status = 'stepup';
      else if (fr.bill_family === false) status = 'not_billed';
      else if (fr.tuition_amount == null) status = 'unset';
      else if (Number(fr.tuition_amount) === 0) status = 'none';
      else if (fr.tuition_frequency === 'school_year') status = 'school_year';   // Kindergarten (020): not billed every two weeks
      else status = 'not_invoiced';
      const paid = inv ? invoicePaid(inv) : 0;
      return { s, fr, inv, status, paid, balance: inv ? invoiceBalance(inv) : 0 };
    });
  }
  const periodAmount = (fr) => round2(Number(fr.tuition_amount) * (fr.tuition_frequency === 'weekly' ? 2 : 1));
  // A child who starts in the second week of a period is billed that one week, due their first Monday (019).
  function periodBill(fr, s, p) {
    const amount = periodAmount(fr), wk2 = addDays(p, 7);
    return s.start_date && s.start_date >= wk2 ? { amount: round2(amount / 2), due_date: wk2, note: `Starts ${fmtDate(s.start_date)}: one week` }
      : { amount, due_date: p };
  }

  function renderTuition(el) {
    if (!state.hasV6) return renderTuitionMonthly(el);
    const p = state.period || (state.period = periodOf(todayStr()));
    // Before the first CRM billing Monday the period was billed and paid in the old billing system (010/011): same page,
    // filled in from its Balance Summary sheet, with nothing to bill or collect.
    const before = p < billing().anchor;
    const pre = before ? preRows(p) : null;
    const earliest = state.history.reduce((m, h) => (h.period_start && h.period_start < m ? h.period_start : m), p);
    const f = state.tuitionFilters, edit = canEditFinance();
    const rows = before ? pre.rows.filter((r) => r.s).map(asBillRow) : billRows(p);
    const gone = before ? pre.rows.filter((r) => !r.s) : [];
    const billed = round2(rows.reduce((t, r) => t + (r.inv ? Number(r.inv.amount) : 0), 0));
    const paidP = round2(rows.reduce((t, r) => t + r.paid, 0));
    const owedP = round2(rows.reduce((t, r) => t + r.balance, 0));
    const open = state.invoices.filter((i) => !i.void && invoiceBalance(i) > 0).sort((a, b) => a.due_date.localeCompare(b.due_date));
    const credits = state.payments.filter((x) => !x.invoice_id).sort((a, b) => a.paid_on.localeCompare(b.paid_on));
    const owedAll = round2(open.reduce((t, i) => t + invoiceBalance(i), 0));
    const creditAll = round2(credits.reduce((t, x) => t + Number(x.amount), 0));
    const toBill = rows.filter((r) => r.status === 'not_invoiced').length;
    // Late fee: tuition still not fully paid after the Friday grace day (008).
    const lateAmt = state.hasV7 ? Number(state.settings?.late_fee_amount) || 0 : 0;
    const lateDue = lateAmt ? rows.filter((r) => r.inv && r.balance > 0 && invoiceLate(r.inv)
      && !state.invoices.some((i) => i.late_fee_for === r.inv.id)) : [];   // a waived (voided) fee stays waived
    const periodPays = state.payments.filter((x) => x.paid_on >= p && x.paid_on < addDays(p, billing().days))
      .sort((a, b) => a.paid_on.localeCompare(b.paid_on) || a.receipt_no - b.receipt_no);
    const nameOf = (sid) => state.students.find((s) => s.id === sid)?.name || '';
    const familyOf = (sid) => state.students.find((s) => s.id === sid)?.family_account || '';
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const late = (i) => { const d = daysBetween(i.due_date, todayStr()); return d <= 0 ? 'current' : d <= 30 ? '1–30 days' : d <= 60 ? '31–60 days' : d <= 90 ? '61–90 days' : 'over 90 days'; };
    el.innerHTML = `${weekBoxHtml()}<div class="month-bar"><button class="btn small" id="p-prev" type="button" aria-label="Previous billing period" ${before && p <= earliest ? 'disabled' : ''}>‹</button>
        <b>${esc(fmtPeriod(p))}, ${p.slice(0, 4)}</b>
        <button class="btn small" id="p-next" type="button" aria-label="Next billing period">›</button>
        ${p !== periodOf(todayStr()) ? '<button class="btn small ghost" id="p-now" type="button">This period</button>' : ''}
        <span class="muted small">${before ? `Before the CRM: billed and paid in the billing system${pre.sheet.length ? ` (sheet printed ${esc(fmtDate(pre.sheet[0].as_of))})` : ''}.`
          : `Billed Monday ${esc(fmtDate(p))}, due that day (grace until Friday ${esc(fmtDate(addDays(p, 4)))}).`}</span></div>
      <div class="stats">
        <div class="stat"><b>${money(billed)}</b><span>Billed this period</span></div>
        <div class="stat"><b>${money(paidP)}</b><span>Paid on this period’s invoices</span></div>
        <div class="stat"><b>${money(owedP)}</b><span>Still owed this period</span></div>
        <div class="stat"><b>${money(round2(owedAll - creditAll))}</b><span>Owed, all periods (less ${money(creditAll)} credits)</span></div>
      </div>
      <div class="toolbar">
        <input type="search" id="t-q" placeholder="Search student or family…" value="${esc(f.q)}">
        <select id="t-status">${opt('', 'Everyone', f.status)}${opt('owing', 'Owes money', f.status)}${opt('paid', 'Paid', f.status)}${opt('not_invoiced', 'Not billed yet', f.status)}${opt('stepup', 'Step Up pending', f.status)}${opt('unset', 'No rate set', f.status)}${before ? opt('check', 'Check amount', f.status) + opt('missing', 'Not on the sheet', f.status) : ''}</select>
        <select id="t-funding">${opt('', 'Any funding', f.funding)}${Object.entries(FUNDING).map(([k, v]) => opt(k, v, f.funding)).join('')}</select>
        <span class="spacer"></span>
        ${edit && toBill ? `<button class="btn small primary" id="t-bill" type="button">Bill this period (${toBill})</button>` : ''}
        ${edit && lateDue.length ? `<button class="btn small" id="t-late" type="button">Add ${money(lateAmt)} late fees (${lateDue.length})</button>` : ''}
        <button class="btn small" id="t-fes" type="button">Print FES-UA receipts</button>
        <button class="btn small" id="t-csv" type="button">Download CSV</button>
        ${edit ? '<button class="btn small" id="t-add" type="button">+ Record payment</button>' : ''}
      </div>
      <div class="table-wrap"><table class="tuition"><thead><tr>
        <th>Student</th><th>Funding</th><th class="num">Rate</th><th class="num">Billed</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th>${edit ? '<th></th>' : ''}
      </tr></thead><tbody id="t-rows"></tbody></table></div>
      <p class="muted small">${before ? `${pre.sheet.length ? 'Billed and paid in the billing system before the CRM: amounts come from the family’s line on its Balance Summary,'
          + ' and brothers and sisters billed together share one amount. “Check amount” means the family carried a balance or had a credit; confirm it on'
          + ' Reports → Annual statements.' : 'There’s no billing system sheet for this period in the CRM.'} Step Up (pending) children aren’t billed and aren’t late.`
        : `Each child is billed their biweekly rate on the billing Monday. Step Up (pending) children aren’t billed and
        aren’t late. Set the rate, billing item and funding on each child’s page.${lateAmt ? ` Tuition not paid by Friday gets a
        ${money(lateAmt)} late fee once you tap “Add late fees”. Added one by mistake? Tap “take off” next to it.` : ''}`}</p>
      ${gone.length ? `<section class="panel"><h2>On the sheet but not in the CRM <span class="muted small">${gone.length}</span></h2>
        <div class="table-wrap flat"><table><thead><tr><th>Family</th><th class="num">Billed</th><th class="num">Paid</th><th>Status</th></tr></thead>
        <tbody id="t-gone">${gone.map((r) => { const st = r.status === 'check' ? 'check' : r.sh.amount ? 'paid' : 'none';
          return `<tr><td><b>${esc(r.sh.h.customer)}</b></td><td class="num">${r.sh.amount ? money(r.sh.amount) : ''}</td>
          <td class="num">${r.sh.amount ? money(r.sh.amount) : ''}</td><td><span class="pay-pill ps-${st}">${INV_STATUS[st]}</span></td></tr>`; }).join('')}</tbody></table></div>
      </section>` : ''}
      <section class="panel"><h2>Owed from all periods <span class="muted small">${money(owedAll)}</span></h2>
        <div class="table-wrap flat"><table><thead><tr><th>Family</th><th>Student</th><th>For</th><th>Due</th><th class="num">Balance</th><th>Late</th>${edit ? '<th></th>' : ''}</tr></thead>
        <tbody id="t-open">${open.map((i) => `<tr data-inv="${i.id}" data-sid="${i.student_id}"><td>${esc(familyOf(i.student_id))}</td><td>${esc(nameOf(i.student_id))}</td>
          <td>${esc(invoiceLabel(i))}</td><td>${esc(fmtDate(i.due_date))}</td><td class="num">${money(invoiceBalance(i))}</td>
          <td>${i.late_fee_for ? '<span class="pay-pill ps-overdue">Late fee</span>' : hasFunding(i.student_id, 'stepup_pending') ? '<span class="pay-pill ps-stepup">Step Up pending</span>' : `<span class="pay-pill ${late(i) === 'current' ? 'ps-open' : 'ps-overdue'}">${late(i)}</span>`}</td>
          ${edit ? `<td>${i.late_fee_for ? `<button class="btn small ghost" type="button" data-waive="${i.id}">Take off</button>` : ''}</td>` : ''}</tr>`).join('')
          || `<tr><td colspan="${edit ? 7 : 6}" class="muted">Nobody owes anything.</td></tr>`}</tbody></table></div>
      </section>
      <section class="panel"><h2>Credits: money not applied to an invoice <span class="muted small">${money(creditAll)}</span></h2>
        <div class="table-wrap flat"><table><thead><tr><th>Received</th><th>Student</th><th>Method</th><th class="num">Amount</th><th>Note</th>${edit ? '<th></th>' : ''}</tr></thead>
        <tbody id="t-credits">${credits.map((x) => `<tr data-pay="${x.id}"><td>${esc(fmtDate(x.paid_on))}</td><td>${esc(nameOf(x.student_id))}</td>
          <td>${esc(METHOD[x.method])}</td><td class="num">${money(x.amount)}</td><td class="small">${esc(x.note || '')}</td>
          ${edit ? `<td>${openInvoices(x.student_id).length ? `<button class="btn small" type="button" data-apply="${x.id}">Apply</button>` : ''}</td>` : ''}</tr>`).join('')
          || `<tr><td colspan="${edit ? 6 : 5}" class="muted">No credits.</td></tr>`}</tbody></table></div>
      </section>
      <section class="panel"><h2>Payments received ${esc(fmtPeriod(p))}</h2>
        <div class="table-wrap flat"><table><thead><tr><th>Received</th><th>Student</th><th>For</th><th>Method</th><th class="num">Amount</th><th>Receipt</th></tr></thead>
        <tbody id="t-pays">${periodPays.map((x) => `<tr data-pay="${x.id}"><td>${esc(fmtDate(x.paid_on))}</td><td>${esc(nameOf(x.student_id))}</td>
          <td>${esc(paymentFor(x))}</td><td>${esc(METHOD[x.method])}${x.reference ? ` <span class="muted small">${esc(x.reference)}</span>` : ''}</td>
          <td class="num">${money(x.amount)}</td><td><button class="btn ghost small" type="button" data-receipt="${x.id}">#${x.receipt_no}</button></td></tr>`).join('')
          || `<tr><td colspan="6" class="muted">${before ? 'Payments for this period were made in the billing system.' : 'No payments received in this period yet.'}</td></tr>`}</tbody></table></div>
      </section>`;

    const go = (np) => { state.period = np; renderTuition(el); };
    $('#p-prev', el).addEventListener('click', () => go(addDays(p, -billing().days)));
    $('#p-next', el).addEventListener('click', () => go(addDays(p, billing().days)));
    $('#p-now', el)?.addEventListener('click', () => go(periodOf(todayStr())));
    [['t-q', 'q', 'input'], ['t-status', 'status', 'change'], ['t-funding', 'funding', 'change']].forEach(([id, k, ev]) =>
      $('#' + id, el).addEventListener(ev, (e) => { f[k] = e.target.value; draw(); }));
    $('#t-add', el)?.addEventListener('click', () => openPayment({}));
    $('#t-bill', el)?.addEventListener('click', async () => {
      if (!confirm(`Bill ${toBill} ${toBill === 1 ? 'child' : 'children'} for ${fmtPeriod(p)}? Each gets an invoice for their biweekly rate, dated ${fmtDate(p)}.`)) return;
      const { data, error } = await sb.rpc('create_period_invoices', { p_period: p });
      if (error) return fail(error, 'Could not create the invoices');
      const r = await selectAll('invoices', 'invoice_date', false);
      if (!r.error) state.invoices = r.data;
      toast(`${data} invoice${data === 1 ? '' : 's'} created for ${fmtPeriod(p)}`);
      renderTuition(el);
    });
    $('#t-late', el)?.addEventListener('click', async () => {
      const n = lateDue.length;
      if (!confirm(`Add a ${money(lateAmt)} late fee for ${n} ${n === 1 ? 'child' : 'children'} whose tuition for ${fmtPeriod(p)} wasn’t paid by Friday ${fmtDate(addDays(p, 4))}?`)) return;
      const { data, error } = await sb.rpc('create_late_fees', { p_period: p });
      if (error) return fail(error, 'Could not add the late fees');
      const r = await selectAll('invoices', 'invoice_date', false);
      if (!r.error) state.invoices = r.data;
      toast(`${data} late fee${data === 1 ? '' : 's'} added`);
      renderTuition(el);
    });
    $$('[data-waive]', el).forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      removeLateFee(b.dataset.waive, () => renderTuition(el));
    }));
    if (before) {
      // Old periods: one receipt per FES-UA child for what the family paid through the billing system.
      $('#t-fes', el).addEventListener('click', () => {
        const fesRows = rows.filter((r) => hasFunding(r.s.id, 'fes_ua'));
        const list = fesRows.filter((r) => r.inv).map((r) => ({ old: p, student_id: r.s.id, covers_month: p.slice(0, 8) + '01', paid_on: todayStr(),
          payer: 'parent', amount: r.inv.amount, note: r.pre?.h?.needs_check ? '' : null }))
          .sort((a, b) => byLastName(nameOf(a.student_id), nameOf(b.student_id)));
        showReceipts(list);
        const shared = fesRows.filter((r) => !r.inv && r.pre?.with).length;
        if (shared) toast(`${shared} FES-UA child${shared === 1 ? '’s' : 'ren’s'} amount is combined with a brother or sister’s; it’s on their receipt`);
      });
    }
    if (!before) $('#t-fes', el).addEventListener('click', () => {
      const fes = periodPays.filter((x) => hasFunding(x.student_id, 'fes_ua'));
      const family = fes.filter((x) => x.payer === 'parent');
      showReceipts(family.sort((a, b) => byLastName(nameOf(a.student_id), nameOf(b.student_id)) || a.receipt_no - b.receipt_no));
      if (family.length && fes.length > family.length) toast(`${fes.length - family.length} payment(s) from programs left out (only family payments are reimbursed)`);
    });
    $('#t-csv', el).addEventListener('click', () => csvDownload(`creativa-billing-${p}.csv`,
      ['Student', 'Family account', 'Class', 'Funding', 'Award ID', 'Rate', 'Billing item', 'Billed', 'Paid', 'Balance', 'Status'],
      rows.map((r) => [r.s.name, r.s.family_account, classroomName(r.s.classroom_id), fundingText(r.s.id), r.fr.award_id,
        r.fr.tuition_amount, r.fr.billing_program, r.inv ? r.inv.amount : '', r.paid || '', r.balance || '', INV_STATUS[r.status]])));
    $$('[data-receipt]', el).forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      showReceipts(state.payments.filter((x) => x.id === b.dataset.receipt));
    }));
    $$('#t-open tr[data-inv]', el).forEach((tr) => tr.addEventListener('click', () => {
      if (edit) openPayment({ studentId: tr.dataset.sid, invoiceId: tr.dataset.inv }); else openStudent(tr.dataset.sid);
    }));
    $$('[data-apply]', el).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openPayment({ paymentId: b.dataset.apply }); }));
    if (edit) $$('#t-pays tr[data-pay], #t-credits tr[data-pay]', el).forEach((tr) => tr.addEventListener('click', () => openPayment({ paymentId: tr.dataset.pay })));
    draw();

    function draw() {
      const q = f.q.trim().toLowerCase();
      const shown = rows.filter((r) => {
        if (f.status === 'owing' && !(r.balance > 0)) return false;
        if (f.status && f.status !== 'owing' && r.status !== f.status) return false;
        if (f.funding && !hasFunding(r.s.id, f.funding)) return false;
        if (q && !`${r.s.name} ${r.s.parent_name || ''} ${r.s.family_account || ''}`.toLowerCase().includes(q)) return false;
        return true;
      });
      $('#t-rows', el).innerHTML = shown.map((r) => `<tr data-id="${r.s.id}">
          <td><b>${esc(r.s.name)}</b><div class="muted small">${esc([classroomName(r.s.classroom_id), r.s.family_account].filter(Boolean).join(' · '))}</div></td>
          <td>${fundingTags(r.s.id)}</td>
          <td class="num">${r.fr.tuition_amount != null ? `${money(r.fr.tuition_amount)}<div class="muted small">${FREQ[r.fr.tuition_frequency] || ''}</div>` : ''}</td>
          <td class="num">${r.inv ? money(r.inv.amount) : r.pre?.with ? `<span class="muted small">with ${esc(r.pre.with.split(' ')[0])}</span>` : ''}
            ${r.pre?.family ? `<div class="muted small">${esc(r.pre.family.join(' & '))}</div>` : ''}</td>
          <td class="num">${r.paid ? money(r.paid) : ''}</td>
          <td class="num">${r.balance ? money(r.balance) : ''}</td>
          <td><span class="pay-pill ps-${r.status}">${INV_STATUS[r.status]}</span>${!r.pre && r.inv && lateFeeOf(r.inv)
            ? `<div class="muted small">+ ${money(lateFeeOf(r.inv).amount)} late fee${invoiceBalance(lateFeeOf(r.inv)) ? '' : ' (paid)'}
              ${edit ? `<button class="btn ghost small link-x" type="button" data-rm-fee="${lateFeeOf(r.inv).id}">take off</button>` : ''}</div>` : ''}
            ${r.pre?.h && r.pre.amount != null && round2(r.pre.h.balance) !== round2(r.pre.amount) ? `<div class="muted small">sheet ${money(r.pre.h.balance)}</div>` : ''}
            ${r.pre?.h?.note ? `<div class="muted small">${esc(r.pre.h.note)}</div>` : ''}</td>
          ${edit ? `<td>${r.pre ? '' : r.inv && r.balance > 0 ? `<button class="btn small" type="button" data-pay-inv="${r.inv.id}">Record payment</button>`
            : r.status === 'not_invoiced' ? `<button class="btn small" type="button" data-bill-one="${r.s.id}">Bill ${money(periodBill(r.fr, r.s, p).amount)}</button>`
              : r.inv ? `<button class="btn small" type="button" data-pay-for="${r.s.id}">+ Payment</button>` : ''}</td>` : ''}</tr>`).join('')
        || `<tr><td colspan="${edit ? 8 : 7}" class="muted">Nobody matches.</td></tr>`;
      $$('#t-rows tr[data-id]', el).forEach((tr) => tr.addEventListener('click', async (e) => {
        const payInv = e.target.closest('[data-pay-inv]'), one = e.target.closest('[data-bill-one]'), payFor = e.target.closest('[data-pay-for]');
        const rmFee = e.target.closest('[data-rm-fee]');
        if (rmFee) return removeLateFee(rmFee.dataset.rmFee, () => renderTuition(el));
        if (payInv) return openPayment({ studentId: tr.dataset.id, invoiceId: payInv.dataset.payInv });
        if (payFor) return openPayment({ studentId: tr.dataset.id });
        if (one) {
          const r = rows.find((x) => x.s.id === tr.dataset.id);
          one.disabled = true;
          const { data, error } = await sb.from('invoices').insert({ student_id: r.s.id, kind: 'tuition', description: r.fr.billing_program || 'Tuition',
            period_start: p, invoice_date: p, ...periodBill(r.fr, r.s, p), created_by: state.me.id }).select().single();
          if (error) { one.disabled = false; return fail(error, 'Could not create the invoice'); }
          state.invoices.push(data);
          toast(`${r.s.name} billed ${money(data.amount)}`);
          return renderTuition(el);
        }
        openStudent(tr.dataset.id);
      }));
    }
  }

  // A billing period before the CRM's first billing Monday was billed and paid in the old billing system. Show it like a
  // CRM period, one row per child with class and funding, using its Balance Summary sheet (010/011): what each family
  // was billed (and paid) for it. Nothing to bill or record here.
  const earlierPaid = (h) => (h.paid != null ? Number(h.paid) : Math.max(Number(h.balance), 0));
  function preRows(p) {
    const sheet = state.history.filter((h) => h.period_start === p);
    const kids = state.students.filter((s) => activeInPeriod(s, p)).sort(sortStudents);
    const share = new Map();
    const used = new Set();
    for (const h of sheet) {
      const k = histKey(h.family_account || h.customer);
      const sibs = kids.filter((s) => histKey(s.family_account) === k);
      if (!sibs.length) continue;
      used.add(h.id);
      const amt = earlierPaid(h);
      const rates = sibs.map((s) => (state.finance[s.id]?.tuition_amount != null ? periodAmount(state.finance[s.id]) : null));
      if (sibs.length > 1 && rates.every((r) => r != null) && round2(rates.reduce((t, r) => t + r, 0)) === round2(amt)) {
        sibs.forEach((s, i) => share.set(s.id, { h, amount: rates[i] }));
      } else {
        share.set(sibs[0].id, { h, amount: amt, family: sibs.length > 1 ? sibs.map((x) => x.name.split(' ')[0]) : null });
        sibs.slice(1).forEach((s) => share.set(s.id, { h, amount: null, with: sibs[0].name }));
      }
    }
    const rows = kids.map((s) => {
      const fr = state.finance[s.id] || {};
      const sh = share.get(s.id);
      let status;
      if (sh?.h.needs_check) status = 'check';
      else if (sh && sh.amount == null) status = 'paid';
      else if (sh && sh.amount > 0) status = 'paid';
      else if (sh && Number(sh.h.balance) < 0) status = 'credit';
      else if (hasFunding(s.id, 'stepup_pending')) status = 'stepup';
      else if (fr.bill_family === false) status = 'not_billed';
      else if (sh) status = 'none';
      else status = 'missing';
      return { s, fr, sh, status };
    });
    // Families on the sheet who aren't in the CRM any more.
    sheet.filter((h) => !used.has(h.id)).forEach((h) => rows.push({ s: null, fr: {}, sh: { h, amount: earlierPaid(h) }, status: earlierPaid(h) > 0 ? (h.needs_check ? 'check' : 'paid') : 'none' }));
    return { rows, sheet };
  }
  // An old period's child row, shaped like billRows() so the page is the same as any CRM period.
  function asBillRow(r) {
    const amt = r.sh?.amount;
    return { s: r.s, fr: r.fr, pre: r.sh || {}, inv: amt > 0 ? { amount: amt } : null, paid: amt > 0 ? amt : 0, balance: 0,
      status: r.status === 'credit' ? 'paid' : r.status };
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
    // With billing (007): what was actually invoiced in the month and what is still open on it.
    const monthInvoices = (mo) => state.invoices.filter((i) => !i.void && i.invoice_date >= monthStart(mo) && i.invoice_date <= monthEnd(mo));
    const expectedFor = (mo) => (state.hasV6 ? round2(monthInvoices(mo).reduce((t, i) => t + Number(i.amount), 0))
      : round2(tuitionRows(mo).reduce((t, r) => t + (r.due || 0), 0)));
    const owedFor = (mo) => (state.hasV6 ? round2(monthInvoices(mo).reduce((t, i) => t + invoiceBalance(i), 0))
      : round2(tuitionRows(mo).reduce((t, r) => t + Math.max(r.balance, 0), 0)));
    const owed = owedFor(m);
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
        <div class="stat"><b>${money(expectedFor(m))}</b><span>${state.hasV6 ? 'Billed in the month' : 'Tuition due for the month'}</span></div>
        <div class="stat"><b>${money(owed)}</b><span>Still owed for the month</span></div>
      </div>
      <div class="today-grid">
        <section class="panel"><h2>By who paid</h2><table class="mini"><tbody>${table(byPayer)}</tbody></table></section>
        <section class="panel"><h2>By method</h2><table class="mini"><tbody>${table(byMethod)}</tbody></table></section>
        <section class="panel"><h2>By class</h2><table class="mini"><tbody>${table(byClass)}</tbody></table></section>
      </div>
      <section class="panel" id="who-paid"><h2>Who paid how · ${esc(fmtMonth(m))}</h2>
        <div class="method-grid">${Object.keys(METHOD).filter((k) => ['cash', 'zelle', 'card'].includes(k) || pays.some((p) => p.method === k)).map((k) => {
          const list = pays.filter((p) => p.method === k).sort((a, b) => a.paid_on.localeCompare(b.paid_on) || a.receipt_no - b.receipt_no);
          return `<div class="method-col" data-method="${k}"><h3>${esc(METHOD[k])} <span class="muted small">${money(list.reduce((t, p) => t + Number(p.amount), 0))} · ${list.length}</span></h3>
            <ul class="plain">${list.map((p) => {
              const s = state.students.find((x) => x.id === p.student_id) || {};
              return `<li><span>${esc(s.name || '')}${p.payer !== 'parent' ? ` <span class="muted small">(${esc(PAYER[p.payer])})</span>` : ''}</span>
                <span class="muted small">${esc(fmtDate(p.paid_on))} · #${esc(p.receipt_no)}</span><b>${money(p.amount)}</b></li>`;
            }).join('') || '<li class="muted small">None</li>'}</ul></div>`;
        }).join('')}</div></section>
      <section class="panel report-year"><h2>School year ${startYear}–${String(startYear + 1).slice(2)}</h2>
        <div class="table-wrap flat"><table><thead><tr><th>Month</th><th class="num">Received</th><th class="num">${state.hasV6 ? 'Billed' : 'Tuition due'}</th><th class="num">${state.hasV6 ? 'Still owed' : 'Paid toward month'}</th></tr></thead>
        <tbody>${year.map((ym) => {
          const rec = round2(state.payments.filter((p) => inMonth(p, ym)).reduce((t, p) => t + Number(p.amount), 0));
          const toward = state.hasV6 ? owedFor(ym) : round2(state.payments.filter((p) => p.covers_month === monthStart(ym)).reduce((t, p) => t + Number(p.amount), 0));
          return `<tr class="${ym === m ? 'cur' : ''}" data-month="${ym}"><td>${esc(fmtMonth(ym))}</td><td class="num">${rec ? money(rec) : '—'}</td>
            <td class="num">${money(expectedFor(ym))}</td><td class="num">${toward ? money(toward) : '—'}</td></tr>`;
        }).join('')}</tbody>
        <tfoot><tr><th>Total</th><th class="num">${money(state.payments.filter((p) => p.paid_on >= monthStart(year[0]) && p.paid_on <= monthEnd(year[11])).reduce((t, p) => t + Number(p.amount), 0))}</th><th></th><th></th></tr></tfoot>
        </table></div>
        <p class="muted small">${state.hasV6 ? '“Received” counts payments by the date they came in; “Billed” the invoices dated in the month, and “Still owed” what is unpaid on them.'
          : '“Received” counts payments by the date they came in; “Paid toward month” by the month they pay for.'}</p>
      </section>
      <section class="panel"><h2>Funding</h2>
        <p class="muted small">Enrolled students by funding program; everyone on no program is private pay. Set funding on each student’s page.</p>
        ${Object.entries(FUNDING).map(([k, label]) => {
          const list = enrolled.filter((s) => hasFunding(s.id, k));
          return `<details class="fund-group"><summary><b>${esc(label)}</b> <span class="muted">${list.length}</span></summary>
            <ul>${list.map((s) => `<li><a href="#" data-student="${s.id}">${esc(s.name)}</a> <span class="muted small">${esc(classroomName(s.classroom_id))}${state.finance[s.id]?.award_id ? ' · ID ' + esc(state.finance[s.id].award_id) : ''}</span></li>`).join('') || '<li class="muted">None</li>'}</ul></details>`;
        }).join('')}
      </section>
      ${stmtPanel()}
      ${historyPanel()}
      <div class="toolbar"><span class="spacer"></span><button class="btn small" id="rp-csv" type="button">Download ${esc(fmtMonth(m))} payments (CSV)</button></div>`;
    bindStmtPanel(el);
    bindHistoryPanel(el);
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

  // ───────────── Payroll ─────────────
  // Staff clock in and out on the time clock page (/clock/) on the front-desk tablet. Here the office
  // checks each pay period, fixes mistakes, and copies everyone's regular and overtime hours into
  // Patriot Software, which runs payroll and the paystubs.
  const empName = (e) => [e.first_name, e.last_name].filter(Boolean).join(' ');
  const empLastFirst = (e) => (e.last_name ? `${e.last_name}, ${e.first_name}` : e.first_name);
  const empSort = (a, b) => (a.last_name || a.first_name).localeCompare(b.last_name || b.first_name) || a.first_name.localeCompare(b.first_name);
  const hrs = (min) => (Math.round((Number(min) || 0) / 60 * 100) / 100).toFixed(2);   // decimal hours, as Patriot takes them
  const hm = (min) => { const m = Math.round(Number(min) || 0); return `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
  const nyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function nyParts(when) {   // the school's date (YYYY-MM-DD) and time (HH:MM) at a moment
    const p = Object.fromEntries(nyFmt.formatToParts(new Date(when)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
  }
  function nyIso(date, time) {   // a date and time at the school → ISO timestamp
    const want = Date.parse(`${date}T${time}:00Z`);
    let t = want;
    for (let i = 0; i < 2; i++) { const p = nyParts(t); t += want - Date.parse(`${p.date}T${p.time}:00Z`); }
    return new Date(t).toISOString();
  }
  const nyToday = () => nyParts(Date.now()).date;
  const clockTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const dayLabel = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const weekdayName = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });

  const paySched = () => ({ freq: state.settings?.payroll_frequency || 'biweekly', anchor: state.settings?.payroll_anchor || '2026-10-02' });
  function payPeriodOf(day, sched = paySched()) {   // same rules as payroll_period() in the database
    const { freq, anchor } = sched;
    if (freq === 'weekly' || freq === 'biweekly') {
      const n = freq === 'weekly' ? 7 : 14;
      const start = addDays(anchor, Math.floor(daysBetween(anchor, day) / n) * n);
      return { start, end: addDays(start, n - 1) };
    }
    const ym = day.slice(0, 7);
    if (freq === 'semimonthly') return Number(day.slice(8)) > 15 ? { start: ym + '-16', end: monthEnd(ym) } : { start: ym + '-01', end: ym + '-15' };
    return { start: ym + '-01', end: monthEnd(ym) };
  }
  const fmtPayPeriod = (pp) => `${fmtDate(pp.start)} – ${fmtDate(pp.end)}`;
  const longPayPeriod = (pp) => `${new Date(pp.start + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${longDate(pp.end)}`;
  function weekStartOf(day) {
    const a = new Date(paySched().anchor + 'T00:00:00').getDay(), d = new Date(day + 'T00:00:00').getDay();
    return addDays(day, -((d - a + 7) % 7));
  }
  const STALE_MS = 16 * 3600e3;   // a stretch open longer than this is a missed clock-out
  const isStale = (x) => !x.clock_out && Date.now() - new Date(x.clock_in) > STALE_MS;

  async function loadPayroll(pp) {
    const entries = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('time_entries').select('*').gte('work_date', pp.start).lte('work_date', pp.end)
        .order('clock_in').order('id').range(from, from + 999);
      if (error) { fail(error, 'Could not load the time clock'); return false; }
      entries.push(...data);
      if (data.length < 1000) break;
    }
    const [emp, open, hours, closed, devices, pins] = await Promise.all([
      sb.from('employees').select('*').order('first_name'),
      sb.from('time_entries').select('*').is('clock_out', null).order('clock_in'),
      sb.rpc('payroll_hours', { p_start: pp.start, p_end: pp.end }),
      sb.from('payroll_periods').select('*').order('period_start', { ascending: false }),
      sb.from('timeclock_devices').select('id, name, created_at, last_seen_at').order('created_at'),
      sb.rpc('payroll_pins'),   // missing until 022
    ]);
    for (const [r, what] of [[emp, 'staff'], [open, 'the time clock'], [hours, 'hours'], [closed, 'pay periods'], [devices, 'time clocks']]) {
      if (r.error) { fail(r.error, `Could not load ${what}`); return false; }
    }
    state.pay = { pp, entries, employees: emp.data, open: open.data, hours: hours.data, closed: closed.data, devices: devices.data,
      pins: pins.error ? null : Object.fromEntries(pins.data.map((x) => [x.employee_id, x.pin])) };
    return true;
  }
  const closedFor = (pp) => state.pay.closed.find((c) => c.period_start <= pp.end && c.period_end >= pp.start) || null;

  // Minutes per person for the period (regular / overtime split by the database, per workweek).
  function payTotals() {
    const by = {};
    for (const h of state.pay.hours) {
      const t = by[h.employee_id] || (by[h.employee_id] = { minutes: 0, regular: 0, overtime: 0, open: 0 });
      t.minutes += Number(h.minutes); t.regular += Number(h.regular); t.overtime += Number(h.overtime); t.open += h.open_entries;
    }
    return by;
  }
  const ZERO = { minutes: 0, regular: 0, overtime: 0, open: 0 };
  const grossOf = (e, t) => round2((Number(e.pay_rate) || 0) * (Number(hrs(t.regular)) + 1.5 * Number(hrs(t.overtime))));
  // Things to look at before sending hours to Patriot.
  function payChecks(e) {
    const mine = state.pay.entries.filter((x) => x.employee_id === e.id);
    const out = [];
    const missed = state.pay.open.filter((x) => x.employee_id === e.id && isStale(x) && x.work_date >= state.pay.pp.start && x.work_date <= state.pay.pp.end);
    if (missed.length) out.push(['warn', `${missed.length} missing clock-out${missed.length === 1 ? '' : 's'}`]);
    if (e.lunch_minutes > 0) {
      const days = {};
      mine.filter((x) => x.clock_out).forEach((x) => { (days[x.work_date] = days[x.work_date] || []).push(x); });
      const noLunch = Object.values(days).filter((list) => list.length === 1
        && (new Date(list[0].clock_out) - new Date(list[0].clock_in)) / 60000 > 6 * 60).length;
      if (noLunch) out.push(['info', `no lunch clocked on ${noLunch} day${noLunch === 1 ? '' : 's'}`]);
    }
    const edited = mine.filter((x) => x.edited_at || x.source === 'office').length;
    if (edited) out.push(['info', `${edited} changed or added by the office`]);
    return out;
  }

  function renderPayroll(el) {
    if (!state.payPeriod) state.payPeriod = payPeriodOf(nyToday());
    const tab = ['hours', 'paid', 'people', 'setup'].includes(state.payTab) ? state.payTab : 'hours';
    el.innerHTML = `<div class="seg" role="tablist" aria-label="Payroll">${[['hours', 'Hours'], ['paid', 'Paychecks'], ['people', 'Staff & PINs'], ['setup', 'Time clock']]
        .map(([k, v]) => `<button type="button" role="tab" data-ptab="${k}" aria-selected="${tab === k}">${v}</button>`).join('')}</div>
      <div id="pay-body"><p class="muted">Loading…</p></div>`;
    $$('[data-ptab]', el).forEach((b) => b.addEventListener('click', () => {
      state.payTab = b.dataset.ptab;
      store.set('payTab', state.payTab);
      renderPayroll(el);
    }));
    const pp = state.payPeriod;
    return loadPayroll(pp).then((loaded) => {
      const body = $('#pay-body', el);
      if (!loaded || !body || state.view !== 'payroll' || state.payPeriod !== pp) return;
      ({ hours: drawPayHours, paid: drawPayPaid, people: drawPayPeople, setup: drawPaySetup })[tab](body, el);
    });
  }
  const reloadPayroll = () => renderPayroll($('#view'));

  // How to do payroll, step by step: on the Hours tab (open until closed once) and as a printable page.
  const payGuideSteps = () => `<ol class="pay-steps">
      <li><b>Check the hours.</b> On <b>Payroll → Hours</b>, use ‹ › to pick the pay period that just ended (two weeks, Friday to Thursday).
        Fix any <i>Missing clock-outs</i> (tap <b>Fix</b>). Tap a name to see their timesheet, and use <b>+ Add time</b> for anyone who forgot to clock in.</li>
      <li><b>Get the hours for Patriot.</b> Tap <b>Hours for Patriot</b>: everyone’s regular and overtime hours, by last name like Patriot. Print it or keep it open.</li>
      <li><b>Run payroll in Patriot.</b> Sign in to Patriot Software, open <b>Payroll → Run Payroll</b> and pick the pay date.
        <ul><li><i>Step 1:</i> type each person’s <b>Regular</b> and <b>Overtime</b> hours from the sheet.</li>
          <li><i>Step 2:</i> check the totals (<b>View Details</b> shows taxes and deductions), then <b>Approve</b>.</li>
          <li><i>Step 3:</i> print the <b>pay stubs</b> (plain paper is fine) or the <b>paychecks</b> (on check paper), or save them to print later.</li></ul></li>
      <li><b>Mark it as done in the CRM.</b> Back on <b>Payroll → Hours</b>, tap <b>Mark as entered in Patriot</b>. That locks the pay period’s time
        so it can’t change by accident (<b>Reopen</b> undoes it).</li>
      <li><b>Keep a copy of the paychecks in the CRM.</b> In Patriot, open <b>Payroll → Print Payrolls</b> and tap <b>View Details</b> on that payroll.
        Select from the pay date down to the <b>Totals</b> line and copy it. In the CRM, open <b>Payroll → Paychecks → Add a payroll from Patriot</b>,
        paste, and tap <b>Save</b>.</li>
    </ol>
    <p class="small"><b>To reprint a pay stub later:</b> in Patriot, <b>Payroll → Print Payrolls → View Details</b>, tick the person and print
      (or <b>Reprint All Paychecks</b>). Staff can also see and print their own pay stubs in Patriot’s employee portal, if it’s turned on in Patriot.</p>`;
  function showPayGuide() {
    const sheet = document.createElement('div');
    sheet.className = 'print-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.innerHTML = `<div class="print-bar no-print"><b>How to do payroll</b><span class="spacer"></span>
        <button class="btn primary" type="button" id="pg-print">Print / Save as PDF</button>
        <button class="btn" type="button" id="pg-close">Close</button></div>
      <article class="receipt pay-sheet pay-guide-sheet">
        <header class="r-band"><img src="/assets/logo.png" alt="${esc(state.settings?.school_name || 'Creativa Academy')}">
          <div class="r-title"><h1>How to do payroll</h1><span class="r-year">Every pay period, step by step</span></div></header>
        ${payGuideSteps()}</article>`;
    document.body.append(sheet);
    document.body.classList.add('printing');
    const close = () => { sheet.remove(); document.body.classList.remove('printing'); };
    $('#pg-print', sheet).addEventListener('click', () => window.print());
    $('#pg-close', sheet).addEventListener('click', close);
    sheet.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
    $('#pg-close', sheet).focus();
  }

  function drawPayHours(body, el) {
    const P = state.pay, pp = P.pp, T = payTotals(), closed = closedFor(pp);
    const people = P.employees.filter((e) => e.active || (T[e.id]?.minutes || T[e.id]?.open)).sort(empSort);
    const sum = (k) => people.reduce((t, e) => t + (T[e.id]?.[k] || 0), 0);
    const gross = round2(people.reduce((t, e) => t + grossOf(e, T[e.id] || ZERO), 0));
    const nameOf = (id) => { const e = P.employees.find((x) => x.id === id); return e ? empName(e) : ''; };
    const here = P.open.filter((x) => !isStale(x));
    const lastOut = {};
    P.entries.filter((x) => x.clock_out).forEach((x) => { if (!lastOut[x.employee_id] || x.clock_out > lastOut[x.employee_id].clock_out) lastOut[x.employee_id] = x; });
    const atLunch = Object.values(lastOut).filter((x) => x.out_reason === 'lunch' && Date.now() - new Date(x.clock_out) < 3 * 3600e3
      && !P.open.some((o) => o.employee_id === x.employee_id && o.clock_in > x.clock_out));
    const missed = P.open.filter(isStale);
    const thisPeriod = pp.start === payPeriodOf(nyToday()).start;
    body.innerHTML = `<div class="month-bar"><button class="btn small" id="pp-prev" type="button" aria-label="Previous pay period">‹</button>
        <b>${esc(fmtPayPeriod(pp))}, ${pp.end.slice(0, 4)}</b>
        <button class="btn small" id="pp-next" type="button" aria-label="Next pay period">›</button>
        ${thisPeriod ? '' : '<button class="btn small ghost" id="pp-now" type="button">This pay period</button>'}
        <span class="muted small">Pay period · ${esc(PAY_FREQ[paySched().freq].toLowerCase())}</span>
        ${closed ? `<span class="pay-pill ps-paid">Entered in Patriot ${esc(fmtDate(closed.closed_at))}${closed.closed_by ? ' · ' + esc(staffName(closed.closed_by)) : ''}</span>` : ''}</div>
      <details class="panel pay-guide" id="pay-guide" ${store.get('payGuideOpen', true) ? 'open' : ''}>
        <summary><b>How to do payroll, step by step</b> <span class="muted small">hours, Patriot, pay stubs</span></summary>
        ${payGuideSteps()}
        <button class="btn small" type="button" id="pay-guide-print">Print these steps</button></details>
      <div class="stats">
        <div class="stat"><b>${hrs(sum('minutes'))}</b><span>Hours worked</span></div>
        <div class="stat"><b>${hrs(sum('overtime'))}</b><span>Overtime hours</span></div>
        <div class="stat"><b>${money(gross)}</b><span>Estimated gross pay</span></div>
        <div class="stat"><b>${people.filter((e) => (T[e.id]?.minutes || 0) > 0).length}</b><span>People who worked</span></div>
      </div>
      ${missed.length ? `<section class="panel warn-panel" id="pp-missed"><h2>Missing clock-outs <span class="muted small">${missed.length}</span></h2>
        <p class="muted small">These people clocked in and never clocked out. Put in the time they left so their hours count.</p>
        <ul class="plain">${missed.map((x) => `<li><b>${esc(nameOf(x.employee_id))}</b> clocked in ${esc(dayLabel(x.work_date))} at ${esc(clockTime(x.clock_in))}
          <button class="btn small" type="button" data-fix="${x.id}">Fix</button></li>`).join('')}</ul></section>` : ''}
      ${thisPeriod ? `<section class="panel here-now"><h2>At work now <span class="muted small">${here.length}</span></h2>
        <div class="chips">${here.map((x) => `<span class="chip in">${esc(nameOf(x.employee_id))} <span class="muted">since ${esc(clockTime(x.clock_in))}</span></span>`).join('')}
        ${atLunch.map((x) => `<span class="chip lunch">${esc(nameOf(x.employee_id))} <span class="muted">at lunch since ${esc(clockTime(x.clock_out))}</span></span>`).join('')}
        ${here.length || atLunch.length ? '' : '<span class="muted small">Nobody is clocked in.</span>'}</div></section>` : ''}
      <div class="toolbar">
        <span class="spacer"></span>
        <button class="btn small primary" id="pp-patriot" type="button">Hours for Patriot</button>
        <button class="btn small" id="pp-csv" type="button">Download punches (CSV)</button>
        ${closed ? '' : '<button class="btn small" id="pp-add" type="button">+ Add time</button>'}
        ${closed ? '<button class="btn small" id="pp-reopen" type="button">Reopen</button>'
          : '<button class="btn small" id="pp-close" type="button">Mark as entered in Patriot</button>'}
      </div>
      <div class="table-wrap"><table class="payroll"><thead><tr><th>Name</th><th class="num">Rate</th><th class="num">Regular</th>
        <th class="num">Overtime</th><th class="num">Total hours</th><th class="num">Est. gross</th><th>Check</th></tr></thead>
        <tbody id="pp-rows">${people.map((e) => {
          const t = T[e.id] || ZERO;
          return `<tr data-emp="${e.id}"><td><b>${esc(empName(e))}</b><div class="muted small">${esc(e.position || '')}${e.active ? '' : ' · not active'}</div></td>
            <td class="num">${e.pay_rate != null ? money(e.pay_rate) : '<span class="muted small">no rate</span>'}</td>
            <td class="num">${t.minutes ? hrs(t.regular) : ''}</td><td class="num">${t.overtime ? hrs(t.overtime) : ''}</td>
            <td class="num"><b>${t.minutes ? hrs(t.minutes) : ''}</b></td><td class="num">${t.minutes ? money(grossOf(e, t)) : ''}</td>
            <td>${payChecks(e).map(([k, v]) => `<div class="check-${k} small">${esc(v)}</div>`).join('')}</td></tr>`;
        }).join('') || '<tr><td colspan="7" class="muted">Add your staff on the “Staff &amp; PINs” tab.</td></tr>'}</tbody>
        <tfoot><tr><th>Total</th><th></th><th class="num">${hrs(sum('regular'))}</th><th class="num">${hrs(sum('overtime'))}</th>
          <th class="num">${hrs(sum('minutes'))}</th><th class="num">${money(gross)}</th><th></th></tr></tfoot></table></div>
      <p class="muted small">Tap a name for their day-by-day timesheet. Lunch clocked out is unpaid. Overtime is time over 40 hours in a workweek
        (${esc(weekdayName(paySched().anchor))} to ${esc(weekdayName(addDays(paySched().anchor, 6)))}), paid at 1½ times the rate.
        Estimated gross is before taxes; Patriot works out the paychecks.</p>`;

    const go = (np) => { state.payPeriod = np; renderPayroll(el); };
    $('#pay-guide', body).addEventListener('toggle', (ev) => { store.set('payGuideOpen', ev.target.open); store.set('payGuideSeen', true); });
    $('#pay-guide-print', body).addEventListener('click', showPayGuide);
    $('#pp-prev', body).addEventListener('click', () => go(payPeriodOf(addDays(pp.start, -1))));
    $('#pp-next', body).addEventListener('click', () => go(payPeriodOf(addDays(pp.end, 1))));
    $('#pp-now', body)?.addEventListener('click', () => go(payPeriodOf(nyToday())));
    $$('#pp-rows tr[data-emp]', body).forEach((tr) => tr.addEventListener('click', () => openTimesheet(tr.dataset.emp)));
    $$('[data-fix]', body).forEach((b) => b.addEventListener('click', () => openTimeEntry({ entryId: b.dataset.fix })));
    $('#pp-add', body)?.addEventListener('click', () => openTimeEntry({}));
    $('#pp-patriot', body).addEventListener('click', () => showPatriotSheet());
    $('#pp-csv', body).addEventListener('click', () => {
      const byId = Object.fromEntries(P.employees.map((e) => [e.id, e]));
      csvDownload(`creativa-time-${pp.start}.csv`,
        ['Last name', 'First name', 'Date', 'Clock in', 'Clock out', 'Left for', 'Hours', 'Recorded by', 'Changed by the office', 'Note'],
        P.entries.slice().sort((a, b) => empSort(byId[a.employee_id], byId[b.employee_id]) || a.clock_in.localeCompare(b.clock_in)).map((x) => {
          const e = byId[x.employee_id] || {};
          return [e.last_name, e.first_name, x.work_date, clockTime(x.clock_in), x.clock_out ? clockTime(x.clock_out) : 'not clocked out',
            x.clock_out ? (x.out_reason === 'lunch' ? 'Lunch' : 'Day') : '', x.clock_out ? hrs((new Date(x.clock_out) - new Date(x.clock_in)) / 60000) : '',
            x.source === 'clock' ? 'Time clock' : 'Office', x.edited_at ? fmtDateTime(x.edited_at) : '', x.note];
        }));
    });
    $('#pp-close', body)?.addEventListener('click', async () => {
      if (!confirm(`Mark ${fmtPayPeriod(pp)} as entered in Patriot? Its hours are saved as sent, and its time can’t be changed unless you reopen it.`)) return;
      const { error } = await sb.rpc('payroll_close_period', { p_start: pp.start, p_end: pp.end });
      if (error) return fail(error, 'Could not mark the pay period');
      toast('Pay period marked as entered in Patriot');
      reloadPayroll();
    });
    $('#pp-reopen', body)?.addEventListener('click', async () => {
      if (!confirm('Reopen this pay period so its time can be changed? If you change hours, fix them in Patriot too.')) return;
      const { error } = await sb.from('payroll_periods').delete().eq('period_start', closed.period_start);
      if (error) return fail(error, 'Could not reopen the pay period');
      toast('Pay period reopened');
      reloadPayroll();
    });
  }

  // ───────────── Paychecks from Patriot (016) ─────────────
  // Patriot has no way to connect other programs, so each payroll's paycheck list is pasted in from Patriot's
  // Payroll → Print Payrolls → View Details: who was paid, their hours, gross and net pay, by pay date.
  const normName = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  function matchEmployee(name) {   // "PEÑA, ANA" or "SMITH, MARIA J" → that staff member
    const [last, first = ''] = name.split(',').map(normName);
    const same = state.pay.employees.filter((e) => normName(e.last_name) === last);
    return same.find((e) => normName(e.first_name).split(' ')[0] === first.split(' ')[0]) || (same.length === 1 ? same[0] : null);
  }
  function parsePatriot(text) {
    const out = { rows: [] }, num = (x) => Number(String(x).replace(/[$,\s]/g, ''));
    const iso = (m) => { const [mo, d, y] = m.split('/').map(Number); return `${y}-${pad(mo)}-${pad(d)}`; };
    text.split(/\r?\n/).forEach((line) => {
      const l = line.replace(/\u00a0/g, ' ').trim();
      const dates = l.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
      if (dates) { if (!out.payDate) Object.assign(out, { payDate: iso(dates[1]), start: iso(dates[2]), end: iso(dates[3]) }); return; }
      const tot = l.match(/^totals?:?\s+([\d,.]+)\s+\$?\s*([\d,]+\.\d{2})\s+\$?\s*([\d,]+\.\d{2})$/i);
      if (tot) { out.totals = { hours: num(tot[1]), gross: num(tot[2]), net: num(tot[3]) }; return; }
      const m = l.match(/^([^\d$\t]*,[^\d$\t]+?)\s+([\d,]+(?:\.\d+)?)\s+\$?\s*([\d,]+\.\d{2})\s+\$?\s*([\d,]+\.\d{2})$/);
      if (m) out.rows.push({ name: m[1].replace(/^[^A-Za-zÀ-ÿ]+/, '').replace(/\s+/g, ' ').trim().toUpperCase(), hours: num(m[2]), gross: num(m[3]), net: num(m[4]) });
    });
    return out;
  }
  const sumBy = (rows, k) => round2(rows.reduce((t, x) => t + Number(x[k] || 0), 0));

  async function drawPayPaid(body, el) {
    const r = await selectAll('paychecks', 'pay_date', false);
    if (!$('#pay-body', el) || state.payTab !== 'paid') return;
    if (r.error) { body.innerHTML = '<p class="muted">To keep paychecks here, run <code>016_paychecks.sql</code> in Supabase.</p>'; return; }
    const all = r.data, years = [...new Set(all.map((x) => x.pay_date.slice(0, 4)))].sort().reverse();
    const year = state.paidYear && years.includes(state.paidYear) ? state.paidYear : years[0] || nyToday().slice(0, 4);
    const rows = all.filter((x) => x.pay_date.startsWith(year));
    const runs = [...new Set(rows.map((x) => x.pay_date))].map((d) => ({ date: d, rows: rows.filter((x) => x.pay_date === d) }));
    const people = new Map();
    rows.forEach((x) => {
      const k = x.employee_id || x.name;
      if (!people.has(k)) people.set(k, { id: x.employee_id, name: x.name, rows: [] });
      people.get(k).rows.push(x);
    });
    const empOf = (id) => state.pay.employees.find((e) => e.id === id);
    const who = (p) => (p.id && empOf(p.id) ? empName(empOf(p.id)) : p.name);
    body.innerHTML = `<div class="month-bar">${years.length > 1 ? years.map((y) => `<button class="btn small ${y === year ? 'primary' : ''}" type="button" data-pyear="${y}">${y}</button>`).join('') : `<b>${esc(year)}</b>`}
        <span class="muted small">Paychecks from Patriot Software, by pay date</span><span class="spacer"></span>
        <button class="btn small primary" id="pc-add" type="button">+ Add a payroll from Patriot</button></div>
      <div class="stats">
        <div class="stat"><b>${runs.length}</b><span>Payrolls in ${esc(year)}</span></div>
        <div class="stat"><b>${sumBy(rows, 'hours').toFixed(2)}</b><span>Hours paid</span></div>
        <div class="stat"><b>${money(sumBy(rows, 'gross'))}</b><span>Gross pay</span></div>
        <div class="stat"><b>${money(sumBy(rows, 'net'))}</b><span>Net pay</span></div>
      </div>
      <section class="panel"><h2>Payrolls</h2><div class="table-wrap flat"><table><thead><tr><th>Pay date</th><th>Pay period</th><th class="num">People</th>
        <th class="num">Hours</th><th class="num">Gross</th><th class="num">Net</th></tr></thead><tbody id="pc-runs">${runs.map((u) => `<tr data-run="${u.date}">
          <td class="nowrap"><b>${esc(fmtDate(u.date))}</b></td><td>${esc(fmtPayPeriod({ start: u.rows[0].period_start, end: u.rows[0].period_end }))}</td>
          <td class="num">${u.rows.length}</td><td class="num">${sumBy(u.rows, 'hours').toFixed(2)}</td><td class="num">${money(sumBy(u.rows, 'gross'))}</td>
          <td class="num">${money(sumBy(u.rows, 'net'))}</td></tr>`).join('')
          || '<tr><td colspan="6" class="muted">No paychecks yet. Add a payroll from Patriot.</td></tr>'}</tbody></table></div></section>
      ${people.size ? `<section class="panel"><h2>By person, ${esc(year)}</h2><div class="table-wrap flat"><table><thead><tr><th>Name</th><th class="num">Paychecks</th>
        <th class="num">Hours</th><th class="num">Gross</th><th class="num">Net</th></tr></thead><tbody id="pc-people">${[...people.values()].sort((a, b) => who(a).localeCompare(who(b))).map((p) => `<tr ${p.id && empOf(p.id) ? `data-pemp="${p.id}"` : ''}>
          <td><b>${esc(who(p))}</b>${p.id && empOf(p.id) ? '' : '<div class="muted small">not on the staff list</div>'}</td><td class="num">${p.rows.length}</td>
          <td class="num">${sumBy(p.rows, 'hours').toFixed(2)}</td><td class="num">${money(sumBy(p.rows, 'gross'))}</td><td class="num">${money(sumBy(p.rows, 'net'))}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th>Total</th><th class="num">${rows.length}</th><th class="num">${sumBy(rows, 'hours').toFixed(2)}</th><th class="num">${money(sumBy(rows, 'gross'))}</th>
          <th class="num">${money(sumBy(rows, 'net'))}</th></tr></tfoot></table></div></section>` : ''}
      <p class="muted small">Patriot can’t connect to other programs, so each payroll is copied over from Patriot (Payroll → Print Payrolls → View Details).
        Gross is before taxes and deductions; net is the take-home pay.</p>`;
    $$('[data-pyear]', body).forEach((b) => b.addEventListener('click', () => { state.paidYear = b.dataset.pyear; drawPayPaid(body, el); }));
    $('#pc-add', body).addEventListener('click', () => openPaychecksAdd(body, el));
    $$('#pc-runs tr[data-run]', body).forEach((tr) => tr.addEventListener('click', () => openPayrollRun(runs.find((u) => u.date === tr.dataset.run), body, el)));
    $$('#pc-people tr[data-pemp]', body).forEach((tr) => tr.addEventListener('click', () => openTimesheet(tr.dataset.pemp)));
  }

  function openPayrollRun(u, body, el) {
    const empOf = (id) => state.pay.employees.find((e) => e.id === id);
    const rows = u.rows.slice().sort((a, b) => a.name.localeCompare(b.name));
    const ctl = mountDrawer({
      title: `Paid ${esc(fmtDate(u.date))}`,
      sub: esc(`Pay period ${fmtPayPeriod({ start: rows[0].period_start, end: rows[0].period_end })} · ${rows.length} people`),
      body: `<div class="table-wrap flat"><table><thead><tr><th>Name</th><th class="num">Hours</th><th class="num">Gross</th><th class="num">Net</th></tr></thead>
        <tbody>${rows.map((x) => `<tr><td><b>${esc(x.employee_id && empOf(x.employee_id) ? empName(empOf(x.employee_id)) : x.name)}</b>
          ${x.employee_id && empOf(x.employee_id) ? '' : '<div class="muted small">not on the staff list</div>'}</td>
          <td class="num">${x.hours != null ? Number(x.hours).toFixed(2) : ''}</td><td class="num">${money(x.gross)}</td><td class="num">${x.net != null ? money(x.net) : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th>Total</th><th class="num">${sumBy(rows, 'hours').toFixed(2)}</th><th class="num">${money(sumBy(rows, 'gross'))}</th><th class="num">${money(sumBy(rows, 'net'))}</th></tr></tfoot></table></div>`,
      foot: `<button class="btn danger" id="pc-del" type="button">Delete this payroll</button><span class="spacer"></span><button class="btn" data-close type="button">Close</button>`,
    });
    $('#pc-del', ctl.drawer).addEventListener('click', async () => {
      if (!confirm(`Delete the payroll paid ${fmtDate(u.date)} from the CRM? (Nothing changes in Patriot.)`)) return;
      const { error } = await sb.from('paychecks').delete().eq('pay_date', u.date);
      if (error) return fail(error, 'Could not delete it');
      closeDrawer();
      toast('Payroll deleted');
      drawPayPaid(body, el);
    });
  }

  function openPaychecksAdd(body, el) {
    const last = payPeriodOf(addDays(payPeriodOf(nyToday()).start, -1));   // the pay period that just ended
    let parsed = { rows: [] };
    const ctl = mountDrawer({
      title: 'Add a payroll from Patriot',
      sub: 'Patriot can’t connect to the CRM, so copy the paycheck list over',
      body: `<div class="section"><ol class="small pc-steps">
          <li>In Patriot, open <b>Payroll → Print Payrolls</b> and tap <b>View Details</b> on the payroll.</li>
          <li>Select from the pay date down to the <b>Totals</b> line, copy it, and paste it here.</li></ol>
        <label>Paste here<textarea name="paste" rows="6" placeholder="10/22/2026   10/2/2026 - 10/15/2026   2&#10;SMITH, ANA   80.00   $1,240.00   $1,145.14&#10;LEE, MARIA   40.00   $600.00   $554.10&#10;Totals:   120.00   $1,840.00   $1,699.24"></textarea></label></div>
        <div class="section grid2">
          <label>Pay date<input type="date" name="pay_date" value="${addDays(last.end, 7)}"></label><span></span>
          <label>Pay period from<input type="date" name="period_start" value="${last.start}"></label>
          <label>to<input type="date" name="period_end" value="${last.end}"></label></div>
        <div class="section"><h3>Paychecks <span class="muted small" id="pc-count"></span></h3><div id="pc-preview"><p class="muted small">Nothing pasted yet.</p></div></div>`,
      foot: `<span class="spacer"></span><button class="btn" data-close type="button">Cancel</button>
        <button class="btn primary" id="pc-save" type="button" disabled>Save</button>`,
    });
    const { drawer, form } = ctl;
    form.paste.focus();
    form.paste.addEventListener('input', () => {
      parsed = parsePatriot(form.paste.value);
      if (parsed.payDate) { form.pay_date.value = parsed.payDate; form.period_start.value = parsed.start; form.period_end.value = parsed.end; }
      const rs = parsed.rows, T = parsed.totals;
      const ok = T && Math.abs(sumBy(rs, 'gross') - T.gross) < 0.005 && Math.abs(sumBy(rs, 'net') - T.net) < 0.005 && Math.abs(sumBy(rs, 'hours') - T.hours) < 0.005;
      $('#pc-count', drawer).textContent = rs.length ? `${rs.length} people` : '';
      $('#pc-save', drawer).disabled = !rs.length;
      $('#pc-preview', drawer).innerHTML = rs.length ? `<div class="table-wrap flat"><table><thead><tr><th>Patriot</th><th>Staff member</th><th class="num">Hours</th>
          <th class="num">Gross</th><th class="num">Net</th></tr></thead><tbody>${rs.map((x) => { const e = matchEmployee(x.name); return `<tr><td>${esc(x.name)}</td>
          <td>${e ? esc(empName(e)) : '<span class="check-warn small">not on the staff list</span>'}</td><td class="num">${x.hours.toFixed(2)}</td>
          <td class="num">${money(x.gross)}</td><td class="num">${money(x.net)}</td></tr>`; }).join('')}</tbody>
          <tfoot><tr><th colspan="2">Total</th><th class="num">${sumBy(rs, 'hours').toFixed(2)}</th><th class="num">${money(sumBy(rs, 'gross'))}</th><th class="num">${money(sumBy(rs, 'net'))}</th></tr></tfoot></table></div>
          ${T ? (ok ? '<p class="small pc-ok">✓ Adds up to Patriot’s totals.</p>'
            : `<p class="check-warn small">Doesn’t add up to Patriot’s totals (${money(T.gross)} gross): check that every person was copied.</p>`)
            : '<p class="muted small">Copy the Totals line too, to check that nobody was left out.</p>'}`
        : `<p class="muted small">${form.paste.value.trim() ? 'No paychecks found in what was pasted. Copy the rows with the names, hours and pay.' : 'Nothing pasted yet.'}</p>`;
    });
    $('#pc-save', drawer).addEventListener('click', async () => {
      const payDate = form.pay_date.value, start = form.period_start.value, end = form.period_end.value;
      if (!payDate || !start || !end) return toast('Fill in the pay date and pay period', true);
      if (end < start) return toast('The pay period ends before it starts', true);
      const { data: had } = await sb.from('paychecks').select('id').eq('pay_date', payDate).limit(1);
      if (had?.length && !confirm(`There’s already a payroll paid ${fmtDate(payDate)} in the CRM. Replace it with this one?`)) return;
      if (had?.length) {
        const { error } = await sb.from('paychecks').delete().eq('pay_date', payDate);
        if (error) return fail(error, 'Could not replace it');
      }
      const rows = parsed.rows.map((x) => ({ pay_date: payDate, period_start: start, period_end: end, employee_id: matchEmployee(x.name)?.id || null,
        name: x.name, hours: x.hours, gross: x.gross, net: x.net }));
      const { error } = await sb.from('paychecks').insert(rows);
      if (error) return fail(error, 'Could not save the payroll');
      ctl.dirty = false;
      closeDrawer();
      toast(`Saved the payroll paid ${fmtDate(payDate)}: ${rows.length} paychecks, ${money(sumBy(rows, 'gross'))} gross`);
      state.paidYear = payDate.slice(0, 4);
      drawPayPaid(body, el);
    });
  }

  function openTimesheet(empId) {
    const P = state.pay, e = P.employees.find((x) => x.id === empId);
    if (!e) return;
    const closed = closedFor(P.pp), t = payTotals()[empId] || ZERO;
    const days = P.hours.filter((h) => h.employee_id === empId);
    const entries = P.entries.filter((x) => x.employee_id === empId);
    const weeks = [];
    days.forEach((d) => {
      const w = weekStartOf(d.work_date);
      if (!weeks.length || weeks[weeks.length - 1].start !== w) weeks.push({ start: w, days: [] });
      weeks[weeks.length - 1].days.push(d);
    });
    const span = (x) => `<button type="button" class="ts-span${x.clock_out ? '' : ' open'}" data-entry="${x.id}" ${closed ? 'disabled' : ''}>
        ${esc(clockTime(x.clock_in))} – ${x.clock_out ? esc(clockTime(x.clock_out)) : '<b>no clock-out</b>'}${x.out_reason === 'lunch' ? ' <span class="muted">lunch</span>' : ''}${x.punched_in ? ` <span class="muted small">(tapped in ${esc(clockTime(x.punched_in))}, early: counts from their start)</span>` : ''}
        ${x.edited_at || x.source === 'office' ? '<span class="ts-edited" title="Changed or added by the office">✎</span>' : ''}</button>`;
    const ctl = mountDrawer({
      title: esc(empName(e)),
      sub: esc([e.position, e.pay_rate != null ? `${money(e.pay_rate)}/hour` : 'no pay rate', e.lunch_minutes ? `lunch ${e.lunch_minutes} min` : 'no lunch',
        e.schedule].filter(Boolean).join(' · ')),
      body: `<div class="section"><h3 class="sub-h">${esc(longPayPeriod(P.pp))}</h3>
        ${weeks.map((w) => {
          const reg = w.days.reduce((s, d) => s + Number(d.regular), 0), ot = w.days.reduce((s, d) => s + Number(d.overtime), 0);
          return `<table class="ts"><thead><tr><th colspan="3">Week of ${esc(dayLabel(w.start))}</th></tr></thead><tbody>
            ${w.days.map((d) => `<tr><td class="nowrap">${esc(dayLabel(d.work_date))}</td>
              <td>${entries.filter((x) => x.work_date === d.work_date).map(span).join('')}</td>
              <td class="num">${hrs(d.minutes)}${Number(d.overtime) ? `<div class="muted small">${hrs(d.overtime)} OT</div>` : ''}</td></tr>`).join('')}
            </tbody><tfoot><tr><th colspan="2">Week total${ot ? ` · ${hrs(ot)} overtime` : ''}</th><th class="num">${hrs(reg + ot)}</th></tr></tfoot></table>`;
        }).join('') || '<p class="muted">No time in this pay period.</p>'}
        <dl class="ts-total"><div><dt>Regular</dt><dd>${hrs(t.regular)}</dd></div><div><dt>Overtime</dt><dd>${hrs(t.overtime)}</dd></div>
          <div><dt>Total hours</dt><dd>${hrs(t.minutes)}</dd></div><div><dt>Est. gross</dt><dd>${money(grossOf(e, t))}</dd></div></dl>
        ${closed ? '<p class="muted small">This pay period was entered in Patriot, so its time is locked. Reopen it on the Hours tab to change it.</p>'
          : '<p class="muted small">Tap a time to change it. ✎ = changed or added by the office (the time clock’s original is kept).</p>'}</div>
        <div class="section" id="ts-paid-box" hidden><h3>Paychecks from Patriot</h3><ul class="chg-list mini" id="ts-paid"></ul></div>`,
      foot: `<span class="spacer"></span><button class="btn" data-close type="button">Close</button>
        ${closed ? '' : '<button class="btn primary" id="ts-add" type="button">+ Add time</button>'}`,
    });
    sb.from('paychecks').select('*').eq('employee_id', empId).order('pay_date', { ascending: false }).limit(8).then(({ data, error }) => {
      const box = $('#ts-paid-box', ctl.drawer);
      if (!box || error || !data?.length) return;
      const year = data[0].pay_date.slice(0, 4), ytd = data.filter((x) => x.pay_date.startsWith(year));
      box.hidden = false;
      $('#ts-paid', ctl.drawer).innerHTML = data.map((x) => `<li><span class="chg-time">${esc(fmtDate(x.pay_date))}</span>
          <span>${esc(fmtPayPeriod({ start: x.period_start, end: x.period_end }))} · ${x.hours != null ? `${Number(x.hours).toFixed(2)} h · ` : ''}<b>${money(x.gross)}</b> gross${x.net != null ? ` · ${money(x.net)} net` : ''}</span></li>`).join('')
        + `<li class="muted small"><span>Shown: ${ytd.length} paycheck${ytd.length === 1 ? '' : 's'} in ${year}, ${money(ytd.reduce((t, x) => t + Number(x.gross), 0))} gross. All of them are on Payroll → Paychecks.</span></li>`;
    });
    const back = () => openTimesheet(empId);
    $$('[data-entry]', ctl.drawer).forEach((b) => b.addEventListener('click', () => openTimeEntry({ entryId: b.dataset.entry, back })));
    $('#ts-add', ctl.drawer)?.addEventListener('click', () => openTimeEntry({ employeeId: empId, back }));
  }

  function openTimeEntry({ entryId, employeeId, back }) {
    const P = state.pay;
    const x = entryId ? P.entries.concat(P.open).find((r) => r.id === entryId) : null;
    const empId = x ? x.employee_id : employeeId;
    const emp = P.employees.find((e) => e.id === empId);
    const inP = x ? nyParts(x.clock_in) : null, outP = x?.clock_out ? nyParts(x.clock_out) : null;
    const today = nyToday();
    const defDay = P.pp.start <= today && today <= P.pp.end ? today : P.pp.end;
    const ctl = mountDrawer({
      title: x ? 'Change time' : 'Add time',
      sub: emp ? esc(empName(emp)) : '',
      body: `<div class="section"><div class="grid2">
          ${emp ? '' : `<label class="full">Who<select name="employee_id" required><option value="">Choose…</option>
            ${optionsHtml(P.employees.filter((e) => e.active).sort(empSort).map((e) => [e.id, empName(e)]), '')}</select></label>`}
          ${fInput('day', 'Day', inP ? inP.date : defDay, 'date', `required max="${today}"`)}
          <span></span>
          ${fInput('t_in', 'Clocked in', inP?.time || '', 'time', 'required')}
          ${fInput('t_out', 'Clocked out', outP?.time || '', 'time')}
          ${fSelect('out_reason', 'Left for', [['out', 'The day'], ['lunch', 'Lunch (unpaid)']], x?.out_reason || 'out')}
          <label class="full">Note<input name="note" value="${esc(x?.note)}" maxlength="300" placeholder="e.g. Forgot to clock out, left at 4:30"></label>
        </div>
        ${x?.punched_in ? `<p class="muted small">Tapped in early at ${esc(clockTime(x.punched_in))}; it counts from their start time.</p>` : ''}
        ${x?.source === 'clock' ? `<p class="muted small">From the time clock${x.original_in ? `. The clock had ${esc(clockTime(x.original_in))} – ${x.original_out ? esc(clockTime(x.original_out)) : 'no clock-out'};
          changed by ${esc(staffName(x.edited_by) || 'the office')} ${esc(fmtDateTime(x.edited_at))}` : ''}.</p>`
          : x ? `<p class="muted small">Added by ${esc(staffName(x.created_by) || 'the office')}${x.edited_at ? `, changed ${esc(fmtDateTime(x.edited_at))}` : ''}.</p>` : ''}
        <p class="muted small">Leave “Clocked out” empty only if they are still here.</p></div>`,
      foot: `${x ? '<button class="btn danger" id="te-del" type="button">Delete</button>' : ''}<span class="spacer"></span>
        <button class="btn" data-close type="button">Cancel</button><button class="btn primary" id="te-save" type="button">Save</button>`,
    });
    const { drawer, form } = ctl;
    const done = async () => { ctl.dirty = false; closeDrawer(); await reloadPayroll(); if (back) back(); };
    $('#te-save', drawer).addEventListener('click', async () => {
      const who = emp ? emp.id : form.employee_id.value;
      const day = form.day.value, tin = form.t_in.value, tout = form.t_out.value;
      if (!who) return toast('Choose who this time is for', true);
      if (!day || !tin) return toast('Enter the day and the time they clocked in', true);
      if (tout && tout <= tin) return toast('Clocked out must be later than clocked in, on the same day', true);
      const row = { clock_in: nyIso(day, tin), clock_out: tout ? nyIso(day, tout) : null, out_reason: tout ? form.out_reason.value : null, note: formVal(form, 'note') };
      const btn = $('#te-save', drawer);
      btn.disabled = true;
      const { error } = x ? await sb.from('time_entries').update(row).eq('id', x.id) : await sb.from('time_entries').insert({ ...row, employee_id: who });
      btn.disabled = false;
      if (error) return fail(error, 'Could not save the time');
      toast('Saved');
      done();
    });
    $('#te-del', drawer)?.addEventListener('click', async () => {
      if (!confirm('Delete this time?')) return;
      const { error } = await sb.from('time_entries').delete().eq('id', x.id);
      if (error) return fail(error, 'Could not delete the time');
      toast('Deleted');
      done();
    });
  }

  // What to type into Patriot: Payroll → Run Payroll, one line per person.
  function showPatriotSheet() {
    const P = state.pay, T = payTotals();
    const list = P.employees.filter((e) => (T[e.id]?.minutes || 0) > 0).sort(empSort);
    const missed = P.open.filter((x) => isStale(x) && x.work_date >= P.pp.start && x.work_date <= P.pp.end).length;
    const tot = (k) => list.reduce((s, e) => s + T[e.id][k], 0);
    const sheet = document.createElement('div');
    sheet.className = 'print-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.innerHTML = `<div class="print-bar no-print"><b>Hours for Patriot</b><span class="spacer"></span>
        <button class="btn" type="button" id="ps-csv">Download CSV</button>
        <button class="btn primary" type="button" id="ps-print">Print / Save as PDF</button>
        <button class="btn" type="button" id="ps-close">Close</button></div>
      <article class="receipt pay-sheet">
        <header class="r-band"><img src="/assets/logo.png" alt="${esc(state.settings?.school_name || 'Creativa Academy')}">
          <div class="r-title"><h1>Hours for Patriot</h1><span class="r-year">Pay period ${esc(longPayPeriod(P.pp))}</span></div></header>
        ${missed ? `<p class="check-warn"><b>${missed} missing clock-out${missed === 1 ? '' : 's'}</b>: fix ${missed === 1 ? 'it' : 'them'} on the Hours tab first, or those hours are left out.</p>` : ''}
        <ol class="steps no-print">
          <li>In Patriot, open <b>Payroll → Run Payroll</b> and pick the pay period <b>${esc(longPayPeriod(P.pp))}</b>.</li>
          <li>For each person below, type the <b>Regular</b> and <b>Overtime</b> hours.</li>
          <li>Preview, approve, then come back here and tap <b>Mark as entered in Patriot</b>.</li>
        </ol>
        <table class="r-table"><thead><tr><th>Employee</th><th class="num">Regular hours</th><th class="num">Overtime hours</th><th class="num">Total hours</th>
          <th class="num">Rate</th><th class="num">Est. gross</th></tr></thead>
          <tbody>${list.map((e) => `<tr><td><b>${esc(empLastFirst(e))}</b></td><td class="num"><b>${hrs(T[e.id].regular)}</b></td>
            <td class="num"><b>${T[e.id].overtime ? hrs(T[e.id].overtime) : '0.00'}</b></td><td class="num">${hrs(T[e.id].minutes)}</td>
            <td class="num">${e.pay_rate != null ? money(e.pay_rate) : ''}</td><td class="num">${money(grossOf(e, T[e.id]))}</td></tr>`).join('')
            || '<tr><td colspan="6">No hours in this pay period.</td></tr>'}</tbody>
          <tfoot><tr><th>Total</th><th class="num">${hrs(tot('regular'))}</th><th class="num">${hrs(tot('overtime'))}</th><th class="num">${hrs(tot('minutes'))}</th>
            <th></th><th class="num">${money(round2(list.reduce((s, e) => s + grossOf(e, T[e.id]), 0)))}</th></tr></tfoot></table>
        <p class="r-note">Overtime: time over 40 hours in a workweek, at 1½ times the rate. Estimated gross is before taxes and deductions.
          Printed ${esc(fmtDateTime(new Date().toISOString()))}.</p>
      </article>`;
    document.body.append(sheet);
    document.body.classList.add('printing');
    const close = () => { sheet.remove(); document.body.classList.remove('printing'); };
    $('#ps-print', sheet).addEventListener('click', () => window.print());
    $('#ps-close', sheet).addEventListener('click', close);
    $('#ps-csv', sheet).addEventListener('click', () => csvDownload(`creativa-patriot-hours-${P.pp.start}.csv`,
      ['Last name', 'First name', 'Regular hours', 'Overtime hours', 'Total hours', 'Pay rate', 'Estimated gross'],
      list.map((e) => [e.last_name, e.first_name, hrs(T[e.id].regular), hrs(T[e.id].overtime), hrs(T[e.id].minutes), e.pay_rate, grossOf(e, T[e.id])])));
    sheet.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
    $('#ps-close', sheet).focus();
  }

  // An easy PIN (7777, 1234...) is fine for now, but marked to change.
  const easyPin = (pin) => /^(\d)\1{3}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin);
  function pinCell(e) {
    const pin = state.pay.pins?.[e.id];
    if (!e.pin_set_at) return '<span class="pay-pill ps-open">No PIN</span>';
    if (state.pay.pins && !pin) return `<span class="pay-pill ps-paid">Set ${esc(fmtDate(e.pin_set_at))}</span> <span class="muted small">not on file</span>`;
    if (!pin) return `<span class="pay-pill ps-paid">Set ${esc(fmtDate(e.pin_set_at))}</span>`;
    return `<span class="pin-val ${state.showPins ? '' : 'pin-hidden'}">${state.showPins ? esc(pin) : '••••'}</span>${easyPin(pin) ? ' <span class="tag due">easy: change soon</span>' : ''}`;
  }
  function drawPayPeople(body, el) {
    const P = state.pay;
    const list = P.employees.slice().sort((a, b) => (b.active - a.active) || empSort(a, b));
    const noPin = list.filter((e) => e.active && !e.pin_set_at);
    body.innerHTML = `<div class="toolbar"><span class="muted small">${list.filter((e) => e.active).length} active ·
        ${noPin.length ? `${noPin.length} without a time clock PIN` : 'everyone has a PIN'}</span><span class="spacer"></span>
        ${P.pins ? `<button class="btn small" id="pe-show" type="button">${state.showPins ? 'Hide PINs' : 'Show PINs'}</button>` : ''}
        ${P.pins && Object.values(P.pins).some(Boolean) ? '<button class="btn small" id="pe-slips" type="button">Print PIN slips</button>' : ''}
        ${noPin.length ? `<button class="btn small" id="pe-pins" type="button">Make PINs for everyone without one (${noPin.length})</button>` : ''}
        <button class="btn small" id="pe-csv" type="button">Download CSV</button>
        <button class="btn small primary" id="pe-add" type="button">+ Add person</button></div>
      ${noPin.length ? `<section class="panel warn-panel" id="pe-nopin"><h2 class="h-row">Missing a time clock PIN <span class="muted small">${noPin.length} of ${list.filter((e) => e.active).length} active</span></h2>
        <p class="muted small">They don’t show on the time clock until they have one. Tap a name to type their PIN (or make one up and print a slip).</p>
        <div class="rate-opts">${noPin.map((e) => `<button class="btn small" type="button" data-nopin="${e.id}">${esc(empName(e))}</button>`).join('')}</div></section>`
        : `<p class="small pe-allpins">Everyone active has a time clock PIN.</p>`}
      <div class="table-wrap"><table class="people"><thead><tr><th>Name</th><th>Position</th><th class="num">Rate</th><th>Lunch</th><th>Schedule</th><th>Time clock PIN</th></tr></thead>
        <tbody id="pe-rows">${list.map((e) => `<tr data-emp="${e.id}" class="${e.active ? '' : 'inactive'}"><td><b>${esc(empName(e))}</b>${e.active ? '' : ' <span class="muted small">(not active)</span>'}</td>
          <td>${esc(e.position || '')}</td><td class="num">${e.pay_rate != null ? money(e.pay_rate) : ''}</td>
          <td>${e.lunch_minutes ? `${e.lunch_minutes} min` : '<span class="muted">none</span>'}</td><td>${esc(e.schedule || '')}</td>
          <td>${pinCell(e)}</td></tr>`).join('')
          || '<tr><td colspan="6" class="muted">Nobody yet. Tap “+ Add person”.</td></tr>'}</tbody></table></div>
      <p class="muted small">Pay rates are per hour. The scheduled lunch is only a reminder: staff clock out for lunch, and the Hours tab flags a
        long day with no lunch clocked. People who leave: open them and turn “Active” off; their past hours stay.</p>`;
    $$('#pe-rows tr[data-emp]', body).forEach((tr) => tr.addEventListener('click', () => openEmployee(tr.dataset.emp)));
    $$('[data-nopin]', body).forEach((b) => b.addEventListener('click', () => {
      openEmployee(b.dataset.nopin);
      const pin = $('.drawer input[name=pin]');
      pin?.scrollIntoView({ block: 'center' });
      pin?.focus();
    }));
    $('#pe-add', body).addEventListener('click', () => openEmployee(null));
    $('#pe-show', body)?.addEventListener('click', () => { state.showPins = !state.showPins; drawPayPeople(body, el); });
    $('#pe-slips', body)?.addEventListener('click', () => showPinSlips(list.filter((e) => e.active && P.pins[e.id]).map((e) => ({ name: empName(e), pin: P.pins[e.id] })), true));
    $('#pe-csv', body).addEventListener('click', () => csvDownload('creativa-staff.csv',
      ['Last name', 'First name', 'Position', 'Hourly rate', 'Lunch (minutes)', 'Schedule', 'Active', 'PIN set'],   // never the PINs themselves
      list.map((e) => [e.last_name, e.first_name, e.position, e.pay_rate, e.lunch_minutes, e.schedule, e.active ? 'yes' : 'no', e.pin_set_at ? 'yes' : 'no'])));
    $('#pe-pins', body)?.addEventListener('click', async () => {
      if (!confirm(`Make a 4-digit PIN for ${noPin.length} ${noPin.length === 1 ? 'person' : 'people'}? You’ll get a sheet to print and cut into slips.`)) return;
      const slips = [];
      for (const e of noPin) {
        const { data, error } = await sb.rpc('payroll_set_pin', { p_employee: e.id, p_pin: null });
        if (error) { fail(error, `Could not make a PIN for ${empName(e)}`); break; }
        slips.push({ name: empName(e), pin: data });
      }
      if (slips.length) showPinSlips(slips);
      reloadPayroll();
    });
  }

  // Slips to cut out and hand to each person. Without PINs on file (022) they're shown only now; later they can only be replaced.
  function showPinSlips(slips, onFile = !!state.pay?.pins) {
    const sheet = document.createElement('div');
    sheet.className = 'print-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.innerHTML = `<div class="print-bar no-print"><b>${slips.length} PIN${slips.length === 1 ? '' : 's'}</b>
        <span class="muted small">${onFile ? 'The PINs stay on file on Payroll → Staff.' : 'Print this now: the PINs can’t be shown again.'}</span><span class="spacer"></span>
        <button class="btn primary" type="button" id="sl-print">Print</button><button class="btn" type="button" id="sl-close">Close</button></div>
      <div class="pin-slips">${slips.map((x) => `<div class="pin-slip"><span class="muted small">${esc(state.settings?.school_name || 'Creativa Academy')} · time clock</span>
        <b class="slip-name">${esc(x.name)}</b><span class="slip-pin">PIN <b>${esc(x.pin)}</b></span>
        <span class="small">Tap your name on the time clock, type your PIN, then tap Clock in. Keep your PIN private.</span>
        <span class="small muted">Toque su nombre, escriba su PIN y toque Marcar entrada. No comparta su PIN.</span></div>`).join('')}</div>`;
    document.body.append(sheet);
    document.body.classList.add('printing');
    const close = () => { if (!onFile && !confirm('Close? The PINs won’t be shown again (you can always make new ones).')) return; sheet.remove(); document.body.classList.remove('printing'); };
    $('#sl-print', sheet).addEventListener('click', () => window.print());
    $('#sl-close', sheet).addEventListener('click', close);
    $('#sl-close', sheet).focus();
  }

  function openEmployee(id) {
    const e = id ? state.pay.employees.find((x) => x.id === id) : { active: true, lunch_minutes: 30 };
    const ctl = mountDrawer({
      title: id ? esc(empName(e)) : 'Add person',
      sub: id ? esc(e.position || '') : 'Someone on payroll',
      body: `<div class="section"><div class="grid2">
          ${fInput('first_name', 'First name', e.first_name, 'text', 'required maxlength="60"')}
          ${fInput('last_name', 'Last name', e.last_name, 'text', 'maxlength="60"')}
          ${fInput('position', 'Position', e.position, 'text', 'maxlength="60" placeholder="e.g. Assistant teacher"')}
          ${fInput('pay_rate', 'Pay rate ($ per hour)', e.pay_rate, 'number', 'min="0" step="0.01" inputmode="decimal"')}
          ${fSelect('lunch_minutes', 'Scheduled lunch (unpaid)', LUNCH, e.lunch_minutes)}
          ${fInput('schedule', 'Schedule', e.schedule, 'text', 'maxlength="60" placeholder="e.g. 8:00 – 4:30"')}
          ${state.pay.employees.some((x) => 'start_time' in x) ? `${fInput('start_time', 'Starts at (time clock)', (e.start_time || '').slice(0, 5), 'time')}
            <p class="full muted small">Clocking in earlier is saved as this time, so pay starts then (the real tap shows on their timesheet).
              Leave it empty to count from the tap.</p>` : ''}
          <label class="full">Notes<input name="notes" value="${esc(e.notes)}" maxlength="500"></label>
          <label class="full pill-check"><input type="checkbox" class="check" name="active" ${e.active ? 'checked' : ''}> Active (shows on the time clock)</label>
        </div></div>
        ${id ? `<div class="section" id="pin-sec"><h3 class="sub-h">Time clock PIN</h3>
          <p class="small">${state.pay.pins?.[id] ? `PIN on file: <b class="pin-val">${esc(state.pay.pins[id])}</b>${easyPin(state.pay.pins[id]) ? ' <span class="tag due">easy: change it when they give you theirs</span>' : ''}`
            : e.pin_set_at ? `<span class="muted">Set ${esc(fmtDate(e.pin_set_at))}. ${state.pay.pins ? 'It isn’t on file (it was set before PINs were kept): type it again, or a new one, to keep it.' : 'PINs can’t be looked up; type a new one to replace it.'}</span>`
              : '<span class="muted">No PIN yet: they don’t appear on the time clock until they have one.</span>'}</p>
          <div class="feed-row"><input name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" placeholder="4 digits" aria-label="New PIN">
            <button class="btn small" id="pin-set" type="button">Save PIN</button><button class="btn small" id="pin-make" type="button">Make one up</button></div>
          <p class="pin-show" id="pin-show" hidden></p></div>` : ''}`,
      foot: `${id ? '<button class="btn danger" id="em-del" type="button">Delete</button>' : ''}<span class="spacer"></span>
        <button class="btn" data-close type="button">Cancel</button><button class="btn primary" id="em-save" type="button">Save</button>`,
    });
    const { drawer, form } = ctl;
    $('#em-save', drawer).addEventListener('click', async () => {
      const row = { first_name: formVal(form, 'first_name'), last_name: formVal(form, 'last_name') || '', position: formVal(form, 'position'),
        pay_rate: form.pay_rate.value === '' ? null : Number(form.pay_rate.value), lunch_minutes: Number(form.lunch_minutes.value),
        schedule: formVal(form, 'schedule'), notes: formVal(form, 'notes'), active: form.active.checked,
        ...(form.start_time ? { start_time: form.start_time.value || null } : {}) };
      if (!row.first_name) return toast('Enter their first name', true);
      const { error } = id ? await sb.from('employees').update(row).eq('id', id) : await sb.from('employees').insert(row);
      if (error) return fail(error, 'Could not save');
      ctl.dirty = false;
      closeDrawer();
      toast(id ? 'Saved' : `${row.first_name} added. Next: give them a time clock PIN.`);
      reloadPayroll();
    });
    const setPin = async (pin) => {
      if (pin !== null && !/^\d{4}$/.test(pin)) return toast('A PIN is 4 digits', true);
      const { data, error } = await sb.rpc('payroll_set_pin', { p_employee: id, p_pin: pin });
      if (error) return fail(error, 'Could not set the PIN');
      form.pin.value = '';
      const show = $('#pin-show', drawer);
      show.hidden = false;
      show.innerHTML = `${esc(e.first_name)}’s PIN is <b>${esc(data)}</b>. ${state.pay.pins ? 'It’s on file here if they forget it.' : 'Give it to them privately; it won’t be shown again.'}${easyPin(data) ? ' It’s an easy one: change it when they give you theirs.' : ''}`;
      e.pin_set_at = new Date().toISOString();
      if (state.pay.pins) state.pay.pins[id] = data;
    };
    $('#pin-set', drawer)?.addEventListener('click', () => setPin(form.pin.value.trim()));
    $('#pin-make', drawer)?.addEventListener('click', () => setPin(null));
    $('#em-del', drawer)?.addEventListener('click', async () => {
      if (!confirm(`Delete ${empName(e)}? (People with recorded time can’t be deleted: turn Active off instead.)`)) return;
      const { error } = await sb.from('employees').delete().eq('id', id);
      if (error) return toast(error.code === '23503' ? `${empName(e)} has time recorded. Turn Active off instead.` : error.message, true);
      ctl.dirty = false;
      closeDrawer();
      toast('Deleted');
      reloadPayroll();
    });
  }

  function drawPaySetup(body, el) {
    const P = state.pay, admin = isAdmin(), set = state.settings || {};
    const mine = store.get('clockToken', null);
    // Staff pay alternates with tuition: show both side by side, and warn if they land on the same weeks.
    const pays = [], bills = [];
    for (let pp = payPeriodOf(nyToday()), i = 0; i < 3; i++, pp = payPeriodOf(addDays(pp.end, 1))) pays.push(pp);
    if (state.hasV6) for (let t = periodOf(todayStr()), i = 0; i < 3; i++, t = addDays(t, billing().days)) bills.push(t);
    const sundayOf = (d) => addDays(d, -new Date(d + 'T00:00:00').getDay());
    const sameWeeks = state.hasV6 && paySched().freq === 'biweekly' && billing().days === 14
      && ((daysBetween(sundayOf(billing().anchor), sundayOf(paySched().anchor)) % 14) + 14) % 14 === 0;
    body.innerHTML = `<section class="panel"><h2>Set up the time clock</h2>
        <ol class="steps">
          <li>On the tablet or computer staff will clock in on (for example the front-desk iPad), open this CRM and sign in.</li>
          <li>Come to <b>Payroll → Time clock</b> and tap <b>Use this device as the time clock</b>.</li>
          <li>The time clock opens, and the CRM signs out on that device, so nobody at the front desk can open it.
            On an iPad, tap <b>Share → Add to Home Screen</b> so the clock opens full screen.</li>
          <li>Staff tap their name, type their 4-digit PIN, and tap <b>Clock in</b>, <b>Lunch</b>, <b>Back from lunch</b> or <b>Clock out</b>.
            Times come from the server, not the tablet’s clock.</li>
        </ol>
        ${mine ? '<p class="ok-text small">This device is already a time clock. <a href="/clock/">Open the time clock</a></p>' : ''}
        <div class="feed-row"><input id="dev-name" value="Front desk tablet" maxlength="60" aria-label="Name for this device">
          <button class="btn primary small" id="dev-add" type="button">Use this device as the time clock</button></div>
        <h3 class="sub-h">Time clocks</h3>
        <div class="table-wrap flat"><table><thead><tr><th>Device</th><th>Set up</th><th>Last used</th><th></th></tr></thead>
          <tbody id="dev-rows">${P.devices.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(fmtDate(d.created_at))}</td>
            <td>${d.last_seen_at ? esc(relDays(d.last_seen_at)) : '<span class="muted">never</span>'}</td>
            <td><button class="btn small ghost danger" type="button" data-dev-del="${d.id}">Remove</button></td></tr>`).join('')
            || '<tr><td colspan="4" class="muted">None yet.</td></tr>'}</tbody></table></div>
        <p class="muted small">Lost a tablet? Remove it here and it stops working at once.</p></section>
      <section class="panel"><h2>Pay schedule</h2>
        <p class="muted small">Match the pay schedule in Patriot, so each pay period here is the one you run there.
          Overtime is counted per workweek, starting on the weekday of the date below.${admin ? '' : ' Only admins can change this.'}</p>
        <p class="muted small" id="pay-weeks">Pay periods${['weekly', 'biweekly'].includes(paySched().freq)
          ? ` (${esc(weekdayName(pays[0].start))} to ${esc(weekdayName(pays[0].end))})` : ''}: ${pays.map((pp) => `<b>${esc(fmtPayPeriod(pp))}</b>`).join(', ')}.
          ${bills.length ? `Tuition is billed ${bills.map((t) => esc(fmtDate(t))).join(', ')}.` : ''}</p>
        ${sameWeeks ? `<p class="check-warn small" id="pay-clash">These pay periods start the same weeks tuition is billed. Staff pay alternates
          with tuition, so start them a week later (or earlier).</p>` : ''}
        <form id="pay-sched" class="grid2">
          ${fSelect('payroll_frequency', 'How often you run payroll', Object.entries(PAY_FREQ), set.payroll_frequency, admin ? '' : 'disabled')}
          ${fInput('payroll_anchor', 'A pay period started on', set.payroll_anchor, 'date', `required ${admin ? '' : 'disabled'}`)}
          ${admin ? '<div class="full"><button class="btn small primary" type="submit">Save pay schedule</button></div>' : ''}
        </form></section>`;
    $('#dev-add', body).addEventListener('click', async () => {
      if (!confirm('Make this device the time clock? You’ll be signed out of the CRM here, and the clock will open.')) return;
      const { data, error } = await sb.rpc('timeclock_add_device', { p_name: $('#dev-name', body).value.trim() || 'Time clock' });
      if (error) return fail(error, 'Could not set up the time clock');
      store.set('clockToken', data);
      await sb.auth.signOut({ scope: 'local' });   // only this device; the admin stays signed in elsewhere
      location.assign('/clock/');
    });
    $$('[data-dev-del]', body).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remove this time clock? It stops working right away.')) return;
      const { error } = await sb.from('timeclock_devices').delete().eq('id', b.dataset.devDel);
      if (error) return fail(error, 'Could not remove it');
      toast('Time clock removed');
      reloadPayroll();
    }));
    $('#pay-sched', body).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const next = { freq: f.payroll_frequency.value, anchor: f.payroll_anchor.value };
      // Pay periods already entered in Patriot that the new schedule would cut across.
      const off = P.closed.filter((c) => { const pp = payPeriodOf(c.period_start, next); return pp.start !== c.period_start || pp.end !== c.period_end; });
      if (off.length && !confirm(`${off.length === 1 ? 'A pay period' : `${off.length} pay periods`} already entered in Patriot (${off.slice(0, 3)
        .map((c) => fmtPayPeriod({ start: c.period_start, end: c.period_end })).join(', ')}${off.length > 3 ? ', …' : ''}) won’t line up with this schedule. `
        + 'Their hours stay saved and locked, but new periods that overlap them will show as entered. Save anyway?')) return;
      const { data, error } = await sb.from('settings').update({ payroll_frequency: next.freq, payroll_anchor: next.anchor })
        .eq('id', 1).select().single();
      if (error) return fail(error, 'Could not save');
      state.settings = data;
      state.payPeriod = null;
      toast('Pay schedule saved');
      reloadPayroll();   // redraw the pay periods, the tuition dates and the clash warning
    });
  }

  // Reports → the billing system's Balance Summary sheets from before the CRM (010): what each family owed on the
  // day each sheet was printed. Reference only; it changes no invoice, payment or statement.
  const histKey = (v) => String(v || '').trim().toUpperCase();
  const historyFor = (s) => (s?.family_account ? state.history.filter((h) => histKey(h.family_account) === histKey(s.family_account)) : []);
  const historySheets = () => [...new Map(state.history.map((h) => [h.as_of, h])).values()].sort((a, b) => a.as_of.localeCompare(b.as_of));
  function historyPanel() {
    if (!state.history.length) return '';
    const sheets = historySheets();
    const sum = (d) => round2(state.history.filter((h) => h.as_of === d).reduce((t, h) => t + Number(h.balance), 0));
    return `<details class="panel history-panel" id="hist-panel"><summary><h2>Balances on the billing system’s sheets
        <span class="muted small">${sheets.length} sheet${sheets.length === 1 ? '' : 's'}, ${esc(fmtDate(sheets[0].as_of))} – ${esc(fmtDate(sheets[sheets.length - 1].as_of))}</span></h2></summary>
      <p class="muted small">Each family’s balance on the Balance Summary printed for each tuition period, which is what they were billed
        (a minus is a credit). All billed and paid in the billing system before the CRM. Kept for reference: it doesn’t change what anyone
        owes in the CRM or what goes on annual statements.</p>
      <div class="toolbar"><input type="search" id="hist-q" placeholder="Search family…"><span class="spacer"></span>
        <button class="btn small" id="hist-csv" type="button">Download CSV</button></div>
      <div class="table-wrap flat"><table class="hist"><thead><tr><th>Family</th>${sheets.map((sh) => `<th class="num">${esc(fmtDate(sh.as_of))}
          <div class="hist-period">${sh.period_start ? `${esc(fmtDate(sh.period_start))} – ${esc(fmtDate(sh.period_end))}` : ''}</div></th>`).join('')}</tr></thead>
        <tbody id="hist-rows"></tbody>
        <tfoot><tr><th>Total</th>${sheets.map((sh) => `<th class="num">${money(sum(sh.as_of))}</th>`).join('')}</tr></tfoot></table></div></details>`;
  }
  function bindHistoryPanel(el) {
    const panel = $('#hist-panel', el);
    if (!panel) return;
    const sheets = historySheets();
    const fams = [...new Set(state.history.map((h) => h.family_account || h.customer))].sort((a, b) => a.localeCompare(b));
    const cell = (f, d) => state.history.find((h) => (h.family_account || h.customer) === f && h.as_of === d);
    const draw = () => {
      const q = $('#hist-q', panel).value.trim().toLowerCase();
      $('#hist-rows', panel).innerHTML = fams.filter((f) => !q || f.toLowerCase().includes(q)).map((f) => {
        const kid = state.students.find((s) => histKey(s.family_account) === histKey(f));
        return `<tr ${kid ? `data-sid="${kid.id}"` : ''}><td><b>${esc(f)}</b>${kid ? '' : ' <span class="muted small">(not in the CRM)</span>'}</td>
          ${sheets.map((sh) => { const h = cell(f, sh.as_of); return `<td class="num${h && Number(h.balance) < 0 ? ' ok-text' : ''}"${h?.note ? ` title="${esc(h.note)}"` : ''}>${h ? money(h.balance) : '—'}${h?.note ? ' *' : ''}</td>`; }).join('')}</tr>`;
      }).join('') || `<tr><td colspan="${sheets.length + 1}" class="muted">Nobody matches.</td></tr>`;
      $$('#hist-rows tr[data-sid]', panel).forEach((tr) => tr.addEventListener('click', () => openStudent(tr.dataset.sid)));
    };
    $('#hist-q', panel).addEventListener('input', draw);
    $('#hist-csv', panel).addEventListener('click', () => csvDownload('creativa-billing-sheets.csv',
      ['Family', ...sheets.map((sh) => `${sh.as_of} (tuition ${sh.period_start || ''} – ${sh.period_end || ''})`), 'Notes'],
      fams.map((f) => [f, ...sheets.map((sh) => cell(f, sh.as_of)?.balance ?? ''),
        sheets.map((sh) => cell(f, sh.as_of)?.note).filter(Boolean).join(' | ')])));
    draw();
  }

  // Reports → annual statements: every family's total for a tax year, printable one by one or all at once.
  function stmtPanel() {
    const years = [...new Set([taxYearDefault(), ...state.payments.filter((p) => FAMILY_PAYERS.has(p.payer)).map((p) => Number(p.paid_on.slice(0, 4)))])]
      .sort((a, b) => b - a);
    const year = state.stmtYear || taxYearDefault();
    return `<section class="panel" id="stmt-panel"><h2>Annual statements (for taxes)</h2>
      <p class="muted small">What each family paid in a year (January–December), with the school’s tax ID, for the child care tax credit.
        Payments from School Readiness, Step Up and VPK are left out. Brothers and sisters on the same family account share one statement.
        ${state.settings?.receipt_tax_id ? '' : '<b class="warn-text">Add the tax ID on Settings → Receipts first.</b>'}</p>
      <div class="toolbar"><select id="stmt-year" aria-label="Tax year">${years.map((y) => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <input type="search" id="stmt-q" placeholder="Search family or child…"><span class="spacer"></span>
        <button class="btn small" id="stmt-csv" type="button">Download CSV</button>
        <button class="btn small primary" id="stmt-all" type="button">Print all</button></div>
      <div class="table-wrap flat"><table><thead><tr><th>Family</th><th>Children</th><th class="num">Payments</th><th class="num">Total paid</th><th></th></tr></thead>
        <tbody id="stmt-rows"></tbody></table></div>
      ${checkListHtml()}</section>`;
  }
  // Families whose old sheets show a carried balance or a credit: what they paid each period is a best guess until
  // finance staff confirm it from the billing system.
  function checkListHtml() {
    if (!histReady()) return '';
    const flagged = [...new Set(state.history.filter((h) => h.needs_check).map((h) => h.family_account || h.customer))].sort();
    if (!flagged.length) return '';
    const edit = canEditFinance();
    return `<div class="hist-check" id="hist-check"><h3 class="sub-h">Check these Aug–Sep amounts before printing (${flagged.length})</h3>
      <p class="muted small">These families carried a balance or had a credit on the old sheets, so what they paid each period can’t be read off the
        sheet. Each box has a best guess (their regular charge). Correct any that are wrong from the billing system, then tap <b>Confirmed</b>.</p>
      ${flagged.map((f) => {
        const rows = state.history.filter((h) => (h.family_account || h.customer) === f && h.period_start && h.period_start < billing().anchor)
          .sort((a, b) => a.period_start.localeCompare(b.period_start));
        const kids = state.students.filter((s) => histKey(s.family_account) === histKey(f)).map((s) => s.name);
        return `<div class="hc-fam" data-fam="${esc(f)}"><div><b>${esc(f)}</b> <span class="muted small">${esc(kids.join(', ') || 'not in the CRM')}</span></div>
          <div class="hc-rows">${rows.map((h) => `<label>${esc(fmtDate(h.period_start))} – ${esc(fmtDate(h.period_end))}
            <span class="muted small">sheet ${money(h.balance)}</span>
            <input type="number" min="0" step="0.01" inputmode="decimal" data-hid="${h.id}" value="${h.paid != null ? Number(h.paid) : ''}" ${edit ? '' : 'disabled'} aria-label="Paid"></label>`).join('')}</div>
          ${edit ? `<button class="btn small primary" type="button" data-hc-save="${esc(f)}">Confirmed</button>` : ''}</div>`;
      }).join('')}</div>`;
  }
  function bindStmtPanel(el) {
    const panel = $('#stmt-panel', el);
    if (!panel) return;
    const year = () => Number($('#stmt-year', panel).value);
    const shown = () => {
      const q = $('#stmt-q', panel).value.trim().toLowerCase();
      return statementGroups(year()).filter((g) => !q || `${g.name} ${g.students.map((s) => s.name).join(' ')} ${g.students[0].family_account || ''}`.toLowerCase().includes(q));
    };
    const draw = () => {
      $('#stmt-rows', panel).innerHTML = shown().map((g) => `<tr data-stmt="${esc(g.key)}"><td><b>${esc(g.name)}</b>
            ${g.needsCheck ? ' <span class="pay-pill ps-open">Check Aug–Sep</span>' : ''}</td>
          <td>${esc(g.students.map((s) => s.name).join(', ') || g.customer || '')}</td><td class="num">${g.count}</td><td class="num">${money(g.total)}</td>
          <td><button class="btn small" type="button" data-print="${esc(g.key)}">Print</button></td></tr>`).join('')
        || `<tr><td colspan="5" class="muted">No family payments in ${year()}.</td></tr>`;
      $$('[data-stmt]', panel).forEach((tr) => tr.addEventListener('click', () =>
        showStatements(statementGroups(year()).filter((g) => g.key === tr.dataset.stmt), year())));
    };
    $('#stmt-year', panel).addEventListener('change', () => { state.stmtYear = year(); draw(); });
    $$('[data-hc-save]', panel).forEach((b) => b.addEventListener('click', async () => {
      const box = b.closest('.hc-fam');
      const inputs = $$('input[data-hid]', box);
      if (inputs.some((i) => i.value === '' || Number(i.value) < 0)) return toast('Fill in every period (0 if nothing was paid)', true);
      b.disabled = true;
      for (const i of inputs) {
        const { error } = await sb.from('billing_history').update({ paid: round2(Number(i.value)), needs_check: false }).eq('id', i.dataset.hid);
        if (error) { b.disabled = false; return fail(error, 'Could not save'); }
      }
      const r = await selectAll('billing_history', 'as_of');
      if (!r.error) state.history = r.data;
      toast(`${box.dataset.fam} confirmed`);
      renderReports(el);
    }));
    $('#stmt-q', panel).addEventListener('input', draw);
    $('#stmt-all', panel).addEventListener('click', () => showStatements(shown(), year()));
    $('#stmt-csv', panel).addEventListener('click', () => csvDownload(`creativa-annual-statements-${year()}.csv`,
      ['Family', 'Family account', 'Children', 'Payments', 'Total paid', 'Cash', 'Zelle', 'Card', 'Other methods'],
      shown().map((g) => {
        const by = (ks) => round2(g.payments.filter((p) => ks.includes(p.method)).reduce((t, p) => t + Number(p.amount), 0));
        return [g.name, g.students[0].family_account, g.students.map((s) => s.name).join('; '), g.payments.length, g.total,
          by(['cash']), by(['zelle']), by(['card']), by(['check', 'ach', 'other'])];
      })));
    draw();
  }

  // ───────────── To do (017): the office's to-do list ─────────────
  // Each to-do shows up on its person's Today page and in the To do tab's count from its reminder date (due date minus
  // "remind me" days) until it's checked off. Repeating ones come back for their next date when checked off.
  const canOffice = () => isAdmin() || state.me?.finance === 'edit' || state.me?.payroll === true;
  const REPEAT = { none: 'Once', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' };
  const REMIND = [[0, 'On the day'], [1, '1 day before'], [2, '2 days before'], [3, '3 days before'], [5, '5 days before'], [7, 'A week before'],
    [10, '10 days before'], [14, 'Two weeks before'], [30, 'A month before']];
  const officeStaff = () => state.staff.filter((p) => p.active && (p.role === 'admin' || p.finance === 'edit' || p.payroll));
  const dayDiff = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
  const todoMine = (t) => !t.assigned_to || t.assigned_to === state.me.id;
  const todoSoon = (mineOnly = true) => (state.todos || []).filter((t) => !t.done_at && (!mineOnly || todoMine(t)) && addDays(t.due_on, -t.remind_days) <= nyToday())
    .sort((a, b) => a.due_on.localeCompare(b.due_on) || a.title.localeCompare(b.title));
  function todoWhen(t) {
    const d = dayDiff(nyToday(), t.due_on);
    if (t.done_at) return [`Done ${fmtDate(t.done_at.slice(0, 10))}${t.done_by ? ` by ${t.done_by === state.me.id ? 'you' : staffName(t.done_by)}` : ''}`, 'done'];
    if (d < 0) return [`${-d} day${d === -1 ? '' : 's'} late (was due ${fmtDate(t.due_on)})`, 'late'];
    if (d === 0) return ['Due today', 'late'];
    return [`Due ${fmtDate(t.due_on)} · ${d === 1 ? 'tomorrow' : `in ${d} days`}`, addDays(t.due_on, -t.remind_days) <= nyToday() ? 'soon' : ''];
  }
  const todoItem = (t) => {
    const [when, cls] = todoWhen(t);
    const who = t.assigned_to ? (t.assigned_to === state.me.id ? 'You' : staffName(t.assigned_to) || 'Someone') : 'Anyone in the office';
    return `<li class="todo ${cls ? 'todo-' + cls : ''}"><input type="checkbox" class="check" data-todo-done="${t.id}" ${t.done_at ? 'checked' : ''}
        aria-label="${t.done_at ? 'Not done' : 'Done'}: ${esc(t.title)}">
      <div class="todo-main"><button class="todo-title" type="button" data-todo="${t.id}">${esc(t.title)}</button>
        <div class="small todo-when">${esc(when)} · ${esc(who)}${t.repeat !== 'none' ? ` · ${esc(REPEAT[t.repeat].toLowerCase())}` : ''}</div>
        ${t.notes && !t.done_at ? `<div class="muted small todo-notes">${esc(t.notes)}</div>` : ''}</div></li>`;
  };
  async function reloadTodos() {
    const r = await selectAll('todos', 'due_on');
    if (!r.error) state.todos = r.data;
  }
  async function toggleTodo(box, after) {
    box.disabled = true;
    const t = state.todos.find((x) => x.id === box.dataset.todoDone);
    const { data: next, error } = await sb.rpc(box.checked ? 'todo_done' : 'todo_undone', { p_id: box.dataset.todoDone });
    if (error) { box.disabled = false; box.checked = !box.checked; return fail(error, 'Could not change it'); }
    await reloadTodos();
    const n = next && state.todos.find((x) => x.id === next);
    toast(box.checked ? `Done: ${t?.title || 'to-do'}${n ? `. It’s back on ${fmtDate(n.due_on)}` : ''}` : 'Back on the list');
    drawTodoBadge();
    after();
  }
  function drawTodoBadge() {
    const n = state.hasTodos ? todoSoon().length : 0, b = $('header nav button[data-view=todo]');
    if (!b) return;
    $('.nav-badge', b)?.remove();
    if (n) b.insertAdjacentHTML('beforeend', ` <span class="nav-badge" aria-label="${n} to do">${n > 99 ? '99+' : n}</span>`);
  }
  // Today, the To do tab: check boxes and titles
  function bindTodos(root, after) {
    $$('[data-todo-done]', root).forEach((b) => b.addEventListener('change', () => toggleTodo(b, after)));
    $$('[data-todo]', root).forEach((b) => b.addEventListener('click', () => openTodo(state.todos.find((x) => x.id === b.dataset.todo), after)));
  }

  function renderTodo(el) {
    const f = state.todoFilter === 'mine' ? 'mine' : 'all';
    const keep = (t) => f === 'all' || todoMine(t);
    const open = state.todos.filter((t) => !t.done_at && keep(t)).sort((a, b) => a.due_on.localeCompare(b.due_on) || a.title.localeCompare(b.title));
    const soon = open.filter((t) => addDays(t.due_on, -t.remind_days) <= nyToday()), later = open.filter((t) => !soon.includes(t));
    const done = state.todos.filter((t) => t.done_at && keep(t)).sort((a, b) => b.done_at.localeCompare(a.done_at)).slice(0, 15);
    el.innerHTML = `<div class="toolbar"><div class="seg" role="tablist" aria-label="Whose to-dos">
        ${[['all', 'Everyone’s'], ['mine', 'Mine']].map(([k, v]) => `<button type="button" data-tf="${k}" aria-selected="${f === k}">${v}</button>`).join('')}</div>
        <span class="spacer"></span><button class="btn primary" id="todo-add" type="button">+ New to-do</button></div>
      <section class="panel"><h2>Now <span class="muted small">${soon.length}</span></h2>
        <ul class="todo-list">${soon.map(todoItem).join('') || '<li class="muted small">Nothing right now.</li>'}</ul></section>
      <section class="panel"><h2>Coming up</h2><ul class="todo-list">${later.map(todoItem).join('') || '<li class="muted small">Nothing else.</li>'}</ul></section>
      ${done.length ? `<section class="panel"><h2>Done</h2><ul class="todo-list">${done.map(todoItem).join('')}</ul></section>` : ''}
      <p class="muted small">A to-do moves to <b>Now</b>, and onto that person’s Today page, from the day you choose to be reminded until it’s checked off.
        A repeating one comes back for its next date when it’s checked off; untick it to undo.</p>`;
    $$('[data-tf]', el).forEach((b) => b.addEventListener('click', () => { state.todoFilter = b.dataset.tf; store.set('todoFilter', state.todoFilter); renderTodo(el); }));
    $('#todo-add', el).addEventListener('click', () => openTodo(null, () => renderTodo(el)));
    bindTodos(el, () => renderTodo(el));
  }

  function openTodo(t, after) {
    const x = t || { title: '', notes: '', assigned_to: null, due_on: addDays(nyToday(), 7), repeat: 'none', remind_days: 3 };
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
    const ctl = mountDrawer({
      title: t ? 'To-do' : 'New to-do',
      sub: t ? esc(todoWhen(t)[0]) : '',
      body: `<div class="section grid2">
          <label class="full">What needs to be done<input name="title" maxlength="160" value="${esc(x.title)}" placeholder="e.g. Submit the VPK attendance"></label>
          <label class="full">Notes<textarea name="notes" rows="3" maxlength="1000" placeholder="Where, how, what to check…">${esc(x.notes)}</textarea></label>
          <label>For<select name="assigned_to">${opt('', 'Anyone in the office', x.assigned_to)}${officeStaff().map((p) => opt(p.id, p.full_name || p.email, x.assigned_to)).join('')}</select></label>
          <label>Due<input type="date" name="due_on" value="${esc(x.due_on)}"></label>
          <label>Repeats<select name="repeat">${Object.entries(REPEAT).map(([k, v]) => opt(k, v, x.repeat)).join('')}</select></label>
          <label>Remind me<select name="remind_days">${REMIND.map(([k, v]) => opt(k, v, x.remind_days)).join('')}</select></label>
        </div>`,
      foot: `${t ? '<button class="btn danger" id="td-del" type="button">Delete</button>' : ''}<span class="spacer"></span>
        <button class="btn" data-close type="button">Cancel</button><button class="btn primary" id="td-save" type="button">Save</button>`,
    });
    const { drawer, form } = ctl;
    form.title.focus();
    const done = async (msg) => { ctl.dirty = false; closeDrawer(); await reloadTodos(); toast(msg); drawTodoBadge(); after(); };
    $('#td-save', drawer).addEventListener('click', async () => {
      const row = { title: form.title.value.trim(), notes: form.notes.value.trim() || null, assigned_to: form.assigned_to.value || null,
        due_on: form.due_on.value, repeat: form.repeat.value, remind_days: Number(form.remind_days.value) };
      if (!row.title) { form.title.focus(); return toast('Say what needs to be done', true); }
      if (!row.due_on) return toast('Pick when it’s due', true);
      const { error } = t ? await sb.from('todos').update(row).eq('id', t.id) : await sb.from('todos').insert(row);
      if (error) return fail(error, 'Could not save it');
      done(t ? 'Saved' : `Added: ${row.title}`);
    });
    $('#td-del', drawer)?.addEventListener('click', async () => {
      if (!confirm(`Delete “${t.title}”?${t.repeat !== 'none' ? ' It won’t come back next time either.' : ''}`)) return;
      const { error } = await sb.from('todos').delete().eq('id', t.id);
      if (error) return fail(error, 'Could not delete it');
      done('Deleted');
    });
  }

  // ───────────── Money (017): what comes in and what goes out ─────────────
  // Money in: tuition and program payments recorded on Tuition (by who paid), the food program once a claim is paid, and
  // anything added here. Money out: paychecks from Patriot (gross pay) and expenses added here. Nothing is typed twice.
  const CCFP_COL = { food: ['d', 'Food purchases'], labor: ['e', 'Food service labor and benefits'], services: ['f', 'Non-contracted purchased services'],
    supplies: ['g', 'Non-food supplies and expendable equipment'], equipment: ['h', 'Food service equipment'], transport: ['i', 'Transportation'],
    other: ['j', 'Other costs'] };
  const MONEY_CATS = {
    in: ['FES / Step Up deposit', 'School Readiness (ELC) deposit', 'VPK (ELC) deposit', 'Registration fees', 'Fundraising', 'Other income'],
    out: ['Food', 'Food service labor', 'Supplies', 'Classroom materials', 'Rent', 'Utilities', 'Insurance', 'Maintenance & repairs', 'Payroll taxes',
      'Bank & card fees', 'Other'],
  };
  const CCFP_STATUS = { draft: 'Not sent yet', submitted: 'Submitted · pending', paid: 'Paid' };
  const CCFP_PILL = { draft: 'none', submitted: 'open', paid: 'paid' };
  const ccfpTotal = (c) => round2(Number(c.meal_earnings || 0) + Number(c.cash_in_lieu || 0) + Number(c.adjustments || 0));
  const ccfpMeals = (c) => ['breakfasts', 'am_snacks', 'lunches', 'pm_snacks', 'suppers', 'eve_snacks'].reduce((t, k) => t + Number(c[k] || 0), 0);
  const sumAmt = (xs) => round2(xs.reduce((t, x) => t + Number(x.amount), 0));
  async function loadMoney() {
    const [m, c, pc, bl] = await Promise.all([selectAll('money_entries', 'on_date'), sb.from('ccfp_claims').select('*').order('claim_month', { ascending: false }),
      canPayroll() ? selectAll('paychecks', 'pay_date') : Promise.resolve({ error: true }),
      sb.from('bills').select('*').order('sort').order('name')]);   // missing until 020
    state.money = m.error || c.error ? null : { entries: m.data, claims: c.data, paychecks: pc.error ? null : pc.data, bills: bl.error ? null : bl.data };
  }
  function moneyMonth(ym) {
    const M = state.money, inMonth = (d) => !!d && d.slice(0, 7) === ym, ins = [], outs = [];
    const add = (arr, key, label, amount, sub = '') => {
      if (!amount) return;
      const x = arr.find((r) => r.key === key);
      if (x) x.amount = round2(x.amount + amount); else arr.push({ key, label, amount: round2(amount), sub });
    };
    const pays = (state.payments || []).filter((p) => inMonth(p.paid_on));
    Object.keys(PAYER).forEach((k) => {
      const ps = pays.filter((p) => p.payer === k);
      add(ins, `pay:${k}`, k === 'parent' ? 'Tuition and fees from families' : `${PAYER[k]} (recorded on Tuition)`, sumAmt(ps),
        Object.keys(METHOD).map((mk) => [METHOD[mk], sumAmt(ps.filter((p) => p.method === mk))]).filter(([, v]) => v).map(([l, v]) => `${l} ${money(v)}`).join(' · '));
    });
    const anchor = state.settings?.billing_anchor || '9999-12-31';   // before the CRM billed: what the old system's sheets say was paid
    add(ins, 'old', 'Tuition paid in the old billing system', round2((state.history || []).filter((h) => h.paid != null && h.period_start < anchor
      && inMonth(h.period_start)).reduce((t, h) => t + Number(h.paid), 0)), 'Balance Summary sheets, by billing period');
    M.claims.filter((c) => c.status === 'paid' && inMonth(c.paid_on))
      .forEach((c) => add(ins, 'ccfp', 'Child Care Food Program', Number(c.paid_amount ?? ccfpTotal(c)), `claim for ${fmtMonth(c.claim_month.slice(0, 7))}`));
    if (M.paychecks) add(outs, 'payroll', 'Payroll (gross pay, from Patriot)', round2(M.paychecks.filter((p) => inMonth(p.pay_date)).reduce((t, p) => t + Number(p.gross), 0)));
    M.entries.filter((e) => inMonth(e.on_date) && e.in_totals).forEach((e) => add(e.kind === 'in' ? ins : outs, `${e.kind}:${e.category}`, e.category, Number(e.amount)));
    const tin = round2(ins.reduce((t, x) => t + x.amount, 0)), tout = round2(outs.reduce((t, x) => t + x.amount, 0));
    const byAmt = (a, b) => b.amount - a.amount;
    return { ins: ins.sort(byAmt), outs: outs.sort(byAmt), tin, tout, net: round2(tin - tout) };
  }

  // ───── Projection (019): the coming months, from each child's rate and start date ─────
  // Money in: every enrolled child's rate for each billing period they'll be here (from their start date, until a last day
  // set on their page), by who pays (private, FES, SR's family share, Kindergarten on Step Up pending); VPK and SR payments,
  // the food program at the average of its last claims, and other money in at their recent averages.
  // Possible: families in the Pipeline (and on the waiting list) with a start date and tuition. Money out: payroll at the
  // last payrolls' average on its two-week schedule, and expenses at their recent average.
  const monthShort = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  const monthLong = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const money0 = (n) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;   // projections: whole dollars
  const FREQ_TEXT = { weekly: 'a week', biweekly: 'every 2 weeks', monthly: 'a month', school_year: 'a school year' };
  function usualRate(program) {   // the class's 2-week rates (020), or the most common 2-week rate in that class, as a hint
    const cls = state.classrooms.find((c) => c.name === program);
    const rs = cls ? classRates(cls.id) : [];
    if (rs.length) return rs.map((r) => rateAs(r, 'biweekly').amount).join(' or ');
    const rates = state.students.filter((s) => s.status === 'enrolled' && (!cls || s.classroom_id === cls.id))
      .map((s) => state.finance[s.id]).filter((f) => f && f.tuition_frequency === 'biweekly' && Number(f.tuition_amount) > 0 && f.bill_family !== false)
      .map((f) => Number(f.tuition_amount));
    if (!rates.length) return 'e.g. 560';
    const top = [...new Set(rates)].sort((a, b) => rates.filter((x) => x === b).length - rates.filter((x) => x === a).length)[0];
    return `usually ${top}`;
  }
  function periodsIn(ym) {   // billing periods that start in the month
    const { days } = billing(), first = monthStart(ym), last = monthEnd(ym), out = [];
    let p = periodOf(first);
    if (p < first) p = addDays(p, days);
    for (; p <= last; p = addDays(p, days)) out.push(p);
    return out;
  }
  function childInMonth(rate, freq, start, last, ym) {   // starting in a period's second week pays just that week
    if (!(Number(rate) > 0)) return 0;
    const here = (!start || start <= monthEnd(ym)) && (!last || last >= monthStart(ym));
    if (freq === 'monthly') return here ? Number(rate) : 0;
    if (freq === 'school_year') return here && !['06', '07'].includes(ym.slice(5, 7)) ? round2(Number(rate) / 10) : 0;   // 10 payments, Aug–May
    const { days } = billing();
    return round2(periodsIn(ym).reduce((t, p) => {
      const end = addDays(p, days - 1);
      if ((start && start > end) || (last && last < p)) return t;
      const full = Number(rate) * (freq === 'weekly' ? 2 : 1);
      return t + (start && start >= addDays(p, 7) ? full / 2 : full);
    }, 0));
  }
  // Tuition for one week (Mon–Fri): a weekly rate, half a two-week rate; a school-year rate is a tenth of it a month, Aug–May.
  // Families pay through holidays and breaks (no credit), so closed days don't change it.
  function childInWeek(rate, freq, start, last, mon) {
    if (!(Number(rate) > 0) || (start && start > addDays(mon, 4)) || (last && last < mon)) return 0;
    const r = Number(rate);
    if (freq === 'weekly') return r;
    if (freq === 'biweekly') return r / 2;
    if (freq === 'school_year') return ['06', '07'].includes(mon.slice(5, 7)) ? 0 : (r / 10) * 12 / 52;
    return (r * 12) / 52;   // monthly
  }
  const closuresIn = (from, to) => (state.closures || []).filter((c) => c.starts_on <= to && c.ends_on >= from);
  function weekTuition(mon) {   // the tuition expected for the week starting that Monday, by who pays
    const w = { mon, fri: addDays(mon, 4), private: 0, fes: 0, sr: 0, kinder: 0, total: 0, billed: 0, starting: 0, leaving: 0 };
    const kids = state.students.filter((s) => s.status === 'enrolled' || (LEFT.has(s.status) && s.withdrawn_on && s.withdrawn_on >= mon))
      .map((s) => ({ fr: state.finance[s.id] || {}, start: s.start_date, last: LEFT.has(s.status) ? s.withdrawn_on : null }))
      .map((k) => ({ ...k, amount: k.fr.tuition_amount, freq: k.fr.tuition_frequency }))
      .concat(newFamilies().filter((f) => f.plan === 'start').map((f) => ({ fr: f.fr, start: f.start, last: null, amount: f.rate.amount, freq: f.rate.freq })));
    kids.forEach(({ fr, start, last, amount, freq }) => {
      const x = childInWeek(amount, freq, start, last, mon);
      if (!x) return;
      w[paysFor(fr)] += x;
      w.total += x;
      // What goes on the families' bill every two weeks (create_period_invoices): not Kindergarten (Step Up pending), not "don't bill".
      if (['weekly', 'biweekly'].includes(freq) && fr.bill_family !== false && paysFor(fr) !== 'kinder') w.billed += x;
      if (start && start >= mon && start <= w.fri) w.starting++;
      if (last && last <= w.fri) w.leaving++;
    });
    w.closed = closuresIn(mon, w.fri).map((c) => c.name.replace(/ \(staff (not )?paid\)$/, ''));
    return w;
  }
  // The box at the top of Tuition: this week (next week on a weekend) and the three after it.
  function weekBoxHtml() {
    const today = nyToday(), dow = new Date(`${today}T12:00:00`).getDay();
    const first = addDays(today, dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow);
    const weeks = [0, 1, 2, 3].map((k) => weekTuition(addDays(first, 7 * k)));
    const w0 = weeks[0], label0 = dow === 0 || dow === 6 ? 'Next week' : 'This week', split = [['private', 'Private-pay families'], ['fes', 'FES / Step Up'], ['sr', 'School Readiness families’ share'], ['kinder', 'Kindergarten (Step Up pending)']]
      .filter(([k]) => w0[k] > 0);
    const notes = (w) => [w.starting && `${w.starting} starting`, w.leaving && `${w.leaving} leaving`, ...w.closed.map((c) => `${c}: tuition still due`)].filter(Boolean);
    return `<section class="panel week-box" id="week-box"><div class="wb-head"><h2>Tuition expected each week</h2>
        <span class="muted small">From each child’s rate. Two weeks of “on the bill” make one bill; Kindergarten (Step Up) and children not billed to their family aren’t on it.</span></div>
      <div class="wb-weeks">${weeks.map((w, i) => `<div class="wb-week ${i === 0 ? 'wb-now' : ''}">
          <span class="wb-label">${i === 0 ? label0 : `Week of ${esc(fmtDate(w.mon))}`}</span>
          <b>${money0(w.total)}</b><span class="muted small">${esc(fmtDate(w.mon))} – ${esc(fmtDate(w.fri))}</span>
          ${round2(w.billed) !== round2(w.total) ? `<span class="muted small">On the bill: ${money(round2(w.billed))}</span>` : ''}
          ${notes(w).map((t) => `<span class="small wb-note">${esc(t)}</span>`).join('')}</div>`).join('')}</div>
      ${split.length > 1 ? `<p class="small wb-split">${label0}: ${split.map(([k, label]) => `${esc(label)} <b>${money0(w0[k])}</b>`).join(' · ')}</p>` : ''}</section>`;
  }
  // A family that hasn't started: their own rate, or else their class's full-time rate (every 2 weeks; Kindergarten a school year).
  function startRate(amount, freq, classId) {
    if (Number(amount) > 0) return { amount: Number(amount), freq, cls: false };
    const r = classRates(classId)[0];
    return r ? { ...rateAs(r, 'biweekly'), cls: true } : null;
  }
  // The class a Pipeline program starts in: its name, and 15–17 months starts with the toddlers in 18–23 months (same rate).
  const classIdOf = (program) => {
    const p = String(program || '').trim().toLowerCase();
    const byName = (n) => state.classrooms.find((c) => c.name.toLowerCase() === n)?.id;
    return byName(p) || (p === '15–17 months' ? byName('18–23 months') : undefined);
  };
  // The same child in Enrollment and the Pipeline: one was made from the other, or the same name, or the same phone and first name.
  function sameChild(st, i) {
    if (st.inquiry_id && st.inquiry_id === i.id) return true;
    const a = normName(st.name), b = normName(i.child_name);
    if (a && a === b) return true;
    const p1 = digits(st.parent_phone).slice(-10), p2 = digits(i.phone).slice(-10);
    return !!b && p1.length === 10 && p1 === p2 && a.split(' ')[0] === b.split(' ')[0];
  }
  // Families who haven't started, each child once: the Enrollment waiting list matched up with the Pipeline, and Pipeline
  // families with a start date or at Waitlisted. A start date + registration paid = starting (counted in money in); a start
  // date without it = possible; no start date = not counted. No rate? Their class's full-time rate.
  function newFamilies() {
    const open = state.inquiries.filter((i) => !CLOSED.has(i.stage)), used = new Set();
    const fam = (st, i) => {
      const fr = st ? state.finance[st.id] || {} : {}, start = st?.start_date || i?.start_on || null;
      const rate = (st && Number(fr.tuition_amount) > 0 && startRate(fr.tuition_amount, fr.tuition_frequency))
        || (i && Number(i.expected_tuition) > 0 && startRate(i.expected_tuition, i.expected_freq))
        || startRate(null, null, st?.classroom_id || classIdOf(i?.program));
      const paid = (st && regPaid(st)) || !!i?.reg_paid_on;
      return { st, i, fr, name: st?.name || i.child_name || i.parent_name || 'A family', start, rate, paid,
        classId: st?.classroom_id || classIdOf(i?.program), plan: !start || !rate ? 'none' : paid ? 'start' : 'maybe' };
    };
    const out = state.students.filter((st) => st.status === 'waitlist').map((st) => {
      const i = open.find((x) => !used.has(x.id) && sameChild(st, x));
      if (i) used.add(i.id);
      return fam(st, i);
    });
    open.filter((i) => !used.has(i.id) && (i.start_on || i.stage === 'waitlisted')
      && !state.students.some((st) => st.status !== 'waitlist' && sameChild(st, i))).forEach((i) => out.push(fam(null, i)));
    return out.sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999') || a.name.localeCompare(b.name));
  }
  // Who pays a child's tuition, for the projection's lines.
  const PROJ_PAYS = { private: 'Tuition from private-pay families', fes: 'FES / Step Up scholarships', sr: 'School Readiness (family’s share)',
    kinder: 'Kindergarten, Step Up (pending)' };
  function paysFor(fr) {
    const f = fr.funding || [];
    return f.includes('stepup_pending') ? 'kinder' : f.includes('fes_ua') || f.includes('fes_eo') ? 'fes' : f.includes('sr') ? 'sr' : 'private';
  }
  function projection(months) {
    const M = state.money, from = monthStart(months[0]);
    const lastDay = (s) => (LEFT.has(s.status) ? s.withdrawn_on : null);
    const here = state.students.filter((s) => s.status === 'enrolled' || (LEFT.has(s.status) && s.withdrawn_on && s.withdrawn_on >= from));
    const fin = (s) => state.finance[s.id] || {};
    const per = (fn) => months.map(fn);
    const tuition = (kids) => per((m) => round2(kids.reduce((t, s) => t + childInMonth(fin(s).tuition_amount, fin(s).tuition_frequency, s.start_date, lastDay(s), m), 0)));
    const claims = M.claims.filter((c) => ccfpTotal(c) > 0).sort((a, b) => b.claim_month.localeCompare(a.claim_month)).slice(0, 3);
    const ccfp = claims.length ? round2(claims.reduce((t, c) => t + ccfpTotal(c), 0) / claims.length) : 0;
    const past = [1, 2, 3].map((k) => shiftMonth(thisMonth(), -k));
    const avgOf = (rows, dateKey) => {   // average of the last 3 months that have any (this month, when only it has)
      const has = (m) => rows.some((r) => r[dateKey].slice(0, 7) === m);
      const ms = past.some(has) ? past.filter(has) : [thisMonth()].filter(has);
      return ms.length ? round2(ms.reduce((t, m) => t + sumAmt(rows.filter((r) => r[dateKey].slice(0, 7) === m)), 0) / ms.length) : 0;
    };
    const bills = M.bills || [], billCats = new Set(bills.map((b) => b.category.toLowerCase()));
    // Other expenses leave out bill payments and anything in a bill's category (so rent isn't counted twice).
    const recentAvg = (kind) => avgOf(M.entries.filter((e) => e.kind === kind && e.in_totals && !(kind === 'out' && (e.bill_id || billCats.has(e.category.toLowerCase())))), 'on_date');
    const programPays = avgOf((state.payments || []).filter((x) => x.payer === 'vpk' || x.payer === 'sr'), 'paid_on');
    const pc = M.paychecks || [], runs = [...new Set(pc.map((p) => p.pay_date))].sort();
    const gross = (d) => pc.filter((p) => p.pay_date === d).reduce((t, p) => t + Number(p.gross), 0);
    const payAvg = runs.length ? round2(runs.slice(-2).reduce((t, d) => t + gross(d), 0) / runs.slice(-2).length) : 0;
    const lastRun = runs[runs.length - 1];
    const payDates = (m) => {   // the two-week pay schedule, through the last payroll's date
      if (!lastRun) return [];
      const out = [];
      for (let d = addDays(lastRun, 14 * Math.ceil(daysBetween(lastRun, monthStart(m)) / 14)); d <= monthEnd(m); d = addDays(d, 14)) out.push(d);
      return out;
    };
    // The share of a payday's pay period that staff are paid for: weekdays on the school calendar (021) marked "staff not paid"
    // (one week of winter break) come off. The period is placed like the last payroll's (its end that many days before payday).
    const lastPc = pc.find((x) => x.pay_date === lastRun);
    const endGap = lastPc ? daysBetween(lastPc.period_end, lastRun) : 7, len = lastPc ? daysBetween(lastPc.period_start, lastPc.period_end) + 1 : 14;
    const unpaid = (state.closures || []).filter((c) => !c.staff_paid);
    const unpaidIn = (d) => {
      const end = addDays(d, -endGap), start = addDays(end, 1 - len);
      let work = 0, off = 0;
      for (let x = start; x <= end; x = addDays(x, 1)) {
        if ([0, 6].includes(new Date(`${x}T12:00:00`).getDay())) continue;
        work++;
        if (unpaid.some((c) => x >= c.starts_on && x <= c.ends_on)) off++;
      }
      return { share: work ? (work - off) / work : 1, names: unpaid.filter((c) => c.starts_on <= end && c.ends_on >= start).map((c) => c.name) };
    };
    const fams = newFamilies(), starting = fams.filter((x) => x.plan === 'start'), waiting = fams.filter((x) => x.plan === 'maybe');
    const sumRates = (xs) => per((m) => round2(xs.reduce((t, x) => t + childInMonth(x.rate.amount, x.rate.freq, x.start, null, m), 0)));
    const possible = sumRates(waiting);
    const kids = (k) => here.filter((s) => paysFor(fin(s)) === k);
    const rows = {
      ...Object.fromEntries(Object.keys(PROJ_PAYS).map((k) => [k, tuition(kids(k))])),
      programs: per(() => programPays), ccfp: per(() => ccfp), other: per(() => recentAvg('in')),
      payroll: per((m) => round2(payDates(m).reduce((t, d) => t + payAvg * unpaidIn(d).share, 0))), bills: per((m) => round2(bills.reduce((t, b) => t + Number(b.amount) * billDues(b, m).length, 0))),
      expenses: per(() => recentAvg('out')), possible, waitlist: sumRates(starting),
    };
    const sumAt = (keys, i) => round2(keys.reduce((t, k) => t + rows[k][i], 0));
    rows.tin = per((m, i) => sumAt([...Object.keys(PROJ_PAYS), 'waitlist', 'programs', 'ccfp', 'other'], i));
    rows.tout = per((m, i) => sumAt(['payroll', 'bills', 'expenses'], i));
    rows.net = per((m, i) => round2(rows.tin[i] - rows.tout[i]));
    rows.netPossible = per((m, i) => round2(rows.net[i] + rows.possible[i]));
    const end = monthEnd(months[months.length - 1]);
    const coming = [
      ...here.filter((s) => s.start_date && s.start_date >= from && s.start_date <= end)
        .map((s) => ({ kind: 'start', who: s.name, on: s.start_date, where: 'Enrolled', rate: fin(s).tuition_amount, freq: fin(s).tuition_frequency, sid: s.id })),
      ...here.filter((s) => lastDay(s) && lastDay(s) <= end)
        .map((s) => ({ kind: 'leave', who: s.name, on: lastDay(s), where: STUDENT_STATUS[s.status], rate: fin(s).tuition_amount, freq: fin(s).tuition_frequency, sid: s.id })),
    ].sort((a, b) => a.on.localeCompare(b.on));
    const counts = Object.fromEntries(Object.keys(PROJ_PAYS).map((k) => [k, kids(k).filter((s) => s.status === 'enrolled').length]));
    const meta = months.map((m) => ({ bills: periodsIn(m).length, paydays: payDates(m).length,
      unpaid: [...new Set(payDates(m).filter((d) => unpaidIn(d).share < 1).flatMap((d) => unpaidIn(d).names))],
      closed: [...new Set(closuresIn(monthStart(m), monthEnd(m)).map((c) => c.name.replace(/ \(staff (not )?paid\)$/, '')))] }));
    return { rows, ccfp, claims: claims.length, payAvg, coming, counts, meta, noPayroll: !M.paychecks, fams, starting, bills, billCats: [...new Set(bills.map((b) => b.category))] };
  }
  // Enrolled children with no rate, or a rate that isn't their class's and no note saying why (020).
  const ratesToCheck = () => state.students.filter((s) => s.status === 'enrolled')
    .map((s) => ({ s, fr: state.finance[s.id] || {}, c: rateCheck(s.classroom_id, state.finance[s.id] || {}) }))
    .filter(({ fr, c }) => c && (c.none || (c.diff && !fr.rate_note)))
    .sort((a, b) => (state.classrooms.find((c) => c.id === a.s.classroom_id)?.sort || 0) - (state.classrooms.find((c) => c.id === b.s.classroom_id)?.sort || 0)
      || byLastName(a.s.name, b.s.name));
  async function setClassRate(s, r) {
    const fr = state.finance[s.id], a = rateAs(r, fr?.tuition_frequency);
    const q = fr ? sb.from('student_finance').update({ tuition_amount: a.amount, tuition_frequency: a.freq }).eq('student_id', s.id)
      : sb.from('student_finance').insert({ student_id: s.id, tuition_amount: a.amount, tuition_frequency: a.freq });
    const { data, error } = await q.select().single();
    if (error) { fail(error, 'Could not set the rate'); return false; }
    state.finance[s.id] = data;
    toast(`${s.name}: ${r.label.toLowerCase()}, ${money(a.amount)} ${FREQ_TEXT[a.freq]}`);
    return true;
  }

  // Money in and out by month: two thin columns a month (in, out) on one axis, left over written above (≤ 6 months).
  function projChart(months, R) {
    const n = months.length, gw = 64, H = 190, top = 26, base = 160, W = n * gw + 44;
    const max = Math.max(1, ...R.tin, ...R.tout), step = [1000, 2500, 5000, 10000, 20000, 25000, 50000, 100000].find((x) => max / x <= 4) || 250000;
    const topVal = Math.ceil((max * 1.08) / step) * step;
    const ticks = Array.from({ length: topVal / step + 1 }, (_, i) => i * step);
    const y = (v) => base - ((base - top) * v) / topVal;
    const bar = (x, v, cls) => { const t = y(v), w = 18, r = Math.min(4, base - t); return v > 0
      ? `<path class="${cls}" d="M${x} ${base} V${t + r} Q${x} ${t} ${x + r} ${t} H${x + w - r} Q${x + w} ${t} ${x + w} ${t + r} V${base} Z"/>` : ''; };
    const k = (v) => (v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${v}`);
    return `<svg class="proj-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Money in and out by month (the table below has every number)">
      ${ticks.map((t) => `<line class="pc-grid" x1="40" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="pc-tick" x="36" y="${y(t) + 4}" text-anchor="end">${k(t)}</text>`).join('')}
      ${months.map((m, i) => { const x = 44 + i * gw + 12; return `<g class="pc-month" data-month="${m}" tabindex="0">
        <title>${esc(monthLong(m))}: in ${money0(R.tin[i])}, out ${money0(R.tout[i])}, left over ${money0(R.net[i])}</title>
        <rect class="pc-hit" x="${x - 10}" y="${top - 22}" width="${gw - 4}" height="${H - top + 22}"/>
        ${bar(x, R.tin[i], 'pc-in')}${bar(x + 20, R.tout[i], 'pc-out')}
        ${n <= 6 ? `<text class="pc-net ${R.net[i] < 0 ? 'neg' : ''}" x="${x + 19}" y="${Math.min(y(R.tin[i]), y(R.tout[i])) - 6}" text-anchor="middle">${money0(R.net[i])}</text>` : ''}
        <text class="pc-label" x="${x + 19}" y="${base + 18}" text-anchor="middle">${esc(monthShort(m).split(' ')[0])}</text></g>`; }).join('')}
    </svg>`;
  }

  function drawProjection(body, el) {
    const n = [3, 6, 12].includes(state.projMonths) ? state.projMonths : 6;
    const months = Array.from({ length: n }, (_, i) => shiftMonth(thisMonth(), i));
    const P = projection(months), R = P.rows, edit = canEditFinance();
    const avg = (xs) => round2(xs.reduce((t, x) => t + x, 0) / xs.length);
    const kidsSub = (k, text) => `${P.counts[k]} child${P.counts[k] === 1 ? '' : 'ren'}, ${text}`;
    const LINES = [
      ['in', 'Money in'],
      ['private', PROJ_PAYS.private, '', kidsSub('private', 'each one’s rate from their start date')],
      ['fes', PROJ_PAYS.fes, '', kidsSub('fes', 'at their rate')],
      ['sr', PROJ_PAYS.sr, '', kidsSub('sr', 'the family’s share only')],
      ['kinder', PROJ_PAYS.kinder, '', kidsSub('kinder', 'at their school-year rate, 10 payments Aug–May')],
      ['waitlist', 'New families starting (registration paid)', '', `${P.starting.length} child${P.starting.length === 1 ? '' : 'ren'}, from their start date`],
      ['programs', 'VPK and School Readiness payments', '', 'average of recent months recorded on Tuition'],
      ['ccfp', 'Child Care Food Program', '', P.claims ? `average of the last ${P.claims} claim${P.claims === 1 ? '' : 's'}` : 'no claims recorded yet'],
      ['other', 'Other money in', '', 'average of recent months on Money'],
      ['tin', 'Money in', 'proj-total'],
      ['out', 'Money out'],
      ['payroll', 'Payroll', '', P.noPayroll ? 'needs Payroll access to see' : P.payAvg ? `about ${money0(P.payAvg)} gross every 2 weeks, less staff days not paid` : 'no paychecks recorded yet'],
      ['bills', 'Rent and bills', '', P.bills.length ? `${P.bills.map((b) => b.name).join(', ')}, on their days (Money → Bills)` : 'add rent and monthly bills on Money → Bills'],
      ['expenses', P.bills.length ? 'Other expenses' : 'Expenses', '', `average of recent months on Money${P.billCats.length ? `, not counting ${P.billCats.join(', ')}` : ''}`],
      ['tout', 'Money out', 'proj-total'],
      ['left', 'Left over'],
      ['net', 'Left over', 'proj-total'],
      ['possible', 'New families starting (possible)', 'proj-possible', 'a start date but registration not paid yet'],
      ['netPossible', 'Left over if they start', 'proj-total proj-possible'],
    ].filter(([k]) => !R[k] || ['tin', 'tout', 'net', 'ccfp', 'payroll', 'bills', 'expenses', 'private'].includes(k) || R[k === 'netPossible' ? 'possible' : k].some((x) => x));
    const notes = (i) => [P.meta[i].bills === 3 && '3 tuition bills this month', P.meta[i].paydays === 3 && '3 paydays this month',
      ...P.meta[i].unpaid.map((c) => `${c.replace(/ \(staff not paid\)$/, '')}: staff paid for part of it`)].filter(Boolean);
    const note = (i) => [P.meta[i].bills === 3 && '3 billing periods', P.meta[i].paydays === 3 && '3 paydays'].filter(Boolean).join(' · ');
    const cell = (x) => (x ? money0(x) : '<span class="muted">—</span>');
    const check = state.hasClassRates ? ratesToCheck() : [];
    const lo = R.net.indexOf(Math.min(...R.net)), hi = R.net.indexOf(Math.max(...R.net));
    const A = moneyMonth(months[0]), prev = shiftMonth(months[0], -1), L = moneyMonth(prev);   // what really came in and went out (Money → In & out)
    const why = (i) => (notes(i)[0] ? ` (${notes(i)[0].replace(/ this month$/, '')})` : '');
    const moneyLines = (i, keys) => LINES.filter(([k]) => keys.includes(k) && R[k] && (R[k][i] || ['payroll', 'private'].includes(k)))
      .map(([k, label]) => `<li><span>${esc(label)}</span><b>${money0(R[k][i])}</b></li>`).join('');
    body.innerHTML = `<div class="toolbar"><span class="muted small">What to expect in the coming months, from today’s children, rates, payroll and bills: an estimate, not what’s been paid.</span>
        <span class="spacer"></span><div class="seg" role="tablist" aria-label="How many months">
        ${[3, 6, 12].map((k) => `<button type="button" data-pm="${k}" aria-selected="${n === k}">${k} months</button>`).join('')}</div></div>
      <section class="panel proj-summary">
        <p class="ps-big">About <b class="${avg(R.net) < 0 ? 'neg' : ''}">${money0(avg(R.net))}</b> left over a month</p>
        <p>Over the next ${n} months, about <b>${money0(avg(R.tin))}</b> a month comes in and <b>${money0(avg(R.tout))}</b> goes out.</p>
        ${n > 1 ? `<p class="small">Tightest month: <b>${esc(monthLong(months[lo]))}</b>, ${money0(R.net[lo])}${esc(why(lo))}. Best month: <b>${esc(monthLong(months[hi]))}</b>, ${money0(R.net[hi])}${esc(why(hi))}.</p>` : ''}
        ${L.tin || L.tout ? `<p class="small">Last month (${esc(monthLong(prev))}), <b>${money0(L.tin)}</b> came in and <b>${money0(L.tout)}</b> went out.</p>` : ''}
        ${avg(R.possible) ? `<p class="small">If the new families in the Pipeline start, about <b>${money0(avg(R.possible))}</b> more a month.</p>` : ''}
        ${check.length ? `<p class="small proj-check-note">${check.length} child${check.length === 1 ? ' has' : 'ren have'} no rate or a rate that isn’t their class’s: <a href="#proj-rates">check them</a>.</p>` : ''}
        <div class="proj-chart">${projChart(months, R)}</div>
        <p class="pc-legend small"><span><i class="sw sw-in"></i>Money in</span><span><i class="sw sw-out"></i>Money out</span>
          <span class="muted">${n <= 6 ? 'Left over is written above each month. ' : ''}Tap a month for its details.</span></p>
      </section>
      <div class="proj-cards">${months.map((m, i) => `<article class="panel proj-month" id="pm-${m}">
          <header class="pm-head"><h3>${esc(monthLong(m))}</h3>${notes(i).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</header>
          ${P.meta[i].closed.length ? `<p class="muted small pm-closed">Closed: ${esc(P.meta[i].closed.join(', '))} (tuition still due)</p>` : ''}
          <p class="pm-left ${R.net[i] < 0 ? 'neg' : ''}"><span>${R.net[i] < 0 ? 'Short' : 'Left over'}</span><b>${money0(R.net[i])}</b></p>
          <p class="pm-io"><span><i class="sw sw-in"></i>Money in</span><b>${money0(R.tin[i])}</b></p>
          <p class="pm-io"><span><i class="sw sw-out"></i>Money out</span><b>${money0(R.tout[i])}</b></p>
          ${R.possible[i] ? `<p class="pm-io pm-maybe"><span>If the new families start</span><b>+${money0(R.possible[i])}</b></p>` : ''}
          ${i === 0 ? `<div class="pm-actual"><p class="pm-io"><span>Came in so far</span><b>${money0(A.tin)}</b></p>
            <p class="pm-io"><span>Went out so far</span><b>${money0(A.tout)}</b></p>
            <p class="muted small">What’s recorded through today (Money → In &amp; out).</p></div>` : ''}
          <details class="pm-more"><summary>What’s in it</summary>
            <h4>Money in</h4><ul class="money-lines">${moneyLines(i, ['private', 'fes', 'sr', 'kinder', 'waitlist', 'programs', 'ccfp', 'other'])}</ul>
            <h4>Money out</h4><ul class="money-lines">${moneyLines(i, ['payroll', 'bills', 'expenses'])}</ul></details></article>`).join('')}</div>
      <details class="panel proj-table-box"><summary>See every number as a table</summary>
        <div class="table-wrap"><table class="proj"><thead><tr><th></th>${months.map((m, i) => `<th class="num">${esc(monthShort(m))}${note(i) ? `<div class="muted small">${esc(note(i))}</div>` : ''}</th>`).join('')}</tr></thead>
        <tbody>${LINES.map(([k, label, cls = '', sub = '']) => (!R[k] ? `<tr class="proj-group"><th colspan="${n + 1}">${esc(label)}</th></tr>`
          : `<tr class="${cls}"><th>${esc(label)}${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}</th>
            ${R[k].map((x) => `<td class="num ${x < 0 ? 'neg' : ''}">${cell(x)}</td>`).join('')}</tr>`)).join('')}</tbody></table></div></details>
      ${P.fams.length ? `<section class="panel" id="proj-wait"><h2>New families</h2>
        <p class="muted small">The waiting list and families in the Pipeline, each child once. A <b>start date</b> and <b>registration paid</b> = counted
          as starting; a start date without registration = possible; no start date = not counted yet. No rate? Their class’s full-time rate.</p>
        <ul class="rate-check">${P.fams.map((x) => `<li><a href="#" ${x.st ? `data-open-sid="${x.st.id}"` : `data-open-iid="${x.i.id}"`}><b>${esc(x.name)}</b></a>
          <span class="muted small">${esc([classroomName(x.classId), x.i ? `Pipeline: ${STAGE_LABEL[x.i.stage]}` : 'Waiting list', `registration ${x.paid ? 'paid' : 'not paid'}`].filter(Boolean).join(' · '))}</span>
          ${x.st && x.i && x.i.stage !== 'waitlisted' ? `<div class="small rate-off">On the Enrollment waiting list, but ${esc(STAGE_LABEL[x.i.stage])} in the Pipeline. Not on the waiting list yet? Open
            <a href="#" data-open-sid="${x.st.id}">their Enrollment page</a> and delete it (the Pipeline family stays).</div>` : ''}
          <div class="small ${x.plan === 'none' ? 'rate-off' : ''}">${x.plan === 'none' ? (x.start ? 'Not counted: no rate and no class rate' : `Not counted: add a start date ${x.st ? 'on their page' : '(Starts on, in the Pipeline)'}`)
            : `${x.plan === 'start' ? 'Counted from' : 'Possible from'} ${esc(fmtDate(x.start))} · ${money(x.rate.amount)} ${esc(FREQ_TEXT[x.rate.freq] || '')}${x.rate.cls ? ' (class rate)' : ''}`}</div></li>`).join('')}</ul></section>` : ''}
      ${check.length ? `<section class="panel" id="proj-rates"><h2>Rates to check</h2>
        <p class="muted small">Children with no rate, or a rate that isn’t one of their class’s (Settings → Classes). ${edit ? 'Tap the class rate to use it.' : ''}
          A different rate on purpose (a sibling discount…)? Open the child and write why under <b>Why the rate is different</b>; they come off this list.</p>
        <ul class="rate-check">${check.map(({ s, fr, c }) => `<li data-sid="${s.id}">
          <a href="#" data-open-sid="${s.id}"><b>${esc(s.name)}</b></a> <span class="muted small">${esc(classroomName(s.classroom_id))}${(fr.funding || []).length ? ` · ${esc(fundingText(s.id))}` : ''}</span>
          <div class="small">${c.none ? 'No rate yet' : `${money(fr.tuition_amount)} ${esc(FREQ_TEXT[fr.tuition_frequency] || '')}: ${esc(c.text)}`}</div>
          ${edit ? `<div class="rate-opts">${c.rs.map((r) => `<button type="button" class="btn small" data-set-rate="${r.k}">${esc(r.label)} · ${esc(rateText(r))}</button>`).join('')}</div>` : ''}</li>`).join('')}</ul></section>` : ''}
      <section class="panel"><h2>Starting and leaving</h2>
        <div class="table-wrap flat"><table><thead><tr><th>Child</th><th>When</th><th class="num">Tuition</th></tr></thead>
          <tbody id="proj-coming">${P.coming.map((x) => `<tr ${x.sid ? `data-sid="${x.sid}"` : `data-iid="${x.iid}"`} class="proj-${x.kind}">
            <td><b>${esc(x.who)}</b><div class="muted small">${esc(x.where)}</div></td>
            <td>${x.kind === 'leave' ? 'Last day ' : x.kind === 'maybe' ? 'Could start ' : 'Starts '}${esc(fmtDate(x.on))}</td>
            <td class="num">${Number(x.rate) > 0 ? `${money(x.rate)}<div class="muted small">${esc(FREQ_TEXT[x.freq] || '')}</div>` : '<span class="muted small">no rate yet</span>'}</td></tr>`).join('')
            || '<tr><td colspan="3" class="muted">No enrolled child starts or leaves in these months. New families are listed above.</td></tr>'}</tbody></table></div></section>
      <details class="panel proj-how"><summary>How it’s worked out</summary>
        <ul class="small">
          <li><b>Tuition</b>: each enrolled child’s rate (on their page) for every billing period they’ll be here, from their start date until a last day set
            on their page; everyone else is assumed to stay. Families pay full tuition through holidays and breaks, so those don’t change it.
            A month where three billing periods start is higher than the others.</li>
          <li><b>Payroll</b>: gross pay from Patriot (the average of the last two payrolls) on each payday. Days on the school calendar marked “staff not paid”
            (Settings → School calendar), like one week of winter break, come off that payroll. A month with three paydays is higher. Taxes the school pays
            aren’t included unless they’re added as an expense.</li>
          <li><b>Rent and bills</b>: every bill on its days (Money → Bills). <b>Food program, program payments, other money in and expenses</b>: recent
            months, so they get better as more is recorded.</li>
          <li><b>Waiting list</b>: a child with a start date and registration paid counts as starting from that day; without registration, as possible.
            <b>New families</b> in the Pipeline with a start date are possible too. Kept apart because they haven’t started. With no rate, their class’s
            full-time rate is used.</li>
        </ul></details>`;
    $$('[data-pm]', body).forEach((b) => b.addEventListener('click', () => { state.projMonths = Number(b.dataset.pm); store.set('projMonths', state.projMonths); drawProjection(body, el); }));
    const toMonth = (g) => { const card = $(`#pm-${g.dataset.month}`, body); card.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('.pm-more', card).open = true; };
    $$('.pc-month', body).forEach((g) => {
      g.addEventListener('click', () => toMonth(g));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toMonth(g); } });
    });
    $$('#proj-coming tr[data-sid]', body).forEach((tr) => tr.addEventListener('click', () => openStudent(tr.dataset.sid)));
    $$('#proj-coming tr[data-iid]', body).forEach((tr) => tr.addEventListener('click', () => openDrawer(tr.dataset.iid)));
    $$('[data-open-sid]', body).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openStudent(a.dataset.openSid); }));
    $$('[data-open-iid]', body).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openDrawer(a.dataset.openIid); }));
    $$('[data-set-rate]', body).forEach((b) => b.addEventListener('click', async () => {
      const s = state.students.find((x) => x.id === b.closest('li').dataset.sid), r = classRates(s.classroom_id).find((x) => x.k === b.dataset.setRate);
      b.disabled = true;
      if (await setClassRate(s, r)) drawProjection(body, el); else b.disabled = false;
    }));
    $('.proj-check-note a', body)?.addEventListener('click', (e) => { e.preventDefault(); $('#proj-rates', body).scrollIntoView({ behavior: 'smooth' }); });
  }

  function renderMoney(el) {
    const tab = ['bills', 'food', 'projection'].includes(state.moneyTab) ? state.moneyTab : 'overview';
    el.innerHTML = `<div class="seg money-tabs" role="tablist" aria-label="Money">${[['overview', 'In & out'], ['bills', 'Bills'], ['food', 'Food program'], ['projection', 'Projection']]
        .map(([k, v]) => `<button type="button" role="tab" data-mtab="${k}" aria-selected="${tab === k}">${v}</button>`).join('')}</div>
      <div id="money-body"><p class="muted">Loading…</p></div>`;
    $$('[data-mtab]', el).forEach((b) => b.addEventListener('click', () => { state.moneyTab = b.dataset.mtab; store.set('moneyTab', state.moneyTab); renderMoney(el); }));
    const go = () => {
      const body = $('#money-body', el);
      if (!body || state.view !== 'money') return;
      if (!state.money) { body.innerHTML = '<p class="muted">To use this page, run <code>017_money_food_program_todos.sql</code> in Supabase.</p>'; return; }
      ({ bills: drawBills, food: drawFood, projection: drawProjection, overview: drawMoney })[tab](body, el);
    };
    if (state.money === undefined) loadMoney().then(go); else go();
  }

  function drawMoney(body, el) {
    const M = state.money, ym = state.moneyMonth || thisMonth(), S = moneyMonth(ym), year = ym.slice(0, 4), edit = canEditFinance();
    const lines = (xs) => `<ul class="money-lines">${xs.map((x) => `<li><span>${esc(x.label)}${x.sub ? `<span class="muted small">${esc(x.sub)}</span>` : ''}</span>
        <b>${money(x.amount)}</b></li>`).join('') || '<li class="muted small">Nothing this month.</li>'}</ul>`;
    const pending = M.claims.filter((c) => c.status === 'submitted');
    const owed = round2(state.students.reduce((t, s) => t + openInvoices(s.id).reduce((u, i) => u + invoiceBalance(i), 0), 0));
    const lastPay = M.paychecks?.length ? M.paychecks.reduce((m, p) => (p.pay_date > m ? p.pay_date : m), '') : '';
    const lastGross = lastPay ? round2(M.paychecks.filter((p) => p.pay_date === lastPay).reduce((t, p) => t + Number(p.gross), 0)) : 0;
    const rows = M.entries.filter((e) => e.on_date.slice(0, 7) === ym).sort((a, b) => b.on_date.localeCompare(a.on_date) || a.category.localeCompare(b.category));
    const unpaidBills = billsDue(ym).filter((x) => !x.paid);
    const months = Array.from({ length: 12 }, (_, i) => `${year}-${pad(i + 1)}`).map((m) => ({ m, ...moneyMonth(m) }));
    body.innerHTML = `<div class="month-bar"><button class="btn small" id="mo-prev" type="button" aria-label="Previous month">‹</button>
        <b>${esc(fmtMonth(ym))}</b><button class="btn small" id="mo-next" type="button" aria-label="Next month">›</button>
        ${ym !== thisMonth() ? '<button class="btn small ghost" id="mo-now" type="button">This month</button>' : ''}<span class="spacer"></span>
        ${edit ? `<button class="btn small" id="mo-add-in" type="button">+ Money in</button>
          <button class="btn small primary" id="mo-add-out" type="button">+ Expense</button>` : ''}</div>
      <div class="stats">
        <div class="stat"><b>${money(S.tin)}</b><span>Money in</span></div>
        <div class="stat"><b>${money(S.tout)}</b><span>Money out</span></div>
        <div class="stat"><b class="${S.net < 0 ? 'neg' : ''}">${money(S.net)}</b><span>${S.net < 0 ? 'More out than in' : 'Left over'}</span></div>
      </div>
      <div class="money-grid">
        <section class="panel"><h2>Money in</h2>${lines(S.ins)}</section>
        <section class="panel"><h2>Money out</h2>${lines(S.outs)}
          ${M.paychecks ? '' : '<p class="muted small">Payroll isn’t included: it needs Payroll access.</p>'}</section>
      </div>
      <section class="panel"><h2>On its way</h2><ul class="money-lines">
        ${pending.map((c) => `<li><span>Coming in: Child Care Food Program, ${esc(fmtMonth(c.claim_month.slice(0, 7)))}
          <span class="muted small">${c.submitted_on ? `submitted ${esc(fmtDate(c.submitted_on))}, ` : ''}not paid yet</span></span><b>${money(ccfpTotal(c))}</b></li>`).join('')}
        ${owed ? `<li><span>Coming in: tuition families still owe <span class="muted small">see Tuition</span></span><b>${money(owed)}</b></li>` : ''}
        ${lastPay ? `<li><span>Going out: payroll every pay period <span class="muted small">the last one, paid ${esc(fmtDate(lastPay))}</span></span><b>${money(lastGross)}</b></li>` : ''}
        ${unpaidBills.length ? `<li><span>Going out: bills not marked paid in ${esc(fmtMonth(ym))} <span class="muted small">${esc(unpaidBills.map((x) => `${x.b.name} ${fmtDate(x.due)}`).join(' · '))}</span></span>
          <b>${money(unpaidBills.reduce((t, x) => t + Number(x.b.amount), 0))}</b></li>` : ''}
        ${pending.length || owed || lastPay || unpaidBills.length ? '' : '<li class="muted small">Nothing pending.</li>'}</ul></section>
      <section class="panel"><h2>Added this month <span class="muted small">${rows.length}</span></h2>
        <div class="table-wrap flat"><table><thead><tr><th>Date</th><th>Category</th><th>From / paid to</th><th>Receipt / check</th><th class="num">In</th><th class="num">Out</th></tr></thead>
          <tbody id="mo-rows">${rows.map((e) => `<tr data-entry="${e.id}" ${edit ? '' : 'class="ro"'}><td class="nowrap">${esc(fmtDate(e.on_date))}</td>
            <td>${esc(e.category)}${e.ccfp_col ? ` <span class="tag" title="${esc(CCFP_COL[e.ccfp_col][1])}">food program ${esc(CCFP_COL[e.ccfp_col][0])}</span>` : ''}
              ${e.in_totals ? '' : '<div class="muted small">only for the food program record</div>'}</td>
            <td>${esc(e.party || '')}</td><td>${esc(e.reference || '')}</td>
            <td class="num">${e.kind === 'in' ? money(e.amount) : ''}</td><td class="num">${e.kind === 'out' ? money(e.amount) : ''}</td></tr>`).join('')
            || '<tr><td colspan="6" class="muted">Nothing added this month.</td></tr>'}</tbody></table></div>
        <p class="muted small">Tuition and program payments recorded per child on <b>Tuition</b>, food program claims once paid, and paychecks from Patriot
          are counted by themselves: add here only what isn’t in the CRM yet (receipts, deposits not recorded per child). Rent and other monthly bills: mark them paid on <b>Bills</b>.</p></section>
      <section class="panel"><h2>${esc(year)} by month</h2><div class="table-wrap flat"><table><thead><tr><th>Month</th><th class="num">Money in</th>
          <th class="num">Money out</th><th class="num">Left over</th></tr></thead><tbody id="mo-year">${months.map((x) => `<tr data-month="${x.m}" ${x.m === ym ? 'class="on"' : ''}>
            <td>${esc(fmtMonth(x.m))}</td><td class="num">${x.tin ? money(x.tin) : ''}</td><td class="num">${x.tout ? money(x.tout) : ''}</td>
            <td class="num ${x.net < 0 ? 'neg' : ''}">${x.tin || x.tout ? money(x.net) : ''}</td></tr>`).join('')}</tbody>
          <tfoot><tr><th>${esc(year)}</th><th class="num">${money(months.reduce((t, x) => t + x.tin, 0))}</th><th class="num">${money(months.reduce((t, x) => t + x.tout, 0))}</th>
            <th class="num">${money(months.reduce((t, x) => t + x.net, 0))}</th></tr></tfoot></table></div></section>`;
    const go = (m) => { state.moneyMonth = m; drawMoney(body, el); };
    $('#mo-prev', body).addEventListener('click', () => go(shiftMonth(ym, -1)));
    $('#mo-next', body).addEventListener('click', () => go(shiftMonth(ym, 1)));
    $('#mo-now', body)?.addEventListener('click', () => go(thisMonth()));
    $$('#mo-year tr[data-month]', body).forEach((tr) => tr.addEventListener('click', () => go(tr.dataset.month)));
    const day = ym === thisMonth() ? nyToday() : monthStart(ym);
    $('#mo-add-in', body)?.addEventListener('click', () => openMoneyEntry({ kind: 'in', on_date: day }, () => drawMoney(body, el)));
    $('#mo-add-out', body)?.addEventListener('click', () => openMoneyEntry({ kind: 'out', on_date: day }, () => drawMoney(body, el)));
    if (edit) $$('#mo-rows tr[data-entry]', body).forEach((tr) => tr.addEventListener('click', () =>
      openMoneyEntry(M.entries.find((e) => e.id === tr.dataset.entry), () => drawMoney(body, el))));
  }

  // ───── Bills (020): what the school pays on set days every month (rent twice a month, utilities...) ─────
  const daysInMonth = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  const ordinal = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
  function billDues(b, ym) {   // the days a bill is due in a month (the 30th or 31st is the last day of a shorter month)
    return [...new Set(b.days.map((d) => `${ym}-${pad(Math.min(d, daysInMonth(ym)))}`))].sort()
      .filter((d) => d >= b.starts_on && (!b.ends_on || d <= b.ends_on));
  }
  const billsDue = (ym) => (state.money?.bills || []).flatMap((b) => billDues(b, ym).map((due) => ({ b, due,
    paid: state.money.entries.find((e) => e.bill_id === b.id && e.bill_due === due) })))
    .sort((x, y) => x.due.localeCompare(y.due) || x.b.sort - y.b.sort);
  const billMonth = (b) => round2(Number(b.amount) * b.days.length);
  const billWhen = (b) => {
    const days = [...b.days].sort((x, y) => x - y).map((d) => `the ${ordinal(d)}`);
    return b.days.length > 1 ? `${b.days.length} payments of ${b.varies ? 'about ' : ''}${money(b.amount)}, on ${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`
      : `${b.varies ? 'about ' : ''}${money(b.amount)}, on ${days[0]}`;
  };

  function drawBills(body, el) {
    const M = state.money, ym = state.moneyMonth || thisMonth(), edit = canEditFinance(), today = nyToday();
    if (!M.bills) { body.innerHTML = '<p class="muted">To keep the school’s monthly bills here, run <code>020_class_rates_and_bills.sql</code> in Supabase.</p>'; return; }
    const dues = billsDue(ym);
    const paidSum = round2(dues.reduce((t, x) => t + (x.paid ? Number(x.paid.amount) : 0), 0));
    const leftSum = round2(dues.reduce((t, x) => t + (x.paid ? 0 : Number(x.b.amount)), 0));
    const status = (x) => {
      if (x.paid) return ['paid', `Paid ${fmtDate(x.paid.on_date)}${x.paid.reference ? ` · ${x.paid.reference}` : ''}`];
      if (x.due < today) return ['missed', 'Not marked paid'];
      if (x.due === today) return ['today', 'Due today'];
      const d = daysBetween(today, x.due);
      return ['soon', d <= 7 ? `Due in ${d} day${d === 1 ? '' : 's'}` : 'Coming up'];
    };
    const wd = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
    const monthTotal = round2(M.bills.filter((b) => !b.ends_on || b.ends_on >= today).reduce((t, b) => t + billMonth(b), 0));
    body.innerHTML = `<div class="month-bar"><button class="btn small" id="mo-prev" type="button" aria-label="Previous month">‹</button>
        <b>${esc(fmtMonth(ym))}</b><button class="btn small" id="mo-next" type="button" aria-label="Next month">›</button>
        ${ym !== thisMonth() ? '<button class="btn small ghost" id="mo-now" type="button">This month</button>' : ''}<span class="spacer"></span>
        ${edit ? '<button class="btn small primary" id="bill-add" type="button">+ Add a bill</button>' : ''}</div>
      <div class="stats">
        <div class="stat"><b>${money(round2(paidSum + leftSum))}</b><span>Bills in ${esc(fmtMonth(ym))}</span></div>
        <div class="stat"><b>${money(paidSum)}</b><span>Paid</span></div>
        <div class="stat"><b class="${leftSum && dues.some((x) => !x.paid && x.due < today) ? 'neg' : ''}">${money(leftSum)}</b><span>Still to pay</span></div>
      </div>
      <section class="panel"><h2>Due in ${esc(fmtMonth(ym))}</h2>
        <ul class="bill-dues" id="bill-dues">${dues.map((x) => {
          const [st, text] = status(x);
          return `<li class="bd-${st}" data-bill="${x.b.id}" data-due="${x.due}">
            <span class="bd-date"><b>${Number(x.due.slice(8))}</b><small>${esc(wd(x.due))}</small></span>
            <span class="bd-what"><b>${esc(x.b.name)}</b><span class="small bd-status">${esc(text)}</span></span>
            <span class="bd-amt"><b>${money(x.paid ? x.paid.amount : x.b.amount)}</b>${x.b.varies && !x.paid ? '<small class="muted">about</small>' : ''}</span>
            ${edit ? `<span class="bd-act">${x.paid ? `<button class="btn small ghost" type="button" data-entry="${x.paid.id}">Edit</button>`
              : `<button class="btn small ${st === 'soon' ? '' : 'primary'}" type="button" data-pay>Mark paid</button>`}</span>` : ''}</li>`;
        }).join('') || `<li class="muted small">No bills ${M.bills.length ? 'due this month' : `yet. ${edit ? 'Add the rent, utilities and other bills paid every month.' : ''}`}</li>`}</ul></section>
      <section class="panel"><h2 class="h-row">Every month <span class="muted small">${money(monthTotal)} a month</span></h2>
        <ul class="bill-list" id="bill-list">${M.bills.map((b) => `<li data-bill="${b.id}" class="${b.ends_on && b.ends_on < today ? 'bl-ended' : ''}">
          <div class="bl-head"><b>${esc(b.name)}</b><b>${b.varies ? '<small class="muted">about </small>' : ''}${money(billMonth(b))}<small class="muted"> a month</small></b></div>
          <div class="muted small">${esc(billWhen(b))} · ${esc(b.category)}${b.party ? ` · ${esc(b.party)}` : ''}</div>
          ${(b.parts || []).length ? `<div class="bl-parts">${b.parts.map((pt) => `<span>${esc(pt.label)} <b>${money(pt.amount)}</b></span>`).join('<span class="muted">+</span>')}
            <span class="muted">a month</span></div>` : ''}
          ${b.note ? `<div class="muted small">${esc(b.note)}</div>` : ''}
          ${b.ends_on ? `<div class="muted small">${b.ends_on < today ? 'Ended' : 'Until'} ${esc(fmtDate(b.ends_on))}</div>` : ''}
          ${edit ? '<button class="btn small ghost bl-edit" type="button" data-edit>Edit</button>' : ''}</li>`).join('')
          || '<li class="muted small">Nothing yet.</li>'}</ul>
        <p class="muted small">Marking a bill paid adds it to money out for that month (In &amp; out). The projection counts every bill on its days.</p></section>`;
    const go = (m) => { state.moneyMonth = m; drawBills(body, el); };
    const redraw = () => drawBills(body, el);
    $('#mo-prev', body).addEventListener('click', () => go(shiftMonth(ym, -1)));
    $('#mo-next', body).addEventListener('click', () => go(shiftMonth(ym, 1)));
    $('#mo-now', body)?.addEventListener('click', () => go(thisMonth()));
    $('#bill-add', body)?.addEventListener('click', () => openBill({}, redraw));
    $$('#bill-list [data-edit]', body).forEach((btn) => btn.addEventListener('click', () => openBill(M.bills.find((b) => b.id === btn.closest('li').dataset.bill), redraw)));
    $$('#bill-dues [data-entry]', body).forEach((btn) => btn.addEventListener('click', () => openMoneyEntry(M.entries.find((e) => e.id === btn.dataset.entry), redraw)));
    $$('#bill-dues [data-pay]', body).forEach((btn) => btn.addEventListener('click', () => {
      const li = btn.closest('li'), b = M.bills.find((x) => x.id === li.dataset.bill), due = li.dataset.due;
      openMoneyEntry({ kind: 'out', on_date: due <= today ? due : today, category: b.category, amount: b.amount, party: b.party || b.name,
        note: `${b.name}, due ${fmtDate(due)}`, bill_id: b.id, bill_due: due }, redraw);
    }));
  }

  function openBill(b0, after) {
    const isNew = !b0.id, b = { name: '', category: '', party: '', amount: '', days: [], varies: false, parts: [], starts_on: monthStart(thisMonth()), ends_on: null, note: '', ...b0 };
    const parts = [...(b.parts || []), {}, {}].slice(0, Math.max(2, (b.parts || []).length + 1));
    const ctl = mountDrawer({
      title: isNew ? 'New bill' : esc(b.name),
      sub: isNew ? 'Paid on the same days every month' : esc(`${money(billMonth(b))} a month`),
      body: `<div class="section grid2">
          ${fInput('name', 'Name', b.name, 'text', 'maxlength="80" placeholder="e.g. Rent, Water"')}
          <label>Category<input name="category" list="bill-cats" maxlength="60" value="${esc(b.category)}" placeholder="e.g. Rent, Utilities"></label>
          ${fInput('party', 'Paid to', b.party, 'text', 'maxlength="120" placeholder="e.g. landlord, Miami-Dade Water"')}
          ${fInput('amount', 'Amount each time', b.amount, 'number', 'step="0.01" min="0.01" inputmode="decimal"')}
          ${fInput('days', 'Day(s) of the month it’s paid', (b.days || []).join(', '), 'text', 'placeholder="e.g. 15, 30" inputmode="numeric"')}
          <label class="pill-check"><input type="checkbox" class="check" name="varies" ${b.varies ? 'checked' : ''}> The amount changes every month (it’s an estimate)</label>
          <p class="full muted small">Paid twice a month? Put both days (15, 30) and the amount of each payment. The 30th or 31st is the last day of a shorter month.</p>
          ${fInput('starts_on', 'Starting', b.starts_on, 'date')}
          ${fInput('ends_on', 'Until (if it ends)', b.ends_on, 'date')}
        </div>
        <div class="section"><h3>What a month is made of <span class="muted small">(optional, e.g. base rent and CAM)</span></h3>
          <div class="bill-parts">${parts.map((pt, i) => `<input name="pl${i}" maxlength="40" value="${esc(pt.label || '')}" placeholder="e.g. Base rent" aria-label="Part ${i + 1}">
            <input name="pa${i}" type="number" step="0.01" min="0" inputmode="decimal" value="${esc(pt.amount ?? '')}" placeholder="a month" aria-label="Part ${i + 1} a month">`).join('')}</div></div>
        <div class="section"><label class="full">Note<textarea name="note" rows="2" maxlength="500">${esc(b.note || '')}</textarea></label></div>
        <datalist id="bill-cats">${[...new Set([...MONEY_CATS.out, ...state.money.entries.filter((x) => x.kind === 'out').map((x) => x.category)])].map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>`,
      foot: `${isNew ? '' : '<button class="btn danger" id="bill-del" type="button">Delete</button>'}<span class="spacer"></span>
        <button class="btn" data-close type="button">Cancel</button><button class="btn primary" id="bill-save" type="button">Save</button>`,
    });
    const { drawer, form } = ctl;
    form.name.focus();
    $('#bill-save', drawer).addEventListener('click', async () => {
      const days = [...new Set(form.days.value.split(/[^0-9]+/).filter(Boolean).map(Number))].sort((x, y) => x - y);
      const row = { name: form.name.value.trim(), category: form.category.value.trim(), party: form.party.value.trim() || null, amount: round2(form.amount.value),
        days, varies: form.varies.checked, starts_on: form.starts_on.value, ends_on: form.ends_on.value || null, note: form.note.value.trim() || null,
        parts: parts.map((_, i) => ({ label: form[`pl${i}`].value.trim(), amount: round2(form[`pa${i}`].value) })).filter((pt) => pt.label && pt.amount > 0) };
      if (!row.name) { form.name.focus(); return toast('Give the bill a name', true); }
      if (!row.category) { form.category.focus(); return toast('Pick or type a category', true); }
      if (!(row.amount > 0)) { form.amount.focus(); return toast('Type the amount of each payment', true); }
      if (!days.length || days.length > 4 || days.some((d) => d < 1 || d > 31)) { form.days.focus(); return toast('Type the day(s) of the month: 1 to 31, up to 4', true); }
      if (!row.starts_on) return toast('Pick when it starts', true);
      if (row.ends_on && row.ends_on < row.starts_on) return toast('It ends before it starts', true);
      const { data, error } = await (isNew ? sb.from('bills').insert({ ...row, sort: state.money.bills.length + 1 }) : sb.from('bills').update(row).eq('id', b.id)).select().single();
      if (error) return fail(error, 'Could not save the bill');
      state.money.bills = [...state.money.bills.filter((x) => x.id !== data.id), data].sort((x, y) => x.sort - y.sort || x.name.localeCompare(y.name));
      ctl.dirty = false;
      toast(`Saved: ${data.name}, ${money(billMonth(data))} a month`);
      closeDrawer();
      after();
    });
    $('#bill-del', drawer)?.addEventListener('click', async () => {
      if (!confirm(`Delete the bill “${b.name}”? Payments already marked stay on Money as expenses.`)) return;
      const { error } = await sb.from('bills').delete().eq('id', b.id);
      if (error) return fail(error, 'Could not delete the bill');
      state.money.bills = state.money.bills.filter((x) => x.id !== b.id);
      state.money.entries = state.money.entries.map((x) => (x.bill_id === b.id ? { ...x, bill_id: null, bill_due: null } : x));
      ctl.dirty = false;
      toast('Bill deleted');
      closeDrawer();
      after();
    });
  }

  function openMoneyEntry(e0, after) {
    const isNew = !e0.id, e = { category: '', amount: '', party: '', reference: '', note: '', ccfp_col: null, in_totals: true, ...e0 };
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
    const ctl = mountDrawer({
      title: isNew ? (e.kind === 'in' ? 'Money in' : 'Expense') : esc(e.category),
      sub: isNew ? '' : esc(`${e.kind === 'in' ? 'Money in' : 'Expense'} · ${fmtDate(e.on_date)} · ${money(e.amount)}`),
      body: `<div class="section grid2">
          <label>Type<select name="kind">${opt('out', 'Expense (money out)', e.kind)}${opt('in', 'Money in', e.kind)}</select></label>
          <label>Date<input type="date" name="on_date" value="${esc(e.on_date)}"></label>
          <label>Category<input name="category" list="mo-cats" maxlength="60" value="${esc(e.category)}" placeholder="e.g. Food"></label>
          <label>Amount<input name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" value="${esc(e.amount)}"></label>
          <label>${e.kind === 'in' ? 'From' : 'Paid to'}<input name="party" maxlength="120" value="${esc(e.party)}" placeholder="${e.kind === 'in' ? 'e.g. ELC of Miami-Dade' : 'e.g. Publix'}"></label>
          <label>Receipt / check no.<input name="reference" maxlength="80" value="${esc(e.reference)}"></label>
          <label class="full">Food program record<select name="ccfp_col">${opt('', 'Not for the food program', e.ccfp_col)}
            ${Object.entries(CCFP_COL).map(([k, [c, l]]) => opt(k, `(${c}) ${l}`, e.ccfp_col)).join('')}</select></label>
          <label class="full pill-check"><input type="checkbox" class="check" name="in_totals" ${e.in_totals ? 'checked' : ''}>
            Count it in money ${e.kind === 'in' ? 'in' : 'out'} <span class="muted small">(untick for a line that’s only for the food program record,
            like the cook’s labor, which payroll already counts)</span></label>
          <label class="full">Note<input name="note" maxlength="500" value="${esc(e.note)}"></label>
        </div><datalist id="mo-cats"></datalist>`,
      foot: `${isNew ? '' : '<button class="btn danger" id="me-del" type="button">Delete</button>'}<span class="spacer"></span>
        <button class="btn" data-close type="button">Cancel</button>
        ${isNew ? '<button class="btn" id="me-again" type="button">Save and add another</button>' : ''}
        <button class="btn primary" id="me-save" type="button">Save</button>`,
    });
    const { drawer, form } = ctl;
    const cats = () => { const k = form.kind.value; $('#mo-cats', drawer).innerHTML = [...new Set([...MONEY_CATS[k], ...state.money.entries.filter((x) => x.kind === k).map((x) => x.category)])]
      .map((c) => `<option value="${esc(c)}"></option>`).join(''); };
    cats();
    form.kind.addEventListener('change', cats);
    form.ccfp_col.addEventListener('change', () => { if (form.ccfp_col.value === 'labor') form.in_totals.checked = false; });
    (isNew ? form.category : form.amount).focus();
    const save = async (again) => {
      const row = { kind: form.kind.value, on_date: form.on_date.value, category: form.category.value.trim(), amount: round2(form.amount.value),
        party: form.party.value.trim() || null, reference: form.reference.value.trim() || null, note: form.note.value.trim() || null,
        ccfp_col: form.ccfp_col.value || null, in_totals: form.in_totals.checked, ...(e.bill_id ? { bill_id: e.bill_id, bill_due: e.bill_due } : {}) };
      if (!row.on_date) return toast('Pick the date', true);
      if (!row.category) { form.category.focus(); return toast('Pick or type a category', true); }
      if (!(row.amount > 0)) { form.amount.focus(); return toast('Type the amount', true); }
      const { data, error } = await (isNew ? sb.from('money_entries').insert(row) : sb.from('money_entries').update(row).eq('id', e.id)).select().single();
      if (error) return fail(error, 'Could not save it');
      state.money.entries = [...state.money.entries.filter((x) => x.id !== data.id), data];
      toast(`Saved: ${row.category} ${money(row.amount)}`);
      ctl.dirty = false;
      after();
      if (again) { openMoneyEntry({ kind: row.kind, on_date: row.on_date, category: row.category, ccfp_col: row.ccfp_col, in_totals: row.in_totals }, after); $('[name=amount]').focus(); }
      else closeDrawer();
    };
    $('#me-save', drawer).addEventListener('click', () => save(false));
    $('#me-again', drawer)?.addEventListener('click', () => save(true));
    $('#me-del', drawer)?.addEventListener('click', async () => {
      if (!confirm(`Delete this ${e.kind === 'in' ? 'money in' : 'expense'} (${e.category}, ${money(e.amount)})?`)) return;
      const { error } = await sb.from('money_entries').delete().eq('id', e.id);
      if (error) return fail(error, 'Could not delete it');
      state.money.entries = state.money.entries.filter((x) => x.id !== e.id);
      ctl.dirty = false;
      closeDrawer();
      toast('Deleted');
      after();
    });
  }

  // ───── Child Care Food Program: claims, and the monthly record of operating expenditures ─────
  function drawFood(body, el) {
    const M = state.money, edit = canEditFinance();
    const ym = state.ccfpMonth || shiftMonth(thisMonth(), -1);
    const recs = M.entries.filter((e) => e.ccfp_col && e.on_date.slice(0, 7) === ym);
    const food = sumAmt(recs.filter((e) => e.ccfp_col === 'food')), nonFood = sumAmt(recs.filter((e) => e.ccfp_col !== 'food'));
    const year = thisMonth().slice(0, 4);
    const paidYear = round2(M.claims.filter((c) => c.status === 'paid' && (c.paid_on || '').startsWith(year)).reduce((t, c) => t + Number(c.paid_amount ?? ccfpTotal(c)), 0));
    const pending = round2(M.claims.filter((c) => c.status === 'submitted').reduce((t, c) => t + ccfpTotal(c), 0));
    body.innerHTML = `<div class="toolbar"><span class="muted small">Florida Department of Health, Child Care Food Program: one claim a month.</span>
        <span class="spacer"></span>${edit ? '<button class="btn small primary" id="cf-add" type="button">+ New claim</button>' : ''}</div>
      <div class="stats">
        <div class="stat"><b>${money(pending)}</b><span>Submitted, not paid yet</span></div>
        <div class="stat"><b>${money(paidYear)}</b><span>Paid in ${esc(year)}</span></div>
        <div class="stat"><b>${M.claims.length}</b><span>Claims recorded</span></div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Claim month</th><th class="num">Meals &amp; snacks</th><th class="num">Reimbursement</th>
          <th class="num">Costs</th><th>Status</th><th>Submitted</th><th>Paid</th></tr></thead>
        <tbody id="cf-rows">${M.claims.map((c) => `<tr data-claim="${c.id}"><td><b>${esc(fmtMonth(c.claim_month.slice(0, 7)))}</b></td>
          <td class="num">${ccfpMeals(c).toLocaleString()}</td><td class="num">${money(ccfpTotal(c))}</td>
          <td class="num">${c.food_cost != null || c.non_food_cost != null ? money(Number(c.food_cost || 0) + Number(c.non_food_cost || 0)) : ''}</td>
          <td><span class="pay-pill ps-${CCFP_PILL[c.status]}">${esc(CCFP_STATUS[c.status])}</span></td>
          <td class="nowrap">${c.submitted_on ? esc(fmtDate(c.submitted_on)) : ''}</td>
          <td class="nowrap">${c.paid_on ? `${esc(fmtDate(c.paid_on))}${c.paid_amount != null ? ` · ${money(c.paid_amount)}` : ''}` : ''}</td></tr>`).join('')
          || '<tr><td colspan="7" class="muted">No claims yet.</td></tr>'}</tbody></table></div>
      <section class="panel"><h2>Monthly record of operating expenditures</h2>
        <div class="month-bar"><button class="btn small" id="cf-prev" type="button" aria-label="Previous month">‹</button><b>${esc(fmtMonth(ym))}</b>
          <button class="btn small" id="cf-next" type="button" aria-label="Next month">›</button><span class="spacer"></span>
          ${edit ? '<button class="btn small" id="cf-receipt" type="button">+ Add a receipt</button>' : ''}
          <button class="btn small primary" id="cf-print" type="button" ${recs.length ? '' : 'disabled'}>Print the record</button></div>
        <p class="small">${recs.length} receipt${recs.length === 1 ? '' : 's'} · Food costs <b>${money(food)}</b> · Non-food costs <b>${money(nonFood)}</b> ·
          Total <b>${money(round2(food + nonFood))}</b></p>
        <p class="muted small">Receipts are the expenses on <b>In &amp; out</b> marked for the food program (column d–j). The record prints like the
          state’s form, ready to sign and keep with the claim.</p></section>`;
    $$('#cf-rows tr[data-claim]', body).forEach((tr) => tr.addEventListener('click', () => openClaim(M.claims.find((c) => c.id === tr.dataset.claim), () => drawFood(body, el))));
    $('#cf-add', body)?.addEventListener('click', () => openClaim(null, () => drawFood(body, el)));
    const go = (m) => { state.ccfpMonth = m; drawFood(body, el); };
    $('#cf-prev', body).addEventListener('click', () => go(shiftMonth(ym, -1)));
    $('#cf-next', body).addEventListener('click', () => go(shiftMonth(ym, 1)));
    $('#cf-print', body).addEventListener('click', () => showCcfpRecord(ym));
    $('#cf-receipt', body)?.addEventListener('click', () => openMoneyEntry({ kind: 'out', on_date: monthStart(ym), category: 'Food', ccfp_col: 'food' }, () => drawFood(body, el)));
  }

  function openClaim(c0, after) {
    const isNew = !c0, M = state.money;
    const c = c0 || { claim_month: monthStart(shiftMonth(thisMonth(), -1)), status: 'draft', adjustments: 0 };
    const num = (k, label, step = '1') => `<label>${label}<input name="${k}" type="number" min="0" step="${step}" inputmode="decimal" value="${esc(c[k] ?? '')}"></label>`;
    const ctl = mountDrawer({
      title: isNew ? 'New food program claim' : `Claim for ${esc(fmtMonth(c.claim_month.slice(0, 7)))}`,
      sub: 'Copy the numbers from the Child Care Center Claim',
      body: `<div class="section grid2">
          <label>Claim month<input type="month" name="claim_month" value="${esc(c.claim_month.slice(0, 7))}"></label>
          <label>Status<select name="status">${Object.entries(CCFP_STATUS).map(([k, v]) => `<option value="${k}" ${c.status === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
          ${num('operating_days', 'Operating days')}${num('daily_avg', 'Average daily participation')}</div>
        <div class="section"><h3>Children enrolled by category</h3><div class="grid3">${num('enrolled_free', 'Free')}${num('enrolled_reduced', 'Reduced')}${num('enrolled_paid', 'Non-needy')}</div></div>
        <div class="section"><h3>Meals claimed</h3><div class="grid3">${num('breakfasts', 'Breakfast')}${num('am_snacks', 'Morning snack')}${num('lunches', 'Lunch')}
          ${num('pm_snacks', 'Afternoon snack')}${num('suppers', 'Supper')}${num('eve_snacks', 'Evening snack')}</div></div>
        <div class="section"><h3>Earnings</h3><div class="grid3">${num('meal_earnings', 'Meal earnings', '0.01')}${num('cash_in_lieu', 'Cash-in-lieu', '0.01')}
          ${num('adjustments', 'Adjustments', '0.01')}</div><p class="small">Total reimbursement: <b id="cf-total"></b></p></div>
        <div class="section"><h3>Costs</h3><div class="grid3">${num('food_cost', 'Food cost', '0.01')}${num('non_food_cost', 'Non-food cost', '0.01')}
          ${num('admin_cost', 'Administrative', '0.01')}</div>
          <button class="btn small" type="button" id="cf-fill">Fill food and non-food from the receipts</button> <span class="muted small" id="cf-fill-note"></span></div>
        <div class="section grid2">
          <label>Submitted on<input type="date" name="submitted_on" value="${esc(c.submitted_on || '')}"></label><span></span>
          <label>Paid on<input type="date" name="paid_on" value="${esc(c.paid_on || '')}"></label>${num('paid_amount', 'Amount paid', '0.01')}
          <label class="full">Note<input name="note" maxlength="500" value="${esc(c.note || '')}"></label></div>`,
      foot: `${isNew ? '' : '<button class="btn danger" id="cf-del" type="button">Delete</button>'}<span class="spacer"></span>
        <button class="btn" data-close type="button">Cancel</button><button class="btn primary" id="cf-save" type="button">Save</button>`,
    });
    const { drawer, form } = ctl;
    const v = (k) => (form[k].value === '' ? null : Number(form[k].value));
    const total = () => { $('#cf-total', drawer).textContent = money(round2((v('meal_earnings') || 0) + (v('cash_in_lieu') || 0) + (v('adjustments') || 0))); };
    total();
    ['meal_earnings', 'cash_in_lieu', 'adjustments'].forEach((k) => form[k].addEventListener('input', total));
    form.paid_on.addEventListener('change', () => {
      if (form.paid_on.value && form.status.value !== 'paid') form.status.value = 'paid';
      if (form.paid_on.value && form.paid_amount.value === '') form.paid_amount.value = round2((v('meal_earnings') || 0) + (v('cash_in_lieu') || 0) + (v('adjustments') || 0)).toFixed(2);
    });
    form.submitted_on.addEventListener('change', () => { if (form.submitted_on.value && form.status.value === 'draft') form.status.value = 'submitted'; });
    $('#cf-fill', drawer).addEventListener('click', () => {
      const ym = form.claim_month.value, recs = M.entries.filter((e) => e.ccfp_col && e.on_date.slice(0, 7) === ym);
      form.food_cost.value = sumAmt(recs.filter((e) => e.ccfp_col === 'food')).toFixed(2);
      form.non_food_cost.value = sumAmt(recs.filter((e) => e.ccfp_col !== 'food')).toFixed(2);
      $('#cf-fill-note', drawer).textContent = `from ${recs.length} receipt${recs.length === 1 ? '' : 's'} in ${fmtMonth(ym)}`;
      ctl.dirty = true;
    });
    $('#cf-save', drawer).addEventListener('click', async () => {
      if (!form.claim_month.value) return toast('Pick the claim month', true);
      const row = { claim_month: monthStart(form.claim_month.value), status: form.status.value, submitted_on: form.submitted_on.value || null,
        paid_on: form.paid_on.value || null, note: form.note.value.trim() || null, adjustments: v('adjustments') || 0 };
      ['operating_days', 'daily_avg', 'enrolled_free', 'enrolled_reduced', 'enrolled_paid', 'meal_earnings', 'cash_in_lieu', 'food_cost', 'non_food_cost',
        'admin_cost', 'paid_amount'].forEach((k) => { row[k] = v(k); });
      ['breakfasts', 'am_snacks', 'lunches', 'pm_snacks', 'suppers', 'eve_snacks'].forEach((k) => { row[k] = v(k) || 0; });
      const { data, error } = await (isNew ? sb.from('ccfp_claims').insert(row) : sb.from('ccfp_claims').update(row).eq('id', c.id)).select().single();
      if (error) return fail(error, error.code === '23505' ? 'There’s already a claim for that month' : 'Could not save the claim');
      M.claims = [...M.claims.filter((x) => x.id !== data.id), data].sort((a, b) => b.claim_month.localeCompare(a.claim_month));
      ctl.dirty = false;
      closeDrawer();
      toast(`Saved the claim for ${fmtMonth(data.claim_month.slice(0, 7))}`);
      after();
    });
    $('#cf-del', drawer)?.addEventListener('click', async () => {
      if (!confirm(`Delete the claim for ${fmtMonth(c.claim_month.slice(0, 7))} from the CRM?`)) return;
      const { error } = await sb.from('ccfp_claims').delete().eq('id', c.id);
      if (error) return fail(error, 'Could not delete it');
      M.claims = M.claims.filter((x) => x.id !== c.id);
      ctl.dirty = false;
      closeDrawer();
      toast('Deleted');
      after();
    });
  }

  function showCcfpRecord(ym) {
    const recs = state.money.entries.filter((e) => e.ccfp_col && e.on_date.slice(0, 7) === ym)
      .sort((a, b) => a.on_date.localeCompare(b.on_date) || (a.reference || '').localeCompare(b.reference || ''));
    const cols = Object.keys(CCFP_COL), col = (k) => sumAmt(recs.filter((e) => e.ccfp_col === k));
    const food = col('food'), nonFood = round2(cols.filter((k) => k !== 'food').reduce((t, k) => t + col(k), 0));
    const [y, mo] = ym.split('-');
    const sheet = document.createElement('div');
    sheet.className = 'print-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.innerHTML = `<div class="print-bar no-print"><b>Food program record</b><span class="spacer"></span>
        <button class="btn primary" type="button" id="cr-print">Print / Save as PDF</button><button class="btn" type="button" id="cr-close">Close</button></div>
      <article class="receipt ccfp-sheet">
        <h1 class="ccfp-h">Monthly Record of CCFP Operating Expenditures</h1>
        <p class="ccfp-sub">For Afterschool Nutrition Program, Affiliated Centers, Homeless Program, and Independent Child Care Centers</p>
        <div class="ccfp-head"><div><b>Month</b> ${esc(new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long' }).toUpperCase())} <b>Year</b> ${esc(y)}</div>
          <div><b>Site name</b> ${esc((state.settings?.school_name || 'Creativa Academy').toUpperCase())}</div>
          <div><b>Food costs</b> ${money(food)} · <b>Non-food costs</b> ${money(nonFood)} · <b>Grand total operating costs</b> ${money(round2(food + nonFood))}</div></div>
        <table class="ccfp-table"><colgroup><col class="c-date"><col class="c-ref"><col class="c-payee">${cols.map(() => '<col>').join('')}</colgroup>
          <thead><tr><th>(a) Day of month</th><th>(b) Invoice or receipt no. / check no.</th><th>(c) Name of payee for expenditures claimed</th>
          ${cols.map((k) => `<th class="num">(${CCFP_COL[k][0]}) ${esc(CCFP_COL[k][1])}</th>`).join('')}</tr></thead>
          <tbody>${recs.map((e) => `<tr><td class="nowrap">${esc(`${Number(mo)}.${Number(e.on_date.slice(8))}.${y.slice(2)}`)}</td><td>${esc(e.reference || 'N/A')}</td>
            <td>${esc((e.party || e.category).toUpperCase())}</td>${cols.map((k) => `<td class="num">${e.ccfp_col === k ? money(e.amount) : ''}</td>`).join('')}</tr>`).join('')}</tbody>
          <tfoot><tr><th colspan="3">Totals</th>${cols.map((k) => `<th class="num">${money(col(k))}</th>`).join('')}</tr></tfoot></table>
        <p class="r-note">Printed ${esc(fmtDateTime(new Date().toISOString()))} from the Creativa CRM (Money → Food program).</p>
      </article>`;
    document.body.append(sheet);
    document.body.classList.add('printing');
    const close = () => { sheet.remove(); document.body.classList.remove('printing'); };
    $('#cr-print', sheet).addEventListener('click', () => window.print());
    $('#cr-close', sheet).addEventListener('click', close);
    sheet.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
    $('#cr-close', sheet).focus();
  }

  // ───────────── Messages (013): texts to families ─────────────
  // Staff pick who gets it (everyone, a class, families who owe or are late, or families they tick), write it once,
  // and each family gets its own text with {parent}, {child} and {balance} filled in. netlify/functions/family-texts.mjs
  // sends them through Twilio, between 8am and 9pm.
  const MSG_STATUS = { queued: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', opted_out: 'Opted out', canceled: 'Canceled' };
  const MSG_PILL = { queued: 'open', sending: 'open', sent: 'paid', failed: 'overdue', opted_out: 'none', canceled: 'void' };
  const MSG_WHO = { all: 'All enrolled families', class: 'One class', owe: 'Families who owe money', late: 'Families with a late balance',
    docs: 'Families missing paperwork', waitlist: 'Waiting list families', pick: 'Families I pick', one: 'Someone else (type a number)' };
  // Examples shown until 014_message_templates.sql is run; after that the school writes and saves its own ("My messages").
  // Plain characters only: an accent or curly quote makes every text cost more (70 characters a part instead of 160).
  const MSG_EXAMPLES = [
    { id: 'ex-1', name: 'Payment reminder', body: "Hi {parent}, this is {me} from Creativa Academy. A friendly reminder that {child}'s tuition balance is {balance}. You can pay by Zelle, card or cash. Thank you!" },
    { id: 'ex-2', name: 'Activity reminder', body: 'Hi {parent}! This is {me} from Creativa Academy. Just a reminder that [activity] is on [day] at [time]. Please [what to bring]. Thank you!' },
    { id: 'ex-3', name: 'School closed', body: 'Hi {parent}, this is {me} from Creativa Academy. We will be closed on [day] for [reason] and reopen on [day]. Thank you!' },
  ];
  // Blocks: filled in for each family when the text goes out. "[ ]" is a blank the writer fills in before sending.
  const MSG_BLOCKS = [['{parent}', 'Parent’s first name'], ['{child}', 'Child’s first name'], ['{balance}', 'Balance owed'],
    ['{class}', 'Class'], ['{missing}', 'Missing paperwork'], ['{me}', 'My first name'], ['[ ]', 'Blank to fill in']];
  const STOP_LINE = 'Reply STOP to opt out.';
  const HAS_BLANK = /\[[^\]]*\]/;
  const familyOwes = (kids) => round2(kids.reduce((t, s) => t + openInvoices(s.id).reduce((u, i) => u + invoiceBalance(i), 0), 0));
  const familyLate = (kids) => round2(kids.reduce((t, s) => t + openInvoices(s.id).filter(invoiceLate)
    .reduce((u, i) => u + invoiceBalance(i), 0), 0));
  const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');
  const anyKid = (s) => s.status === 'enrolled' || openInvoices(s.id).length > 0;          // enrolled, or still owes
  const pickable = (s) => !LEFT.has(s.status) || openInvoices(s.id).length > 0;             // ... or on the waiting list
  // The children kept, grouped by family: brothers and sisters are one family when they share a family account or a
  // parent (the same Primary or Secondary contact's cell number), so they get one text that names them all.
  function msgFamilies(keep = anyKid) {
    const kids = state.students.filter(keep), up = new Map();
    const root = (k) => { while (up.get(k) !== k) k = up.get(k); return k; };
    const join = (a, b) => { const [x, y] = [root(a), root(b)].sort(); if (x !== y) up.set(y, x); };
    kids.forEach((s) => up.set(familyKey(s), familyKey(s)));
    const byId = new Map(kids.map((s) => [s.id, s])), byPhone = new Map();
    state.contacts.forEach((c) => {
      const s = c.role !== 'emergency' && byId.get(c.student_id);
      const ph = s && e164(c.sms_phone || c.cell_phone);
      if (!ph) return;
      if (byPhone.has(ph)) join(byPhone.get(ph), familyKey(s)); else byPhone.set(ph, familyKey(s));
    });
    const groups = new Map();
    kids.forEach((s) => {
      const k = root(familyKey(s));
      if (!groups.has(k)) groups.set(k, { key: k, keys: new Set(), kids: [] });
      groups.get(k).keys.add(familyKey(s));
      groups.get(k).kids.push(s);
    });
    return [...groups.values()].map((g) => ({ ...g, keys: [...g.keys], name: familyName(g.kids), owes: familyOwes(g.kids), late: familyLate(g.kids) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  // A list (015): children in its classes (none = every class) with its funding (none = any; "private" = no program).
  function listMatch(l, s) {
    const fund = fundingOf(s.id);
    return (!l.classes.length || l.classes.includes(s.classroom_id))
      && (!l.funding.length || l.funding.some((f) => fund.includes(f) || (f === 'sr' && fund.includes('sr_bpiece'))));
  }
  const listKids = (l) => (s) => l.families.includes(s.id) || (s.status === 'enrolled' && listMatch(l, s));
  // Who in a family gets a text. Group texts (lists, classes, everyone, reminders) go to contacts set to get them
  // (015; usually the Primary contact); texts to families picked by hand go to the Primary contact.
  const getsGroupTexts = (c) => c.group_texts ?? c.role === 'primary';
  function msgPhones(g, secondary, group = true) {
    const out = new Map();
    g.kids.forEach((s) => {
      const mine = state.contacts.filter((c) => c.student_id === s.id);
      const cs = mine.filter((c) => (group ? getsGroupTexts(c) : c.role === 'primary') || (secondary && c.role === 'secondary'))
        .sort((a, b) => a.role.localeCompare(b.role));
      cs.forEach((c) => { const ph = e164(c.sms_phone || c.cell_phone); if (ph && !out.has(ph)) out.set(ph, { name: contactName(c), phone: ph, sid: s.id }); });
      if (!cs.some((c) => e164(c.sms_phone || c.cell_phone)) && !(group && mine.some((c) => c.group_texts === false))) {
        const ph = e164(s.parent_phone);
        if (ph && !out.has(ph)) out.set(ph, { name: s.parent_name || '', phone: ph, sid: s.id });
      }
    });
    return [...out.values()];
  }
  function missingText(g) {   // {missing}: "Ana's blue form and birth certificate, and Leo's yellow form"
    const parts = g.kids.filter((s) => s.status === 'enrolled').map((s) => [s.name.split(' ')[0], missingDocs(s).map(([, long]) => long.toLowerCase())])
      .filter(([, docs]) => docs.length).map(([first, docs]) => `${first}'s ${andList(docs)}`);
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}` : parts[0] || 'nothing';
  }
  function msgText(body, g, to) {
    const first = String(to.name || '').trim().split(/\s+/)[0];
    const child = andList(g.kids.map((s) => s.name.split(' ')[0])) || 'your child';
    const cls = andList([...new Set(g.kids.filter((s) => s.classroom_id).map((s) => classroomName(s.classroom_id)).filter(Boolean))]) || 'class';
    const me = String(state.me.full_name || '').trim().split(/\s+/)[0] || 'the office';
    return body.replace(/ ?\{parent\}/gi, first ? ` ${first}` : '').replace(/\{child\}/gi, child).replace(/\{balance\}/gi, money(g.owes))
      .replace(/\{class\}/gi, cls).replace(/\{missing\}/gi, () => missingText(g)).replace(/\{me\}/gi, me).trim();
  }
  const msgList = (d) => d.listObj || (d.who.startsWith('list:') ? (state.msgLists || []).find((l) => `list:${l.id}` === d.who) : null);
  function msgAudience(d) {   // { fams, extra: other people [{name, phone}], group, secondary }
    const l = msgList(d);
    if (l) return { fams: msgFamilies(listKids(l)), extra: l.extra || [], group: true, secondary: l.both_parents };
    const en = (s) => s.status === 'enrolled';
    switch (d.who) {
      case 'all': return { fams: msgFamilies(en), group: true };
      case 'class': return { fams: msgFamilies((s) => en(s) && s.classroom_id === d.cls), group: true };
      case 'owe': return { fams: msgFamilies(anyKid).filter((g) => g.owes > 0), group: true };
      case 'late': return { fams: msgFamilies(anyKid).filter((g) => g.late > 0), group: true };
      case 'docs': return { fams: msgFamilies((s) => en(s) && missingDocs(s).length > 0), group: true };
      case 'waitlist': return { fams: msgFamilies((s) => s.status === 'waitlist'), group: true };
      case 'pick': return { fams: msgFamilies(pickable).filter((g) => g.keys.some((k) => d.picked.includes(k))), group: false };
      case 'one': return { fams: [], extra: d.onePhone.trim() ? [{ name: d.oneName.trim(), phone: d.onePhone.trim() }] : [], group: false };
      default: return { fams: [], group: true };
    }
  }
  function msgRecipients(d) {
    const a = msgAudience(d);
    const body = d.body.trim() + (d.stop && d.body.trim() && !/STOP/i.test(d.body) ? `\n${STOP_LINE}` : '');
    const send = [], skipped = [], used = new Set();
    const add = (g, to) => {
      if (textsStopped(to.phone)) return skipped.push({ g, why: `${to.name || to.phone} replied STOP` });
      if (used.has(to.phone)) return;
      used.add(to.phone);
      if (d.skip.includes(to.phone)) return skipped.push({ g, why: 'you took them off', phone: to.phone });
      const own = d.edits[to.phone];
      send.push({ g, to, text: own ?? msgText(body, g, to), edited: own != null });
    };
    a.fams.forEach((g) => {
      const phones = msgPhones(g, d.secondary || a.secondary, a.group);
      if (!phones.length) {
        const off = a.group && g.kids.some((s) => state.contacts.some((c) => c.student_id === s.id && c.group_texts === false));
        return skipped.push({ g, why: off ? 'nobody set to get group texts' : 'no cell number' });
      }
      phones.forEach((to) => add(g, to));
    });
    (a.extra || []).forEach((x) => {
      const g = { key: `x:${x.phone}`, kids: [], name: x.name || x.phone, owes: 0, late: 0, other: true };
      const phone = e164(x.phone);
      if (!phone) return skipped.push({ g, why: 'not a cell number' });
      add(g, { name: x.name || '', phone, sid: null });
    });
    return { fams: a.fams, list: msgList(d), send, skipped, body };
  }
  const smsParts = (t) => {   // how many texts Twilio bills for one message
    const wide = /[^\x00-\x7F]/.test(t);
    return t.length <= (wide ? 70 : 160) ? 1 : Math.ceil(t.length / (wide ? 67 : 153));
  };
  async function loadMsgTpls() {   // null until 014 / 015 are run
    const [t, l] = await Promise.all([sb.from('message_templates').select('*').order('sort').order('name'),
      sb.from('message_lists').select('*').order('sort').order('name')]);
    state.msgTpls = t.error ? null : t.data;
    state.msgLists = l.error ? null : l.data;
  }
  const newMsgDraft = () => ({ who: 'all', cls: state.classrooms[0]?.id || '', secondary: false, body: '', stop: true, when: 'now', at: '',
    picked: [], q: '', oneName: '', onePhone: '', tpl: null, tplName: '', edits: {}, skip: [], editing: null });
  const famCount = (n, x) => `${n} famil${n === 1 ? 'y' : 'ies'}${x ? ` + ${x} other${x === 1 ? '' : 's'}` : ''}`;
  function listSummary(l) {
    const cls = l.classes.map(classroomName).filter(Boolean), extra = (l.extra || []).length;
    return [cls.length ? cls.join(', ') : 'Every class', l.funding.length ? l.funding.map((f) => FUNDING[f] || f).join(', ') : '',
      l.both_parents ? 'both parents' : '', l.families.length ? `+${l.families.length} added by hand` : '',
      extra ? `+${extra} other${extra === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  }

  function renderMessages(el) {
    const d = state.msgDraft || (state.msgDraft = newMsgDraft());
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const whoOptions = () => (state.msgLists?.length ? `<optgroup label="My lists">${state.msgLists.map((l) => opt(`list:${l.id}`, l.name, d.who)).join('')}</optgroup>
      <optgroup label="More">` : '<optgroup label="Who">') + Object.entries(MSG_WHO).map(([k, v]) => opt(k, v, d.who)).join('') + '</optgroup>';
    el.innerHTML = `<div class="msg-grid">
      <section class="panel msg-compose"><h2>New text</h2>
        <form id="msg-form" class="grid2" novalidate>
          <label class="full">Who gets it<select name="who">${whoOptions()}</select></label>
          <p class="full muted small" id="msg-list-sum" hidden></p>
          <div class="full grid2" id="msg-one" ${d.who === 'one' ? '' : 'hidden'}>
            <label>Name<input name="oneName" maxlength="80" value="${esc(d.oneName)}" placeholder="e.g. Maria"></label>
            <label>Cell number<input name="onePhone" type="tel" value="${esc(d.onePhone)}" placeholder="(305) 555-0123"></label></div>
          <label class="full" id="msg-cls" ${d.who === 'class' ? '' : 'hidden'}>Class<select name="cls">${state.classrooms.map((c) => opt(c.id, c.name, d.cls)).join('')}</select></label>
          <div class="full" id="msg-pick" ${d.who === 'pick' ? '' : 'hidden'}><input type="search" name="q" placeholder="Search families…" value="${esc(d.q)}">
            <div class="msg-pick" id="msg-pick-list"></div></div>
          <label class="full pill-check"><input type="checkbox" class="check" name="secondary" ${d.secondary ? 'checked' : ''}> Also text the second parent (Secondary contact)</label>
          <div class="full msg-templates" id="msg-tpls"></div>
          <label class="full">Message<textarea name="body" rows="6" maxlength="900"
            placeholder="Write it your way. Tap a block below to add each family’s names, e.g. Hi {parent}! …">${esc(d.body)}</textarea></label>
          <div class="full msg-blocks"><span class="muted small">Add:</span>
            ${MSG_BLOCKS.map(([tok, label]) => `<button class="btn small block-btn" type="button" data-block="${esc(tok)}">${esc(label)}</button>`).join('')}</div>
          <p class="full muted small msg-help">Blocks are filled in for each family: see how every text reads under <b>Who gets it</b>,
            and change any one of them there. <span id="msg-count"></span>
            <button class="btn ghost small" type="button" id="msg-next-blank" hidden>Fill in the next [blank]</button></p>
          <div class="full msg-save" id="msg-save-row"></div>
          <label class="full pill-check"><input type="checkbox" class="check" name="stop" ${d.stop ? 'checked' : ''}> End with “${STOP_LINE}”</label>
          <label>When<select name="when">${opt('now', 'Send now', d.when)}${opt('later', 'Later…', d.when)}</select></label>
          <label id="msg-at" ${d.when === 'later' ? '' : 'hidden'}>On<input type="datetime-local" name="at" value="${esc(d.at)}"></label>
          <div class="full"><button class="btn primary" id="msg-send" type="button">Send</button></div>
        </form></section>
      <section class="panel msg-preview"><h2>Who gets it <span class="muted small" id="msg-sum"></span></h2><div id="msg-list"></div></section>
    </div>
    <section class="panel msg-lists"><div class="msg-lists-head"><h2>My lists</h2>
        <button class="btn small" type="button" id="list-new" hidden>+ New list</button></div>
      <p class="muted small">Like TextMagic’s lists, but the CRM keeps them up to date: a child who changes class or funding moves lists
        by themselves. Each family gets the text at the contacts set to get group texts (the Primary contact, unless you change it
        on the child’s page).</p>
      <div id="msg-lists-body"><p class="muted">Loading…</p></div></section>
    <section class="panel msg-history"><h2>Texts sent</h2>
      <div class="table-wrap flat"><table><thead><tr><th>When</th><th>By</th><th>To</th><th>Message</th><th>Status</th></tr></thead>
        <tbody id="msg-hist"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table></div>
      <p class="muted small">Texts go out between 8am and 9pm Miami time (one written later waits until 8am). Families who replied STOP are skipped.
        Replies go to the school’s Twilio number${state.settings?.telegram_token_set ? ' and are copied to Telegram' : ''}.</p></section>`;
    const form = $('#msg-form', el);
    const setBody = (v) => { d.body = form.body.value = v; d.edits = {}; d.editing = null; };
    const selectBlank = (from) => {   // select the next [blank] (brackets too), so typing replaces it
      const ta = form.body, re = /\[[^\]]*\]/g;
      re.lastIndex = from;
      let m = re.exec(ta.value);
      if (!m && from) { re.lastIndex = 0; m = re.exec(ta.value); }
      if (!m) return false;
      ta.focus();
      ta.setSelectionRange(m.index, m.index + m[0].length);
      return true;
    };
    $('#msg-next-blank', el).addEventListener('click', () => selectBlank(form.body.selectionEnd || 0));

    // My messages: start from one, save the one being written, change or delete a saved one
    const drawTpls = () => {
      const saved = state.msgTpls, list = saved || MSG_EXAMPLES;
      $('#msg-tpls', el).innerHTML = `<span class="muted small">${saved ? 'My messages:' : 'Start from:'}</span>
        ${list.map((t) => `<button class="btn small ${t.id === d.tpl ? 'on' : ''}" type="button" data-tpl="${esc(t.id)}">${esc(t.name)}</button>`).join('')}
        ${saved ? '<button class="btn small ghost" type="button" data-tpl-new>+ New message</button>' : ''}
        ${saved && !saved.length ? '<span class="muted small">None saved yet: write one below and save it.</span>' : ''}`;
      const cur = saved?.find((t) => t.id === d.tpl);
      $('#msg-save-row', el).innerHTML = saved === undefined ? ''
        : saved === null ? '<p class="muted small">To save your own messages here, run <code>014_message_templates.sql</code> in Supabase.</p>'
          : `<input name="tplName" maxlength="60" placeholder="Name it to save it, e.g. Picture day" value="${esc(d.tplName)}">
            ${cur ? `<button class="btn small" type="button" id="tpl-update">Save changes</button>
              <button class="btn small" type="button" id="tpl-new">Save as new</button>
              <button class="btn small ghost danger" type="button" id="tpl-del">Delete</button>`
              : '<button class="btn small" type="button" id="tpl-new">Save to My messages</button>'}`;
      $$('[data-tpl]', el).forEach((b) => b.addEventListener('click', () => {
        const t = list.find((x) => x.id === b.dataset.tpl);
        if (d.body.trim() && d.body !== t.body && d.body !== (list.find((x) => x.id === d.tpl)?.body) && !confirm('Replace what you’ve written?')) return;
        setBody(t.body);
        d.tpl = saved ? t.id : null;
        d.tplName = saved ? t.name : '';
        if (/\{balance\}/i.test(t.body) && d.who === 'all') d.who = form.who.value = 'owe';
        if (/\{missing\}/i.test(t.body) && d.who === 'all') d.who = form.who.value = 'docs';
        drawTpls();
        draw();
        if (!selectBlank(0)) form.body.focus();
      }));
      $('[data-tpl-new]', el)?.addEventListener('click', () => {
        if (d.body.trim() && !cur && !confirm('Start over? What you’ve written will be cleared.')) return;
        setBody('');
        d.tpl = null;
        d.tplName = '';
        drawTpls();
        draw();
        form.body.focus();
      });
      const saveTpl = async (asNew) => {
        const name = d.tplName.trim(), body = d.body.trim();
        if (!body) return toast('Write the message first', true);
        if (!name) { form.tplName.focus(); return toast('Give it a name first', true); }
        const q = asNew ? sb.from('message_templates').insert({ name, body, sort: Math.max(0, ...saved.map((t) => t.sort)) + 1 })
          : sb.from('message_templates').update({ name, body, updated_at: new Date().toISOString() }).eq('id', cur.id);
        const { data, error } = await q.select().single();
        if (error) return fail(error, 'Could not save it');
        state.msgTpls = asNew ? [...saved, data] : saved.map((t) => (t.id === data.id ? data : t));
        d.tpl = data.id;
        drawTpls();
        toast(asNew ? `Saved “${name}” to My messages` : `Saved changes to “${name}”`);
      };
      $('#tpl-new', el)?.addEventListener('click', () => saveTpl(true));
      $('#tpl-update', el)?.addEventListener('click', () => saveTpl(false));
      $('#tpl-del', el)?.addEventListener('click', async () => {
        if (!confirm(`Delete “${cur.name}” from My messages? (Texts already sent stay in Texts sent.)`)) return;
        const { error } = await sb.from('message_templates').delete().eq('id', cur.id);
        if (error) return fail(error, 'Could not delete it');
        state.msgTpls = saved.filter((t) => t.id !== cur.id);
        d.tpl = null;
        d.tplName = '';
        drawTpls();
        toast(`Deleted “${cur.name}”`);
      });
    };

    const draw = () => {
      const r = msgRecipients(d);
      $('#msg-cls', el).hidden = d.who !== 'class';
      $('#msg-pick', el).hidden = d.who !== 'pick';
      $('#msg-one', el).hidden = d.who !== 'one';
      $('#msg-list-sum', el).hidden = !r.list;
      if (r.list) $('#msg-list-sum', el).textContent = listSummary(r.list);
      $('#msg-at', el).hidden = d.when !== 'later';
      $('#msg-next-blank', el).hidden = !HAS_BLANK.test(d.body);
      if (d.who === 'pick') {
        const q = d.q.trim().toLowerCase();
        $('#msg-pick-list', el).innerHTML = msgFamilies(pickable).filter((g) => !q || `${g.name} ${g.kids.map((s) => s.name).join(' ')}`.toLowerCase().includes(q))
          .map((g) => `<label class="pill-check"><input type="checkbox" class="check" data-fam="${esc(g.keys.join('|'))}" ${g.keys.some((k) => d.picked.includes(k)) ? 'checked' : ''}>
            ${esc(g.name)} <span class="muted small">${esc(g.kids.map((s) => s.name.split(' ')[0]).join(', '))}</span></label>`).join('');
        $$('#msg-pick-list [data-fam]', el).forEach((b) => b.addEventListener('change', () => {
          const keys = b.dataset.fam.split('|');
          d.picked = b.checked ? [...new Set([...d.picked, ...keys])] : d.picked.filter((k) => !keys.includes(k));
          draw();
        }));
      }
      const longest = r.send.reduce((m, x) => (x.text.length > m.length ? x.text : m), r.body);
      $('#msg-count', el).textContent = d.body.trim() ? `${longest.length} characters · ${smsParts(longest)} text${smsParts(longest) === 1 ? '' : 's'} each` : '';
      $('#msg-sum', el).textContent = `${r.send.length} text${r.send.length === 1 ? '' : 's'}${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}`;
      $('#msg-send', el).textContent = r.send.length ? `${d.when === 'later' ? 'Schedule' : 'Send'} ${r.send.length} text${r.send.length === 1 ? '' : 's'}` : 'Send';
      const zero = /\{balance\}/i.test(d.body) ? r.send.filter((x) => !x.g.owes && !x.edited).length : 0;
      const one = (x) => {
        const ph = esc(x.to.phone);
        const acts = `<span class="msg-acts">${d.body.trim() && d.editing !== x.to.phone ? `<button class="btn ghost small" type="button" data-edit-one="${ph}">Change</button>` : ''}
          ${x.edited ? `<button class="btn ghost small" type="button" data-undo-one="${ph}">Undo change</button>` : ''}
          <button class="btn ghost small" type="button" data-skip-one="${ph}">Don’t send</button></span>`;
        const text = d.editing === x.to.phone
          ? `<textarea class="msg-one" data-one="${ph}" rows="4" maxlength="1500">${esc(x.text)}</textarea>
            <div><button class="btn small" type="button" data-done-one>Done</button></div>`
          : d.body.trim() ? `<div class="msg-bubble">${esc(x.text)}</div>${x.edited ? '<span class="muted small">Changed just for them</span>' : ''}` : '';
        return `<li><div class="msg-to-head"><div><b>${esc(x.to.name || x.g.name)}</b>
          <span class="muted small">${esc(x.g.kids.map((s) => s.name).join(', '))} · ${esc(x.to.phone)}${x.g.owes ? ` · owes ${money(x.g.owes)}` : ''}</span></div>${acts}</div>${text}</li>`;
      };
      $('#msg-list', el).innerHTML = (zero ? `<p class="check-warn small">${zero} of these famil${zero === 1 ? 'y owes' : 'ies owe'} $0.00, so the balance block reads $0.00 for them.</p>` : '')
        + (r.send.length ? `<ul class="msg-to">${r.send.slice(0, 60).map(one).join('')}</ul>${r.send.length > 60 ? `<p class="muted small">…and ${r.send.length - 60} more.</p>` : ''}`
          : '<p class="muted">Nobody to text yet.</p>')
        + (r.skipped.length ? `<p class="muted small"><b>Skipped:</b> ${r.skipped.map((x) => `${esc(x.g.name)} (${esc(x.why)}${x.phone
          ? ` · <button class="btn ghost small" type="button" data-unskip="${esc(x.phone)}">put back</button>` : ''})`).join(', ')}</p>` : '');
      $$('[data-edit-one]', el).forEach((b) => b.addEventListener('click', () => {
        d.editing = b.dataset.editOne;
        draw();
        const ta = $(`.msg-one[data-one="${CSS.escape(d.editing)}"]`, el);
        ta?.focus();
        ta?.setSelectionRange(ta.value.length, ta.value.length);
      }));
      $$('.msg-one', el).forEach((ta) => ta.addEventListener('input', () => { d.edits[ta.dataset.one] = ta.value; }));
      $$('[data-done-one]', el).forEach((b) => b.addEventListener('click', () => {
        const x = r.send.find((y) => y.to.phone === d.editing);
        if (x && d.edits[d.editing] != null && (!d.edits[d.editing].trim() || d.edits[d.editing] === msgText(r.body, x.g, x.to))) delete d.edits[d.editing];
        d.editing = null;
        draw();
      }));
      $$('[data-undo-one]', el).forEach((b) => b.addEventListener('click', () => { delete d.edits[b.dataset.undoOne]; d.editing = null; draw(); }));
      $$('[data-skip-one]', el).forEach((b) => b.addEventListener('click', () => { d.skip.push(b.dataset.skipOne); if (d.editing === b.dataset.skipOne) d.editing = null; draw(); }));
      $$('[data-unskip]', el).forEach((b) => b.addEventListener('click', () => { d.skip = d.skip.filter((x) => x !== b.dataset.unskip); draw(); }));
    };
    form.addEventListener('input', (e) => {
      const t = e.target;
      if (!t.name) return;
      d[t.name] = t.type === 'checkbox' ? t.checked : t.value;
      if (t.name !== 'tplName') draw();
    });
    form.addEventListener('change', (e) => {
      if (!e.target.name || e.target.name === 'tplName' || e.target.name === 'body') return;
      d[e.target.name] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      draw();
    });
    $$('[data-block]', el).forEach((b) => b.addEventListener('click', () => {
      const ta = form.body, blank = b.dataset.block === '[ ]', tok = blank ? '[write here]' : b.dataset.block;
      const a = ta.selectionStart ?? ta.value.length, z = ta.selectionEnd ?? a;
      const before = ta.value.slice(0, a), after = ta.value.slice(z);
      const pad = /[^\s(\[]$/.test(before) ? ' ' : '';   // "Hi" + {parent} → "Hi {parent}"
      ta.value = before + pad + tok + after;
      d.body = ta.value;
      ta.focus();
      const at = a + pad.length;
      if (blank) ta.setSelectionRange(at + 1, at + tok.length - 1);   // "write here" selected: just type over it
      else ta.setSelectionRange(at + tok.length, at + tok.length);
      draw();
    }));
    $('#msg-send', el).addEventListener('click', async () => {
      const r = msgRecipients(d);
      if (!d.body.trim()) return toast('Write the message first', true);
      if (r.send.some((x) => HAS_BLANK.test(x.text))) { selectBlank(0); return toast('Fill in the parts in [brackets] first', true); }
      if (!r.send.length) return toast('Nobody to text', true);
      let at = new Date();
      if (d.when === 'later') {
        if (!d.at) return toast('Pick when to send it', true);
        at = new Date(d.at);
        if (at < new Date()) return toast('Pick a time that hasn’t passed', true);
      }
      if (!confirm(`${d.when === 'later' ? `Schedule ${r.send.length} text${r.send.length === 1 ? '' : 's'} for ${fmtDateTime(at.toISOString())}` : `Send ${r.send.length} text${r.send.length === 1 ? '' : 's'} now`}?`)) return;
      const btn = $('#msg-send', el);
      btn.disabled = true;
      const audience = r.list ? r.list.name : d.who === 'class' ? `${classroomName(d.cls)} families`
        : d.who === 'pick' ? `${r.fams.length} famil${r.fams.length === 1 ? 'y' : 'ies'} picked` : d.who === 'one' ? (d.oneName.trim() || 'One person') : MSG_WHO[d.who];
      const { data: m, error } = await sb.from('messages').insert({ audience: `${audience} (${r.send.length})`, body: r.body, send_at: at.toISOString(), created_by: state.me.id })
        .select().single();
      if (error) { btn.disabled = false; return fail(error, 'Could not save the text'); }
      const rows = r.send.map((x) => ({ message_id: m.id, student_id: x.to.sid, name: x.to.name || null, phone: x.to.phone, body: x.text.trim() }));
      for (let i = 0; i < rows.length; i += 200) {
        const { error: e2 } = await sb.from('message_recipients').insert(rows.slice(i, i + 200));
        if (e2) { btn.disabled = false; return fail(e2, 'Could not save the text'); }
      }
      let note = d.when === 'later' ? `Scheduled for ${fmtDateTime(at.toISOString())}` : 'Saved';
      if (d.when === 'now') {
        btn.textContent = 'Sending…';
        const tot = { sent: 0, failed: 0 };
        let out = null;
        try {
          for (let k = 0; k < 30; k++) {   // each call sends for a few seconds; call again while there are more
            const res = await fetch('/.netlify/functions/family-texts', { method: 'POST' });
            out = res.ok ? await res.json() : null;
            if (!out || out.dryRun) break;
            tot.sent += out.sent; tot.failed += out.failed;
            btn.textContent = `Sending… ${tot.sent} sent`;
            if (!out.more || !out.due) break;
          }
        } catch { out = null; }
        note = out?.dryRun ? 'Saved. Twilio isn’t connected yet, so the texts are waiting; they go out once it is'
          : tot.sent || tot.failed ? `${tot.sent} sent${tot.failed ? `, ${tot.failed} failed (see Texts sent)` : ''}${out?.more ? '; the rest go out within the hour' : ''}`
            : out?.due === 0 ? 'Saved: texts go out between 8am and 9pm, so these go at 8am' : 'Saved: the texts go out within the hour';
      }
      toast(note);
      state.msgDraft = null;
      renderMessages(el);
    });
    // My lists
    const drawLists = () => {
      const lists = state.msgLists, body = $('#msg-lists-body', el);
      if (!body) return;
      $('#list-new', el).hidden = !lists;
      if (lists === undefined) return;
      if (lists === null) { body.innerHTML = '<p class="muted small">To use lists, run <code>015_message_lists.sql</code> in Supabase.</p>'; return; }
      body.innerHTML = lists.length ? `<ul class="msg-lists-ul">${lists.map((l) => {
        const r = msgRecipients({ ...newMsgDraft(), listObj: l });
        return `<li><div class="ml-name"><b>${esc(l.name)}</b><span class="muted small">${esc(listSummary(l))}</span></div>
          <span class="muted small ml-count">${famCount(r.fams.length, (l.extra || []).length)} · ${r.send.length} text${r.send.length === 1 ? '' : 's'}</span>
          <span class="ml-acts"><button class="btn small" type="button" data-list-text="${l.id}">Text this list</button>
            <button class="btn ghost small" type="button" data-list-edit="${l.id}">Edit</button></span></li>`;
      }).join('')}</ul>` : '<p class="muted">No lists yet.</p>';
      $$('[data-list-text]', el).forEach((b) => b.addEventListener('click', () => {
        d.who = form.who.value = `list:${b.dataset.listText}`;
        d.edits = {}; d.skip = []; d.editing = null;
        draw();
        $('.msg-compose', el).scrollIntoView({ behavior: 'smooth', block: 'start' });
      }));
      $$('[data-list-edit]', el).forEach((b) => b.addEventListener('click', () => openList(lists.find((l) => l.id === b.dataset.listEdit))));
    };
    $('#list-new', el).addEventListener('click', () => openList(null));

    drawTpls();
    draw();
    drawLists();
    if (state.msgTpls === undefined) {
      loadMsgTpls().then(() => {
        if (!$('#msg-tpls', el)) return;
        if (d.who.startsWith('list:') && !msgList(d)) d.who = 'all';
        form.who.innerHTML = whoOptions();
        drawTpls();
        draw();
        drawLists();
      });
    }
    loadMsgHistory(el);
  }

  // Make or change a list (015)
  function openList(l) {
    const L = l ? { ...l, classes: [...l.classes], funding: [...l.funding], families: [...l.families], extra: [...(l.extra || [])] }
      : { name: '', classes: [], funding: [], both_parents: false, families: [], extra: [] };
    const box = (attr, v, label, on) => `<label class="pill-check"><input type="checkbox" class="check" ${attr}="${esc(v)}" ${on ? 'checked' : ''}> ${esc(label)}</label>`;
    const ctl = mountDrawer({
      title: l ? esc(l.name) : 'New list',
      sub: 'Kept up to date from each child’s class and funding',
      body: `<div class="section"><label>Name<input name="name" maxlength="60" value="${esc(L.name)}" placeholder="e.g. VPK Moms"></label></div>
        <div class="section"><h3>Children in these classes</h3><p class="muted small">None ticked = every class.</p>
          <div class="funding-boxes">${state.classrooms.map((c) => box('data-cls', c.id, c.name, L.classes.includes(c.id))).join('')}</div></div>
        <div class="section"><h3>With this funding</h3><p class="muted small">None ticked = any funding.</p>
          <div class="funding-boxes">${Object.entries(FUNDING).map(([k, v]) => box('data-fund', k, v, L.funding.includes(k))).join('')}</div>
          <label class="pill-check ls-both"><input type="checkbox" class="check" name="both_parents" ${L.both_parents ? 'checked' : ''}>
            Also text the second parent (Secondary contact)</label></div>
        <div class="section"><h3>Families added by hand</h3><p class="muted small">On the list whatever their class or funding.</p>
          <ul class="chg-list mini" id="ls-fams"></ul>
          <input type="search" id="ls-q" placeholder="Add a family: type a child’s or parent’s name…" autocomplete="off">
          <div class="msg-pick" id="ls-found" hidden></div></div>
        <div class="section"><h3>Other people</h3><p class="muted small">Not a family in the CRM: for example yourself, to get a copy, or a grandparent.</p>
          <ul class="chg-list mini" id="ls-extra"></ul>
          <div class="grid2 ls-add"><input id="ls-xname" placeholder="Name" maxlength="80"><input id="ls-xphone" type="tel" placeholder="Cell number"></div>
          <button class="btn small" type="button" id="ls-xadd">+ Add person</button></div>
        <div class="section"><h3>On this list now <span class="muted small" id="ls-count"></span></h3><ul class="chg-list mini" id="ls-now"></ul></div>`,
      foot: `${l ? '<button class="btn danger" id="ls-del" type="button">Delete list</button>' : ''}<span class="spacer"></span>
        <button class="btn" data-close type="button">Cancel</button><button class="btn primary" id="ls-save" type="button">Save</button>`,
    });
    const { drawer, form } = ctl;
    const drawNow = () => {
      const r = msgRecipients({ ...newMsgDraft(), listObj: L });
      $('#ls-count', drawer).textContent = `${famCount(r.fams.length, L.extra.length)} · ${r.send.length} text${r.send.length === 1 ? '' : 's'}`;
      $('#ls-now', drawer).innerHTML = r.send.map((x) => `<li><span><b>${esc(x.to.name || x.g.name)}</b>
          <span class="muted small">${esc(x.g.other ? 'other person' : x.g.kids.map((k) => k.name).join(', '))} · ${esc(x.to.phone)}</span></span></li>`).join('')
        + r.skipped.map((x) => `<li class="muted"><span>${esc(x.g.name)} <span class="small">(${esc(x.why)})</span></span></li>`).join('')
        || '<li class="muted small">Nobody yet.</li>';
    };
    const drawFams = () => {
      $('#ls-fams', drawer).innerHTML = L.families.map((id) => state.students.find((s) => s.id === id)).filter(Boolean).map((s) => `<li>
          <span><b>${esc(s.name)}</b> <span class="muted small">${esc(s.parent_name || '')}</span></span>
          <button class="btn ghost small" type="button" data-unfam="${s.id}" aria-label="Take off">✕</button></li>`).join('');
      $$('[data-unfam]', drawer).forEach((b) => b.addEventListener('click', () => {
        L.families = L.families.filter((x) => x !== b.dataset.unfam);
        ctl.dirty = true; drawFams(); drawNow();
      }));
    };
    const drawExtra = () => {
      $('#ls-extra', drawer).innerHTML = L.extra.map((x, i) => `<li><span><b>${esc(x.name || 'No name')}</b> <span class="muted small">${esc(x.phone)}</span></span>
          <button class="btn ghost small" type="button" data-unx="${i}" aria-label="Take off">✕</button></li>`).join('');
      $$('[data-unx]', drawer).forEach((b) => b.addEventListener('click', () => {
        L.extra.splice(Number(b.dataset.unx), 1);
        ctl.dirty = true; drawExtra(); drawNow();
      }));
    };
    $$('[data-cls]', drawer).forEach((b) => b.addEventListener('change', () => {
      L.classes = b.checked ? [...L.classes, b.dataset.cls] : L.classes.filter((x) => x !== b.dataset.cls); drawNow();
    }));
    $$('[data-fund]', drawer).forEach((b) => b.addEventListener('change', () => {
      L.funding = b.checked ? [...L.funding, b.dataset.fund] : L.funding.filter((x) => x !== b.dataset.fund); drawNow();
    }));
    form.both_parents.addEventListener('change', () => { L.both_parents = form.both_parents.checked; drawNow(); });
    $('#ls-q', drawer).addEventListener('input', () => {
      const q = $('#ls-q', drawer).value.trim().toLowerCase(), found = $('#ls-found', drawer);
      const hits = q.length < 2 ? [] : state.students.filter((s) => pickable(s) && !L.families.includes(s.id)
        && `${s.name} ${s.parent_name || ''} ${state.contacts.filter((c) => c.student_id === s.id).map(contactName).join(' ')}`.toLowerCase().includes(q)).slice(0, 12);
      found.hidden = !hits.length;
      found.innerHTML = hits.map((s) => `<button class="btn ghost small" type="button" data-addfam="${s.id}">${esc(s.name)}
          <span class="muted small">${esc([classroomName(s.classroom_id), STUDENT_STATUS[s.status]].filter(Boolean).join(' · '))}</span></button>`).join('');
      $$('[data-addfam]', found).forEach((b) => b.addEventListener('click', () => {
        L.families.push(b.dataset.addfam);
        $('#ls-q', drawer).value = ''; found.hidden = true;
        ctl.dirty = true; drawFams(); drawNow();
      }));
    });
    $('#ls-xadd', drawer).addEventListener('click', () => {
      const name = $('#ls-xname', drawer).value.trim(), phone = e164($('#ls-xphone', drawer).value);
      if (!phone) { $('#ls-xphone', drawer).focus(); return toast('Type a US cell number, e.g. (305) 555-0123', true); }
      if (L.extra.some((x) => x.phone === phone)) return toast('That number is already on the list', true);
      L.extra.push({ name, phone });
      $('#ls-xname', drawer).value = ''; $('#ls-xphone', drawer).value = '';
      ctl.dirty = true; drawExtra(); drawNow();
    });
    $('#ls-save', drawer).addEventListener('click', async () => {
      const name = form.name.value.trim();
      if (!name) { form.name.focus(); return toast('Give the list a name', true); }
      const row = { name, classes: L.classes, funding: L.funding, both_parents: L.both_parents, families: L.families, extra: L.extra };
      const q = l ? sb.from('message_lists').update({ ...row, updated_at: new Date().toISOString() }).eq('id', l.id)
        : sb.from('message_lists').insert({ ...row, sort: Math.max(0, ...state.msgLists.map((x) => x.sort)) + 1 });
      const { data, error } = await q.select().single();
      if (error) return fail(error, 'Could not save the list');
      state.msgLists = l ? state.msgLists.map((x) => (x.id === data.id ? data : x)) : [...state.msgLists, data];
      ctl.dirty = false;
      closeDrawer();
      toast(`Saved “${name}”`);
      renderView();
    });
    $('#ls-del', drawer)?.addEventListener('click', async () => {
      if (!confirm(`Delete the list “${l.name}”? (Nobody is removed from the CRM, and texts already sent stay in Texts sent.)`)) return;
      const { error } = await sb.from('message_lists').delete().eq('id', l.id);
      if (error) return fail(error, 'Could not delete the list');
      state.msgLists = state.msgLists.filter((x) => x.id !== l.id);
      if (state.msgDraft?.who === `list:${l.id}`) state.msgDraft.who = 'all';
      ctl.dirty = false;
      closeDrawer();
      toast(`Deleted “${l.name}”`);
      renderView();
    });
    drawFams();
    drawExtra();
    drawNow();
    form.name.focus();
  }

  async function loadMsgHistory(el) {
    const { data: ms, error } = await sb.from('messages').select('*').order('created_at', { ascending: false }).limit(60);
    const tbody = $('#msg-hist', el);
    if (!tbody) return;
    if (error) { tbody.innerHTML = '<tr><td colspan="5" class="muted">Could not load texts.</td></tr>'; return; }
    const ids = ms.map((m) => m.id);
    const recs = [];
    for (let i = 0; i < ids.length; i += 20) {
      const { data } = await sb.from('message_recipients').select('*').in('message_id', ids.slice(i, i + 20)).limit(5000);
      recs.push(...(data || []));
    }
    const by = (id) => recs.filter((r) => r.message_id === id);
    tbody.innerHTML = ms.map((m) => {
      const rs = by(m.id), n = (st) => rs.filter((r) => r.status === st).length;
      const parts = [['sent', 'sent'], ['queued', 'waiting'], ['sending', 'sending'], ['failed', 'failed'], ['opted_out', 'opted out'], ['canceled', 'canceled']]
        .filter(([k]) => n(k)).map(([k, label]) => `${n(k)} ${label}`);
      return `<tr data-msg="${m.id}"><td class="nowrap">${esc(fmtDateTime(m.send_at > m.created_at ? m.send_at : m.created_at))}${m.send_at > new Date().toISOString() && !m.canceled_at ? '<div class="muted small">scheduled</div>' : ''}</td>
        <td>${esc(m.created_by === state.me.id ? 'You' : staffName(m.created_by))}</td><td>${esc(m.audience)}</td>
        <td class="small">${esc(m.body.length > 90 ? m.body.slice(0, 87) + '…' : m.body)}</td>
        <td><span class="pay-pill ps-${n('failed') ? 'overdue' : n('queued') || n('sending') ? 'open' : m.canceled_at ? 'void' : 'paid'}">${esc(parts.join(' · ') || '—')}</span></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">No texts sent yet.</td></tr>';
    $$('#msg-hist tr[data-msg]', el).forEach((tr) => tr.addEventListener('click', () => {
      const m = ms.find((x) => x.id === tr.dataset.msg);
      openMessage(m, by(m.id), el);
    }));
  }

  function openMessage(m, rs, el) {
    const waiting = rs.some((r) => r.status === 'queued');
    const ctl = mountDrawer({
      title: esc(m.audience),
      sub: esc(`${m.created_by === state.me.id ? 'You' : staffName(m.created_by)} · ${fmtDateTime(m.created_at)}${m.send_at > m.created_at ? ` · for ${fmtDateTime(m.send_at)}` : ''}`),
      body: `<div class="section"><h3>Message</h3><div class="msg-bubble">${esc(m.body)}</div></div>
        <div class="section"><h3>Families (${rs.length})</h3><ul class="chg-list mini">${rs.sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((r) => `<li>
          <span class="pay-pill ps-${MSG_PILL[r.status]}">${esc(MSG_STATUS[r.status])}</span>
          <span><b>${esc(r.name || r.phone)}</b> <span class="muted small">${esc(r.phone)}${r.sent_at ? ` · ${esc(fmtDateTime(r.sent_at))}` : ''}</span>
          <div class="small msg-their">${esc(r.body)}</div>
          ${r.error ? `<div class="check-warn small">${esc(r.error)}</div>` : ''}</span></li>`).join('')}</ul></div>`,
      foot: `${waiting ? '<button class="btn danger" id="msg-cancel" type="button">Cancel the ones not sent</button>' : ''}<span class="spacer"></span>
        <button class="btn" data-close type="button">Close</button>`,
    });
    $('#msg-cancel', ctl.drawer)?.addEventListener('click', async () => {
      if (!confirm('Cancel this text for everyone it hasn’t gone to yet?')) return;
      const { data, error } = await sb.rpc('message_cancel', { p_message: m.id });
      if (error) return fail(error, 'Could not cancel');
      toast(`Canceled for ${data} famil${data === 1 ? 'y' : 'ies'}`);
      closeDrawer();
      loadMsgHistory(el);
    });
  }

  // ───────────── Changes (012): who changed what ─────────────
  const CHANGE_AREA = { enrollment: 'Enrollment', finance: 'Tuition & payments', payroll: 'Payroll', settings: 'Settings & access' };
  const FIELD_LABEL = { name: 'name', dob: 'birthday', classroom_id: 'class', status: 'status', start_date: 'start date', withdrawn_on: 'last day',
    withdraw_reason: 'reason', parent_name: 'parent', parent_phone: 'parent phone', parent_email: 'parent email', notes: 'notes', rbt: 'RBT',
    therapy: 'therapy', reg_fee: 'registration fee', doc_registration: 'registration packet', doc_blue_form: 'blue form', doc_yellow_form: 'yellow form',
    doc_birth_cert: 'birth certificate', family_account: 'family account', funding: 'funding', tuition_amount: 'rate', tuition_frequency: 'billed',
    award_id: 'award ID', billing_program: 'billing item', bill_family: 'billed to family', amount: 'amount', paid_on: 'date received', method: 'method',
    payer: 'paid by', reference: 'reference', note: 'note', invoice_id: 'invoice', covers_month: 'month', void: 'void', description: 'description',
    due_date: 'due', invoice_date: 'date', clock_in: 'clock in', clock_out: 'clock out', out_reason: 'left for', pay_rate: 'pay rate', position: 'position',
    lunch_minutes: 'lunch', schedule: 'schedule', active: 'active', first_name: 'first name', last_name: 'last name', relationship: 'relationship',
    role: 'role', cell_phone: 'cell', work_phone: 'work phone', home_phone: 'home phone', sms_phone: 'texts to', email: 'email', paid: 'paid',
    needs_check: 'to check', finance: 'finances', payroll: 'payroll', capacity: 'capacity', teachers: 'teachers', sort: 'order', full_name: 'name',
    group_texts: 'group texts' };
  const MONEY_KEYS = new Set(['amount', 'tuition_amount', 'pay_rate', 'paid', 'balance', 'late_fee_amount']);
  function fmtVal(k, v) {
    if (v == null || v === '') return '—';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (MONEY_KEYS.has(k)) return money(v);
    if (k === 'funding') return (v.length ? v : ['private']).map((x) => FUNDING[x] || x).join(', ');
    if (k === 'classroom_id') return classroomName(v) || 'a class';
    if (k === 'status') return (STUDENT_STATUS[v] || v).toLowerCase();
    if (k === 'method') return METHOD[v] || v;
    if (k === 'payer') return PAYER[v] || v;
    if (k === 'role') return CONTACT_ROLE[v] || v;
    if (k === 'invoice_id') { const inv = state.invoices.find((i) => i.id === v); return inv ? invoiceLabel(inv) : 'an invoice'; }
    if (k === 'clock_in' || k === 'clock_out') return clockTime(v);
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDate(v);
    const t = typeof v === 'string' ? v : JSON.stringify(v);
    return t.length > 60 ? t.slice(0, 57) + '…' : t;
  }
  const diffText = (c, max = 3) => {
    const parts = Object.entries(c.diff || {}).map(([k, [a, b]]) => `${FIELD_LABEL[k] || k.replace(/_/g, ' ')} ${fmtVal(k, a)} → ${fmtVal(k, b)}`);
    return parts.slice(0, max).join('; ') + (parts.length > max ? `; and ${parts.length - max} more` : '');
  };
  function describeChange(c) {
    const d = c.data || {}, act = { insert: 'added', update: 'changed', delete: 'removed' }[c.action];
    const kid = state.students.find((x) => x.id === c.student_id)?.name || (c.table_name === 'students' ? d.name : '') || 'a child';
    const emp = state.changeEmps?.[c.employee_id] || (d.first_name ? [d.first_name, d.last_name].filter(Boolean).join(' ') : 'a staff member');
    const dt = diffText(c);
    switch (c.table_name) {
      case 'students': return c.action === 'insert' ? `added ${kid}${d.classroom_id ? ` to ${classroomName(d.classroom_id)}` : ''}`
        : c.action === 'delete' ? `deleted ${kid}` : `changed ${kid}: ${dt}`;
      case 'student_finance': return c.action === 'update' ? `changed tuition for ${kid}: ${dt}` : `${c.action === 'insert' ? 'set up' : 'removed'} tuition for ${kid}`;
      case 'payments': return c.action === 'insert' ? `recorded a ${money(d.amount)} ${METHOD[d.method] || ''} payment for ${kid} (receipt #${d.receipt_no})`
        : c.action === 'delete' ? `deleted payment #${d.receipt_no} (${money(d.amount)}) for ${kid}` : `changed payment #${d.receipt_no} for ${kid}: ${dt}`;
      case 'invoices': {
        const what = d.late_fee_for ? 'late fee' : 'bill';
        if (c.action === 'insert') return d.late_fee_for ? `added a ${money(d.amount)} late fee for ${kid}`
          : `billed ${kid} ${money(d.amount)} (${d.description}${d.period_start ? ` · ${fmtPeriod(d.period_start)}` : ''})`;
        if (c.action === 'delete') return `deleted ${kid}’s ${what} (${money(d.amount)})`;
        if (c.diff?.void && c.diff.void[1] === true) return d.late_fee_for ? `waived the ${money(d.amount)} late fee for ${kid}` : `voided ${kid}’s ${money(d.amount)} bill`;
        return `changed ${kid}’s ${what}: ${dt}`;
      }
      case 'student_contacts': return `${act} ${CONTACT_ROLE[d.role]?.toLowerCase() || ''} contact ${[d.first_name, d.last_name].filter(Boolean).join(' ')} for ${kid}${c.action === 'update' ? `: ${dt}` : ''}`;
      case 'classrooms': return `${act} class ${d.name}${c.action === 'update' ? `: ${dt}` : ''}`;
      case 'billing_history': return c.action === 'update' ? `confirmed ${d.family_account || d.customer}’s amount for tuition ${d.period_start ? fmtPeriod(d.period_start) : ''}: ${dt}`
        : `${act} a billing system line for ${d.customer}`;
      case 'employees': return c.action === 'insert' ? `added ${emp} to payroll` : c.action === 'delete' ? `removed ${emp} from payroll` : `changed ${emp}: ${dt}`;
      case 'time_entries': {
        const when = d.work_date ? dayLabel(d.work_date) : '';
        return c.action === 'insert' ? `added time for ${emp}: ${when} ${clockTime(d.clock_in)} – ${d.clock_out ? clockTime(d.clock_out) : 'still in'}`
          : c.action === 'delete' ? `deleted ${emp}’s time on ${when}` : `changed ${emp}’s time on ${when}: ${dt}`;
      }
      case 'payroll_periods': return c.action === 'insert' ? `marked pay period ${fmtDate(d.period_start)} – ${fmtDate(d.period_end)} as entered in Patriot`
        : `reopened pay period ${fmtDate(d.period_start)} – ${fmtDate(d.period_end)}`;
      case 'messages': return c.action === 'insert' ? `texted ${d.audience}: “${String(d.body || '').slice(0, 80)}${String(d.body || '').length > 80 ? '…' : ''}”`
        : c.diff?.canceled_at ? `canceled a text to ${d.audience}` : `changed a text to ${d.audience}`;
      case 'message_templates': return `${{ insert: 'saved', update: 'changed', delete: 'deleted' }[c.action]} the message “${d.name}” in My messages`;
      case 'message_lists': return `${{ insert: 'made', update: 'changed', delete: 'deleted' }[c.action]} the list “${d.name}”`;
      case 'money_entries': return `${act} ${d.kind === 'in' ? 'money in' : 'an expense'}: ${d.category} ${money(d.amount)}${d.party ? ` (${d.party})` : ''}, ${fmtDate(d.on_date)}`;
      case 'ccfp_claims': return `${act} the food program claim for ${fmtMonth(String(d.claim_month).slice(0, 7))}${c.action === 'update' ? `: ${dt}` : ''}`;
      case 'todos': return c.action === 'update' && c.diff?.done_at ? `${d.done_at ? 'checked off' : 'unchecked'} “${d.title}”` : `${act} the to-do “${d.title}”`;
      case 'settings': return `changed settings: ${Object.keys(c.diff || {}).map((k) => FIELD_LABEL[k] || k.replace(/_/g, ' ')).join(', ')}`;
      case 'profiles': return c.action === 'update' ? `changed ${d.full_name || d.email}’s access: ${dt}` : `${act} login ${d.email}`;
      default: return `${act} ${c.table_name.replace(/_/g, ' ')}`;
    }
  }

  async function renderChanges(el) {
    el.innerHTML = '<p class="muted">Loading…</p>';
    const seenBefore = state.me.changes_seen_at || '1970-01-01';
    const [log, emps] = await Promise.all([
      sb.from('change_log').select('*').order('at', { ascending: false }).limit(1000),
      canPayroll() ? sb.from('employees').select('id, first_name, last_name') : Promise.resolve({ data: [] }),
    ]);
    if (log.error) return fail(log.error, 'Could not load changes');
    state.changeEmps = Object.fromEntries((emps.data || []).map((e) => [e.id, empName(e)]));
    const { data: seenNow } = await sb.rpc('mark_changes_seen');
    if (seenNow) state.me.changes_seen_at = seenNow;
    state.unseen = [];
    $('header nav button[data-view=changes] .nav-badge')?.remove();
    const all = log.data;
    const f = state.changeFilters;
    const people = [...new Set(all.map((c) => c.actor).filter(Boolean))].sort((a, b) => staffName(a).localeCompare(staffName(b)));
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    el.innerHTML = `<section class="panel changes-help"><h2>Changes</h2>
        <p class="muted small">Everything staff change in the CRM, newest first, with who did it: children and contacts, tuition and payments,
          payroll and time, settings and access. New ones since you last looked are highlighted.
          You see the areas you have access to.</p></section>
      <div class="toolbar">
        <select id="cg-who" aria-label="Who">${opt('', 'Everyone', f.who)}${opt('others', 'Everyone but me', f.who)}${people.map((id) => opt(id, staffName(id) || 'Someone', f.who)).join('')}</select>
        <select id="cg-area" aria-label="Area">${opt('', 'All areas', f.area)}${Object.entries(CHANGE_AREA).map(([k, v]) => opt(k, v, f.area)).join('')}</select>
        <input type="search" id="cg-q" placeholder="Search a name or a word…" value="${esc(f.q)}">
        <span class="spacer"></span><button class="btn small" id="cg-csv" type="button">Download CSV</button></div>
      <div id="cg-list"></div>`;
    const shown = () => all.filter((c) => {
      if (f.who === 'others' ? c.actor === state.me.id : f.who && c.actor !== f.who) return false;
      if (f.area && c.area !== f.area) return false;
      if (f.q && !`${staffName(c.actor)} ${describeChange(c)}`.toLowerCase().includes(f.q.trim().toLowerCase())) return false;
      return true;
    });
    const draw = () => {
      const list = shown();
      const days = [];
      list.forEach((c) => {
        const day = localDate(new Date(c.at));
        if (!days.length || days[days.length - 1].day !== day) days.push({ day, items: [] });
        days[days.length - 1].items.push(c);
      });
      $('#cg-list', el).innerHTML = days.map((g) => `<section class="panel chg-day"><h2>${esc(g.day === todayStr() ? 'Today' : longDate(g.day))}</h2>
        <ul class="chg-list">${g.items.map((c) => `<li class="${c.actor !== state.me.id && c.at > seenBefore ? 'new' : ''}">
          <span class="chg-time">${esc(new Date(c.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</span>
          <span class="chg-what"><b>${esc(c.actor === state.me.id ? 'You' : staffName(c.actor) || 'Someone')}</b> ${esc(describeChange(c))}
            <span class="tag">${esc(CHANGE_AREA[c.area])}</span></span>
          ${c.student_id && state.students.some((x) => x.id === c.student_id) ? `<button class="btn ghost small" type="button" data-cg-kid="${c.student_id}">Open</button>` : ''}</li>`).join('')}</ul></section>`).join('')
        || '<p class="muted">No changes yet.</p>';
      $$('[data-cg-kid]', el).forEach((b) => b.addEventListener('click', () => openStudent(b.dataset.cgKid)));
    };
    [['cg-who', 'who', 'change'], ['cg-area', 'area', 'change'], ['cg-q', 'q', 'input']].forEach(([id, k, ev]) =>
      $('#' + id, el).addEventListener(ev, (e) => { f[k] = e.target.value; draw(); }));
    $('#cg-csv', el).addEventListener('click', () => csvDownload('creativa-changes.csv', ['Date', 'Time', 'Who', 'Area', 'What', 'Details'],
      shown().map((c) => [localDate(new Date(c.at)), new Date(c.at).toLocaleTimeString(), staffName(c.actor), CHANGE_AREA[c.area], describeChange(c), diffText(c, 99)])));
    draw();
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
        ${state.hasClassRates ? `<h3 class="sub-h">Tuition rates</h3>
        <p class="muted small">Full time is 7:00–3:00, with after care 7:00–5:45. A week, or a school year for Kindergarten (10 payments, no summer).
          Each child’s page has these as one-tap rates, and Money → Projection lists children whose rate is different.</p>
        <div class="table-wrap flat"><table class="class-table rate-table"><thead><tr><th>Class</th><th>Full time</th><th>+ After care</th><th>Per</th>
          <th>Registration</th><th>Book fee</th></tr></thead>
        <tbody>${state.classrooms.map((c) => `<tr data-cls="${c.id}"><td>${esc(c.name)}</td>
          ${['rate_full', 'rate_after_care'].map((k) => `<td><input data-k="${k}" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(c[k] ?? '')}" aria-label="${esc(c.name)} ${k === 'rate_full' ? 'full time' : 'with after care'}"></td>`).join('')}
          <td><select data-k="rate_per" aria-label="${esc(c.name)} rate per"><option value="week" ${c.rate_per !== 'school_year' ? 'selected' : ''}>Week</option>
            <option value="school_year" ${c.rate_per === 'school_year' ? 'selected' : ''}>School year</option></select></td>
          ${['registration_fee', 'book_fee'].map((k) => `<td><input data-k="${k}" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(c[k] ?? '')}" aria-label="${esc(c.name)} ${k === 'book_fee' ? 'book fee' : 'registration'}"></td>`).join('')}
          </tr>`).join('')}</tbody></table></div>` : ''}
      </section>
      ${state.closures ? `<section class="panel settings-panel" id="cal-panel"><h2>School calendar</h2>
        <p class="muted small">Holidays and closed days. Families pay full tuition through them (no credit). Untick <b>Staff paid</b> for days teachers
          aren’t paid (one of the two weeks of winter break): Money → Projection takes them out of payroll. Changes save as you go.</p>
        <div class="table-wrap flat"><table class="cal-table"><thead><tr><th>Closed for</th><th>From</th><th>To</th><th>Staff paid</th><th></th></tr></thead>
        <tbody>${state.closures.map((c) => `<tr data-cal="${c.id}" class="${c.ends_on < todayStr() ? 'cal-past' : ''}">
          <td><input data-k="name" value="${esc(c.name)}" maxlength="80" aria-label="Closed for"></td>
          <td><input data-k="starts_on" type="date" value="${esc(c.starts_on)}" aria-label="From"></td>
          <td><input data-k="ends_on" type="date" value="${esc(c.ends_on)}" aria-label="To"></td>
          <td><input data-k="staff_paid" type="checkbox" class="check" ${c.staff_paid ? 'checked' : ''} aria-label="Staff paid"></td>
          <td><button class="btn small ghost" type="button" data-cal-del>Remove</button></td></tr>`).join('')
          || '<tr><td colspan="5" class="muted">No closed days yet.</td></tr>'}</tbody></table></div>
        <button class="btn small" id="cal-add" type="button">+ Add a closed day</button></section>` : ''}
      <section class="panel settings-panel"><h2>Receipts</h2>
        <form id="set-receipt" class="grid2">
          ${fInput('school_name', 'School name', set.school_name)}
          ${fInput('receipt_signer', 'Signed by', set.receipt_signer, 'text', 'placeholder="Name, Administrator"')}
          ${state.hasV7 ? fInput('receipt_license', 'School license number', set.receipt_license, 'text', 'placeholder="C11MD1517"') : ''}
          ${'receipt_tax_id' in set ? fInput('receipt_tax_id', 'Tax ID (EIN), for receipts and annual statements', set.receipt_tax_id, 'text', 'placeholder="12-3456789" maxlength="20"') : ''}
          <label class="full">Address line at the bottom (address · phone · email)<textarea name="receipt_header" rows="2">${esc(set.receipt_header)}</textarea></label>
          <div class="full"><button class="btn small primary" type="submit">Save receipt details</button></div>
        </form>
        ${state.hasV7 ? `<div class="sig-box" id="sig-box"><h3 class="sub-h">Signature printed on receipts</h3>
          <div class="sig-preview">${state.signature ? `<img src="${esc(state.signature)}" alt="Signature on receipts">` : '<span class="muted small">No signature yet: receipts have a blank line to sign by hand.</span>'}</div>
          <p class="muted small">Sign on white paper with a dark pen and take a photo, or use a scan. The CRM crops it and removes the paper.
            Only finance staff see it (on receipts); only admins change it.</p>
          <div class="feed-row"><label class="btn small" id="sig-pick">Choose a picture…<input type="file" accept="image/png,image/jpeg" id="sig-file" hidden></label>
            ${state.signature ? '<button class="btn small danger" id="sig-del" type="button">Remove</button>' : ''}</div></div>` : ''}
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
      </section>
      ${'texts_enabled' in set ? `<section class="panel settings-panel"><h2>Automatic text messages</h2>
        <p class="muted small">Sent through Twilio by the hourly text job, between 9am and 8pm: a reminder the day before each
        tour to every family with a US phone number, and the “how was your visit?” text to families the follow-up email
        can’t reach (no email address). Same placeholders as the emails. Families who reply STOP are never texted again
        (${state.optOuts?.size || 0} so far); other replies show on the family’s timeline.</p>
        <p class="muted small">Keep each text short and end it with “Reply STOP to opt out.” Accented letters (ñ, á, ¿)
        make a text count as several messages, so it costs a little more.</p>
        <form id="set-texts" class="grid2">
          <label class="full pill-check"><input type="checkbox" class="check" name="texts_enabled" ${set.texts_enabled ? 'checked' : ''}> Send automatic tour texts</label>
          <label class="full">Reminder text<textarea name="tour_reminder_text" rows="4" maxlength="600">${esc(set.tour_reminder_text)}</textarea></label>
          <label class="full">Follow-up text<textarea name="followup_text" rows="4" maxlength="600">${esc(set.followup_text)}</textarea></label>
          <div class="full"><button class="btn small primary" type="submit">Save texts</button></div>
        </form>
      </section>` : ''}
      ${state.hasV5 ? telegramPanelHtml() + spamPanelHtml() : ''}`;
  }

  const WEB_FORMS = Object.keys(SOURCE_LABEL).filter((k) => k !== 'manual');

  function telegramPanelHtml() {
    const set = state.settings || {};
    const connected = set.telegram_token_set && set.telegram_chat_id;
    const last = set.telegram_last_at ? ` Last message ${fmtDateTime(set.telegram_last_at)}.` : '';
    return `<section class="panel settings-panel" id="tg-panel"><h2>Telegram alerts</h2>
      <p class="muted small">Each new website request is sent to Telegram the moment it is saved in the CRM: only after the
        robot check, and never from blocked senders. Staff-added inquiries are not sent.</p>
      <p class="small tg-status ${connected ? 'on' : ''}">${connected ? `<b>Connected</b> to chat ${esc(set.telegram_chat_id)}.` : '<b>Not connected yet.</b>'}<span class="tg-last">${esc(last)}</span></p>
      <ol class="muted small steps">
        <li>In Telegram, open <b>@BotFather</b>, send <code>/newbot</code> and follow the steps (or use your existing Creativa bot). Copy the token it gives you.</li>
        <li>Paste the token below and press <b>Save token</b>.</li>
        <li>Send any message to your bot (or add the bot to your staff group), then press <b>Find chat</b> and pick the chat.</li>
        <li>Press <b>Send test</b>. A message should arrive in Telegram.</li>
      </ol>
      <form id="tg-token" class="feed-row">
        <input name="token" type="password" autocomplete="off" spellcheck="false" aria-label="Bot token"
          placeholder="${set.telegram_token_set ? 'Token saved. Paste a new one to replace it' : '123456789:AAH…'}">
        <button class="btn small primary" type="submit">Save token</button>
        ${set.telegram_token_set ? '<button class="btn small danger" type="button" id="tg-remove">Disconnect</button>' : ''}
      </form>
      <form id="tg-chat" class="grid2 tg-chat">
        <label>Chat ID<input name="telegram_chat_id" value="${esc(set.telegram_chat_id)}" placeholder="e.g. 555111222" autocomplete="off"></label>
        <div class="tg-find"><button class="btn small" type="button" id="tg-find" ${set.telegram_token_set ? '' : 'disabled'}>Find chat</button>
          <select id="tg-chats" hidden aria-label="Chats that messaged the bot"></select></div>
        <fieldset class="full tg-forms"><legend>Send alerts for</legend>
          ${WEB_FORMS.map((k) => `<label class="pill-check"><input type="checkbox" class="check" name="tgf_${k}" ${(set.telegram_forms || []).includes(k) ? 'checked' : ''}> ${esc(SOURCE_LABEL[k])}</label>`).join('')}
        </fieldset>
        <div class="full"><button class="btn small primary" type="submit">Save</button>
          <button class="btn small" type="button" id="tg-test" ${connected ? '' : 'disabled'}>Send test</button></div>
      </form>
    </section>`;
  }

  const BLOCK_REASON = {
    'missing-input-response': 'No robot check (a bot, or a very old page)',
    'invalid-input-response': 'Failed the robot check',
    'timeout-or-duplicate': 'Robot check expired or reused',
    'blocked-sender': 'From a blocked sender',
    'too-many-from-device': 'Too many from one device (over 5 an hour)',
  };
  const BLOCK_KIND = { email: 'Email', phone: 'Phone', ip: 'Device' };

  function spamPanelHtml() {
    return `<section class="panel settings-panel" id="spam-panel"><h2>Spam protection</h2>
      <p class="small" id="ts-status">Robot check: …</p>
      <p class="muted small">Website requests pass three checks before they reach the CRM: Cloudflare’s robot check, the
        list of blocked senders below, and a limit of 5 requests an hour from one device. To block someone, open their
        inquiry and press <b>Spam</b>: it is deleted and their email, phone and device are blocked.</p>
      <p class="muted small">These checks cover the CRM and Telegram alerts. Netlify still keeps its own copy of every form and
        emails it to you unfiltered; once Telegram alerts are on, turn those emails off in Netlify
        (<b>Site configuration → Forms → Form notifications</b>) so only checked requests reach you.</p>
      <h3 class="sub-h">Stopped in the last 30 days</h3>
      <div id="spam-stats" class="muted small">Loading…</div>
      <h3 class="sub-h">Blocked senders</h3>
      <div class="table-wrap flat"><table class="block-table"><thead><tr><th>Type</th><th>Blocked</th><th>Note</th><th>Since</th><th></th></tr></thead>
        <tbody id="block-rows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table></div>
      <form id="block-add" class="feed-row block-add">
        <select name="kind" aria-label="What to block"><option value="email">Email</option><option value="phone">Phone</option></select>
        <input name="value" placeholder="Email or phone number to block" autocomplete="off" aria-label="Email or phone">
        <input name="note" placeholder="Note (optional)" aria-label="Note">
        <button class="btn small" type="submit">Block</button>
      </form>
    </section>`;
  }

  async function bindTelegramPanel(el) {
    const panel = $('#tg-panel', el);
    if (!panel) return;
    // Redraw only this panel, keeping a chat ID or form choices that haven't been saved yet.
    const refresh = async () => {
      const { data } = await sb.from('settings').select('*').eq('id', 1).maybeSingle();
      if (data) state.settings = data;
      const f = $('#tg-chat', panel);
      const keep = { chat: f.telegram_chat_id.value, forms: WEB_FORMS.map((k) => f['tgf_' + k].checked) };
      panel.outerHTML = telegramPanelHtml();
      const g = $('#tg-chat', el);
      g.telegram_chat_id.value = keep.chat;
      WEB_FORMS.forEach((k, i) => { g['tgf_' + k].checked = keep.forms[i]; });
      bindTelegramPanel(el);
    };
    showTelegramStatus(panel);
    $('#tg-token', panel).addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = e.target.token.value.trim();
      if (!token) return toast('Paste the bot token from @BotFather first', true);
      const { error } = await sb.rpc('set_telegram_token', { p_token: token });
      if (error) return fail(error, 'Could not save the token');
      toast('Token saved. Now send your bot a message and press Find chat');
      refresh();
    });
    $('#tg-remove', panel)?.addEventListener('click', async () => {
      if (!confirm('Disconnect Telegram? Alerts stop until a token is saved again.')) return;
      const { error } = await sb.rpc('set_telegram_token', { p_token: '' });
      if (error) return fail(error, 'Could not disconnect');
      toast('Telegram disconnected');
      refresh();
    });
    $('#tg-find', panel).addEventListener('click', async () => {
      const btn = $('#tg-find', panel);
      btn.disabled = true;
      const { data, error } = await sb.rpc('telegram_recent_chats');
      btn.disabled = false;
      if (error) return fail(error, 'Could not reach Telegram');
      const pick = $('#tg-chats', panel);
      if (!data.length) return toast('No chats yet. Send your bot a message in Telegram, then press Find chat again', true);
      pick.innerHTML = '<option value="">Pick a chat…</option>' + data.map((c) => `<option value="${esc(c.chat_id)}">${esc(c.title)} (${esc(c.chat_id)})</option>`).join('');
      pick.hidden = false;
      pick.onchange = () => { if (pick.value) $('#tg-chat', panel).telegram_chat_id.value = pick.value; };
      if (data.length === 1) { pick.value = data[0].chat_id; pick.onchange(); }
    });
    $('#tg-chat', panel).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const chat = f.telegram_chat_id.value.trim();
      if (chat && !/^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/.test(chat)) return toast('A chat ID is a number like 555111222 (groups start with -100)', true);
      const patch = { telegram_chat_id: chat || null, telegram_forms: WEB_FORMS.filter((k) => f['tgf_' + k].checked) };
      const { data, error } = await sb.from('settings').update(patch).eq('id', 1).select().single();
      if (error) return fail(error, 'Could not save');
      state.settings = data;
      toast('Saved');
      refresh();
    });
    $('#tg-test', panel).addEventListener('click', async () => {
      const { data, error } = await sb.rpc('telegram_send_test');
      if (error) return fail(error, 'Could not send');
      if (data === 'ok') toast('Test message sent. Check Telegram'); else toast(`Telegram said: ${data}`, true);
      showTelegramStatus(panel);
    });
  }

  // "Last message …": alerts go out in the background, so ask the database how the last one went.
  async function showTelegramStatus(panel) {
    const set = state.settings || {};
    const line = $('.tg-last', panel);
    if (!line || !set.telegram_last_at) return;
    const { data } = await sb.rpc('telegram_status');
    const r = (Array.isArray(data) ? data[0] : data) || {};
    if (!r.last_at || !document.body.contains(line)) return;
    const what = { ok: 'delivered', sent: 'sent', sending: 'sending…', queued: 'sending…' }[r.result] || `Telegram said: ${r.result || 'no answer'}`;
    line.textContent = ` Last message ${fmtDateTime(r.last_at)}: ${what}.`;
    line.classList.toggle('warn-text', !['ok', 'sent', 'sending', 'queued'].includes(r.result));
  }

  async function bindSpamPanel(el) {
    const panel = $('#spam-panel', el);
    if (!panel) return;
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const count = (reason) => {
      let q = sb.from('intake_blocked').select('id', { count: 'exact', head: true }).gte('created_at', since);
      if (reason) q = q.eq('reason', reason);
      return q;
    };
    const [ts, total, list, ...byReason] = await Promise.all([
      sb.rpc('turnstile_configured'), count(null),
      sb.from('intake_blocklist').select('*').order('created_at', { ascending: false }),
      ...Object.keys(BLOCK_REASON).map((r) => count(r)),
    ]);
    if (!document.body.contains(panel)) return;
    $('#ts-status', panel).innerHTML = ts.error ? 'Robot check: unknown.'
      : ts.data ? '<b class="ok-text">Robot check is on.</b> Bots that skip or fail it are refused.'
        : '<b class="warn-text">Robot check is off:</b> the secret key isn’t stored yet (see the README, “Are you human” check).';
    const parts = Object.keys(BLOCK_REASON).map((r, i) => [BLOCK_REASON[r], byReason[i].count || 0]).filter(([, n]) => n);
    const other = (total.count || 0) - parts.reduce((t, [, n]) => t + n, 0);
    if (other > 0) parts.push(['Other', other]);
    $('#spam-stats', panel).innerHTML = total.error ? 'Could not load.' : total.count
      ? `<b>${total.count}</b> stopped: ${parts.map(([l, n]) => `${esc(l)} <b>${n}</b>`).join(' · ')}` : 'Nothing stopped yet.';
    const rows = list.data || [];
    $('#block-rows', panel).innerHTML = rows.map((b) => `<tr data-block="${b.id}"><td>${esc(BLOCK_KIND[b.kind])}</td>
        <td><code>${esc(b.value)}</code></td><td>${esc(b.note || '')}</td><td>${esc(fmtDate(b.created_at))}</td>
        <td><button class="btn ghost small" type="button" data-unblock="${b.id}">Unblock</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">Nobody is blocked.</td></tr>';
    $$('[data-unblock]', panel).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Unblock? They will be able to send website forms again.')) return;
      const { error } = await sb.from('intake_blocklist').delete().eq('id', b.dataset.unblock);
      if (error) return fail(error, 'Could not unblock');
      toast('Unblocked');
      bindSpamPanel(el);
    }));
    const add = $('#block-add', panel);
    add.onsubmit = async (e) => {
      e.preventDefault();
      const kind = add.kind.value, value = add.value.value.trim();
      if (kind === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return toast('Enter the email address to block', true);
      if (kind === 'phone' && digits(value).length < 10) return toast('Enter the full phone number with area code', true);
      const { error } = await sb.from('intake_blocklist').insert({ kind, value, note: add.note.value.trim() || null, created_by: state.me.id });
      if (error) return fail(error, error.code === '23505' ? 'Already blocked' : 'Could not block');
      add.value.value = '';
      add.note.value = '';
      toast('Blocked');
      bindSpamPanel(el);
    };
  }

  function bindSettingsPanels(el) {
    if (!state.hasEnrollment) return;
    $$('.class-table input, .class-table select', el).forEach((input) => input.addEventListener('change', async () => {
      const id = input.closest('tr').dataset.cls, k = input.dataset.k;
      let v = input.value.trim();
      if (k === 'name' && !v) return renderStaff(el);
      if (k === 'capacity' || k === 'sort') v = v === '' ? (k === 'sort' ? 100 : null) : Number(v);
      if (/^rate_(full|after_care)$|_fee$/.test(k)) {
        if (v !== '' && !(Number(v) >= 0)) { toast('Rates are numbers', true); return renderStaff(el); }
        v = v === '' ? null : Number(v);
      }
      const { data, error } = await sb.from('classrooms').update({ [k]: v === '' ? null : v }).eq('id', id).select().single();
      if (error) { fail(error, 'Could not save the class'); return renderStaff(el); }
      state.classrooms = state.classrooms.map((c) => (c.id === id ? data : c)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
      toast('Saved');
    }));
    const sortCal = (xs) => xs.sort((a, b) => a.starts_on.localeCompare(b.starts_on));
    $$('.cal-table input', el).forEach((input) => input.addEventListener('change', async () => {
      const id = input.closest('tr').dataset.cal, k = input.dataset.k, v = k === 'staff_paid' ? input.checked : input.value.trim();
      if (v === '') return renderStaff(el);
      const { data, error } = await sb.from('school_closures').update({ [k]: v }).eq('id', id).select().single();
      if (error) { fail(error, 'Could not save the closed day'); return renderStaff(el); }
      state.closures = sortCal(state.closures.map((c) => (c.id === id ? data : c)));
      toast('Saved');
    }));
    $$('.cal-table [data-cal-del]', el).forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('tr').dataset.cal, c = state.closures.find((x) => x.id === id);
      if (!confirm(`Remove “${c.name}” (${fmtDate(c.starts_on)}) from the calendar?`)) return;
      const { error } = await sb.from('school_closures').delete().eq('id', id);
      if (error) return fail(error, 'Could not remove it');
      state.closures = state.closures.filter((x) => x.id !== id);
      renderStaff(el);
    }));
    $('#cal-add', el)?.addEventListener('click', async () => {
      const day = todayStr();
      const { data, error } = await sb.from('school_closures').insert({ name: 'School closed', starts_on: day, ends_on: day }).select().single();
      if (error) return fail(error, 'Could not add a closed day');
      state.closures = sortCal([...state.closures, data]);
      renderStaff(el);
      toast('Added: change its name and dates');
    });
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
      if (['school_name', 'tour_reminder_subject', 'tour_reminder_body', 'followup_subject', 'followup_body', 'tour_reminder_text', 'followup_text'].some((k) => k in patch && !patch[k])) {
        return toast('Subjects, emails, texts and the school name can’t be empty', true);
      }
      const { data, error } = await sb.from('settings').update(patch).eq('id', 1).select().single();
      if (error) return fail(error, 'Could not save');
      state.settings = data;
      toast('Saved');
    });
    saveSettings($('#set-receipt', el), ['school_name', 'receipt_signer', 'receipt_header', ...(state.hasV7 ? ['receipt_license'] : []),
      ...('receipt_tax_id' in (state.settings || {}) ? ['receipt_tax_id'] : [])]);
    bindSignature(el);
    saveSettings($('#set-emails', el), ['emails_enabled', 'tour_reminder_subject', 'tour_reminder_body', 'followup_subject', 'followup_body']);
    if ($('#set-texts', el)) saveSettings($('#set-texts', el), ['texts_enabled', 'tour_reminder_text', 'followup_text']);
    bindTelegramPanel(el);
    bindSpamPanel(el);
  }

  // A photo or scan of a signature becomes a see-through PNG: cropped to the ink, at most 900×300
  // (sharp when printed), the paper made transparent so it prints cleanly over the signature line.
  function signatureFromFile(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg)$/.test(file.type)) return reject(new Error('Choose a PNG or JPG picture'));
      const reader = new FileReader();   // a data: URL; the page's security policy blocks blob: images
      reader.onerror = () => reject(new Error('Could not read that file'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file isn’t a picture'));
        img.onload = () => {
          const k = Math.min(1, 1600 / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
          const g = c.getContext('2d', { willReadFrequently: true });
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          g.drawImage(img, 0, 0, c.width, c.height);
          const px = g.getImageData(0, 0, c.width, c.height), d = px.data;
          let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
          for (let y = 0; y < c.height; y++) {
            for (let x = 0; x < c.width; x++) {
              const i = (y * c.width + x) * 4;
              const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
              const a = lum >= 190 ? 0 : Math.min(255, Math.round((190 - lum) * 2.4));
              d[i + 3] = a;
              if (a > 60) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
            }
          }
          if (x1 < 0) return reject(new Error('No signature found in that picture'));
          g.putImageData(px, 0, 0);
          const padPx = 6;
          x0 = Math.max(0, x0 - padPx); y0 = Math.max(0, y0 - padPx);
          x1 = Math.min(c.width - 1, x1 + padPx); y1 = Math.min(c.height - 1, y1 + padPx);
          const w = x1 - x0 + 1, h = y1 - y0 + 1, s = Math.min(1, 900 / w, 300 / h);
          const out = document.createElement('canvas');
          out.width = Math.max(1, Math.round(w * s)); out.height = Math.max(1, Math.round(h * s));
          out.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, out.width, out.height);
          resolve(out.toDataURL('image/png'));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function bindSignature(el) {
    const box = $('#sig-box', el);
    if (!box) return;
    const save = async (image, msg) => {
      const { data, error } = await sb.from('receipt_signature').update({ image }).eq('id', 1).select('image').maybeSingle();
      if (error) return fail(error, 'Could not save the signature');
      if (!data) return toast('Only admins can change the signature', true);
      state.signature = data.image || null;
      toast(msg);
      renderStaff(el);
    };
    $('#sig-file', box).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try { await save(await signatureFromFile(file), 'Signature saved: it prints on every receipt'); } catch (err) { toast(err.message, true); }
    });
    $('#sig-del', box)?.addEventListener('click', () => { if (confirm('Remove the signature from receipts?')) save(null, 'Signature removed'); });
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
      : student ? `<p class="small enroll-link">On the ${student.status === 'waitlist' ? 'waiting' : 'enrollment'} list: <a href="#" id="open-student">${esc(student.name)}</a></p>`
        : inq.stage === 'enrolled' ? `<p class="enroll-link"><button class="btn small primary" type="button" id="to-roster">Add ${esc(inq.child_name || 'child')} to the enrollment list</button></p>`
          : inq.stage === 'waitlisted' ? `<p class="enroll-link"><button class="btn small" type="button" id="to-roster">Add ${esc(inq.child_name || 'child')} to the waiting list</button></p>` : '';

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
          <label>Stage${sel('stage', (stages().includes(v.stage) ? stages() : STAGES).map((s) => [s, STAGE_LABEL[s]]), v.stage)}</label>
          <label>Assigned to${sel('assigned_to', [['', 'Unassigned'], ...state.staff.filter((s) => s.active || s.id === v.assigned_to).map((s) => [s.id, s.full_name || s.email])], v.assigned_to)}</label>
          ${inp('tour_at', 'Tour date & time', 'datetime-local')}
          ${inp('next_follow_up', 'Next follow-up', 'date')}
          <label class="full" id="lost-wrap" ${v.stage === 'lost' ? '' : 'hidden'}>Reason lost${inp('lost_reason', '').replace(/^<label>|<\/label>$/g, '')}</label>
          ${!state.hasStartOn ? '' : student ? `<p class="full small">Registration: <b>${regPaid(student) ? 'paid' : 'not paid'}</b>
            <span class="muted">(from ${esc(student.name)}’s page on Students)</span></p>`
            : `${inp('reg_paid_on', 'Registration paid on', 'date')}
              <label>Registration amount<input name="reg_amount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(v.reg_amount ?? '')}"></label>
              <p class="full muted small">Paying registration is what holds a family’s spot on the waiting list.</p>`}
          ${state.hasEnrollment ? `<label class="full pill-check"><input type="checkbox" class="check" name="auto_emails" ${v.auto_emails !== false ? 'checked' : ''}>
            Automatic tour ${'texts_enabled' in (state.settings || {}) ? 'emails &amp; texts' : 'emails'} (reminder the day before, check-in a week after)</label>
            ${inq.tour_reminder_sent_at || inq.followup_sent_at || inq.reminder_texted_at || inq.followup_texted_at || textsStopped(inq.phone) ? `<p class="full muted small">${[
              inq.tour_reminder_sent_at && 'Reminder emailed ' + fmtDateTime(inq.tour_reminder_sent_at),
              inq.reminder_texted_at && 'Reminder texted ' + fmtDateTime(inq.reminder_texted_at),
              inq.followup_sent_at && 'Follow-up emailed ' + fmtDateTime(inq.followup_sent_at),
              inq.followup_texted_at && 'Follow-up texted ' + fmtDateTime(inq.followup_texted_at),
              textsStopped(inq.phone) && 'Replied STOP: no automatic texts'].filter(Boolean).map(esc).join(' · ')}</p>` : ''}` : ''}
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
          ${state.hasStartOn ? `${inp('start_on', 'Starts on', 'date')}
            <label>Tuition<span class="inline-pair"><input name="expected_tuition" type="number" min="0" step="0.01" inputmode="decimal"
              value="${esc(v.expected_tuition ?? '')}" placeholder="${esc(usualRate(v.program))}">${sel('expected_freq',
                Object.entries(FREQ_TEXT).filter(([k]) => k !== 'school_year' || state.hasClassRates || v.expected_freq === k), v.expected_freq || 'biweekly')}</span></label>
            <div class="full rate-opts" id="inq-rates"></div>
            <p class="full muted small">With a start day and tuition, this family shows on Money → Projection from that day, and moves over when they become a student.</p>` : ''}
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
        ${id && isAdmin() && state.hasV5 && inq.source !== 'manual' ? '<button class="btn danger" id="spam" title="Delete and block this sender">Spam</button>' : ''}
        <span class="spacer"></span>
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" id="save">${id ? 'Save' : 'Add inquiry'}</button>
      </div>`;
    document.body.append(scrim, drawer);
    document.body.style.overflow = 'hidden';

    const form = $('#inq-form', drawer);
    let dirty = Object.keys(preset).length > 0;
    form.addEventListener('input', () => { dirty = true; });
    form.stage.addEventListener('change', () => {
      $('#lost-wrap', drawer).hidden = form.stage.value !== 'lost';
      // Back from Reschedule needs a new time, same as moving the card on the Pipeline.
      if (inq.stage === 'reschedule' && form.stage.value === 'tour_scheduled') { form.tour_at.value = ''; form.tour_at.focus(); }
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    // The class's rates (020), one tap to use one: the program typed in is a class's name.
    const inqRates = $('#inq-rates', drawer);
    const drawInqRates = () => {
      const cls = state.classrooms.find((c) => c.name.toLowerCase() === form.program.value.trim().toLowerCase());
      const rs = cls ? classRates(cls.id) : [];
      const cur = rs.find((r) => { const a = rateAs(r, form.expected_freq.value); return a.freq === form.expected_freq.value && a.amount === Number(form.expected_tuition.value); });
      inqRates.innerHTML = rs.length ? rateSelect('inq-rate-pick', rs, form.expected_freq.value, cur?.k || (form.expected_tuition.value ? 'other' : '')) : '';
      $('#inq-rate-pick', inqRates)?.addEventListener('change', (e) => {
        const r = rs.find((x) => x.k === e.target.value);
        if (r) {
          const a = rateAs(r, form.expected_freq.value);
          form.expected_tuition.value = a.amount;
          form.expected_freq.value = a.freq;
        } else if (e.target.value === 'other') form.expected_tuition.focus();
        dirty = true;
      });
      form.expected_tuition.placeholder = usualRate(cls?.name || form.program.value.trim());
    };
    if (inqRates) { drawInqRates(); form.program.addEventListener('input', drawInqRates); }
    const tryClose = () => { if (!dirty || confirm('Discard your changes?')) closeDrawer(); };
    $$('[data-close]', drawer).forEach((b) => b.addEventListener('click', tryClose));
    scrim.addEventListener('click', tryClose);
    drawer.addEventListener('keydown', (e) => { if (e.key === 'Escape') tryClose(); });
    $$('[data-open]', drawer).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); if (!dirty || confirm('Discard your changes?')) openDrawer(a.dataset.open); }));
    $('#save', drawer).addEventListener('click', save);
    if (id && isAdmin()) $('#del', drawer).addEventListener('click', remove);
    $('#spam', drawer)?.addEventListener('click', async () => {
      if (!confirm(`Mark ${inq.parent_name || 'this inquiry'} as spam? It is deleted, and its email, phone and device can’t send website forms again. You can unblock them on Settings.`)) return;
      const { data, error } = await sb.rpc('mark_inquiry_spam', { p_id: id });
      if (error) return fail(error, 'Could not mark as spam');
      state.inquiries = state.inquiries.filter((x) => x.id !== id);
      closeDrawer();
      renderView();
      toast(`Marked as spam · ${data} sender detail${data === 1 ? '' : 's'} blocked`);
    });
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
      [...FIELDS, ...(state.hasStartOn ? ['start_on', 'expected_tuition', 'expected_freq'] : []), ...(form.reg_paid_on ? ['reg_paid_on', 'reg_amount'] : [])].forEach((k) => {
        let val = form[k].value.trim();
        if (k === 'tour_at') val = val ? new Date(val).toISOString() : '';
        if (k === 'email') val = val.toLowerCase();
        patch[k] = val === '' ? null : val;
      });
      if (!patch.parent_name && !patch.child_name) return toast('Add the parent’s or child’s name', true);
      if (!patch.phone && !patch.email) return toast('Add a phone number or email', true);
      if (patch.stage === 'lost' && !patch.lost_reason) { form.lost_reason.focus(); return toast('Add the reason this family was lost', true); }
      if (patch.reg_amount && !patch.reg_paid_on) { form.reg_paid_on.focus(); return toast('Add the day registration was paid', true); }
      if (inq.stage === 'reschedule') {
        const changed = patch.tour_at && new Date(patch.tour_at).getTime() !== new Date(inq.tour_at || 0).getTime();
        // A new, future time typed in while still at Reschedule means the tour has been rescheduled.
        if (patch.stage === 'reschedule' && changed && new Date(patch.tour_at) > new Date()) patch.stage = 'tour_scheduled';
        if (patch.stage === 'tour_scheduled' && !changed) {
          form.tour_at.focus();
          return toast('Pick the new tour date and time', true);
        }
      }
      if (patch.stage === 'tour_scheduled' && !patch.tour_at && inq.stage !== 'tour_scheduled') {
        form.tour_at.focus();
        return toast('Pick the tour date and time', true);
      }
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
