'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Database}=require('../reader-bridge/database');
const {ReaderService}=require('../reader-bridge/service');
const {createApp}=require('../reader-bridge/server');
const {normalizeTags}=require('../reader-bridge/tags');
const metadata=require('../reader-bridge/article-metadata');
const history=require('../reader-bridge/reading-history');
const blogger={id:'author',name:'Test author',platform:'blog',tags:['Agent','数学'],url:'https://example.org',feeds:[]};
const channel={id:'channel',source_id:'author',transport:'public',url:'https://example.org/feed',enabled:true,group_key:'example.org',interval_ms:1800000,min_gap_ms:0};
const article=(id,extra={})=>({id,title:'Test article '+id,url:'https://example.org/'+id,content:'<p>Metadata</p>',status:'unread',published_at:'2026-09-16T00:00:00Z',...extra});
function setup(t,mf={call:async()=>null},file=':memory:'){
 const db=new Database(file);db.putSource(blogger,[channel]);db.run('UPDATE channels SET feed_id=7');
 const service=new ReaderService(db,{karakeep:'http://unused.invalid',adapters:{}},{mf});
 t.after(()=>db.close());return {db,service};
}
test('tag validation normalizes Unicode, trims and deduplicates',()=>{
 assert.deepEqual(normalizeTags([' Agent ','数学','Agent']),['Agent','数学']);
 assert.deepEqual(normalizeTags([]),[]);
 for(const input of ['Agent',[1],[''],['x\n'],Array(51).fill('a'),['a'.repeat(81)]])assert.throws(()=>normalizeTags(input));
});
test('new articles inherit a snapshot; later blogger tags only affect later articles',t=>{
 const {service}=setup(t);service.project(article(1),channel);
 service.setBloggerTags('author',['新主题']);service.project(article(2),channel);service.project(article(1),channel);
 const byId=new Map(service.list().items.map(e=>[e.id,e]));
 assert.deepEqual(byId.get(1).tags,['Agent','数学']);assert.deepEqual(byId.get(2).tags,['新主题']);
});
test('article edits and clearing tags survive refresh and blogger reconfiguration',t=>{
 const {db,service}=setup(t);service.project(article(1),channel);service.setArticleTags(1,[]);
 service.setBloggerTags('author',['手动博主标签']);db.putSource(blogger,[channel]);service.project(article(1,{content:'updated'}),channel);
 assert.deepEqual(service.list().items[0].tags,[]);assert.deepEqual(db.sources()[0].tags,['手动博主标签']);
 assert.equal(service.list().items[0].tagOrigin,'manual');
});
test('AND tag filters use the article tags, not current blogger tags',t=>{
 const {service}=setup(t);for(let i=1;i<=3;i++)service.project(article(i),channel);
 service.setArticleTags(2,['Agent']);service.setArticleTags(3,['数学']);
 assert.deepEqual(service.list({tags:['Agent','数学']}).items.map(e=>e.id),[1]);
 assert.equal(service.list({tags:['Agent']}).total,2);assert.equal(service.list({tags:['无此标签']}).total,0);
});
test('time order and unread are independently composable with tag filters',t=>{
 const {service}=setup(t);service.project(article(1),channel);service.project(article(2,{published_at:'2026-09-17T00:00:00Z',status:'read'}),channel);
 assert.deepEqual(service.list({order:'asc'}).items.map(e=>e.id),[1,2]);
 assert.deepEqual(service.list({order:'desc'}).items.map(e=>e.id),[2,1]);
 assert.deepEqual(service.list({mode:'unread',tags:['数学']}).items.map(e=>e.id),[1]);
 assert.throws(()=>service.list({order:'random'}));
});
test('opening records read state and idempotent history; repeated opens are separate visits',async t=>{
 const {db,service}=setup(t);service.project(article(1),channel);
 await service.openArticle(1,'fixture-event-00001','original');
 await service.openArticle(1,'fixture-event-00001','original');
 assert.equal(db.get('SELECT status FROM entries').status,'read');assert.equal(history.historyPage(db).items.length,1);
 await service.openArticle(1,'fixture-event-00002','original');
 assert.equal(history.historyPage(db).items.length,2);assert.equal(history.activity(db).opens,2);
});
test('manual read changes, tags and listing do not fabricate viewing history',async t=>{
 const {db,service}=setup(t);service.project(article(1),channel);
 service.setArticleTags(1,['新标签']);service.setBloggerTags('author',[]);service.list();await service.markRead(1,'read');
 assert.equal(history.historyPage(db).items.length,0);assert.equal(history.activity(db).opens,0);
});
test('failed upstream read write leaves unread state and history untouched',async t=>{
 const {db,service}=setup(t,{call:async()=>{throw new Error('offline');}});service.project(article(1),channel);
 await assert.rejects(service.openArticle(1,'fixture-event-00001','original'));
 assert.equal(db.get('SELECT status FROM entries').status,'unread');assert.equal(history.historyPage(db).items.length,0);
});
test('a stale in-flight feed response cannot revert a newly saved read state',async t=>{
 const {db,service}=setup(t);service.project(article(1),channel);const before=Date.now()-1;
 await service.openArticle(1,'fixture-event-00001','original');service.project(article(1,{status:'unread'}),channel,before);
 assert.equal(db.get('SELECT status FROM entries').status,'read');
});
test('the same request ID cannot describe opens of different articles',async t=>{
 const {service}=setup(t);service.project(article(1),channel);service.project(article(2),channel);
 await service.openArticle(1,'fixture-event-00001','original');
 await assert.rejects(service.openArticle(2,'fixture-event-00001','original'),e=>e.status===409);
});
test('history uses stable descending cursors and timezone-aware activity days',t=>{
 const {db,service}=setup(t);service.project(article(1),channel);
 history.recordOpen(db,{id:1},'fixture-event-00001','original',Date.parse('2026-09-16T17:00:00Z'));
 history.recordOpen(db,{id:1},'fixture-event-00002','reader',Date.parse('2026-09-16T17:01:00Z'));
 const page=history.historyPage(db,{limit:1});assert.ok(page.nextCursor);assert.equal(history.historyPage(db,{before:page.nextCursor}).items.length,1);
 const a=history.activity(db,'Asia/Shanghai',Date.parse('2026-09-17T00:00:00Z'));
 assert.equal(a.days.length,365);assert.equal(a.days.at(-1).count,2);assert.equal(a.uniqueArticles,1);
});
test('tag overrides and viewing history survive reopening the database',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qr-workspace-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'test.sqlite');let db=new Database(file);db.putSource(blogger,[channel]);
 let service=new ReaderService(db,{karakeep:'http://unused.invalid'},{mf:{call:async()=>null}});
 service.project(article(1),channel);service.setArticleTags(1,['保存']);service.setBloggerTags('author',['新博主标签']);
 history.recordOpen(db,{id:1},'fixture-event-00001','original');db.close();
 db=new Database(file);service=new ReaderService(db,{karakeep:'http://unused.invalid'},{mf:{call:async()=>null}});
 assert.deepEqual(service.list().items[0].tags,['保存']);assert.deepEqual(db.sources()[0].tags,['新博主标签']);
 assert.equal(history.historyPage(db).items.length,1);db.close();
});
test('backoffice reports missing/failed/stale feeds without asserting permanent deletion',t=>{
 const {db,service}=setup(t);db.run("UPDATE channels SET state='TIMEOUT',last_check=1");
 const b=service.backend();assert.equal(b.faults[0].state,'TIMEOUT');assert.equal(b.faults[0].source,blogger.name);
 assert.equal(b.activity.opens,0);assert.ok(!JSON.stringify(b).includes('/feed'));
});
async function apiFixture(t){const fixture=setup(t);fixture.service.project(article(1),channel);fixture.service.project(article(2),channel);
 const app=createApp(fixture.service,{accessToken:'fixture-token-only'});await new Promise(r=>app.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>app.close(r)));return {...fixture,base:'http://127.0.0.1:'+app.address().port};}
