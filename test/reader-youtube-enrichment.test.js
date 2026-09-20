'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Database}=require('../reader-bridge/database');
const {ReaderService}=require('../reader-bridge/service');
const {hash}=require('../reader-bridge/core');
const {youtubeVideoTarget,transcriptFromJson3,renderTranscript,youtubeTranscript}=require('../reader-bridge/youtube-enrichment');

test('YouTube target accepts only canonical video URLs and stable 11-char IDs',()=>{
  assert.deepEqual(youtubeVideoTarget('https://www.youtube.com/watch?v=TlR7douxQRM'),{kind:'youtube-video',videoId:'TlR7douxQRM',url:'https://www.youtube.com/watch?v=TlR7douxQRM'});
  assert.deepEqual(youtubeVideoTarget('https://youtu.be/TlR7douxQRM'),{kind:'youtube-video',videoId:'TlR7douxQRM',url:'https://www.youtube.com/watch?v=TlR7douxQRM'});
  for(const bad of [
    'http://www.youtube.com/watch?v=TlR7douxQRM',
    'https://evil.example/watch?v=TlR7douxQRM',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=short',
    'https://user:pass@www.youtube.com/watch?v=TlR7douxQRM'
  ])assert.equal(youtubeVideoTarget(bad),null,bad);
});

test('YouTube JSON3 transcript deduplicates events, groups paragraphs and escapes text',()=>{
  const parsed=transcriptFromJson3({events:[
    {tStartMs:0,dDurationMs:1000,segs:[{utf8:'Hello '},{utf8:'world'}]},
    {tStartMs:1000,dDurationMs:1000,segs:[{utf8:'Hello world'}]},
    {tStartMs:2200,dDurationMs:1000,segs:[{utf8:'safe <script>alert(1)</script>'}]},
    {tStartMs:9000,dDurationMs:1000,segs:[{utf8:'Second paragraph'}]}
  ]});
  assert.equal(parsed.paragraphs.length,2);
  assert.match(parsed.paragraphs[0].text,/Hello world safe/);
  const html=renderTranscript(parsed,{language:'en-orig',automatic:true});
  assert.match(html,/YouTube Transcript/);assert.match(html,/00:00/);assert.match(html,/00:09/);
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});

