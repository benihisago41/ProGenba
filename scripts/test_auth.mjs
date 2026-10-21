// 認証・権限・会社境界（Phase 3）の結合試験。
// scripts/test_auth.ps1 が作る専用 Compose プロジェクト（progenba-authtest）のネットワーク内で実行する。
// 稼働中の progenba-app-1 / progenba-db-1 には接続しない（SIRIUS_TEST_PSQL=1 と PG* 環境変数が前提）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

assert.equal(process.env.SIRIUS_TEST_PSQL, '1', 'scripts/test_auth.ps1 経由で実行してください');
const base = process.env.SIRIUS_TEST_URL;
assert.ok(base, 'SIRIUS_TEST_URL が未設定です');
const outputPath = process.env.SIRIUS_AUTH_OUTPUT || 'artifacts/auth-acceptance.json';
const legacyOutput = process.env.SIRIUS_TEST_OUTPUT || 'artifacts/acceptance-api-auth.json';
const db = sql => execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' }).trim();

const ROLES = ['viewer', 'registrar', 'approver'];
const uid = role => `authtest-${role}`;
const pw = (company, role) => {
  const v = process.env[`AUTHTEST_PW_${company}_${role.toUpperCase()}`];
  assert.ok(v, `AUTHTEST_PW_${company}_${role.toUpperCase()} が未設定です`);
  return v;
};
const sha256 = s => createHash('sha256').update(s).digest('hex');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, passed: false, error: String(e && e.message || e).slice(0, 600) });
    console.log('FAIL', name, String(e && e.message || e).slice(0, 600));
  }
}

async function call(path, { method = 'GET', body, cookie, contentType } = {}) {
  const headers = { Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = contentType ?? 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    redirect: 'manual',
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非JSON */ }
  return { status: res.status, data, text, setCookie: res.headers.get('set-cookie') };
}
function expect(r, status, code) {
  assert.equal(r.status, status, `HTTP ${r.status} (期待 ${status}): ${r.text.slice(0, 300)}`);
  if (code) {
    assert.equal(r.data?.code, code);
    assert.equal(typeof r.data?.message, 'string');
    assert.ok(r.data.message.length > 0);
  }
  return r;
}
const post = (path, body, cookie, contentType) => call(path, { method: 'POST', body, cookie, contentType });

async function loginRaw(company_code, user_id, password) {
  return post('/api/v1/auth/login', { company_code, user_id, password });
}
function cookieFrom(r) {
  assert.ok(r.setCookie, 'Set-Cookie がありません');
  const m = /^progenba_session=([0-9a-f]{64});/.exec(r.setCookie);
  assert.ok(m, `セッションCookie形式が不正: ${r.setCookie.replace(/=[0-9a-f]{64}/, '=<token>')}`);
  return { cookie: `progenba_session=${m[1]}`, token: m[1], header: r.setCookie };
}
const sessions = {};
async function login(company, role) {
  const r = expect(await loginRaw(company, uid(role), pw(company, role)), 200);
  const c = cookieFrom(r);
  sessions[`${company}:${role}`] = c;
  return { ...c, me: r.data };
}

