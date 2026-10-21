import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const base = process.env.SIRIUS_TEST_URL || 'http://127.0.0.1:8080';
const container = process.env.SIRIUS_TEST_DB_CONTAINER || 'progenba-db-1';
const dbUser = process.env.SIRIUS_TEST_DB_USER || 'sirius';
// SIRIUS_TEST_PSQL=1: scripts/test_auth.ps1 が作る専用Composeネットワーク内のコンテナから psql（PG*環境変数）で接続する。
// それ以外は従来どおり docker exec で専用DBコンテナへ接続する（稼働中の progenba プロジェクトは拒否）。
const usePsql = process.env.SIRIUS_TEST_PSQL === '1';
if (!usePsql) {
  const label = execFileSync('docker', ['inspect', '-f', '{{index .Config.Labels "ai.agent"}}', container], { encoding:'utf8' }).trim();
  assert.equal(label, 'codex', '専用の検証DBだけを対象にしてください');
  const project = execFileSync('docker', ['inspect', '-f', '{{index .Config.Labels "com.docker.compose.project"}}', container], { encoding:'utf8' }).trim();
  assert.notEqual(project, 'progenba', '稼働中の progenba プロジェクトのDBでは実行しないでください');
}
const db = sql => (usePsql
  ? execFileSync('psql', ['-X','-At','-v','ON_ERROR_STOP=1'], {input:sql,encoding:'utf8'})
  : execFileSync('docker', ['exec','-i',container,'psql','-X','-U',dbUser,'-d','sirius_reborn','-At','-v','ON_ERROR_STOP=1'], {input:sql,encoding:'utf8'})).trim();
