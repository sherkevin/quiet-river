'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Database}=require('../reader-bridge/database');
const {ReaderService}=require('../reader-bridge/service');
const {hash}=require('../reader-bridge/core');
const {probeBackend}=require('../reader-bridge/acquisition-backends');
const {bilibiliVideoTarget,validatePayload,renderVideo,bilibiliDetail}=require('../reader-bridge/bilibili-enrichment');

test('Bilibili detail target accepts only canonical BV video URLs',()=>{
  assert.deepEqual(
    bilibiliVideoTarget('https://www.bilibili.com/video/BV1AaJP6iEch'),
    {kind:'bilibili-video',bvid:'BV1AaJP6iEch',url:'https://www.bilibili.com/video/BV1AaJP6iEch'}
  );
  assert.deepEqual(
    bilibiliVideoTarget('https://www.bilibili.com/video/BV1AaJP6iEch/?spm_id_from=333'),
    {kind:'bilibili-video',bvid:'BV1AaJP6iEch',url:'https://www.bilibili.com/video/BV1AaJP6iEch'}
  );
  for(const bad of [
    'http://www.bilibili.com/video/BV1AaJP6iEch',
    'https://bilibili.com/video/BV1AaJP6iEch',
    'https://www.bilibili.com/read/BV1AaJP6iEch',
    'https://www.bilibili.com/video/av123',
    'https://user:pass@www.bilibili.com/video/BV1AaJP6iEch',
    'https://www.bilibili.com:444/video/BV1AaJP6iEch'
  ])assert.equal(bilibiliVideoTarget(bad),null,bad);
});

test('Bilibili payload validator binds BV identity, canonical URL and subscribed owner UID',()=>{
  const target={kind:'bilibili-video',bvid:'BV1AaJP6iEch',url:'https://www.bilibili.com/video/BV1AaJP6iEch'};
  const payload={video:{bvid:target.bvid,url:target.url,title:'Video',owner:{id:'503316308',name:'AITIME'}}};
  assert.equal(validatePayload(payload,target,{expectedOwnerId:'503316308'}).bvid,target.bvid);
  assert.throws(()=>validatePayload({video:{...payload.video,bvid:'BV1cvJP6eEbv'}},target,{expectedOwnerId:'503316308'}),/identity mismatch/);
  assert.throws(()=>validatePayload({video:{...payload.video,url:'https://www.bilibili.com/video/BV1cvJP6eEbv'}},target,{expectedOwnerId:'503316308'}),/identity mismatch/);
  assert.throws(()=>validatePayload({video:{...payload.video,owner:{id:'123',name:'Other'}}},target,{expectedOwnerId:'503316308'}),/owner mismatch/);
});

test('Bilibili detail renderer escapes upstream text and keeps bounded structured stats',()=>{
  const html=renderVideo({
    bvid:'BV1AaJP6iEch',title:'<script>alert(1)</script>',description:'desc <img src=x onerror=1>',
    duration:'12:34',owner:{id:'503316308',name:'A <B>'},
    stats:{view:10,danmaku:2,like:3,coin:4,favorite:5,share:6}
  });
  assert.match(html,/Bilibili Video 详情/);
  assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<script|<img/i);
  assert.match(html,/播放 10/);assert.match(html,/点赞 3/);
});

test('Bilibili detail adapter uses only the public read-only API with bounded unauthenticated request',async()=>{
  const target={kind:'bilibili-video',bvid:'BV1AaJP6iEch',url:'https://www.bilibili.com/video/BV1AaJP6iEch'},calls=[];
  const service={internalFetch:async(url,opts)=>{calls.push({url,opts});return {status:200,body:Buffer.from(JSON.stringify({code:0,data:{
    bvid:target.bvid,title:'Detail',desc:'Description',duration:600,owner:{mid:503316308,name:'AITIME'},stat:{view:1,danmaku:2,like:3,coin:4,favorite:5,share:6}
  }}))};}};
  const out=await bilibiliDetail(service,target,{expectedOwnerId:'503316308'});
  assert.match(out.html,/Description/);assert.equal(out.ownerId,'503316308');assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.bilibili.com/x/web-interface/view?bvid=BV1AaJP6iEch');assert.equal(calls[0].opts.trusted,false);assert.equal(calls[0].opts.maxBytes,2*1024*1024);
  assert.equal(Object.keys(calls[0].opts.headers).some(k=>/cookie|authorization/i.test(k)),false);
});

test('Bilibili public detail doctor is observational and does not contact the platform',async()=>{
  let calls=0;const result=await probeBackend({config:{},internalFetch:async()=>{calls++;throw new Error('must not call');}},'bilibili-public-detail-api');
  assert.equal(result.status,'warn');assert.equal(result.state,'UNVERIFIED');assert.match(result.reason,/doctor does not contact Bilibili/);assert.equal(calls,0);
});