// 登録ペイロード（scripts/test_api.mjs と同じ検証用値）
const cost = { company_code: '0000', project_code: 'PRJ-2026-A', branch_code: '000', occurred_date: '2026-07-01', work_type_code: '002000100010', cost_element_code: '0100', item_name: '認証受入検証', quantity: '1.000', unit: 'm3', unit_price: '100.000' };
const report = { company_code: '0000', project_code: 'PRJ-2026-A', branch_code: '000', work_date: '2026-07-01', employee_code: 'EMP-0001', work_type_code: '002000100010', work_hours: '1.000' };
const equip = { company_code: '0000', equipment_code: 'EQP-001', dest_project_code: 'PRJ-2026-A', dest_branch_code: '000', work_type_code: '001000100010', movement_date: '2026-07-01', quantity: '1.000', usage_days: 1, freight_fee: 0, maintenance_fee: 0 };
const progress = { company_code: '0000', order_number: 'ORD-2026-001', order_history_no: 0, assessment_year_month: '202607', curr_assessed_amount_tax_ex: 1000, fixed_deductions: 0, chargeback_offset: 0 };
const KINDS = {
  'subcontract-progress': { table: 'progress_assessments', col: 'assessment_no' },
  'direct-entry': { table: 'direct_cost_entries', col: 'entry_no' },
  'daily-report': { table: 'site_daily_reports', col: 'report_no' },
  'equipment-movement': { table: 'equipment_site_movements', col: 'movement_slip_no' },
};
// 枝番（と外注注文番号）を差し替えた4方式のペイロード
function payloads(company, branch, orderNumber = 'ORD-2026-001') {
  return {
    'subcontract-progress': { ...progress, company_code: company, order_number: orderNumber },
    'direct-entry': { ...cost, company_code: company, branch_code: branch },
    'daily-report': { ...report, company_code: company, branch_code: branch },
    'equipment-movement': { ...equip, company_code: company, dest_branch_code: branch },
  };
}
const documents = [];
async function registerOk(kind, body, cookie) {
  const r = expect(await post('/api/v1/costs/' + kind, body, cookie), 201);
  assert.match(r.data.document_no, /^\d{12}$/);
  assert.ok(Array.isArray(r.data.warnings));
  documents.push({ ...KINDS[kind], no: r.data.document_no, company: body.company_code });
  return r.data;
}
const countAll = company => Object.values(KINDS)
  .map(({ table }) => Number(db(`SELECT count(*) FROM ${table} WHERE company_code='${company}';`)))
  .reduce((a, b) => a + b, 0);

const tenantTables = ['business_partners', 'work_types', 'cost_elements', 'quick_item_templates', 'project_masters', 'project_branches', 'execution_budgets', 'execution_budget_details', 'subcontract_orders', 'construction_equipment_masters'];
const created = { tenant: false, branches: false, orders: [] };
let fatal = null;

