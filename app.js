'use strict';
/* Моите финанси — интерфейс. Чист JavaScript, без библиотеки. */

// ------------------------------------------------------------------ помощни

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];
const MONTHS_SHORT = ['яну', 'фев', 'мар', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];
const ACCOUNT_TYPES = { bank: 'Банкова сметка', cash: 'В брой', credit: 'Кредитна карта', savings: 'Резерв (спестявания)', invest: 'Инвестиции', pension: 'Пенсионен фонд' };
const TYPE_LABEL = { income: 'Приход', expense: 'Разход', fixed: 'Фиксиран разход', transfer: 'Прехвърляне', loan_extra: 'Предсрочно погасяване' };
const COLORS = { income: '#15803d', fixed: '#475569', transfer: '#2563eb', loan_extra: '#9333ea' };

const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const currentMonth = () => today().slice(0, 7);
function shiftMonth(m, k) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + k, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function monthLabel(m, short = false) {
  const [y, mo] = m.split('-').map(Number);
  return short ? `${MONTHS_SHORT[mo - 1]} ${String(y).slice(2)}` : `${MONTHS[mo - 1]} ${y}`;
}
function dayLabel(d) {
  const t = today();
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (d === t) return 'Днес';
  if (d === `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`) return 'Вчера';
  return new Date(`${d}T12:00:00`).toLocaleDateString('bg-BG', { weekday: 'short', day: 'numeric', month: 'long' });
}
const shortDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('bg-BG', { day: 'numeric', month: 'short' });

const fmt = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
const money = (c) => fmt.format((c || 0) / 100);
const signed = (c) => (c > 0 ? '+' : c < 0 ? '−' : '') + fmt.format(Math.abs(c || 0) / 100);
const centsToInput = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));

/** Превръща „12,50“ / „12.5“ / „1 200“ в евроцентове без грешки от плаваща запетая. */
function parseAmount(raw, { allowZero = false, allowNegative = false } = {}) {
  let s = String(raw ?? '').trim().replace(/[\s €]/g, '').replace(',', '.');
  let sign = 1;
  if (allowNegative && /^[-−]/.test(s)) { sign = -1; s = s.slice(1); }
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const c = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(c) || (c === 0 && !allowZero)) return null;
  return sign * c;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* по избор */ } },
};

/** Всички данни са в локалната база на устройството (core.js). Копие на тялото — за да не се споделят обекти. */
function api(method, url, body) {
  return Core.request(method, url, body === undefined ? {} : JSON.parse(JSON.stringify(body)));
}

const isPhone = () => matchMedia('(pointer: coarse)').matches;

/** Запазва файл: на телефон отваря „Сподели“ (→ Запази във Файлове / iCloud), на компютър — изтегляне. */
async function saveFile(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const file = new File([blob], name, { type: mime });
  if (isPhone() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false; // потребителят затвори менюто
      // ако споделянето не сработи — падаме към изтегляне
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

async function downloadBackup() {
  const data = await api('GET', '/api/backup/json');
  const ok = await saveFile(`finance-backup-${today()}.json`, 'application/json', JSON.stringify(data, null, 1));
  if (ok) {
    await api('POST', '/api/backup/done');
    toast('Бекъпът е запазен');
    await refresh();
  }
}

async function downloadCsv(from, to) {
  const csv = await api('GET', `/api/export/csv?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`);
  const name = from ? `dvizhenia_${from}${to && to !== from ? '_' + to : ''}.csv` : `dvizhenia_vsichki_${today()}.csv`;
  await saveFile(name, 'text/csv', csv);
}

let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, error ? 4500 : 2200);
}

// ------------------------------------------------------------------ състояние и навигация

const state = {
  month: currentMonth(),
  route: 'dashboard',
  meta: null,
};

const views = { dashboard: viewDashboard, month: viewMonth, loans: viewLoans, settings: viewSettings };

