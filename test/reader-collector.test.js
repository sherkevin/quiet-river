'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Database}=require('../reader-bridge/database');
const {channelsFor}=require('../reader-bridge/core');
const {DesktopCollector,validateItems}=require('../reader-bridge/desktop-collector');
const {normalize,normalizeEnrichment,statusFor}=require('../tools/windows/normalize.cjs');
const {confirmedCollect,authRecovered,proxyTunnelArgs}=require('../tools/windows/collector.cjs');
const {createApp}=require('../reader-bridge/server');
function fixture(t,platform='zhihu'){
 const db=new Database(':memory:');t.after(()=>db.close());
 const source={id:'source1',name:'Subscribed author',platform,url:'https://www.zhihu.com/people/test',tags:['Agent'],feeds:[],adapter:{id:platform==='zhihu'?'test-author':'0123456789abcdef01234567'}};
 const config={adapters:{desktopPlatforms:['zhihu','xiaohongshu']}};
 const channels=channelsFor(source,config.adapters).filter(c=>c.label!=='articles');db.putSource(source,channels);db.run('UPDATE channels SET feed_id=7');
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
 const r=validateItems({platform:'zhihu',label:'answers'},[{...answer,summary:'<script>bad</script>'}]);
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
test('answer metadata cannot be uploaded under the article channel',()=>{
 assert.throws(()=>validateItems({platform:'zhihu',label:'articles'},[answer]),/does not match/);
});
test('an authentication-paused group does not create repeated scheduled runs',async t=>{
 const f=fixture(t),r=f.collector.claim(['zhihu']);
 await f.collector.submit({leaseId:r.job.leaseId,status:'AUTH_REQUIRED',items:[]});
 const before=f.db.get('SELECT count(*) n FROM runs').n;
 f.collector.claim(['zhihu']);f.collector.claim(['zhihu']);
 assert.equal(f.db.get('SELECT count(*) n FROM runs').n,before);
});
test('successful desktop collection clears stale channel errors while retaining partial task detail',async t=>{
 const f=fixture(t);const r=f.collector.claim(['zhihu']);
 f.db.run("UPDATE channels SET error='old failure' WHERE id=?",f.channels[0].id);
 const ack=await f.collector.submit({leaseId:r.job.leaseId,status:'OK',items:[answer]});
 assert.equal(ack.state,'SUCCEEDED_PARTIAL');
 assert.equal(f.db.get('SELECT error FROM channels WHERE id=?',f.channels[0].id).error,'');
 const job=f.db.get('SELECT error FROM jobs WHERE id=?',r.job.leaseId); // lease ID is not the job ID; task detail is covered by runStatus below.
 assert.equal(job,undefined);
 const run=f.db.all('SELECT error FROM jobs ORDER BY created_at DESC LIMIT 1')[0];
 assert.match(run.error,/窗口列表已同步/);
});
test('collector startup removes legacy success messages from the channel error field',t=>{
 const f=fixture(t);f.db.run("UPDATE channels SET state='SUCCEEDED_PARTIAL',error='legacy success note'");
 new DesktopCollector(f.service);
 assert.equal(f.db.get('SELECT error FROM channels').error,'');
});

test('paused desktop group exposes only a bounded local auth probe and can resume itself',async t=>{
 const f=fixture(t),r=f.collector.claim(['zhihu']);
 await f.collector.submit({leaseId:r.job.leaseId,status:'AUTH_REQUIRED',items:[]});
 const paused=f.collector.claim(['zhihu']);assert.equal(paused.job,null);
 assert.deepEqual(Object.keys(paused.authProbe).sort(),['authorId','kind','limit','platform','sourceId'].sort());
 assert.equal(paused.authProbe.platform,'zhihu');assert.equal(paused.authProbe.authorId,'test-author');
 assert.throws(()=>f.collector.resume('twitter'),/unsupported recovery platform/);
 const resumed=f.collector.resume('zhihu');assert.equal(resumed.resumed,true);
 assert.equal(f.db.get('SELECT state FROM groups').state,'UNKNOWN');
 assert.equal(f.db.channels()[0].state,'NEVER_CHECKED');assert.equal(f.db.channels()[0].next_check,0);
});

test('collector recovery is rate limited after another authentication pause',async t=>{
 const f=fixture(t),r=f.collector.claim(['zhihu']);
 await f.collector.submit({leaseId:r.job.leaseId,status:'AUTH_REQUIRED',items:[]});
 const at=Date.now();assert.equal(f.collector.resume('zhihu',at).resumed,true);
 f.db.run("UPDATE groups SET state='AUTH_REQUIRED'");
 const blocked=f.collector.resume('zhihu',at+1000);assert.equal(blocked.resumed,false);assert.ok(blocked.retryAfter>=599);
});

test('Windows confirms an authentication failure on the same route before freezing the group',async()=>{
 let calls=0;const sequence=[{status:'AUTH_REQUIRED'},{status:'OK',items:[]}];
 const result=await confirmedCollect({platform:'zhihu'},()=>{calls++;return sequence.shift();},async()=>{});
 assert.equal(calls,2);assert.equal(result.status,'OK');
 calls=0;const confirmed=await confirmedCollect({platform:'zhihu'},()=>{calls++;return {status:'AUTH_REQUIRED',items:[]};},async()=>{});
 assert.equal(calls,2);assert.equal(confirmed.status,'AUTH_REQUIRED');
});

test('automatic credential recovery requires two consecutive local successful probes',async()=>{
 let seq=[{status:'OK'},{status:'AUTH_REQUIRED'}],calls=0;
 assert.equal(await authRecovered({platform:'zhihu'},()=>{calls++;return seq.shift();},async()=>{}),false);assert.equal(calls,2);
 seq=[{status:'OK'},{status:'OK'}];calls=0;
 assert.equal(await authRecovered({platform:'zhihu'},()=>{calls++;return seq.shift();},async()=>{}),true);assert.equal(calls,2);
 seq=[{status:'AUTH_REQUIRED'}];calls=0;
 assert.equal(await authRecovered({platform:'zhihu'},()=>{calls++;return seq.shift();},async()=>{}),false);assert.equal(calls,1);
});


test('Bilibili RSSHub video channel keeps its identity when moved to the desktop collector',()=>{
 const source={id:'bili-source',name:'Bili author',platform:'bilibili',url:'https://space.bilibili.com/503316308',
  feeds:['http://127.0.0.1:1200/bilibili/user/video/503316308']};
 const old=channelsFor(source)[0],next=channelsFor(source,{desktopPlatforms:['bilibili']})[0];
 assert.equal(next.id,old.id);assert.equal(next.transport,'desktop');assert.equal(next.author_id,'503316308');
 assert.equal(next.desktop_kind,'videos');assert.equal(next.group_key,'desktop:bilibili');assert.equal(next.enabled,true);
});

function bilibiliFixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());
 const source={id:'bili-source',name:'Bili author',platform:'bilibili',url:'https://space.bilibili.com/503316308',
  feeds:['http://127.0.0.1:1200/bilibili/user/video/503316308']};
 const config={adapters:{desktopPlatforms:['bilibili']}},channels=channelsFor(source,config.adapters);db.putSource(source,channels);db.run('UPDATE channels SET feed_id=9');
 const stored=[];const service={db,config,provisionChannels:async()=>{},importItem:async(c,item)=>{stored.push(item);return 1;},
  finish:(job,state,error)=>db.run('UPDATE jobs SET state=?,error=?,finished_at=? WHERE id=?',state,error,Date.now(),job.id)};
 const collector=new DesktopCollector(service);service.desktop=collector;return {db,source,channels,collector,stored};
}

