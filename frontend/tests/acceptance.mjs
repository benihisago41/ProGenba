import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const base=process.env.SIRIUS_TEST_URL || 'http://127.0.0.1:8080';
const dbContainer=process.env.SIRIUS_TEST_DB_CONTAINER || 'progenba-codex-phase0-db';
const dbUser=process.env.SIRIUS_TEST_DB_USER || 'postgres';
assert.equal(execFileSync('docker',['inspect','-f','{{index .Config.Labels "ai.agent"}}',dbContainer],{encoding:'utf8'}).trim(),'codex');
const db=sql=>execFileSync('docker',['exec','-i',dbContainer,'psql','-X','-U',dbUser,'-d','sirius_reborn','-At','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8'}).trim();
const get=async()=>{const r=await fetch(base+'/api/v1/cockpit');assert.equal(r.status,200);return r.json();};
const paths={ 'subcontract-progress':['progress_assessments','assessment_no'], 'direct-entry':['direct_cost_entries','entry_no'], 'daily-report':['site_daily_reports','report_no'], 'equipment-movement':['equipment_site_movements','movement_slip_no'] };
const records=[],checks=[],errors=[];
mkdirSync('artifacts/browser',{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const page=await browser.newPage({viewport:{width:1440,height:1080}});
page.on('pageerror',e=>errors.push(String(e)));
async function check(name,fn){await fn();checks.push(name);console.log('PASS',name);}
async function choose(selector,text){
  const options=await page.locator(selector+' option').evaluateAll(xs=>xs.map(x=>({value:x.value,text:x.textContent,disabled:x.disabled})));
  const option=options.find(x=>!x.disabled&&x.value&&x.text.includes(text));assert.ok(option,`${selector}: ${text}`);
  await page.locator(selector).selectOption(option.value);
}
const fill=async(id,value)=>page.locator('#'+id).fill(value);
const tab=async(name)=>page.getByRole('tab',{name}).click();
async function submit(kind,{double=false}={}){
  const promise=page.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith('/costs/'+kind));
  await page.locator('button[type=submit]').click({clickCount:double?2:1});
  const response=await promise;const data=await response.json();assert.equal(response.status(),201,JSON.stringify(data));
  assert.match(data.document_no,/^\d{12}$/);records.push({kind,no:data.document_no});
  await page.waitForFunction(no=>document.body.innerText.includes(no),data.document_no);
  await page.locator('#easy-branch-select').waitFor();
}
try {
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.body.innerText.includes('青葉台'));
  const seed=(await get()).find(x=>x.key.branch_code==='000');assert.equal(seed.actual_occurred_cost,0,'専用の空原価DBで実行してください');
  await page.getByRole('button',{name:/かんたん原価登録/}).click();
  await page.locator('#easy-branch-select').waitFor();
  await choose('#easy-branch-select','本工事');
  await check('subcontract-real-ui-preview-and-registration',async()=>{
    await tab(/外注さん/);await choose('#subcontract-order-select','佐藤');
    await fill('subcontract-curr-amount','3000000');await fill('subcontract-ym-input','202607');await fill('subcontract-fixed-deduction','5000');
    assert.ok((await page.locator('body').innerText()).includes('2,986,000'));
    await submit('subcontract-progress');assert.equal((await get()).find(x=>x.key.branch_code==='000').actual_breakdown.subcontract_cost,3000000);
  });
  async function material(){
    await tab(/買った材料/);await page.getByRole('button',{name:/生コンクリート/}).click();
    await fill('direct-occurred-date','2026-07-01');await fill('direct-quantity-input','1.005');await fill('direct-unit-price-input','100.5');
  }
  await check('material-rounding-and-client-validation',async()=>{
    await material();await fill('direct-quantity-input','1.0001');assert.equal(await page.locator('button[type=submit]').isDisabled(),true);
    await fill('direct-quantity-input','-1');assert.equal(await page.locator('button[type=submit]').isDisabled(),true);
    await fill('direct-quantity-input','1.005');await submit('direct-entry');
    assert.equal((await get()).find(x=>x.key.branch_code==='000').actual_breakdown.material_cost,101);
  });
  await check('expense-card-maps-to-expense-cost',async()=>{
    await page.getByRole('button',{name:/産廃処分/}).click();await fill('direct-quantity-input','1');await fill('direct-unit-price-input','200');await submit('direct-entry');
    assert.equal((await get()).find(x=>x.key.branch_code==='000').actual_breakdown.expense_cost,200);
  });
  await check('network-failure-keeps-input-and-allows-retry',async()=>{
    await material();await page.route('**/api/v1/costs/direct-entry',route=>route.abort('failed'),{times:1});
    await page.locator('button[type=submit]').click();await page.getByRole('alert').filter({hasText:/通信|fetch|Failed/}).waitFor();
    assert.equal(await page.locator('#direct-quantity-input').inputValue(),'1.005');
    assert.equal(await page.locator('#direct-unit-price-input').inputValue(),'100.5');await submit('direct-entry');
  });
  await check('double-click-registers-once',async()=>{
    let count=0;await page.route('**/api/v1/costs/direct-entry',async route=>{count++;await new Promise(r=>setTimeout(r,300));await route.continue();});
    await submit('direct-entry',{double:true});await page.unroute('**/api/v1/costs/direct-entry');assert.equal(count,1);
    assert.equal((await get()).find(x=>x.key.branch_code==='000').actual_breakdown.material_cost,303);
  });
  await check('daily-report-quick-hours-and-standard-wage',async()=>{
    await tab(/今日の現場日報/);await choose('#daily-employee-select','高橋');await choose('#daily-work-type-select','躯体');
    await fill('daily-work-date-input','2026-07-01');await page.getByRole('button',{name:/4.0時間/}).click();await submit('daily-report');
    assert.equal((await get()).find(x=>x.key.branch_code==='000').actual_breakdown.labor_cost,11000);
  });
  await check('equipment-rent-freight-maintenance',async()=>{
    await tab(/資機材・重機/);await choose('#equip-select','枠組足場');await choose('#equip-work-type-select','外部足場');
    await fill('equip-movement-date-input','2026-07-01');await fill('equip-quantity-input','2');await fill('equip-usage-days-input','3');
    await fill('equip-freight-input','1000');await fill('equip-maintenance-input','200');await submit('equipment-movement');
    assert.equal((await get()).find(x=>x.key.branch_code==='000').actual_breakdown.equipment_cost,1920);
  });
  await check('additional-branch-and-whole-project-totals',async()=>{
    await choose('#easy-branch-select','追加');await material();await fill('direct-quantity-input','1');await fill('direct-unit-price-input','10');await submit('direct-entry');
    const rows=await get();assert.equal(rows.find(x=>x.key.branch_code==='000').actual_occurred_cost,3013423);assert.equal(rows.find(x=>x.key.branch_code==='001').actual_occurred_cost,10);
    await page.getByRole('button',{name:/^📊 工事原価コックピット/}).click();
    await page.getByRole('tab',{name:/全枝番合算/}).click();assert.ok((await page.locator('body').innerText()).includes('3,013,433'));
  });
  await check('mobile-layout-and-input-controls',async()=>{
    await page.setViewportSize({width:375,height:812});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false,'スマホ幅でページが横にはみ出しています');
    await page.screenshot({path:'artifacts/browser/cockpit-mobile.png',fullPage:true});
    await page.getByRole('button',{name:/かんたん原価登録/}).click();await tab(/今日の現場日報/);
    assert.equal(await page.locator('#daily-work-hours-input').isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:'artifacts/browser/input-mobile.png',fullPage:true});
    await page.setViewportSize({width:1440,height:1080});
  });
  await check('initial-fetch-error-and-retry',async()=>{
    await page.route('**/api/v1/cockpit?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'TEST',message:'受入試験用通信エラー'})}),{times:1});
    await page.reload({waitUntil:'networkidle'});await page.getByRole('alert').filter({hasText:'受入試験用通信エラー'}).waitFor();
    await page.getByRole('button',{name:/再試行/}).click();await page.waitForFunction(()=>document.body.innerText.includes('青葉台'));
  });
  await check('oversized-aggregate-shows-error-and-recovers',async()=>{
    const fixture=Array.from({length:10},(_,i)=>({...seed,key:{...seed.key,branch_code:String(i).padStart(3,'0')},branch_name:'上限検証'+i,contract_amount_tax_ex:999999999999999,forecast_gross_profit:999999961999999}));
    await page.route('**/api/v1/cockpit?*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(fixture)}),{times:1});
    await page.reload({waitUntil:'networkidle'});await page.getByRole('tab',{name:/全枝番合算/}).click();
    await page.getByRole('alert').filter({hasText:/安全整数|上限/}).waitFor();
    await page.getByRole('button',{name:/本工事を表示/}).click();assert.ok((await page.locator('body').innerText()).includes('999,999,999,999,999'));
    await page.reload({waitUntil:'networkidle'});
  });
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'artifacts/browser/cockpit-desktop.png',fullPage:true});
  writeFileSync('artifacts/acceptance-browser.json',JSON.stringify({passed:true,base,checks,records,page_errors:errors},null,2));
}catch(error){
  await page.screenshot({path:'artifacts/browser/failure.png',fullPage:true}).catch(()=>{});
  writeFileSync('artifacts/acceptance-browser.json',JSON.stringify({passed:false,checks,records,error:String(error),page_errors:errors},null,2));throw error;
}finally{
  await browser.close();
  if(process.env.SIRIUS_KEEP_BROWSER_DATA!=='1'){
    for(const {kind,no} of records.reverse()){const [table,col]=paths[kind];db(`DELETE FROM ${table} WHERE company_code='0000' AND ${col}='${no}';`);}
  }
}