function routeFromHash() {
  const h = location.hash.replace(/^#\/?/, '');
  return views[h] ? h : 'dashboard';
}

async function loadMeta() { state.meta = await api('GET', '/api/meta'); }

let renderSeq = 0;
async function render() {
  state.route = routeFromHash();
  $$('[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === state.route));
  $('#monthLabel').textContent = monthLabel(state.month);
  $('#monthPicker').classList.toggle('hidden', state.route === 'settings' || state.route === 'loans');
  const seq = ++renderSeq;
  try {
    if (!state.meta) await loadMeta();
    const html = await views[state.route]();
    if (seq !== renderSeq) return; // по-нов рендер вече тече
    $('#view').innerHTML = html;
    afterRender[state.route]?.();
  } catch (e) {
    if (seq !== renderSeq) return;
    $('#view').innerHTML = `<div class="card empty"><h2>Нещо се обърка</h2><p>${esc(e.message)}</p>
      <p class="small">Опитайте да затворите и отворите приложението отново.</p>
      <button class="btn primary" data-action="reload">Опитай пак</button></div>`;
  }
}

async function refresh() {
  await loadMeta();
  await render();
}

const afterRender = {};

// ------------------------------------------------------------------ общи елементи

const activeAccounts = (filter = () => true) => state.meta.accounts.filter((a) => !a.archived && filter(a));
const activeCategories = () => state.meta.categories.filter((c) => !c.archived);
/** Собствени пари: банкови сметки и кеш (без кредитния лимит). */
const isSpending = (a) => a.type === 'bank' || a.type === 'cash';
/** С какво може да се плаща разход: собствени пари или кредитна карта. */
const canPay = (a) => isSpending(a) || a.type === 'credit';
const debtOf = (a) => Math.max(0, -a.balance_cents);
/** Сметка, от която обичайно се захранва дадена сметка: същата банка (напр. „Revolut“ → „Revolut Резерв“), иначе първата банкова. */
function sourceFor(target) {
  const word = target.name.trim().split(/\s+/)[0].toLowerCase();
  const banks = activeAccounts((a) => a.type === 'bank' && a.id !== target.id);
  return banks.find((a) => a.name.toLowerCase().startsWith(word)) || banks[0] || activeAccounts(isSpending)[0];
}

function txView(t) {
  let title; let color; let meta = [];
  switch (t.type) {
    case 'expense':
      title = t.category_name; color = t.category_color; meta.push(t.account_name); break;
    case 'income':
      title = t.note || 'Приход'; color = COLORS.income; meta.push(t.account_type === 'cash' ? 'на ръка' : `по банка · ${t.account_name}`); break;
    case 'fixed':
      title = t.fixed_name; color = COLORS.fixed; meta.push(`за ${monthLabel(t.period)}`, t.account_name);
      if (t.loan_id) meta.push(`главница ${money(t.principal_cents)} · лихва ${money(t.interest_cents)}`);
      if (t.to_account_id) meta.push(`→ ${t.to_account_name}`);
      break;
    case 'transfer':
      title = transferTitle(t); color = COLORS.transfer; meta.push(`${t.account_name} → ${t.to_account_name}`); break;
    default:
      title = TYPE_LABEL[t.type]; color = COLORS.loan_extra; meta.push(t.loan_name, t.account_name);
  }
  if (t.note && t.type !== 'income') meta.unshift(t.note);
  const sign = t.type === 'income' ? 1 : t.type === 'transfer' ? 0 : -1;
  return { title, color, meta: meta.filter(Boolean).join(' · '), sign };
}

function transferTitle(t) {
  if (t.to_account_type === 'savings' && isSpending({ type: t.account_type })) return 'Към резерв';
  if (t.to_account_type === 'invest' && isSpending({ type: t.account_type })) return 'Инвестиция';
  if (t.to_account_type === 'pension') return 'Към пенсионен фонд';
  if (t.account_type === 'savings') return 'Теглене от резерв';
  if (t.account_type === 'invest') return 'Теглене от инвестиции';
  if (t.to_account_type === 'cash' && t.account_type === 'bank') return 'Теглене в брой';
  if (t.to_account_type === 'credit') return 'Погасяване на кредитна карта';
  if (t.to_account_type === 'bank' && t.account_type === 'bank') return `Захранване на ${t.to_account_name}`;
  return 'Прехвърляне';
}

function txRow(t, { showDate = false } = {}) {
  const v = txView(t);
  const amount = v.sign === 0 ? money(t.amount_cents) : signed(v.sign * t.amount_cents);
  return `<div class="row clickable" data-action="edit-tx" data-id="${t.id}" role="button" tabindex="0">
    <div class="avatar" style="background:${esc(v.color)}">${esc((v.title || '?').trim().charAt(0).toUpperCase())}</div>
    <div class="main"><div class="title">${esc(v.title)}</div><div class="meta">${showDate ? esc(shortDate(t.date)) + ' · ' : ''}${esc(v.meta)}</div></div>
    <div class="amount ${v.sign > 0 ? 'pos' : ''}">${amount}</div>
  </div>`;
}

function accountRow(a) {
  if (a.type === 'credit') {
    const debt = debtOf(a);
    const limit = a.credit_limit_cents || 0;
    const free = limit - debt;
    const pct = limit ? (debt / limit) * 100 : 0;
    return `<div class="row" style="flex-wrap:wrap">
      <div class="main"><div class="title">${esc(a.name)}</div>
        <div class="meta">${limit ? `свободен лимит ${money(free)} от ${money(limit)}` : 'кредитна карта'}</div></div>
      <div class="amount ${debt ? 'neg' : ''}">${debt ? 'дълг ' + money(debt) : money(a.balance_cents)}</div>
      ${limit ? `<div style="flex-basis:100%">${progress(pct, pct >= 90 ? 'over' : pct >= 70 ? 'warn' : '')}</div>` : ''}
    </div>`;
  }
  return `<div class="row"><div class="main"><div class="title">${esc(a.name)}</div><div class="meta">${ACCOUNT_TYPES[a.type]}</div></div>
    <div class="amount ${a.balance_cents < 0 ? 'neg' : ''}">${money(a.balance_cents)}</div></div>`;
}

function progress(pct, cls = '') {
  const w = Math.max(0, Math.min(100, pct));
  return `<div class="bar ${cls}"><span style="width:${w.toFixed(1)}%"></span></div>`;
}

// Кешира последно заредените движения, за да може „редактирай“ да ги отвори без нова заявка.
const txCache = new Map();
const remember = (list) => { list.forEach((t) => txCache.set(t.id, t)); return list; };

// ------------------------------------------------------------------ ТАБЛО

async function viewDashboard() {
  const o = await api('GET', `/api/overview?m=${state.month}`);
  const s = o.summary;
  const accs = o.accounts.filter((a) => !a.archived);
  const available = accs.filter(isSpending).reduce((x, a) => x + a.balance_cents, 0);
  const credit = accs.filter((a) => a.type === 'credit');
  const debt = credit.reduce((x, a) => x + debtOf(a), 0);
  const reserve = accs.filter((a) => a.type === 'savings').reduce((x, a) => x + a.balance_cents, 0);
  const goal = o.settings.reserve_goal_cents;
  const out = s.income - s.remaining;
  const usedPct = s.income > 0 ? (out / s.income) * 100 : 0;
  const isCurrent = state.month === currentMonth();

  const lastBackup = o.settings.last_backup_at ? new Date(o.settings.last_backup_at) : null;
  const backupDays = lastBackup ? Math.floor((Date.now() - lastBackup) / 86400e3) : null;
  const backupNotice = o.tx_count > 0 && (backupDays === null || backupDays >= 7) ? `
    <div class="notice" style="align-items:center">
      <span style="flex:1">${backupDays === null ? 'Още не сте запазвали бекъп.' : `Последният бекъп е отпреди ${backupDays} дни.`} Данните са само на това устройство — запазете копие в iCloud.</span>
      <button class="btn small primary" data-action="download-backup">Запази бекъп</button>
    </div>` : '';

  return `
  <div class="stack">
    ${backupNotice}
    <div class="card hero ${s.remaining < 0 ? 'negative' : ''}">
      <div class="label">${isCurrent ? 'Остава този месец' : `Остатък за ${monthLabel(state.month)}`}</div>
      <div class="big">${money(s.remaining)}</div>
      ${s.income > 0 ? progress(usedPct) : ''}
      <div class="sub" style="margin-top:10px">
        <span>Приходи ${money(s.income)}</span>
        <span>Изразходвани и разпределени ${money(out)}${s.income > 0 ? ` (${Math.round(usedPct)}%)` : ''}</span>
        ${s.pending_fixed > 0 ? `<span>След предстоящите фиксирани: <b>${money(s.remaining_after_pending)}</b></span>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-head" style="margin-bottom:6px"><h2>Общо налични пари</h2><span class="muted small">всички месеци</span></div>
      <div style="font-size:28px;font-weight:700;letter-spacing:-.01em" class="${available < 0 ? 'neg' : ''}">${money(available)}</div>
      <div class="muted small" style="margin-top:4px">${accs.filter(isSpending).map((a) => `${esc(a.name)} ${money(a.balance_cents)}`).join(' · ')}</div>
    </div>

    <div class="grid grid-2">
      ${budgetCard(o.categories, s.daily, o.settings.budget_warn_pct)}
      <div class="card">
        <div class="card-head"><h2>Сметки</h2><a class="small" href="#/settings">Управление</a></div>
        <div class="rows">${accs.map(accountRow).join('')}</div>
        <div class="row" style="border-top:2px solid var(--border);margin-top:4px">
          <div class="main"><div class="title">Налични пари</div><div class="meta">банкови сметки + кеш (без кредитния лимит)</div></div><div class="amount">${money(available)}</div>
        </div>
        ${credit.length && debt ? `<div class="row"><div class="main"><div class="title">След погасяване на картата</div><div class="meta">налични − дълг ${money(debt)}</div></div>
          <div class="amount ${available - debt < 0 ? 'neg' : ''}">${money(available - debt)}</div></div>` : ''}
        <div style="margin-top:14px">
          <div class="card-head" style="margin-bottom:8px"><h3>Резерв към цел</h3>
            ${goal > 0 ? `<span class="small"><b>${money(reserve)}</b> / ${money(goal)}</span>` : '<a class="small" href="#/settings">Задай цел</a>'}</div>
          ${goal > 0 ? progress((reserve / goal) * 100) + `<div class="muted small" style="margin-top:6px">${Math.min(100, Math.round((reserve / goal) * 100))}% · остават ${money(Math.max(0, goal - reserve))}</div>` : ''}
        </div>
      </div>
    </div>

  </div>`;
}

/** Състояние на бюджет: ok / warn (над прага, напр. 80%) / over (над 100%). */
function budgetState(spent, budget, warnPct) {
  if (!budget) return null;
  const pct = (spent / budget) * 100;
  return { pct, cls: pct > 100 ? 'over' : pct >= warnPct ? 'warn' : '' };
}

/** „Разходи и бюджет“: всяка категория — похарчено, лимит (ако има) и лента спрямо лимита. */
function budgetCard(categories, daily, warnPct) {
  const rows = categories.filter((c) => c.spent_cents > 0 || c.budget_cents);
  const withBudget = rows.filter((c) => c.budget_cents);
  const budgetTotal = withBudget.reduce((x, c) => x + c.budget_cents, 0);
  const maxSpent = Math.max(1, ...rows.filter((c) => !c.budget_cents).map((c) => c.spent_cents));

  const row = (c) => {
    const st = budgetState(c.spent_cents, c.budget_cents, warnPct);
    const pct = st ? st.pct : (c.spent_cents / maxSpent) * 100;
    const left = c.budget_cents ? c.budget_cents - c.spent_cents : null;
    return `<div class="cat-row">
      <div class="name"><span class="dot" style="background:${esc(c.color)}"></span><span>${esc(c.name)}</span></div>
      <div class="nowrap"><b>${money(c.spent_cents)}</b>${c.budget_cents ? ` <span class="muted small">/ ${money(c.budget_cents)}</span>` : ''}</div>
      ${st ? progress(pct, st.cls) : `<div class="bar"><span style="width:${pct.toFixed(1)}%;background:${esc(c.color)}"></span></div>`}
      ${st ? `<div class="small ${st.cls === 'over' ? 'neg' : st.cls === 'warn' ? 'warn' : 'muted'}" style="grid-column:1/-1">
        ${st.cls === 'over' ? `⚠︎ превишен с ${money(-left)}` : st.cls === 'warn' ? `⚠︎ ${Math.round(st.pct)}% — остават ${money(left)}` : `остават ${money(left)}`}</div>` : ''}
    </div>`;
  };

  return `<div class="card">
    <div class="card-head"><h2>Разходи и бюджет</h2><span class="muted small">${money(daily)}${budgetTotal ? ` · лимит ${money(budgetTotal)}` : ''}</span></div>
    ${rows.length ? rows.map(row).join('') : '<div class="empty">Още няма разходи за този месец.</div>'}
    ${budgetTotal ? '' : '<div class="muted small" style="margin-top:8px">Лимит за категория се задава в Настройки → Категории.</div>'}
  </div>`;
}

// ------------------------------------------------------------------ МЕСЕЦ

async function viewMonth() {
  const o = await api('GET', `/api/overview?m=${state.month}`);
  remember(o.incomes); remember(o.transfers); remember(o.expenses);
  const s = o.summary;
  const line = (label, c, cls = '', strong = false) =>
    `<div class="row"><div class="main ${strong ? 'title' : ''}">${label}</div><div class="amount ${cls}">${c}</div></div>`;

  const fixedHtml = o.fixed.length ? o.fixed.map((f) => {
    const paid = f.paid_count > 0;
    const diff = paid && f.default_cents && f.paid_cents !== f.default_cents;
    return `<div class="row">
      <div class="main"><div class="title">${esc(f.name)}</div>
        <div class="meta">${f.to_account_id ? `→ ${esc(state.meta.accounts.find((a) => a.id === f.to_account_id)?.name || '')} · ` : ''}${paid ? `платено ${esc(shortDate(f.paid_date))}${f.loan_id && f.principal_cents !== null ? ` · главница ${money(f.principal_cents)} · лихва ${money(f.interest_cents)}` : diff ? ` · обичайно ${money(f.default_cents)}` : ''}` : (f.default_cents ? `обичайно ${money(f.default_cents)}` : 'няма зададена сума')}</div></div>
      ${paid
        ? `<span class="badge ok">Платено</span><button class="btn small ghost" data-action="edit-tx" data-id="${f.tx_id}"><b>${money(f.paid_cents)}</b></button>`
        : `<button class="btn small primary" data-action="pay-fixed" data-id="${f.id}">Плати${f.default_cents ? ' ' + money(f.default_cents) : ''}</button>`}
    </div>`;
  }).join('') : '<div class="empty">Няма фиксирани разходи. Добавете в Настройки.</div>';

  // кеш за „Плати“
  fixedCache = new Map(o.fixed.map((f) => [f.id, f]));

  return `
  <div class="page-head"><h1>${esc(monthLabel(state.month).replace(/^./, (c) => c.toUpperCase()))}</h1></div>
  <div class="grid grid-2">
    <div class="stack">
      <div class="card">
        <div class="card-head"><h2>Приходи</h2><button class="btn small primary" data-action="new-income">+ Приход</button></div>
        <div class="rows">${o.incomes.length ? o.incomes.map((t) => txRow(t, { showDate: true })).join('') : '<div class="empty">Още няма приходи за месеца.</div>'}</div>
        <div class="row" style="border-top:2px solid var(--border)"><div class="main muted small">по банка ${money(s.income_bank)} · на ръка ${money(s.income_cash)}</div><div class="amount pos">${money(s.income)}</div></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Фиксирани разходи</h2><a class="small" href="#/settings">Промени</a></div>
        <div class="rows">${fixedHtml}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Ежедневни разходи</h2><span class="muted small">${money(s.daily)}</span></div>
        ${pagedRows('expRows', o.expenses, '<div class="empty small">Още няма разходи този месец. Добавят се с бутона +.</div>')}
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <div class="card-head"><h2>Отчет за месеца</h2></div>
        <div class="rows">
          ${line('Приходи по банка', money(s.income_bank))}
          ${line('Приходи на ръка', money(s.income_cash))}
          ${line('<b>Общо приходи</b>', `<b>${money(s.income)}</b>`, 'pos')}
          ${line('Фиксирани разходи', '−' + money(s.fixed))}
          ${line('Ежедневни разходи', '−' + money(s.daily))}
          ${line('Към резерв', (s.reserve < 0 ? '+' : '−') + money(Math.abs(s.reserve)))}
          ${line('Инвестиции (S&P 500)', (s.invest < 0 ? '+' : '−') + money(Math.abs(s.invest)))}
          ${s.pension ? line('Пенсионен фонд', (s.pension < 0 ? '+' : '−') + money(Math.abs(s.pension))) : ''}
          ${s.loan_extra ? line('Предсрочно погасяване', '−' + money(s.loan_extra)) : ''}
          ${s.card_old_debt ? line('Погасяване на стар дълг по карта', '−' + money(s.card_old_debt)) : ''}
          <div class="row" style="border-top:2px solid var(--text)"><div class="main title">Остава</div><div class="amount ${s.remaining < 0 ? 'neg' : 'pos'}" style="font-size:18px">${money(s.remaining)}</div></div>
          ${s.pending_fixed ? line('<span class="muted">След предстоящите фиксирани</span>', `<span class="muted">${money(s.remaining_after_pending)}</span>`) : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Разпределение</h2></div>
        <div class="chips" style="margin-bottom:12px">
          <button class="btn small" data-action="alloc" data-kind="savings">→ Към резерв</button>
          <button class="btn small" data-action="alloc" data-kind="invest">→ Инвестиции</button>
          ${quickTransfers()}
          <button class="btn small" data-action="new-transfer">⇄ Прехвърляне</button>
        </div>
        ${pagedRows('trRows', o.transfers, '<div class="empty small">Няма разпределения и прехвърляния този месец.</div>')}
      </div>
    </div>
  </div>`;
}
let fixedCache = new Map();

/** Дълги списъци се показват по 5 реда; „По-стари“ показва следващите 5. */
const PAGE = 5;
const moreLabel = (left) => `По-стари (${left}) ▾`;
function pagedRows(id, list, empty) {
  if (!list.length) return `<div class="rows">${empty}</div>`;
  const rowsHtml = list.map((t, i) => txRow(t, { showDate: true })
    .replace('class="row clickable"', `class="row clickable${i >= PAGE ? ' hidden' : ''}"`)).join('');
  return `<div class="rows" id="${id}">${rowsHtml}</div>${list.length > PAGE
    ? `<button class="btn small" style="width:100%;margin-top:8px" data-action="more-rows" data-target="${id}">${moreLabel(list.length - PAGE)}</button>` : ''}`;
}


// ------------------------------------------------------------------ КРЕДИТИ

/** Лихва за вноската за месец m (същата формула като в core.js: остатък × лихва × дни / 360). */
function loanInterest(loan, balance, m) {
  let days = 30;
  if (loan.day_count === 'act360' && loan.payment_day) {
    const due = (mm) => {
      const [y, mo] = mm.split('-').map(Number);
      return Date.UTC(y, mo - 1, Math.min(loan.payment_day, new Date(Date.UTC(y, mo, 0)).getUTCDate()));
    };
    days = Math.round((due(m) - due(shiftMonth(m, -1))) / 86400e3);
  }
  return Math.round((balance * loan.annual_rate * days) / 36000);
}

/** „2 г. и 3 м.“ */
function duration(months) {
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y} г.` : '', m ? `${m} м.` : ''].filter(Boolean).join(' и ') || '0 м.';
}
const rateLabel = (r) => `${String(Number(r.toFixed(3))).replace('.', ',')}%`;
const loanOriginal = (l) => l.original_cents || l.opening_cents;
const loanPaidPct = (l) => (loanOriginal(l) ? ((loanOriginal(l) - l.balance_cents) / loanOriginal(l)) * 100 : 0);

function pensionCard(p) {
  const f = p.fixed;
  const paid = p.paid_this_month;
  return `<div class="card">
    <div class="card-head"><h2>${esc(p.name)}</h2><button class="btn small" data-action="pension-form" data-id="${p.id}">Редактирай</button></div>
    <div class="kpi" style="margin-bottom:10px"><div class="label">Внесено общо</div><div class="value">${money(p.balance_cents)}</div></div>
    <div class="rows">
      <div class="row"><div class="main muted">Месечна вноска</div><div class="amount">${f ? money(f.default_cents) : '—'}</div></div>
      <div class="row"><div class="main muted">${esc(monthLabel(p.month).replace(/^./, (c) => c.toUpperCase()))}</div>
        <div class="amount">${paid ? `<span class="badge ok">Платено ${esc(shortDate(paid.date))}</span>` : '<span class="badge warn">Не е платено</span>'}</div></div>
    </div>
    <div class="chips" style="margin-top:14px">
      ${paid
        ? `<button class="btn small" data-action="edit-tx" data-id="${paid.tx_id}">Промени плащането (${money(paid.cents)})</button>`
        : `<button class="btn small primary" data-action="pension-pay" data-id="${p.id}" ${f ? '' : 'disabled'}>Плати вноска</button>`}
    </div>
  </div>`;
}

let pensionCache = [];

function pensionForm(id) {
  const p = pensionCache.find((x) => x.id === id);
  const accs = state.meta.accounts.filter((a) => isSpending(a) && (!a.archived || a.id === p.fixed?.account_id));
  openFormSheet({
    title: 'Пенсионен фонд',
    fields: [
      { name: 'name', label: 'Име', value: p.name, required: true },
      { name: 'balance_cents', label: 'Внесено до момента (€)', type: 'money', value: p.balance_cents,
        hint: 'Общата сума на вноските досега. Следващите плащания се добавят автоматично.' },
      { name: 'monthly_cents', label: 'Месечна вноска (€)', type: 'money', value: p.fixed?.default_cents ?? 0 },
      { name: 'account_id', label: 'Плаща се от', type: 'select', value: p.fixed?.account_id ?? accs.find((a) => a.type === 'bank')?.id, options: accs.map((a) => [a.id, a.name]) },
    ],
    onSubmit: (b) => api('PUT', `/api/pension/${p.id}`, b).then(() => toast('Запазено')),
  });
}

async function viewLoans() {
  await loadMeta();
  pensionCache = await api('GET', '/api/pension');
  const payments = remember(await api('GET', '/api/payments'));
  const historyCard = `<div class="card">
    <div class="card-head"><h2>История на плащанията</h2><span class="muted small">${payments.length ? `общо ${money(payments.reduce((x, t) => x + t.amount_cents, 0))}` : ''}</span></div>
    ${pagedRows('payRows', payments, '<div class="empty small">Още няма плащания. Отбелязват се с „Плати вноска“ тук или в Месец.</div>')}
  </div>`;
  const loans = state.meta.loans.filter((l) => !l.archived);
  const archived = state.meta.loans.filter((l) => l.archived);
  const total = loans.reduce((x, l) => x + l.balance_cents, 0);
  const monthly = loans.filter((l) => l.balance_cents > 0).reduce((x, l) => x + l.payment_cents + l.insurance_cents, 0);
  const interestLeft = loans.reduce((x, l) => x + (l.forecast.ok ? l.forecast.interest_cents : 0), 0);
  const lastPayoff = loans.map((l) => l.forecast.payoff_month).filter(Boolean).sort().pop();

  const card = (l) => {
    const f = l.forecast;
    const done = l.balance_cents <= 0;
    return `<div class="card">
      <div class="card-head"><h2>${esc(l.name)}</h2>
        <button class="btn small" data-action="loan-form" data-id="${l.id}">Редактирай</button></div>
      <div class="kpi" style="margin-bottom:10px"><div class="label">Остатък (главница)</div>
        <div class="value">${money(l.balance_cents)}</div>
        <div class="hint">изплатени ${Math.round(loanPaidPct(l))}% от ${money(loanOriginal(l))}</div></div>
      ${progress(loanPaidPct(l))}
      <div class="rows" style="margin-top:8px">
        <div class="row"><div class="main muted">Годишна лихва</div><div class="amount">${rateLabel(l.annual_rate)}</div></div>
        <div class="row"><div class="main muted">Месечна вноска</div><div class="amount">${money(l.payment_cents)}${l.insurance_cents ? ` <span class="muted small">+ ${money(l.insurance_cents)} застр.</span>` : ''}</div></div>
        ${done ? '<div class="row"><div class="main"><span class="badge ok">Изплатен</span></div></div>' : f.ok ? `
        <div class="row"><div class="main muted">Изплащане</div><div class="amount">${esc(monthLabel(f.payoff_month))} <span class="muted small">(${duration(f.months)})</span></div></div>
        <div class="row"><div class="main muted">Остава лихва</div><div class="amount">≈ ${money(f.interest_cents)}</div></div>
        <div class="row"><div class="main"><div class="title">Остава да платиш общо</div><div class="meta">${f.months} вноски: главница + лихва${f.insurance_cents ? ' + застраховки' : ''}</div></div>
          <div class="amount">≈ ${money(l.balance_cents + f.interest_cents + f.insurance_cents)}</div></div>` : `
        <div class="notice" style="margin-top:8px">${esc(f.error)}</div>`}
        <div class="row"><div class="main muted">Платена лихва досега</div><div class="amount">${money(l.interest_paid_cents)}</div></div>
        ${l.extra_paid_cents ? `<div class="row"><div class="main muted">Предсрочно погасено</div><div class="amount">${money(l.extra_paid_cents)}</div></div>` : ''}
      </div>
      ${l.fixed_id ? '' : '<div class="notice" style="margin-top:10px">Кредитът не е свързан с фиксиран разход — натиснете „Редактирай“ и изберете вноската.</div>'}
      ${done ? '' : `<div class="chips" style="margin-top:14px">
        <button class="btn small primary" data-action="loan-pay" data-id="${l.id}" ${l.fixed_id ? '' : 'disabled'}>Плати вноска</button>
        <button class="btn small" data-action="loan-prepay" data-id="${l.id}">Предсрочно погасяване</button>
        <button class="btn small" data-action="loan-plan" data-id="${l.id}">Погасителен план</button>
      </div>`}
    </div>`;
  };

  return `
  <div class="page-head"><h1>Кредити</h1><button class="btn small primary" data-action="loan-form">+ Кредит</button></div>
  ${loans.length ? `
  <div class="stack">
    <div class="grid grid-3">
      <div class="card kpi"><div class="label">Общ остатък</div><div class="value">${money(total)}</div>
        <div class="hint">${lastPayoff ? `всички изплатени до ${esc(monthLabel(lastPayoff))}` : '&nbsp;'}</div></div>
      <div class="card kpi"><div class="label">Месечно плащане</div><div class="value">${money(monthly)}</div><div class="hint">вноски + застраховки</div></div>
      <div class="card kpi"><div class="label">Остава лихва</div><div class="value">≈ ${money(interestLeft)}</div><div class="hint">ако плащате по план</div></div>
    </div>
    <div class="grid grid-2">${loans.map(card).join('')}</div>
    ${pensionCache.length ? `<div class="grid grid-2">${pensionCache.map(pensionCard).join('')}</div>` : ''}
    ${historyCard}
    ${archived.length ? `<div class="card"><div class="card-head"><h2>Архивирани</h2></div><div class="rows">${archived.map((l) => `
      <div class="row clickable" data-action="loan-form" data-id="${l.id}" role="button" tabindex="0"><div class="main"><div class="title">${esc(l.name)}</div></div><div class="amount">${money(l.balance_cents)}</div></div>`).join('')}</div></div>` : ''}
  </div>` : `
  <div class="card empty">
    <h2 style="margin-bottom:8px">Добавете кредитите си</h2>
    <p>За всеки кредит въведете остатък, годишна лихва, месечна вноска и застраховка.<br>Приложението ще разделя всяка вноска на лихва и главница и ще показва кога ще се изплати.</p>
    <button class="btn primary" data-action="loan-form">+ Добави кредит</button>
  </div>
  ${pensionCache.length ? `<div class="grid grid-2" style="margin-top:16px">${pensionCache.map(pensionCard).join('')}</div>` : ''}
  <div style="margin-top:16px">${historyCard}</div>`}`;
}

function loanForm(id) {
  const l = id ? state.meta.loans.find((x) => x.id === id) : null;
  const linkable = state.meta.fixed.filter((f) => !f.loan_id || f.loan_id === l?.id);
  const suggested = l ? (l.fixed_id ?? '') : (linkable.find((f) => f.active && /кредит/i.test(f.name))?.id ?? 'new');
  const linkedFixed = state.meta.fixed.find((f) => f.id === (l?.fixed_id ?? suggested));
  const accs = state.meta.accounts.filter((a) => isSpending(a) && (!a.archived || a.id === linkedFixed?.account_id));
  const fields = [
    { name: 'name', label: 'Име', value: l?.name ?? `Кредит ${state.meta.loans.length + 1}`, required: true },
    { name: 'balance_cents', label: 'Текущ остатък (€)', type: 'money', value: l?.balance_cents ?? 0,
      hint: 'По последното извлечение. Ако някога се размине с банката — просто въведете вярната сума тук.' },
    { name: 'annual_rate', label: 'Годишна лихва (%)', value: l ? String(l.annual_rate).replace('.', ',') : '', hint: 'напр. 3,49' },
    { name: 'payment_cents', label: 'Месечна вноска — лихва + главница (€)', type: 'money', value: l?.payment_cents ?? 0, hint: 'Без застраховката.' },
    { name: 'insurance_cents', label: 'Месечна застраховка (€)', type: 'money', value: l?.insurance_cents ?? 0 },
    { name: 'payment_day', label: 'Ден от месеца на вноската', type: 'select', value: l?.payment_day ?? '',
      options: [['', '— не знам —'], ...Array.from({ length: 28 }, (_, i) => [i + 1, `${i + 1}-во число`])],
      hint: 'При UniCredit: 1-во, 7-мо, 14-то или 21-во. Нужно е за точната лихва.' },
    { name: 'day_count', label: 'Как се смята лихвата', type: 'select', value: l?.day_count ?? 'act360',
      options: [['act360', 'Реален брой дни / 360 (UniCredit)'], ['30360', 'Равни месеци (30/360)']] },
    { name: 'original_cents', label: 'Първоначален размер на кредита (€) — по избор', type: 'money', value: l?.original_cents ?? 0,
      hint: 'За лентата „изплатено“. Ако е празно, се брои от сегашния остатък.' },
    { name: 'fixed_link', label: 'Плаща се чрез фиксиран разход', type: 'select', value: suggested,
      options: [...linkable.map((f) => [f.id, f.name]), ['new', '+ Създай нов фиксиран разход'], ['', '— без връзка —']],
      hint: 'Бутонът „Плати“ в Месец ще разделя тази вноска на лихва, главница и застраховка.' },
    { name: 'account_id', label: 'Плаща се от', type: 'select', value: linkedFixed?.account_id ?? accs.find((a) => a.type === 'bank')?.id, options: accs.map((a) => [a.id, a.name]) },
  ];
  fields.push({ name: 'prepay_fee', label: 'Такса при предсрочно погасяване (1%, или 0,5% в последната година)', type: 'checkbox', value: l ? l.prepay_fee : 1 });
  if (l) fields.push({ name: 'archived', label: 'Архивиран (изплатен / скрит)', type: 'checkbox', value: l.archived });
  openFormSheet({
    title: l ? 'Редакция на кредит' : 'Нов кредит',
    fields,
    onSubmit: (b) => {
      b.original_cents = b.original_cents || null;
      return (l ? api('PUT', `/api/loans/${l.id}`, b) : api('POST', '/api/loans', b)).then(() => toast('Кредитът е запазен'));
    },
    onDelete: l ? async () => {
      if (!(await confirmDialog(`Да изтрия ли „${esc(l.name)}“?`, { okLabel: 'Изтрий', danger: true }))) throw new Error(CANCELLED);
      await api('DELETE', `/api/loans/${l.id}`); toast('Кредитът е изтрит');
    } : null,
  });
}

async function openLoanPlan(id) {
  const l = await api('GET', `/api/loans/${id}`);
  remember(l.payments);
  const f = l.forecast;
  openSheet(`
    <div class="sheet-head"><h2>${esc(l.name)} — погасителен план</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="Затвори">×</button></div>
    <div class="sheet-body">
      ${f.ok ? `<p class="small" style="margin-top:0">Остатък <b>${money(l.balance_cents)}</b> · изплащане <b>${esc(monthLabel(f.payoff_month))}</b> (${duration(f.months)})
        · лихва ≈ <b>${money(f.interest_cents)}</b>${l.insurance_cents ? ` · застраховки ≈ <b>${money(f.insurance_cents)}</b>` : ''}</p>
        <p class="muted small">Прогноза при плащане по план. Реалните суми зависят от банката (брой дни в месеца, промени в лихвата).</p>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Месец</th><th>Вноска</th><th>Лихва</th><th>Главница</th><th>Остатък</th></tr></thead>
          <tbody>${f.schedule.map((r) => `<tr><td>${monthLabel(r.month, true)}</td><td>${money(r.payment_cents)}</td><td>${money(r.interest_cents)}</td><td>${money(r.principal_cents)}</td><td>${money(r.balance_cents)}</td></tr>`).join('')}</tbody>
        </table></div>` : `<div class="notice">${esc(f.error || 'Кредитът е изплатен.')}</div>`}
      <h3 style="margin:18px 0 6px">Плащания (${l.payments.length})</h3>
      <div class="rows">${l.payments.map((t) => txRow(t, { showDate: true })).join('') || '<div class="empty small">Още няма записани плащания.</div>'}</div>
    </div>
    <div class="sheet-foot"><button type="button" class="btn" data-action="close-sheet">Затвори</button></div>`);
}

/** Предсрочно погасяване: показва колко месеца и лихва се спестяват, преди да се потвърди. */
function openPrepaySheet({ loanId, tx = null }) {
  const l = state.meta.loans.find((x) => x.id === loanId);
  const editing = !!tx;
  const accs = state.meta.accounts.filter((a) => (isSpending(a) && !a.archived) || a.id === tx?.account_id);
  const from = tx?.account_id ?? accs.find((a) => a.type === 'bank')?.id;
  const d = openSheet(`
  <form id="prepayForm" autocomplete="off" novalidate>
    <div class="sheet-head"><h2>${editing ? 'Редакция: предсрочно погасяване' : 'Предсрочно погасяване'}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="Затвори">×</button></div>
    <div class="sheet-body">
      <p class="muted small" style="margin-top:0">${esc(l.name)} · остатък ${money(l.balance_cents + (editing ? tx.amount_cents : 0))}. Вноската остава същата, срокът се съкращава.</p>
      <label class="field"><span>Сума</span>
        <div class="amount-wrap"><input class="input amount" name="amount" inputmode="decimal" placeholder="0,00" value="${centsToInput(tx?.amount_cents)}" autofocus></div></label>
      <div class="notice-soft small" id="sim" ${editing ? 'hidden' : ''}>Въведете сума, за да видите колко спестявате.</div>
      <div class="field" style="margin-top:14px"><span>Платено от</span>${radioChips('account_id', accs.map((a) => ({ value: a.id, label: a.name })), from)}</div>
      <div class="field-row">
        <label class="field"><span>Дата</span><input class="input" type="date" name="date" value="${esc(tx?.date ?? today())}"></label>
        <label class="field"><span>Бележка</span><input class="input" name="note" maxlength="500" placeholder="по избор" value="${esc(tx?.note ?? '')}"></label>
      </div>
      <p class="muted small" style="margin:0">${l.prepay_fee ? 'Таксата за предсрочно погасяване банката я взема отделно — запишете я като разход (категория „Други“).' : 'По този кредит няма такса за предсрочно погасяване.'}</p>
    </div>
    <div class="sheet-foot">
      ${editing ? '<button type="button" class="btn danger" data-action="delete-tx">Изтрий</button><span class="spacer"></span>' : ''}
      <button type="button" class="btn" data-action="close-sheet">Отказ</button>
      <button type="submit" class="btn primary">${editing ? 'Запази промените' : 'Погаси'}</button>
    </div>
  </form>`);
  d.dataset.txId = tx ? tx.id : '';
  const form = $('#prepayForm', d);
  form.amount.focus();

  let timer;
  form.amount.addEventListener('input', () => {
    if (editing) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const amount = parseAmount(form.amount.value);
      const sim = $('#sim', form);
      if (amount === null) { sim.textContent = 'Въведете сума, за да видите колко спестявате.'; return; }
      if (amount > l.balance_cents) { sim.innerHTML = `<span class="neg">Сумата надвишава остатъка (${money(l.balance_cents)}).</span>`; return; }
      const r = await api('GET', `/api/loans/${l.id}/simulate?extra=${amount}`);
      if (r.after.months === 0) { sim.innerHTML = '<b>Кредитът ще бъде изплатен изцяло.</b> 🎉'; return; }
      sim.innerHTML = r.months_saved === null ? esc(r.before.error || r.after.error || '')
        : `Срокът намалява с <b>${duration(r.months_saved)}</b> — изплащане <b>${esc(monthLabel(r.after.payoff_month))}</b> вместо ${esc(monthLabel(r.before.payoff_month))}.<br>
           Спестявате ≈ <b class="pos">${money(r.interest_saved_cents)}</b> лихва${r.fee_cents ? `, такса ${String(r.fee_pct).replace('.', ',')}% = ${money(r.fee_cents)}
           → <b>нетно ${money(r.interest_saved_cents - r.fee_cents)}</b>` : ''}.`;
    }, 200);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = parseAmount(form.amount.value);
    if (amount === null) return toast('Въведете валидна сума.', true);
    const account_id = Number(form.querySelector('input[name="account_id"]:checked')?.value);
    if (!account_id) return toast('Изберете от коя сметка.', true);
    const body = { type: 'loan_extra', loan_id: l.id, amount_cents: amount, account_id, date: form.date.value, note: form.note.value.trim() };
    try {
      if (editing) await api('PUT', `/api/transactions/${tx.id}`, body);
      else await api('POST', '/api/transactions', body);
      closeSheet();
      toast(editing ? 'Промените са запазени' : `Погасени ${money(amount)}`);
      await refresh();
    } catch (err) { toast(err.message, true); }
  });
}

