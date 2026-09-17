'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Database}=require('../reader-bridge/database');
const {channelsFor}=require('../reader-bridge/core');
const {DesktopCollector,validateItems}=require('../reader-bridge/desktop-collector');
const {normalize,statusFor}=require('../tools/windows/normalize.cjs');
const {createApp}=require('../reader-bridge/server');
function fixture(t,platform='zhihu'){
 const db=new Database(':memory:');t.after(()=>db.close());
 const source={id:'source1',name:'Subscribed author',platform,url:'https://www.zhihu.com/people/test',tags:['Agent'],feeds:[],adapter:{id:platform==='zhihu'?'test-author':'0123456789abcdef01234567'}};
 const config={adapters:{desktopPlatforms:['zhihu','xiaohongshu']}};
 const channels=channelsFor(source,config.adapters);db.putSource(source,channels);db.run('UPDATE channels SET feed_id=7');
 const stored=[];
 const service={db,config,provisionChannels:async()=>{},importItem:async(c,item)=>{stored.push(item);return 1;},
  finish:(job,state,error)=>db.run('UPDATE jobs SET state=?,error=?,finished_at=? WHERE id=?',state,error,Date.now(),job.id)};
 const collector=new DesktopCollector(service);service.desktop=collector;
 return {db,source,channels,collector,stored,service};
}
const answer={title:'A subscribed answer',link:'https://www.zhihu.com/question/123/answer/456',published:null,summary:''};
test('desktop routes preserve prior channel IDs while moving collection to Windows',()=>{
 const s={id:'s',name:'A',platform:'zhihu',feeds:[],adapter:{id:'author'}};
 const old=channelsFor(s),next=channelsFor(s,{desktopPlatforms:['zhihu']});
 assert.deepEqual(next.map(c=>c.id),old.map(c=>c.id));assert.ok(next.every(c=>c.transport==='desktop'));
});
test('claim returns only registered author metadata, never credentials or feed URLs',t=>{
 const f=fixture(t);const r=f.collector.claim(['zhihu']);assert.equal(r.job.authorId,'test-author');
 assert.deepEqual(Object.keys(r.job).sort(),['authorId','kind','leaseId','limit','name','platform','sourceId'].sort());
});
test('only one active browser task can be claimed',t=>{const f=fixture(t);assert.ok(f.collector.claim(['zhihu']).job);assert.equal(f.collector.claim(['zhihu']).job,null);});
test('expired lease requeues the job instead of declaring collection success',t=>{
 const f=fixture(t),first=f.collector.claim(['zhihu']);f.db.run('UPDATE collector_leases SET expires_at=1');
 const second=f.collector.claim(['zhihu']);assert.ok(second.job);assert.notEqual(second.job.leaseId,first.job.leaseId);
 assert.equal(f.db.channels()[0].last_success,0);
});
test('acknowledged replay does not import or reset read state twice',async t=>{
 const f=fixture(t),r=f.collector.claim(['zhihu']);const result={leaseId:r.job.leaseId,status:'OK',items:[answer]};
 const a=await f.collector.submit(result),b=await f.collector.submit(result);
 assert.deepEqual(a,b);assert.equal(f.stored.length,1);assert.equal(a.state,'SUCCEEDED_PARTIAL');
 await assert.rejects(f.collector.submit({...result,items:[]}),/changed replay/);
});
test('invalid cross-platform result is rejected before any imported item',async t=>{
 const f=fixture(t),r=f.collector.claim(['zhihu']);
 await assert.rejects(f.collector.submit({leaseId:r.job.leaseId,status:'OK',items:[{...answer,link:'https://evil.example/a'}]}));
 assert.equal(f.stored.length,0);assert.equal(f.db.channels()[0].last_success,0);
});
test('explicit authentication failure pauses shared group and preserves existing content',async t=>{
 const f=fixture(t),r=f.collector.claim(['zhihu']);
 await f.collector.submit({leaseId:r.job.leaseId,status:'AUTH_REQUIRED',items:[]});
 assert.equal(f.collector.claim(['zhihu']).job,null);assert.equal(f.stored.length,0);
 assert.equal(f.db.get('SELECT state FROM groups').state,'AUTH_REQUIRED');
 assert.equal(f.db.get('SELECT count(*) n FROM outbox').n,1);
});
test('source paused during collection cannot receive the result',async t=>{
 const f=fixture(t),r=f.collector.claim(['zhihu']);f.db.run('UPDATE sources SET enabled=0');
 await assert.rejects(f.collector.submit({leaseId:r.job.leaseId,status:'OK',items:[answer]}),/no longer enabled/);
});
test('lease expiry rejects late uploads and never fabricates new updates',async t=>{
 const f=fixture(t),r=f.collector.claim(['zhihu']);f.db.run('UPDATE collector_leases SET expires_at=1');
 await assert.rejects(f.collector.submit({leaseId:r.job.leaseId,status:'OK',items:[answer]}),/expired lease/);
});
test('metadata summary is escaped rather than executed',()=>{
 const r=validateItems({platform:'zhihu'},[{...answer,summary:'<script>bad</script>'}]);
 assert.ok(r[0].content.includes('&lt;script&gt;'));assert.equal(r[0].published,null);
});
test('Windows normalizer discards unrelated fields and preserves unknown XHS date',()=>{
 const r=normalize({platform:'xiaohongshu'},[{id:'0123456789abcdef01234567',title:'Note',url:'https://www.xiaohongshu.com/explore/0123456789abcdef01234567',cookie:'must-not-upload'}]);
 assert.equal(r[0].published,null);assert.equal(r[0].cookie,undefined);
});
test('Windows normalizer handles Zhihu Unix seconds and canonical answer title',()=>{
 const r=normalize({platform:'zhihu',kind:'answers'},[{question:'Question',created:1789600000,url:answer.link}]);
 assert.equal(r[0].published,1789600000000);assert.equal(r[0].title,'Question');
});
test('navigation rejection is not falsely diagnosed as an expired cookie',()=>{
 assert.equal(statusFor(1,'Navigation rejected.'),'ACCESS_BLOCKED');assert.equal(statusFor(77,'login required'),'AUTH_REQUIRED');
});
test('collector endpoint requires separate machine authorization and rejects browser origins',async t=>{
 const f=fixture(t);const app=createApp(f.service,{accessToken:'human-test',collectorToken:'collector-test'});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.close(r)));
 const url='http://127.0.0.1:'+app.address().port+'/desk/collector/v1';
 for(const headers of [{},{'X-Qr-Token':'human-test'},{'X-Qr-Collector-Token':'collector-test',Origin:'https://evil.example'}]){
   const r=await fetch(url,{method:'POST',headers,body:'{"op":"status"}'});assert.equal(r.status,401);
 }
 const r=await fetch(url,{method:'POST',headers:{'X-Qr-Collector-Token':'collector-test'},body:'{"op":"status"}'});
 assert.equal(r.status,200);assert.equal((await r.json()).device,'Shervin');
});
test('normal server collector does not make the browser fetch for a desktop channel',async t=>{
 const {ReaderService}=require('../reader-bridge/service');const f=fixture(t);let calls=0;
 const s=new ReaderService(f.db,{miniflux:'http://unused.invalid',karakeep:'http://unused.invalid',adapters:{}},{mf:{call:async()=>{calls++;return [];}}});
 f.db.createRun(f.db.channels());await s.pump();assert.equal(calls,0);
 assert.ok(f.db.all("SELECT * FROM jobs WHERE state='QUEUED'").length>0);
});
