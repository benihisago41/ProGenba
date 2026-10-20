import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const base=process.env.SIRIUS_TEST_URL || 'http://127.0.0.1:8080';
mkdirSync('artifacts/browser',{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const errors=[];
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.body.innerText.includes('青葉台'));
  const text=await page.locator('body').innerText();
  assert.ok(text.includes('実際') || text.includes('実発生'));
  assert.ok(text.includes('50,000,000') || text.includes('55,000,000'));
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'artifacts/browser/cockpit-desktop.png',fullPage:true});
  writeFileSync('artifacts/cockpit-browser.json',JSON.stringify({passed:true,base,checks:['real-api-project','contract-amount','actual-cost-label','no-page-errors'],screenshot:'artifacts/browser/cockpit-desktop.png'},null,2));
  console.log('PASS cockpit real API render and screenshot');
} catch(error) {
  writeFileSync('artifacts/cockpit-browser.json',JSON.stringify({passed:false,error:String(error),errors},null,2)); throw error;
} finally { await browser.close(); }
