#!/usr/bin/env node
'use strict';
// Default: local read-only checks. The explicit flag activates only two previously
// selected, independently verified public sources; never probes account cookies.
const assert=require('node:assert/strict');
const {ApiClient,request}=require('../reader-bridge/network');
const base=process.env.SOURCE_CHECK_BASE||'http://127.0.0.1:4380';
async function main(){
 if(!process.env.QR_ACCESS_TOKEN)throw new Error('Local application authorization is required');
 const api=new ApiClient(base,{'X-Qr-Token':process.env.QR_ACCESS_TOKEN,'X-QR-Action':'1'});
 const denied=await request(base+'/desk/api/state',{trusted:true});
 assert.equal(denied.status,401);
 const before=await api.call('/desk/api/state');
 if(process.argv.includes('--activate-verified-sources')){
  const targets=[{id:'239f75d1493f',platform:'podcast',feed:'https://feeds.transistor.fm/recsperts-recommender-systems-experts'},
   {id:'5afaff0c4d50',platform:'juejin'}];
  for(const target of targets){
   assert.equal(before.sources.find(s=>s.id===target.id)?.platform,target.platform);
   if(target.feed)await api.call('/desk/api/sources/'+target.id+'/feed','POST',{feedUrl:target.feed});
   else await api.call('/desk/api/sources/'+target.id+'/configure','POST',{});
   const run=await api.call('/desk/api/refresh','POST',{sourceId:target.id});
   let result=run;
   for(let i=0;i<90&&result.pending;i++){
    await new Promise(r=>setTimeout(r,1000));result=await api.call('/desk/api/runs/'+run.id);
   }
   console.log(JSON.stringify({platform:target.platform,pending:result.pending,states:result.jobs.map(j=>j.state)}));
  }
 }
 const state=await api.call('/desk/api/state');
 assert.equal(state.sources.length,before.sources.length,'No authors added or removed by verification');
 const platforms=[...new Set(state.sources.map(s=>s.platform))].sort();
 const summary=[];
 for(const platform of platforms){
  const sources=state.sources.filter(s=>s.platform===platform);
  const ids=new Set(sources.map(s=>s.id));
  const channels=state.health.channels.filter(c=>ids.has(c.sourceId));
  const page=await api.call('/desk/api/entries?mode=latest&platform='+encodeURIComponent(platform)+'&limit=5');
  assert.ok(page.items.every(x=>x.platform===platform),'Cross-platform list leakage');
  summary.push({platform,registered:sources.length,withEnabledChannel:new Set(channels.filter(c=>c.enabled).map(c=>c.sourceId)).size,
   everCheckedSuccessfully:new Set(channels.filter(c=>c.lastSuccess>0).map(c=>c.sourceId)).size,
   storedItems:page.total});
 }
 const shell=await request(base+'/desk/',{trusted:true});
 assert.equal(shell.status,200);assert.match(shell.body.toString(),/platform-filter/);
 console.log(JSON.stringify({observedAt:new Date().toISOString(),sources:state.sources.length,
  storedItems:state.health.entries,platforms:summary},null,2));
 console.log('PASS source catalog, authentication, platform-filtered metadata and source-first shell');
 console.log('Not tested: full text, highlights, device push, account-based source collection');
}
main().catch(error=>{console.error('Source tracking check failed:',error.message);process.exitCode=1;});