/** Бутони „Захрани Revolut“ и „Погаси кредитна карта“ според наличните сметки. */
function quickTransfers() {
  const banks = activeAccounts((a) => a.type === 'bank');
  const out = banks.slice(1).map((a) => `<button class="btn small" data-action="fund" data-id="${a.id}">→ Захрани ${esc(a.name)}</button>`);
  activeAccounts((a) => a.type === 'credit').forEach((a) => {
    out.push(`<button class="btn small" data-action="pay-card" data-id="${a.id}">Погаси ${esc(a.name)}${debtOf(a) ? ` (${money(debtOf(a))})` : ''}</button>`);
  });
  return out.join('');
}

// ------------------------------------------------------------------ НАСТРОЙКИ

async function viewSettings() {
  await loadMeta();
  const m = state.meta;
  const backups = await api('GET', '/api/backups');
  const lastBackup = m.settings.last_backup_at ? new Date(m.settings.last_backup_at).toLocaleString('bg-BG', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  const accName = (id) => m.accounts.find((a) => a.id === id)?.name || '—';

  return `
  <div class="page-head"><h1>Настройки</h1></div>
  <div class="grid grid-2">
    <div class="stack">
      <div class="card">
        <div class="card-head"><h2>Сметки</h2><button class="btn small primary" data-action="account-form">+ Сметка</button></div>
        <p class="muted small" style="margin-top:-6px">Въведете <b>началния баланс</b> — колко пари има във всяка сметка в деня, в който започвате.</p>
        <div class="rows">${m.accounts.map((a) => `
          <div class="row clickable" data-action="account-form" data-id="${a.id}" role="button" tabindex="0">
            <div class="main"><div class="title">${esc(a.name)} ${a.archived ? '<span class="badge">архивирана</span>' : ''}</div>
              <div class="meta">${ACCOUNT_TYPES[a.type]} · ${a.type === 'credit' ? `начален дълг ${money(-a.opening_cents)}${a.credit_limit_cents ? ` · лимит ${money(a.credit_limit_cents)}` : ''}` : `начален ${money(a.opening_cents)}`}</div></div>
            <div class="amount ${a.balance_cents < 0 ? 'neg' : ''}">${a.type === 'credit' ? 'дълг ' + money(debtOf(a)) : money(a.balance_cents)}</div>
          </div>`).join('')}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Фиксирани разходи</h2><button class="btn small primary" data-action="fixed-form">+ Добави</button></div>
        <div class="rows">${m.fixed.map((f) => `
          <div class="row clickable" data-action="fixed-form" data-id="${f.id}" role="button" tabindex="0">
            <div class="main"><div class="title">${esc(f.name)} ${f.active ? '' : '<span class="badge">спрян</span>'}</div>
              <div class="meta">от ${esc(accName(f.account_id))}</div></div>
            <div class="amount">${f.default_cents ? money(f.default_cents) : '<span class="muted">—</span>'}</div>
          </div>`).join('') || '<div class="empty">Няма.</div>'}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Категории разходи</h2><button class="btn small primary" data-action="category-form">+ Категория</button></div>
        <div class="chips">${m.categories.map((c) => `
          <button class="chip" data-action="category-form" data-id="${c.id}" ${c.archived ? 'style="opacity:.5"' : ''}>
            <span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</button>`).join('')}</div>
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <div class="card-head"><h2>Цели</h2></div>
        <form id="goalForm" autocomplete="off">
          <label class="field"><span>Цел на резерва (€)</span>
            <input class="input" name="goal" inputmode="decimal" placeholder="напр. 10 000" value="${m.settings.reserve_goal_cents ? centsToInput(m.settings.reserve_goal_cents) : ''}"></label>
          <button class="btn primary" type="submit">Запази целта</button>
        </form>
      </div>

      <div class="card">
        <div class="card-head"><h2>Архив и бекъп</h2></div>
        <p class="muted small" style="margin-top:-6px">Данните се пазят <b>само на това устройство</b>. Веднъж седмично натиснете „Запази бекъп“ и изберете <b>„Запази във Файлове“ → iCloud Drive</b>. Ако смените или загубите телефона, ще възстановите всичко от този файл.</p>
        <p class="small" style="margin:0 0 12px">Последен бекъп: <b>${lastBackup ? esc(lastBackup) : 'никога'}</b></p>
        <div class="chips" style="margin-bottom:10px">
          <button class="btn primary" data-action="download-backup">⬇ Запази бекъп</button>
          <label class="btn">⬆ Възстанови / добави от файл<input type="file" accept=".json,application/json" id="restoreFile" hidden></label>
        </div>
        <details class="advanced">
          <summary>Разширени</summary>
          <div class="chips" style="margin-top:10px">
            <button class="btn small" data-action="download-csv">CSV — всички движения</button>
            <button class="btn small" data-action="download-csv" data-from="${state.month}" data-to="${state.month}">CSV — ${esc(monthLabel(state.month))}</button>
            <button class="btn small" data-action="backup-now">Направи копие сега</button>
          </div>
          <h3 style="margin:18px 0 6px">Копия в устройството</h3>
          <p class="muted small" style="margin:0 0 4px">Автоматично всеки ден (последните 14). Помагат при грешно изтриване, но не и при загубен телефон.</p>
          <div class="rows">${backups.slice(0, 12).map((b) => `
            <div class="row"><div class="main"><div class="title small">${esc(backupLabel(b.file))}</div><div class="meta">${(b.size / 1024).toFixed(0)} KB</div></div>
              <button class="btn small" data-action="restore-snapshot" data-file="${esc(b.file)}">Възстанови</button></div>`).join('') || '<div class="empty small">Все още няма копия.</div>'}</div>
        </details>
      </div>
    </div>
  </div>`;
}

function backupLabel(file) {
  const m = file.match(/^finance_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-\d{2}_(\w[\w-]*)\.db$/);
  if (!m) return file;
  const kind = { auto: 'автоматично', manual: 'ръчно', 'pre-restore': 'преди възстановяване' }[m[6]] || m[6];
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${m[4]}:${m[5]} — ${kind}`;
}

afterRender.settings = () => {
  $('#goalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = e.target.goal.value.trim();
    const c = raw === '' ? 0 : parseAmount(raw, { allowZero: true });
    if (c === null) return toast('Невалидна сума.', true);
    try { await api('PUT', '/api/settings', { reserve_goal_cents: c }); toast('Целта е запазена'); await refresh(); }
    catch (err) { toast(err.message, true); }
  });
  $('#restoreFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { return toast('Файлът не е валиден бекъп.', true); }
    if (data?.app === 'moite-finansi' && data.kind === 'loans') {
      const names = (data.loans || []).map((l) => esc(l.name)).join(', ');
      if (!(await confirmDialog(`Ще добавя кредитите: <b>${names}</b>.<br><br>Останалите ви данни няма да се променят.`, { okLabel: 'Добави', title: 'Кредити от файл' }))) return;
      try {
        const r = await api('POST', '/api/backup/restore', data);
        toast(r.added.length ? `Добавени: ${r.added.join(', ')}` : 'Кредитите вече са добавени.');
        await refresh();
        location.hash = '#/loans';
      } catch (err) { toast(err.message, true); }
      return;
    }
    const n = data?.tables?.transactions?.length ?? 0;
    const when = data?.exported_at ? new Date(data.exported_at).toLocaleString('bg-BG') : 'неизвестна дата';
    const ok = await confirmDialog(`Ще замените всички текущи данни с бекъпа от <b>${esc(when)}</b> (${n} движения).<br><br>Преди това автоматично ще се направи копие на сегашните данни.`, { okLabel: 'Възстанови', danger: true });
    if (!ok) return;
    try { await api('POST', '/api/backup/restore', data); toast('Данните са възстановени'); await refresh(); }
    catch (err) { toast(err.message, true); }
  });
};

// ------------------------------------------------------------------ диалози

const sheet = () => $('#sheet');

function openSheet(html) {
  const d = sheet();
  d.innerHTML = html;
  if (!d.open) d.showModal();
  return d;
}
function closeSheet() { if (sheet().open) sheet().close(); }

function confirmDialog(message, { okLabel = 'Потвърди', danger = false, title = 'Потвърждение' } = {}) {
  return new Promise((resolve) => {
    const d = $('#confirm');
    d.innerHTML = `<form method="dialog">
      <div class="sheet-head"><h2>${esc(title)}</h2></div>
      <div class="sheet-body"><p style="margin:0">${message}</p></div>
      <div class="sheet-foot"><button class="btn" value="no">Отказ</button><button class="btn ${danger ? 'danger solid' : 'primary'}" value="yes">${esc(okLabel)}</button></div>
    </form>`;
    d.onclose = () => resolve(d.returnValue === 'yes');
    d.returnValue = '';
    d.showModal();
  });
}

function defaultDate() {
  return state.month === currentMonth() ? today() : `${state.month}-01`;
}

function radioChips(name, items, selected) {
  return `<div class="chips">${items.map((it) => `
    <label class="chip"><input type="radio" name="${name}" value="${esc(it.value)}" ${String(it.value) === String(selected) ? 'checked' : ''}>
      ${it.color ? `<span class="dot" style="background:${esc(it.color)}"></span>` : ''}${esc(it.label)}${it.sub ? ` <span class="sub">${esc(it.sub)}</span>` : ''}</label>`).join('')}</div>`;
}

/** Диалог за добавяне/редакция на движение. */
function openTxSheet({ tx = null, type = 'expense', preset = {} } = {}) {
  const editing = !!tx;
  const lastAcc = store.get('lastAccount') || {};
  const spending = activeAccounts(isSpending);
  const v = tx ? { ...tx } : {
    type,
    date: defaultDate(),
    amount_cents: null,
    account_id: lastAcc[type] ?? (type === 'income' ? spending[0]?.id : spending[0]?.id),
    to_account_id: null,
    category_id: null,
    note: '',
    ...preset,
  };

  const includeArchived = (a) => !a.archived || a.id === v.account_id || a.id === v.to_account_id;
  const accounts = state.meta.accounts.filter(includeArchived);
  const cats = state.meta.categories.filter((c) => !c.archived || c.id === v.category_id);
  const fixedItem = v.type === 'fixed' ? state.meta.fixed.find((f) => f.id === v.fixed_id) : null;
  const loan = fixedItem?.loan_id ? state.meta.loans.find((l) => l.id === fixedItem.loan_id) : null;
  // Остатък преди това плащане (при редакция — плюс главницата на самото плащане).
  const loanBefore = loan ? loan.balance_cents + (editing && tx.loan_id === loan.id ? (tx.principal_cents || 0) : 0) : 0;
  const defInterest = loan ? (editing && tx.loan_id === loan.id ? tx.interest_cents : loanInterest(loan, loanBefore, v.period || state.month)) : 0;
  const defInsurance = loan ? (editing && tx.loan_id === loan.id ? tx.insurance_cents : loan.insurance_cents) : 0;
  const periods = Array.from({ length: 16 }, (_, i) => shiftMonth(currentMonth(), 3 - i));
  if (v.period && !periods.includes(v.period)) periods.push(v.period);

  const accOpts = (sel) => accounts.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)} (${money(a.balance_cents)})</option>`).join('');
  const title = editing ? `Редакция: ${TYPE_LABEL[v.type].toLowerCase()}` : v.type === 'fixed' ? `Плащане: ${fixedItem?.name ?? ''}` : 'Ново движение';

  const d = openSheet(`
  <form id="txForm" autocomplete="off" novalidate>
    <div class="sheet-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="Затвори">×</button></div>
    <div class="sheet-body">
      ${v.type === 'fixed' ? '' : `
      <div class="seg" role="radiogroup">
        ${['expense', 'income', 'transfer'].map((k) => `<label><input type="radio" name="type" value="${k}" ${v.type === k ? 'checked' : ''}>${TYPE_LABEL[k]}</label>`).join('')}
      </div>`}
      <label class="field"><span>Сума</span>
        <div class="amount-wrap"><input class="input amount" name="amount" inputmode="decimal" placeholder="0,00" value="${centsToInput(v.amount_cents)}" required autofocus></div>
      </label>

      ${loan ? `
      <div data-show="fixed">
        <div class="field-row">
          <label class="field"><span>Лихва</span><input class="input" name="interest" inputmode="decimal" value="${centsToInput(defInterest)}"></label>
          <label class="field"><span>Застраховка</span><input class="input" name="insurance" inputmode="decimal" value="${centsToInput(defInsurance)}"></label>
        </div>
        <div class="notice-soft small" id="splitInfo"></div>
      </div>` : ''}

      <div data-show="expense" class="field"><span>Категория</span>
        ${radioChips('category_id', cats.map((c) => ({ value: c.id, label: c.name, color: c.color })), v.category_id)}
      </div>

      <div data-show="expense fixed" class="field"><span>Платено с</span>
        ${radioChips('account_id_pay', accounts.filter((a) => canPay(a) || a.id === v.account_id).map((a) => ({ value: a.id, label: a.name, sub: a.type === 'credit' ? 'кредитна' : '' })), v.account_id)}
      </div>

      <div data-show="income" class="field"><span>Къде постъпват парите</span>
        ${radioChips('account_id_in', accounts.filter((a) => isSpending(a) || a.id === v.account_id).map((a) => ({ value: a.id, label: a.name, sub: a.type === 'cash' ? 'на ръка' : 'по банка' })), v.account_id)}
      </div>

      <div data-show="transfer" class="field-row">
        <label class="field"><span>От сметка</span><select class="input" name="from_account">${accOpts(v.account_id)}</select></label>
        <label class="field"><span>Към сметка</span><select class="input" name="to_account"><option value="">— изберете —</option>${accOpts(v.to_account_id)}</select></label>
      </div>

      <div data-show="fixed" class="field-row">
        <label class="field"><span>За месец</span><select class="input" name="period">${periods.sort().reverse().map((p) => `<option value="${p}" ${p === (v.period || state.month) ? 'selected' : ''}>${monthLabel(p)}</option>`).join('')}</select></label>
        <label class="field"><span>Дата на плащане</span><input class="input" type="date" name="date_fixed" value="${esc(v.date)}"></label>
      </div>

      <div data-show="expense income transfer" class="field-row">
        <label class="field"><span>Дата</span><input class="input" type="date" name="date" value="${esc(v.date)}" required></label>
        <label class="field"><span>Бележка</span><input class="input" name="note" maxlength="500" placeholder="${v.type === 'income' ? 'напр. Заплата' : 'по избор'}" value="${esc(v.note)}"></label>
      </div>
      <label data-show="fixed" class="field"><span>Бележка</span><input class="input" name="note_fixed" maxlength="500" placeholder="по избор" value="${esc(v.note)}"></label>
    </div>
    <div class="sheet-foot">
      ${editing ? '<button type="button" class="btn danger" data-action="delete-tx">Изтрий</button><span class="spacer"></span>' : ''}
      <button type="button" class="btn" data-action="close-sheet">Отказ</button>
      <button type="submit" class="btn primary">${editing ? 'Запази промените' : 'Запиши'}</button>
    </div>
  </form>`);

  const form = $('#txForm', d);
  const currentType = () => (v.type === 'fixed' ? 'fixed' : form.type.value);
  const syncType = () => {
    const t = currentType();
    $$('[data-show]', form).forEach((el) => el.classList.toggle('hidden', !el.dataset.show.split(' ').includes(t)));
    form.note.placeholder = t === 'income' ? 'напр. Заплата' : 'по избор';
  };
  syncType();
  form.addEventListener('change', (e) => { if (e.target.name === 'type') syncType(); });
  form.amount.focus();

  // Жива сметка: колко отива за главница и какъв ще е остатъкът.
  const splitInfo = $('#splitInfo', form);
  const updateSplit = () => {
    if (!splitInfo) return;
    const amount = parseAmount(form.amount.value);
    const interest = parseAmount(form.interest.value, { allowZero: true });
    const insurance = parseAmount(form.insurance.value, { allowZero: true });
    if (amount === null || interest === null || insurance === null) {
      splitInfo.innerHTML = `Остатък по кредита: <b>${money(loanBefore)}</b>. Лихвата е изчислена приблизително — ако се различава от извлечението, коригирайте я.`;
      return;
    }
    const principal = amount - interest - insurance;
    splitInfo.innerHTML = principal < 0
      ? '<span class="neg">Лихвата и застраховката са повече от сумата.</span>'
      : `Главница: <b>${money(principal)}</b> · остатък след плащането: <b>${money(Math.max(0, loanBefore - principal))}</b>
         <br><span class="muted">Лихвата е изчислена приблизително — ако се различава от извлечението, коригирайте я.</span>`;
  };
  form.addEventListener('input', updateSplit);
  updateSplit();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = currentType();
    const amount = parseAmount(form.amount.value);
    if (amount === null) { toast('Въведете валидна сума, напр. 12,50', true); form.amount.focus(); return; }
    const pick = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
    const body = { type: t, amount_cents: amount };
    if (t === 'expense') {
      body.category_id = Number(pick('category_id'));
      body.account_id = Number(pick('account_id_pay'));
      if (!body.category_id) return toast('Изберете категория.', true);
      if (!body.account_id) return toast('Изберете с какво е платено.', true);
    } else if (t === 'income') {
      body.account_id = Number(pick('account_id_in'));
      if (!body.account_id) return toast('Изберете къде постъпват парите.', true);
    } else if (t === 'transfer') {
      body.account_id = Number(form.from_account.value);
      body.to_account_id = Number(form.to_account.value);
      if (!body.to_account_id) return toast('Изберете към коя сметка.', true);
      if (body.account_id === body.to_account_id) return toast('Изберете две различни сметки.', true);
    } else if (t === 'fixed') {
      body.fixed_id = v.fixed_id;
      body.period = form.period.value;
      body.account_id = Number(pick('account_id_pay'));
      if (!body.account_id) return toast('Изберете с какво е платено.', true);
      if (loan) {
        body.interest_cents = parseAmount(form.interest.value, { allowZero: true });
        body.insurance_cents = parseAmount(form.insurance.value, { allowZero: true });
        if (body.interest_cents === null || body.insurance_cents === null) return toast('Невалидна лихва или застраховка.', true);
      }
    }
    body.date = t === 'fixed' ? form.date_fixed.value : form.date.value;
    body.note = (t === 'fixed' ? form.note_fixed.value : form.note.value).trim();
    if (!body.date) return toast('Изберете дата.', true);

    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (editing) await api('PUT', `/api/transactions/${tx.id}`, body);
      else await api('POST', '/api/transactions', body);
      store.set('lastAccount', { ...(store.get('lastAccount') || {}), [t]: body.account_id });
      closeSheet();
      // Ако записът е в друг месец, превключваме към него, за да се вижда.
      const m = (t === 'fixed' ? body.period : body.date.slice(0, 7));
      let msg = editing ? 'Промените са запазени' : `Записано: ${money(amount)}`;
      let warn = false;
      if (t === 'expense') {
        const o = await api('GET', `/api/overview?m=${m}`);
        const c = o.categories.find((x) => x.id === body.category_id);
        const st = c && budgetState(c.spent_cents, c.budget_cents, o.settings.budget_warn_pct);
        if (st?.cls === 'over') { msg += ` · ${c.name}: превишен лимит (${money(c.spent_cents)} / ${money(c.budget_cents)})`; warn = true; }
        else if (st?.cls === 'warn') { msg += ` · ${c.name}: ${Math.round(st.pct)}% от лимита, остават ${money(c.budget_cents - c.spent_cents)}`; warn = true; }
      }
      toast(msg, warn);
      if (!editing && m !== state.month) state.month = m;
      await refresh();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });

  d.dataset.txId = tx ? tx.id : '';
}

