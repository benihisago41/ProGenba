import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const base=process.env.SIRIUS_TEST_URL || 'http://127.0.0.1:8080';
const get=async()=>{
  const r=await fetch(base+'/api/v1/cockpit?company_code=0000');
  assert.equal(r.status,200); return r.json();
};
try {
  const before=await get();
  assert.ok(before.some(x=>x.actual_occurred_cost>0),'画面から登録した検証原価が必要です');
  await new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','restart','app','db'],{stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{}); child.stderr.on('data',()=>{});
    child.on('error',reject); child.on('exit',code=>code===0?resolve():reject(Error('Compose restart failed')));
  });
  const deadline=Date.now()+90000;
  let ready=false;
  while(Date.now()<deadline){
    try {
      const r=await fetch(base+'/api/v1/health',{signal:AbortSignal.timeout(2000)});
      if(r.ok){ready=true;break;}
    }catch{}
    await new Promise(r=>setTimeout(r,1500));
  }
  assert.ok(ready,'再起動後の稼働確認がタイムアウトしました');
  const after=await get(); assert.deepEqual(after,before);
  writeFileSync('artifacts/acceptance-persistence.json',JSON.stringify({passed:true,base,checks:['browser-created-cost-present','app-and-db-restart','readiness-recovered','all-cockpit-values-unchanged'],branches:after.map(x=>({key:x.key,actual_cost:x.actual_occurred_cost}))},null,2));
  console.log('PASS app/DB restart preserves browser-created costs and all cockpit values');
}catch(error){
  writeFileSync('artifacts/acceptance-persistence.json',JSON.stringify({passed:false,error:String(error)},null,2)); throw error;
}