test('YouTube runner uses pinned read-only subtitle command, loopback proxy and cleans temp files',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qr-youtube-test-')),bin=path.join(root,'yt-dlp');fs.writeFileSync(bin,'fixture');
  let tempDir='',call=null;
  const spawnFn=(cmd,args,opts)=>{
    call={cmd,args,opts};const output=args[args.indexOf('-o')+1];tempDir=path.dirname(output);
    fs.writeFileSync(path.join(tempDir,'TlR7douxQRM.en-orig.json3'),JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:'Transcript fixture text long enough for validation.'}]}]}));
    return {status:0,stdout:'',stderr:''};
  };
  try{
    const service={config:{tools:{ytDlp:bin,youtubeProxy:'http://127.0.0.1:7890'}}};
    const out=youtubeTranscript(service,{kind:'youtube-video',videoId:'TlR7douxQRM',url:'https://www.youtube.com/watch?v=TlR7douxQRM'},{spawnFn});
    assert.match(out.html,/Transcript fixture/);assert.equal(out.language,'en-orig');
    assert.equal(call.cmd,bin);assert.ok(call.args.includes('--skip-download'));assert.ok(call.args.includes('--write-auto-subs'));
    assert.ok(call.args.includes('--ignore-config'));assert.ok(call.args.includes('--proxy'));assert.ok(call.args.includes('http://127.0.0.1:7890'));
    assert.equal(call.args.some(x=>String(x).includes('cookies')),false);
    assert.equal(fs.existsSync(tempDir),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('YouTube runner rejects non-loopback proxy before executing yt-dlp',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qr-youtube-test-')),bin=path.join(root,'yt-dlp');fs.writeFileSync(bin,'fixture');let calls=0;
  try{
    const service={config:{tools:{ytDlp:bin,youtubeProxy:'https://proxy.example.com'}}};
    assert.throws(()=>youtubeTranscript(service,{kind:'youtube-video',videoId:'TlR7douxQRM',url:'https://www.youtube.com/watch?v=TlR7douxQRM'},{spawnFn:()=>{calls++;return {status:0};}}),/loopback-only/);
    assert.equal(calls,0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

function setupService(t,{fail=false}={}){
  const db=new Database(':memory:');t.after(()=>db.close());
  const source={id:'yt-source',name:'ACM RecSys',platform:'youtube',url:'https://www.youtube.com/@acmrecsys',tags:['推荐系统'],feeds:['https://www.youtube.com/feeds/videos.xml?channel_id=UC2nEn-yNA1BtdDNWziphPGA']};
  const channel={id:'yt-channel',source_id:source.id,transport:'public',url:source.feeds[0],group_key:'youtube.com',enabled:true,interval_ms:1800000,min_gap_ms:0};
  db.putSource(source,[channel]);db.run('UPDATE channels SET feed_id=3 WHERE id=?',channel.id);
  let entry={id:8709,title:'Keynote Xavier Amatriain',url:'https://www.youtube.com/watch?v=TlR7douxQRM',author:'ACM RecSys',published_at:'2026-09-01T00:00:00Z',content:'<p>'+('existing description '.repeat(120))+'</p>',status:'unread'};
  const mfCalls=[];const mf={call:async(path,method='GET',value)=>{mfCalls.push({path,method,value});if(path==='/v1/entries/8709'&&method==='PUT'){entry={...entry,...value};return {};}if(path==='/v1/entries/8709')return {...entry};throw new Error('unexpected '+method+' '+path);}};
  let transcriptCalls=0;const transcript=async()=>{transcriptCalls++;if(fail)throw new Error('subtitle unavailable');return {html:'<section><h2>YouTube Transcript</h2><p><time>00:00</time> transcript body</p></section>',language:'en-orig',chars:15,truncated:false};};
  const service=new ReaderService(db,{miniflux:'http://unused',minifluxToken:'x',karakeep:'http://unused',karakeepToken:'',tools:{},adapters:{}},{mf,youtubeTranscript:transcript});
  service.project(entry,channel);db.run("INSERT INTO imports(channel_id,external_id,entry_id,content_hash,payload,state,original_published_at,published_at_source,content_state,content_origin) VALUES(?,?,?,?,?,'COMPLETE',?,'upstream','TEXT','adapter_feed')",channel.id,'youtube:fixture',8709,hash(entry.content),'{}',Date.parse(entry.published_at));
  db.run("UPDATE entries SET status='read' WHERE id=8709");db.set('ui.article.read.8709',{status:'read',changedAt:Date.now()+60000});
  return {db,service,mfCalls,transcriptCalls:()=>transcriptCalls,getEntry:()=>({...entry})};
}

test('YouTube prepare appends transcript once even when Atom description is already long',async t=>{
  const f=setupService(t);const before=f.db.get('SELECT url,published_at,status FROM entries WHERE id=8709');
  const plain=await f.service.articleDetail(8709);assert.equal(plain.prepareKind,'youtube-transcript');assert.equal(plain.canFetchFullText,true);assert.ok(plain.contentTextLength>1500);
  const enriched=await f.service.articleDetail(8709,{prepare:true});
  assert.equal(f.transcriptCalls(),1);assert.equal(enriched.prepareImproved,true);assert.match(enriched.content,/existing description/);assert.match(enriched.content,/YouTube Transcript/);
  assert.equal(enriched.contentOrigin,'youtube_subtitle_enrichment');assert.equal(enriched.canFetchFullText,false);assert.equal(enriched.prepareKind,null);
  assert.deepEqual(f.db.get('SELECT url,published_at,status FROM entries WHERE id=8709'),before);
  const cache=f.db.get("SELECT state,detail FROM entry_enrichments WHERE entry_id=8709 AND kind='youtube_transcript_v1'");assert.equal(cache.state,'DONE');assert.equal(JSON.parse(cache.detail).language,'en-orig');
  assert.equal(f.db.get('SELECT content_origin FROM imports WHERE entry_id=8709').content_origin,'youtube_subtitle_enrichment');
  const again=await f.service.articleDetail(8709,{prepare:true});assert.equal(f.transcriptCalls(),1);assert.equal(again.canFetchFullText,false);
});

test('YouTube subtitle failure retains Atom body and records failed enrichment',async t=>{
  const f=setupService(t,{fail:true}),before=f.db.get('SELECT url,published_at,status,content_origin FROM entries WHERE id=8709'),old=f.getEntry().content;
  const result=await f.service.articleDetail(8709,{prepare:true});
  assert.equal(f.transcriptCalls(),1);assert.equal(result.prepareImproved,false);assert.equal(f.getEntry().content,old);
  assert.deepEqual(f.db.get('SELECT url,published_at,status,content_origin FROM entries WHERE id=8709'),before);
  assert.equal(f.db.get("SELECT state FROM entry_enrichments WHERE entry_id=8709 AND kind='youtube_transcript_v1'").state,'FAILED');
});

test('yt-dlp installer pins the audited release and SHA instead of tracking latest',()=>{
  const installer=fs.readFileSync(path.join(__dirname,'../deploy/install-ytdlp.sh'),'utf8');
  assert.match(installer,/VERSION="2026\.08\.19"/);
  assert.match(installer,/1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6/);
  assert.match(installer,/sha256sum -c/);
  assert.doesNotMatch(installer,/releases\/latest|pip install\s+yt-dlp(?!==)/);
});