/** Общ диалог-форма за настройките. */
function openFormSheet({ title, fields, onSubmit, onDelete, deleteLabel = 'Изтрий', submitLabel = 'Запази' }) {
  const fieldHtml = (f) => {
    const val = f.value ?? '';
    if (f.type === 'select') {
      return `<label class="field"><span>${esc(f.label)}</span><select class="input" name="${f.name}">
        ${f.options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${f.hint ? `<small class="muted">${esc(f.hint)}</small>` : ''}</label>`;
    }
    if (f.type === 'checkbox') return `<label class="check"><input type="checkbox" name="${f.name}" ${val ? 'checked' : ''}>${esc(f.label)}</label>`;
    if (f.type === 'color') {
      return `<div class="field"><span>${esc(f.label)}</span>${radioChips(f.name, PALETTE.map((c) => ({ value: c, label: ' ', color: c })), val || PALETTE[0])}</div>`;
    }
    const money = f.type === 'money' || f.type === 'money-signed';
    return `<label class="field"><span>${esc(f.label)}</span>
      <input class="input" name="${f.name}" ${money ? 'inputmode="decimal" placeholder="0,00"' : ''} value="${esc(money ? centsToInput(val) : val)}" ${f.required ? 'required' : ''} maxlength="120">
      ${f.hint ? `<small class="muted">${esc(f.hint)}</small>` : ''}</label>`;
  };

  const d = openSheet(`
  <form id="setForm" autocomplete="off" novalidate>
    <div class="sheet-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="Затвори">×</button></div>
    <div class="sheet-body">${fields.map(fieldHtml).join('')}</div>
    <div class="sheet-foot">
      ${onDelete ? `<button type="button" class="btn danger" id="setDelete">${esc(deleteLabel)}</button><span class="spacer"></span>` : ''}
      <button type="button" class="btn" data-action="close-sheet">Отказ</button>
      <button type="submit" class="btn primary">${esc(submitLabel)}</button>
    </div>
  </form>`);
  const form = $('#setForm', d);
  setTimeout(() => form.querySelector('input:not([type=radio]):not([type=checkbox])')?.focus(), 50);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = {};
    for (const f of fields) {
      if (f.type === 'checkbox') out[f.name] = form[f.name].checked;
      else if (f.type === 'color') out[f.name] = form.querySelector(`input[name="${f.name}"]:checked`)?.value;
      else if (f.type === 'money' || f.type === 'money-signed') {
        const raw = form[f.name].value.trim();
        const c = raw === '' ? 0 : parseAmount(raw, { allowZero: true, allowNegative: f.type === 'money-signed' });
        if (c === null) { toast(`${f.label}: невалидна сума.`, true); form[f.name].focus(); return; }
        out[f.name] = c;
      } else out[f.name] = form[f.name].value.trim();
      if (f.required && (out[f.name] === '' || out[f.name] === undefined)) { toast(`${f.label} е задължително.`, true); return; }
    }
    try { await onSubmit(out); closeSheet(); await refresh(); }
    catch (err) { if (err.message !== CANCELLED) toast(err.message, true); }
  });

  if (onDelete) {
    $('#setDelete', d).addEventListener('click', async () => {
      try { await onDelete(); closeSheet(); await refresh(); }
      catch (err) { if (err.message !== CANCELLED) toast(err.message, true); }
    });
  }
}

