#!/usr/bin/env node
'use strict';
// Live local service smoke test. Uses the private environment without logging it.
const assert=require('node:assert/strict');
const base=process.env.BRIDGE_TEST_URL||'http://127.0.0.1:4380';
async function call(path,body){
  const response=await fetch(base+'/desk/api'+path,{method:body?'POST':'GET',
    headers:{'X-Qr-Token':process.env.QR_ACCESS_TOKEN,'X-QR-Action':'1','Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  assert(response.ok,'Bridge HTTP '+response.status);
  return response.json();
}
async function main(){
  assert.equal((await fetch(base+'/desk/api/state')).status,401);
  assert.equal((await fetch(base+'/desk/')).status,200);
  const state=await call('/state');
  assert.equal(state.sources.length,269);
  assert(state.health.readerConfigured);
  console.log('PASS private API, public login shell and complete source catalog');
  const notes=await call('/notes');assert(Array.isArray(notes.highlights));
  console.log('PASS connected native notes API');
  if(process.env.QR_SMOKE_REFRESH==='true'){
    const source=state.sources.find(s=>s.name.includes('Eugene'))||state.sources.find(s=>s.platform==='blog'&&state.health.channels.some(c=>c.sourceId===s.id&&c.enabled));
    assert(source,'Missing known public blog fixture');
    const run=await call('/refresh',{sourceId:source.id});
    console.log('Refresh accepted; channels:',run.jobs.length);
    let result;
    for(let i=0;i<90;i++){
      result=await call('/runs/'+run.id);
      if(!result.pending)break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.equal(result.pending,0,'Refresh did not complete within the observation window');
    assert(result.jobs.every(j=>['SUCCEEDED_NEW','SUCCEEDED_NO_NEW'].includes(j.state)),
      'Refresh completed with a source problem, not success');
    const entries=await call('/entries?source='+encodeURIComponent(source.id));
    assert(entries.total>0,'No live articles returned');
    console.log('PASS live subscribed source refresh; article count:',entries.total);
  }
  const health=await call('/state');
  console.log('Stored entries:',health.health.entries,'Queued work:',health.health.queue);
  console.log('LIVE HTTP SMOKE PASSED');
}
main().catch(error=>{console.error('Smoke failed:',error.message);process.exitCode=1;});