try {
  // ---- 前提: 試験開始時点はシードどおり（他の試験の残骸がない） ----
  for (const t of Object.values(KINDS)) assert.equal(Number(db(`SELECT count(*) FROM ${t.table};`)), 0, `${t.table} に既存伝票があります`);
  for (const table of tenantTables) assert.equal(Number(db(`SELECT count(*) FROM ${table} WHERE company_code='9001';`)), 0, '9001 の既存データがあります');

  await check('health-is-public', async () => {
    expect(await call('/api/v1/health'), 200);
  });

  await check('unauthenticated-requests-are-401', async () => {
    for (const p of ['/api/v1/cockpit', '/api/v1/cockpit?company_code=0000', '/api/v1/lookups', '/api/v1/lookups?company_code=0000', '/api/v1/auth/me']) {
      expect(await call(p), 401, 'UNAUTHORIZED');
    }
    for (const [kind, body] of Object.entries(payloads('0000', '000'))) {
      expect(await post('/api/v1/costs/' + kind, body), 401, 'UNAUTHORIZED');
    }
    // 形式不正・未知のトークンも 401
    expect(await call('/api/v1/cockpit', { cookie: 'progenba_session=not-a-token' }), 401, 'UNAUTHORIZED');
    expect(await call('/api/v1/cockpit', { cookie: `progenba_session=${'a'.repeat(64)}` }), 401, 'UNAUTHORIZED');
    assert.equal(countAll('0000'), 0);
  });

  await check('login-failures-are-indistinguishable-401', async () => {
    const wrong = expect(await loginRaw('0000', uid('registrar'), 'wrong-password-123'), 401, 'UNAUTHORIZED');
    const noUser = expect(await loginRaw('0000', 'authtest-nobody', 'wrong-password-123'), 401, 'UNAUTHORIZED');
    const noCompany = expect(await loginRaw('9999', uid('registrar'), pw('0000', 'registrar')), 401, 'UNAUTHORIZED');
    // 同じ利用者IDでも会社が違えば別利用者（9001 のパスワードでは 0000 に入れない）
    const otherCompanyPw = expect(await loginRaw('0000', uid('registrar'), pw('9001', 'registrar')), 401, 'UNAUTHORIZED');
    const malformed = expect(await loginRaw('00', uid('registrar'), 'x'), 401, 'UNAUTHORIZED');
    for (const r of [noUser, noCompany, otherCompanyPw, malformed]) {
      assert.equal(r.data.message, wrong.data.message, '失敗理由を区別しないこと');
      assert.equal(r.setCookie, null);
    }
    assert.equal(wrong.setCookie, null);
    // 失敗回数を戻す（後続のロック試験とは別利用者）
    db(`UPDATE app_users SET failed_login_count=0 WHERE company_code='0000' AND user_id='${uid('registrar')}';`);
  });

  await check('login-sets-httponly-strict-cookie-and-me', async () => {
    for (const company of ['0000', '9001']) {
      for (const role of ROLES) {
        const s = await login(company, role);
        assert.match(s.header, /HttpOnly/);
        assert.match(s.header, /SameSite=Strict/);
        assert.match(s.header, /Path=\//);
        assert.doesNotMatch(s.header, /Secure/, '既定は Secure off（HTTP運用）');
        assert.deepEqual(Object.keys(s.me).sort(), ['company_code', 'display_name', 'role', 'user_id']);
        assert.equal(s.me.company_code, company);
        assert.equal(s.me.role, role);
        const me = expect(await call('/api/v1/auth/me', { cookie: s.cookie }), 200);
        assert.deepEqual(me.data, s.me);
        // DB にはトークン本体ではなく SHA-256 のみ保存
        assert.equal(Number(db(`SELECT count(*) FROM app_sessions WHERE token_hash='${sha256(s.token)}';`)), 1);
        assert.equal(Number(db(`SELECT count(*) FROM app_sessions WHERE token_hash='${s.token}';`)), 0);
      }
    }
    assert.equal(db("SELECT count(*) FILTER (WHERE password_hash NOT LIKE '$argon2id$%') || '/' || count(*) FROM app_users;"), '0/9', '全利用者（9人）が Argon2id で保存されていること');
  });

  await check('cockpit-values-after-login-match-pre-auth-seed', async () => {
    const c = sessions['0000:approver'].cookie;
    const rows = expect(await call('/api/v1/cockpit?company_code=0000', { cookie: c }), 200).data;
    const main = rows.find(r => r.key.project_code === 'PRJ-2026-A' && r.key.branch_code === '000');
    const add = rows.find(r => r.key.project_code === 'PRJ-2026-A' && r.key.branch_code === '001');
    assert.ok(main && add);
    // 認証導入前（scripts/test_api.mjs の readiness 試験・シード）と同じ値
    assert.equal(main.execution_budget_amount, 38000000);
    assert.equal(main.actual_occurred_cost, 0);
    assert.equal(main.forecast_gross_profit, 12000000);
    assert.equal(main.ordered_committed_amount, 18000000);
    assert.equal(typeof main.forecast_profit_rate, 'string');
    assert.equal(add.execution_budget_amount, 3500000);
    assert.equal(add.actual_occurred_cost, 0);
    // company_code 省略時はセッションの会社（同一結果）
    const omitted = expect(await call('/api/v1/cockpit', { cookie: c }), 200).data;
    assert.deepEqual(omitted, rows);
    const look = expect(await call('/api/v1/lookups', { cookie: c }), 200).data;
    assert.equal(look.quick_templates.length, 5);
    assert.equal(look.employees.length, 2);
  });

  // ---- 試験用データ: 9001 複製会社、完成区分 1/2/3 の枝番と注文 ----
  db('BEGIN;' + tenantTables.map(t => `INSERT INTO ${t} SELECT (jsonb_populate_record(NULL::${t},to_jsonb(x)||'{"company_code":"9001"}'::jsonb)).* FROM ${t} x WHERE company_code='0000';`).join('\n') +
    "UPDATE project_masters SET project_name = project_name || '（9001複製）' WHERE company_code='9001'; COMMIT;");
  created.tenant = true;
  db(`BEGIN;
    INSERT INTO project_branches SELECT (jsonb_populate_record(NULL::project_branches,to_jsonb(b)||jsonb_build_object('branch_code',v.code,'branch_name','認証受入検証','completion_status',v.status))).* FROM project_branches b CROSS JOIN (VALUES('990','1'),('991','2'),('992','3')) v(code,status) WHERE b.company_code='0000' AND b.project_code='PRJ-2026-A' AND b.branch_code='000';
    COMMIT;`);
  created.branches = true;
  for (const br of ['990', '991', '992']) {
    db(`INSERT INTO subcontract_orders SELECT (jsonb_populate_record(NULL::subcontract_orders,to_jsonb(o)||jsonb_build_object('order_number','QA-AUTH-${br}','branch_code','${br}'))).* FROM subcontract_orders o WHERE company_code='0000' AND order_number='ORD-2026-002' AND order_history_no=0;`);
    created.orders.push(`QA-AUTH-${br}`);
  }

  await check('viewer-cannot-register-any-of-4-methods-403', async () => {
    const before = countAll('0000');
    for (const [kind, body] of Object.entries(payloads('0000', '000'))) {
      const r = expect(await post('/api/v1/costs/' + kind, body, sessions['0000:viewer'].cookie), 403, 'FORBIDDEN');
      assert.match(r.data.message, /閲覧/);
    }
    assert.equal(countAll('0000'), before);
    // 閲覧は可能
    expect(await call('/api/v1/cockpit', { cookie: sessions['0000:viewer'].cookie }), 200);
    expect(await call('/api/v1/lookups', { cookie: sessions['0000:viewer'].cookie }), 200);
  });

  await check('registrar-registers-uncompleted-201-all-4-methods', async () => {
    for (const [kind, body] of Object.entries(payloads('0000', '000'))) {
      const d = await registerOk(kind, body, sessions['0000:registrar'].cookie);
      assert.ok(!d.warnings.some(w => w.includes('完成')), '未成工事に完成警告は出ない');
    }
  });

  await check('registrar-on-completed-1-is-403-with-reason-and-not-written', async () => {
    const before = countAll('0000');
    for (const [kind, body] of Object.entries(payloads('0000', '990', 'QA-AUTH-990'))) {
      const r = expect(await post('/api/v1/costs/' + kind, body, sessions['0000:registrar'].cookie), 403, 'FORBIDDEN');
      assert.match(r.data.message, /承認権限/);
    }
    assert.equal(countAll('0000'), before);
  });

  await check('approver-on-completed-1-is-201-with-warning', async () => {
    for (const [kind, body] of Object.entries(payloads('0000', '990', 'QA-AUTH-990'))) {
      const d = await registerOk(kind, body, sessions['0000:approver'].cookie);
      assert.ok(d.warnings.some(w => w.includes('完成区分が「完成(1)」')), `${kind}: 完成警告が必要`);
    }
  });

  await check('completed-2-and-3-are-422-even-for-approver', async () => {
    const before = countAll('0000');
    for (const br of ['991', '992']) {
      for (const role of ['approver', 'registrar']) {
        for (const [kind, body] of Object.entries(payloads('0000', br, `QA-AUTH-${br}`))) {
          expect(await post('/api/v1/costs/' + kind, body, sessions[`0000:${role}`].cookie), 422, 'UNPROCESSABLE_ENTITY');
        }
      }
    }
    assert.equal(countAll('0000'), before);
  });

  await check('cross-company-get-and-post-are-403-without-9001-data', async () => {
    const before9001 = countAll('9001');
    for (const role of ROLES) {
      const c = sessions[`0000:${role}`].cookie;
      for (const p of ['/api/v1/cockpit?company_code=9001', '/api/v1/cockpit?company_code=9001&branch_code=000', '/api/v1/lookups?company_code=9001']) {
        const r = expect(await call(p, { cookie: c }), 403, 'FORBIDDEN');
        assert.ok(!Array.isArray(r.data) && !('quick_templates' in r.data), '9001 のデータを返さない');
        assert.ok(!r.text.includes('9001複製'));
      }
    }
    for (const role of ['registrar', 'approver']) {
      for (const [kind, body] of Object.entries(payloads('9001', '000'))) {
        expect(await post('/api/v1/costs/' + kind, body, sessions[`0000:${role}`].cookie), 403, 'FORBIDDEN');
      }
    }
    // 逆方向（9001 の利用者が 0000 を指定）も 403
    expect(await call('/api/v1/cockpit?company_code=0000', { cookie: sessions['9001:approver'].cookie }), 403, 'FORBIDDEN');
    expect(await post('/api/v1/costs/direct-entry', cost, sessions['9001:approver'].cookie), 403, 'FORBIDDEN');
    assert.equal(countAll('9001'), before9001, '9001 に書き込まれていない');
  });

  await check('omitted-company-get-returns-only-own-company', async () => {
    // 9001 側に 1 件登録して両社の値を変える
    await registerOk('direct-entry', { ...cost, company_code: '9001' }, sessions['9001:registrar'].cookie);
    const own = expect(await call('/api/v1/cockpit', { cookie: sessions['0000:viewer'].cookie }), 200).data;
    assert.ok(own.length > 0 && own.every(r => r.key.company_code === '0000' && !r.project_name.includes('9001複製')));
    const other = expect(await call('/api/v1/cockpit', { cookie: sessions['9001:viewer'].cookie }), 200).data;
    assert.ok(other.length > 0 && other.every(r => r.key.company_code === '9001' && r.project_name.includes('9001複製')));
    const otherMain = other.find(r => r.key.branch_code === '000');
    assert.equal(otherMain.actual_occurred_cost, 100);
    assert.equal(otherMain.execution_budget_amount, 38000000);
    const ownMain = own.find(r => r.key.branch_code === '000');
    assert.equal(ownMain.actual_occurred_cost, Number(db(`SELECT
      (SELECT COALESCE(SUM(curr_assessed_amount_tax_ex),0) FROM progress_assessments WHERE company_code='0000' AND branch_code='000') +
      (SELECT COALESCE(SUM(amount_tax_ex),0) FROM direct_cost_entries WHERE company_code='0000' AND branch_code='000') +
      (SELECT COALESCE(SUM(calculated_labor_cost),0) FROM site_daily_reports WHERE company_code='0000' AND branch_code='000') +
      (SELECT COALESCE(SUM(calculated_equip_cost),0) FROM equipment_site_movements WHERE company_code='0000' AND dest_branch_code='000');`)));
    const look = expect(await call('/api/v1/lookups', { cookie: sessions['9001:viewer'].cookie }), 200).data;
    assert.equal(look.quick_templates.length, 5);
  });

  await check('state-changing-post-requires-json-content-type', async () => {
    const before = countAll('0000');
    expect(await post('/api/v1/costs/direct-entry', JSON.stringify(cost), sessions['0000:approver'].cookie, 'text/plain'), 400, 'BAD_REQUEST');
    expect(await post('/api/v1/costs/direct-entry', 'a=1', sessions['0000:approver'].cookie, 'application/x-www-form-urlencoded'), 400, 'BAD_REQUEST');
    expect(await post('/api/v1/auth/logout', '', sessions['0000:approver'].cookie, 'text/plain'), 400, 'BAD_REQUEST');
    expect(await post('/api/v1/auth/login', JSON.stringify({ company_code: '0000', user_id: uid('viewer'), password: pw('0000', 'viewer') }), undefined, 'text/plain'), 400, 'BAD_REQUEST');
    assert.equal(countAll('0000'), before);
    // ログアウト要求が拒否されたのでセッションは有効なまま
    expect(await call('/api/v1/auth/me', { cookie: sessions['0000:approver'].cookie }), 200);
  });

  await check('logout-deletes-server-session-and-cookie-is-rejected', async () => {
    const s = cookieFrom(expect(await loginRaw('0000', uid('viewer'), pw('0000', 'viewer')), 200));
    expect(await call('/api/v1/cockpit', { cookie: s.cookie }), 200);
    const r = expect(await post('/api/v1/auth/logout', {}, s.cookie), 204);
    assert.match(r.setCookie || '', /Max-Age=0/);
    assert.equal(Number(db(`SELECT count(*) FROM app_sessions WHERE token_hash='${sha256(s.token)}';`)), 0);
    expect(await call('/api/v1/cockpit', { cookie: s.cookie }), 401, 'UNAUTHORIZED');
    expect(await call('/api/v1/auth/me', { cookie: s.cookie }), 401, 'UNAUTHORIZED');
    // 他のセッションには影響しない
    expect(await call('/api/v1/auth/me', { cookie: sessions['0000:registrar'].cookie }), 200);
  });

  await check('expired-session-is-401-and-activity-slides-expiry', async () => {
    const s = cookieFrom(expect(await loginRaw('0000', uid('registrar'), pw('0000', 'registrar')), 200));
    const h = sha256(s.token);
    db(`UPDATE app_sessions SET expires_at = now() + interval '1 minute' WHERE token_hash='${h}';`);
    expect(await call('/api/v1/auth/me', { cookie: s.cookie }), 200);
    const hours = Number(db(`SELECT round(extract(epoch FROM expires_at - now()) / 3600) FROM app_sessions WHERE token_hash='${h}';`));
    assert.equal(hours, 8, 'アクセスで無操作期限が8時間に延長される');
    db(`UPDATE app_sessions SET expires_at = now() - interval '1 second' WHERE token_hash='${h}';`);
    expect(await call('/api/v1/cockpit', { cookie: s.cookie }), 401, 'UNAUTHORIZED');
    expect(await post('/api/v1/costs/direct-entry', cost, s.cookie), 401, 'UNAUTHORIZED');
  });

  await check('consecutive-failures-lock-user-temporarily', async () => {
    const user = 'authtest-lockout';
    const good = pw('0000', 'lockout');
    for (let i = 0; i < 5; i++) expect(await loginRaw('0000', user, `wrong-${i}-password`), 401, 'UNAUTHORIZED');
    assert.equal(db(`SELECT locked_until > now() FROM app_users WHERE company_code='0000' AND user_id='${user}';`), 't');
    const locked = expect(await loginRaw('0000', user, good), 401, 'UNAUTHORIZED');
    assert.equal(locked.setCookie, null, 'ロック中は正しいパスワードでも拒否');
    // ロック期限経過を模擬
    db(`UPDATE app_users SET locked_until = now() - interval '1 second' WHERE company_code='0000' AND user_id='${user}';`);
    expect(await loginRaw('0000', user, good), 200);
    assert.equal(db(`SELECT failed_login_count || ',' || CASE WHEN locked_until IS NULL THEN 'unlocked' ELSE 'locked' END FROM app_users WHERE company_code='0000' AND user_id='${user}';`), '0,unlocked');
  });

  await check('deactivated-user-session-and-login-are-401', async () => {
    const user = 'authtest-disabled';
    const s = cookieFrom(expect(await loginRaw('0000', user, pw('0000', 'disabled')), 200));
    expect(await call('/api/v1/cockpit', { cookie: s.cookie }), 200);
    db(`UPDATE app_users SET is_active = FALSE WHERE company_code='0000' AND user_id='${user}';`);
    // 既存セッションは残っていても無効化した利用者では通らない
    assert.equal(Number(db(`SELECT count(*) FROM app_sessions WHERE token_hash='${sha256(s.token)}';`)), 1);
    expect(await call('/api/v1/cockpit', { cookie: s.cookie }), 401, 'UNAUTHORIZED');
    expect(await call('/api/v1/auth/me', { cookie: s.cookie }), 401, 'UNAUTHORIZED');
    const r = expect(await loginRaw('0000', user, pw('0000', 'disabled')), 401, 'UNAUTHORIZED');
    assert.equal(r.setCookie, null);
    // 再度有効化すれば同じパスワードで入れる（拒否理由が is_active であることの確認）
    db(`UPDATE app_users SET is_active = TRUE WHERE company_code='0000' AND user_id='${user}';`);
    expect(await loginRaw('0000', user, pw('0000', 'disabled')), 200);
  });

  await check('add-user-update-demotion-revokes-existing-sessions', async () => {
    // test_auth.ps1 が approver でログイン → add-user --update --role viewer を実行済み
    const oldCookie = process.env.AUTHTEST_DEMOTE_OLD_COOKIE;
    assert.ok(oldCookie, 'AUTHTEST_DEMOTE_OLD_COOKIE が未設定です');
    assert.equal(process.env.AUTHTEST_DEMOTE_ROLE_BEFORE, 'approver', '降格前は承認権限');
    assert.equal(Number(db("SELECT count(*) FROM app_sessions WHERE company_code='0000' AND user_id='authtest-demote';")), 0);
    expect(await call('/api/v1/auth/me', { cookie: oldCookie }), 401, 'UNAUTHORIZED');
    expect(await post('/api/v1/costs/direct-entry', cost, oldCookie), 401, 'UNAUTHORIZED');
    const r = expect(await loginRaw('0000', 'authtest-demote', pw('0000', 'demote')), 200);
    assert.equal(r.data.role, 'viewer');
    expect(await post('/api/v1/costs/direct-entry', cost, cookieFrom(r).cookie), 403, 'FORBIDDEN');
  });

  await check('static-bundle-serves-login-screen', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<div id="root">/);
    const src = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
    assert.ok(src, 'バンドルの script がありません');
    const js = await (await fetch(new URL(src, base))).text();
    for (const s of ['/api/v1/auth/login', '/api/v1/auth/me', '/api/v1/auth/logout', 'ログイン', '会社コード', '利用者ID', 'パスワード', 'same-origin']) {
      assert.ok(js.includes(s), `バンドルに ${s} が含まれていません`);
    }
  });
} catch (e) {
  fatal = String(e && e.message || e);
  console.log('FATAL', fatal);
} finally {
  // 試験データの後片付け（環境ごと削除するが、念のため作成したものは消す）
  try {
    for (const { table, col, no, company } of documents.reverse()) db(`DELETE FROM ${table} WHERE company_code='${company}' AND ${col}='${no}';`);
    for (const no of created.orders) db(`DELETE FROM subcontract_orders WHERE company_code='0000' AND order_number='${no}';`);
    if (created.branches) db("DELETE FROM project_branches WHERE company_code='0000' AND project_code='PRJ-2026-A' AND branch_code IN ('990','991','992');");
    if (created.tenant) for (const t of [...tenantTables].reverse()) db(`DELETE FROM ${t} WHERE company_code='9001';`);
    db("DELETE FROM app_users WHERE user_id LIKE 'authtest-%';");
  } catch (e) {
    fatal = (fatal ? fatal + ' / ' : '') + 'cleanup: ' + String(e && e.message || e);
  }
}