const CANCELLED = '__cancelled__';
const PALETTE = ['#16a34a', '#ea580c', '#7c3aed', '#db2777', '#0891b2', '#64748b', '#2563eb', '#ca8a04', '#dc2626', '#0d9488', '#9333ea', '#78716c'];

function accountForm(id) {
  const a = id ? state.meta.accounts.find((x) => x.id === id) : null;
  const isCredit = a?.type === 'credit';
  const fields = [
    { name: 'name', label: 'Име', value: a?.name, required: true },
    { name: 'type', label: 'Вид', type: 'select', value: a?.type || 'bank', options: Object.entries(ACCOUNT_TYPES),
      hint: '„В брой“ се отчита като приход „на ръка“. „Резерв“ и „Инвестиции“ се отчитат като разпределение.' },
    isCredit
      ? { name: 'opening_cents', label: 'Текущ дълг по картата (€)', type: 'money', value: debtOf(a),
        hint: 'Колко дължиш в момента — не колко е свободно. Пример: лимит 500 € и свободни 75 € → дълг 425 €.' }
      : { name: 'opening_cents', label: 'Начален баланс (€)', type: 'money-signed', value: a?.opening_cents ?? 0,
        hint: 'Колко пари има в сметката, преди да започнете да въвеждате движения. За кредитна карта: колко дължите (не свободната сума).' },
    { name: 'credit_limit_cents', label: 'Кредитен лимит (€) — само за кредитна карта', type: 'money', value: a?.credit_limit_cents ?? 0 },
  ];
  if (a) fields.push({ name: 'archived', label: 'Архивирана (скрита от избора)', type: 'checkbox', value: a.archived });
  openFormSheet({
    title: a ? 'Редакция на сметка' : 'Нова сметка',
    fields,
    onSubmit: (b) => {
      if (b.type === 'credit') {
        const debt = Math.abs(b.opening_cents);
        if (b.credit_limit_cents && debt > b.credit_limit_cents) {
          throw new Error(`Дългът (${money(debt)}) е по-голям от лимита (${money(b.credit_limit_cents)}). Въведи колко дължиш, не колко е свободно.`);
        }
        // Пазим „начален“ дълг така, че текущият дълг да стане точно въведения (като корекцията при кредитите).
        const recorded = isCredit ? a.balance_cents - a.opening_cents : 0;
        b.opening_cents = -debt - recorded;
      } else {
        b.credit_limit_cents = null;
      }
      return (a ? api('PUT', `/api/accounts/${a.id}`, b) : api('POST', '/api/accounts', b)).then(() => toast('Сметката е запазена'));
    },
    onDelete: a ? async () => {
      if (!(await confirmDialog(`Да изтрия ли сметка „${esc(a.name)}“?`, { okLabel: 'Изтрий', danger: true }))) throw new Error(CANCELLED);
      await api('DELETE', `/api/accounts/${a.id}`); toast('Сметката е изтрита');
    } : null,
  });
}

