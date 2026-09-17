'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {authorIdentity}=require('../reader-bridge/sources');
const {channelsFor}=require('../reader-bridge/core');
const {fetchNativeMetadata}=require('../reader-bridge/native-metadata');
const {Database}=require('../reader-bridge/database');
const {ReaderService}=require('../reader-bridge/service');
const {createApp}=require('../reader-bridge/server');
const base={id:'s1',name:'Fixture',url:'https://example.org',platform:'blog',feeds:[],tags:[]};
function setup(t){const db=new Database(':memory:');t.after(()=>db.close());
 const service=new ReaderService(db,{karakeep:'http://unused.invalid',adapters:{}},{mf:{call:async()=>[]}});
 return {db,service};}
test('Zhihu homepage identifies the author, not a third-party host',()=>{
 assert.deepEqual(authorIdentity('https://www.zhihu.com/people/my-author'),{platform:'zhihu',id:'my-author'});
 assert.equal(authorIdentity('https://zhihu.com.evil.example/people/my-author'),null);
 assert.equal(authorIdentity('https://evil-zhihu.com/people/my-author'),null);
 assert.equal(authorIdentity('https://www.zhihu.com/question/1/answer/2'),null);
});
test('Xiaohongshu profile identifier is validated and share query is not an ID',()=>{
 assert.deepEqual(authorIdentity('https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567?share=1'),
  {platform:'xiaohongshu',id:'0123456789abcdef01234567'});
 assert.equal(authorIdentity('https://www.xiaohongshu.com/user/profile/not-an-id'),null);
 assert.equal(authorIdentity('javascript:alert(1)'),null);
});
test('homepage parsing does not claim authenticated routes are ready',()=>{
 const c=channelsFor({...base,platform:'zhihu',adapter:authorIdentity('https://zhihu.com/people/test')});
 assert.equal(c.length,2);assert.ok(c.every(x=>!x.enabled));
});
const nativeChannel={native_adapter:'juejin',author_id:'123'};
test('native author-list adapter requests metadata only once and preserves partiality',async()=>{
 let calls=0;const result=await fetchNativeMetadata(nativeChannel,async(url,options)=>{
  calls++;assert.equal(url,'https://api.juejin.cn/content_api/v1/article/query_list');
  assert.equal(options.trusted,undefined);assert.equal(JSON.parse(options.body).user_id,'123');
  return {status:200,body:Buffer.from(JSON.stringify({err_no:0,has_more:true,data:[{
   article_info:{article_id:'456',user_id:'123',title:'Update',brief_content:'Short summary',ctime:'1750000000'}
  }]}))};
 });
 assert.equal(calls,1);assert.equal(result.items[0].link,'https://juejin.cn/post/456');
 assert.equal(result.items[0].content_state,'PARTIAL');assert.equal(result.moreAvailable,true);
});
for(const status of [401,403,429])test(`native API ${status} is not retried or reported as no new posts`,async()=>{
 let calls=0;await assert.rejects(fetchNativeMetadata(nativeChannel,async()=>{calls++;return {status};}),e=>e.status===status);
 assert.equal(calls,1);
});
test('native API rejects another author or an invalid response',async()=>{
 await assert.rejects(fetchNativeMetadata(nativeChannel,async()=>({status:200,body:Buffer.from(JSON.stringify({
  err_no:0,data:[{article_info:{article_id:'1',user_id:'999'}}]
 }))})),/author mismatch/);
 await assert.rejects(fetchNativeMetadata(nativeChannel,async()=>({status:200,body:Buffer.from('<html>login</html>')})));
});
test('native API reports an authenticated-format empty list without fabricating posts',async()=>{
 const result=await fetchNativeMetadata(nativeChannel,async()=>({status:200,body:Buffer.from('{"err_no":0,"data":[],"has_more":false}')}));
 assert.deepEqual(result.items,[]);assert.equal(result.moreAvailable,false);
});
test('platform-scoped lists and refreshes exclude unrelated sources',t=>{
 const {db,service}=setup(t);service.pump=async()=>{};
 for(const [i,platform] of [[1,'blog'],[2,'wechat']]){
  const source={...base,id:'p'+i,platform,feeds:['https://example.org/feed'+i]};
  const c=channelsFor(source)[0];db.putSource(source,[c]);
  service.project({id:i,url:'https://example.org/'+i,title:'Post',content:'summary',published_at:'2026-09-16T00:00:00Z'},c);
 }
 assert.equal(service.list({platform:'wechat'}).total,1);
 assert.equal(service.list({platform:'wechat'}).items[0].platform,'wechat');
 const run=service.refresh({platform:'wechat'});assert.equal(run.sources,1);assert.equal(run.jobs.length,1);
});
test('partial list completion is visible and not reported as all updates checked',async t=>{
 const {db,service}=setup(t);const s={...base,platform:'juejin',adapter:{id:'123'}};
 const c=channelsFor(s)[0];db.putSource(s,[c]);db.run('UPDATE channels SET feed_id=7');
 service.fetchNative=async()=>({items:[],moreAvailable:true});
 const run=service.refresh();while(service.working)await new Promise(r=>setTimeout(r,5));
 assert.equal(db.runStatus(run.id).jobs[0].state,'SUCCEEDED_PARTIAL');
 assert.ok(db.channels()[0].last_success>0);
});
async function appFixture(t){
 const {db,service}=setup(t);db.putSource(base,[]);let captured;
 service.importManifest=async m=>{captured=m;return {sources:1,channels:0};};
 const app=createApp(service,{accessToken:'fixture-local-only'});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.close(r)));
 return {base:'http://127.0.0.1:'+app.address().port,captured:()=>captured};
}
const headers={'X-Qr-Token':'fixture-local-only','X-QR-Action':'1','Content-Type':'application/json'};
test('authenticated feed attachment preserves the source identity and existing feeds',async t=>{
 const f=await appFixture(t);
 const r=await fetch(f.base+'/desk/api/sources/s1/feed',{method:'POST',headers,body:JSON.stringify({feedUrl:'https://example.org/rss'})});
 assert.equal(r.status,200);assert.equal(f.captured().subscriptions[0].id,'s1');
 assert.deepEqual(f.captured().subscriptions[0].feeds,['https://example.org/rss']);
});
test('feed attachment denies anonymous requests and unsafe URLs',async t=>{
 const f=await appFixture(t);
 assert.equal((await fetch(f.base+'/desk/api/sources/s1/feed',{method:'POST',body:'{}'})).status,401);
 assert.equal((await fetch(f.base+'/desk/api/sources/s1/feed',{method:'POST',headers,
  body:JSON.stringify({feedUrl:'javascript:alert(1)'})})).status,400);
 assert.equal(f.captured(),undefined);
});
test('new profile registration produces author channels instead of inert manual metadata',async t=>{
 const f=await appFixture(t);
 const r=await fetch(f.base+'/desk/api/sources',{method:'POST',headers,
  body:JSON.stringify({name:'Chosen author',platform:'blog',url:'https://www.zhihu.com/people/test-author'})});
 assert.equal(r.status,201);const source=f.captured().subscriptions[0];
 assert.equal(source.platform,'zhihu');assert.equal(source.adapter.id,'test-author');
 assert.equal(channelsFor(source).length,2);assert.ok(channelsFor(source).every(c=>!c.enabled));
});
test('reconfiguration uses the saved author rather than arbitrary client adapter options',async t=>{
 const f=await appFixture(t);
 const r=await fetch(f.base+'/desk/api/sources/s1/configure',{method:'POST',headers,
  body:JSON.stringify({id:'someone-else',browserEnabled:true})});
 assert.equal(r.status,200);assert.equal(f.captured().subscriptions[0].id,'s1');
 assert.equal(f.captured().subscriptions[0].browserEnabled,undefined);
});
test('source-first landing preserves notes navigation but makes Latest the initial view',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const html=fs.readFileSync(path.join(__dirname,'../reader-bridge/public/index.html'),'utf8');
 const app=fs.readFileSync(path.join(__dirname,'../reader-bridge/public/app.js'),'utf8');
 assert.match(html,/id="platform-filter"/);assert.match(html,/data-view="notes"/);
 assert.match(app,/await switchView\('latest'\);refresh\(\)/);
 assert.match(fs.readFileSync(path.join(__dirname,'../reader-bridge/public/workspace-ui.js'),'utf8'),/<a class="primary" data-original/);
});