test('Bilibili desktop claim exposes only the subscribed UID and read-only kind',t=>{
 const f=bilibiliFixture(t),r=f.collector.claim(['bilibili']);assert.equal(r.job.authorId,'503316308');assert.equal(r.job.kind,'videos');
 assert.equal(r.job.platform,'bilibili');assert.equal(r.job.sourceId,'bili-source');assert.equal(r.job.url,undefined);
});

test('Bilibili desktop result accepts canonical video links and never turns auth noise into a credential freeze',async t=>{
 const f=bilibiliFixture(t),r=f.collector.claim(['bilibili']);
 const ack=await f.collector.submit({leaseId:r.job.leaseId,status:'OK',items:[{
  title:'Fixture video',link:'https://www.bilibili.com/video/BV1XAew6mEhw',published:Date.parse('2026-09-17T00:00:00Z'),summary:''
 }]});
 assert.equal(ack.state,'SUCCEEDED_PARTIAL');assert.equal(f.stored.length,1);
 assert.equal(f.stored[0].guid,'https://www.bilibili.com/video/BV1XAew6mEhw');
 const next=f.collector.claim(['bilibili']);assert.equal(next.job,null);
 f.db.run('UPDATE channels SET next_check=0');f.db.run("UPDATE groups SET next_allowed=0,state='OK'");
 const retry=f.collector.claim(['bilibili']);assert.ok(retry.job);
 const blocked=await f.collector.submit({leaseId:retry.job.leaseId,status:'AUTH_REQUIRED',items:[]});
 assert.equal(blocked.state,'ACCESS_BLOCKED');assert.equal(f.db.get("SELECT state FROM groups WHERE id='desktop:bilibili'").state,'ACCESS_BLOCKED');
});