function categoryForm(id) {
  const c = id ? state.meta.categories.find((x) => x.id === id) : null;
  const fields = [
    { name: 'name', label: 'Име', value: c?.name, required: true },
    { name: 'budget_cents', label: 'Месечен лимит (€)', type: 'money', value: c?.budget_cents ?? 0,
      hint: 'Празно или 0 = без лимит. Предупреждава при 80% и при превишаване.' },
    { name: 'color', label: 'Цвят', type: 'color', value: c?.color },
  ];
  if (c) fields.push({ name: 'archived', label: 'Архивирана (скрита при въвеждане)', type: 'checkbox', value: c.archived });
  openFormSheet({
    title: c ? 'Редакция на категория' : 'Нова категория',
    fields,
    onSubmit: (b) => {
      b.budget_cents = b.budget_cents || null;
      return (c ? api('PUT', `/api/categories/${c.id}`, b) : api('POST', '/api/categories', b)).then(() => toast('Категорията е запазена'));
    },
    onDelete: c ? async () => {
      if (!(await confirmDialog(`Да изтрия ли категория „${esc(c.name)}“?`, { okLabel: 'Изтрий', danger: true }))) throw new Error(CANCELLED);
      await api('DELETE', `/api/categories/${c.id}`); toast('Категорията е изтрита');
    } : null,
  });
}