let legacy = null;
if (existsSync(legacyOutput)) {
  try {
    const j = JSON.parse(readFileSync(legacyOutput, 'utf8'));
    legacy = { file: legacyOutput, passed: j.passed === true, tests: j.tests?.length ?? 0, error: j.error ?? null };
  } catch { legacy = { file: legacyOutput, passed: false, error: '読み取り失敗' }; }
}
let migration = null;
try { migration = JSON.parse(process.env.SIRIUS_MIGRATION_RESULT || 'null'); } catch { migration = { passed: false, error: '読み取り失敗' }; }
const passed = !fatal && results.length > 0 && results.every(r => r.passed) && legacy?.passed === true && migration?.passed === true;
writeFileSync(outputPath, JSON.stringify({
  passed,
  checked_at: new Date().toISOString(),
  commit: process.env.SIRIUS_TEST_COMMIT || null,
  environment: {
    compose_project: process.env.SIRIUS_TEST_PROJECT || null,
    base,
    note: '専用 Compose プロジェクトで実行。稼働中の progenba-app-1 / progenba-db-1 は使用していない',
  },
  users: '0000・9001 × viewer/registrar/approver ＋ 0000 のロック・無効化・降格試験用（試験中だけ作成、パスワードは実行ごとに乱数生成し記録しない）',
  summary: { total: results.length, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length },
  tests: results,
  legacy_api_acceptance: legacy,
  // 既存DB（002 未適用）→ app 起動時に 002 適用 → 再起動でも冪等、の経路（test_auth.ps1 が実施）
  startup_migration_on_existing_db: migration,
  fatal,
}, null, 2) + '\n');
console.log(passed ? '[AUTH ACCEPTANCE PASSED]' : '[AUTH ACCEPTANCE FAILED]');
process.exit(passed ? 0 : 1);
