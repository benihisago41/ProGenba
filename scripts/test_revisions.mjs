// 予算・発注の登録と承認（Phase 4）の結合試験。
// scripts/test_auth.ps1 が作る専用 Compose プロジェクト（progenba-authtest）のネットワーク内で、
// test_api.mjs・test_auth.mjs の後に実行する。稼働中の progenba-app-1 / progenba-db-1 には接続しない。
// 試験用利用者 revtest-{viewer,registrar,approver}（0000・9001）は test_auth.ps1 が試験中だけ作成する
// （パスワードは実行ごとに乱数生成し、環境変数でのみ受け取る。ファイル・ログに出さない）。
// 専用環境ごと削除されるため、作成した業務データの後片付けはしない（操作履歴は追記専用で削除できない）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

assert.equal(process.env.SIRIUS_TEST_PSQL, '1', 'scripts/test_auth.ps1 経由で実行してください');
const base = process.env.SIRIUS_TEST_URL;
assert.ok(base, 'SIRIUS_TEST_URL が未設定です');
const outputPath = process.env.SIRIUS_REVISIONS_OUTPUT || 'artifacts/revisions-acceptance.json';
const db = sql => execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
/** DB が拒否すること（エラー文に marker を含む）を確認する */
function dbRejects(sql, marker) {
  try {
    db(sql);
  } catch (e) {
    const text = String(e.stderr || '') + String(e.message || '');
    assert.ok(text.includes(marker), `DBのエラー文に ${marker} がありません: ${text.slice(0, 300)}`);
    return;
  }
  assert.fail(`DB が更新を受け付けてしまいました: ${sql}`);
}

const ROLES = ['viewer', 'registrar', 'approver'];
const pw = (company, role) => {
  const v = process.env[`REVTEST_PW_${company}_${role.toUpperCase()}`];
  assert.ok(v, `REVTEST_PW_${company}_${role.toUpperCase()} が未設定です`);
  return v;
};

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, passed: false, error: String(e && e.message || e).slice(0, 800) });
    console.log('FAIL', name, String(e && e.message || e).slice(0, 800));
  }
}

async function call(path, { method = 'GET', body, cookie, contentType, rawBody } = {}) {
  const headers = { Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (contentType !== undefined) { if (contentType) headers['Content-Type'] = contentType; }
  else if (body !== undefined || method !== 'GET') headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非JSON・空 */ }
  return { status: res.status, data, text };
}
function expect(r, status, code) {
  assert.equal(r.status, status, `HTTP ${r.status} (期待 ${status}): ${r.text.slice(0, 400)}`);
  if (code) {
    assert.equal(r.data?.code, code);
    assert.ok(typeof r.data?.message === 'string' && r.data.message.length > 0);
  }
  return r.data;
}

const sessions = {};
async function login(company, role) {
  const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code: company, user_id: `revtest-${role}`, password: pw(company, role) }) });
  assert.equal(res.status, 200, `revtest-${role}@${company} でログインできません`);
  const m = /progenba_session=([0-9a-f]{64})/.exec(res.headers.get('set-cookie') || '');
  assert.ok(m, 'セッションCookieがありません');
  sessions[`${company}:${role}`] = `progenba_session=${m[1]}`;
}
const S = (company, role) => sessions[`${company}:${role}`];

const P = 'PRJ-2026-A';
const budgetUrl = (p, b) => `/api/v1/projects/${encodeURIComponent(p)}/branches/${b}/budget`;
const draftsUrl = (p, b) => `${budgetUrl(p, b)}/drafts`;
const draftUrl = (p, b, h) => `${draftsUrl(p, b)}/${h}`;
const orderDrafts = n => `/api/v1/orders/${encodeURIComponent(n)}/drafts`;
const orderDraft = (n, h) => `${orderDrafts(n)}/${h}`;
async function cockpit(company, project, branch, role = 'viewer') {
  const rows = expect(await call(`/api/v1/cockpit?project_code=${encodeURIComponent(project)}&branch_code=${branch}`, { cookie: S(company, role) }), 200);
  assert.equal(rows.length, 1, `コックピットに ${project}-${branch} がありません`);
  return rows[0];
}
const getBudget = (company, p, b, role = 'viewer') => call(budgetUrl(p, b), { cookie: S(company, role) }).then(r => expect(r, 200));
const getOrders = (company, p, b, role = 'viewer') => call(`/api/v1/projects/${encodeURIComponent(p)}/branches/${b}/orders`, { cookie: S(company, role) }).then(r => expect(r, 200));
const toInputs = lines => lines.map(l => ({
  line_no: l.line_no, work_type_code: l.work_type_code, cost_element_code: l.cost_element_code, item_name: l.item_name,
  specification: l.specification, unit: l.unit, planned_quantity: l.planned_quantity, planned_unit_price: l.planned_unit_price,
}));
const count = sql => Number(db(sql));
const orderFields = o => ({
  subcontractor_code: o.subcontractor_code, work_type_code: o.work_type_code, order_date: o.order_date,
  work_start_date: o.work_start_date, work_end_date: o.work_end_date, is_unit_price_contract: o.is_unit_price_contract,
  order_amount_tax_ex: o.order_amount_tax_ex, tax_rate: o.tax_rate, retainage_rate_num: o.retainage_rate_num,
  retainage_rate_den: o.retainage_rate_den, safety_assoc_rate_num: o.safety_assoc_rate_num, safety_assoc_rate_den: o.safety_assoc_rate_den,
});
const assessment = (h, amount) => ({ company_code: '0000', order_number: 'ORD-2026-001', order_history_no: h, assessment_year_month: '202608', curr_assessed_amount_tax_ex: amount, fixed_deductions: 0, chargeback_offset: 0 });
const mainBranch = (patch = {}) => ({
  branch_name: '本工事（受入検証）', site_manager_code: 'EMP-0001', supervising_engineer_code: null, chief_engineer_code: null,
  client_partner_code: 'CLI-0001', contract_start_date: '2026-09-01', contract_end_date: '2027-03-31',
  internal_start_date: '2026-09-05', internal_end_date: '2027-03-20', contract_amount_tax_ex: 20000000,
  contract_tax_amount: 2000000, estimated_total_cost: 15000000, ...patch,
});
const tenantTables = ['business_partners', 'work_types', 'cost_elements', 'quick_item_templates', 'project_masters', 'project_branches', 'execution_budgets', 'execution_budget_details', 'subcontract_orders', 'construction_equipment_masters'];
const digest9001 = () => db(`SELECT md5(string_agg(x, E'\\n' ORDER BY x)) FROM (
  SELECT 'b|'||t::text AS x FROM execution_budgets t WHERE company_code='9001'
  UNION ALL SELECT 'd|'||t::text FROM execution_budget_details t WHERE company_code='9001'
  UNION ALL SELECT 'o|'||t::text FROM subcontract_orders t WHERE company_code='9001'
  UNION ALL SELECT 'p|'||t::text FROM project_branches t WHERE company_code='9001'
  UNION ALL SELECT 'm|'||t::text FROM project_masters t WHERE company_code='9001') s;`);