function fixedForm(id) {
  const f = id ? state.meta.fixed.find((x) => x.id === id) : null;
  const accs = state.meta.accounts.filter((a) => !a.archived || a.id === f?.account_id);
  const fields = [
    { name: 'name', label: 'Име', value: f?.name, required: true },
    { name: 'default_cents', label: 'Обичайна месечна сума (€)', type: 'money', value: f?.default_cents ?? 0,
      hint: 'При плащане сумата може да се коригира (напр. за сметки, които варират).' },
    { name: 'account_id', label: 'Плаща се от', type: 'select', value: f?.account_id ?? accs.find(isSpending)?.id, options: accs.filter((a) => isSpending(a) || a.type === 'credit' || a.id === f?.account_id).map((a) => [a.id, a.name]) },
    { name: 'to_account_id', label: 'Отива към', type: 'select', value: f?.to_account_id ?? '',
      options: [['', 'Разход (парите се харчат)'], ...accs.filter((a) => ['savings', 'invest', 'pension'].includes(a.type)).map((a) => [a.id, `${a.name} (спестяване)`])],
      hint: 'За вноски към резерв, инвестиции или пенсионен фонд — броят се като спестяване, не като разход.' },
  ];
  if (f) fields.push({ name: 'active', label: 'Активен (появява се всеки месец)', type: 'checkbox', value: f.active });
  openFormSheet({
    title: f ? 'Редакция на фиксиран разход' : 'Нов фиксиран разход',
    fields,
    onSubmit: (b) => (f ? api('PUT', `/api/fixed/${f.id}`, b) : api('POST', '/api/fixed', b)).then(() => toast('Запазено')),
    onDelete: f ? async () => {
      if (!(await confirmDialog(`Да изтрия ли „${esc(f.name)}“?`, { okLabel: 'Изтрий', danger: true }))) throw new Error(CANCELLED);
      await api('DELETE', `/api/fixed/${f.id}`); toast('Изтрито');
    } : null,
  });
}