function setupService(t,{fail=false,ownerId='503316308'}={}){
  const db=new Database(':memory:');t.after(()=>db.close());
  const source={id:'bili-source',name:'AITIME',platform:'bilibili',url:'http://127.0.0.1:1200/bilibili/user/video/503316308',tags:['AI'],feeds:['http://127.0.0.1:1200/bilibili/user/video/503316308'],adapter:{id:'503316308'}};
  const channel={id:'bili-channel',source_id:source.id,transport:'desktop',url:'https://quiet-river.invalid/desktop/bilibili/503316308/videos',group_key:'desktop:bilibili',enabled:true,interval_ms:21600000,min_gap_ms:8000,author_id:'503316308',desktop_kind:'videos'};
  db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=4 WHERE id=?',channel.id);
  let entry={id:7042,title:'ICML 2026 oral/spotlight',url:'https://www.bilibili.com/video/BV1AaJP6iEch',author:'AITIME',published_at:'2026-09-01T00:00:00Z',content:'',status:'unread'};
  const mfCalls=[];const mf={call:async(pathName,method='GET',value)=>{
    mfCalls.push({path:pathName,method,value});
    if(pathName==='/v1/entries/7042'&&method==='PUT'){entry={...entry,...value};return {};}
    if(pathName==='/v1/entries/7042')return {...entry};
    throw new Error('unexpected '+method+' '+pathName);
  }};
  let detailCalls=0;const detail=async(_service,target,options)=>{
    detailCalls++;assert.equal(target.bvid,'BV1AaJP6iEch');assert.equal(options.expectedOwnerId,'503316308');
    if(fail)throw new Error('bili detail unavailable');
    if(ownerId!=='503316308')throw new Error('Bilibili video owner mismatch');
    return {html:'<section><h2>Bilibili Video 详情</h2><p>structured body</p></section>',bvid:target.bvid,ownerId:'503316308',title:'Detail'};
  };
  const service=new ReaderService(db,{miniflux:'http://unused',minifluxToken:'x',karakeep:'http://unused',karakeepToken:'',tools:{},adapters:{}},{mf,bilibiliDetail:detail});
  service.project(entry,channel);
  db.run("INSERT INTO imports(channel_id,external_id,entry_id,content_hash,payload,state,original_published_at,published_at_source,content_state,content_origin) VALUES(?,?,?,?,?,'COMPLETE',?,'upstream','META','adapter_feed')",
    channel.id,'bilibili:fixture',7042,hash(''),'{}',Date.parse(entry.published_at));
  db.run("UPDATE entries SET status='read' WHERE id=7042");db.set('ui.article.read.7042',{status:'read',changedAt:Date.now()+60000});
  return {db,service,mfCalls,detailCalls:()=>detailCalls,getEntry:()=>({...entry})};
}

test('Bilibili prepare upgrades META to cached TEXT while preserving source identity/read metadata',async t=>{
  const f=setupService(t),before=f.db.get('SELECT url,published_at,status FROM entries WHERE id=7042');
  const plain=await f.service.articleDetail(7042);assert.equal(plain.prepareKind,'bilibili-detail');assert.equal(plain.contentState,'META');
  const enriched=await f.service.articleDetail(7042,{prepare:true});
  assert.equal(f.detailCalls(),1);assert.equal(enriched.prepareImproved,true);assert.match(enriched.content,/Bilibili Video 详情/);
  assert.equal(enriched.contentState,'TEXT');assert.equal(enriched.contentOrigin,'bilibili_public_detail_enrichment');
  assert.equal(enriched.prepareKind,null);assert.equal(enriched.canFetchFullText,false);
  assert.deepEqual(f.db.get('SELECT url,published_at,status FROM entries WHERE id=7042'),before);
  const cache=f.db.get("SELECT state,detail FROM entry_enrichments WHERE entry_id=7042 AND kind='bilibili_detail_v1'");assert.equal(cache.state,'DONE');assert.equal(JSON.parse(cache.detail).ownerId,'503316308');
  assert.equal(f.db.get('SELECT content_origin FROM imports WHERE entry_id=7042').content_origin,'bilibili_public_detail_enrichment');
  await f.service.articleDetail(7042,{prepare:true});assert.equal(f.detailCalls(),1);
});

test('Bilibili detail failure preserves META card and existing read/url/time state',async t=>{
  const f=setupService(t,{fail:true}),before=f.db.get('SELECT url,published_at,status,content_state,content_origin FROM entries WHERE id=7042');
  const result=await f.service.articleDetail(7042,{prepare:true});
  assert.equal(f.detailCalls(),1);assert.equal(result.prepareImproved,false);assert.equal(result.contentState,'META');
  assert.deepEqual(f.db.get('SELECT url,published_at,status,content_state,content_origin FROM entries WHERE id=7042'),before);
  assert.equal(f.db.get("SELECT state FROM entry_enrichments WHERE entry_id=7042 AND kind='bilibili_detail_v1'").state,'FAILED');
});

test('Bilibili public detail treats HTTP/API/JSON failures as failures, never as empty video',async()=>{
  const target={kind:'bilibili-video',bvid:'BV1AaJP6iEch',url:'https://www.bilibili.com/video/BV1AaJP6iEch'};
  await assert.rejects(bilibiliDetail({internalFetch:async()=>({status:412,body:Buffer.from('{}')})},target),/HTTP 412/);
  await assert.rejects(bilibiliDetail({internalFetch:async()=>({status:200,body:Buffer.from('bad')})},target),/invalid JSON/);
  await assert.rejects(bilibiliDetail({internalFetch:async()=>({status:200,body:Buffer.from(JSON.stringify({code:-404,data:null}))})},target),/rejected request/);
});