// 過去の証拠 artifacts/acceptance-api.json は上書きしない
const outputPath = process.env.SIRIUS_TEST_OUTPUT || 'artifacts/acceptance-api-auth.json';
// 認証導入後: 試験用の承認権限利用者（scripts/test_auth.ps1 が試験中だけ作成）でログインし Cookie を付ける
async function loginCookie(company) {
  const password = process.env[`AUTHTEST_PW_${company}_APPROVER`];
  assert.ok(password, `AUTHTEST_PW_${company}_APPROVER が未設定です`);
  const r = await fetch(base+'/api/v1/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company_code:company,user_id:'authtest-approver',password})});
  assert.equal(r.status, 200, '試験用利用者でログインできません');
  const m = /progenba_session=([0-9a-f]{64})/.exec(r.headers.get('set-cookie') || '');
  assert.ok(m, 'セッションCookieがありません');
  return `progenba_session=${m[1]}`;
}
const cookie0000 = await loginCookie('0000');
const cookie9001 = await loginCookie('9001');
const tests = [];
const documents = [];
const created={base:false,orderRevision:false,budgetRevision:false,tenant:false,trigger:false,lockedOrders:[]};
const tenantTables=['business_partners','work_types','cost_elements','quick_item_templates','project_masters','project_branches','execution_budgets','execution_budget_details','subcontract_orders','construction_equipment_masters'];
async function request(path, body, expected=200, cookie=cookie0000) {
  const response = await fetch(base+path, body === undefined ? {headers:{Cookie:cookie}} : {method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  if (expected === 201) { assert.match(data.document_no,/^\d{12}$/); assert.ok(Array.isArray(data.warnings)); }
  if (expected >= 400) { assert.equal(typeof data.code,'string'); assert.equal(typeof data.message,'string'); }
  return data;
}
const main = async () => (await request('/api/v1/cockpit?company_code=0000&project_code=PRJ-2026-A&branch_code=000'))[0];
async function check(name, fn) { await fn(); tests.push(name); console.log('PASS', name); }
const cost={company_code:'0000',project_code:'PRJ-2026-A',branch_code:'000',occurred_date:'2026-07-01',work_type_code:'002000100010',cost_element_code:'0100',item_name:'受入検証',quantity:'1.005',unit:'m3',unit_price:'100.500'};
const report={company_code:'0000',project_code:'PRJ-2026-A',branch_code:'000',work_date:'2026-07-01',employee_code:'EMP-0001',work_type_code:'002000100010',work_hours:'4.000'};
const equip={company_code:'0000',equipment_code:'EQP-001',dest_project_code:'PRJ-2026-A',dest_branch_code:'000',work_type_code:'001000100010',movement_date:'2026-07-01',quantity:'2.000',usage_days:3,freight_fee:1000,maintenance_fee:200};
const progress={company_code:'0000',order_number:'ORD-2026-001',order_history_no:0,assessment_year_month:'202607',curr_assessed_amount_tax_ex:3000000,fixed_deductions:5000,chargeback_offset:0};
async function register(kind, body, cookie=cookie0000) {
  const r=await request('/api/v1/costs/'+kind,body,201,cookie);
  const table={'subcontract-progress':'progress_assessments','direct-entry':'direct_cost_entries','daily-report':'site_daily_reports','equipment-movement':'equipment_site_movements'}[kind];
  const col={'subcontract-progress':'assessment_no','direct-entry':'entry_no','daily-report':'report_no','equipment-movement':'movement_slip_no'}[kind];
  documents.push({table,col,no:r.document_no,company:body.company_code}); return r;
}
try {
  await check('readiness-and-json-contract',async()=>{
    await request('/api/v1/health');
    const x=await main(); assert.equal(x.execution_budget_amount,38000000); assert.equal(x.actual_occurred_cost,0);
    assert.equal(x.forecast_gross_profit,12000000); assert.equal(typeof x.forecast_profit_rate,'string');
    const look=await request('/api/v1/lookups?company_code=0000'); assert.equal(look.quick_templates.length,5);
    assert.equal(typeof look.subcontract_orders[0].safety_assoc_rate_den,'string'); assert.equal(look.employees.length,2);
    // 認証導入後: 0000 のセッションで 9001 を指定すると会社越境として 403
    await request('/api/v1/cockpit?company_code=9001',undefined,403);
  });
  await check('subcontract-tax-deductions-and-cost',async()=>{
    const r=await register('subcontract-progress',progress);
    const row=db(`SELECT curr_assessed_tax_amount||','||curr_retainage_deduction||','||curr_safety_assoc_deduction||','||net_payment_amount FROM progress_assessments WHERE company_code='0000' AND assessment_no='${r.document_no}';`);
    assert.equal(row,'300000,300000,9000,2986000'); assert.equal((await main()).actual_breakdown.subcontract_cost,3000000);
  });
  await check('materials-expenses-labor-equipment-and-independent-sums',async()=>{
    await register('direct-entry',cost); await register('direct-entry',{...cost,cost_element_code:'0400',quantity:'1.000',unit_price:'200.000'});
    await register('daily-report',report); await register('equipment-movement',equip);
    const x=await main(); assert.equal(x.actual_breakdown.material_cost,101); assert.equal(x.actual_breakdown.expense_cost,200);
    assert.equal(x.actual_breakdown.labor_cost,11000); assert.equal(x.actual_breakdown.equipment_cost,1920);
    assert.equal(x.actual_occurred_cost,3013221); assert.equal(x.actual_breakdown.total_cost,3013221);
    assert.equal(x.by_work_type.reduce((s,r)=>s+r.actual_cost,0),3013221); assert.equal(x.ordered_committed_amount,18013221);
  });
  await check('invalid-inputs-and-cross-company-references',async()=>{
    for(const patch of [{quantity:'-1'},{quantity:'1.0001'},{unit_price:'-1'},{unit_price:'999999999999.999',quantity:'999999999999.999'},{work_type_code:'bad'},{cost_element_code:'0300'},{vendor_partner_code:'EMP-0001'},{occurred_date:'2026-02-30'}]) await request('/api/v1/costs/direct-entry',{...cost,...patch},422);
    await request('/api/v1/costs/daily-report',{...report,employee_code:'SUB-0001'},422);
    await request('/api/v1/costs/daily-report',{...report,work_hours:'0'},422);
    await request('/api/v1/costs/equipment-movement',{...equip,usage_days:-1},422);
    await request('/api/v1/costs/subcontract-progress',{...progress,curr_assessed_amount_tax_ex:8000000},422);
    await request('/api/v1/costs/subcontract-progress',{...progress,assessment_year_month:'202613'},422);
    await request('/api/v1/costs/subcontract-progress',{...progress,curr_assessed_amount_tax_ex:1,fixed_deductions:10000},422);
    const noCompany=await fetch(base+'/api/v1/costs/direct-entry',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie0000},body:JSON.stringify({...cost,company_code:'9001'})});
    assert.equal(noCompany.status,403);
    assert.equal((await main()).actual_occurred_cost,3013221);
  });
  db(`BEGIN;
    INSERT INTO project_branches SELECT (jsonb_populate_record(NULL::project_branches,to_jsonb(b)||jsonb_build_object('branch_code',v.code,'branch_name','受入検証','completion_status',v.status))).* FROM project_branches b CROSS JOIN (VALUES('990','1'),('991','2'),('992','3')) v(code,status) WHERE b.company_code='0000' AND b.project_code='PRJ-2026-A' AND b.branch_code='000';
    INSERT INTO execution_budgets SELECT (jsonb_populate_record(NULL::execution_budgets,to_jsonb(b)||'{"budget_history_no":1,"approval_status":"0","total_budget_amount":1}'::jsonb)).* FROM execution_budgets b WHERE company_code='0000' AND branch_code='000' AND budget_history_no=0;
    INSERT INTO subcontract_orders SELECT (jsonb_populate_record(NULL::subcontract_orders,to_jsonb(o)||'{"order_history_no":1,"order_status":"0","order_amount_tax_ex":1}'::jsonb)).* FROM subcontract_orders o WHERE company_code='0000' AND order_number='ORD-2026-001' AND order_history_no=0;
    COMMIT;`);
  created.base=true;
  await check('completion-guards-warnings-and-unapproved-revisions',async()=>{
    assert.equal((await main()).execution_budget_amount,38000000); assert.equal((await main()).ordered_committed_amount,18013221);
    for(const branch_code of ['991','992']) {
      await request('/api/v1/costs/direct-entry',{...cost,branch_code},422);
      await request('/api/v1/costs/daily-report',{...report,branch_code},422);
      await request('/api/v1/costs/equipment-movement',{...equip,dest_branch_code:branch_code},422);
      db(`INSERT INTO subcontract_orders SELECT (jsonb_populate_record(NULL::subcontract_orders,to_jsonb(o)||jsonb_build_object('order_number','QA-LOCK-${branch_code}','branch_code','${branch_code}'))).* FROM subcontract_orders o WHERE company_code='0000' AND order_number='ORD-2026-002' AND order_history_no=0;`);
      created.lockedOrders.push(`QA-LOCK-${branch_code}`);
      await request('/api/v1/costs/subcontract-progress',{...progress,order_number:`QA-LOCK-${branch_code}`},422);
    }
    const r=await register('direct-entry',{...cost,branch_code:'990'}); assert.ok(r.warnings.length>0);
    const late=await register('direct-entry',{...cost,occurred_date:'2027-01-01'}); assert.ok(late.warnings.length>0);
  });
  await check('concurrent-assessments-use-serialized-cumulative-tax',async()=>{
    const rs=await Promise.all([register('subcontract-progress',{...progress,curr_assessed_amount_tax_ex:11,fixed_deductions:0}),register('subcontract-progress',{...progress,curr_assessed_amount_tax_ex:19,fixed_deductions:0})]);
    assert.notEqual(rs[0].document_no,rs[1].document_no);
    assert.equal(db("SELECT sum(curr_assessed_amount_tax_ex)||','||sum(curr_assessed_tax_amount) FROM progress_assessments WHERE company_code='0000' AND order_number='ORD-2026-001';"),'3000030,300003');
  });
  db(`INSERT INTO subcontract_orders SELECT (jsonb_populate_record(NULL::subcontract_orders,to_jsonb(o)||'{"order_history_no":2}'::jsonb)).* FROM subcontract_orders o WHERE company_code='0000' AND order_number='ORD-2026-001' AND order_history_no=0;`);
  created.orderRevision=true;
  await check('stale-order-revision-is-rejected-and-history-not-double-counted',async()=>{
    await request('/api/v1/costs/subcontract-progress',{...progress,curr_assessed_amount_tax_ex:1,fixed_deductions:0},409);
    const look=await request('/api/v1/lookups'); const order=look.subcontract_orders.find(x=>x.order_number==='ORD-2026-001');
    assert.equal(order.order_history_no,2); assert.equal(order.accum_assessed_amount_tax_ex,3000030);
    assert.equal((await main()).ordered_committed_amount,18013322);
  });
  await check('latest-approved-budget-is-selected-once',async()=>{
    db(`BEGIN;
      INSERT INTO execution_budgets SELECT (jsonb_populate_record(NULL::execution_budgets,to_jsonb(b)||'{"budget_history_no":2,"total_budget_amount":38001000}'::jsonb)).* FROM execution_budgets b WHERE company_code='0000' AND project_code='PRJ-2026-A' AND branch_code='000' AND budget_history_no=0;
      INSERT INTO execution_budget_details SELECT (jsonb_populate_record(NULL::execution_budget_details,to_jsonb(b)||jsonb_build_object('budget_history_no',2,'planned_amount',planned_amount+CASE WHEN line_no=1 THEN 1000 ELSE 0 END))).* FROM execution_budget_details b WHERE company_code='0000' AND project_code='PRJ-2026-A' AND branch_code='000' AND budget_history_no=0;
      COMMIT;`);
    created.budgetRevision=true;
    const x=await main(); assert.equal(x.latest_budget_history_no,2); assert.equal(x.execution_budget_amount,38001000);
    assert.equal(x.by_work_type.reduce((sum,r)=>sum+r.budget_amount,0),38001000);
  });
  await check('two-existing-companies-with-identical-business-codes-remain-isolated',async()=>{
    for(const table of tenantTables) assert.equal(Number(db(`SELECT count(*) FROM ${table} WHERE company_code='9001';`)),0,'試験会社の既存データが存在します');
    db('BEGIN;'+tenantTables.map(table=>`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(t)||'{"company_code":"9001"}'::jsonb)).* FROM ${table} t WHERE company_code='0000';`).join('\n')+'COMMIT;');
    created.tenant=true;
    const before=await main(); await register('direct-entry',{...cost,company_code:'9001'},cookie9001);
    const other=(await request('/api/v1/cockpit?company_code=9001&branch_code=000',undefined,200,cookie9001))[0];
    assert.equal(other.actual_occurred_cost,101); assert.equal(other.actual_breakdown.subcontract_cost,0);
    assert.equal((await main()).actual_occurred_cost,before.actual_occurred_cost);
  });
  db(`BEGIN; CREATE FUNCTION codex_test_reject_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '受入試験の意図的失敗'; END $$;
      CREATE TRIGGER codex_test_reject BEFORE INSERT ON direct_cost_entries FOR EACH ROW EXECUTE FUNCTION codex_test_reject_insert(); COMMIT;`);
  created.trigger=true;
  await check('insert-failure-rolls-back',async()=>{
    const before=await main(); await request('/api/v1/costs/direct-entry',cost,500);
    assert.equal((await main()).actual_occurred_cost,before.actual_occurred_cost);
  });
  writeFileSync(outputPath,JSON.stringify({passed:true,base,database_container:usePsql?'psql:'+(process.env.PGHOST||''):container,authenticated:true,tests},null,2));
} catch(error) {
  writeFileSync(outputPath,JSON.stringify({passed:false,tests,error:String(error)},null,2)); throw error;
} finally {
  if(created.trigger) db('DROP TRIGGER codex_test_reject ON direct_cost_entries; DROP FUNCTION codex_test_reject_insert();');
  for(const {table,col,no,company} of documents.reverse()) db(`DELETE FROM ${table} WHERE company_code='${company}' AND ${col}='${no}';`);
  if(created.tenant) for(const table of [...tenantTables].reverse()) db(`DELETE FROM ${table} WHERE company_code='9001';`);
  for(const no of created.lockedOrders) db(`DELETE FROM subcontract_orders WHERE company_code='0000' AND order_number='${no}';`);
  if(created.orderRevision) db("DELETE FROM subcontract_orders WHERE company_code='0000' AND order_number='ORD-2026-001' AND order_history_no=2;");
  if(created.budgetRevision) db("DELETE FROM execution_budget_details WHERE company_code='0000' AND project_code='PRJ-2026-A' AND branch_code='000' AND budget_history_no=2; DELETE FROM execution_budgets WHERE company_code='0000' AND project_code='PRJ-2026-A' AND branch_code='000' AND budget_history_no=2;");
  if(created.base) db("DELETE FROM subcontract_orders WHERE company_code='0000' AND order_number='ORD-2026-001' AND order_history_no=1; DELETE FROM execution_budgets WHERE company_code='0000' AND project_code='PRJ-2026-A' AND branch_code='000' AND budget_history_no=1; DELETE FROM project_branches WHERE company_code='0000' AND project_code='PRJ-2026-A' AND branch_code IN ('990','991','992');");
}
