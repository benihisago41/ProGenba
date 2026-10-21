import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { me, projects, project, lookups } from './ui-fixtures.mjs';

const base = process.env.SIRIUS_TEST_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
mkdirSync('/tmp/agent-browser', { recursive: true });
let passed = 0;
async function scenario(name, run, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1253, height: 817 } });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const state = { loggedIn: true, role: 'approver', rows: structuredClone(projects), lookup: structuredClone(lookups), failCockpit: false, failLookups: false, postStatus: 201, postDelay: 0, abortPost: false, calls: [], errors: [], ...options };
  page.on('pageerror', error => state.errors.push(String(error)));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    state.calls.push({ path, method: request.method(), body: request.postDataJSON() });
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.endsWith('/auth/me')) return json(state.loggedIn ? 200 : 401, state.loggedIn ? { ...me, role: state.role } : {});
    if (path.endsWith('/auth/login')) { state.loggedIn = true; return json(200, { ...me, role: state.role }); }
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
    return json(404, {});
  });
  try {
    await page.goto(base);
    if (state.loggedIn && state.failCockpit) await page.getByText('工事の状況を取得できませんでした', { exact: false }).waitFor();
    else if (state.loggedIn && state.rows.length === 0) await page.getByText('登録されている工事がありません', { exact: false }).waitFor();
    else await page.getByRole('heading', { name: state.loggedIn ? '工事の状況' : 'ログイン', exact: true }).waitFor();
    await run(page, state);
    assert.deepEqual(state.errors, [], 'ブラウザ実行エラー');
    console.log('PASS', name); passed++;
  } catch (error) {
    console.error('FAIL', name); await page.screenshot({ path: '/tmp/agent-browser/ui-regression-failure.png', fullPage: true });
    console.error((await page.locator('body').innerText()).slice(-6500)); throw error;
  } finally { await context.close(); }
}
const input = page => page.getByRole('button', { name: /^原価を登録/ }).first().click();
const mode = (page, name) => page.getByRole('tab', { name: new RegExp(name) }).click();
const register = page => page.getByRole('button', { name: 'この内容で登録', exact: true });
const postCalls = state => state.calls.filter(call => call.path.includes('/costs/'));
const hasText = async (page, text) => assert.ok((await page.locator('body').innerText()).includes(text), `表示なし: ${text}`);
const submit = async page => { await register(page).click(); await page.getByTestId('registration-success').waitFor(); await register(page).waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.querySelector('form[aria-busy="true"]')); };
const noOverflow = async page => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'ページ全体の横はみ出し');
try {
  await scenario('login-validation-autocomplete-keyboard-and-real-auth-contract', async (page, state) => {
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();
    await hasText(page, '4文字の英数字を入力'); assert.equal(await page.locator('#login-company').evaluate(el => el === document.activeElement), true);
    await page.locator('#login-company').fill('A001'); await page.locator('#login-user').fill('user01'); await page.locator('#login-password').fill('test-password-only');
    assert.equal(await page.locator('#login-user').getAttribute('autocomplete'), 'username');
    await page.locator('#login-password').press('Enter'); await page.getByRole('heading', { name: '工事の状況', exact: true }).waitFor();
    assert.deepEqual(state.calls.find(call => call.path.endsWith('/auth/login')).body, { company_code: 'A001', user_id: 'user01', password: 'test-password-only' });
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
    await register(page).click({ clickCount: 2 }); await page.getByTestId('registration-success').waitFor(); assert.equal(postCalls(state).length, 1);
    const body = postCalls(state)[0].body; assert.equal(body.quantity, '1.005'); assert.equal(body.unit_price, '100.500'); assert.equal(body.cost_element_code, '0100'); assert.equal(body.company_code, '0000');
  }, { postDelay: 350 });
  await scenario('expense-template-confirmation-and-optional-inputs', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('100'); await page.getByRole('button', { name: '産廃処分', exact: true }).click();
    await page.getByRole('dialog').waitFor(); await page.getByRole('button', { name: '変更する', exact: true }).click(); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '1');
    await page.getByRole('button', { name: '詳細・任意項目' }).click(); await page.locator('#direct-notes-input').fill('現場メモ'); await page.locator('#direct-vendor-select').selectOption('V001');
    await submit(page); assert.equal(postCalls(state)[0].body.cost_element_code, '0400'); assert.equal(postCalls(state)[0].body.notes, '現場メモ');
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
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('4'); await register(page).click();
    await hasTextAfter(page, '試験用の登録エラー'); assert.equal(await page.locator('#direct-quantity-input').inputValue(), '4');
    state.postStatus = 201; await submit(page); assert.equal(postCalls(state).length, 2);
  }, { postStatus: 422 });
  await scenario('unknown-post-result-is-not-automatically-retried', async (page, state) => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('4'); await register(page).click(); await hasTextAfter(page, '通信結果を確認できません');
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
  await scenario('session-expiry-removes-drafts', async page => {
    await input(page); await mode(page, '材料・経費'); await page.locator('#direct-quantity-input').fill('9');
    await page.route('**/api/v1/cockpit?*', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
    await page.getByRole('button', { name: '更新', exact: true }).click(); await page.getByRole('heading', { name: 'ログイン', exact: true }).waitFor(); await hasText(page, '入力途中の内容は安全のため破棄');
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
    await page.setViewportSize({ width: 1253, height: 817 }); await page.evaluate(() => { document.documentElement.style.zoom = '2'; }); await noOverflow(page); await input(page); await noOverflow(page); await page.screenshot({ path: '/tmp/agent-browser/progenba-zoom-200.png', fullPage: true });
  });
  console.log(`\n${passed} mock API browser scenarios passed. No real API/database writes were made.`);
} finally { await browser.close(); }
async function hasTextAfter(page, text) { await page.getByText(text, { exact: false }).first().waitFor(); }
