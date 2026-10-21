import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { me, projects, project, lookups, revOptions, revProjects, revBudget, revOrders } from './ui-fixtures.mjs';

const base = process.env.SIRIUS_TEST_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
mkdirSync('/tmp/agent-browser', { recursive: true });
let passed = 0;
async function scenario(name, run, options = {}) {
  if (process.env.SIRIUS_UI_FILTER && !name.includes(process.env.SIRIUS_UI_FILTER)) return;
  const context = await browser.newContext({ viewport: { width: 1253, height: 817 } });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const state = { loggedIn: true, identity: structuredClone(me), failMe: false, role: 'approver', rows: structuredClone(projects), lookup: structuredClone(lookups), rev: structuredClone(revProjects), budgets: new Map(), orders: new Map(), revStatus: 200, revDelay: 0, abortRevision: false, failRevisionRead: false, failCockpit: false, failLookups: false, postStatus: 201, postDelay: 0, abortPost: false, calls: [], errors: [], ...options };
  page.on('pageerror', error => state.errors.push(String(error)));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    // パスワードは試験用の値であっても結果・失敗ログへ保持しない。
    state.calls.push({ path, method: request.method(), body: path.endsWith('/auth/login') ? { ...body, password: '[redacted]' } : body });
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.endsWith('/auth/me')) return state.failMe ? json(503, { message: '試験用の接続エラー' }) : json(state.loggedIn ? 200 : 401, state.loggedIn ? { ...state.identity, role: state.role } : {});
    if (path.endsWith('/auth/login')) { state.loggedIn = true; state.identity = { ...me, company_code: body.company_code, user_id: body.user_id }; return json(200, { ...state.identity, role: state.role }); }
    if (path.endsWith('/auth/logout')) { state.loggedIn = false; return json(200, {}); }
    if (path.endsWith('/cockpit')) return json(state.failCockpit ? 503 : 200, state.failCockpit ? { message: '試験用の取得エラー' } : state.rows);
    if (path.endsWith('/lookups')) return json(state.failLookups ? 503 : 200, state.failLookups ? { message: '試験用の辞書エラー' } : state.lookup);
    if (path.includes('/costs/')) {
      if (state.postDelay) await new Promise(resolve => setTimeout(resolve, state.postDelay));
      if (state.abortPost) return route.abort('failed');
      if (state.postStatus !== 201) return json(state.postStatus, { message: '試験用の登録エラー' });
      if (path.endsWith('/subcontract-progress')) {
        const order = state.lookup.subcontract_orders.find(item => item.order_number === request.postDataJSON().order_number);
        order.accum_assessed_amount_tax_ex += request.postDataJSON().curr_assessed_amount_tax_ex;
        order.remaining_order_balance -= request.postDataJSON().curr_assessed_amount_tax_ex;
      }
      return json(201, { document_no: '000000000123', warnings: state.rows[0]?.completion_status === '1' ? ['完成済み工事への登録です。'] : [] });
    }
    // 予算・発注（RevisionsView）
    if (path === '/api/v1/revision-options') return json(200, revOptions);
    if (path === '/api/v1/projects' && request.method() === 'GET') return json(200, state.rev);
    if (path === '/api/v1/projects' && request.method() === 'POST') {
      const body = request.postDataJSON(); state.rev.projects.push({ project_code: body.project_code, project_name: body.project_name, project_short_name: body.project_short_name, branches: [{ branch_code: '000', branch_name: body.main_branch.branch_name, completion_status: '0', contract_amount_tax_ex: body.main_branch.contract_amount_tax_ex, approved_budget_history_no: null, has_budget_draft: false, order_count: 0, order_draft_count: 0 }] });
      return json(201, { target_type: 'project', action: 'create', project_code: body.project_code, branch_code: '000', order_number: null, history_no: null, status: null, amount: null, event_no: 1 });
    }
    const branch = /^\/api\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/(budget|orders)(.*)$/.exec(path);
    if (branch && request.method() === 'GET' && branch[4] === '') {
      const key = `${branch[1]}::${branch[2]}`;
      const store = branch[3] === 'budget' ? state.budgets : state.orders;
      if (!store.has(key)) store.set(key, branch[3] === 'budget' ? revBudget(decodeURIComponent(branch[1]), branch[2]) : revOrders(decodeURIComponent(branch[1]), branch[2]));
      // 送信時点の応答を遅延させ、後の選択の応答を上書きしないことも検証できるようにする。
      const response = structuredClone(store.get(key));
      if (state.revDelay) await new Promise(resolve => setTimeout(resolve, state.revDelay));
      return state.failRevisionRead ? json(503, { message: '試験用の再取得エラー' }) : json(200, response);
    }
    if (branch || path.startsWith('/api/v1/orders')) {
      if (state.abortRevision) return route.abort('failed');
      if (state.revStatus !== 200) return json(state.revStatus, { code: 'ERR', message: `試験用の予算エラー${state.revStatus}` });
      if (branch?.[3] === 'budget') {
        const key = `${branch[1]}::${branch[2]}`;
        const budget = state.budgets.get(key);
        if (budget?.draft && /\/(approve|reject)$/.test(branch[4])) {
          budget.draft.status = branch[4].endsWith('/approve') ? '1' : '9';
          if (budget.draft.status === '1') budget.approved = structuredClone(budget.draft);
          const version = budget.versions.find(v => v.history_no === budget.draft.history_no);
          if (version) version.status = budget.draft.status;
          budget.draft = null; budget.diff = null;
        } else if (budget?.draft && request.method() === 'PUT') {
          budget.draft.target_gross_profit_rate = body.target_gross_profit_rate;
          budget.draft.notes = body.notes;
        } else if (budget && request.method() === 'DELETE') {
          budget.draft = null; budget.diff = null;
        }
      }
      if (request.method() === 'DELETE') return route.fulfill({ status: 204, body: '' });
      return json(200, { target_type: 'budget', action: 'approve', project_code: 'P001', branch_code: '000', order_number: null, history_no: 3, status: '1', amount: 2000000, event_no: 2 });
    }
    return json(404, {});
  });
  try {
    await page.goto(base);
    if (state.failMe) await page.getByText('サーバーに接続できません', { exact: false }).waitFor();
    else if (state.loggedIn && state.failCockpit) await page.getByText('工事の状況を取得できませんでした', { exact: false }).waitFor();
    else if (state.loggedIn && state.rows.length === 0) await page.getByText('登録されている工事がありません', { exact: false }).first().waitFor();
    else await page.getByRole('heading', { name: state.loggedIn ? '工事の状況' : 'ログイン', exact: true }).waitFor();
    await run(page, state);
    assert.deepEqual(state.errors, [], 'ブラウザ実行エラー');
    console.log('PASS', name); passed++;
  } catch (error) {
    console.error('FAIL', name); await page.screenshot({ path: '/tmp/agent-browser/ui-regression-failure.png', fullPage: true });
    console.error('Accessibility state:', JSON.stringify(await page.evaluate(() => ({
      headings: [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].map(el => ({ tag: el.tagName, text: el.textContent, blockedAncestors: [...function* () { for (let parent = el; parent; parent = parent.parentElement) if (parent.hasAttribute('aria-hidden') || parent.hasAttribute('inert') || parent.hasAttribute('hidden')) yield { tag: parent.tagName, id: parent.id, className: parent.className, tabster: parent.getAttribute('data-tabster'), hidden: parent.getAttribute('hidden'), ariaHidden: parent.getAttribute('aria-hidden'), inert: parent.getAttribute('inert') }; }()] })),
    }))));
    console.error((await page.locator('body').innerText()).slice(-6500)); throw error;
  } finally { await context.close(); }
}
const input = page => page.getByRole('button', { name: /^原価を登録/ }).first().click();
const mode = (page, name) => page.getByRole('tab', { name: new RegExp(name) }).click();
const register = page => page.getByRole('button', { name: 'この内容で登録', exact: true });
const postCalls = state => state.calls.filter(call => call.path.includes('/costs/'));
const hasText = async (page, text) => assert.ok((await page.locator('body').innerText()).includes(text), `表示なし: ${text}`);
// 登録は確認ダイアログ（登録先・内容・金額）で確定してから送信する
const confirmRegister = async page => { await register(page).click(); await page.getByRole('dialog').waitFor(); await page.getByRole('button', { name: '登録する', exact: true }).click(); };
const submit = async page => { await confirmRegister(page); await page.getByTestId('registration-success').waitFor(); await register(page).waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.querySelector('form[aria-busy="true"]')); };
const rev = page => page.locator('section[aria-label="予算・発注"]');
const revisions = async page => { await page.getByRole('button', { name: /^予算・発注/ }).click(); await rev(page).getByText('承認済み最新版').first().waitFor(); };
const dialogText = page => page.getByRole('dialog').innerText();
const noOverflow = async page => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'ページ全体の横はみ出し');
const relogin = async (page, company = me.company_code, user = me.user_id) => {
  await page.locator('#login-company').fill(company); await page.locator('#login-user').fill(user); await page.locator('#login-password').fill('test-only');
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
};
const saveBudget = async page => {
  await rev(page).getByRole('button', { name: '案を保存', exact: true }).click();
  await page.getByRole('dialog').waitFor(); await page.getByRole('button', { name: '保存する', exact: true }).click();
};
const costCases = [
  ['外注の出来高', '#subcontract-progress-input', '30'],
  ['材料・経費', '#direct-quantity-input', '4'],
  ['作業日報', '#daily-work-hours-input', '6'],
  ['資機材の使用', '#equip-quantity-input', '2'],
];
try {
  await scenario('login-validation-autocomplete-keyboard-and-real-auth-contract', async (page, state) => {
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();
    await hasText(page, '4文字の英数字を入力'); assert.equal(await page.locator('#login-company').evaluate(el => el === document.activeElement), true);
    await page.locator('#login-company').fill('A001'); await page.locator('#login-user').fill('user01'); await page.locator('#login-password').fill('test-password-only');
    assert.equal(await page.locator('#login-user').getAttribute('autocomplete'), 'username');
    await page.locator('#login-password').press('Enter'); await page.getByRole('heading', { name: '工事の状況', exact: true }).waitFor();
    assert.deepEqual(state.calls.find(call => call.path.endsWith('/auth/login')).body, { company_code: 'A001', user_id: 'user01', password: '[redacted]' });
  }, { loggedIn: false });
  await scenario('cockpit-whole-project-amounts-and-detail-table', async page => {
    await page.getByRole('tab', { name: /工事全体/ }).click();
    assert.equal(await page.getByTestId('actual-cost').innerText(), '¥13,000,000');
    assert.equal(await page.getByTestId('remaining-budget').innerText(), '¥29,000,000');
    await page.getByRole('button', { name: /工種別の明細/ }).click(); await page.getByRole('table', { name: '工種別明細' }).waitFor();
    await hasText(page, '55,000,000');
  });
  await scenario('shared-branch-and-whole-project-requires-explicit-registration-target', async page => {
    await page.getByRole('tab', { name: /追加工事/ }).click(); await input(page);
    assert.equal(await page.locator('#easy-branch-select').inputValue(), 'P001::001');
    await page.getByRole('button', { name: '工事の状況', exact: true }).click(); await page.getByRole('tab', { name: /工事全体/ }).click(); await input(page);
    assert.equal(await page.locator('#easy-branch-select').inputValue(), ''); assert.equal(await register(page).isDisabled(), true); await hasText(page, '工事全体の合計は登録先にできません');
  });
  await scenario('four-mode-drafts-survive-navigation-and-background-refresh', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('3.125');
    await mode(page, '作業日報'); await page.locator('#daily-work-hours-input').fill('6');
    await mode(page, '材料・経費'); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '3.125');
    await page.getByRole('button', { name: '工事の状況', exact: true }).click(); await page.getByRole('button', { name: '更新', exact: true }).click(); await hasTextAfter(page, '最新の状態に更新しました');
    await input(page); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '3.125');
    assert.equal(state.calls.filter(call => call.path.endsWith('/lookups')).length, 2, '辞書の二重取得なし');
    await mode(page, '作業日報'); assert.equal(await page.locator('#daily-work-hours-input').inputValue(), '6');
  });
  await scenario('dirty-context-change-cancel-and-confirm', async page => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('7');
    await page.locator('#easy-branch-select').focus(); await page.locator('#easy-branch-select').selectOption('P001::001'); await page.getByRole('dialog').waitFor(); await page.getByRole('button', { name: '戻る', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'easy-branch-select');
    assert.equal(await page.locator('#easy-branch-select').inputValue(), 'P001::000'); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '7');
    await page.locator('#easy-branch-select').selectOption('P001::001'); await page.getByRole('button', { name: '破棄して変更', exact: true }).click();
    assert.equal(await page.locator('#easy-branch-select').inputValue(), 'P001::001'); await mode(page, '材料・経費'); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '1');
  });
  await scenario('subcontract-cumulative-preview-tax-deductions-and-api-format', async (page, state) => {
    await input(page); await page.locator('#subcontract-progress-input').fill('50'); await page.locator('#subcontract-ym-input').fill('2026-10');
    await page.getByRole('button', { name: '控除・税額の詳細' }).click(); await page.locator('#subcontract-fixed-deduction').fill('5000');
    assert.equal(await page.locator('#subcontract-curr-amount').inputValue(), '3000000'); await hasText(page, '3,136,000');
    await submit(page); assert.deepEqual(postCalls(state)[0].body, { company_code: '0000', order_number: '000000000001', order_history_no: 2, assessment_year_month: '202610', curr_assessed_amount_tax_ex: 3000000, fixed_deductions: 5000, chargeback_offset: 0 });
    assert.equal(await page.locator('#subcontract-progress-input').inputValue(), '50');
  });
  await scenario('subcontract-order-change-does-not-silently-discard-input', async page => {
    await input(page); await page.locator('#subcontract-curr-amount').fill('1000'); await page.locator('#subcontract-order-select').selectOption('000000000002');
    await page.getByRole('dialog').waitFor(); await page.getByRole('button', { name: '戻る', exact: true }).click(); assert.equal(await page.locator('#subcontract-curr-amount').inputValue(), '1000');
    await page.locator('#subcontract-order-select').selectOption('000000000002'); await page.getByRole('button', { name: '変更する', exact: true }).click(); assert.equal(await page.locator('#subcontract-curr-amount').inputValue(), '0');
  });
  await scenario('material-round-half-up-decimal-json-and-double-click-once', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('1.005'); await page.locator('#direct-unit-price-input').fill('100.5');
    assert.equal(await page.getByTestId('cost-preview').innerText(), '¥101');
    await register(page).click(); await page.getByRole('dialog').waitFor(); await page.getByRole('button', { name: '登録する', exact: true }).click({ clickCount: 2 }); await page.getByTestId('registration-success').waitFor(); assert.equal(postCalls(state).length, 1);
    const body = postCalls(state)[0].body; assert.equal(body.quantity, '1.005'); assert.equal(body.unit_price, '100.500'); assert.equal(body.cost_element_code, '0100'); assert.equal(body.company_code, '0000');
  }, { postDelay: 350 });
  await scenario('expense-template-confirmation-and-optional-inputs', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('100'); await page.getByRole('button', { name: '産廃処分', exact: true }).click();
    await page.getByRole('dialog').waitFor(); await page.getByRole('button', { name: '変更する', exact: true }).click(); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '1');
    await page.getByRole('button', { name: '詳細・任意項目' }).click(); await page.locator('#direct-notes-input').fill('現場メモ'); await page.locator('#direct-vendor-select').selectOption('V001');
    await submit(page); assert.equal(postCalls(state)[0].body.cost_element_code, '0400'); assert.equal(postCalls(state)[0].body.notes, '現場メモ');
    assert.equal(await page.locator('#direct-quantity-input').inputValue(), '1', '登録成功後は数量を1に戻す');
  });
  await scenario('daily-report-standard-wage-preview-and-json', async (page, state) => {
    await input(page); await mode(page, '作業日報'); await page.getByRole('button', { name: /4.0時間/ }).click(); assert.equal(await page.getByTestId('cost-preview').innerText(), '¥11,000');
    await submit(page); assert.equal(postCalls(state)[0].body.work_hours, '4.000'); assert.equal(postCalls(state)[0].body.employee_code, 'E001');
  });
  await scenario('equipment-rent-freight-maintenance-preview-and-json', async (page, state) => {
    await input(page); await mode(page, '資機材の使用'); await page.locator('#equip-quantity-input').fill('2'); await page.locator('#equip-usage-days-input').fill('3');
    await page.getByRole('button', { name: '運賃・整備費（任意）' }).click(); await page.locator('#equip-freight-input').fill('1000'); await page.locator('#equip-maintenance-input').fill('200');
    assert.equal(await page.getByTestId('cost-preview').innerText(), '¥1,920'); await submit(page);
    const body = postCalls(state)[0].body; assert.equal(body.quantity, '2.000'); assert.equal(body.usage_days, 3); assert.equal(body.freight_fee, 1000); assert.equal(body.maintenance_fee, 200); assert.equal(body.dest_branch_code, '000');
  });
  await scenario('errors-on-interaction-and-first-invalid-focus', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); assert.equal(await page.locator('input[aria-invalid=true]').count(), 0);
    await page.locator('#direct-quantity-input').fill('1.0001'); await register(page).click();
    assert.equal(await page.locator('#direct-quantity-input').evaluate(el => el === document.activeElement), true); await hasText(page, '小数第3位'); assert.equal(postCalls(state).length, 0);
    await page.locator('#direct-quantity-input').fill('-1'); await register(page).click(); assert.equal(postCalls(state).length, 0);
  });
  await scenario('api-error-preserves-input-and-manual-retry', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('4'); await confirmRegister(page);
    await hasTextAfter(page, '試験用の登録エラー'); await hasText(page, '入力内容を確認してください（登録できませんでした）'); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '4');
    state.postStatus = 201; await submit(page); assert.equal(postCalls(state).length, 2);
  }, { postStatus: 422 });
  await scenario('unknown-post-result-is-not-automatically-retried', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('4'); await confirmRegister(page); await hasTextAfter(page, '通信結果を確認できません');
    assert.equal(await page.locator('#direct-quantity-input').inputValue(), '4'); assert.equal(postCalls(state).length, 1);
  }, { abortPost: true });
  await scenario('success-is-not-registration-failure-when-refresh-fails', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); state.failCockpit = true; state.failLookups = true; await submit(page);
    await hasTextAfter(page, '登録は完了していますが'); await hasText(page, '再登録は不要'); await hasText(page, '000000000123'); assert.equal(postCalls(state).length, 1);
  });
  await scenario('background-fetch-failure-keeps-existing-data-and-draft', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('5'); state.failCockpit = true;
    await page.getByRole('button', { name: '更新', exact: true }).click(); await hasTextAfter(page, '更新できないデータがあります'); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '5');
    await page.getByRole('button', { name: '工事の状況', exact: true }).click(); assert.equal(await page.getByTestId('actual-cost').innerText(), '¥12,000,000');
  });
  await scenario('viewer-cannot-open-registration', async page => { assert.equal(await page.getByRole('button', { name: /^原価を登録/ }).first().isDisabled(), true); await hasText(page, '閲覧権限で利用'); }, { role: 'viewer' });
  await scenario('registrar-cannot-register-completed-or-locked-branches', async page => {
    await input(page); for (const key of ['000', '002', '003']) assert.equal(await page.locator(`#easy-branch-select option[value="P001::${key}"]`).isDisabled(), true);
    assert.equal(await register(page).isDisabled(), true); await page.locator('#easy-branch-select').selectOption('P001::001'); assert.equal(await register(page).isDisabled(), false);
  }, { role: 'registrar', rows: [{ ...project, completion_status: '1' }, projects[1], { ...project, key: { ...project.key, branch_code: '002' }, completion_status: '2' }, { ...project, key: { ...project.key, branch_code: '003' }, completion_status: '3' }] });
  await scenario('approver-completed-registration-needs-confirmation', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await register(page).click(); await page.getByRole('dialog').waitFor(); assert.equal(postCalls(state).length, 0);
    await page.getByRole('button', { name: '確認して登録', exact: true }).click(); await page.getByTestId('registration-success').waitFor(); await hasText(page, '完成済み工事への登録');
  }, { rows: [{ ...project, completion_status: '1' }] });
  await scenario('logout-confirmation-discards-drafts-and-session-cache', async page => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('9'); await page.getByRole('button', { name: 'ログアウト', exact: true }).click(); await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: '戻る', exact: true }).click(); await page.waitForFunction(() => document.activeElement?.textContent === 'ログアウト'); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '9');
    await page.getByRole('button', { name: 'ログアウト', exact: true }).click(); await page.getByRole('button', { name: '破棄してログアウト', exact: true }).click(); await page.getByRole('heading', { name: 'ログイン', exact: true }).waitFor();
    await page.locator('#login-company').fill('0000'); await page.locator('#login-user').fill('another'); await page.locator('#login-password').fill('test-only'); await page.getByRole('button', { name: 'ログイン', exact: true }).click();
    await page.getByRole('heading', { name: '工事の状況', exact: true }).waitFor(); await input(page); await mode(page, '材料・経費'); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '1');
  });
  await scenario('session-expiry-preserves-drafts-until-same-user-relogin', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('9');
    await revisions(page); await rev(page).getByRole('button', { name: '明細を編集' }).click(); await page.locator('#rev-rate').fill('31.25');
    state.postStatus = 401; await input(page); await confirmRegister(page);
    await page.getByRole('heading', { name: 'ログイン', exact: true }).waitFor(); await hasText(page, '入力');
    assert.equal(await register(page).isVisible(), false, 'セッション切れ中は業務操作を隠す');
    await relogin(page); await page.getByRole('heading', { name: 'ログイン', exact: true }).waitFor({ state: 'hidden' });
    await input(page); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '9');
    await page.getByRole('button', { name: /^予算・発注/ }).click(); assert.equal(await page.locator('#rev-rate').inputValue(), '31.25');
    assert.equal(postCalls(state).length, 1, '再ログインだけで失敗した登録を再送しない');
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.deepEqual(Object.keys(storage.local).filter(key => key !== 'progenba-theme'), []); assert.deepEqual(storage.session, {}, '入力はメモリ内だけに保持');
  });
  await scenario('different-user-relogin-requires-discard-and-cancel-preserves-draft', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('9'); state.postStatus = 401; await confirmRegister(page);
    await page.getByRole('heading', { name: 'ログイン', exact: true }).waitFor(); await relogin(page, '0000', 'another');
    await page.getByRole('dialog').waitFor(); assert.ok((await dialogText(page)).includes('破棄'));
    await page.getByRole('button', { name: '戻る', exact: true }).click(); await page.getByRole('heading', { name: 'ログイン', exact: true }).waitFor();
    await relogin(page); await input(page); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '9');
    await confirmRegister(page); await page.getByRole('heading', { name: 'ログイン', exact: true }).waitFor(); await relogin(page, '0000', 'another');
    await page.getByRole('dialog').waitFor(); await page.getByRole('dialog').getByRole('button', { name: /破棄/ }).click();
    await input(page); await mode(page, '材料・経費'); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '1', '別利用者に入力を引き継がない');
    assert.ok(state.calls.filter(call => call.path.endsWith('/lookups')).length >= 2, '別利用者では辞書キャッシュも取り直す');
  });
  await scenario('session-reconnect-401-preserves-drafts-through-relogin', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('9');
    // SWRの既定の2秒の重複取得抑止を過ぎてから実際の再接続イベントを発火する。
    await new Promise(resolve => setTimeout(resolve, 2100)); state.loggedIn = false;
    const checked = page.waitForResponse(response => response.url().endsWith('/auth/me') && response.status() === 401);
    await page.context().setOffline(true); await page.context().setOffline(false); await checked;
    await page.getByRole('heading', { name: 'ログイン', exact: true }).waitFor(); await relogin(page); await input(page); await mode(page, '材料・経費');
    assert.equal(await page.locator('#direct-quantity-input').inputValue(), '9', '再接続時のセッション確認でも入力を破棄しない');
    assert.equal(postCalls(state).length, 0);
  });
  await scenario('beforeunload-warning-only-with-draft', async page => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('2');
    let seen = false; page.once('dialog', async dialog => { seen = dialog.type() === 'beforeunload'; await dialog.dismiss(); }); await page.reload().catch(() => {}); assert.equal(seen, true);
    assert.equal(await page.locator('#direct-quantity-input').inputValue(), '2');
  });
  await scenario('initial-cockpit-fetch-error-and-recovery', async (page, state) => {
    state.failCockpit = false; await page.getByRole('button', { name: '再試行', exact: true }).click();
    await page.getByRole('heading', { name: '工事の状況', exact: true }).waitFor();
  }, { failCockpit: true });
  await scenario('initial-lookups-fetch-error-and-recovery', async (page, state) => {
    await input(page); await hasText(page, '試験用の辞書エラー'); state.failLookups = false;
    await page.getByRole('button', { name: '再取得', exact: true }).click(); await page.locator('#subcontract-progress-input').waitFor();
  }, { failLookups: true });
  await scenario('empty-project-list', async page => { await hasText(page, '登録されている工事がありません'); }, { rows: [] });
  await scenario('empty-master-selections-prohibit-invalid-post', async (page, state) => {
    await input(page); await mode(page, '作業日報'); await register(page).click(); await hasTextAfter(page, '作業員を選択'); assert.equal(postCalls(state).length, 0);
  }, { lookup: { quick_templates: [], subcontract_orders: [], employees: [], suppliers: [], equipments: [], work_types: [] } });
  await scenario('aggregate-safe-integer-limit-and-recovery', async page => {
    await page.getByRole('tab', { name: /工事全体/ }).click(); await hasTextAfter(page, '安全整数上限'); await page.getByRole('button', { name: '本工事を表示' }).click(); assert.equal(await page.getByTestId('actual-cost').innerText(), '¥12,000,000');
  }, { rows: Array.from({ length: 10 }, (_, index) => ({ ...project, key: { ...project.key, branch_code: String(index).padStart(3, '0') }, contract_amount_tax_ex: 999999999999999 })) });
  await scenario('light-dark-mobile-tablet-desktop-and-200-percent-layout', async page => {
    await page.screenshot({ path: '/tmp/agent-browser/progenba-cockpit-light.png', fullPage: true });
    await page.getByRole('button', { name: 'ダーク表示に切り替え' }).click(); await page.screenshot({ path: '/tmp/agent-browser/progenba-cockpit-dark.png', fullPage: true });
    await noOverflow(page);
    for (const width of [375, 768]) { await page.setViewportSize({ width, height: 812 }); await noOverflow(page); await input(page); for (const label of ['外注の出来高', '材料・経費', '作業日報', '資機材の使用']) { await mode(page, label); await noOverflow(page); } await page.screenshot({ path: `/tmp/agent-browser/progenba-input-${width}.png`, fullPage: true }); await page.getByRole('button', { name: '工事の状況', exact: true }).click(); }
    // 予算・発注（ダーク表示・375px）: 編集・否認・新規発注・工事登録の各フォームを開いても横にはみ出さない
    await page.setViewportSize({ width: 375, height: 812 }); await revisions(page); await noOverflow(page);
    await rev(page).getByRole('button', { name: '明細を編集' }).click(); await rev(page).getByRole('button', { name: '明細を追加' }).click(); await noOverflow(page);
    await page.screenshot({ path: '/tmp/agent-browser/progenba-revisions-375-dark.png', fullPage: true });
    await rev(page).getByRole('button', { name: '編集をやめる' }).click(); await page.getByRole('button', { name: '破棄する', exact: true }).click();
    await rev(page).getByRole('button', { name: '否認…' }).click(); await noOverflow(page); await page.getByRole('button', { name: '戻る', exact: true }).click();
    await rev(page).getByRole('button', { name: '新規発注案', exact: true }).click(); await noOverflow(page); await rev(page).getByRole('button', { name: 'やめる', exact: true }).click();
    await rev(page).getByRole('button', { name: '工事を登録', exact: true }).click(); await noOverflow(page); await rev(page).getByRole('button', { name: 'やめる', exact: true }).click();
    await page.getByRole('button', { name: '工事の状況', exact: true }).click();
    await page.setViewportSize({ width: 1253, height: 817 }); await page.evaluate(() => { document.documentElement.style.zoom = '2'; }); await noOverflow(page); await input(page); await noOverflow(page); await page.screenshot({ path: '/tmp/agent-browser/progenba-zoom-200.png', fullPage: true });
  });
  // ---- PR #11 の目的（選択の共有・入力保持・破棄の確認・エラー案内・確認ダイアログ）と予算・発注 ----
  await scenario('login-screen-has-no-sample-entry', async page => {
    const text = await page.locator('body').innerText(); assert.ok(!text.includes('サンプル') && !text.includes('ログイン不要'), '架空データへの導線がない');
  }, { loggedIn: false });
  await scenario('server-unreachable-shows-retry-only-no-sample-data', async (page, state) => {
    const text = await page.locator('body').innerText(); assert.ok(!text.includes('サンプル') && !text.includes('ログイン不要'), '架空データへの導線がない');
    assert.equal(await page.getByRole('button').count(), 1, '再試行ボタンだけを表示');
    assert.ok(!state.calls.some(call => call.path.endsWith('/cockpit')), 'ログイン前に業務データを取得しない');
    state.failMe = false; await page.getByRole('button', { name: '再試行', exact: true }).click(); await page.getByRole('heading', { name: '工事の状況', exact: true }).waitFor();
  }, { failMe: true });
  await scenario('selection-is-shared-across-cockpit-input-and-revisions', async (page, state) => {
    await page.getByRole('tab', { name: /追加工事/ }).click(); await revisions(page);
    assert.equal(await rev(page).getByRole('tab', { name: /追加工事 001/ }).getAttribute('aria-selected'), 'true');
    await rev(page).getByRole('button', { name: /改定案を作成/ }).waitFor();
    assert.ok(state.calls.some(call => call.path === '/api/v1/projects/P001/branches/001/budget'), '予算・発注は共有の選択（追加工事001）を読む');
    await rev(page).getByRole('tab', { name: /本工事/ }).click(); await rev(page).getByRole('button', { name: '明細を編集' }).waitFor();
    await input(page); assert.equal(await page.locator('#easy-branch-select').inputValue(), 'P001::000');
    await page.locator('#easy-branch-select').selectOption('P001::001');
    await page.getByRole('button', { name: '工事の状況', exact: true }).click();
    assert.equal(await page.locator('section[aria-label="工事の状況"]').getByRole('tab', { name: /追加工事/ }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: /^予算・発注/ }).click(); assert.equal(await rev(page).getByRole('tab', { name: /追加工事 001/ }).getAttribute('aria-selected'), 'true');
  });
  await scenario('drafts-survive-tab-and-mode-switches-including-revisions', async page => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('3.125');
    await mode(page, '作業日報'); await page.locator('#daily-work-hours-input').fill('6');
    await revisions(page); await rev(page).getByRole('button', { name: '明細を編集' }).click(); await page.locator('#rev-rate').fill('30.00');
    await page.getByRole('button', { name: /^予算・発注/ }).getByText('編集中').waitFor();
    await input(page); assert.equal(await page.locator('#daily-work-hours-input').inputValue(), '6');
    await mode(page, '材料・経費'); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '3.125');
    await page.getByRole('button', { name: '工事の状況', exact: true }).click();
    await page.getByRole('button', { name: /^予算・発注/ }).click(); assert.equal(await page.locator('#rev-rate').inputValue(), '30.00');
  });
  await scenario('all-four-drafts-and-budget-edit-survive-delayed-manual-refresh', async (page, state) => {
    await input(page);
    for (const [label, selector, value] of costCases) { await mode(page, label); await page.locator(selector).fill(value); }
    await revisions(page); await rev(page).getByRole('button', { name: '明細を編集' }).click(); await page.locator('#rev-rate').fill('31.25');
    state.revDelay = 500;
    const refreshed = page.waitForResponse(response => response.url().includes('/branches/000/budget') && response.request().method() === 'GET');
    await page.getByRole('button', { name: '更新', exact: true }).click();
    assert.equal(await page.locator('#rev-rate').isVisible(), true, '取得中にも編集部品を外さない');
    await page.locator('#rev-rate').fill('32.50'); await refreshed;
    await hasTextAfter(page, '最新の状態に更新しました'); assert.equal(await page.locator('#rev-rate').inputValue(), '32.50');
    await input(page);
    for (const [label, selector, value] of costCases) { await mode(page, label); assert.equal(await page.locator(selector).inputValue(), value); }
  });
  await scenario('initial-selection-stays-fixed-when-refreshed-projects-reorder', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('9');
    assert.equal(await page.locator('#easy-branch-select').inputValue(), 'P001::000'); state.rows.reverse();
    await page.getByRole('button', { name: '更新', exact: true }).click(); await hasTextAfter(page, '最新の状態に更新しました');
    assert.equal(await page.locator('#easy-branch-select').inputValue(), 'P001::000', '一覧の並び順が変わっても登録先を変更しない');
    assert.equal(await page.locator('#direct-quantity-input').inputValue(), '9');
  });
  await scenario('late-branch-response-cannot-replace-current-branch', async (page, state) => {
    await revisions(page); state.revDelay = 500;
    const started = page.waitForRequest(request => request.url().includes('/branches/001/budget'));
    const late = page.waitForResponse(response => response.url().includes('/branches/001/budget'));
    await rev(page).getByRole('tab', { name: /追加工事 001/ }).click();
    await started;
    state.revDelay = 0; await rev(page).getByRole('tab', { name: /本工事/ }).click();
    await late; await rev(page).getByRole('button', { name: '明細を編集' }).waitFor();
    assert.equal(await rev(page).getByRole('tab', { name: /本工事/ }).getAttribute('aria-selected'), 'true');
    await rev(page).getByRole('button', { name: '明細を編集' }).click(); assert.equal(await page.locator('#rev-rate').inputValue(), '20.00');
  });
  await scenario('discard-confirmation-before-selection-change-cancel-and-logout', async page => {
    await revisions(page); await rev(page).getByRole('button', { name: '明細を編集' }).click(); await page.locator('#rev-rate').fill('30');
    await rev(page).getByRole('tab', { name: /追加工事 001/ }).click(); await page.getByRole('dialog').waitFor(); assert.ok((await dialogText(page)).includes('予算・発注の編集'));
    await page.getByRole('button', { name: '戻る', exact: true }).click(); assert.equal(await page.locator('#rev-rate').inputValue(), '30');
    assert.equal(await rev(page).getByRole('tab', { name: /本工事/ }).getAttribute('aria-selected'), 'true');
    await rev(page).getByRole('tab', { name: /追加工事 001/ }).click(); await page.getByRole('button', { name: '破棄して変更', exact: true }).click();
    await rev(page).getByRole('button', { name: /改定案を作成/ }).waitFor(); assert.equal(await page.locator('#rev-rate').count(), 0);
    await page.getByRole('button', { name: '工事の状況', exact: true }).click();
    assert.equal(await page.locator('section[aria-label="工事の状況"]').getByRole('tab', { name: /追加工事/ }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: /^予算・発注/ }).click(); await rev(page).getByRole('tab', { name: /本工事/ }).click();
    await rev(page).getByRole('button', { name: '明細を編集' }).click(); await page.locator('#rev-rate').fill('31');
    await rev(page).getByRole('button', { name: '編集をやめる' }).click(); await page.getByRole('dialog').waitFor(); assert.ok((await dialogText(page)).includes('編集中の内容を破棄しますか'));
    await page.getByRole('button', { name: '破棄する', exact: true }).click(); assert.equal(await page.locator('#rev-rate').count(), 0);
    await rev(page).getByRole('button', { name: '明細を編集' }).click(); await page.locator('#rev-rate').fill('32');
    await page.getByRole('button', { name: 'ログアウト', exact: true }).click(); await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: '破棄してログアウト', exact: true }).click(); await page.getByRole('heading', { name: 'ログイン', exact: true }).waitFor();
  });
  await scenario('error-guidance-per-status-keeps-input', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('4');
    for (const [status, title] of [[403, '権限がないため、登録できませんでした'], [409, '他の操作と重なったため、登録できませんでした'], [422, '入力内容を確認してください（登録できませんでした）'], [503, 'サーバーでエラーが発生し、登録できませんでした（HTTP 503）']]) {
      state.postStatus = status; await confirmRegister(page); await hasTextAfter(page, title); await hasText(page, '入力内容は保持しています');
      assert.equal(await page.locator('#direct-quantity-input').inputValue(), '4', `HTTP ${status} でも入力を保持`);
    }
    await revisions(page); state.revStatus = 409;
    await rev(page).getByRole('button', { name: '予算案を承認' }).click(); await page.getByRole('button', { name: '承認する', exact: true }).click();
    await hasTextAfter(page, '他の操作と重なったため、予算案を承認できませんでした'); await hasText(page, '試験用の予算エラー409');
    await page.getByRole('dialog').getByRole('button', { name: '戻る', exact: true }).click();
    state.revStatus = 422; await rev(page).getByRole('button', { name: '明細を編集' }).click(); await page.locator('#rev-rate').fill('30');
    await saveBudget(page); await hasTextAfter(page, '入力内容を確認してください（予算案を保存できませんでした）');
    await hasText(page, '入力中の内容は保持しています'); assert.equal(await page.locator('#rev-rate').inputValue(), '30');
    await page.getByRole('dialog').getByRole('button', { name: '戻る', exact: true }).click();
    state.postStatus = 401; await input(page); await confirmRegister(page); await page.getByRole('heading', { name: 'ログイン', exact: true }).waitFor(); await hasText(page, 'ログインの有効期限が切れました');
  });
  for (const [label, selector, value] of costCases) await scenario(`all-errors-preserve-${label}-draft-and-never-auto-resend`, async (page, state) => {
    await input(page); await mode(page, label); await page.locator(selector).fill(value);
    for (const status of [403, 409, 422]) {
      state.postStatus = status; const before = postCalls(state).length;
      await confirmRegister(page); await hasTextAfter(page, '試験用の登録エラー'); await hasText(page, '入力内容は保持しています');
      assert.equal(await page.locator(selector).inputValue(), value); assert.equal(postCalls(state).length, before + 1);
    }
    state.abortPost = true; await confirmRegister(page); await hasTextAfter(page, '通信結果を確認できません');
    assert.equal(await page.locator(selector).inputValue(), value); const sent = postCalls(state).length;
    state.abortPost = false; state.postStatus = 401; await confirmRegister(page);
    await page.getByRole('heading', { name: 'ログイン', exact: true }).waitFor(); await relogin(page); await input(page);
    assert.equal(await page.locator(selector).inputValue(), value); assert.equal(postCalls(state).length, sent + 1, '401から復帰しても自動再送しない');
  });
  for (const status of [403, 409, 422, 'network']) await scenario(`budget-save-${status}-preserves-editor`, async (page, state) => {
    await revisions(page); await rev(page).getByRole('button', { name: '明細を編集' }).click(); await page.locator('#rev-rate').fill('31.25');
    if (status === 'network') state.abortRevision = true; else state.revStatus = status;
    await saveBudget(page); await hasTextAfter(page, status === 'network' ? '入力内容は保持しています' : '入力中の内容は保持しています');
    assert.equal(await page.locator('#rev-rate').inputValue(), '31.25');
    assert.equal(state.calls.filter(call => call.method === 'PUT' && call.path.includes('/budget/drafts/')).length, 1);
  });
  await scenario('budget-save-401-preserves-editor-through-relogin', async (page, state) => {
    await revisions(page); await rev(page).getByRole('button', { name: '明細を編集' }).click(); await page.locator('#rev-rate').fill('31.25');
    state.revStatus = 401; await saveBudget(page); await page.getByRole('heading', { name: 'ログイン', exact: true }).waitFor();
    state.revStatus = 200; await relogin(page); await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '戻る', exact: true }).click(); await page.getByRole('button', { name: /^予算・発注/ }).click();
    assert.equal(await page.locator('#rev-rate').inputValue(), '31.25');
    assert.equal(state.calls.filter(call => call.method === 'PUT' && call.path.includes('/budget/drafts/')).length, 1);
  });
  await scenario('reject-failure-keeps-reason-and-can-be-retried-manually', async (page, state) => {
    await revisions(page); await rev(page).getByRole('button', { name: '否認…', exact: true }).click();
    await page.locator('#rev-budget-reason').fill('数量の根拠を確認してください'); state.revStatus = 409;
    await page.getByRole('button', { name: '否認する', exact: true }).click(); await hasTextAfter(page, '試験用の予算エラー409');
    assert.equal(await page.locator('#rev-budget-reason').inputValue(), '数量の根拠を確認してください');
    const calls = () => state.calls.filter(call => call.path.endsWith('/reject') && call.method === 'POST'); assert.equal(calls().length, 1);
    state.revStatus = 200; await page.getByRole('button', { name: '否認する', exact: true }).click(); await hasTextAfter(page, '予算案を否認しました'); assert.equal(calls().length, 2);
  });
  await scenario('successful-budget-save-is-not-reported-as-failure-if-refresh-fails', async (page, state) => {
    await revisions(page); await rev(page).getByRole('button', { name: '明細を編集' }).click(); await page.locator('#rev-rate').fill('31.25'); state.failRevisionRead = true;
    await saveBudget(page); await hasTextAfter(page, '予算案を保存しました'); await hasTextAfter(page, '操作は完了しましたが、最新の状態を取得できません'); await hasText(page, '再登録・再承認は不要');
    assert.equal(state.calls.filter(call => call.method === 'PUT' && call.path.includes('/budget/drafts/')).length, 1);
    assert.equal(await page.locator('#rev-rate').count(), 0, '保存成功した編集を未保存扱いで残さない');
  });
  for (const status of [403, 409, 422, 'network']) await scenario(`new-order-${status}-preserves-form-and-confirmation`, async (page, state) => {
    await revisions(page); await rev(page).getByRole('button', { name: '新規発注案', exact: true }).click();
    await page.locator('#rev-order-no').fill('ORD-TEST-01'); await rev(page).getByRole('button', { name: '発注案を作成', exact: true }).click();
    await page.getByRole('dialog').waitFor(); assert.ok((await dialogText(page)).includes('ORD-TEST-01'));
    if (status === 'network') state.abortRevision = true; else state.revStatus = status;
    await page.getByRole('dialog').getByRole('button', { name: '作成する', exact: true }).click(); await hasTextAfter(page, status === 'network' ? '入力内容は保持しています' : '入力中の内容は保持しています');
    assert.equal(await page.locator('#rev-order-no').inputValue(), 'ORD-TEST-01'); assert.equal(state.calls.filter(call => call.method === 'POST' && call.path === '/api/v1/orders').length, 1);
  });
  await scenario('confirm-dialogs-show-target-amount-and-require-reject-reason', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('2');
    await register(page).click(); await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByTestId('confirm-amount').innerText(), '¥36,000'); assert.ok((await dialogText(page)).includes('青葉台レジデンス新築工事 / 本工事'));
    await page.getByRole('button', { name: '戻る', exact: true }).click(); assert.equal(postCalls(state).length, 0, '戻ると送信しない');
    await submit(page); assert.equal(postCalls(state).length, 1);
    await revisions(page);
    const revCalls = () => state.calls.filter(call => call.method !== 'GET' && call.path.includes('/drafts/'));
    await rev(page).getByRole('button', { name: '予算案を承認' }).click(); await page.getByRole('dialog').waitFor();
    assert.ok((await dialogText(page)).includes('¥2,000,000') && (await dialogText(page)).includes('+¥200,000'), '承認の確認に金額と差額');
    await page.getByRole('button', { name: '戻る', exact: true }).click(); assert.equal(revCalls().length, 0);
    await rev(page).getByRole('button', { name: '否認…' }).click(); await page.getByRole('button', { name: '否認する', exact: true }).click();
    await hasTextAfter(page, '否認理由を入力してください'); assert.equal(revCalls().length, 0, '理由なしでは否認しない');
    await page.locator('#rev-budget-reason').fill('数量の根拠が不足'); await page.getByRole('button', { name: '否認する', exact: true }).click();
    await hasTextAfter(page, '予算案を否認しました');
    assert.deepEqual(revCalls().at(-1), { path: '/api/v1/projects/P001/branches/000/budget/drafts/3/reject', method: 'POST', body: { reason: '数量の根拠が不足' } });
    assert.equal(await rev(page).getByRole('button', { name: '予算案を承認' }).count(), 0, '否認済み版をそのまま承認できない');
  });
  for (const action of ['approve', 'delete']) await scenario(`budget-${action}-confirmation-and-realistic-terminal-state`, async (page, state) => {
    await revisions(page); await rev(page).getByRole('button', { name: action === 'approve' ? '予算案を承認' : '案を削除', exact: true }).click();
    await page.getByRole('dialog').waitFor(); assert.ok((await dialogText(page)).includes('¥2,000,000'));
    await page.getByRole('button', { name: action === 'approve' ? '承認する' : '削除する', exact: true }).click();
    await hasTextAfter(page, action === 'approve' ? '予算案を承認しました' : '予算案を削除しました');
    const call = state.calls.filter(call => call.method !== 'GET' && call.path.includes('/drafts/')).at(-1);
    assert.equal(call.method, action === 'approve' ? 'POST' : 'DELETE');
    assert.equal(await rev(page).getByRole('button', { name: '明細を編集' }).count(), 0, '確定した案を編集させない');
  });
  await scenario('viewer-sees-revisions-read-only-with-reasons-at-375-light', async page => {
    await revisions(page);
    for (const name of ['明細を編集', '案を削除', '予算案を承認', '工事を登録', '新規発注案']) assert.equal(await rev(page).getByRole('button', { name, exact: true }).first().isDisabled(), true, `${name} は無効`);
    for (const text of ['閲覧権限のため、案の作成・編集・削除はできません', '承認・否認は承認権限の利用者のみ可能です', '工事・枝番の登録は承認権限の利用者のみ可能です']) await hasText(page, text);
    assert.equal(await rev(page).getByRole('button', { name: '否認…' }).count(), 0);
    await page.setViewportSize({ width: 375, height: 812 }); await noOverflow(page); await page.screenshot({ path: '/tmp/agent-browser/progenba-revisions-375-viewer-light.png', fullPage: true });
  }, { role: 'viewer' });
  await scenario('registrar-can-edit-drafts-but-not-approve-or-register-projects', async page => {
    await revisions(page);
    assert.equal(await rev(page).getByRole('button', { name: '明細を編集' }).isDisabled(), false);
    for (const name of ['予算案を承認', '工事を登録']) assert.equal(await rev(page).getByRole('button', { name, exact: true }).isDisabled(), true, `${name} は無効`);
    await hasText(page, '承認・否認は承認権限の利用者のみ可能です');
  }, { role: 'registrar' });
  await scenario('zero-projects-still-allows-project-registration-in-revisions', async (page, state) => {
    await page.getByRole('button', { name: /^予算・発注/ }).click(); await hasTextAfter(page, '「工事を登録」から登録できます');
    await rev(page).getByRole('button', { name: '工事を登録', exact: true }).click(); await rev(page).getByRole('button', { name: '登録内容を確認' }).click();
    await hasTextAfter(page, '工事名称を入力してください'); assert.equal(await page.getByRole('dialog').count(), 0);
    await page.locator('#rev-new-project-code').fill('NEW01'); await page.locator('#rev-new-project-name').fill('新規検証工事');
    await rev(page).getByRole('button', { name: '登録内容を確認' }).click(); await page.getByRole('dialog').waitFor(); assert.ok((await dialogText(page)).includes('NEW01'));
    await page.getByRole('button', { name: '登録する', exact: true }).click(); await hasTextAfter(page, '工事「NEW01」を登録しました');
    const post = state.calls.find(call => call.path === '/api/v1/projects' && call.method === 'POST'); assert.equal(post.body.project_code, 'NEW01'); assert.equal(post.body.main_branch.branch_name, '本工事');
    await page.waitForFunction(() => document.querySelector('#rev-project')?.value === 'NEW01');
    assert.equal(await page.locator('#rev-project').inputValue(), 'NEW01'); await hasTextAfter(page, '承認済みの予算はありません');
    assert.equal(await page.getByRole('dialog').count(), 0, '登録直後の選択変更で破棄の確認を出さない');
  }, { rows: [], rev: { company_code: '0000', projects: [] } });
  console.log(`\n${passed} mock API browser scenarios passed. No real API/database writes were made.`);
} finally { await browser.close(); }
async function hasTextAfter(page, text) { await page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor(); }
