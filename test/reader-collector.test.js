'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Database}=require('../reader-bridge/database');
const {channelsFor}=require('../reader-bridge/core');
const {DesktopCollector,validateItems}=require('../reader-bridge/desktop-collector');
const {normalize,normalizeEnrichment,normalizeYtDlpJson3,normalizeYoutubeTranscript,selectFreshXhsNoteUrl,statusFor}=require('../tools/windows/normalize.cjs');
const {confirmedCollect,authRecovered,proxyTunnelArgs,runOpencliRead}=require('../tools/windows/collector.cjs');
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
 assert.deepEqual(Object.keys(r.job).sort(),['authorId','backendId','kind','leaseId','limit','name','platform','sourceId'].sort());
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
 const waiting=f.db.get('SELECT next_attempt,error FROM collector_enrichments WHERE entry_id=101');assert.ok(waiting.next_attempt>Date.now());assert.ok(waiting.error);
 f.collector.queueEnrichment(101);assert.equal(f.db.get('SELECT next_attempt FROM collector_enrichments WHERE entry_id=101').next_attempt,0);assert.equal(f.db.get('SELECT error FROM collector_enrichments WHERE entry_id=101').error,'');f.db.run('UPDATE groups SET next_allowed=0');claim=f.collector.claim(['zhihu'],['entry_body_v1']);
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
 assert.match(src,/function workerCapabilities\(\)/);assert.match(src,/out\.push\('podcast_transcript_v1'\)/);assert.match(src,/taskType==='entry_body_v1'/);assert.match(src,/answer-detail/);assert.match(src,/xiaohongshu','user'/);assert.match(src,/--limit','50'/);assert.match(src,/xiaohongshu','note/);assert.match(src,/web','read/);
 assert.match(src,/result\.entryId\?`ECS accepted article-body result/);assert.doesNotMatch(src,/job\.command|job\.argv|job\.output/);
});
test('Windows enrichment normalizer rejects short login and challenge bodies before upload',()=>{
 const article={taskType:'entry_body_v1',entryId:10,platform:'zhihu',kind:'articles',authorId:'author',url:'https://zhuanlan.zhihu.com/p/789'};
 assert.throws(()=>normalizeEnrichment(article,'请登录后查看全文'),/login or challenge/);
 const xhs={taskType:'entry_body_v1',entryId:11,platform:'xiaohongshu',kind:'notes',authorId:'0123456789abcdef01234567',url:'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01?xsec_token=signed'};
 assert.throws(()=>normalizeEnrichment(xhs,[{field:'content',value:'验证码 安全限制'}]),/login or challenge/);
});
test('Xiaohongshu enrichment refreshes the signed URL by exact author-list note identity',()=>{
 const job={taskType:'entry_body_v1',entryId:12,platform:'xiaohongshu',kind:'notes',authorId:'0123456789abcdef01234567',url:'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01?xsec_token=stale'};
 const fresh='https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01?xsec_token=fresh';
 const rows=[{id:'ffffffffffffffffffffffff',url:'https://www.xiaohongshu.com/explore/ffffffffffffffffffffffff?xsec_token=other'},{id:'abcdef0123456789abcdef01',url:fresh}];
 assert.equal(selectFreshXhsNoteUrl(job,rows),fresh);
 assert.equal(selectFreshXhsNoteUrl(job,[{id:'000000000000000000000000',url:fresh}]),'');
});
test('read-only OpenCLI retries Chromium Navigation rejected exactly once with trace retention',()=>{
 const calls=[],spawn=(node,argv,options)=>{calls.push({node,argv:[...argv],options});return calls.length===1?{status:1,stderr:'Navigation rejected.',stdout:''}:{status:0,stderr:'',stdout:'[]'};};
 const argv=['opencli-main.js','xiaohongshu','user','author','--trace','off','-f','json'];
 const result=runOpencliRead({profile:''},argv,spawn);
 assert.equal(result.status,0);assert.equal(result.qrNavigationRetried,true);assert.equal(calls.length,2);
 assert.equal(calls[0].argv[calls[0].argv.indexOf('--trace')+1],'off');
 assert.equal(calls[1].argv[calls[1].argv.indexOf('--trace')+1],'retain-on-failure');
 assert.equal(argv[argv.indexOf('--trace')+1],'off');
});
test('read-only OpenCLI does not retry unrelated failures',()=>{
 let calls=0;const spawn=()=>{calls++;return {status:1,stderr:'HTTP 403 access denied',stdout:''};};
 const result=runOpencliRead({profile:''},['opencli-main.js','xiaohongshu','user','author','--trace','off'],spawn);
 assert.equal(result.status,1);assert.equal(calls,1);assert.equal(result.qrNavigationRetried,undefined);
});


test('Twitter CLI and OpenCLI rows normalize to the same canonical tweet identity',()=>{
 const job={platform:'twitter',kind:'tweets',authorId:'karpathy',name:'Andrej Karpathy'};
 const id='2086848998204473743',when='Thu Jul 10 12:15:47 +0000 2026';
 const cli=normalize(job,[{id,text:'same tweet text',author:{screenName:'karpathy'},createdAtISO:'2026-07-10T12:15:47Z'}])[0];
 const opencli=normalize(job,[{id,text:'same tweet text',author:'karpathy',created_at:when,url:'https://x.com/karpathy/status/'+id}])[0];
 assert.equal(cli.link,'https://x.com/karpathy/status/'+id);
 assert.equal(opencli.link,cli.link);
 assert.equal(cli.published,opencli.published);
 assert.equal(cli.summary,'same tweet text');
 assert.equal(opencli.summary,'same tweet text');
 const validated=validateItems({platform:'twitter',label:'tweets',authorId:'karpathy'},[cli])[0];
 assert.equal(validated.guid,id);
 assert.equal(validated.link,cli.link);
});

test('Twitter normalization rejects another author even when tweet ID and URL shape are valid',()=>{
 const job={platform:'twitter',kind:'tweets',authorId:'karpathy'};
 assert.throws(()=>normalize(job,[{id:'2086848998204473743',text:'wrong author',author:'ylecun',created_at:'Thu Jul 10 12:15:47 +0000 2026',url:'https://x.com/ylecun/status/2086848998204473743'}]),/author mismatch/);
 assert.throws(()=>validateItems({platform:'twitter',label:'tweets',authorId:'karpathy'},[{title:'wrong',link:'https://x.com/ylecun/status/2086848998204473743',published:null,summary:''}]),/original URL/);
});

test('Twitter media-only rows still get a stable non-empty card title',()=>{
 const job={platform:'twitter',kind:'tweets',authorId:'karpathy',name:'Andrej Karpathy'};
 const [item]=normalize(job,[{id:'2086848998204473743',text:'',author:{screenName:'karpathy'},createdAtISO:'2026-07-10T12:15:47Z'}]);
 assert.equal(item.title,'Andrej Karpathy 的 X 帖子');
 assert.equal(item.summary,'');
});


function twitterRouteFixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());
 const source={id:'twitter-source',name:'Twitter Author',platform:'twitter',url:'https://x.com/karpathy',feeds:['https://api.xgo.ing/rss/user/abc'],tags:[],enabled:true};
 const channel={id:'twitter-channel',source_id:source.id,label:'https://api.xgo.ing/rss/user/abc',transport:'public',url:'https://api.xgo.ing/rss/user/abc',group_key:'api.xgo.ing',enabled:true,interval_ms:1800000,min_gap_ms:0};
 db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=7 WHERE id=?',channel.id);
 const stored=[];
 const service={db,config:{adapters:{desktopPlatforms:['twitter']}},provisionChannels:async()=>{},importItem:async(c,item)=>{stored.push({channel:c.id,item});return 1;},finish:(job,state,error)=>db.run('UPDATE jobs SET state=?,error=?,finished_at=? WHERE id=?',state,error,Date.now(),job.id),pump:async()=>{}};
 const collector=new DesktopCollector(service);service.desktop=collector;
 return {db,source,channel,service,collector,stored};
}
test('healthy Twitter direct backend claims the existing xgo logical channel without creating a second channel',t=>{
 const f=twitterRouteFixture(t);f.db.createRun([f.channel],'manual');
 const result=f.collector.claim(['twitter'],[],{'twitter-cli-shervin':{status:'ok',reason:'verified explicit client',state:'READY'}});
 assert.ok(result.job);assert.equal(result.job.platform,'twitter');assert.equal(result.job.authorId,'karpathy');assert.equal(result.job.kind,'tweets');assert.equal(result.job.backendId,'twitter-cli-shervin');
 const lease=f.db.get('SELECT channel_id,backend_id FROM collector_leases WHERE id=?',result.job.leaseId);
 assert.equal(lease.channel_id,'twitter-channel');assert.equal(lease.backend_id,'twitter-cli-shervin');
 assert.equal(f.db.channels().filter(c=>c.source_id==='twitter-source').length,1);
 assert.equal(f.db.channels()[0].transport,'public');
});
test('successful Twitter direct collection updates the shared logical channel but not the xgo physical group',async t=>{
 const f=twitterRouteFixture(t);f.db.createRun([f.channel],'manual');
 const claim=f.collector.claim(['twitter'],[],{'twitter-cli-shervin':{status:'ok',reason:'verified',state:'READY'}});
 const before=f.db.get('SELECT * FROM groups WHERE id=?','api.xgo.ing');
 const ack=await f.collector.submit({leaseId:claim.job.leaseId,status:'OK',items:[{title:'tweet',link:'https://x.com/karpathy/status/2086848998204473743',published:1786378547000,summary:'tweet body'}]});
 assert.equal(ack.state,'SUCCEEDED_PARTIAL');assert.equal(ack.backendId,'twitter-cli-shervin');assert.equal(f.stored.length,1);assert.equal(f.stored[0].item.guid,'2086848998204473743');
 const after=f.db.get('SELECT * FROM groups WHERE id=?','api.xgo.ing');assert.deepEqual(after,before);
 assert.equal(f.db.get('SELECT state FROM collector_backend_health WHERE id=?','twitter-cli-shervin').state,'OK');
 assert.equal(f.db.get('SELECT state FROM jobs LIMIT 1').state,'SUCCEEDED_PARTIAL');
});
test('failed Twitter direct backend requeues the same job and restores xgo as the active fallback',async t=>{
 const f=twitterRouteFixture(t);let pumps=0;f.service.pump=async()=>{pumps++;};
 f.db.createRun([f.channel],'manual');
 const claim=f.collector.claim(['twitter'],[],{'twitter-cli-shervin':{status:'ok',reason:'verified',state:'READY'}});
 const ack=await f.collector.submit({leaseId:claim.job.leaseId,status:'TIMEOUT',items:[]});
 assert.equal(ack.state,'FALLBACK_QUEUED');assert.equal(ack.failedState,'TIMEOUT');
 assert.equal(f.db.get('SELECT state FROM jobs LIMIT 1').state,'QUEUED');
 assert.equal(f.db.get('SELECT state FROM groups WHERE id=?','api.xgo.ing').state,'UNKNOWN');
 assert.equal(f.db.get('SELECT state FROM collector_backend_health WHERE id=?','twitter-cli-shervin').state,'TIMEOUT');
 assert.equal(f.collector.ownsChannel(f.db.channels()[0],f.db.sources()[0]),false);
 const cap=require('../reader-bridge/capabilities').sourceCapabilities(f.db.sources()[0],f.db.channels(),{collector:f.collector.status(),backendStatus:f.collector.backendStatus()})[0];
 assert.equal(cap.activeBackend,'xgo-twitter-feed');
 await new Promise(r=>setImmediate(r));assert.equal(pumps,1);
});


test('ECS pump leaves a Twitter xgo job queued while a verified Shervin backend owns the capability, then uses xgo after backend failure',async t=>{
 const {ReaderService}=require('../reader-bridge/service');
 const db=new Database(':memory:');t.after(()=>db.close());
 const source={id:'tw-pump',name:'Twitter Author',platform:'twitter',url:'https://x.com/karpathy',feeds:['https://api.xgo.ing/rss/user/abc'],tags:[],enabled:true};
 const channel={id:'tw-pump-channel',source_id:source.id,label:'https://api.xgo.ing/rss/user/abc',transport:'public',url:'https://api.xgo.ing/rss/user/abc',group_key:'api.xgo.ing',enabled:true,interval_ms:1800000,min_gap_ms:0};
 db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=7 WHERE id=?',channel.id);
 let fetches=0;
 const service=new ReaderService(db,{adapters:{desktopPlatforms:['twitter']},miniflux:'http://unused',karakeep:'http://unused'},{mf:{call:async()=>[]}});
 service.refreshPublic=async()=>{fetches++;return 0;};
 const collector=new DesktopCollector(service);service.desktop=collector;
 collector.recordBackendStatus({'twitter-cli-shervin':{status:'ok',reason:'verified',state:'READY'}});
 db.createRun([channel],'manual');await service.pump();
 assert.equal(fetches,0);assert.equal(db.get('SELECT state FROM jobs LIMIT 1').state,'QUEUED');
 collector.backendFailure('twitter-cli-shervin','TIMEOUT','timeout');
 await service.pump();assert.equal(fetches,1);
 assert.notEqual(db.get('SELECT state FROM jobs LIMIT 1').state,'QUEUED');
});

test('scheduled Twitter direct ownership ignores the xgo physical group health until fallback is needed',t=>{
 const {ReaderService}=require('../reader-bridge/service');
 const db=new Database(':memory:');t.after(()=>db.close());
 const source={id:'tw-tick',name:'Twitter Author',platform:'twitter',url:'https://x.com/karpathy',feeds:['https://api.xgo.ing/rss/user/abc'],tags:[],enabled:true};
 const channel={id:'tw-tick-channel',source_id:source.id,label:'https://api.xgo.ing/rss/user/abc',transport:'public',url:'https://api.xgo.ing/rss/user/abc',group_key:'api.xgo.ing',enabled:true,interval_ms:1800000,min_gap_ms:0};
 db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=7,next_check=0 WHERE id=?',channel.id);db.run("UPDATE groups SET state='AUTH_REQUIRED',next_allowed=? WHERE id=?",Date.now()+86400000,'api.xgo.ing');
 const service=new ReaderService(db,{schedulerEnabled:true,adapters:{desktopPlatforms:['twitter']},miniflux:'http://unused',karakeep:'http://unused'},{mf:{call:async()=>[]}});
 service.monitor=()=>{};service.sendNotifications=async()=>{};service.pump=async()=>{};
 const collector=new DesktopCollector(service);service.desktop=collector;collector.recordBackendStatus({'twitter-cli-shervin':{status:'ok',reason:'verified',state:'READY'}});
 service.tick();assert.equal(db.get("SELECT count(*) n FROM jobs WHERE channel_id=? AND state='QUEUED'",channel.id).n,1);
});

test('explicit Twitter Python wrapper never imports browser-cookie auth and filters retweets',t=>{
 const os=require('node:os'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qr-twitter-wrapper-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const pkg=path.join(dir,'twitter_cli');fs.mkdirSync(pkg);fs.writeFileSync(path.join(pkg,'__init__.py'),'');
 fs.writeFileSync(path.join(pkg,'client.py'),[
   'from types import SimpleNamespace',
   'class TwitterClient:',
   '  def __init__(self, auth_token, ct0, rate_limit_config=None, cookie_string=None):',
   '    assert auth_token == "explicit-auth" and ct0 == "explicit-ct0"',
   '  def fetch_user(self, handle): return SimpleNamespace(id="u1", screen_name=handle)',
   '  def fetch_user_tweets(self, user_id, limit):',
   '    a=SimpleNamespace(screen_name="karpathy")',
   '    return [SimpleNamespace(is_retweet=False, author=a, payload={"id":"1","text":"ok","author":{"screenName":"karpathy"},"createdAtISO":"2026-09-20T00:00:00Z"}), SimpleNamespace(is_retweet=True, author=a, payload={"id":"2"})]'
 ].join('\n'));
 fs.writeFileSync(path.join(pkg,'serialization.py'),'def tweet_to_dict(tweet): return tweet.payload\n');
 const wrapper=path.join(__dirname,'../tools/windows/twitter-explicit.py');
 const run=spawnSync('python3',[wrapper,'karpathy','20'],{encoding:'utf8',env:{...process.env,PYTHONPATH:dir,TWITTER_AUTH_TOKEN:'explicit-auth',TWITTER_CT0:'explicit-ct0'}});
 assert.equal(run.status,0,run.stderr);const rows=JSON.parse(run.stdout);assert.equal(rows.length,1);assert.equal(rows[0].id,'1');
 const code=fs.readFileSync(wrapper,'utf8');assert.doesNotMatch(code,/^\s*(?:from|import)\s+twitter_cli\.auth/m);assert.doesNotMatch(code,/browser_cookie3/);
 const noCreds=spawnSync('python3',[wrapper,'karpathy','1'],{encoding:'utf8',env:{...process.env,PYTHONPATH:dir,TWITTER_AUTH_TOKEN:'',TWITTER_CT0:''}});
 assert.equal(noCreds.status,77);
});


test('Instagram rows normalize stable shortcode identity, time and author',()=>{
 const job={platform:'instagram',kind:'posts',authorId:'nasa',name:'NASA'};
 const [item]=normalize(job,[{id:'1234567890123456789',code:'ABC_def-12',author:'nasa',caption:'Moon image',taken_at:1789700000,media_type:1,url:'https://www.instagram.com/p/ABC_def-12/'}]);
 assert.equal(item.link,'https://www.instagram.com/p/ABC_def-12/');
 assert.equal(item.published,1789700000000);
 assert.equal(item.title,'Moon image');assert.equal(item.summary,'Moon image');assert.equal(item.author,'nasa');
 const [validated]=validateItems({platform:'instagram',label:'posts',authorId:'nasa'},[item]);
 assert.equal(validated.guid,'instagram:ABC_def-12');assert.equal(validated.author,'nasa');assert.equal(validated.content_state,'PARTIAL');
});
test('Instagram item author and shortcode mismatch are rejected on both worker and ECS boundaries',()=>{
 const job={platform:'instagram',kind:'posts',authorId:'nasa'};
 assert.throws(()=>normalize(job,[{id:'1',code:'ABC_def-12',author:'other',caption:'x',taken_at:1789700000,url:'https://www.instagram.com/p/ABC_def-12/'}]),/author mismatch/);
 assert.throws(()=>normalize(job,[{id:'1',code:'DIFFERENT1',author:'nasa',caption:'x',taken_at:1789700000,url:'https://www.instagram.com/p/ABC_def-12/'}]),/shortcode mismatch/);
 assert.throws(()=>validateItems({platform:'instagram',label:'posts',authorId:'nasa'},[{title:'x',link:'https://www.instagram.com/p/ABC_def-12/',published:1789900000000,summary:'x',author:'other'}]),/author/);
});
test('Instagram desktop source is only claimable after its platform backend passes an explicit canary',t=>{
 const db=new Database(':memory:');t.after(()=>db.close());
 const source={id:'ig-source',name:'NASA',platform:'instagram',url:'https://www.instagram.com/nasa/',tags:[],adapter:{platform:'instagram',id:'nasa'},enabled:true};
 const config={adapters:{desktopPlatforms:['instagram']}},channel=channelsFor(source,config.adapters)[0];
 db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=19 WHERE id=?',channel.id);
 const service={db,config,provisionChannels:async()=>{},finish:(job,state,error)=>db.run('UPDATE jobs SET state=?,error=? WHERE id=?',state,error,job.id)};
 const collector=new DesktopCollector(service);service.desktop=collector;db.createRun([channel],'manual');
 const blocked=collector.claim(['instagram'],[],{'opencli-instagram-shervin':{status:'off',reason:'login canary not verified',state:'UNVERIFIED'}});
 assert.equal(blocked.job,null);
 const claimed=collector.claim(['instagram'],[],{'opencli-instagram-shervin':{status:'ok',reason:'read-only canary passed',state:'READY'}});
 assert.ok(claimed.job);assert.equal(claimed.job.platform,'instagram');assert.equal(claimed.job.authorId,'nasa');assert.equal(claimed.job.kind,'posts');assert.equal(claimed.job.backendId,'opencli-instagram-shervin');
});

test('Instagram auth recovery probe names the platform backend and is explicitly read-only',t=>{
 const db=new Database(':memory:');t.after(()=>db.close());
 const source={id:'ig-source',name:'NASA',platform:'instagram',url:'https://www.instagram.com/nasa/',tags:[],adapter:{platform:'instagram',id:'nasa'},enabled:true};
 const config={adapters:{desktopPlatforms:['instagram']}},channel=channelsFor(source,config.adapters)[0];db.putSource(source,[channel]);db.run("UPDATE channels SET feed_id=19,state='AUTH_REQUIRED' WHERE id=?",channel.id);db.run("INSERT OR REPLACE INTO groups(id,state,next_allowed,last_success,failures) VALUES('credential:instagram','AUTH_REQUIRED',0,0,1)");
 const service={db,config,provisionChannels:async()=>{},finish:()=>{}};const collector=new DesktopCollector(service);service.desktop=collector;
 const probe=collector.authProbe(['instagram']);assert.equal(probe.platform,'instagram');assert.equal(probe.authorId,'nasa');assert.equal(probe.kind,'posts');assert.equal(probe.backendId,'opencli-instagram-shervin');assert.equal(probe.authProbe,true);
});

function youtubeTranscriptFixture(t){
 const {ReaderService}=require('../reader-bridge/service');
 const db=new Database(':memory:');t.after(()=>db.close());
 const source={id:'yt-source',name:'YouTube source',platform:'youtube',url:'https://www.youtube.com/@example',tags:[],feeds:['https://www.youtube.com/feeds/videos.xml?channel_id=UCfixture'],enabled:true};
 const channel={id:'yt-channel',source_id:source.id,label:'rss',transport:'public',url:source.feeds[0],enabled:true,group_key:'youtube.com',interval_ms:1800000,min_gap_ms:0};
 db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=23,last_success=?,state=? WHERE id=?',1234567890,'SUCCEEDED_NO_NEW',channel.id);
 let upstream={id:901,title:'Video',url:'https://www.youtube.com/watch?v=TlR7douxQRM',author:'Channel',published_at:'2026-09-20T00:00:00Z',content:'<p>Feed body</p>',status:'unread'},puts=[];
 const mf={call:async(path,method='GET',payload)=>{if(path==='/v1/entries/901'&&method==='GET')return upstream;if(path==='/v1/entries/901'&&method==='PUT'){puts.push(payload);upstream={...upstream,title:payload.title??upstream.title,content:payload.content??upstream.content};return {};}throw new Error('unexpected mf '+method+' '+path);}};
 const service=new ReaderService(db,{karakeep:'http://unused',karakeepToken:'',adapters:{}},{mf});service.project(upstream,channel);
 const collector=new DesktopCollector(service);service.desktop=collector;return {db,service,collector,source,channel,puts,getUpstream:()=>upstream};
}

test('YouTube original links normalize watch and youtu.be routes to one video identity',()=>{
 const {originalLink}=require('../tools/windows/original-link.cjs');
 const a=originalLink({platform:'youtube',kind:'transcript'},'https://www.youtube.com/watch?v=TlR7douxQRM');
 const b=originalLink({platform:'youtube',kind:'transcript'},'https://youtu.be/TlR7douxQRM');
 assert.equal(a.guid,'youtube:TlR7douxQRM');assert.equal(b.guid,a.guid);assert.equal(b.link,a.link);
 assert.throws(()=>originalLink({platform:'youtube',kind:'transcript'},'https://www.youtube.com/playlist?list=PL123'),/mismatch/);
});

test('yt-dlp JSON3 subtitles normalize into bounded transcript rows',()=>{
 const job={taskType:'youtube_transcript_v1',platform:'youtube',entryId:901,url:'https://www.youtube.com/watch?v=TlR7douxQRM'};
 const payload={events:[
  {tStartMs:0,segs:[{utf8:'Hello '},{utf8:'world'}]},
  {tStartMs:1200,segs:[{utf8:'Second line'}]},
  {tStartMs:2400,segs:[{utf8:'Second line'}]},
  {tStartMs:65000,segs:[{utf8:'After a minute'}]}
 ]};
 const out=normalizeYtDlpJson3(job,payload);
 assert.equal(out.videoId,'TlR7douxQRM');assert.equal(out.segmentCount,3);
 assert.match(out.content,/\[0:00\] Hello world/);assert.match(out.content,/\[1:05\] After a minute/);
});

test('YouTube transcript queue is explicit and uses the existing entry identity',t=>{
 const f=youtubeTranscriptFixture(t);
 const initial=f.collector.transcriptStatus(901);assert.equal(initial.state,'NONE');assert.equal(initial.eligible,true);
 const queued=f.collector.queueTranscript(901);assert.equal(queued.state,'QUEUED');
 const claim=f.collector.claim(['youtube'],['youtube_transcript_v1']);assert.equal(claim.job.taskType,'youtube_transcript_v1');assert.equal(claim.job.entryId,901);
 assert.equal(claim.job.url,'https://www.youtube.com/watch?v=TlR7douxQRM');assert.equal(claim.job.kind,'transcript');
});

test('successful YouTube transcript enrichment preserves read state, publication time and source health',async t=>{
 const f=youtubeTranscriptFixture(t);f.collector.queueTranscript(901);const claim=f.collector.claim(['youtube'],['youtube_transcript_v1']);
 const before=f.db.get('SELECT status,published_at,url FROM entries WHERE id=901'),channelBefore=f.db.get('SELECT last_success,state FROM channels WHERE id=?',f.channel.id);
 const result={leaseId:claim.job.leaseId,entryId:901,status:'OK',backendId:'opencli-youtube-shervin',videoId:'TlR7douxQRM',segmentCount:2,content:'[0:00] hello\n[0:05] world'};
 const ack=await f.collector.submit(result);assert.equal(ack.state,'TRANSCRIPT_ENRICHED');assert.equal(ack.backendId,'opencli-youtube-shervin');
 const row=f.db.get('SELECT status,published_at,url,content_origin FROM entries WHERE id=901');assert.equal(row.status,before.status);assert.equal(row.published_at,before.published_at);assert.equal(row.url,before.url);assert.equal(row.content_origin,'youtube_transcript_enrichment');
 assert.deepEqual(f.db.get('SELECT last_success,state FROM channels WHERE id=?',f.channel.id),channelBefore);
 assert.equal(f.puts.length,1);assert.match(f.puts[0].content,/data-qr-youtube-transcript="TlR7douxQRM"/);assert.match(f.puts[0].content,/\[0:00\] hello/);
 const detail=JSON.parse(f.db.get("SELECT detail FROM entry_enrichments WHERE entry_id=901 AND kind='youtube_transcript_v1'").detail);assert.equal(detail.backend,'opencli-youtube-shervin');
 assert.deepEqual(await f.collector.submit(result),ack);await assert.rejects(f.collector.submit({...result,content:'changed'}),/changed transcript replay/);
});

test('YouTube transcript submit rejects mismatched video or unknown backend before Miniflux write',async t=>{
 const f=youtubeTranscriptFixture(t);f.collector.queueTranscript(901);let claim=f.collector.claim(['youtube'],['youtube_transcript_v1']);
 await assert.rejects(f.collector.submit({leaseId:claim.job.leaseId,entryId:901,status:'OK',backendId:'opencli-youtube-shervin',videoId:'AAAAAAAAAAA',segmentCount:1,content:'x'}),/video mismatch/);
 assert.equal(f.puts.length,0);
 f.db.run("UPDATE collector_transcripts SET state='QUEUED',lease_id=NULL,expires_at=0,digest=NULL,next_attempt=0 WHERE entry_id=901");claim=f.collector.claim(['youtube'],['youtube_transcript_v1']);
 await assert.rejects(f.collector.submit({leaseId:claim.job.leaseId,entryId:901,status:'OK',backendId:'unknown',videoId:'TlR7douxQRM',segmentCount:1,content:'x'}),/invalid transcript backend/);
 assert.equal(f.puts.length,0);
});

test('YouTube worker implements Agent-Reach retry chain without downloading video',()=>{
 const fs=require('node:fs'),path=require('node:path'),src=fs.readFileSync(path.join(__dirname,'../tools/windows/collector.cjs'),'utf8');
 assert.match(src,/function collectYoutubeViaYtDlp/);assert.match(src,/--skip-download/);assert.match(src,/--sub-format','json3'/);assert.match(src,/fs\.rmSync\(dir/);
 assert.match(src,/backendId:'yt-dlp-shervin'/);assert.match(src,/backendId:'opencli-youtube-shervin'/);
 assert.ok(src.indexOf("collectYoutubeViaYtDlp(job)")<src.indexOf("config.opencliMain,'youtube','transcript'"));
});

test('native YouTube transcript status is authenticated and queueing is action-gated',async t=>{
 const f=youtubeTranscriptFixture(t),app=createApp(f.service,{accessToken:'reader-test',collectorToken:'collector-test'});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.close(r)));
 const base='http://127.0.0.1:'+app.address().port,auth={'X-Qr-Token':'reader-test','Content-Type':'application/json'},write={...auth,'X-QR-Action':'1'};
 assert.equal((await fetch(base+'/desk/api/entries/901/transcript')).status,401);
 let response=await fetch(base+'/desk/api/entries/901/transcript',{headers:auth});assert.equal(response.status,200);assert.equal((await response.json()).state,'NONE');
 assert.equal((await fetch(base+'/desk/api/entries/901/transcript',{method:'POST',headers:auth,body:'{}'})).status,403);
 response=await fetch(base+'/desk/api/entries/901/transcript',{method:'POST',headers:write,body:'{}'});assert.equal(response.status,202);assert.equal((await response.json()).state,'QUEUED');
});

function podcastTranscriptFixture(t,{length=82430062}={}){
 const {ReaderService}=require('../reader-bridge/service');
 const db=new Database(':memory:');t.after(()=>db.close());
 const feed='https://feeds.transistor.fm/recsperts-recommender-systems-experts',episode='https://share.transistor.fm/s/c07c7bf6',audio='https://media.transistor.fm/c07c7bf6/8a10e95d.mp3';
 const source={id:'pod-source',name:'Recsperts',platform:'podcast',url:'https://podcasts.apple.com/us/podcast/id1587222271',tags:[],feeds:[feed],enabled:true};
 const channel={id:'pod-channel',source_id:source.id,label:feed,transport:'public',url:feed,enabled:true,group_key:'feeds.transistor.fm',interval_ms:1800000,min_gap_ms:0};
 db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=24,last_success=?,state=? WHERE id=?',1234567890,'SUCCEEDED_NO_NEW',channel.id);
 let upstream={id:902,title:'Episode',url:episode,author:'Recsperts',published_at:'2026-09-20T00:00:00Z',content:'<p>Feed notes</p>',status:'unread'},puts=[];
 const mf={call:async(path,method='GET',payload)=>{if(path==='/v1/entries/902'&&method==='GET')return upstream;if(path==='/v1/entries/902'&&method==='PUT'){puts.push(payload);upstream={...upstream,title:payload.title??upstream.title,content:payload.content??upstream.content};return {};}throw new Error('unexpected mf '+method+' '+path);}};
 const xml='<rss><channel><title>R</title><item><guid>g</guid><title>Episode</title><link>'+episode+'</link><enclosure url="'+audio+'" type="audio/mpeg" length="'+length+'"/></item></channel></rss>';
 const calls=[],internalFetch=async(url,opts={})=>{calls.push({url,opts});if(url===feed)return {status:200,body:Buffer.from(xml),headers:{},url};if(url===audio&&opts.method==='HEAD')return {status:200,body:Buffer.alloc(0),headers:{'content-type':'audio/mpeg'},url};throw new Error('unexpected fetch '+url);};
 const service=new ReaderService(db,{karakeep:'http://unused',karakeepToken:'',adapters:{}},{mf,internalFetch});service.project(upstream,channel);
 const collector=new DesktopCollector(service);service.desktop=collector;return {db,service,collector,source,channel,feed,episode,audio,calls,puts,getUpstream:()=>upstream};
}

test('Podcast transcript request resolves audio only from the registered feed before queueing',async t=>{
 const f=podcastTranscriptFixture(t);const state=await f.service.requestTranscript(902);
 assert.equal(state.state,'QUEUED');assert.equal(state.kind,'podcast_transcript_v1');
 const task=f.db.get('SELECT kind,media_url,media_length FROM collector_transcripts WHERE entry_id=902');
 assert.equal(task.kind,'podcast_transcript_v1');assert.equal(task.media_url,f.audio);assert.equal(task.media_length,82430062);
 assert.deepEqual(f.calls.map(x=>[x.url,x.opts.method||'GET']),[[f.feed,'GET'],[f.audio,'HEAD']]);
 const claim=f.collector.claim(['podcast'],['podcast_transcript_v1']);
 assert.equal(claim.job.taskType,'podcast_transcript_v1');assert.equal(claim.job.audioUrl,f.audio);assert.equal(claim.job.mediaLength,82430062);
 assert.equal(f.db.get('SELECT expires_at FROM collector_transcripts WHERE entry_id=902').expires_at>Date.now()+50*60*1000,true);
});

test('Podcast audio larger than the local-transcription limit is refused before worker queueing',async t=>{
 const f=podcastTranscriptFixture(t,{length:513*1024*1024});
 await assert.rejects(f.service.requestTranscript(902),e=>e.status===413);
 assert.equal(f.db.get('SELECT count(*) n FROM collector_transcripts').n,0);
});

test('successful local Podcast transcript preserves entry identity, read state and source health',async t=>{
 const f=podcastTranscriptFixture(t);await f.service.requestTranscript(902);const claim=f.collector.claim(['podcast'],['podcast_transcript_v1']);
 const before=f.db.get('SELECT status,published_at,url FROM entries WHERE id=902'),channelBefore=f.db.get('SELECT last_success,state FROM channels WHERE id=?',f.channel.id);
 const mediaSha256=require('../reader-bridge/core').hash(f.audio),result={leaseId:claim.job.leaseId,entryId:902,status:'OK',backendId:'faster-whisper-local',mediaSha256,model:'base',language:'en',segmentCount:2,content:'[0:00] hello\n[0:05] world'};
 const ack=await f.collector.submit(result);assert.equal(ack.state,'TRANSCRIPT_ENRICHED');assert.equal(ack.backendId,'faster-whisper-local');
 const row=f.db.get('SELECT status,published_at,url,content_origin FROM entries WHERE id=902');assert.equal(row.status,before.status);assert.equal(row.published_at,before.published_at);assert.equal(row.url,before.url);assert.equal(row.content_origin,'podcast_local_transcript_enrichment');
 assert.deepEqual(f.db.get('SELECT last_success,state FROM channels WHERE id=?',f.channel.id),channelBefore);
 assert.equal(f.puts.length,1);assert.match(f.puts[0].content,/data-qr-podcast-transcript="902"/);assert.match(f.puts[0].content,/\[0:00\] hello/);
 const detail=JSON.parse(f.db.get("SELECT detail FROM entry_enrichments WHERE entry_id=902 AND kind='podcast_transcript_v1'").detail);assert.equal(detail.backend,'faster-whisper-local');assert.equal(detail.model,'base');assert.equal(detail.language,'en');assert.equal(detail.mediaUrlHash,mediaSha256);
 assert.deepEqual(await f.collector.submit(result),ack);
});

test('Podcast transcript rejects worker media substitution and cloud backends before Miniflux write',async t=>{
 const f=podcastTranscriptFixture(t);await f.service.requestTranscript(902);let claim=f.collector.claim(['podcast'],['podcast_transcript_v1']);
 await assert.rejects(f.collector.submit({leaseId:claim.job.leaseId,entryId:902,status:'OK',backendId:'faster-whisper-local',mediaSha256:'0'.repeat(64),model:'base',language:'en',segmentCount:1,content:'x'}),/media mismatch/);assert.equal(f.puts.length,0);
 f.db.run("UPDATE collector_transcripts SET state='QUEUED',lease_id=NULL,expires_at=0,digest=NULL,next_attempt=0 WHERE entry_id=902");claim=f.collector.claim(['podcast'],['podcast_transcript_v1']);
 await assert.rejects(f.collector.submit({leaseId:claim.job.leaseId,entryId:902,status:'OK',backendId:'groq-whisper',mediaSha256:require('../reader-bridge/core').hash(f.audio),model:'base',language:'en',segmentCount:1,content:'x'}),/invalid transcript backend/);assert.equal(f.puts.length,0);
});

test('Podcast local wrapper is local-only, SSRF-aware and deletes temporary audio',()=>{
 const fs=require('node:fs'),path=require('node:path'),src=fs.readFileSync(path.join(__dirname,'../tools/windows/podcast-local-whisper.py'),'utf8');
 assert.match(src,/ipaddress\.ip_address/);assert.match(src,/ip\.is_global/);assert.match(src,/HTTPRedirectHandler/);assert.match(src,/TemporaryDirectory/);assert.match(src,/shell=False/);
 assert.match(src,/faster_whisper/);assert.match(src,/compute_type="int8"/);assert.match(src,/MODEL = "base"/);assert.match(src,/faster-whisper-local/);
 assert.doesNotMatch(src,/groq|openai|requests\.post|api_key/i);
});

test('Reddit RSS rows normalize stable t3 identity, community, time and plain summary',()=>{
 const job={platform:'reddit',kind:'community.posts',authorId:'localllama',name:'r/LocalLLaMA'};
 const [item]=normalize(job,[{id:'t3_1wkxx8e',subreddit:'LocalLLaMA',author:'example',title:'A post',summary:'plain summary',updated:'2026-09-19T21:18:19+00:00',url:'https://www.reddit.com/r/LocalLLaMA/comments/1wkxx8e/'}]);
 assert.equal(item.link,'https://www.reddit.com/r/LocalLLaMA/comments/1wkxx8e/');
 assert.equal(item.published,Date.parse('2026-09-19T21:18:19+00:00'));assert.equal(item.author,'example');
 const [validated]=validateItems({platform:'reddit',label:'community.posts',authorId:'localllama'},[item]);
 assert.equal(validated.guid,'t3_1wkxx8e');assert.equal(validated.content_state,'PARTIAL');
});
test('Reddit RSS normalization rejects cross-community rows and mismatched t3 identity',()=>{
 const job={platform:'reddit',kind:'community.posts',authorId:'localllama'};
 assert.throws(()=>normalize(job,[{id:'t3_abc',subreddit:'MachineLearning',title:'x',url:'https://www.reddit.com/r/MachineLearning/comments/abc/x/'}]),/community mismatch/);
 assert.throws(()=>normalize(job,[{id:'t3_wrong',subreddit:'LocalLLaMA',title:'x',url:'https://www.reddit.com/r/LocalLLaMA/comments/abc/x/'}]),/identity mismatch/);
});
test('Reddit community is claimable through the single-browser lease without becoming an auth credential group',t=>{
 const db=new Database(':memory:');t.after(()=>db.close());
 const source={id:'reddit-source',name:'r/LocalLLaMA',platform:'reddit',url:'https://www.reddit.com/r/LocalLLaMA/',sourceType:'community',tags:[],adapter:{platform:'reddit',id:'localllama'},enabled:true};
 const config={adapters:{desktopPlatforms:['reddit']}},channel=channelsFor(source,config.adapters)[0];
 db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=23 WHERE id=?',channel.id);
 const service={db,config,provisionChannels:async()=>{},finish:(job,state,error)=>db.run('UPDATE jobs SET state=?,error=? WHERE id=?',state,error,job.id)};
 const collector=new DesktopCollector(service);service.desktop=collector;db.createRun([channel],'manual');
 const claimed=collector.claim(['reddit']);
 assert.ok(claimed.job);assert.equal(claimed.job.platform,'reddit');assert.equal(claimed.job.authorId,'localllama');assert.equal(claimed.job.kind,'community.posts');assert.equal(claimed.job.backendId,'reddit-rss-shervin');
 assert.equal(db.channels().find(c=>c.id===channel.id).credential_group,undefined);
});
test('Windows collector maps Reddit only to the bounded RSS wrapper and never to login commands',()=>{
 const fs=require('node:fs'),path=require('node:path'),src=fs.readFileSync(path.join(__dirname,'../tools/windows/collector.cjs'),'utf8');
 assert.match(src,/reddit-rss\.cjs/);assert.match(src,/backendId!=='reddit-rss-shervin'/);
 assert.doesNotMatch(src,/reddit.*login|rdt login/i);
});
