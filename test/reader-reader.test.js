'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Database}=require('../reader-bridge/database');
const {ReaderService}=require('../reader-bridge/service');
const {createApp}=require('../reader-bridge/server');
const {createReaderWebSession,safeBase}=require('../reader-bridge/reader-web-session');
const source={id:'reader-source',name:'Reader source',platform:'blog',url:'https://example.com',tags:['Agent'],feeds:['https://example.com/feed']};
const channel={id:'reader-channel',source_id:source.id,transport:'public',url:'https://example.com/feed',group_key:'example.com',enabled:true,interval_ms:1800000,min_gap_ms:0,feed_id:1};
function setup(t,{content='',fetchedContent,crawlStatus='success'}={}){
  const db=new Database(':memory:');t.after(()=>db.close());db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=1 WHERE id=?',channel.id);
  const entry={id:1,title:'Article',url:'https://example.com/article',author:'Author',published_at:'2026-09-17T00:00:00Z',content,status:'unread'};
  const mfCalls=[],extracted=fetchedContent===undefined?content:fetchedContent;
  const mf={call:async(path,method,value)=>{mfCalls.push({path,method,value});if(path.includes('/fetch-content'))return {content:extracted};if(method==='PUT')return {};return entry;}};let kkCalls=0;
  const kk={call:async()=>{kkCalls++;return {id:'bookmark-1',content:{crawlStatus}};}};
  const service=new ReaderService(db,{accessToken:'reader-test',miniflux:'http://unused',karakeep:'http://unused',karakeepToken:'reader-key',adapters:{}},{mf,kk});
  service.project(entry,channel);return {db,service,kkCalls:()=>kkCalls,mfCalls};
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
  assert.equal(result.path,'/desk/reader/1');
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
  assert.doesNotMatch(ui,/readerDestination|signin\?callbackUrl|\/api\/auth\/session/);
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
test('reader web session exchanges credentials only with loopback Karakeep and returns session cookie',async()=>{
  const calls=[];
  const response=(status,data,cookies=[])=>({status,ok:status>=200&&status<300,headers:{getSetCookie:()=>cookies},json:async()=>data});
  const fetchImpl=async(url,options={})=>{
    calls.push({url,options});
    if(url.endsWith('/api/auth/csrf'))return response(200,{csrfToken:'csrf-fixture'},['__Host-next-auth.csrf-token=csrf-cookie; Path=/; HttpOnly; Secure']);
    if(url.endsWith('/api/auth/callback/credentials'))return response(200,{},['__Secure-next-auth.session-token=opaque-session; Path=/; Domain=127.0.0.1; HttpOnly; Secure; SameSite=Lax']);
    if(url.endsWith('/api/auth/session'))return response(200,{user:{email:'reader@quiet-river.local'}});
    throw new Error('unexpected request');
  };
  const cookies=await createReaderWebSession({karakeep:'http://127.0.0.1:3062',accessToken:'fixture-secret'},fetchImpl);
  assert.equal(calls.length,3);assert.equal(cookies.length,1);assert.match(cookies[0],/^__Secure-next-auth\.session-token=opaque-session/);
  assert.doesNotMatch(cookies[0],/Domain=/i);assert.doesNotMatch(cookies[0],/fixture-secret/);
  assert.equal(new URLSearchParams(String(calls[1].options.body)).get('password'),'fixture-secret');
  assert.throws(()=>safeBase('https://reader.example.com'),/loopback/);
});
test('reader launch is QR-authenticated, keeps unread state and redirects through fixed Karakeep routes',async t=>{
  const {db,service}=setup(t,{content:'<p>Readable</p>',crawlStatus:'success'});
  db.run("UPDATE entries SET bookmark_id='bookmark-1',archive_state='QUEUED' WHERE id=1");let exchanges=0;
  const app=createApp(service,{accessToken:'reader-test',karakeep:'http://127.0.0.1:3062'},{createReaderWebSession:async()=>{
    exchanges++;return ['__Secure-next-auth.session-token=opaque; Path=/; HttpOnly; Secure; SameSite=Lax'];
  }});
  await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.close(r)));
  const base='http://127.0.0.1:'+app.address().port,auth={'X-Qr-Token':'reader-test'};
  assert.equal((await fetch(base+'/desk/reader/1',{redirect:'manual'})).status,401);assert.equal(exchanges,0);
  let response=await fetch(base+'/desk/reader/1',{headers:auth,redirect:'manual'});
  assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/reader/bookmark-1');
  assert.match(response.headers.get('set-cookie')||'',/__Secure-next-auth\.session-token=opaque/);
  assert.equal(db.get('SELECT status FROM entries WHERE id=1').status,'unread');
  response=await fetch(base+'/desk/reader-home?target=https://evil.example',{headers:auth,redirect:'manual'});
  assert.equal(response.headers.get('location'),'/dashboard/bookmarks');
  response=await fetch(base+'/desk/bookmark/bookmark-1',{headers:auth,redirect:'manual'});
  assert.equal(response.headers.get('location'),'/reader/bookmark-1');
});
test('native article detail reads current Miniflux body without creating a Karakeep archive',async t=>{
  const {service,kkCalls}=setup(t,{content:'<p>Full <strong>body</strong></p>'});
  const detail=await service.articleDetail(1);
  assert.equal(detail.title,'Article');assert.equal(detail.source,'Reader source');assert.equal(detail.sourceId,'reader-source');
  assert.equal(detail.content,'<p>Full <strong>body</strong></p>');assert.equal(detail.contentState,'TEXT');
  assert.equal(detail.readerMode,'reader');assert.equal(detail.canFetchFullText,true);assert.equal(detail.canAnnotate,true);assert.equal(kkCalls(),0);
});
test('native article prepare keeps the same entry and upgrades public full text only when better',async t=>{
  const full='<p>'+('expanded body '.repeat(220))+'</p>';
  const {db,service,mfCalls}=setup(t,{content:'<p>short</p>',fetchedContent:full});
  const detail=await service.articleDetail(1,{prepare:true});
  assert.equal(detail.id,1);assert.equal(detail.prepareAttempted,true);assert.equal(detail.prepareImproved,true);assert.equal(detail.content,full);
  assert.ok(detail.contentTextLength>1500);assert.equal(db.get('SELECT content_state FROM entries WHERE id=1').content_state,'TEXT');
  assert.ok(mfCalls.some(c=>c.path.includes('/fetch-content')));assert.ok(mfCalls.some(c=>c.path==='/v1/entries/1'&&c.method==='PUT'));
});
test('restricted metadata-only article detail never uses ECS full-text extraction',async t=>{
  const {db,service,mfCalls}=setup(t,{content:''});
  const restricted={id:'xhs-native',name:'XHS native',platform:'xiaohongshu',url:'https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567',tags:[]};
  const c={id:'xhs-native-channel',source_id:restricted.id,transport:'desktop',url:'https://quiet-river.invalid/xhs',group_key:'credential:xiaohongshu',enabled:true,interval_ms:21600000,min_gap_ms:8000};
  const entry2={id:2,title:'Restricted note',url:'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01',author:'XHS',published_at:null,content:'',status:'unread'};
  db.putSource(restricted,[c]);service.project(entry2,c);
  service.mf.call=async(path,method,value)=>{mfCalls.push({path,method,value});if(path==='/v1/entries/2')return entry2;if(path.includes('/fetch-content'))throw new Error('must not fetch restricted content');return {};};
  const detail=await service.articleDetail(2,{prepare:true});
  assert.equal(detail.readerMode,'original');assert.equal(detail.canFetchFullText,false);assert.equal(detail.prepareAttempted,false);assert.equal(detail.contentState,'META');
  assert.equal(mfCalls.some(c=>c.path.includes('/fetch-content')),false);
});
test('native article shell is addressable while article content APIs remain authenticated',async t=>{
  const {service}=setup(t,{content:'<p>Readable in Quiet River</p>'});
  const app=createApp(service,{accessToken:'reader-test'});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.close(r)));
  const base='http://127.0.0.1:'+app.address().port,auth={'X-Qr-Token':'reader-test'},write={...auth,'X-QR-Action':'1','Content-Type':'application/json'};
  let response=await fetch(base+'/desk/article/1');assert.equal(response.status,200);assert.match(await response.text(),/Quiet River/);
  assert.equal((await fetch(base+'/desk/api/entries/1')).status,401);
  response=await fetch(base+'/desk/api/entries/1',{headers:auth});assert.equal(response.status,200);assert.match((await response.json()).content,/Readable in Quiet River/);
  assert.equal((await fetch(base+'/desk/api/entries/1/prepare',{method:'POST',headers:auth,body:'{}'})).status,403);
  response=await fetch(base+'/desk/api/entries/1/prepare',{method:'POST',headers:write,body:'{}'});assert.equal(response.status,200);assert.equal((await response.json()).id,1);
});
test('metadata-only native note uses a separate Karakeep text bookmark without consuming content bookmark identity',async t=>{
  const {db,service}=setup(t,{content:''});let note='';const calls=[];
  service.kk.call=async(path,method='GET',payload)=>{calls.push({path,method,payload});
    if(path==='/api/v1/bookmarks'&&method==='POST')return {id:'note-only-1',note:'',content:{type:'text',text:payload.text,sourceUrl:payload.sourceUrl}};
    if(path==='/api/v1/bookmarks/note-only-1'&&method==='PATCH'){note=payload.note;return {id:'note-only-1',note,content:{type:'text'}};}
    if(path==='/api/v1/bookmarks/note-only-1')return {id:'note-only-1',note,content:{type:'text'}};
    throw new Error('unexpected Karakeep call '+method+' '+path);
  };
  const saved=await service.saveArticleNote(1,'我的站内笔记');
  assert.equal(saved.bookmarkId,'note-only-1');assert.equal(saved.note,'我的站内笔记');
  const row=db.get('SELECT bookmark_id,note_bookmark_id FROM entries WHERE id=1');
  assert.equal(row.bookmark_id,null);assert.equal(row.note_bookmark_id,'note-only-1');
  const create=calls.find(c=>c.path==='/api/v1/bookmarks'&&c.method==='POST');
  assert.equal(create.payload.type,'text');assert.equal(create.payload.sourceUrl,'https://example.com/article');
  const detail=await service.articleDetail(1);assert.equal(detail.note,'我的站内笔记');assert.equal(detail.noteBookmarkId,'note-only-1');
});
test('native note reuses an existing content bookmark and persists only the mapping reference locally',async t=>{
  const {db,service}=setup(t,{content:'<p>full text</p>'});db.run("UPDATE entries SET bookmark_id='content-bookmark',archive_state='READY' WHERE id=1");
  let note='';const calls=[];service.kk.call=async(path,method='GET',payload)=>{calls.push({path,method,payload});
    if(path==='/api/v1/bookmarks/content-bookmark'&&method==='PATCH'){note=payload.note;return {id:'content-bookmark',note,content:{type:'link',crawlStatus:'success'}};}
    if(path==='/api/v1/bookmarks/content-bookmark')return {id:'content-bookmark',note,content:{type:'link',crawlStatus:'success'}};
    throw new Error('unexpected Karakeep call '+method+' '+path);
  };
  await service.saveArticleNote(1,'共享正文归档上的笔记');
  const row=db.get('SELECT bookmark_id,note_bookmark_id FROM entries WHERE id=1');
  assert.equal(row.bookmark_id,'content-bookmark');assert.equal(row.note_bookmark_id,'content-bookmark');
  assert.equal(calls.some(c=>c.path==='/api/v1/bookmarks'&&c.method==='POST'),false);
  assert.equal((await service.articleNote(1)).note,'共享正文归档上的笔记');
});
test('article note length is bounded before creating any Karakeep object',async t=>{
  const {db,service}=setup(t,{content:''});let called=false;service.kk.call=async()=>{called=true;return {};};
  await assert.rejects(service.saveArticleNote(1,'x'.repeat(50001)),e=>e.status===400);
  assert.equal(called,false);assert.equal(db.get('SELECT note_bookmark_id FROM entries WHERE id=1').note_bookmark_id,null);
});
test('native article note endpoint is action-protected and round-trips through Karakeep',async t=>{
  const {service}=setup(t,{content:''});let note='';service.kk.call=async(path,method='GET',payload)=>{
    if(path==='/api/v1/bookmarks'&&method==='POST')return {id:'http-note-1',note:'',content:{type:'text'}};
    if(path==='/api/v1/bookmarks/http-note-1'&&method==='PATCH'){note=payload.note;return {id:'http-note-1',note,content:{type:'text'}};}
    if(path==='/api/v1/bookmarks/http-note-1')return {id:'http-note-1',note,content:{type:'text'}};
    throw new Error('unexpected note call');
  };
  const app=createApp(service,{accessToken:'reader-test'});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.close(r)));
  const base='http://127.0.0.1:'+app.address().port,auth={'X-Qr-Token':'reader-test','Content-Type':'application/json'},write={...auth,'X-QR-Action':'1'};
  assert.equal((await fetch(base+'/desk/api/entries/1/note',{method:'POST',body:JSON.stringify({note:'x'})})).status,401);
  assert.equal((await fetch(base+'/desk/api/entries/1/note',{method:'POST',headers:auth,body:JSON.stringify({note:'x'})})).status,403);
  let response=await fetch(base+'/desk/api/entries/1/note',{method:'POST',headers:write,body:JSON.stringify({note:'round trip note'})});
  assert.equal(response.status,200);assert.equal((await response.json()).note,'round trip note');
  response=await fetch(base+'/desk/api/entries/1',{headers:{'X-Qr-Token':'reader-test'}});const detail=await response.json();
  assert.equal(detail.note,'round trip note');assert.equal(detail.noteBookmarkId,'http-note-1');
});
test('saving an empty note on an untouched article does not create an empty bookmark',async t=>{
  const {db,service}=setup(t,{content:''});let called=false;service.kk.call=async()=>{called=true;return {};};
  const saved=await service.saveArticleNote(1,'');
  assert.equal(saved.bookmarkId,null);assert.equal(saved.note,'');assert.equal(called,false);
  const row=db.get('SELECT bookmark_id,note_bookmark_id FROM entries WHERE id=1');
  assert.equal(row.bookmark_id,null);assert.equal(row.note_bookmark_id,null);
});
