'use strict';
/*
 * Моите финанси — ядро. Работи изцяло на устройството:
 * SQLite (sql.js / WebAssembly), записана в IndexedDB след всяка промяна.
 * Нищо не се изпраща по интернет.
 */

const Core = (() => {
  const IDB_NAME = 'moite-finansi';
  const KEEP_SNAPSHOTS = 14;
  const MAX_CENTS = 100_000_000_00;
  const TABLES = ['settings', 'accounts', 'categories', 'loans', 'fixed_items', 'transactions'];

  let SQL;
  let db;

  // ---------------------------------------------------------------- IndexedDB (постоянно хранилище)

  let idbPromise;
  function idb() {
    idbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return idbPromise;
  }
  async function idbDo(mode, fn) {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('kv', mode);
      const r = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Записът беше прекъснат.'));
    });
  }
  const kvGet = (k) => idbDo('readonly', (s) => s.get(k));
  const kvSet = (k, v) => idbDo('readwrite', (s) => s.put(v, k));
  const kvDel = (k) => idbDo('readwrite', (s) => s.delete(k));
  const kvKeys = () => idbDo('readonly', (s) => s.getAllKeys());

  // ---------------------------------------------------------------- SQLite помощни

  function rows(sql, params = []) {
    const st = db.prepare(sql);
    try {
      st.bind(params);
      const out = [];
      while (st.step()) out.push(st.getAsObject());
      return out;
    } finally {
      st.free();
    }
  }
  const all = (sql, ...p) => rows(sql, p);
  const get = (sql, ...p) => rows(sql, p)[0];
  function run(sql, ...p) {
    db.run(sql, p);
    return { lastInsertRowid: get('SELECT last_insert_rowid() AS id').id };
  }
  function inTx(fn) {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function prepareConnection() {
    db.exec('PRAGMA foreign_keys = ON;');
    // LIKE в SQLite не разбира кирилица без значение на главни/малки букви — помагаме си с JS.
    db.create_function('lower_bg', (s) => (s === null ? null : String(s).toLocaleLowerCase('bg')));
  }

  /** Записва базата в постоянното хранилище на устройството. */
  async function persist() {
    const bytes = db.export(); // export() отваря базата наново — възстановяваме настройките
    prepareConnection();
    await kvSet('db', bytes);
  }

  // ---------------------------------------------------------------- схема

  const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS accounts (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL CHECK (type IN ('bank','cash','credit','savings','invest','pension')),
    opening_cents INTEGER NOT NULL DEFAULT 0,
    credit_limit_cents INTEGER,
    sort          INTEGER NOT NULL DEFAULT 0,
    archived      INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS categories (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    color        TEXT NOT NULL DEFAULT '#64748b',
    budget_cents INTEGER,
    sort         INTEGER NOT NULL DEFAULT 0,
    archived     INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS loans (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    opening_cents   INTEGER NOT NULL DEFAULT 0,
    opening_date    TEXT,
    annual_rate     REAL NOT NULL DEFAULT 0,
    payment_cents   INTEGER NOT NULL DEFAULT 0,
    insurance_cents INTEGER NOT NULL DEFAULT 0,
    original_cents  INTEGER,
    payment_day     INTEGER,
    day_count       TEXT NOT NULL DEFAULT 'act360',
    prepay_fee      INTEGER NOT NULL DEFAULT 1,
    sort            INTEGER NOT NULL DEFAULT 0,
    archived        INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS fixed_items (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    default_cents INTEGER NOT NULL DEFAULT 0,
    account_id    INTEGER REFERENCES accounts(id),
    loan_id       INTEGER REFERENCES loans(id),
    to_account_id INTEGER REFERENCES accounts(id),
    active        INTEGER NOT NULL DEFAULT 1,
    sort          INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY,
    date            TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('income','expense','fixed','transfer','loan_extra')),
    amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
    account_id      INTEGER NOT NULL REFERENCES accounts(id),
    to_account_id   INTEGER REFERENCES accounts(id),
    category_id     INTEGER REFERENCES categories(id),
    fixed_id        INTEGER REFERENCES fixed_items(id),
    period          TEXT,
    loan_id         INTEGER REFERENCES loans(id),
    principal_cents INTEGER,
    interest_cents  INTEGER,
    insurance_cents INTEGER,
    note            TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_tx_date   ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_fixed  ON transactions(fixed_id, period);
  CREATE INDEX IF NOT EXISTS idx_tx_acc    ON transactions(account_id);
  CREATE INDEX IF NOT EXISTS idx_tx_to_acc ON transactions(to_account_id);
  `;

  function seedIfEmpty() {
    if (get('SELECT COUNT(*) n FROM accounts').n > 0) return;
    inTx(() => {
      const acc = (name, type, sort, limit = null) =>
        run('INSERT INTO accounts (name, type, sort, credit_limit_cents) VALUES (?, ?, ?, ?)', name, type, sort, limit).lastInsertRowid;
      const uni = acc('UniCredit', 'bank', 1);
      acc('Revolut', 'bank', 2);
      acc('Кеш', 'cash', 3);
      acc('Кредитна карта', 'credit', 4, 50000);
      acc('Revolut Резерв (джоб)', 'savings', 5);
      acc('Инвестиции S&P 500', 'invest', 6);
      const pension = acc('Пенсионен фонд Алианц', 'pension', 7);

      [
        ['Храна', '#16a34a'], ['Гориво', '#ea580c'], ['Хранителни добавки', '#7c3aed'],
        ['Дрехи', '#db2777'], ['Излизане', '#0891b2'], ['Други', '#64748b'],
      ].forEach(([n, c], i) => run('INSERT INTO categories (name, color, sort) VALUES (?, ?, ?)', n, c, i + 1));

      ['Наем', 'Сметки', 'Телефон', 'Вноска Кредит 1', 'Вноска Кредит 2']
        .forEach((n, i) => run('INSERT INTO fixed_items (name, default_cents, account_id, sort) VALUES (?, 0, ?, ?)', n, uni, i + 1));
      run('INSERT INTO fixed_items (name, default_cents, account_id, to_account_id, sort) VALUES (?, ?, ?, ?, ?)',
        'Пенсионен фонд Алианц', 2556, uni, pension, 6);

      run("INSERT INTO settings (key, value) VALUES ('reserve_goal_cents', '0'), ('budget_warn_pct', '80')");
    });
  }

  // ---------------------------------------------------------------- валидиране

  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const bad = (msg) => { throw new HttpError(400, msg); };

  const pad = (n) => String(n).padStart(2, '0');
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const localStamp = (d = new Date()) => `${localDate(d)}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

  function cents(v, label, { allowZero = false, allowNegative = false } = {}) {
    const n = Number(v);
    if (!Number.isInteger(n)) bad(`${label}: невалидна сума.`);
    if (!allowNegative && n < 0) bad(`${label}: сумата не може да е отрицателна.`);
    if (!allowZero && n === 0) bad(`${label}: сумата трябва да е по-голяма от 0.`);
    if (Math.abs(n) > MAX_CENTS) bad(`${label}: сумата е твърде голяма.`);
    return n;
  }
  function text(v, label, max = 120, required = true) {
    const s = (v ?? '').toString().trim();
    if (required && !s) bad(`${label} е задължително поле.`);
    return s.slice(0, max);
  }
  function rowId(v) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  function mustExist(table, id, label) {
    if (!id || !get(`SELECT id FROM ${table} WHERE id = ?`, id)) bad(`${label}: не е избрано или не съществува.`);
    return id;
  }

  // ---------------------------------------------------------------- справки

  const SPENDING = "('bank','cash')";

  function accountsWithBalance() {
    return all(`
      SELECT a.*,
        a.opening_cents
        + COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE type = 'income'   AND account_id    = a.id), 0)
        + COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE type IN ('transfer','fixed') AND to_account_id = a.id), 0)
        - COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE type <> 'income'  AND account_id    = a.id), 0)
        AS balance_cents
      FROM accounts a
      ORDER BY a.archived, a.sort, a.id`);
  }

  function settingsObj() {
    const o = {};
    for (const r of all('SELECT key, value FROM settings')) o[r.key] = r.value;
    return {
      reserve_goal_cents: Number(o.reserve_goal_cents) || 0,
      budget_warn_pct: Number(o.budget_warn_pct) || 80,
      last_backup_at: o.last_backup_at || null,
    };
  }

  function fixedStatus(m) {
    return all(`
      SELECT f.id, f.name, f.default_cents, f.account_id, f.loan_id, f.to_account_id, f.active,
             COUNT(t.id)          AS paid_count,
             SUM(t.amount_cents)  AS paid_cents,
             SUM(t.principal_cents) AS principal_cents,
             SUM(t.interest_cents)  AS interest_cents,
             SUM(t.insurance_cents) AS insurance_cents,
             MAX(t.date)          AS paid_date,
             MIN(t.id)            AS tx_id
      FROM fixed_items f
      LEFT JOIN transactions t ON t.fixed_id = f.id AND t.type = 'fixed' AND t.period = ?
      GROUP BY f.id
      HAVING f.active = 1 OR COUNT(t.id) > 0
      ORDER BY f.sort, f.id`, m);
  }

  // Месечен отчет. Фиксираните разходи се отчитат по месеца, за който са (period),
  // всичко останало — по датата на движението.
  function monthSummary(m) {
    const inc = get(`
      SELECT COALESCE(SUM(CASE WHEN a.type =  'cash' THEN t.amount_cents END), 0) AS cash,
             COALESCE(SUM(CASE WHEN a.type <> 'cash' THEN t.amount_cents END), 0) AS bank
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.type = 'income' AND substr(t.date, 1, 7) = ?`, m);
    const daily = get(`SELECT COALESCE(SUM(amount_cents), 0) s FROM transactions
                       WHERE type = 'expense' AND substr(date, 1, 7) = ?`, m).s;
    const fixed = get(`SELECT COALESCE(SUM(amount_cents), 0) s FROM transactions
                       WHERE type = 'fixed' AND to_account_id IS NULL AND period = ?`, m).s;
    const extra = get(`SELECT COALESCE(SUM(amount_cents), 0) s FROM transactions
                       WHERE type = 'loan_extra' AND substr(date, 1, 7) = ?`, m).s;
    // Разпределения: прехвърляния от собствени пари към резерв / инвестиции / пенсионен фонд (минус тегленията обратно),
    // включително фиксираните вноски-прехвърляния (отчитат се по месеца, за който са).
    const allocOf = (kind) => `COALESCE(SUM(CASE WHEN fa.type IN ${SPENDING} AND ta.type = '${kind}' THEN t.amount_cents
                          WHEN fa.type = '${kind}' AND ta.type IN ${SPENDING} THEN -t.amount_cents END), 0)`;
    const alloc = get(`
      SELECT ${allocOf('savings')} AS reserve, ${allocOf('invest')} AS invest, ${allocOf('pension')} AS pension
      FROM transactions t
      JOIN accounts fa ON fa.id = t.account_id
      JOIN accounts ta ON ta.id = t.to_account_id
      WHERE (t.type = 'transfer' AND substr(t.date, 1, 7) = ?) OR (t.type = 'fixed' AND t.period = ?)`, m, m);

    const pendingFixed = fixedStatus(m)
      .filter((f) => f.active && !f.paid_count)
      .reduce((s, f) => s + f.default_cents, 0);

    const cardOld = oldCardDebtPaid(m);
    const income = inc.bank + inc.cash;
    const outflow = fixed + daily + alloc.reserve + alloc.invest + alloc.pension + extra + cardOld;
    return {
      month: m,
      income_bank: inc.bank,
      income_cash: inc.cash,
      income,
      fixed,
      daily,
      reserve: alloc.reserve,
      invest: alloc.invest,
      pension: alloc.pension,
      card_old_debt: cardOld,
      loan_extra: extra,
      remaining: income - outflow,
      pending_fixed: pendingFixed,
      remaining_after_pending: income - outflow - pendingFixed,
    };
  }

  /**
   * Колко от плащанията към кредитни карти през месец m покриват „стария“ дълг —
   * началния, въведен при създаване на сметката (покупки отпреди приложението, никога не отчетени като разход).
   * Плащанията се разпределят хронологично: първо покриват стария дълг, после покупките, записани в приложението
   * (те вече са отчетени като разход при покупката, затова не се броят повторно).
   */
  function oldCardDebtPaid(m) {
    let total = 0;
    for (const a of all("SELECT id, opening_cents FROM accounts WHERE type = 'credit' AND opening_cents < 0")) {
      const oldDebt = -a.opening_cents;
      // Нето: плащания към картата минус пари, изтеглени от картата към собствени сметки (напр. захранване на Revolut).
      const net = (cond) => get(`SELECT COALESCE(SUM(CASE WHEN t.to_account_id = ?1 THEN t.amount_cents ELSE -t.amount_cents END), 0) s
                                  FROM transactions t
                                  JOIN accounts fa ON fa.id = t.account_id
                                  JOIN accounts ta ON ta.id = t.to_account_id
                                  WHERE t.type = 'transfer'
                                    AND ((t.to_account_id = ?1 AND fa.type IN ${SPENDING}) OR (t.account_id = ?1 AND ta.type IN ${SPENDING}))
                                    AND substr(t.date, 1, 7) ${cond} ?2`, a.id, m).s;
      const covered = (x) => Math.min(Math.max(x, 0), oldDebt);
      const before = net('<');
      total += covered(before + net('=')) - covered(before);
    }
    return total;
  }

  function categoryBreakdown(m) {
    return all(`
      SELECT c.id, c.name, c.color, c.budget_cents, c.archived,
             COALESCE(SUM(t.amount_cents), 0) AS spent_cents,
             COUNT(t.id) AS count
      FROM categories c
      LEFT JOIN transactions t ON t.category_id = c.id AND t.type = 'expense' AND substr(t.date, 1, 7) = ?
      GROUP BY c.id
      HAVING c.archived = 0 OR COUNT(t.id) > 0
      ORDER BY spent_cents DESC, c.sort, c.id`, m);
  }

  function prevMonth(m, k = 1) {
    const [y, mo] = m.split('-').map(Number);
    const d = new Date(y, mo - 1 - k, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }

  const TX_SELECT = `
    SELECT t.*, a.name AS account_name, a.type AS account_type,
           ta.name AS to_account_name, ta.type AS to_account_type,
           c.name AS category_name, c.color AS category_color,
           f.name AS fixed_name, l.name AS loan_name
    FROM transactions t
    JOIN accounts a        ON a.id = t.account_id
    LEFT JOIN accounts ta  ON ta.id = t.to_account_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN fixed_items f ON f.id = t.fixed_id
    LEFT JOIN loans l       ON l.id = t.loan_id`;

  function listTransactions(q) {
    const where = [];
    const p = [];
    if (isMonth(q.m)) {
      where.push("(CASE WHEN t.type = 'fixed' THEN t.period ELSE substr(t.date, 1, 7) END) = ?");
      p.push(q.m);
    }
    if (q.type) { where.push('t.type = ?'); p.push(q.type); }
    if (rowId(q.category)) { where.push('t.category_id = ?'); p.push(rowId(q.category)); }
    if (rowId(q.account)) { where.push('(t.account_id = ? OR t.to_account_id = ?)'); p.push(rowId(q.account), rowId(q.account)); }
    if (q.q) {
      where.push('(lower_bg(t.note) LIKE ? OR lower_bg(c.name) LIKE ? OR lower_bg(f.name) LIKE ?)');
      const like = `%${String(q.q).toLocaleLowerCase('bg')}%`;
      p.push(like, like, like);
    }
    const limit = Math.min(Number(q.limit) || 2000, 5000);
    return rows(`${TX_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY t.date DESC, t.id DESC LIMIT ${limit}`, p);
  }

  function overview(m) {
    const months = Array.from({ length: 12 }, (_, i) => prevMonth(m, 11 - i));
    return {
      month: m,
      summary: monthSummary(m),
      fixed: fixedStatus(m),
      categories: categoryBreakdown(m),
      accounts: accountsWithBalance(),
      settings: settingsObj(),
      history: months.map(monthSummary),
      incomes: all(`${TX_SELECT} WHERE t.type = 'income' AND substr(t.date, 1, 7) = ? ORDER BY t.date DESC, t.id DESC`, m),
      transfers: all(`${TX_SELECT} WHERE t.type IN ('transfer','loan_extra') AND substr(t.date, 1, 7) = ? ORDER BY t.date DESC, t.id DESC`, m),
      expenses: all(`${TX_SELECT} WHERE t.type = 'expense' AND substr(t.date, 1, 7) = ? ORDER BY t.date DESC, t.id DESC`, m),
      recent: all(`${TX_SELECT} ORDER BY t.date DESC, t.id DESC LIMIT 6`),
      tx_count: get('SELECT COUNT(*) n FROM transactions').n,
    };
  }

  function meta() {
    return {
      accounts: accountsWithBalance(),
      categories: all('SELECT * FROM categories ORDER BY archived, sort, id'),
      fixed: all('SELECT * FROM fixed_items ORDER BY active DESC, sort, id'),
      loans: loansWithStatus(),
      settings: settingsObj(),
    };
  }

  // ---------------------------------------------------------------- движения

  const eur = (c) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

  /** Остатък по кредит; excludeTxId — без дадено движение (при редакция). */
  function loanBalance(loanId, excludeTxId = null) {
    return get(`SELECT l.opening_cents - COALESCE((SELECT SUM(principal_cents) FROM transactions
                  WHERE loan_id = l.id AND id <> ?), 0) AS b FROM loans l WHERE l.id = ?`, excludeTxId || 0, loanId).b;
  }

  /** Разделя вноска на лихва, застраховка и главница. Подадените лихва/застраховка се уважават (за точност по извлечение). */
  function loanSplit(loanId, amount, b, excludeTxId) {
    const loan = get('SELECT * FROM loans WHERE id = ?', loanId);
    const balance = loanBalance(loanId, excludeTxId);
    const given = (v) => v !== undefined && v !== null && v !== '';
    const interest = given(b.interest_cents)
      ? cents(b.interest_cents, 'Лихва', { allowZero: true })
      : periodInterest(loan, balance, b.period);
    const insurance = given(b.insurance_cents)
      ? cents(b.insurance_cents, 'Застраховка', { allowZero: true })
      : loan.insurance_cents;
    const principal = amount - interest - insurance;
    if (principal < 0) bad(`Лихвата и застраховката (${eur(interest + insurance)}) са повече от платената сума.`);
    if (principal > balance) bad(`Главницата (${eur(principal)}) надвишава остатъка по кредита (${eur(balance)}).`);
    return { loan_id: loanId, principal_cents: principal, interest_cents: interest, insurance_cents: insurance };
  }

  function cleanTx(b, excludeTxId = null) {
    const type = b.type;
    if (!['income', 'expense', 'fixed', 'transfer', 'loan_extra'].includes(type)) bad('Невалиден вид движение.');
    if (!isDate(b.date)) bad('Невалидна дата.');
    const t = {
      date: b.date,
      type,
      amount_cents: cents(b.amount_cents, 'Сума'),
      account_id: mustExist('accounts', rowId(b.account_id), type === 'transfer' ? 'От сметка' : 'Сметка'),
      to_account_id: null,
      category_id: null,
      fixed_id: null,
      period: null,
      loan_id: null,
      principal_cents: null,
      interest_cents: null,
      insurance_cents: null,
      note: text(b.note, 'Бележка', 500, false),
    };
    if (type === 'expense') t.category_id = mustExist('categories', rowId(b.category_id), 'Категория');
    if (type === 'fixed') {
      t.fixed_id = mustExist('fixed_items', rowId(b.fixed_id), 'Фиксиран разход');
      if (!isMonth(b.period)) bad('Невалиден месец, за който е плащането.');
      t.period = b.period;
      const item = get('SELECT loan_id, to_account_id FROM fixed_items WHERE id = ?', t.fixed_id);
      if (item.loan_id) Object.assign(t, loanSplit(item.loan_id, t.amount_cents, b, excludeTxId));
      if (item.to_account_id) {
        t.to_account_id = item.to_account_id;
        if (t.to_account_id === t.account_id) bad('Плаща се от същата сметка, към която отиват парите.');
      }
    }
    if (type === 'transfer') {
      t.to_account_id = mustExist('accounts', rowId(b.to_account_id), 'Към сметка');
      if (t.to_account_id === t.account_id) bad('Изберете различни сметки за прехвърлянето.');
    }
    if (type === 'loan_extra') {
      t.loan_id = mustExist('loans', rowId(b.loan_id), 'Кредит');
      const balance = loanBalance(t.loan_id, excludeTxId);
      if (t.amount_cents > balance) bad(`Сумата надвишава остатъка по кредита (${eur(balance)}).`);
      t.principal_cents = t.amount_cents;
    }
    return t;
  }

  const TX_COLS = ['date', 'type', 'amount_cents', 'account_id', 'to_account_id', 'category_id', 'fixed_id', 'period',
    'loan_id', 'principal_cents', 'interest_cents', 'insurance_cents', 'note'];

  function createTx(b) {
    const t = cleanTx(b);
    const id = run(`INSERT INTO transactions (${TX_COLS.join(',')}) VALUES (${TX_COLS.map(() => '?').join(',')})`,
      ...TX_COLS.map((c) => t[c])).lastInsertRowid;
    return get(`${TX_SELECT} WHERE t.id = ?`, id);
  }

  function updateTx(id, b) {
    if (!get('SELECT id FROM transactions WHERE id = ?', id)) throw new HttpError(404, 'Движението не е намерено.');
    const t = cleanTx(b, id);
    run(`UPDATE transactions SET ${TX_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...TX_COLS.map((c) => t[c]), id);
    return get(`${TX_SELECT} WHERE t.id = ?`, id);
  }

  // ---------------------------------------------------------------- сметки, категории, фиксирани

  const ACCOUNT_TYPES = ['bank', 'cash', 'credit', 'savings', 'invest', 'pension'];

  function saveAccount(id, b) {
    const name = text(b.name, 'Име');
    if (!ACCOUNT_TYPES.includes(b.type)) bad('Невалиден вид сметка.');
    const opening = cents(b.opening_cents ?? 0, 'Начален баланс', { allowZero: true, allowNegative: true });
    const limit = b.type === 'credit' && b.credit_limit_cents ? cents(b.credit_limit_cents, 'Кредитен лимит', { allowZero: true }) : null;
    const archived = b.archived ? 1 : 0;
    if (id) {
      run('UPDATE accounts SET name = ?, type = ?, opening_cents = ?, credit_limit_cents = ?, archived = ? WHERE id = ?', name, b.type, opening, limit, archived, id);
      return id;
    }
    const sort = get('SELECT COALESCE(MAX(sort), 0) + 1 s FROM accounts').s;
    return run('INSERT INTO accounts (name, type, opening_cents, credit_limit_cents, sort) VALUES (?, ?, ?, ?, ?)', name, b.type, opening, limit, sort).lastInsertRowid;
  }

  function saveCategory(id, b) {
    const name = text(b.name, 'Име', 60);
    const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#64748b';
    const budget = b.budget_cents === null || b.budget_cents === '' || b.budget_cents === undefined
      ? null : cents(b.budget_cents, 'Бюджет', { allowZero: true });
    const archived = b.archived ? 1 : 0;
    const key = name.toLocaleLowerCase('bg');
    if (all('SELECT name FROM categories WHERE id <> ?', id || 0).some((c) => c.name.toLocaleLowerCase('bg') === key)) {
      bad(`Категория „${name}“ вече съществува.`);
    }
    if (id) {
      run('UPDATE categories SET name = ?, color = ?, budget_cents = ?, archived = ? WHERE id = ?', name, color, budget, archived, id);
      return id;
    }
    const sort = get('SELECT COALESCE(MAX(sort), 0) + 1 s FROM categories').s;
    return run('INSERT INTO categories (name, color, budget_cents, sort) VALUES (?, ?, ?, ?)', name, color, budget, sort).lastInsertRowid;
  }

  function saveFixed(id, b) {
    const name = text(b.name, 'Име');
    const amount = cents(b.default_cents ?? 0, 'Сума', { allowZero: true });
    const account = mustExist('accounts', rowId(b.account_id), 'Сметка');
    const active = b.active === undefined ? 1 : (b.active ? 1 : 0);
    let target = rowId(b.to_account_id);
    if (target) {
      const acc = get('SELECT type FROM accounts WHERE id = ?', target);
      if (!acc || !['savings', 'invest', 'pension'].includes(acc.type)) bad('„Отива към“ трябва да е резерв, инвестиции или пенсионен фонд.');
      if (target === account) bad('Плаща се от същата сметка, към която отиват парите.');
    } else target = null;
    if (id) {
      run('UPDATE fixed_items SET name = ?, default_cents = ?, account_id = ?, to_account_id = ?, active = ? WHERE id = ?', name, amount, account, target, active, id);
      return id;
    }
    const sort = get('SELECT COALESCE(MAX(sort), 0) + 1 s FROM fixed_items').s;
    return run('INSERT INTO fixed_items (name, default_cents, account_id, to_account_id, active, sort) VALUES (?, ?, ?, ?, ?, ?)', name, amount, account, target, active, sort).lastInsertRowid;
  }

  function deleteRow(table, id, usedSql, usedMsg) {
    if (get(usedSql, id, id).n > 0) throw new HttpError(409, usedMsg);
    run(`DELETE FROM ${table} WHERE id = ?`, id);
  }

  // ---------------------------------------------------------------- кредити

  const addMonths = (m, k) => prevMonth(m, -k);

  /** Дата на падежа за месец m (ден, ограничен до дължината на месеца). */
  function dueDate(m, day) {
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return Date.UTC(y, mo - 1, Math.min(day, last));
  }
  /** Дни в лихвения период, завършващ с вноската за месец m. */
  function periodDays(loan, m) {
    if (loan.day_count !== 'act360' || !loan.payment_day) return 30; // 30/360 — равни месеци
    return Math.round((dueDate(m, loan.payment_day) - dueDate(addMonths(m, -1), loan.payment_day)) / 86400e3);
  }
  /** Лихва за вноската за месец m при даден остатък: остатък × год. лихва × дни / 360. */
  const periodInterest = (loan, balance, m) => Math.round((balance * loan.annual_rate * periodDays(loan, m)) / 36000);

  /**
   * Прогноза за изплащане при анюитетна вноска: лихва = остатък × год. лихва × дни в периода / 360
   * (реален брой дни/360, както в договорите на UniCredit; или 30/360), главница = вноска − лихва.
   * Предсрочното погасяване намалява срока (вноската остава същата).
   */
  function forecast(loan, balance, startMonth, withSchedule = false) {
    const out = { months: 0, payoff_month: null, interest_cents: 0, insurance_cents: 0, ok: true, error: null };
    if (balance <= 0) return out;
    if (loan.payment_cents <= Math.round((balance * loan.annual_rate * 31) / 36000)) {
      return { ...out, ok: false, error: 'Вноската не покрива месечната лихва — кредитът няма да се изплати.' };
    }
    const schedule = [];
    let b = balance;
    while (b > 0 && out.months < 1200) {
      const interest = periodInterest(loan, b, addMonths(startMonth, out.months));
      let principal = Math.min(loan.payment_cents - interest, b);
      // Малък остатък (под ¼ вноска) банката добавя към последната вноска, вместо да прави нова.
      if (b - principal > 0 && b - principal < loan.payment_cents / 4) principal = b;
      b -= principal;
      out.months += 1;
      out.interest_cents += interest;
      out.insurance_cents += loan.insurance_cents;
      if (withSchedule) {
        schedule.push({ month: addMonths(startMonth, out.months - 1), payment_cents: principal + interest,
          interest_cents: interest, principal_cents: principal, insurance_cents: loan.insurance_cents, balance_cents: b });
      }
    }
    out.payoff_month = addMonths(startMonth, out.months - 1);
    if (withSchedule) out.schedule = schedule;
    return out;
  }

  const LOAN_SELECT = `
    SELECT l.*,
      l.opening_cents - COALESCE((SELECT SUM(principal_cents) FROM transactions WHERE loan_id = l.id), 0) AS balance_cents,
      COALESCE((SELECT SUM(interest_cents)  FROM transactions WHERE loan_id = l.id), 0) AS interest_paid_cents,
      COALESCE((SELECT SUM(insurance_cents) FROM transactions WHERE loan_id = l.id), 0) AS insurance_paid_cents,
      COALESCE((SELECT SUM(principal_cents) FROM transactions WHERE loan_id = l.id AND type = 'loan_extra'), 0) AS extra_paid_cents,
      (SELECT id FROM fixed_items WHERE loan_id = l.id ORDER BY id LIMIT 1) AS fixed_id,
      (SELECT COUNT(*) FROM transactions WHERE loan_id = l.id AND type = 'fixed' AND period = ?) AS paid_this_month
    FROM loans l`;

  /** Първият месец, за който остава вноска: този, ако още не е платен, иначе следващия. */
  const loanStart = (l, cur) => (l.paid_this_month ? addMonths(cur, 1) : cur);

  function loansWithStatus() {
    const cur = localDate().slice(0, 7);
    return all(`${LOAN_SELECT} ORDER BY l.archived, l.sort, l.id`, cur)
      .map((l) => ({ ...l, forecast: forecast(l, l.balance_cents, loanStart(l, cur)) }));
  }

  function loanDetail(id) {
    const cur = localDate().slice(0, 7);
    const l = get(`${LOAN_SELECT} WHERE l.id = ?`, cur, id);
    if (!l) throw new HttpError(404, 'Кредитът не е намерен.');
    return {
      ...l,
      forecast: forecast(l, l.balance_cents, loanStart(l, cur), true),
      payments: all(`${TX_SELECT} WHERE t.loan_id = ? ORDER BY t.date DESC, t.id DESC`, id),
    };
  }

  /** Какво се променя при предсрочно погасяване със сума extra. */
  function simulateExtra(id, extra) {
    const cur = localDate().slice(0, 7);
    const l = get(`${LOAN_SELECT} WHERE l.id = ?`, cur, id);
    if (!l) throw new HttpError(404, 'Кредитът не е намерен.');
    const amount = Math.max(0, Math.min(Number(extra) || 0, l.balance_cents));
    const before = forecast(l, l.balance_cents, loanStart(l, cur));
    const after = forecast(l, l.balance_cents - amount, loanStart(l, cur));
    const feePct = l.prepay_fee ? (before.months > 12 ? 1 : 0.5) : 0;
    const fee = Math.round((amount * feePct) / 100);
    return {
      balance_cents: l.balance_cents,
      fee_pct: feePct,
      fee_cents: fee,
      before, after,
      months_saved: before.ok && after.ok ? before.months - after.months : null,
      interest_saved_cents: before.ok && after.ok ? before.interest_cents - after.interest_cents : null,
    };
  }

  function saveLoan(id, b) {
    const name = text(b.name, 'Име', 60);
    const balance = cents(b.balance_cents ?? 0, 'Текущ остатък', { allowZero: true });
    const original = b.original_cents ? cents(b.original_cents, 'Първоначален размер', { allowZero: true }) : null;
    const rate = Number(String(b.annual_rate ?? '').replace(',', '.'));
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) bad('Годишната лихва трябва да е число между 0 и 100 (%).');
    const payment = cents(b.payment_cents, 'Месечна вноска');
    const insurance = cents(b.insurance_cents ?? 0, 'Застраховка', { allowZero: true });
    const archived = b.archived ? 1 : 0;
    if (original !== null && original > 0 && original < balance) bad('Първоначалният размер не може да е по-малък от текущия остатък.');
    const payDay = b.payment_day === '' || b.payment_day === null || b.payment_day === undefined ? null : Number(b.payment_day);
    if (payDay !== null && !(Number.isInteger(payDay) && payDay >= 1 && payDay <= 31)) bad('Денят на вноската трябва да е между 1 и 31.');
    const dayCount = b.day_count === '30360' ? '30360' : 'act360';
    const prepayFee = b.prepay_fee === undefined ? 1 : (b.prepay_fee ? 1 : 0);

    return inTx(() => {
      // Остатъкът се пази като „начален“ + всички платени главници → въведеният текущ остатък винаги е точен.
      const paid = id ? get('SELECT COALESCE(SUM(principal_cents), 0) s FROM transactions WHERE loan_id = ?', id).s : 0;
      const opening = balance + paid;
      if (id) {
        if (!get('SELECT id FROM loans WHERE id = ?', id)) throw new HttpError(404, 'Кредитът не е намерен.');
        run(`UPDATE loans SET name = ?, opening_cents = ?, original_cents = ?, annual_rate = ?, payment_cents = ?,
             insurance_cents = ?, payment_day = ?, day_count = ?, prepay_fee = ?, archived = ? WHERE id = ?`,
          name, opening, original, rate, payment, insurance, payDay, dayCount, prepayFee, archived, id);
      } else {
        const sort = get('SELECT COALESCE(MAX(sort), 0) + 1 s FROM loans').s;
        id = run(`INSERT INTO loans (name, opening_cents, opening_date, original_cents, annual_rate, payment_cents, insurance_cents,
                  payment_day, day_count, prepay_fee, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        name, opening, localDate(), original, rate, payment, insurance, payDay, dayCount, prepayFee, sort).lastInsertRowid;
      }

      // Връзка с фиксиран разход: „Плати“ в Месец записва вноската по този кредит.
      const link = b.fixed_link;
      if (link === 'new' || rowId(link)) {
        const account = mustExist('accounts', rowId(b.account_id), 'Плаща се от');
        let fixedId = rowId(link);
        if (link === 'new') {
          const sort = get('SELECT COALESCE(MAX(sort), 0) + 1 s FROM fixed_items').s;
          fixedId = run('INSERT INTO fixed_items (name, default_cents, account_id, sort) VALUES (?, 0, ?, ?)', `Вноска ${name}`, account, sort).lastInsertRowid;
        }
        const other = get('SELECT loan_id FROM fixed_items WHERE id = ?', fixedId);
        if (!other) bad('Фиксираният разход не съществува.');
        if (other.loan_id && other.loan_id !== id) bad('Този фиксиран разход вече е свързан с друг кредит.');
        run('UPDATE fixed_items SET loan_id = NULL WHERE loan_id = ? AND id <> ?', id, fixedId);
        run('UPDATE fixed_items SET loan_id = ?, default_cents = ?, account_id = ?, active = ? WHERE id = ?',
          id, payment + insurance, account, archived ? 0 : 1, fixedId);
      } else if (link === '') {
        run('UPDATE fixed_items SET loan_id = NULL WHERE loan_id = ?', id);
      }
      return id;
    });
  }

  /**
   * Добавя кредити от файл (без да пипа останалите данни). Кредит със същото име се пропуска,
   * за да не се дублира при повторно отваряне на файла. Свързва се с фиксиран разход със същото име
   * („Вноска <име>“), ако има такъв свободен; иначе създава нов.
   */
  function importLoans(list) {
    if (!Array.isArray(list) || !list.length) bad('Файлът не съдържа кредити.');
    const bank = get("SELECT id FROM accounts WHERE type = 'bank' AND archived = 0 ORDER BY sort, id LIMIT 1")
      || get("SELECT id FROM accounts WHERE type IN ('bank','cash') ORDER BY sort, id LIMIT 1");
    const added = [];
    const skipped = [];
    for (const l of list) {
      const name = text(l?.name, 'Име на кредит', 60);
      const key = name.toLocaleLowerCase('bg');
      if (all('SELECT name FROM loans').some((x) => x.name.toLocaleLowerCase('bg') === key)) { skipped.push(name); continue; }
      const fixed = all('SELECT id, name FROM fixed_items WHERE loan_id IS NULL')
        .find((f) => f.name.toLocaleLowerCase('bg') === `вноска ${key}`);
      saveLoan(null, { ...l, name, fixed_link: fixed ? fixed.id : 'new', account_id: bank?.id });
      added.push(name);
    }
    return { added, skipped };
  }

  // ---------------------------------------------------------------- пенсионен фонд

  /** Пенсионни фондове: внесено общо, месечна вноска и дали е платена за текущия месец. */
  function pensionFunds() {
    const cur = localDate().slice(0, 7);
    return accountsWithBalance().filter((a) => a.type === 'pension' && !a.archived).map((a) => {
      const fixed = get('SELECT * FROM fixed_items WHERE to_account_id = ? ORDER BY active DESC, id LIMIT 1', a.id) || null;
      const paid = fixed ? get(`SELECT COUNT(*) n, SUM(amount_cents) cents, MAX(date) date, MIN(id) tx_id FROM transactions
                                WHERE type = 'fixed' AND fixed_id = ? AND period = ?`, fixed.id, cur) : null;
      return { ...a, fixed, paid_this_month: paid && paid.n ? paid : null, month: cur };
    });
  }

  /** Редакция на фонд: „внесено до момента“ (изравнява се като остатъка при кредитите) и месечната вноска. */
  function savePension(id, b) {
    const acc = get("SELECT * FROM accounts WHERE id = ? AND type = 'pension'", id);
    if (!acc) throw new HttpError(404, 'Фондът не е намерен.');
    const name = text(b.name, 'Име', 60);
    const total = cents(b.balance_cents ?? 0, 'Внесено до момента', { allowZero: true });
    const monthly = cents(b.monthly_cents ?? 0, 'Месечна вноска', { allowZero: true });
    const from = mustExist('accounts', rowId(b.account_id), 'Плаща се от');
    return inTx(() => {
      const current = accountsWithBalance().find((a) => a.id === id);
      const recorded = current.balance_cents - current.opening_cents; // движенията, записани в приложението
      run('UPDATE accounts SET name = ?, opening_cents = ? WHERE id = ?', name, total - recorded, id);
      const fixed = get('SELECT id FROM fixed_items WHERE to_account_id = ? ORDER BY active DESC, id LIMIT 1', id);
      if (fixed) {
        run('UPDATE fixed_items SET name = ?, default_cents = ?, account_id = ?, active = 1 WHERE id = ?', name, monthly, from, fixed.id);
      } else {
        const sort = get('SELECT COALESCE(MAX(sort), 0) + 1 s FROM fixed_items').s;
        run('INSERT INTO fixed_items (name, default_cents, account_id, to_account_id, sort) VALUES (?, ?, ?, ?, ?)', name, monthly, from, id, sort);
      }
      return id;
    });
  }

  function deleteLoan(id) {
    if (get('SELECT COUNT(*) n FROM transactions WHERE loan_id = ?', id).n > 0) {
      throw new HttpError(409, 'По кредита има записани плащания. Можете да го архивирате — историята ще се запази.');
    }
    inTx(() => {
      run('UPDATE fixed_items SET loan_id = NULL WHERE loan_id = ?', id);
      run('DELETE FROM loans WHERE id = ?', id);
    });
  }

  function setSetting(key, value) {
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  function saveSettings(b) {
    if (b.reserve_goal_cents !== undefined) setSetting('reserve_goal_cents', cents(b.reserve_goal_cents, 'Цел на резерва', { allowZero: true }));
    if (b.budget_warn_pct !== undefined) {
      const p = Number(b.budget_warn_pct);
      if (!Number.isInteger(p) || p < 1 || p > 100) bad('Прагът за предупреждение трябва да е между 1 и 100%.');
      setSetting('budget_warn_pct', p);
    }
  }

  // ---------------------------------------------------------------- копия, бекъп, CSV

  /** Копие на цялата база вътре в устройството (защита от грешно изтриване). */
  async function snapshot(reason) {
    // Уникално име дори при няколко копия в една и съща секунда.
    const existing = new Set((await kvKeys()).filter((k) => typeof k === 'string'));
    const when = new Date();
    let file = `finance_${localStamp(when)}_${reason}.db`;
    while (existing.has(`snap:${file}`)) {
      when.setSeconds(when.getSeconds() + 1);
      file = `finance_${localStamp(when)}_${reason}.db`;
    }
    const bytes = db.export();
    prepareConnection();
    await kvSet(`snap:${file}`, bytes);
    await pruneSnapshots();
    return file;
  }

  async function listSnapshots() {
    const keys = (await kvKeys()).filter((k) => typeof k === 'string' && k.startsWith('snap:'));
    const out = [];
    for (const k of keys) {
      const bytes = await kvGet(k);
      out.push({ file: k.slice(5), size: bytes?.byteLength || 0 });
    }
    return out.sort((a, b) => (a.file < b.file ? 1 : -1));
  }

  async function pruneSnapshots() {
    const autos = (await listSnapshots()).filter((s) => s.file.endsWith('_auto.db'));
    for (const s of autos.slice(KEEP_SNAPSHOTS)) await kvDel(`snap:${s.file}`);
  }

  async function dailySnapshot() {
    if (get('SELECT COUNT(*) n FROM transactions').n === 0) return;
    const today = localDate();
    if ((await listSnapshots()).some((s) => s.file.startsWith(`finance_${today}`) && s.file.endsWith('_auto.db'))) return;
    await snapshot('auto');
  }

  function validDb(candidate) {
    try {
      candidate.exec('SELECT COUNT(*) FROM accounts; SELECT COUNT(*) FROM transactions;');
      return true;
    } catch {
      return false;
    }
  }

  async function restoreSnapshot(file) {
    if (typeof file !== 'string' || !/^finance_[\w-]+\.db$/.test(file)) bad('Невалидно копие.');
    const bytes = await kvGet(`snap:${file}`);
    if (!bytes) throw new HttpError(404, 'Копието не е намерено.');
    const candidate = new SQL.Database(bytes);
    if (!validDb(candidate)) { candidate.close(); bad('Копието е повредено.'); }
    const safety = await snapshot('pre-restore');
    db.close();
    db = candidate;
    prepareConnection();
    migrate();
    await persist();
    return { safety };
  }

  function exportJson() {
    const tables = {};
    for (const t of TABLES) tables[t] = all(`SELECT * FROM ${t}`);
    return { app: 'moite-finansi', version: 1, exported_at: new Date().toISOString(), tables };
  }

  async function importJson(data) {
    if (!data || data.app !== 'moite-finansi' || typeof data.tables !== 'object') bad('Файлът не е бекъп от „Моите финанси“.');
    for (const t of TABLES) if (!Array.isArray(data.tables[t] ?? [])) bad(`Повреден бекъп: таблица ${t}.`);
    if (!Array.isArray(data.tables.accounts) || data.tables.accounts.length === 0) bad('Бекъпът не съдържа сметки.');

    const safety = await snapshot('pre-restore');
    try {
      inTx(() => {
        for (const t of [...TABLES].reverse()) run(`DELETE FROM ${t}`);
        for (const t of TABLES) {
          const cols = all(`PRAGMA table_info(${t})`).map((c) => c.name);
          for (const row of data.tables[t] || []) {
            if (!row || typeof row !== 'object') bad(`Повреден ред в таблица ${t}.`);
            const keys = cols.filter((c) => row[c] !== undefined);
            run(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
          }
        }
        if (all('PRAGMA foreign_key_check').length) bad('Бекъпът съдържа несъвместими връзки между данните.');
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, `Възстановяването не успя, данните са непроменени. (${e.message})`);
    }
    return { safety, counts: Object.fromEntries(TABLES.map((t) => [t, (data.tables[t] || []).length])) };
  }

  const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvMoney = (c) => (c / 100).toFixed(2).replace('.', ',');
  const TYPE_BG = { income: 'Приход', expense: 'Разход', fixed: 'Фиксиран разход', transfer: 'Прехвърляне', loan_extra: 'Предсрочно погасяване' };

  function exportCsv(q) {
    const where = [];
    const p = [];
    if (isMonth(q.from)) { where.push('substr(t.date, 1, 7) >= ?'); p.push(q.from); }
    if (isMonth(q.to)) { where.push('substr(t.date, 1, 7) <= ?'); p.push(q.to); }
    const list = rows(`${TX_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.date, t.id`, p);
    const head = ['Дата', 'Вид', 'Сума (EUR)', 'Сметка', 'Към сметка', 'Категория', 'Фиксиран разход', 'За месец',
      'Кредит', 'Главница', 'Лихва', 'Застраховка', 'Бележка'];
    const lines = list.map((t) => {
      const sign = t.type === 'income' || t.type === 'transfer' ? 1 : -1;
      return [t.date, TYPE_BG[t.type], csvMoney(sign * t.amount_cents), t.account_name, t.to_account_name,
        t.category_name, t.fixed_name, t.period, t.loan_name,
        t.principal_cents === null ? '' : csvMoney(t.principal_cents),
        t.interest_cents === null ? '' : csvMoney(t.interest_cents),
        t.insurance_cents === null ? '' : csvMoney(t.insurance_cents), t.note].map(csvCell).join(';');
    });
    // BOM + „;“ — за да се отваря правилно в Excel с български настройки
    return '﻿' + [head.join(';'), ...lines].join('\r\n') + '\r\n';
  }

  // ---------------------------------------------------------------- миграции

  const DB_VERSION = 4;
  function migrate() {
    const v = get('PRAGMA user_version').user_version;
    if (v >= DB_VERSION) return;
    // v2: първоначален размер на кредита (за прогреса на изплащането)
    if (!all('PRAGMA table_info(loans)').some((c) => c.name === 'original_cents')) {
      db.exec('ALTER TABLE loans ADD COLUMN original_cents INTEGER');
    }
    // v3: ден на вноската и метод на олихвяване (реален брой дни/360 — както при UniCredit)
    const cols = all('PRAGMA table_info(loans)').map((c) => c.name);
    if (!cols.includes('payment_day')) db.exec('ALTER TABLE loans ADD COLUMN payment_day INTEGER');
    if (!cols.includes('day_count')) db.exec("ALTER TABLE loans ADD COLUMN day_count TEXT NOT NULL DEFAULT 'act360'");
    if (!cols.includes('prepay_fee')) db.exec('ALTER TABLE loans ADD COLUMN prepay_fee INTEGER NOT NULL DEFAULT 1');

    // v4: вид сметка „пенсионен фонд“ и фиксирани разходи, които са прехвърляне (напр. вноска към фонда)
    if (!all('PRAGMA table_info(fixed_items)').some((c) => c.name === 'to_account_id')) {
      db.exec('ALTER TABLE fixed_items ADD COLUMN to_account_id INTEGER REFERENCES accounts(id)');
    }
    if (!get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").sql.includes("'pension'")) {
      // SQLite не може да промени CHECK — преизграждаме таблицата, като запазваме всички редове и id-та.
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        inTx(() => {
          db.exec(`CREATE TABLE accounts_new (
            id            INTEGER PRIMARY KEY,
            name          TEXT NOT NULL,
            type          TEXT NOT NULL CHECK (type IN ('bank','cash','credit','savings','invest','pension')),
            opening_cents INTEGER NOT NULL DEFAULT 0,
            credit_limit_cents INTEGER,
            sort          INTEGER NOT NULL DEFAULT 0,
            archived      INTEGER NOT NULL DEFAULT 0
          )`);
          db.exec(`INSERT INTO accounts_new (id, name, type, opening_cents, credit_limit_cents, sort, archived)
                   SELECT id, name, type, opening_cents, credit_limit_cents, sort, archived FROM accounts`);
          db.exec('DROP TABLE accounts');
          db.exec('ALTER TABLE accounts_new RENAME TO accounts');
          if (all('PRAGMA foreign_key_check').length) throw new Error('Нарушени връзки след обновяване.');
        });
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
    // Пенсионният фонд в Алианц (25,56 € месечно от основната банкова сметка) — добавя се веднъж към съществуващи данни.
    if (v < 4 && get('SELECT COUNT(*) n FROM accounts').n > 0 && !get("SELECT id FROM accounts WHERE type = 'pension'")) {
      const sort = get('SELECT COALESCE(MAX(sort), 0) + 1 s FROM accounts').s;
      const pension = run("INSERT INTO accounts (name, type, sort) VALUES ('Пенсионен фонд Алианц', 'pension', ?)", sort).lastInsertRowid;
      const bank = get("SELECT id FROM accounts WHERE type = 'bank' AND archived = 0 ORDER BY sort, id LIMIT 1");
      if (bank) {
        const fsort = get('SELECT COALESCE(MAX(sort), 0) + 1 s FROM fixed_items').s;
        run('INSERT INTO fixed_items (name, default_cents, account_id, to_account_id, sort) VALUES (?, ?, ?, ?, ?)',
          'Пенсионен фонд Алианц', 2556, bank.id, pension, fsort);
      }
    }
    db.exec(`PRAGMA user_version = ${DB_VERSION}`);
  }

  // ---------------------------------------------------------------- „адреси“ (същите като при сървъра)

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/api\/meta$/, () => meta());
  route('GET', /^\/api\/overview$/, ({ query }) => {
    if (!isMonth(query.m)) bad('Невалиден месец.');
    return overview(query.m);
  });
  route('GET', /^\/api\/transactions$/, ({ query }) => listTransactions(query));
  route('POST', /^\/api\/transactions$/, ({ body }) => createTx(body));
  route('PUT', /^\/api\/transactions\/(\d+)$/, ({ body, params }) => updateTx(Number(params[0]), body));
  route('DELETE', /^\/api\/transactions\/(\d+)$/, ({ params }) => {
    run('DELETE FROM transactions WHERE id = ?', Number(params[0]));
    return { ok: true };
  });

  route('POST', /^\/api\/accounts$/, ({ body }) => ({ id: saveAccount(null, body) }));
  route('PUT', /^\/api\/accounts\/(\d+)$/, ({ body, params }) => ({ id: saveAccount(Number(params[0]), body) }));
  route('DELETE', /^\/api\/accounts\/(\d+)$/, ({ params }) => {
    deleteRow('accounts', Number(params[0]),
      'SELECT (SELECT COUNT(*) FROM transactions WHERE account_id = ?1 OR to_account_id = ?1) + (SELECT COUNT(*) FROM fixed_items WHERE account_id = ?2) n',
      'Сметката се използва в движения или фиксирани разходи. Можете да я архивирате.');
    return { ok: true };
  });

  route('POST', /^\/api\/categories$/, ({ body }) => ({ id: saveCategory(null, body) }));
  route('PUT', /^\/api\/categories\/(\d+)$/, ({ body, params }) => ({ id: saveCategory(Number(params[0]), body) }));
  route('DELETE', /^\/api\/categories\/(\d+)$/, ({ params }) => {
    deleteRow('categories', Number(params[0]),
      'SELECT COUNT(*) n FROM transactions WHERE category_id = ?1 OR category_id = ?2',
      'Категорията има разходи. Можете да я архивирате — старите записи ще се запазят.');
    return { ok: true };
  });

  route('POST', /^\/api\/fixed$/, ({ body }) => ({ id: saveFixed(null, body) }));
  route('PUT', /^\/api\/fixed\/(\d+)$/, ({ body, params }) => ({ id: saveFixed(Number(params[0]), body) }));
  route('DELETE', /^\/api\/fixed\/(\d+)$/, ({ params }) => {
    deleteRow('fixed_items', Number(params[0]),
      'SELECT COUNT(*) n FROM transactions WHERE fixed_id = ?1 OR fixed_id = ?2',
      'Има записани плащания по този разход. Можете да го спрете (неактивен) — историята ще се запази.');
    return { ok: true };
  });

  route('PUT', /^\/api\/settings$/, ({ body }) => { saveSettings(body); return settingsObj(); });

  route('GET', /^\/api\/loans$/, () => loansWithStatus());
  route('GET', /^\/api\/loans\/(\d+)$/, ({ params }) => loanDetail(Number(params[0])));
  route('GET', /^\/api\/loans\/(\d+)\/simulate$/, ({ params, query }) => simulateExtra(Number(params[0]), query.extra));
  route('POST', /^\/api\/loans$/, ({ body }) => ({ id: saveLoan(null, body) }));
  route('PUT', /^\/api\/loans\/(\d+)$/, ({ body, params }) => ({ id: saveLoan(Number(params[0]), body) }));
  route('DELETE', /^\/api\/loans\/(\d+)$/, ({ params }) => { deleteLoan(Number(params[0])); return { ok: true }; });
  route('GET', /^\/api\/pension$/, () => pensionFunds());
  // История на плащанията: вноски по кредити, предсрочни погасявания и вноски към пенсионен фонд — най-новите първо.
  route('GET', /^\/api\/payments$/, () => all(`${TX_SELECT}
    WHERE t.loan_id IS NOT NULL OR (t.type = 'fixed' AND ta.type = 'pension')
    ORDER BY t.date DESC, t.id DESC`));
  route('PUT', /^\/api\/pension\/(\d+)$/, ({ body, params }) => ({ id: savePension(Number(params[0]), body) }));

  route('GET', /^\/api\/backups$/, () => listSnapshots());
  route('POST', /^\/api\/backups$/, async () => ({ file: await snapshot('manual') }));
  route('POST', /^\/api\/backups\/restore$/, ({ body }) => restoreSnapshot(body.file));
  route('GET', /^\/api\/backup\/json$/, () => exportJson());
  route('POST', /^\/api\/backup\/done$/, () => { setSetting('last_backup_at', new Date().toISOString()); return { ok: true }; });
  route('POST', /^\/api\/backup\/restore$/, async ({ body }) => (body?.app === 'moite-finansi' && body.kind === 'loans'
    ? importLoans(body.loans)
    : importJson(body)));
  route('GET', /^\/api\/export\/csv$/, ({ query }) => exportCsv(query));

  const MUTATING = new Set(['POST', 'PUT', 'DELETE']);

  /** Изпълнява заявка към локалната база. Връща резултата или хвърля грешка с текст на български. */
  async function request(method, url, body = {}) {
    await ready;
    const u = new URL(url, 'http://local');
    const r = routes.find((x) => x.method === method && x.pattern.test(u.pathname));
    if (!r) throw new Error('Няма такава функция.');
    const params = u.pathname.match(r.pattern).slice(1);
    try {
      const out = await r.handler({ body: body ?? {}, params, query: Object.fromEntries(u.searchParams) });
      if (MUTATING.has(method)) await persist();
      return out;
    } catch (e) {
      if (e instanceof HttpError) throw new Error(e.message);
      console.error(e);
      throw new Error(`Вътрешна грешка: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------- старт

  async function init() {
    SQL = await initSqlJs({ locateFile: (f) => `lib/${f}` });
    const bytes = await kvGet('db');
    db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    prepareConnection();
    db.exec(SCHEMA);
    migrate();
    seedIfEmpty();
    await persist();
    // Молим браузъра да не трие данните при липса на място.
    try { await navigator.storage?.persist?.(); } catch { /* по избор */ }
    try { await dailySnapshot(); } catch (e) { console.warn('Копие:', e); }
  }

  const ready = init();

  return { ready, request };
})();