// ------------------------------------------------------------------ действия

const actions = {
  'reload': () => refresh(),
  'month-prev': () => { state.month = shiftMonth(state.month, -1); render(); },
  'month-next': () => { state.month = shiftMonth(state.month, 1); render(); },
  'month-today': () => { state.month = currentMonth(); render(); },
  'close-sheet': () => closeSheet(),
  'new-expense': () => openTxSheet({ type: 'expense' }),
  'new-income': () => openTxSheet({ type: 'income' }),
  'new-transfer': () => openTxSheet({ type: 'transfer' }),
  'alloc': (el) => {
    const target = activeAccounts((a) => a.type === el.dataset.kind)[0];
    if (!target) return toast(`Няма сметка от вид „${ACCOUNT_TYPES[el.dataset.kind]}“. Добавете в Настройки.`, true);
    openTxSheet({ type: 'transfer', preset: { account_id: sourceFor(target)?.id, to_account_id: target.id } });
  },
  'fund': (el) => {
    const target = state.meta.accounts.find((a) => a.id === Number(el.dataset.id));
    const from = activeAccounts((a) => a.type === 'bank')[0];
    openTxSheet({ type: 'transfer', preset: { account_id: from?.id, to_account_id: target.id } });
  },
  'pay-card': (el) => {
    const card = state.meta.accounts.find((a) => a.id === Number(el.dataset.id));
    const from = activeAccounts((a) => a.type === 'bank')[0];
    openTxSheet({ type: 'transfer', preset: { account_id: from?.id, to_account_id: card.id, amount_cents: debtOf(card) || null } });
  },
  'pension-form': (el) => pensionForm(Number(el.dataset.id)),
  'pension-pay': (el) => {
    const p = pensionCache.find((x) => x.id === Number(el.dataset.id));
    const f = p?.fixed;
    if (!f) return toast('Задайте месечна вноска (Редактирай).', true);
    openTxSheet({ type: 'fixed', preset: { fixed_id: f.id, amount_cents: f.default_cents || null, account_id: f.account_id, period: p.month, date: today(), note: '' } });
  },
  'more-rows': (el) => {
    const hidden = $$(`#${el.dataset.target} .row.hidden`);
    hidden.slice(0, PAGE).forEach((r) => r.classList.remove('hidden'));
    const left = hidden.length - PAGE;
    if (left > 0) el.textContent = moreLabel(left);
    else el.remove();
  },
  'loan-form': (el) => loanForm(Number(el.dataset.id) || null),
  'loan-plan': (el) => openLoanPlan(Number(el.dataset.id)).catch((err) => toast(err.message, true)),
  'loan-prepay': (el) => openPrepaySheet({ loanId: Number(el.dataset.id) }),
  'loan-pay': (el) => {
    const l = state.meta.loans.find((x) => x.id === Number(el.dataset.id));
    const f = state.meta.fixed.find((x) => x.id === l?.fixed_id);
    if (!f) return toast('Свържете кредита с фиксиран разход (Редактирай).', true);
    const period = l.paid_this_month ? shiftMonth(currentMonth(), 1) : currentMonth();
    openTxSheet({ type: 'fixed', preset: { fixed_id: f.id, amount_cents: f.default_cents || null, account_id: f.account_id, period, date: today(), note: '' } });
  },
  'pay-fixed': (el) => {
    const f = fixedCache.get(Number(el.dataset.id));
    openTxSheet({ type: 'fixed', preset: { fixed_id: f.id, amount_cents: f.default_cents || null, account_id: f.account_id, period: state.month, note: '' } });
  },
  'edit-tx': async (el) => {
    const id = Number(el.dataset.id);
    let t = txCache.get(id);
    if (!t) {
      const list = remember(await api('GET', `/api/transactions?limit=5000`));
      t = list.find((x) => x.id === id);
    }
    if (t?.type === 'loan_extra') openPrepaySheet({ loanId: t.loan_id, tx: t });
    else if (t) openTxSheet({ tx: t });
  },
  'delete-tx': async () => {
    const id = Number(sheet().dataset.txId);
    const t = txCache.get(id);
    const ok = await confirmDialog(`Да изтрия ли ${esc(TYPE_LABEL[t?.type] || 'движението').toLowerCase()} от <b>${money(t?.amount_cents)}</b>${t ? ` (${esc(shortDate(t.date))})` : ''}? Това не може да се върне.`, { okLabel: 'Изтрий', danger: true });
    if (!ok) return;
    try { await api('DELETE', `/api/transactions/${id}`); txCache.delete(id); closeSheet(); toast('Изтрито'); await refresh(); }
    catch (err) { toast(err.message, true); }
  },
  'download-backup': async () => {
    try { await downloadBackup(); } catch (err) { toast(err.message, true); }
  },
  'download-csv': async (el) => {
    try { await downloadCsv(el.dataset.from, el.dataset.to); } catch (err) { toast(err.message, true); }
  },
  'account-form': (el) => accountForm(Number(el.dataset.id) || null),
  'category-form': (el) => categoryForm(Number(el.dataset.id) || null),
  'fixed-form': (el) => fixedForm(Number(el.dataset.id) || null),
  'backup-now': async () => {
    try { await api('POST', '/api/backups'); toast('Копието е направено'); await render(); }
    catch (err) { toast(err.message, true); }
  },
  'restore-snapshot': async (el) => {
    const ok = await confirmDialog(`Да върна ли данните към копието от <b>${esc(backupLabel(el.dataset.file))}</b>?<br><br>Сегашните данни първо ще се запазят като отделно копие.`, { okLabel: 'Възстанови', danger: true });
    if (!ok) return;
    try { await api('POST', '/api/backups/restore', { file: el.dataset.file }); toast('Данните са възстановени'); await refresh(); }
    catch (err) { toast(err.message, true); }
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  if (el.tagName === 'A') e.preventDefault();
  actions[el.dataset.action](el);
});
document.addEventListener('keydown', (e) => {
  const el = e.target.closest?.('[data-action][role="button"]');
  if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); actions[el.dataset.action]?.(el); return; }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (!typing && !sheet().open && !$('#confirm').open && (e.key === 'n' || e.key === 'н') && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    openTxSheet({ type: 'expense' });
  }
});
// Затваряне на диалога при клик извън него
sheet().addEventListener('click', (e) => { if (e.target === sheet()) closeSheet(); });

window.addEventListener('hashchange', render);
render();

// Работа без интернет + автоматично обновяване при нова версия.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker:', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // първа инсталация — няма нужда от презареждане
    const reload = () => { if (!sheet().open && !$('#confirm').open) location.reload(); else setTimeout(reload, 3000); };
    reload();
  });
}