test('Bilibili desktop validator rejects unrelated hosts',()=>{
 assert.throws(()=>validateItems({platform:'bilibili',label:'videos',authorId:'503316308'},[{
  title:'Bad',link:'https://www.bilibili.com.evil.example/video/BV1XAew6mEhw',published:null,summary:''
 }]),/does not match/);
});test('proxy tunnel is loopback-only and uses a dedicated SSH identity',()=>{
 const spec=proxyTunnelArgs({host:'ecs.example',port:22,knownHostsFile:'known_hosts'},'/collector');
 assert.equal(spec.key,require('node:path').join('/collector','proxy_tunnel_ed25519'));
 const joined=spec.argv.join(' ');
 assert.match(joined,/127\.0\.0\.1:17890:127\.0\.0\.1:7890/);
 assert.match(joined,/qr-proxy-tunnel@ecs\.example/);
 assert.ok(!joined.includes('0.0.0.0'));assert.ok(!joined.includes('qr-collector@'));
});
function enrichmentFixture(t,{platform='zhihu',kind='answers'}={}){
 const {ReaderService}=require('../reader-bridge/service');const db=new Database(':memory:');t.after(()=>db.close());
 const source={id:'enrich-source',name:'Enrich author',platform,url:platform==='zhihu'?'https://www.zhihu.com/people/enrich-author':'https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567',tags:[],adapter:{id:platform==='zhihu'?'enrich-author':'0123456789abcdef01234567'}};
 const config={adapters:{desktopPlatforms:[platform]}},channel=channelsFor(source,config.adapters).find(c=>c.label===kind);db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=17 WHERE id=?',channel.id);
 const url=platform==='zhihu'?(kind==='answers'?'https://www.zhihu.com/question/123/answer/456':'https://zhuanlan.zhihu.com/p/789'):'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01?xsec_token=signed';
 let upstream={id:101,title:'Restricted article',url,author:'Author',published_at:'2026-09-19T00:00:00Z',content:'',status:'unread'},puts=[];
 const mf={call:async(path,method='GET',payload)=>{if(path==='/v1/entries/101'&&method==='GET')return upstream;if(path==='/v1/entries/101'&&method==='PUT'){puts.push(payload);upstream={...upstream,title:payload.title??upstream.title,content:payload.content??upstream.content};return {};}throw new Error('unexpected mf '+method+' '+path);}};
 const service=new ReaderService(db,{...config,miniflux:'http://unused',karakeep:'http://unused',karakeepToken:'',adapters:config.adapters},{mf});service.project(upstream,channel);
 const collector=new DesktopCollector(service);service.desktop=collector;return {db,service,collector,source,channel,getUpstream:()=>upstream,puts};
}
test('desktop enrichment is capability-gated and does not starve behind scheduled list jobs',t=>{
 const legacyFixture=enrichmentFixture(t);legacyFixture.collector.queueEnrichment(101);
 const legacy=legacyFixture.collector.claim(['zhihu']);assert.ok(legacy.job);assert.equal(legacy.job.taskType,undefined);
 const compatibleFixture=enrichmentFixture(t);compatibleFixture.collector.queueEnrichment(101);
 const compatible=compatibleFixture.collector.claim(['zhihu'],['entry_body_v1']);assert.equal(compatible.job.taskType,'entry_body_v1');assert.equal(compatible.job.entryId,101);assert.equal(compatible.job.url,'https://www.zhihu.com/question/123/answer/456');
 assert.deepEqual(Object.keys(compatible.job).sort(),['authorId','entryId','kind','leaseId','platform','sourceId','taskType','title','url'].sort());
});
test('successful desktop enrichment upgrades only article content and preserves source health/read metadata',async t=>{
 const f=enrichmentFixture(t);f.collector.queueEnrichment(101);const claimed=f.collector.claim(['zhihu'],['entry_body_v1']);
 const before=f.db.get('SELECT status,published_at FROM entries WHERE id=101'),channelBefore=f.db.get('SELECT last_success,state FROM channels WHERE id=?',f.channel.id);
 const result={leaseId:claimed.job.leaseId,entryId:101,status:'OK',content:'Full body <script>must stay text</script>\n\nSecond paragraph'};
 const ack=await f.collector.submit(result);assert.equal(ack.state,'ENRICHED');assert.equal(ack.updated,true);assert.equal(f.puts.length,1);assert.match(f.puts[0].content,/&lt;script&gt;/);assert.doesNotMatch(f.puts[0].content,/<script>/);
 const row=f.db.get('SELECT status,published_at,content_state,content_origin,archive_state FROM entries WHERE id=101');assert.equal(row.status,before.status);assert.equal(row.published_at,before.published_at);assert.equal(row.content_state,'TEXT');assert.equal(row.content_origin,'desktop_enrichment');
 const channelAfter=f.db.get('SELECT last_success,state FROM channels WHERE id=?',f.channel.id);assert.deepEqual(channelAfter,channelBefore);
 assert.deepEqual(await f.collector.submit(result),ack);await assert.rejects(f.collector.submit({...result,content:'changed'}),/changed enrichment replay/);
});
test('desktop enrichment failures keep old content and only confirmed auth failure freezes credentials',async t=>{
 const f=enrichmentFixture(t);f.collector.queueEnrichment(101);let claim=f.collector.claim(['zhihu'],['entry_body_v1']);
 let ack=await f.collector.submit({leaseId:claim.job.leaseId,entryId:101,status:'ACCESS_BLOCKED'});assert.equal(ack.updated,false);assert.equal(f.db.get('SELECT content_state FROM entries WHERE id=101').content_state,'META');assert.equal(f.db.get('SELECT state FROM groups').state,'UNKNOWN');
 f.collector.queueEnrichment(101);f.db.run('UPDATE collector_enrichments SET next_attempt=0');f.db.run('UPDATE groups SET next_allowed=0');claim=f.collector.claim(['zhihu'],['entry_body_v1']);
 ack=await f.collector.submit({leaseId:claim.job.leaseId,entryId:101,status:'AUTH_REQUIRED'});assert.equal(ack.state,'AUTH_REQUIRED');assert.equal(f.db.get('SELECT state FROM groups').state,'AUTH_REQUIRED');assert.equal(f.db.get('SELECT state FROM channels').state,'NEVER_CHECKED');
 const resumed=f.collector.resume('zhihu',Date.now()+86500000);assert.equal(resumed.resumed,true);assert.equal(f.db.get('SELECT state FROM collector_enrichments').state,'QUEUED');
});
test('desktop enrichment rejects challenge pages and oversize content before Miniflux write',async t=>{
 const f=enrichmentFixture(t);f.collector.queueEnrichment(101);let claim=f.collector.claim(['zhihu'],['entry_body_v1']);
 await assert.rejects(f.collector.submit({leaseId:claim.job.leaseId,entryId:101,status:'OK',content:'请登录后查看全文'}),/invalid enrichment body/);assert.equal(f.puts.length,0);
 f.db.run("UPDATE collector_enrichments SET state='QUEUED',lease_id=NULL,expires_at=0,digest=NULL,next_attempt=0");f.db.run('UPDATE groups SET next_allowed=0');claim=f.collector.claim(['zhihu'],['entry_body_v1']);
 await assert.rejects(f.collector.submit({leaseId:claim.job.leaseId,entryId:101,status:'OK',content:'x'.repeat(1024*1024+1)}),/invalid enrichment body/);assert.equal(f.puts.length,0);
});
test('Windows enrichment normalizer keeps only the known article body and verifies answer identity',()=>{
 const job={taskType:'entry_body_v1',entryId:7,platform:'zhihu',kind:'answers',authorId:'author',url:'https://www.zhihu.com/question/123/answer/456'};
 const result=normalizeEnrichment(job,[{id:'456',url:job.url,content:'complete answer',votes:99,cookie:'secret'}]);
 assert.deepEqual(result,{entryId:7,content:'complete answer'});
 assert.throws(()=>normalizeEnrichment(job,[{url:'https://www.zhihu.com/question/123/answer/999',content:'wrong'}]),/identity mismatch/);
});
test('Windows enrichment normalizer extracts only Xiaohongshu content rows and preserves signed target validation',()=>{
 const job={taskType:'entry_body_v1',entryId:8,platform:'xiaohongshu',kind:'notes',authorId:'0123456789abcdef01234567',url:'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01?xsec_token=signed'};
 const payload=[{field:'title',value:'T'},{field:'content',value:'full note text'},{field:'likes',value:'88'},{field:'cookie',value:'never upload'}];
 assert.deepEqual(normalizeEnrichment(job,payload),{entryId:8,content:'full note text'});
});
test('Windows enrichment normalizer accepts Zhihu article stdout but bounds the payload',()=>{
 const job={taskType:'entry_body_v1',entryId:9,platform:'zhihu',kind:'articles',authorId:'author',url:'https://zhuanlan.zhihu.com/p/789'};
 assert.deepEqual(normalizeEnrichment(job,'# Title\n\narticle markdown'),{entryId:9,content:'# Title\n\narticle markdown'});
 assert.throws(()=>normalizeEnrichment(job,'x'.repeat(1024*1024+1)),/too large/);
});
test('native body enrichment status is authenticated and queueing is action-gated',async t=>{
 const f=enrichmentFixture(t),app=createApp(f.service,{accessToken:'reader-test',collectorToken:'collector-test'});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.close(r)));
 const base='http://127.0.0.1:'+app.address().port,auth={'X-Qr-Token':'reader-test','Content-Type':'application/json'},write={...auth,'X-QR-Action':'1'};
 assert.equal((await fetch(base+'/desk/api/entries/101/enrichment')).status,401);
 let response=await fetch(base+'/desk/api/entries/101/enrichment',{headers:auth});assert.equal(response.status,200);assert.equal((await response.json()).state,'NONE');
 assert.equal((await fetch(base+'/desk/api/entries/101/enrichment',{method:'POST',headers:auth,body:'{}'})).status,403);
 response=await fetch(base+'/desk/api/entries/101/enrichment',{method:'POST',headers:write,body:'{}'});assert.equal(response.status,202);assert.equal((await response.json()).state,'QUEUED');
});
test('Windows collector advertises enrichment capability without changing normal source-list result shape',()=>{
 const fs=require('node:fs'),path=require('node:path'),src=fs.readFileSync(path.join(__dirname,'../tools/windows/collector.cjs'),'utf8');
 assert.match(src,/capabilities:\['entry_body_v1'\]/);assert.match(src,/taskType==='entry_body_v1'/);assert.match(src,/answer-detail/);assert.match(src,/xiaohongshu','note/);assert.match(src,/web','read/);
 assert.doesNotMatch(src,/job\.command|job\.argv|job\.output/);
});
test('Windows enrichment normalizer rejects short login and challenge bodies before upload',()=>{
 const article={taskType:'entry_body_v1',entryId:10,platform:'zhihu',kind:'articles',authorId:'author',url:'https://zhuanlan.zhihu.com/p/789'};
 assert.throws(()=>normalizeEnrichment(article,'请登录后查看全文'),/login or challenge/);
 const xhs={taskType:'entry_body_v1',entryId:11,platform:'xiaohongshu',kind:'notes',authorId:'0123456789abcdef01234567',url:'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01?xsec_token=signed'};
 assert.throws(()=>normalizeEnrichment(xhs,[{field:'content',value:'验证码 安全限制'}]),/login or challenge/);
});