const auth={'X-Qr-Token':'fixture-token-only','X-QR-Action':'1','Content-Type':'application/json'};
test('history/backend and mutations remain behind authentication',async t=>{
 const f=await apiFixture(t);
 for(const endpoint of ['/backend','/history'])assert.equal((await fetch(f.base+'/desk/api'+endpoint)).status,401);
 const r=await fetch(f.base+'/desk/api/entries/1/open',{method:'POST',body:'{}'});assert.equal(r.status,401);
 const ok=await fetch(f.base+'/desk/api/backend',{headers:auth});assert.equal(ok.status,200);assert.equal((await ok.json()).activity.days.length,365);
});
test('HTTP editing, multi-tag AND, unread and read-on-open compose correctly',async t=>{
 const f=await apiFixture(t);const call=(p,body)=>fetch(f.base+'/desk/api'+p,{method:body?'POST':'GET',headers:auth,body:body?JSON.stringify(body):undefined});
 assert.equal((await call('/entries/2/tags',{tags:['Agent']})).status,200);
 const filtered=await (await call('/entries?tag=Agent&tag='+encodeURIComponent('数学')+'&unread=1')).json();
 assert.deepEqual(filtered.items.map(e=>e.id),[1]);
 assert.equal((await call('/entries/1/open',{eventId:'fixture-event-http1',target:'original'})).status,200);
 const unread=await (await call('/entries?unread=1')).json();assert.deepEqual(unread.items.map(e=>e.id),[2]);
 const h=await (await call('/history')).json();assert.equal(h.items.length,1);
 assert.equal((await call('/sources/author',{tags:[]})).status,200);
 assert.deepEqual(f.db.sources()[0].tags,[]);
 assert.equal((await call('/entries/1/tags',{tags:'bad'})).status,400);
});
test('editing article tags is not a viewing event',async t=>{
 const f=await apiFixture(t);
 await fetch(f.base+'/desk/api/entries/1/tags',{method:'POST',headers:auth,body:JSON.stringify({tags:[]})});
 assert.equal(history.historyPage(f.db).items.length,0);assert.equal(f.db.get('SELECT status FROM entries WHERE id=1').status,'unread');
});
test('navigation, tag editor and unread styling are present without removing prior data views',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../reader-bridge/public/index.html'),'utf8');
 const css=fs.readFileSync(path.join(__dirname,'../reader-bridge/public/style.css'),'utf8');
 for(const label of ['文章','未读','博主','后台'])assert.ok(html.includes('>'+label+'</button>'));
 assert.match(html,/workspace-ui.js/);assert.match(css,/\.unread-dot/);assert.match(css,/box-shadow/);
 assert.match(css,/activity-grid/);
});
