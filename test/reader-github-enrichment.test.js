'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Database}=require('../reader-bridge/database');
const {ReaderService}=require('../reader-bridge/service');
const {hash}=require('../reader-bridge/core');
const {githubDetailTarget,apiUrl,renderCommit,renderCompare,githubEnrichment}=require('../reader-bridge/github-enrichment');

test('GitHub enrichment target accepts only canonical commit/compare URLs',()=>{
  assert.deepEqual(githubDetailTarget('https://github.com/Doragd/Algorithm-Practice-in-Industry/commit/7b734408e365f514cfef0b15fd5517ed420e16c0'),
    {kind:'commit',owner:'Doragd',repo:'Algorithm-Practice-in-Industry',sha:'7b734408e365f514cfef0b15fd5517ed420e16c0'});
  assert.deepEqual(githubDetailTarget('https://github.com/sherkevin/quiet-river/compare/abcdef1...1234567'),
    {kind:'compare',owner:'sherkevin',repo:'quiet-river',base:'abcdef1',head:'1234567'});
  for(const bad of [
    'http://github.com/a/b/commit/abcdef1',
    'https://evil.example/a/b/commit/abcdef1',
    'https://user:pass@github.com/a/b/commit/abcdef1',
    'https://github.com:444/a/b/commit/abcdef1',
    'https://github.com/a/b/tree/main',
    'https://github.com/a/b/compare/main...abcdef1'
  ])assert.equal(githubDetailTarget(bad),null,bad);
});

test('GitHub commit rendering validates identity and escapes upstream-controlled text',()=>{
  const t={kind:'commit',owner:'a',repo:'b',sha:'abcdef1'};
  const html=renderCommit({
    sha:'abcdef1234567890',html_url:'https://github.com/a/b/commit/abcdef1234567890',
    commit:{message:'fix <script>alert(1)</script>',author:{name:'A <B>',date:'2026-09-20T00:00:00Z'}},
    stats:{additions:2,deletions:1,total:3},
    files:[{filename:'<img src=x onerror=1>.js',status:'modified',additions:2,deletions:1}]
  },t);
  assert.match(html,/GitHub Commit 详情/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img/);
  assert.doesNotMatch(html,/<script|<img/i);
  assert.throws(()=>renderCommit({sha:'deadbeef',html_url:'https://github.com/a/b/commit/deadbeef',commit:{}},t),/identity mismatch/);
  assert.throws(()=>renderCommit({sha:'abcdef123',html_url:'https://github.com/other/b/commit/abcdef123',commit:{}},t),/identity mismatch/);
});

test('GitHub compare rendering binds base/head identity and escapes commit messages',()=>{
  const t={kind:'compare',owner:'a',repo:'b',base:'abcdef1',head:'1234567'};
  const html=renderCompare({
    html_url:'https://github.com/a/b/compare/abcdef1...1234567',status:'ahead',ahead_by:2,behind_by:0,total_commits:1,
    base_commit:{sha:'abcdef123456'},head_commit:{sha:'123456789abc'},
    commits:[{sha:'123456789abc',commit:{message:'hello <b>unsafe</b>\nbody'}}],
    files:[]
  },t);
  assert.match(html,/GitHub Compare 详情/);assert.match(html,/hello &lt;b&gt;unsafe&lt;\/b&gt;/);assert.doesNotMatch(html,/<b>unsafe/);
  assert.throws(()=>renderCompare({...{},html_url:'https://github.com/a/b/compare/abcdef1...9999999',base_commit:{sha:'abcdef123'},head_commit:{sha:'999999999'}},t),/identity mismatch/);
});

test('GitHub REST adapter is public/read-only, bounded and rejects HTTP/JSON failures',async()=>{
  const target={kind:'commit',owner:'a',repo:'b',sha:'abcdef1'},calls=[];
  const service={internalFetch:async(url,opts)=>{calls.push({url,opts});return {status:200,headers:{'x-ratelimit-remaining':'58'},body:Buffer.from(JSON.stringify({
    sha:'abcdef123',html_url:'https://github.com/a/b/commit/abcdef123',commit:{message:'m',author:{name:'a'}},stats:{total:0},files:[]
  }))};}};
  const out=await githubEnrichment(service,target);assert.match(out.html,/GitHub Commit 详情/);assert.equal(out.rateRemaining,'58');
  assert.equal(calls.length,1);assert.equal(calls[0].url,apiUrl(target));assert.equal(calls[0].opts.trusted,false);assert.equal(calls[0].opts.maxBytes,2*1024*1024);assert.equal(calls[0].opts.method,undefined);
  await assert.rejects(githubEnrichment({internalFetch:async()=>({status:429,body:Buffer.from('{}'),headers:{}})},target),/GitHub API HTTP 429/);
  await assert.rejects(githubEnrichment({internalFetch:async()=>({status:200,body:Buffer.from('bad'),headers:{}})},target),/invalid JSON/);
});

