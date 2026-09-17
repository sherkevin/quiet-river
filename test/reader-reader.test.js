'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Database}=require('../reader-bridge/database');
const {ReaderService}=require('../reader-bridge/service');
const {createApp}=require('../reader-bridge/server');
const source={id:'reader-source',name:'Reader source',platform:'blog',url:'https://example.com',tags:['Agent'],feeds:['https://example.com/feed']};
const channel={id:'reader-channel',source_id:source.id,transport:'public',url:'https://example.com/feed',group_key:'example.com',enabled:true,interval_ms:1800000,min_gap_ms:0,feed_id:1};
function setup(t,{content='',crawlStatus='success'}={}){
  const db=new Database(':memory:');t.after(()=>db.close());db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=1 WHERE id=?',channel.id);
  const entry={id:1,title:'Article',url:'https://example.com/article',author:'Author',published_at:'2026-09-17T00:00:00Z',content,status:'unread'};
  const mf={call:async path=>path.includes('/fetch-content')?{content}:entry};let kkCalls=0;
  const kk={call:async()=>{kkCalls++;return {id:'bookmark-1',content:{crawlStatus}};}};
  const service=new ReaderService(db,{accessToken:'reader-test',miniflux:'http://unused',karakeep:'http://unused',karakeepToken:'reader-key',adapters:{}},{mf,kk});
  service.project(entry,channel);return {db,service,kkCalls:()=>kkCalls};
}
test('metadata-only article falls back to original without creating a fake reader bookmark',async t=>{
  const {db,service,kkCalls}=setup(t,{content:''});
  const result=await service.archive(1);
  assert.equal(result.state,'ORIGINAL_ONLY');assert.equal(result.path,null);assert.equal(result.canHighlight,false);
  assert.equal(kkCalls(),0);assert.equal(db.get('SELECT archive_state FROM entries WHERE id=1').archive_state,'ORIGINAL_ONLY');
});
test('reader status becomes READY only after Karakeep reports successful content preparation',async t=>{
  const {db,service}=setup(t,{content:'<p>Readable body</p>',crawlStatus:'success'});
  db.run("UPDATE entries SET bookmark_id='bookmark-1',archive_state='QUEUED' WHERE id=1");
  const result=await service.readerStatus(1);
  assert.equal(result.state,'READY');assert.equal(result.canHighlight,true);
  assert.equal(result.path,'/dashboard/preview/bookmark-1');
});
test('reader status reports failed crawl without claiming highlight capability',async t=>{
  const {db,service}=setup(t,{content:'<p>Readable body</p>',crawlStatus:'failure'});
  db.run("UPDATE entries SET bookmark_id='bookmark-1',archive_state='QUEUED' WHERE id=1");
  const result=await service.readerStatus(1);
  assert.equal(result.state,'ERROR');assert.equal(result.canHighlight,false);
});
test('authenticated reader status GET is read-only and exposes original-only fallback',async t=>{
  const {service}=setup(t,{content:''});await service.archive(1);
  const app=createApp(service,{accessToken:'reader-test'});await new Promise(r=>app.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>app.close(r)));const base='http://127.0.0.1:'+app.address().port;
  assert.equal((await fetch(base+'/desk/api/entries/1/archive')).status,401);
  const response=await fetch(base+'/desk/api/entries/1/archive',{headers:{'X-Qr-Token':'reader-test'}});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.state,'ORIGINAL_ONLY');
});
test('workspace reader UI polls archive readiness and disables metadata-only reader',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const ui=fs.readFileSync(path.join(__dirname,'../reader-bridge/public/workspace-ui.js'),'utf8');
  assert.match(ui,/api\('\/entries\/'\+entry\.id\+'\/archive'\)/);
  assert.match(ui,/readerButtonState/);assert.match(ui,/button\.disabled=true/);assert.match(ui,/ORIGINAL_ONLY/);
});

test('content upgrade re-enables reader after original-only fallback',t=>{
  const {db,service}=setup(t,{content:''});
  service.project({id:1,title:'Article',url:'https://example.com/article',author:'Author',published_at:'2026-09-17T00:00:00Z',content:'',status:'unread'},channel);
  db.run("UPDATE entries SET archive_state='ORIGINAL_ONLY' WHERE id=1");
  service.project({id:1,title:'Article',url:'https://example.com/article',author:'Author',published_at:'2026-09-17T00:00:00Z',content:'<p>Now readable</p>',status:'unread'},channel);
  const row=db.get('SELECT archive_state,content_state FROM entries WHERE id=1');
  assert.equal(row.archive_state,'NONE');assert.equal(row.content_state,'TEXT');
});
test('public metadata-only articles remain eligible for anonymous reader extraction',t=>{
  const {service}=setup(t,{content:''});
  const item=service.list({mode:'latest'}).items[0];
  assert.equal(item.content_state,'META');assert.equal(item.readerMode,'fetchable');
});
test('restricted metadata-only articles stay original-only until content is supplied',t=>{
  const {db,service}=setup(t,{content:''});
  const restricted={id:'xhs-source',name:'XHS',platform:'xiaohongshu',url:'https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567',tags:[],adapter:{id:'0123456789abcdef01234567'}};
  const c={id:'xhs-channel',source_id:restricted.id,transport:'desktop',url:'https://quiet-river.invalid/xhs',group_key:'credential:xiaohongshu',enabled:true,interval_ms:21600000,min_gap_ms:8000};
  db.putSource(restricted,[c]);service.project({id:2,title:'Note',url:'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01',author:'XHS',published_at:null,content:'',status:'unread'},c);
  const item=service.list({sourceId:restricted.id}).items[0];
  assert.equal(item.content_state,'META');assert.equal(item.readerMode,'original');
});