let fatal = null;
let ui = null;
const expected = {};
try {
  for (const company of ['0000', '9001']) for (const role of ROLES) await login(company, role);
  // 前提: test_api・test_auth の後片付け済みで、シードどおり（予算は履歴0のみ・査定0件・9001 は空）
  assert.equal(count("SELECT count(*) FROM execution_budgets WHERE company_code='0000';"), 2, '予算の版がシードと異なります');
  assert.equal(count('SELECT count(*) FROM progress_assessments;'), 0, '既存の出来高査定があります');
  assert.equal(count("SELECT count(*) FROM project_masters WHERE company_code='9001';"), 0, '9001 の既存データがあります');
  assert.equal(count("SELECT count(*) FROM revision_events;"), 0, '操作履歴が空ではありません');

  await check('unauthenticated-and-content-type-guards', async () => {
    expect(await call('/api/v1/projects'), 401, 'UNAUTHORIZED');
    expect(await call(budgetUrl(P, '000')), 401, 'UNAUTHORIZED');
    expect(await call('/api/v1/orders', { method: 'POST', body: {} }), 401, 'UNAUTHORIZED');
    expect(await call(draftsUrl(P, '000'), { method: 'POST', cookie: S('0000', 'registrar'), contentType: 'text/plain', rawBody: '{}' }), 400, 'BAD_REQUEST');
    expect(await call(draftsUrl(P, '000'), { method: 'POST', cookie: S('0000', 'registrar'), contentType: 'application/x-www-form-urlencoded', rawBody: 'a=1' }), 400, 'BAD_REQUEST');
    assert.equal(count("SELECT count(*) FROM execution_budgets WHERE company_code='0000';"), 2);
  });

  await check('viewer-can-read-but-cannot-create-drafts-403', async () => {
    const list = expect(await call('/api/v1/projects', { cookie: S('0000', 'viewer') }), 200);
    assert.ok(list.projects.some(p => p.project_code === P && p.branches.length === 2));
    const b = await getBudget('0000', P, '000');
    assert.equal(b.approved.history_no, 0);
    assert.equal(b.approved.total_budget_amount, 38000000);
    assert.equal(b.approved.lines.length, 6);
    assert.equal(b.draft, null);
    expect(await call('/api/v1/revision-options', { cookie: S('0000', 'viewer') }), 200);
    const before = count("SELECT count(*) FROM execution_budgets WHERE company_code='0000';");
    expect(await call(draftsUrl(P, '000'), { method: 'POST', body: {}, cookie: S('0000', 'viewer') }), 403, 'FORBIDDEN');
    expect(await call(orderDrafts('ORD-2026-001'), { method: 'POST', body: {}, cookie: S('0000', 'viewer') }), 403, 'FORBIDDEN');
    expect(await call('/api/v1/orders', { method: 'POST', cookie: S('0000', 'viewer'), body: { project_code: P, branch_code: '000', subcontractor_code: 'SUB-0001', work_type_code: '002000100010', order_date: '2026-08-01', work_start_date: '2026-08-01', work_end_date: '2026-09-01', order_amount_tax_ex: 1 } }), 403, 'FORBIDDEN');
    assert.equal(count("SELECT count(*) FROM execution_budgets WHERE company_code='0000';"), before);
    assert.equal(count("SELECT count(*) FROM subcontract_orders WHERE company_code='0000';"), 2);
  });

  await check('registrar-creates-revision-draft-copying-latest-approved', async () => {
    const r = expect(await call(draftsUrl(P, '000'), { method: 'POST', body: {}, cookie: S('0000', 'registrar') }), 201);
    assert.equal(r.history_no, 1);
    assert.equal(r.status, '0');
    assert.equal(r.amount, 38000000);
    assert.equal(count(`SELECT count(*) FROM execution_budget_details WHERE company_code='0000' AND project_code='${P}' AND branch_code='000' AND budget_history_no=1;`), 6);
    const b = await getBudget('0000', P, '000');
    assert.equal(b.draft.history_no, 1);
    assert.equal(b.draft.created_by, 'revtest-registrar');
    assert.equal(b.diff.total_delta, 0);
    assert.equal(b.diff.added.length + b.diff.changed.length + b.diff.removed.length, 0);
  });

  await check('only-one-unapproved-draft-per-key-409', async () => {
    expect(await call(draftsUrl(P, '000'), { method: 'POST', body: {}, cookie: S('0000', 'registrar') }), 409, 'CONFLICT');
    expect(await call(draftsUrl(P, '000'), { method: 'POST', body: {}, cookie: S('0000', 'approver') }), 409, 'CONFLICT');
    assert.equal(count(`SELECT count(*) FROM execution_budgets WHERE company_code='0000' AND project_code='${P}' AND branch_code='000' AND approval_status='0';`), 1);
  });

  await check('registrar-edits-draft-and-server-computes-line-amounts-and-total', async () => {
    const b = await getBudget('0000', P, '000');
    const lines = toInputs(b.draft.lines)
      .filter(l => l.line_no !== 6)
      .map(l => (l.line_no === 2 ? { ...l, planned_unit_price: '9000000.000', planned_amount: 1 } : l));
    lines.push({ line_no: null, work_type_code: '002000100010', cost_element_code: '0100', item_name: '追加資材（受入検証）', specification: null, unit: '式', planned_quantity: '3.000', planned_unit_price: '1000.500', planned_amount: 999 });
    // 不正な明細（自社マスタに無い工種・費目、精度超過）は 422
    expect(await call(draftUrl(P, '000', 1), { method: 'PUT', cookie: S('0000', 'registrar'), body: { target_gross_profit_rate: '25.00', notes: 'x', lines: [{ ...lines[0], work_type_code: '999999999999' }] } }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call(draftUrl(P, '000', 1), { method: 'PUT', cookie: S('0000', 'registrar'), body: { target_gross_profit_rate: '25.00', notes: 'x', lines: [{ ...lines[0], cost_element_code: '0999' }] } }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call(draftUrl(P, '000', 1), { method: 'PUT', cookie: S('0000', 'registrar'), body: { target_gross_profit_rate: '25.00', notes: 'x', lines: [{ ...lines[0], planned_quantity: '1.0001' }] } }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call(draftUrl(P, '000', 1), { method: 'PUT', cookie: S('0000', 'viewer'), body: { target_gross_profit_rate: '25.00', notes: 'x', lines } }), 403, 'FORBIDDEN');
    const r = expect(await call(draftUrl(P, '000', 1), { method: 'PUT', cookie: S('0000', 'registrar'), body: { target_gross_profit_rate: '25.00', notes: '受入検証の改定', total_budget_amount: 1, lines } }), 200);
    // 38,000,000 − 2,000,000（6行目削除）+ 500,000（2行目単価）+ round_half_up(3 × 1000.5 = 3001.5) = 3,002
    expected.budgetH1 = 38000000 - 2000000 + 500000 + 3002;
    assert.equal(r.amount, expected.budgetH1);
    assert.equal(db(`SELECT line_no||','||planned_amount FROM execution_budget_details WHERE company_code='0000' AND project_code='${P}' AND branch_code='000' AND budget_history_no=1 AND item_name='追加資材（受入検証）';`), '7,3002', '新しい行は承認済み版の最大行番号の次・金額はサーバー計算');
    assert.equal(count(`SELECT total_budget_amount FROM execution_budgets WHERE company_code='0000' AND project_code='${P}' AND branch_code='000' AND budget_history_no=1;`), expected.budgetH1);
    const d = (await getBudget('0000', P, '000')).diff;
    assert.equal(d.total_before, 38000000);
    assert.equal(d.total_after, expected.budgetH1);
    assert.equal(d.total_delta, expected.budgetH1 - 38000000);
    assert.deepEqual(d.added.map(l => l.line_no), [7]);
    assert.deepEqual(d.removed.map(l => l.line_no), [6]);
    assert.deepEqual(d.changed.map(c => [c.line_no, c.amount_delta]), [[2, 500000]]);
  });

  await check('registrar-and-viewer-cannot-approve-403-and-cockpit-unchanged-before-approval', async () => {
    for (const role of ['viewer', 'registrar']) {
      expect(await call(`${draftUrl(P, '000', 1)}/approve`, { method: 'POST', body: {}, cookie: S('0000', role) }), 403, 'FORBIDDEN');
      expect(await call(`${draftUrl(P, '000', 1)}/reject`, { method: 'POST', body: { reason: '不可' }, cookie: S('0000', role) }), 403, 'FORBIDDEN');
    }
    const c = await cockpit('0000', P, '000');
    assert.equal(c.execution_budget_amount, 38000000, '承認前の案はコックピットに反映されない');
    assert.equal(c.latest_budget_history_no, 0);
    assert.equal(db(`SELECT approval_status FROM execution_budgets WHERE company_code='0000' AND project_code='${P}' AND branch_code='000' AND budget_history_no=1;`), '0');
  });

  await check('reject-requires-reason-422', async () => {
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'あ'.repeat(201) }]) {
      expect(await call(`${draftUrl(P, '000', 1)}/reject`, { method: 'POST', body, cookie: S('0000', 'approver') }), 422, 'UNPROCESSABLE_ENTITY');
    }
    assert.equal(db(`SELECT approval_status FROM execution_budgets WHERE company_code='0000' AND project_code='${P}' AND branch_code='000' AND budget_history_no=1;`), '0');
  });

  await check('approver-approves-budget-cockpit-reflects-expected-and-actual-cost-unchanged', async () => {
    const before = await cockpit('0000', P, '000');
    const r = expect(await call(`${draftUrl(P, '000', 1)}/approve`, { method: 'POST', body: { comment: '受入検証で承認' }, cookie: S('0000', 'approver') }), 200);
    assert.equal(r.status, '1');
    assert.equal(r.amount, expected.budgetH1);
    const after = await cockpit('0000', P, '000');
    assert.equal(after.execution_budget_amount, expected.budgetH1);
    assert.equal(after.latest_budget_history_no, 1);
    assert.equal(after.by_work_type.reduce((s, w) => s + w.budget_amount, 0), expected.budgetH1);
    assert.equal(after.actual_occurred_cost, before.actual_occurred_cost, '予算の承認は実際原価を変えない');
    assert.deepEqual(after.actual_breakdown, before.actual_breakdown);
    assert.equal(after.ordered_committed_amount, before.ordered_committed_amount);
    assert.equal(count(`SELECT total_budget_amount - (SELECT SUM(planned_amount) FROM execution_budget_details d WHERE d.company_code=b.company_code AND d.project_code=b.project_code AND d.branch_code=b.branch_code AND d.budget_history_no=b.budget_history_no) FROM execution_budgets b WHERE company_code='0000' AND project_code='${P}' AND branch_code='000' AND budget_history_no=1;`), 0, 'ヘッダ総額＝明細合計');
  });

  await check('approved-version-cannot-be-changed-via-api-or-db-trigger', async () => {
    const lines = toInputs((await getBudget('0000', P, '000')).approved.lines);
    for (const h of [0, 1]) {
      expect(await call(draftUrl(P, '000', h), { method: 'PUT', cookie: S('0000', 'approver'), body: { target_gross_profit_rate: '1.00', notes: null, lines } }), 409, 'CONFLICT');
      expect(await call(draftUrl(P, '000', h), { method: 'DELETE', cookie: S('0000', 'approver') }), 409, 'CONFLICT');
      expect(await call(`${draftUrl(P, '000', h)}/approve`, { method: 'POST', body: {}, cookie: S('0000', 'approver') }), 409, 'CONFLICT');
      expect(await call(`${draftUrl(P, '000', h)}/reject`, { method: 'POST', body: { reason: '再否認' }, cookie: S('0000', 'approver') }), 409, 'CONFLICT');
    }
    expect(await call(draftUrl(P, '000', 99), { method: 'PUT', cookie: S('0000', 'registrar'), body: { target_gross_profit_rate: '1.00', notes: null, lines } }), 404, 'NOT_FOUND');
    dbRejects(`UPDATE execution_budgets SET notes='直接更新' WHERE company_code='0000' AND project_code='${P}' AND branch_code='000' AND budget_history_no=1;`, 'IMMUTABLE_REVISION_VIOLATION');
    dbRejects(`UPDATE execution_budgets SET total_budget_amount=1 WHERE company_code='0000' AND project_code='${P}' AND branch_code='000' AND budget_history_no=0;`, 'IMMUTABLE_REVISION_VIOLATION');
    assert.equal((await cockpit('0000', P, '000')).execution_budget_amount, expected.budgetH1);
  });

  await check('reject-with-reason-then-new-draft-and-delete-draft', async () => {
    const r2 = expect(await call(draftsUrl(P, '000'), { method: 'POST', body: {}, cookie: S('0000', 'registrar') }), 201);
    assert.equal(r2.history_no, 2);
    assert.equal(r2.amount, expected.budgetH1, '改定案は最新の承認済み版（履歴1）を複写');
    const rej = expect(await call(`${draftUrl(P, '000', 2)}/reject`, { method: 'POST', body: { reason: '  数量根拠の資料が不足  ' }, cookie: S('0000', 'approver') }), 200);
    assert.equal(rej.status, '9');
    const b = await getBudget('0000', P, '000');
    assert.equal(b.draft, null);
    assert.ok(b.versions.some(v => v.history_no === 2 && v.status === '9'));
    expect(await call(draftUrl(P, '000', 2), { method: 'PUT', cookie: S('0000', 'registrar'), body: { target_gross_profit_rate: '1.00', notes: null, lines: [] } }), 409, 'CONFLICT');
    const r3 = expect(await call(draftsUrl(P, '000'), { method: 'POST', body: {}, cookie: S('0000', 'registrar') }), 201);
    assert.equal(r3.history_no, 3, '否認後は新しい案（履歴番号+1）を作れる');
    assert.equal(r3.amount, expected.budgetH1);
    // DELETE: Content-Type: application/json が必須（本文は空でよい）
    expect(await call(draftUrl(P, '000', 3), { method: 'DELETE', cookie: S('0000', 'registrar'), contentType: '' }), 400, 'BAD_REQUEST');
    expect(await call(draftUrl(P, '000', 3), { method: 'DELETE', cookie: S('0000', 'viewer') }), 403, 'FORBIDDEN');
    const del = await call(draftUrl(P, '000', 3), { method: 'DELETE', cookie: S('0000', 'registrar') });
    assert.equal(del.status, 204, del.text);
    assert.equal(count(`SELECT count(*) FROM execution_budgets WHERE company_code='0000' AND project_code='${P}' AND branch_code='000' AND budget_history_no=3;`), 0);
    assert.equal(count(`SELECT count(*) FROM execution_budget_details WHERE company_code='0000' AND project_code='${P}' AND branch_code='000' AND budget_history_no=3;`), 0);
    assert.equal((await cockpit('0000', P, '000')).execution_budget_amount, expected.budgetH1, '否認・削除はコックピットに影響しない');
  });

  await check('concurrent-draft-creation-and-concurrent-approval-are-serialized', async () => {
    const created = await Promise.all([0, 1].map(() => call(draftsUrl(P, '000'), { method: 'POST', body: {}, cookie: S('0000', 'registrar') })));
    assert.deepEqual(created.map(r => r.status).sort(), [201, 409]);
    const h = created.find(r => r.status === 201).data.history_no;
    assert.equal(h, 3);
    const lines = toInputs((await getBudget('0000', P, '000')).draft.lines).map(l => (l.line_no === 1 ? { ...l, planned_unit_price: '2501000.000' } : l));
    expect(await call(draftUrl(P, '000', h), { method: 'PUT', cookie: S('0000', 'registrar'), body: { target_gross_profit_rate: '24.00', notes: '同時承認試験', lines } }), 200);
    const approvals = await Promise.all([0, 1].map(() => call(`${draftUrl(P, '000', h)}/approve`, { method: 'POST', body: {}, cookie: S('0000', 'approver') })));
    assert.deepEqual(approvals.map(r => r.status).sort(), [200, 409], approvals.map(r => r.text).join(' / '));
    assert.equal(count(`SELECT count(*) FROM execution_budgets WHERE company_code='0000' AND project_code='${P}' AND branch_code='000' AND budget_history_no=${h} AND approval_status='1';`), 1);
    assert.equal(count(`SELECT count(*) FROM revision_events WHERE company_code='0000' AND target_type='budget' AND action='approve' AND history_no=${h};`), 1, '承認の操作履歴は1件');
    assert.equal(count(`SELECT count(*) - count(DISTINCT budget_history_no) FROM execution_budgets WHERE company_code='0000' AND project_code='${P}' AND branch_code='000';`), 0);
    expected.budgetH3 = expected.budgetH1 + 1000;
    const c = await cockpit('0000', P, '000');
    assert.equal(c.execution_budget_amount, expected.budgetH3);
    assert.equal(c.latest_budget_history_no, 3);
  });

  await check('order-revision-below-cumulative-assessment-is-422', async () => {
    // 外注出来高 3,000,000（承認済み履歴0の条件）
    expect(await call('/api/v1/costs/subcontract-progress', { method: 'POST', body: assessment(0, 3000000), cookie: S('0000', 'registrar') }), 201);
    const r = expect(await call(orderDrafts('ORD-2026-001'), { method: 'POST', body: {}, cookie: S('0000', 'registrar') }), 201);
    assert.equal(r.history_no, 1);
    assert.equal(r.amount, 10000000);
    const draft = (await getOrders('0000', P, '000')).orders.find(o => o.order_number === 'ORD-2026-001').draft;
    const f = orderFields(draft);
    expect(await call(orderDraft('ORD-2026-001', 1), { method: 'PUT', cookie: S('0000', 'registrar'), body: { ...f, order_amount_tax_ex: 2999999 } }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call(orderDraft('ORD-2026-001', 1), { method: 'PUT', cookie: S('0000', 'registrar'), body: { ...f, tax_rate: '0.080' } }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call(orderDraft('ORD-2026-001', 1), { method: 'PUT', cookie: S('0000', 'registrar'), body: { ...f, subcontractor_code: 'SUB-0002' } }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call(orderDraft('ORD-2026-001', 1), { method: 'PUT', cookie: S('0000', 'registrar'), body: { ...f, order_amount_tax_ex: 3500000 } }), 200);
    // 案の保存後に査定が増え（承認済み履歴0の条件で 600,000）、累計 3,600,000 > 案 3,500,000 になる
    expect(await call('/api/v1/costs/subcontract-progress', { method: 'POST', body: assessment(0, 600000), cookie: S('0000', 'registrar') }), 201);
    expect(await call(`${orderDraft('ORD-2026-001', 1)}/approve`, { method: 'POST', body: {}, cookie: S('0000', 'registrar') }), 403, 'FORBIDDEN');
    const denied = expect(await call(`${orderDraft('ORD-2026-001', 1)}/approve`, { method: 'POST', body: {}, cookie: S('0000', 'approver') }), 422, 'UNPROCESSABLE_ENTITY');
    assert.match(denied.message, /査定累計/);
    assert.equal(db("SELECT order_status FROM subcontract_orders WHERE company_code='0000' AND order_number='ORD-2026-001' AND order_history_no=1;"), '0');
    const look = expect(await call('/api/v1/lookups', { cookie: S('0000', 'viewer') }), 200).subcontract_orders.find(o => o.order_number === 'ORD-2026-001');
    assert.equal(look.order_history_no, 0, '承認されるまで出来高登録は旧版の条件');
    // 増額に直して承認（税額は承認時にサーバーが切捨で計算）
    expect(await call(orderDraft('ORD-2026-001', 1), { method: 'PUT', cookie: S('0000', 'registrar'), body: { ...f, order_amount_tax_ex: 12000000, order_tax_amount: 1 } }), 200);
    const ok = expect(await call(`${orderDraft('ORD-2026-001', 1)}/approve`, { method: 'POST', body: { comment: '追加数量の反映' }, cookie: S('0000', 'approver') }), 200);
    assert.equal(ok.status, '1');
    assert.equal(db("SELECT order_amount_tax_ex||','||order_tax_amount||','||order_status FROM subcontract_orders WHERE company_code='0000' AND order_number='ORD-2026-001' AND order_history_no=1;"), '12000000,1200000,1');
  });

  await check('assessment-after-order-approval-uses-new-version-amount-and-balance', async () => {
    const look = expect(await call('/api/v1/lookups', { cookie: S('0000', 'viewer') }), 200).subcontract_orders.find(o => o.order_number === 'ORD-2026-001');
    assert.equal(look.order_history_no, 1);
    assert.equal(look.order_amount_tax_ex, 12000000);
    assert.equal(look.accum_assessed_amount_tax_ex, 3600000);
    assert.equal(look.remaining_order_balance, 8400000);
    expect(await call('/api/v1/costs/subcontract-progress', { method: 'POST', body: assessment(0, 1), cookie: S('0000', 'registrar') }), 409, 'CONFLICT');
    // 旧版（10,000,000）では超過する 8,400,000 が、新版（12,000,000）の残高ちょうどで登録できる
    expect(await call('/api/v1/costs/subcontract-progress', { method: 'POST', body: assessment(1, 8400000), cookie: S('0000', 'registrar') }), 201);
    expect(await call('/api/v1/costs/subcontract-progress', { method: 'POST', body: assessment(1, 1), cookie: S('0000', 'registrar') }), 422, 'UNPROCESSABLE_ENTITY');
    assert.equal(count("SELECT count(*) FROM progress_assessments WHERE company_code='0000' AND order_number='ORD-2026-001' AND order_history_no=1;"), 1);
    const c = await cockpit('0000', P, '000');
    assert.equal(c.ordered_committed_amount, 12000000 + 8000000);
    assert.equal(c.actual_breakdown.subcontract_cost, 12000000);
    assert.equal(c.execution_budget_amount, expected.budgetH3);
    const entry = (await getOrders('0000', P, '000')).orders.find(o => o.order_number === 'ORD-2026-001');
    assert.equal(entry.remaining_order_balance, 0);
    assert.equal(entry.accum_assessed_amount_tax_ex, 12000000);
  });

  await check('approved-order-cannot-be-changed-via-api-or-db-trigger', async () => {
    const approved = (await getOrders('0000', P, '000')).orders.find(o => o.order_number === 'ORD-2026-001').approved;
    expect(await call(orderDraft('ORD-2026-001', 1), { method: 'PUT', cookie: S('0000', 'approver'), body: orderFields(approved) }), 409, 'CONFLICT');
    expect(await call(orderDraft('ORD-2026-001', 0), { method: 'DELETE', cookie: S('0000', 'approver') }), 409, 'CONFLICT');
    dbRejects("UPDATE subcontract_orders SET order_amount_tax_ex=1 WHERE company_code='0000' AND order_number='ORD-2026-001' AND order_history_no=1;", 'IMMUTABLE_REVISION_VIOLATION');
    // 減額改定の案は作れるが、査定累計（12,000,000）を下回る額では保存も承認もできない
    const r = expect(await call(orderDrafts('ORD-2026-001'), { method: 'POST', body: {}, cookie: S('0000', 'registrar') }), 201);
    expect(await call(orderDraft('ORD-2026-001', r.history_no), { method: 'PUT', cookie: S('0000', 'registrar'), body: { ...orderFields(approved), order_amount_tax_ex: 11999999 } }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call(orderDraft('ORD-2026-001', r.history_no), { method: 'DELETE', cookie: S('0000', 'registrar'), rawBody: '{}' }), 204);
  });

  await check('new-order-auto-numbering-duplicates-partner-roles-and-approval', async () => {
    const body = { project_code: P, branch_code: '001', subcontractor_code: 'SUB-0002', work_type_code: '001000200010', order_date: '2026-05-01', work_start_date: '2026-06-05', work_end_date: '2026-11-30', order_amount_tax_ex: 1234567, tax_rate: '0.100' };
    expect(await call('/api/v1/orders', { method: 'POST', cookie: S('0000', 'registrar'), body: { ...body, order_number: 'ORD-2026-001' } }), 409, 'CONFLICT');
    expect(await call('/api/v1/orders', { method: 'POST', cookie: S('0000', 'registrar'), body: { ...body, subcontractor_code: 'CLI-0001' } }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call('/api/v1/orders', { method: 'POST', cookie: S('0000', 'registrar'), body: { ...body, work_type_code: '999999999999' } }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call('/api/v1/orders', { method: 'POST', cookie: S('0000', 'registrar'), body: { ...body, work_end_date: '2026-06-01' } }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call('/api/v1/orders', { method: 'POST', cookie: S('0000', 'registrar'), body: { ...body, order_number: 'bad number' } }), 422, 'UNPROCESSABLE_ENTITY');
    const before = await cockpit('0000', P, '001');
    const r = expect(await call('/api/v1/orders', { method: 'POST', cookie: S('0000', 'registrar'), body }), 201);
    assert.equal(r.order_number, 'ORD-2026-003', 'ORD-YYYY-NNN の自動採番（既存最大+1）');
    assert.equal(r.history_no, 0);
    const manual = expect(await call('/api/v1/orders', { method: 'POST', cookie: S('0000', 'registrar'), body: { ...body, order_number: 'QA-RV-001' } }), 201);
    assert.equal(manual.order_number, 'QA-RV-001');
    expect(await call(orderDraft('QA-RV-001', 0), { method: 'DELETE', cookie: S('0000', 'registrar') }), 204);
    assert.equal(count("SELECT count(*) FROM subcontract_orders WHERE company_code='0000' AND order_number='QA-RV-001';"), 0);
    const o = (await getOrders('0000', P, '001')).orders.find(x => x.order_number === 'ORD-2026-003');
    assert.equal(o.approved, null);
    assert.equal(o.draft.order_tax_amount, 123456);
    assert.equal(o.diff.base_history_no, null);
    assert.equal((await cockpit('0000', P, '001')).ordered_committed_amount, before.ordered_committed_amount, '承認前の発注は発注確定額に入らない');
    expect(await call(`${orderDraft('ORD-2026-003', 0)}/approve`, { method: 'POST', body: {}, cookie: S('0000', 'approver') }), 200);
    const after = await cockpit('0000', P, '001');
    assert.equal(after.ordered_committed_amount, before.ordered_committed_amount + 1234567);
    // 同時に改定案を作っても1つだけ
    const both = await Promise.all([0, 1].map(() => call(orderDrafts('ORD-2026-002'), { method: 'POST', body: {}, cookie: S('0000', 'registrar') })));
    assert.deepEqual(both.map(x => x.status).sort(), [201, 409]);
    assert.equal(count("SELECT count(*) FROM subcontract_orders WHERE company_code='0000' AND order_number='ORD-2026-002' AND order_status='0';"), 1);
    const rejected = expect(await call(`${orderDraft('ORD-2026-002', 1)}/reject`, { method: 'POST', body: { reason: '工期の根拠が未添付' }, cookie: S('0000', 'approver') }), 200);
    assert.equal(rejected.status, '9');
  });

  await check('project-and-branch-registration-is-approver-only-with-validation', async () => {
    const proj = { project_code: 'PRJ-RV-01', project_name: '受入検証 新築工事', project_short_name: '受入検証', doken_type: '2', honzatsu_type: '1', kanmin_type1: '2', main_branch: mainBranch() };
    expect(await call('/api/v1/projects', { method: 'POST', cookie: S('0000', 'viewer'), body: proj }), 403, 'FORBIDDEN');
    const denied = expect(await call('/api/v1/projects', { method: 'POST', cookie: S('0000', 'registrar'), body: proj }), 403, 'FORBIDDEN');
    assert.match(denied.message, /承認権限/);
    for (const bad of [
      { ...proj, main_branch: mainBranch({ site_manager_code: 'SUB-0001' }) },
      { ...proj, main_branch: mainBranch({ client_partner_code: 'EMP-0001' }) },
      { ...proj, main_branch: mainBranch({ contract_end_date: '2026-08-31' }) },
      { ...proj, main_branch: mainBranch({ internal_start_date: '2027-03-21' }) },
      { ...proj, main_branch: mainBranch({ supervising_engineer_code: 'CLI-0001' }) },
      { ...proj, main_branch: mainBranch({ contract_amount_tax_ex: -1 }) },
      { ...proj, project_code: 'PRJ RV' },
      { ...proj, project_name: '' },
      { ...proj, doken_type: '5' },
    ]) {
      expect(await call('/api/v1/projects', { method: 'POST', cookie: S('0000', 'approver'), body: bad }), 422, 'UNPROCESSABLE_ENTITY');
    }
    assert.equal(count("SELECT count(*) FROM project_masters WHERE company_code='0000' AND project_code='PRJ-RV-01';"), 0);
    const r = expect(await call('/api/v1/projects', { method: 'POST', cookie: S('0000', 'approver'), body: proj }), 201);
    assert.equal(r.branch_code, '000');
    expect(await call('/api/v1/projects', { method: 'POST', cookie: S('0000', 'approver'), body: proj }), 409, 'CONFLICT');
    assert.equal(db("SELECT completion_status||','||order_format||','||approval_status FROM project_branches b JOIN project_masters m USING (company_code, project_code) WHERE company_code='0000' AND project_code='PRJ-RV-01' AND branch_code='000';"), '0,1,1');
    const br = { ...mainBranch({ branch_name: '第1回追加工事（受入検証）', contract_amount_tax_ex: 1000000, contract_tax_amount: 100000, estimated_total_cost: 800000 }), branch_code: '001' };
    expect(await call('/api/v1/projects/PRJ-RV-01/branches', { method: 'POST', cookie: S('0000', 'registrar'), body: br }), 403, 'FORBIDDEN');
    expect(await call('/api/v1/projects/PRJ-RV-01/branches', { method: 'POST', cookie: S('0000', 'approver'), body: { ...br, branch_code: '000' } }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call('/api/v1/projects/PRJ-RV-01/branches', { method: 'POST', cookie: S('0000', 'approver'), body: { ...br, branch_code: '1' } }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call('/api/v1/projects/PRJ-NONE/branches', { method: 'POST', cookie: S('0000', 'approver'), body: br }), 404, 'NOT_FOUND');
    expect(await call('/api/v1/projects/PRJ-RV-01/branches', { method: 'POST', cookie: S('0000', 'approver'), body: br }), 201);
    expect(await call('/api/v1/projects/PRJ-RV-01/branches', { method: 'POST', cookie: S('0000', 'approver'), body: br }), 409, 'CONFLICT');
    const main0 = await cockpit('0000', 'PRJ-RV-01', '000');
    assert.equal(main0.contract_amount_tax_ex, 20000000);
    assert.equal(main0.execution_budget_amount, 0);
  });

  await check('budget-on-new-branch-starts-at-history-0-and-appears-in-cockpit-after-approval', async () => {
    const r = expect(await call(draftsUrl('PRJ-RV-01', '001'), { method: 'POST', body: {}, cookie: S('0000', 'registrar') }), 201);
    assert.equal(r.history_no, 0, '版が無い枝番は履歴0の空の案');
    assert.equal(r.amount, 0);
    expect(await call(`${draftUrl('PRJ-RV-01', '001', 0)}/approve`, { method: 'POST', body: {}, cookie: S('0000', 'approver') }), 422, 'UNPROCESSABLE_ENTITY');
    const lines = [
      { line_no: null, work_type_code: '001000200010', cost_element_code: '0300', item_name: '擁壁土工外注', specification: null, unit: 'm3', planned_quantity: '10.000', planned_unit_price: '12345.678' },
      { line_no: null, work_type_code: '001000100010', cost_element_code: '0400', item_name: '仮設経費', specification: '月額', unit: '月', planned_quantity: '2.500', planned_unit_price: '1000.000' },
    ];
    const u = expect(await call(draftUrl('PRJ-RV-01', '001', 0), { method: 'PUT', cookie: S('0000', 'registrar'), body: { target_gross_profit_rate: '20.00', notes: null, lines } }), 200);
    // round_half_up(123456.78) = 123457、2.5 × 1000 = 2500
    expected.newBranch = 123457 + 2500;
    assert.equal(u.amount, expected.newBranch);
    assert.equal((await cockpit('0000', 'PRJ-RV-01', '001')).execution_budget_amount, 0);
    expect(await call(`${draftUrl('PRJ-RV-01', '001', 0)}/approve`, { method: 'POST', body: {}, cookie: S('0000', 'approver') }), 200);
    const c = await cockpit('0000', 'PRJ-RV-01', '001');
    assert.equal(c.execution_budget_amount, expected.newBranch);
    assert.equal(c.latest_budget_history_no, 0);
    assert.equal(c.contract_amount_tax_ex, 1000000);
    assert.equal(c.forecast_gross_profit, 1000000 - expected.newBranch);
  });

  await check('cross-company-access-is-rejected-and-data-unchanged', async () => {
    db('BEGIN;' + tenantTables.map(t => `INSERT INTO ${t} SELECT (jsonb_populate_record(NULL::${t},to_jsonb(x)||'{"company_code":"9001"}'::jsonb)).* FROM ${t} x WHERE company_code='0000';`).join('\n') +
      "UPDATE project_masters SET project_name = project_name || '（9001複製）' WHERE company_code='9001'; COMMIT;");
    expect(await call('/api/v1/projects', { method: 'POST', cookie: S('9001', 'approver'), body: { project_code: 'PRJ-9001-X', project_name: '9001専用工事', project_short_name: '9001専用', main_branch: mainBranch() } }), 201);
    const h9001 = expect(await call(draftsUrl(P, '000'), { method: 'POST', body: {}, cookie: S('9001', 'registrar') }), 201).history_no;
    assert.equal(h9001, 4);
    const before9001 = digest9001();
    const before0000 = await cockpit('0000', P, '000');
    const events0000 = count("SELECT count(*) FROM revision_events WHERE company_code='0000';");
    // 0000 の利用者が 9001 にしかない工事を指定 → 404（存在しない扱い）
    expect(await call(budgetUrl('PRJ-9001-X', '000'), { cookie: S('0000', 'approver') }), 404, 'NOT_FOUND');
    expect(await call(`/api/v1/projects/PRJ-9001-X/branches/000/orders`, { cookie: S('0000', 'approver') }), 404, 'NOT_FOUND');
    expect(await call(draftsUrl('PRJ-9001-X', '000'), { method: 'POST', body: {}, cookie: S('0000', 'registrar') }), 404, 'NOT_FOUND');
    expect(await call('/api/v1/projects/PRJ-9001-X/branches', { method: 'POST', cookie: S('0000', 'approver'), body: { ...mainBranch(), branch_code: '005' } }), 404, 'NOT_FOUND');
    // 9001 にだけある案（履歴4）を 0000 の承認者が承認・否認・削除 → 404（自社にその版は無い）
    expect(await call(`${draftUrl(P, '000', h9001)}/approve`, { method: 'POST', body: {}, cookie: S('0000', 'approver') }), 404, 'NOT_FOUND');
    expect(await call(`${draftUrl(P, '000', h9001)}/reject`, { method: 'POST', body: { reason: '越境' }, cookie: S('0000', 'approver') }), 404, 'NOT_FOUND');
    expect(await call(draftUrl(P, '000', h9001), { method: 'DELETE', cookie: S('0000', 'registrar') }), 404, 'NOT_FOUND');
    // 会社コードを明示した越境 → 403
    expect(await call('/api/v1/projects?company_code=9001', { cookie: S('0000', 'viewer') }), 403, 'FORBIDDEN');
    expect(await call(`${budgetUrl(P, '000')}?company_code=9001`, { cookie: S('0000', 'viewer') }), 403, 'FORBIDDEN');
    expect(await call('/api/v1/revision-options?company_code=9001', { cookie: S('0000', 'viewer') }), 403, 'FORBIDDEN');
    expect(await call(`${draftUrl(P, '000', h9001)}/approve`, { method: 'POST', body: { company_code: '9001' }, cookie: S('0000', 'approver') }), 403, 'FORBIDDEN');
    expect(await call(draftsUrl(P, '001'), { method: 'POST', body: { company_code: '9001' }, cookie: S('0000', 'registrar') }), 403, 'FORBIDDEN');
    expect(await call('/api/v1/orders', { method: 'POST', cookie: S('0000', 'registrar'), body: { company_code: '9001', project_code: P, branch_code: '000', subcontractor_code: 'SUB-0001', work_type_code: '002000100010', order_date: '2026-08-01', work_start_date: '2026-08-01', work_end_date: '2026-09-01', order_amount_tax_ex: 1 } }), 403, 'FORBIDDEN');
    expect(await call('/api/v1/projects', { method: 'POST', cookie: S('0000', 'approver'), body: { company_code: '9001', project_code: 'PRJ-X2', project_name: 'x', project_short_name: 'x', main_branch: mainBranch() } }), 403, 'FORBIDDEN');
    expect(await call(draftUrl(P, '000', h9001), { method: 'DELETE', cookie: S('0000', 'registrar'), rawBody: '{"company_code":"9001"}' }), 403, 'FORBIDDEN');
    assert.equal(digest9001(), before9001, '9001 のデータは変わっていない');
    assert.equal(count("SELECT count(*) FROM revision_events WHERE company_code='0000';"), events0000, '拒否された操作は履歴に残らない');
    // 9001 自身の承認は 9001 にだけ反映され、0000 には影響しない
    expect(await call(`${draftUrl(P, '000', h9001)}/approve`, { method: 'POST', body: {}, cookie: S('9001', 'approver') }), 200);
    assert.equal((await cockpit('9001', P, '000')).latest_budget_history_no, 4);
    assert.deepEqual(await cockpit('0000', P, '000'), before0000);
    const own = expect(await call('/api/v1/projects', { cookie: S('9001', 'viewer') }), 200);
    assert.equal(own.company_code, '9001');
    assert.ok(own.projects.some(p => p.project_code === 'PRJ-9001-X'));
    assert.ok(!expect(await call('/api/v1/projects', { cookie: S('0000', 'viewer') }), 200).projects.some(p => p.project_code === 'PRJ-9001-X'));
  });

  await check('revision-events-record-who-when-what-and-reasons-append-only', async () => {
    const rows = db(`SELECT target_type||'|'||action||'|'||coalesce(order_number, project_code||'-'||branch_code, project_code)||'|'||coalesce(history_no::text,'')||'|'||actor_user_id||'|'||actor_role||'|'||coalesce(reason,'')
      FROM revision_events WHERE company_code='0000' ORDER BY event_no;`).split('\n');
    const has = s => assert.ok(rows.includes(s), `操作履歴に ${s} がありません:\n${rows.join('\n')}`);
    has(`budget|create|${P}-000|1|revtest-registrar|registrar|`);
    has(`budget|update|${P}-000|1|revtest-registrar|registrar|`);
    has(`budget|approve|${P}-000|1|revtest-approver|approver|受入検証で承認`);
    has(`budget|reject|${P}-000|2|revtest-approver|approver|数量根拠の資料が不足`);
    has(`budget|delete|${P}-000|3|revtest-registrar|registrar|`);
    has('order|approve|ORD-2026-001|1|revtest-approver|approver|追加数量の反映');
    has('order|reject|ORD-2026-002|1|revtest-approver|approver|工期の根拠が未添付');
    has('order|create|ORD-2026-003|0|revtest-registrar|registrar|');
    has('order|delete|QA-RV-001|0|revtest-registrar|registrar|');
    has('project|create|PRJ-RV-01||revtest-approver|approver|');
    has('branch|create|PRJ-RV-01-001||revtest-approver|approver|');
    // 金額の前後と時刻が記録される
    assert.equal(db(`SELECT amount_before||','||amount_after FROM revision_events WHERE company_code='0000' AND target_type='budget' AND action='approve' AND history_no=1;`), `38000000,${expected.budgetH1}`);
    assert.equal(count("SELECT count(*) FROM revision_events WHERE company_code='0000' AND (occurred_at IS NULL OR occurred_at > now());"), 0);
    // 会社ごとの連番（既存最大+1）に欠番・重複がない
    assert.equal(db("SELECT count(*)||','||max(event_no)||','||count(DISTINCT event_no) FROM revision_events WHERE company_code='0000';"), `${rows.length},${rows.length},${rows.length}`);
    // 画面用の取得APIにも理由付きで出る
    const b = await getBudget('0000', P, '000');
    assert.ok(b.events.some(e => e.action === 'reject' && e.reason === '数量根拠の資料が不足' && e.actor_user_id === 'revtest-approver'));
    // 追記専用（DB が UPDATE・DELETE を拒否）
    dbRejects("UPDATE revision_events SET reason='改ざん' WHERE company_code='0000' AND event_no=1;", 'REVISION_EVENT_IMMUTABLE');
    dbRejects("DELETE FROM revision_events WHERE company_code='0000' AND event_no=1;", 'REVISION_EVENT_IMMUTABLE');
    // 否認理由なしの否認は DB の CHECK でも拒否
    dbRejects("INSERT INTO revision_events (company_code, event_no, actor_user_id, actor_role, target_type, action, order_number, history_no) VALUES ('0000', 999999, 'x', 'approver', 'order', 'reject', 'X', 0);", 'chk_revision_events_reject_reason');
  });

  await check('completed-branch-blocks-revisions-422', async () => {
    db(`INSERT INTO project_branches SELECT (jsonb_populate_record(NULL::project_branches,to_jsonb(b)||jsonb_build_object('branch_code','993','branch_name','計上済（受入検証）','completion_status','3'))).* FROM project_branches b WHERE company_code='0000' AND project_code='${P}' AND branch_code='000';`);
    expect(await call(draftsUrl(P, '993'), { method: 'POST', body: {}, cookie: S('0000', 'approver') }), 422, 'UNPROCESSABLE_ENTITY');
    expect(await call('/api/v1/orders', { method: 'POST', cookie: S('0000', 'approver'), body: { project_code: P, branch_code: '993', subcontractor_code: 'SUB-0001', work_type_code: '002000100010', order_date: '2026-08-01', work_start_date: '2026-08-01', work_end_date: '2026-09-01', order_amount_tax_ex: 1 } }), 422, 'UNPROCESSABLE_ENTITY');
    assert.equal(count(`SELECT count(*) FROM execution_budgets WHERE company_code='0000' AND branch_code='993';`), 0);
  });

  await check('static-bundle-contains-revisions-tab', async () => {
    const html = await (await fetch(base + '/')).text();
    const src = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
    assert.ok(src, 'バンドルの script がありません');
    const js = await (await fetch(new URL(src, base))).text();
    for (const s of ['予算・発注', '/api/v1/projects', '/api/v1/revision-options', '/api/v1/orders', '否認理由', '改定案を作成']) assert.ok(js.includes(s), `バンドルに ${s} がありません`);
    assert.ok(!html.includes('.rev-row'), '旧来の予算・発注CSSが残っています');
  });

  // ---- 画面（375px）: 横スクロールが出ないこと、権限のないボタンは無効で理由が出ること ----
  if (process.env.SIRIUS_UI_CHECK === '1') {
    await check('ui-375px-no-horizontal-scroll-and-permission-reasons', async () => {
      const { chromium } = await import(process.env.SIRIUS_PLAYWRIGHT_MODULE || 'playwright-core');
      // Chromium は TLD「.app」を HSTS プリロードしているため、ホスト名 app では HTTPS を強制される。
      // 画面確認だけはコンテナの IP アドレスで接続する（同一の app コンテナ）。
      const { lookup } = await import('node:dns/promises');
      const u = new URL(base);
      u.hostname = (await lookup(u.hostname, { family: 4 })).address;
      const uiBase = u.origin;
      // 画面確認用に予算の改定案と発注の改定案を作っておく（承認待ちの表示を確認するため）
      expect(await call(draftsUrl(P, '000'), { method: 'POST', body: {}, cookie: S('0000', 'registrar') }), 201);
      expect(await call(orderDrafts('ORD-2026-003'), { method: 'POST', body: {}, cookie: S('0000', 'registrar') }), 201);
      const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const shots = [];
      const measured = [];
      try {
        mkdirSync('artifacts/browser', { recursive: true });
        for (const role of ['viewer', 'approver']) {
          const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
          const page = await ctx.newPage();
          const errors = [];
          page.on('pageerror', e => errors.push(String(e)));
          await page.goto(uiBase + '/', { waitUntil: 'networkidle' });
          await page.locator('#login-company').fill('0000');
          await page.locator('#login-user').fill(`revtest-${role}`);
          await page.locator('#login-password').fill(pw('0000', role));
          await page.locator('button[type=submit]').click();
          await page.getByRole('button', { name: /予算・発注/ }).click();
          await page.waitForFunction(() => document.body.innerText.includes('承認済み最新版'));
          await page.getByRole('heading', { name: '予算・発注', exact: true }).waitFor();
          assert.ok(await page.locator('.fui-Card').count() > 0, 'Fluent UI の Card がありません');
          const overflow = async label => {
            const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, w: window.innerWidth }));
            measured.push({ role, label, ...m });
            assert.ok(m.sw <= m.w && m.bw <= m.w, `${role}/${label}: 横スクロールあり（scrollWidth ${m.sw}/${m.bw} > ${m.w}）`);
          };
          await overflow('予算・発注タブ');
          await page.getByRole('button', { name: 'ダーク表示に切り替え', exact: true }).click();
          await overflow('予算・発注タブ（ダーク）');
          await page.getByRole('button', { name: 'ライト表示に切り替え', exact: true }).click();
          if (role === 'viewer') {
            const create = page.getByRole('button', { name: /明細を編集/ });
            assert.ok(await create.isDisabled(), '閲覧権限では編集ボタンが無効');
            assert.ok(await page.getByRole('button', { name: /予算案を承認/ }).isDisabled(), '閲覧権限では承認ボタンが無効');
            const text = await page.locator('body').innerText();
            assert.ok(text.includes('閲覧権限のため、案の作成・編集・削除はできません'));
            assert.ok(text.includes('承認・否認は承認権限の利用者のみ可能です'));
            assert.ok(text.includes('工事・枝番の登録は承認権限の利用者のみ可能です'));
          } else {
            await page.getByRole('button', { name: /明細を編集/ }).click();
            await page.waitForFunction(() => document.body.innerText.includes('明細を追加'));
            await page.getByRole('button', { name: /明細を追加/ }).click();
            await overflow('予算明細の編集');
            await page.getByRole('button', { name: '編集をやめる' }).click();
            const discard = page.getByRole('dialog');
            await discard.getByRole('button', { name: '破棄する', exact: true }).click();
            await discard.waitFor({ state: 'hidden' });
            await page.getByRole('button', { name: '否認…', exact: true }).first().click();
            await page.locator('#rev-budget-reason').waitFor({ state: 'visible' });
            await overflow('否認理由の入力');
            await page.getByRole('dialog').getByRole('button', { name: '戻る', exact: true }).click();
            await page.getByRole('button', { name: /新規発注案/ }).click();
            await overflow('新規発注案フォーム');
            await page.getByRole('button', { name: /工事を登録/ }).click();
            await overflow('工事の登録フォーム');
          }
          const path = `artifacts/browser/revisions-375-${role}.png`;
          await page.screenshot({ path, fullPage: true });
          shots.push(path);
          assert.deepEqual(errors, [], `${role}: 画面エラー`);
          await ctx.close();
        }
      } finally {
        await browser.close();
      }
      ui = { viewport: '375x812', measured, screenshots: shots, note: '日本語フォントは試験コンテナに入れていない（文字は代替表示）。幅の判定には影響しない' };
    });
  } else {
    ui = { skipped: true, reason: 'SIRIUS_UI_CHECK が 1 ではない' };
  }
} catch (e) {
  fatal = String(e && e.message || e);
  console.log('FATAL', fatal);
}

let migration = null;
try { migration = JSON.parse(process.env.SIRIUS_MIGRATION_RESULT || 'null'); } catch { migration = { passed: false, error: '読み取り失敗' }; }
const revisionMigration = migration?.revision_workflow_003 ?? null;
const uiRequired = process.env.SIRIUS_UI_CHECK === '1';
const passed = !fatal && results.length > 0 && results.every(r => r.passed) && revisionMigration?.passed === true && (!uiRequired || ui?.screenshots?.length === 2);
writeFileSync(outputPath, JSON.stringify({
  passed,
  checked_at: new Date().toISOString(),
  commit: process.env.SIRIUS_TEST_COMMIT || null,
  environment: {
    compose_project: process.env.SIRIUS_TEST_PROJECT || null,
    base,
    note: '専用 Compose プロジェクトで test_api.mjs・test_auth.mjs の後に実行。稼働中の progenba-app-1 / progenba-db-1 は使用していない',
  },
  users: '0000・9001 × revtest-viewer/registrar/approver（試験中だけ作成、パスワードは実行ごとに乱数生成し記録しない）',
  self_approval: '既定（REVISION_ALLOW_SELF_APPROVAL 未設定＝許可）で実行',
  summary: { total: results.length, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length },
  tests: results,
  expected_values: expected,
  // 既存DB（003 未適用）→ app 起動時に 003 適用 → 再起動でも冪等、の経路（test_auth.ps1 が実施）
  startup_migration_003: revisionMigration,
  ui_check: ui,
  fatal,
}, null, 2) + '\n');
console.log(passed ? '[REVISIONS ACCEPTANCE PASSED]' : '[REVISIONS ACCEPTANCE FAILED]');
process.exit(passed ? 0 : 1);
