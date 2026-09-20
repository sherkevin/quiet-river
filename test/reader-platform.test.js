'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const {Database}=require('../reader-bridge/database');
const {ReaderService}=require('../reader-bridge/service');
const {createApp,secureEqual,cookies,validPreferences}=require('../reader-bridge/server');
const {hash,channelsFor,opmlFor,parseFullFeed,rankEntries,buildArchive,classifyError,safeURL}=require('../reader-bridge/core');
const {isPublicIPv4,request}=require('../reader-bridge/network');
const source={id:'source1',name:'测试博主',platform:'blog',url:'https://example.com',tags:['Agent','数学'],feeds:['https://example.com/rss']};
const channel={id:'channel1',source_id:source.id,transport:'public',url:'https://example.com/rss',group_key:'example.com',enabled:true,interval_ms:1800000,min_gap_ms:0};
function setup(mf={call:async()=>[]}){const db=new Database(':memory:');db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=1 WHERE id=?',channel.id);return {db,service:new ReaderService(db,{accessToken:'test-only-token',miniflux:'http://localhost',karakeep:'http://localhost'},{mf})};}
function entry(id,extra={}){return {id,feed_id:1,title:'Agent 工具学习',url:`https://example.com/${id}`,author:'作者',published_at:new Date().toISOString(),content:'<p>真实文章内容</p>',status:'unread',...extra};}

test('all sources survive migration including manual and multiple channels',()=>{const z={...source,platform:'zhihu',feeds:[],adapter:{id:'alice'}};assert.equal(channelsFor(z).length,2);assert.equal(channelsFor({...source,platform:'wechat',feeds:[],manual:true}).length,0);});
test('existing third-party author feeds remain enabled',()=>{const c=channelsFor({...source,platform:'wechat',feeds:['https://relay.example/feed/a']});assert.equal(c[0].transport,'public');assert.equal(c[0].enabled,true);});
test('declared WeRSS IDs are bound to the blogger and do not need a side mapping',()=>{
  const s={...source,platform:'wechat',feeds:[],adapter:{platform:'wechat',mp_id:'MP_WXS_1234567890'}};
  const c=channelsFor(s,{werss:'http://127.0.0.1:8001'});
  assert.equal(c.length,1);assert.equal(c[0].transport,'werss');assert.equal(c[0].mp_id,'MP_WXS_1234567890');
  assert.equal(c[0].url,'http://127.0.0.1:8001/feed/MP_WXS_1234567890.xml');assert.equal(c[0].enabled,true);
});
test('invalid declared WeRSS IDs are not turned into executable channels',()=>{
  const c=channelsFor({...source,platform:'wechat',feeds:[],adapter:{platform:'wechat',mp_id:'guess-me'}},{werss:'http://127.0.0.1:8001'});
  assert.equal(c.length,0);
});
test('credential-gated routes do not claim readiness without credentials',()=>{const c=channelsFor({...source,platform:'zhihu',feeds:[],adapter:{id:'alice'}},{rsshub:'http://127.0.0.1:1200'});assert.equal(c[0].enabled,false);assert.equal(c[0].credential_group,'zhihu');});
test('RSSHub route generation encodes author identifiers',()=>{const c=channelsFor({...source,platform:'zhihu',feeds:[],adapter:{id:'a/b?x'}},{rsshub:'http://127.0.0.1:1200',zhihuReady:true});assert.ok(c[0].url.includes('a%2Fb%3Fx'));});
test('OPML disables automatic fetching and escapes untrusted names',()=>{const s={...source,name:'<script>&"'};const x=opmlFor([channel],[s]);assert.ok(x.includes('miniflux:disabled="true"'));assert.ok(!x.includes('<script>'));assert.ok(x.includes('&amp;'));});
test('restricted OPML identity is never the internal crawler address',()=>{const x=opmlFor([{...channel,transport:'rsshub'}],[source]);assert.ok(x.includes('quiet-river.invalid/channel/channel1'));assert.ok(!x.includes('xmlUrl="http://127.0.0.1'));});
test('RSS full content is retained beyond legacy 400-character summary',()=>{const full='正文'.repeat(500);const r=parseFullFeed(`<rss><channel><title>T</title><item><guid>1</guid><title>A</title><link>https://example.com/1</link><content:encoded><![CDATA[<p>${full}</p>]]></content:encoded></item></channel></rss>`,'https://example.com/rss');assert.ok(r.items[0].content.length>1000);assert.ok(r.items[0].summary.length<410);assert.equal(r.items[0].content_state,'TEXT');});
test('JSON feed preserves content and unknown date is not invented',()=>{const r=parseFullFeed(JSON.stringify({version:'https://jsonfeed.org/version/1',items:[{id:'1',url:'https://example.com/1',content_html:'<p>A</p>'}]}),'https://example.com/rss');assert.equal(r.items[0].content,'<p>A</p>');assert.equal(r.items[0].published,null);});
test('DTDs and external entities are rejected',()=>assert.throws(()=>parseFullFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>','https://example.com'),/DTD/));
test('HTML login pages are not accepted as valid feeds',()=>assert.throws(()=>parseFullFeed('<html><body>请登录</body></html>','https://example.com'),/recognised feed/));
for(const address of ['127.0.0.1','10.1.1.1','172.16.2.3','192.168.1.1','169.254.169.254','100.100.100.200','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1'])test('SSRF rejects '+address,()=>assert.equal(isPublicIPv4(address),false));
test('public IPv4 is accepted',()=>assert.equal(isPublicIPv4('1.1.1.1'),true));
test('network rejects metadata before opening a connection',async()=>{await assert.rejects(request('http://100.100.100.200/latest/meta-data'),/SSRF/);});
test('links reject script and embedded userinfo',()=>{assert.equal(safeURL('javascript:alert(1)'),'');assert.equal(safeURL('https://user:pass@example.com'),'');});
test('credential classification distinguishes 401 from 403',()=>{assert.equal(classifyError({status:401}),'AUTH_REQUIRED');assert.equal(classifyError({status:403}),'ACCESS_BLOCKED');assert.equal(classifyError({status:429}),'COOLDOWN');});
test('manual refresh requests merge active jobs',()=>{const {db}=setup();const a=db.createRun([channel]),b=db.createRun([channel]);assert.equal(a.jobs[0].id,b.jobs[0].id);assert.notEqual(a.id,b.id);assert.equal(db.get('SELECT count(*) n FROM jobs').n,1);db.close();});
test('recovery keeps unfinished jobs queued without deleting runs',()=>{const {db}=setup();db.createRun([channel]);db.run("UPDATE jobs SET state='RUNNING'");db.recover();assert.equal(db.get('SELECT state FROM jobs').state,'QUEUED');db.close();});
test('new article projection does not mark it read',()=>{const {db,service}=setup();service.project(entry(1),channel);assert.equal(db.get('SELECT status FROM entries').status,'unread');db.close();});
test('projection preserves archive and discovery time when content changes',()=>{const {db,service}=setup();service.project(entry(1),channel);const before=db.get('SELECT discovered_at FROM entries').discovered_at;db.run("UPDATE entries SET bookmark_id='saved' WHERE id=1");service.project(entry(1,{content:'longer',status:'read'}),channel);const after=db.get('SELECT * FROM entries');assert.equal(after.bookmark_id,'saved');assert.equal(after.discovered_at,before);assert.equal(after.status,'read');db.close();});
test('first imported entry explicitly passes unread',async()=>{const calls=[];const {db,service}=setup({call:async(p,m,v)=>{calls.push({p,m,v});if(p.endsWith('/import'))return {id:9};if(p==='/v1/entries/9')return entry(9);return [];}});await service.importItem(channel,{guid:'g',link:'https://example.com/9',title:'A',content:'<p>A</p>'});assert.equal(calls.find(c=>c.p.endsWith('/import')).v.status,'unread');assert.equal(db.get('SELECT id FROM entries').id,9);db.close();});
test('content upgrade uses PUT and never sends read state',async()=>{const calls=[];const {db,service}=setup({call:async(p,m,v)=>{calls.push({p,m,v});if(p.endsWith('/import'))return {id:9};if(p==='/v1/entries/9'&&m!=='PUT')return entry(9,{status:'read'});return {};}});const item={guid:'g',link:'https://example.com/9',title:'A',content:'<p>A</p>'};await service.importItem(channel,item);await service.importItem(channel,{...item,content:'<p>updated</p>'});assert.equal(calls.filter(c=>c.p.endsWith('/import')).length,1);const update=calls.find(c=>c.m==='PUT');assert.equal(update.p,'/v1/entries/9');assert.equal(update.v.status,undefined);assert.equal(db.get('SELECT status FROM entries').status,'read');db.close();});
test('uncertain import checks existing records instead of blindly replaying',async()=>{let imports=0;const {db,service}=setup({call:async(p,m,v)=>{if(p.endsWith('/import')){imports++;throw new Error('timeout');}if(p.includes('/entries?'))return {entries:[entry(9)],total:1};if(p==='/v1/entries/9')return entry(9,{status:'read'});return {};}});const item={guid:'g',link:'https://example.com/9',title:'A',content:'<p>A</p>'};await assert.rejects(service.importItem(channel,item));await service.importItem(channel,item);assert.equal(imports,1);assert.equal(db.get('SELECT status FROM entries').status,'read');db.close();});
test('ranker changes priorities but never drops candidates',()=>{const entries=[{id:1,source_id:'source1',title:'普通更新',summary:'',published_at:Date.now(),discovered_at:Date.now()},{id:2,source_id:'source1',title:'语义 ID 的研究',summary:'',published_at:Date.now()-1000,discovered_at:Date.now()}];const ranked=rankEntries(entries,[source],{keywords:'语义 ID'});assert.equal(ranked[0].id,2);assert.equal(ranked.length,2);});
test('source multiplicity does not multiply tag preference',()=>{const e={id:1,source_id:'source1',title:'test',summary:'',published_at:1,discovered_at:1};const a=rankEntries([e],[source],{tags:{Agent:3}}, {},1)[0].score;const b=rankEntries([e],[{...source,tags:['Agent','数学']}],{tags:{Agent:3,数学:3}}, {},1)[0].score;assert.equal(a,b);});
test('unsubscribed sources do not enter recommendation, entries are retained',()=>{const {db,service}=setup();service.project(entry(1),channel);db.run('UPDATE sources SET enabled=0');assert.equal(service.list({mode:'recommend'}).total,0);assert.equal(db.get('SELECT count(*) n FROM entries').n,1);db.close();});
test('health checks generate no network request and deduplicate alerts',()=>{let calls=0;const {db,service}=setup({call:async()=>{calls++;}});db.run('UPDATE channels SET last_success=1');service.monitor(Date.now());service.monitor(Date.now());assert.equal(calls,0);assert.equal(db.get('SELECT count(*) n FROM outbox').n,1);db.close();});
test('shared invalid credential group blocks all associated jobs without requests',async()=>{let calls=0;const {db,service}=setup({call:async()=>{calls++;}});db.run("UPDATE groups SET state='AUTH_REQUIRED'");const r=service.refresh();while(service.working)await new Promise(r=>setTimeout(r,5));assert.equal(calls,0);assert.equal(db.runStatus(r.id).jobs[0].state,'AUTH_REQUIRED');db.close();});
test('digest uses all candidates before selecting top N and stores a snapshot',()=>{const {db,service}=setup();for(let i=1;i<=40;i++)service.project(entry(i,{title:i===40?'最想读的专题':'普通内容'}),channel);db.set('preferences',{keywords:'最想读',digestCount:3});const d=service.makeDigest('2026-09-17');assert.equal(d.items.length,3);assert.equal(d.items[0].id,40);assert.equal(d.candidateCount,40);assert.deepEqual(service.makeDigest('2026-09-17'),d);db.close();});
test('archive escapes title but preserves supplied article HTML for reader sanitization',()=>{const a=buildArchive({title:'<script>x</script>',url:'https://example.com',author:'A'},'<p>正文</p>');assert.ok(a.includes('&lt;script&gt;'));assert.ok(a.includes('<p>正文</p>'));});
test('API token comparison rejects missing and malformed values',()=>{assert.equal(secureEqual('abc','abc'),true);assert.equal(secureEqual('abc',''),false);assert.deepEqual(cookies('x=%E0%A4%A; qr_token=ok'),{qr_token:'ok'});});
test('invalid preference timezone is rejected',()=>assert.throws(()=>validPreferences({timezone:'not-a-zone'})));
test('preferences bound weights and daily budget',()=>{const p=validPreferences({tags:{A:999},digestCount:200});assert.equal(p.tags.A,3);assert.equal(p.digestCount,50);});
test('HTTP: auth required, cross-origin mutations denied, valid local writes accepted',async()=>{const {db,service}=setup();const app=createApp(service,{accessToken:'test-only-token'});await new Promise(r=>app.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.address().port;
 try{assert.equal((await fetch(base+'/desk/api/state')).status,401);assert.equal((await fetch(base+'/desk/')).status,200);
 const csrf=await fetch(base+'/desk/api/preferences',{method:'POST',headers:{'X-Qr-Token':'test-only-token','X-QR-Action':'1','Origin':'https://evil.example','Content-Type':'application/json'},body:'{}'});assert.equal(csrf.status,403);
 const r=await fetch(base+'/desk/api/preferences',{method:'POST',headers:{'X-Qr-Token':'test-only-token','X-QR-Action':'1','Content-Type':'application/json'},body:JSON.stringify({keywords:'测试'})});assert.equal(r.status,200);assert.equal(db.setting('preferences',{}).keywords,'测试');
 }finally{await new Promise(r=>app.close(r));db.close();}});

test('empty refresh completes immediately without a permanently active run',()=>{
  const {db}=setup();const run=db.createRun([]);
  assert.equal(run.pending,0);assert.ok(run.finished_at);db.close();
});
test('paused sources remain readable in the timeline but leave recommendations',()=>{
  const {db,service}=setup();service.project(entry(1),channel);
  db.run('UPDATE sources SET enabled=0');
  assert.equal(service.list({mode:'latest'}).total,1);
  assert.equal(service.list({mode:'recommend'}).total,0);db.close();
});
test('sources without a usable channel remain represented in health and daily gaps',()=>{
  const {db,service}=setup();
  db.putSource({...source,id:'manual',platform:'wechat',feeds:[]},[]);
  assert.equal(service.health().unconfiguredSources.length,1);
  const digest=service.makeDigest('2026-09-17');
  assert(digest.issues.some(i=>i.sourceId==='manual'));db.close();
});
test('never-successful channels also generate local-only stale alerts',()=>{
  const {db,service}=setup();db.set('manifest_imported_at',1);
  service.monitor(10*3600000);service.monitor(10*3600000);
  assert.equal(db.get('SELECT count(*) n FROM outbox').n,1);db.close();
});
test('archive supplies a local-to-origin favicon hint instead of depending on Google fallback',()=>{
  const html=buildArchive({url:'https://example.com/article',title:'Test',author:'A'},'<p>Body</p>');
  assert(html.includes('rel="icon" href="https://example.com/favicon.ico"'));
});

test('specific manual refresh takes priority without duplicating scheduled work',()=>{
  const {db}=setup();const second={...channel,id:'channel2'};db.putSource(source,[second]);
  db.createRun([channel,second],'scheduled');db.createRun([second],'manual');
  const first=db.get("SELECT * FROM jobs ORDER BY priority DESC,created_at,id LIMIT 1");
  assert.equal(first.channel_id,'channel2');assert.equal(db.get('SELECT count(*) n FROM jobs').n,2);
  db.close();
});
test('pagination cutoff prevents new arrivals shifting an existing read session',()=>{
  const {db,service}=setup();service.project(entry(1),channel);
  const first=service.list();service.project(entry(2),channel);
  db.run('UPDATE entries SET discovered_at=? WHERE id=2',first.asOf+1000);
  assert.equal(service.list({asOf:first.asOf}).total,1);
  assert.equal(service.list({asOf:first.asOf+2000}).total,2);db.close();
});

test('verified WeChat bloggers keep stable unique WeRSS identities in the manifest',()=>{
  const manifest=JSON.parse(fs.readFileSync(require.resolve('../data/subscriptions.json'),'utf8'));
  const mapped=manifest.subscriptions.filter(s=>s.platform==='wechat'&&s.adapter?.platform==='wechat');
  assert.equal(mapped.length,16);
  const ids=mapped.map(s=>s.adapter.mp_id);
  assert.equal(new Set(ids).size,16);
  for(const id of ids)assert.match(id,/^MP_WXS_\d+$/);
  assert.equal(manifest.subscriptions.length,268);
});
test('renamed WeChat blogger keeps the historical source id and the mistaken repository source stays removed',()=>{
  const manifest=JSON.parse(fs.readFileSync(require.resolve('../data/subscriptions.json'),'utf8'));
  const renamed=manifest.subscriptions.find(s=>s.id==='b1cede844cdf');
  assert.equal(renamed?.name,'推广搜老油条');
  assert.equal(renamed?.adapter?.mp_id,'MP_WXS_3216764246');
  assert.equal(manifest.subscriptions.some(s=>s.name==='丁丁丁写字的地方'),false);
  assert.equal(manifest.subscriptions.some(s=>s.name==='搜广推学习笔记'),false);
});
test('WeRSS refresh uses the locked update API before reading the exact XML feed',async t=>{
  const seen=[],server=http.createServer((req,res)=>{
    seen.push(req.url);
    if(req.url==='/api/v1/wx/mps/update/MP_WXS_1234567890?start_page=0&end_page=1'){
      res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"code":0,"data":{"total":1}}');
    }
    if(req.url==='/feed/MP_WXS_1234567890.xml'){
      res.writeHead(200,{'Content-Type':'application/rss+xml'});
      return res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>W</title><item><guid>w1</guid><title>A</title><link>https://mp.weixin.qq.com/s/test</link><description>摘要</description></item></channel></rss>');
    }
    res.writeHead(404);res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port,db=new Database(':memory:');t.after(()=>db.close());
  const s={...source,id:'wx-source',platform:'wechat',feeds:[],adapter:{platform:'wechat',mp_id:'MP_WXS_1234567890'}};
  const c=channelsFor(s,{werss:base})[0];db.putSource(s,[c]);db.run('UPDATE channels SET feed_id=1 WHERE id=?',c.id);
  const service=new ReaderService(db,{miniflux:'http://unused',karakeep:'http://unused',adapters:{werss:base,browserEnabled:true}},{mf:{call:async()=>[]}});
  const imported=[];service.importItem=async(ch,item)=>{imported.push({ch,item});return 1;};
  const added=await service.refreshAdapter(c);
  assert.equal(added,1);assert.deepEqual(seen,['/api/v1/wx/mps/update/MP_WXS_1234567890?start_page=0&end_page=1','/feed/MP_WXS_1234567890.xml']);
  assert.equal(imported.length,1);assert.equal(imported[0].ch.id,c.id);assert.equal(imported[0].item.link,'https://mp.weixin.qq.com/s/test');
});
test('WeRSS explicit update failure stops before reading a cached feed',async t=>{
  const seen=[],server=http.createServer((req,res)=>{seen.push(req.url);res.writeHead(200,{'Content-Type':'application/json'});res.end('{"code":50002,"message":"upstream failed"}');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port,db=new Database(':memory:');t.after(()=>db.close());
  const s={...source,id:'wx-source',platform:'wechat',feeds:[],adapter:{platform:'wechat',mp_id:'MP_WXS_1234567890'}};
  const c=channelsFor(s,{werss:base})[0];db.putSource(s,[c]);db.run('UPDATE channels SET feed_id=1 WHERE id=?',c.id);
  const service=new ReaderService(db,{miniflux:'http://unused',karakeep:'http://unused',adapters:{werss:base,browserEnabled:true}},{mf:{call:async()=>[]}});
  await assert.rejects(service.refreshAdapter(c),/did not confirm success/);
  assert.deepEqual(seen,['/api/v1/wx/mps/update/MP_WXS_1234567890?start_page=0&end_page=1']);
});

test('HTTP acquisition doctor is authenticated, read-only and does not require mutation action header',async()=>{
  const {db,service}=setup();const app=createApp(service,{accessToken:'test-only-token'});
  await new Promise(r=>app.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.address().port;
  try{
    assert.equal((await fetch(base+'/desk/api/acquisition/doctor')).status,401);
    const response=await fetch(base+'/desk/api/acquisition/doctor',{headers:{'X-Qr-Token':'test-only-token'}});
    assert.equal(response.status,200);const doctor=await response.json();
    assert.equal(doctor.backends['direct-feed'].status,'ok');
    assert.equal(doctor.backends['xiaohongshu-mcp-ecs'].status,'off');
    assert.ok(Array.isArray(doctor.capabilities));
  }finally{await new Promise(r=>app.close(r));db.close();}
});