function setupService(t,{restFailure=false,fetchedContent=''}={}){
  const db=new Database(':memory:');t.after(()=>db.close());
  const source={id:'gh-source',name:'Repo',platform:'github',url:'https://github.com/Doragd/Algorithm-Practice-in-Industry/commits.atom',tags:['GitHub'],feeds:['https://github.com/Doragd/Algorithm-Practice-in-Industry/commits.atom']};
  const channel={id:'gh-channel',source_id:source.id,transport:'public',url:source.feeds[0],group_key:'github.com',enabled:true,interval_ms:1800000,min_gap_ms:0};
  db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=1 WHERE id=?',channel.id);
  let entry={id:77,title:'Old Atom title',url:'https://github.com/Doragd/Algorithm-Practice-in-Industry/commit/7b734408e365f514cfef0b15fd5517ed420e16c0',author:'Doragd',published_at:'2026-09-20T01:02:03Z',content:'<p>old atom body</p>',status:'unread'};
  const mfCalls=[],restCalls=[];
  const mf={call:async(path,method='GET',value)=>{
    mfCalls.push({path,method,value});
    if(path.includes('/fetch-content'))return {content:fetchedContent};
    if(path==='/v1/entries/77'&&method==='PUT'){entry={...entry,...value};return {};}
    if(path==='/v1/entries/77')return {...entry};
    throw new Error('unexpected Miniflux call '+method+' '+path);
  }};
  const internalFetch=async(url,opts)=>{
    restCalls.push({url,opts});
    if(restFailure)return {status:429,headers:{'x-ratelimit-remaining':'0'},body:Buffer.from('{}')};
    return {status:200,headers:{'x-ratelimit-remaining':'57'},body:Buffer.from(JSON.stringify({
      sha:'7b734408e365f514cfef0b15fd5517ed420e16c0',
      html_url:entry.url,
      commit:{message:'structured commit detail',author:{name:'Doragd',date:'2026-09-20T01:02:03Z'}},
      stats:{additions:6,deletions:5,total:11},
      files:[{filename:'README.md',status:'modified',additions:6,deletions:5}]
    }))};
  };
  const service=new ReaderService(db,{miniflux:'http://unused',minifluxToken:'x',karakeep:'http://unused',karakeepToken:'',adapters:{}},{mf,internalFetch});
  service.project(entry,channel);
  db.run("INSERT INTO imports(channel_id,external_id,entry_id,content_hash,payload,state,original_published_at,published_at_source,content_state,content_origin) VALUES(?,?,?,?,?,'COMPLETE',?,'upstream','TEXT','adapter_feed')",
    channel.id,'github:fixture',77,hash(entry.content),'{}',Date.parse(entry.published_at));
  db.run("UPDATE entries SET status='read' WHERE id=77");db.set('ui.article.read.77',{status:'read',changedAt:Date.now()+60000});
  return {db,service,mfCalls,restCalls,getEntry:()=>({...entry}),channel};
}

test('GitHub prepare enriches once, caches provenance and preserves article identity/read metadata',async t=>{
  const f=setupService(t);
  const before=f.db.get('SELECT url,published_at,status FROM entries WHERE id=77');
  const plain=await f.service.articleDetail(77);assert.equal(f.restCalls.length,0);assert.equal(plain.canFetchFullText,true);
  const enriched=await f.service.articleDetail(77,{prepare:true});
  assert.equal(f.restCalls.length,1);assert.equal(enriched.prepareImproved,true);assert.match(enriched.content,/GitHub Commit 详情/);assert.equal(enriched.canFetchFullText,false);
  assert.equal(enriched.contentOrigin,'github_rest_enrichment');
  assert.deepEqual(f.db.get('SELECT url,published_at,status FROM entries WHERE id=77'),before);
  const cache=f.db.get("SELECT state,detail FROM entry_enrichments WHERE entry_id=77 AND kind='github_rest_v1'");assert.equal(cache.state,'DONE');assert.equal(JSON.parse(cache.detail).rateRemaining,'57');
  const imported=f.db.get('SELECT content_state,content_origin FROM imports WHERE entry_id=77');assert.equal(imported.content_state,'TEXT');assert.equal(imported.content_origin,'github_rest_enrichment');
  assert.equal(f.mfCalls.filter(x=>x.path==='/v1/entries/77'&&x.method==='PUT').length,1);
  const again=await f.service.articleDetail(77,{prepare:true});assert.equal(f.restCalls.length,1);assert.equal(again.canFetchFullText,false);
});

test('GitHub REST failure records failure and retains Atom content/read metadata',async t=>{
  const f=setupService(t,{restFailure:true,fetchedContent:''});
  const before=f.db.get('SELECT url,published_at,status,content_origin FROM entries WHERE id=77'),old=f.getEntry().content;
  const result=await f.service.articleDetail(77,{prepare:true});
  assert.equal(f.restCalls.length,1);assert.equal(result.prepareImproved,false);assert.match(result.content,/old atom body/);
  assert.equal(f.getEntry().content,old);assert.deepEqual(f.db.get('SELECT url,published_at,status,content_origin FROM entries WHERE id=77'),before);
  assert.equal(f.db.get("SELECT state FROM entry_enrichments WHERE entry_id=77 AND kind='github_rest_v1'").state,'FAILED');
});
