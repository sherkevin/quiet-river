'use strict';
const fs = require('node:fs');
const {hash,json,escapeHTML,opmlFor,channelsFor,rankEntries,buildArchive,stripHTML,safeURL,classifyError,articleKey} = require('./core');
const {ApiClient,request} = require('./network');
const {fetchNativeMetadata}=require('./native-metadata');
const {normalizeTags,containsAllTags,requestedTags}=require('./tags');
const meta=require('./article-metadata');
const reading=require('./reading-history');
const {capabilityReport}=require('./capabilities');
const {runBackend,doctorBackends}=require('./acquisition-backends');
const {githubDetailTarget,githubEnrichment}=require('./github-enrichment');
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

class ReaderService {
  constructor(db,config,clients={}) {
    this.db=db;this.config=config;this.stopping=false;this.working=false;this.archiving=new Map();this.readWrites=new Map();
    this.mf=clients.mf || new ApiClient(config.miniflux,{ 'X-Auth-Token':config.minifluxToken });
    this.kk=clients.kk || new ApiClient(config.karakeep,{Authorization:`Bearer ${config.karakeepToken || ''}`});
    this.internalFetch=clients.internalFetch || request;
    this.fetchNative=clients.fetchNative || fetchNativeMetadata;
    meta.ensureSnapshots(db);
  }
  async importManifest(manifest,options={}) {
    if(!Array.isArray(manifest.subscriptions))throw new Error('manifest missing subscriptions array');
    const ids=new Set();
    for(const s of manifest.subscriptions){
      if(!s.id||!s.name||ids.has(s.id))throw new Error('invalid or duplicate source ID');ids.add(s.id);
      normalizeTags(s.tags||[]);
      if(s.content_policy!==undefined&&!['feed_full','fetch_public_html','adapter_full','metadata_only'].includes(s.content_policy))throw new Error('invalid content policy');
    }
    // Complete validation before the first persistent write.
    for(const s of manifest.subscriptions){
      this.db.putSource(s,channelsFor(s,{...this.config.adapters,...options}));
    }
    if(!this.db.setting('manifest_imported_at',0))this.db.set('manifest_imported_at',Date.now());this.db.set('manifest_source_count',this.db.sources().length);
    await this.provisionChannels(ids);
    return {sources:this.db.sources().length,channels:this.db.channels().length};
  }
  async provisionChannels(sourceIds) {
    const channels=this.db.channels().filter(c=>!sourceIds||sourceIds.has(c.source_id));
    if(!channels.length)return;
    await this.mf.call('/v1/import','POST',opmlFor(channels,this.db.sources()),{headers:{'Content-Type':'application/xml'}});
    const feeds=await this.mf.call('/v1/feeds');
    for(const c of channels){
      const identity=c.transport==='public'?c.url:`https://quiet-river.invalid/channel/${c.id}`;
      const feed=feeds.find(f=>f.feed_url===identity);
      if(!feed)throw new Error('Miniflux did not create channel '+c.id);
      this.db.run('UPDATE channels SET feed_id=? WHERE id=?',feed.id,c.id);
      // All refresh requests go through our single scheduler. No interest-based ingestion filters.
      const source=this.db.sources().find(s=>s.id===c.source_id);
      const policy=source?.content_policy;
      const patch={disabled:true,blocklist_rules:'',keeplist_rules:'',block_filter_entry_rules:'',keep_filter_entry_rules:''};
      if(this.config.proxyFeedsEnabled&&c.transport==='public'){
        let host='';try{host=new URL(c.url).hostname;}catch{}
        patch.fetch_via_proxy=['twitter','youtube'].includes(source?.platform)||host==='research.google';
      }
      // Keep public-feed crawler/CSS settings unless explicitly changed by this source.
      // Imported restricted feeds must not independently crawl the original platform.
      if(c.transport!=='public')patch.crawler=false;
      else if(policy!==undefined)patch.crawler=policy==='fetch_public_html';
      await this.mf.call(`/v1/feeds/${feed.id}`,'PUT',patch);
    }
  }
  refresh({sourceId,tag,tags,platform,kind='manual'}={}) {
    const selected=requestedTags(tags,tag);
    const sources=this.db.sources().filter(s=>s.enabled&&(!sourceId||s.id===sourceId)&&(!platform||s.platform===platform)&&containsAllTags(s.tags,selected));
    const ids=new Set(sources.map(s=>s.id));
    const run=this.db.createRun(this.db.channels().filter(c=>ids.has(c.source_id)),kind);
    this.pump().catch(e=>this.db.audit('pump','error',e.message));
    return {...run,sources:sources.length};
  }
  async pump() {
    if(this.working||this.stopping)return;this.working=true;
    try {
      while(!this.stopping) {
        const queued=this.db.all("SELECT * FROM jobs WHERE state='QUEUED' ORDER BY priority DESC,created_at,id"),channels=this.db.channels(),sources=new Map(this.db.sources().map(s=>[s.id,s]));
        const job=queued.find(j=>{const c=channels.find(x=>x.id===j.channel_id),source=c&&sources.get(c.source_id);return c&&c.transport!=='desktop'&&!this.desktop?.ownsChannel?.(c,source);});
        if(!job)break;
        this.db.run("UPDATE jobs SET state='RUNNING' WHERE id=?",job.id);
        let c=channels.find(c=>c.id===job.channel_id);
        if(!c){this.finish(job,'UPSTREAM_ERROR','来源已移除');continue;}
        const source=this.db.sources().find(s=>s.id===c.source_id);
        if(!source?.enabled){this.finish(job,'PAUSED','该来源已暂停采集');continue;}
        const group=this.db.get('SELECT * FROM groups WHERE id=?',c.group_key);
        if(!c.enabled||!c.feed_id){this.finish(job,'NOT_CONFIGURED','此采集通道尚未配置或未通过连接验收');continue;}
        if(group?.state==='AUTH_REQUIRED'){this.finish(job,'AUTH_REQUIRED','共享凭证组已暂停，请更新凭证后恢复');continue;}
        const now=Date.now();
        if(c.next_check>now && (c.transport!=='public'||c.failures>0)){this.finish(job,'COOLDOWN','未到该平台允许的下次检查时间');continue;}
        if(group?.next_allowed-now>65000){this.finish(job,'COOLDOWN','采集组仍在退避，未发出平台请求');continue;}
        if(group?.next_allowed>now)await delay(group.next_allowed-now);
        if(this.stopping){this.db.run("UPDATE jobs SET state='QUEUED' WHERE id=?",job.id);break;}
        this.db.run('UPDATE channels SET last_check=?,state=? WHERE id=?',Date.now(),'RUNNING',c.id);
        try {
          const result=await runBackend(this,c);
          const added=typeof result==='number'?result:result.added;
          const finalState=result?.partial?'SUCCEEDED_PARTIAL':added?'SUCCEEDED_NEW':'SUCCEEDED_NO_NEW';
          const success=Date.now();
          this.db.run("UPDATE channels SET last_success=?,next_check=?,state=?,error='',failures=0 WHERE id=?",success,success+c.interval_ms,finalState,c.id);
          this.db.run("UPDATE groups SET state='OK',last_success=?,next_allowed=?,failures=0,alerted=0 WHERE id=?",success,success+c.min_gap_ms,c.group_key);
          this.finish(job,finalState,result?.partial?'已取得一页更新，但上游仍有下一页；不能证明全部更新已覆盖':'');
        } catch(e) {
          const state=classifyError(e), now=Date.now();
          const wait=state==='AUTH_REQUIRED'?24*3600000:Math.min(6*3600000,60000*2**Math.min(c.failures,8));
          // Never persist raw external error bodies, Cookie values or token-bearing feed URLs.
          const message=state==='AUTH_REQUIRED'?'平台明确拒绝凭证，请重新授权':state==='ACCESS_BLOCKED'?'访问受限；不能据此认定 Cookie 失效':state==='TIMEOUT'?'采集超时，保留既有文章':state==='NOT_CONFIGURED'?'采集服务未配置':'采集失败；检查该通道服务及网络';
          this.db.run('UPDATE channels SET state=?,error=?,next_check=?,failures=failures+1 WHERE id=?',state,message,now+wait,c.id);
          this.db.run('UPDATE groups SET state=?,next_allowed=?,failures=failures+1 WHERE id=?',state,now+wait,c.group_key);
          const epoch=this.db.get('SELECT last_success FROM groups WHERE id=?',c.group_key)?.last_success||0;
          this.db.alert(`failure:${c.group_key}:${epoch}`,`采集组异常：${c.group_key}`,message);
          this.finish(job,state,message);
        }
      }
    } finally{this.working=false;}
  }
  finish(job,state,error){this.db.run('UPDATE jobs SET state=?,error=?,finished_at=? WHERE id=?',state,error,Date.now(),job.id);this.db.run('UPDATE runs SET finished_at=? WHERE finished_at IS NULL AND NOT EXISTS(SELECT 1 FROM run_jobs r JOIN jobs j ON j.id=r.job_id WHERE r.run_id=runs.id AND j.state IN (\'QUEUED\',\'RUNNING\'))',Date.now());}
  async refreshPublic(c) {
    const before=await this.mf.call(`/v1/feeds/${c.feed_id}`);
    await this.mf.call(`/v1/feeds/${c.feed_id}/refresh`,'PUT',undefined,{timeout:60000});
    let feed;
    for(let i=0;i<60;i++) {
      feed=await this.mf.call(`/v1/feeds/${c.feed_id}`);
      if(feed.checked_at!==before.checked_at)break;
      await delay(1000);
    }
    if(feed.checked_at===before.checked_at)throw new Error('refresh completion timeout');
    if(feed.parsing_error_count>0){const e=new Error('upstream feed check failed');const m=String(feed.parsing_error_message||'');e.status=/\b401\b/.test(m)?401:/\b403\b/.test(m)?403:/\b429\b/.test(m)?429:502;throw e;}
    return this.syncFeed(c);
  }
  async syncFeed(c) {
    let offset=0,added=0;
    while(true) {
      const fetchedAt=Date.now();
      const page=await this.mf.call(`/v1/feeds/${c.feed_id}/entries?limit=100&offset=${offset}&order=id&direction=asc`);
      const entries=page.entries||[];
      for(const e of entries)added+=this.project(e,c,fetchedAt);
      offset+=entries.length;
      if(entries.length<100||offset>=page.total)break;
    }
    return added;
  }
  project(e,c,fetchedAt=Date.now()) {
    const old=this.db.get('SELECT * FROM entries WHERE id=?',e.id);
    const imported=this.db.get('SELECT * FROM imports WHERE entry_id=? AND published_at_source IS NOT NULL',e.id);
    const raw=String(e.content||''), text=stripHTML(raw), now=Date.now();
    const local=meta.localReadState(this.db,e.id);
    const readStatus=local&&local.changedAt>=fetchedAt?local.status:(e.status||'unread');
    const published=imported?imported.original_published_at:(Date.parse(e.published_at)||null);
    const dateSource=imported?imported.published_at_source:(published?'miniflux_unverified':'unknown');
    const state=text?(imported?.content_state||'TEXT'):'META';
    const origin=imported?.content_origin||'miniflux';
    const values={url:safeURL(e.url)||'',title:e.title||'(无标题)',author:e.author||'',summary:text.slice(0,1200),published_at:published,content_state:state};
    const contentHash=hash(JSON.stringify([values.url,values.title,values.author,raw,published,state,dateSource,origin]));
    const metadataChanged=old&&Object.entries(values).some(([key,value])=>old[key]!==value);
    // First post-migration sync establishes a hash baseline, not a fictional content update.
    const changed=!old||metadataChanged||(old.content_hash!==null&&old.content_hash!==contentHash);
    if(old?.archive_state==='ORIGINAL_ONLY'&&!old.bookmark_id&&state!=='META')this.db.run("UPDATE entries SET archive_state='NONE' WHERE id=?",e.id);
    this.db.run(`INSERT INTO entries(id,channel_id,source_id,url,title,author,summary,published_at,discovered_at,changed_at,status,content_state,content_hash,synced_at,content_origin,published_at_source)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      url=excluded.url,title=excluded.title,author=excluded.author,summary=excluded.summary,
      published_at=excluded.published_at,status=excluded.status,changed_at=excluded.changed_at,
      content_state=excluded.content_state,content_hash=excluded.content_hash,synced_at=excluded.synced_at,
      content_origin=excluded.content_origin,published_at_source=excluded.published_at_source`,
      e.id,c.id,c.source_id,values.url,values.title,values.author,values.summary,published,
      old?.discovered_at||now,changed?now:old.changed_at,readStatus,state,contentHash,now,origin,dateSource);
    const blogger=this.db.sources().find(s=>s.id===c.source_id);
    meta.inheritArticleTags(this.db,e.id,blogger?.tags||[]);
    return old?0:1;
  }
  async refreshAdapter(c) {
    // Backward-compatible method retained for tests/callers; execution is now
    // delegated to the backend registry instead of hard-coded transport branches.
    return runBackend(this,c);
  }
  async findImported(c,payload) {
    let offset=0;
    const expected=hash(payload.external_id);
    while(true){const page=await this.mf.call(`/v1/feeds/${c.feed_id}/entries?limit=100&offset=${offset}&order=id&direction=desc`);
      const hit=(page.entries||[]).find(e=>e.hash===expected||e.url===payload.url);if(hit)return hit;
      offset+=(page.entries||[]).length;if(!page.entries?.length||offset>=page.total)break;}
    return null;
  }
  async importItem(c,item) {
    const source=this.db.sources().find(s=>s.id===c.source_id);
    const external=articleKey(source.platform,item.guid,item.link), contentHash=hash(item.content||'');
    const published=Number.isFinite(item.published)&&item.published>0?item.published:null;
    const itemState=['TEXT','PARTIAL','META'].includes(item.content_state)?item.content_state:(item.content?'TEXT':'META');
    const payload={url:item.link,title:item.title,author:item.author||source.name,content:item.content||'',status:'unread',external_id:external};
    if(published)payload.published_at=Math.floor(published/1000);
    let row=this.db.get('SELECT * FROM imports WHERE channel_id=? AND external_id=?',c.id,external), id=row?.entry_id, created=0;
    if(!id && row){const existing=await this.findImported(c,payload);id=existing?.id;}
    if(!id){
      this.db.run('INSERT INTO imports(channel_id,external_id,payload,state) VALUES(?,?,?,?) ON CONFLICT(channel_id,external_id) DO UPDATE SET payload=excluded.payload',c.id,external,JSON.stringify(payload),'SENDING');
      try{const result=await this.mf.call(`/v1/feeds/${c.feed_id}/entries/import`,'POST',payload);id=result.id;if(!id)throw new Error('missing imported entry ID');created=1;}
      catch(e){this.db.run("UPDATE imports SET state='UNCERTAIN' WHERE channel_id=? AND external_id=?",c.id,external);throw e;}
    } else if(row?.content_hash!==contentHash && item.content) {
      // PUT modifies content/title only. Re-import would silently overwrite read state.
      await this.mf.call(`/v1/entries/${id}`,'PUT',{title:item.title,content:item.content});
    }
    // Empty later output must not downgrade valid content or invent a publication time.
    const retainContent=!item.content&&row?.entry_id&&row?.content_hash;
    this.db.run("UPDATE imports SET entry_id=?,content_hash=?,state='COMPLETE',payload='{}',original_published_at=?,published_at_source=?,content_state=?,content_origin=? WHERE channel_id=? AND external_id=?",
      id,retainContent?row.content_hash:contentHash,published??row?.original_published_at??null,
      published?'upstream':(row?.published_at_source||'unknown'),
      retainContent?(row.content_state||'TEXT'):itemState,'adapter_feed',c.id,external);
    const fetchedAt=Date.now();
    this.project(await this.mf.call(`/v1/entries/${id}`),c,fetchedAt);
    return created;
  }
  list(options={}) {return require('./article-actions').list(this,options);}
  tagCatalog() {return require('./article-actions').tagCatalog(this);}
  setBloggerTags(id,tags) {return require('./article-actions').setBloggerTags(this,id,tags);}
  setArticleTags(id,tags) {return require('./article-actions').setArticleTags(this,id,tags);}
  markRead(id,status) {return require('./article-actions').markRead(this,id,status);}
  openArticle(id,eventId,target) {return require('./article-actions').openArticle(this,id,eventId,target);}
  backend() {return require('./article-actions').backend(this);}
  bodyEnrichment(id){return this.desktop?this.desktop.enrichmentStatus(id):{entryId:Number(id),eligible:false,state:'UNAVAILABLE',error:'Shervin collector is not configured',collector:null};}
  requestBodyEnrichment(id){if(!this.desktop)throw Object.assign(new Error('Shervin collector is not configured'),{status:503});return this.desktop.queueEnrichment(id);}
  feedback(id,value){if(![-1,0,1].includes(value)||!this.db.get('SELECT id FROM entries WHERE id=?',id))throw new Error('invalid feedback');this.db.run('INSERT INTO feedback VALUES(?,?,?) ON CONFLICT(entry_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',id,value,Date.now());}
  async _articleNoteBookmark(row,{create=false}={}) {
    if(!this.config.karakeepToken){if(create)throw Object.assign(new Error('not configured: notes'),{status:503});return null;}
    let bookmarkId=row.note_bookmark_id||row.bookmark_id||null;
    if(bookmarkId){
      const bookmark=await this.kk.call('/api/v1/bookmarks/'+encodeURIComponent(bookmarkId));
      if(create&&!row.note_bookmark_id)this.db.run('UPDATE entries SET note_bookmark_id=? WHERE id=?',bookmarkId,row.id);
      return bookmark;
    }
    if(!create)return null;
    const text=[row.title,row.summary].filter(Boolean).join('\n\n').slice(0,50000)||'Quiet River article note';
    const payload={type:'text',text},sourceUrl=safeURL(row.url);if(sourceUrl)payload.sourceUrl=sourceUrl;
    const bookmark=await this.kk.call('/api/v1/bookmarks','POST',payload);
    if(!bookmark?.id)throw new Error('notes bookmark missing ID');
    this.db.run('UPDATE entries SET note_bookmark_id=? WHERE id=?',bookmark.id,row.id);
    return bookmark;
  }
  async articleNote(id) {
    const row=this.db.get('SELECT * FROM entries WHERE id=?',id);if(!row)throw Object.assign(new Error('entry not found'),{status:404});
    if(!this.config.karakeepToken)return {entryId:id,configured:false,bookmarkId:null,note:'',unavailable:false};
    try{
      const bookmark=await this._articleNoteBookmark(row);
      return {entryId:id,configured:true,bookmarkId:bookmark?.id||null,note:String(bookmark?.note||''),unavailable:false};
    }catch{this.db.audit('article-note',id,'Note store unavailable while reading');return {entryId:id,configured:true,bookmarkId:row.note_bookmark_id||row.bookmark_id||null,note:'',unavailable:true};}
  }
  async saveArticleNote(id,note) {
    if(typeof note!=='string'||note.length>50000)throw Object.assign(new Error('invalid article note'),{status:400});
    const row=this.db.get('SELECT * FROM entries WHERE id=?',id);if(!row)throw Object.assign(new Error('entry not found'),{status:404});
    if(!note&&!(row.note_bookmark_id||row.bookmark_id))return {entryId:id,configured:!!this.config.karakeepToken,bookmarkId:null,note:'',unavailable:false};
    const bookmark=await this._articleNoteBookmark(row,{create:true});
    const saved=await this.kk.call('/api/v1/bookmarks/'+encodeURIComponent(bookmark.id),'PATCH',{note});
    this.db.audit('article-note',id,'saved');
    return {entryId:id,configured:true,bookmarkId:bookmark.id,note:String(saved?.note??note),unavailable:false};
  }
  async articleDetail(id,{prepare=false}={}) {
    let row=this.db.get('SELECT * FROM entries WHERE id=?',id);if(!row)throw Object.assign(new Error('entry not found'),{status:404});
    const source=this.db.sources().find(s=>s.id===row.source_id),channel=this.db.channels().find(c=>c.id===row.channel_id);
    if(!source)throw Object.assign(new Error('source not found'),{status:404});
    const githubTarget=source.platform==='github'?githubDetailTarget(row.url):null,githubKind='github_rest_v1';
    const githubDone=githubTarget&&!!this.db.get("SELECT 1 ok FROM entry_enrichments WHERE entry_id=? AND kind=? AND state='DONE'",id,githubKind);
    const canGithubEnrich=!!githubTarget&&!githubDone;
    const canFetch=channel?.transport==='public'&&['blog','github','csdn','juejin','wechat'].includes(source.platform)&&source.fullTextMode!=='feed'&&!['feed_full','metadata_only'].includes(source.content_policy);
    let upstream=null,html='',prepareAttempted=false,prepareImproved=false,contentUnavailable=false;
    try {
      upstream=await this.mf.call(`/v1/entries/${id}`);html=String(upstream?.content||'');
      if(prepare&&canGithubEnrich){
        prepareAttempted=true;
        try{
          const enriched=await githubEnrichment(this,githubTarget),candidate=String(enriched.html||'');
          if(stripHTML(candidate)){
            html=candidate;prepareImproved=true;
            await this.mf.call(`/v1/entries/${id}`,'PUT',{title:upstream.title||row.title,content:html});
            this.db.run("INSERT INTO entry_enrichments(entry_id,kind,state,updated_at,detail) VALUES(?,?,?,?,?) ON CONFLICT(entry_id,kind) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,detail=excluded.detail",id,githubKind,'DONE',Date.now(),JSON.stringify({rateRemaining:enriched.rateRemaining}));
            this.db.run("UPDATE imports SET content_hash=?,content_state='TEXT',content_origin='github_rest_enrichment' WHERE entry_id=?",hash(html),id);
            this.project({...upstream,content:html},channel,Date.now());this.db.run("UPDATE entries SET content_origin='github_rest_enrichment' WHERE id=?",id);row=this.db.get('SELECT * FROM entries WHERE id=?',id);
          }
        }catch(e){
          this.db.run("INSERT INTO entry_enrichments(entry_id,kind,state,updated_at,detail) VALUES(?,?,?,?,?) ON CONFLICT(entry_id,kind) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,detail=excluded.detail",id,githubKind,'FAILED',Date.now(),String(e.message||e).slice(0,200));
          this.db.audit('github-enrichment',id,'GitHub REST detail unavailable; existing content retained');
        }
      }
      if(prepare&&!prepareImproved&&canFetch&&stripHTML(html).length<1500){
        prepareAttempted=true;
        try {
          const fetched=await this.mf.call(`/v1/entries/${id}/fetch-content?update_content=false`,'GET',undefined,{timeout:20000});
          const candidate=String(fetched?.content||'');
          if(stripHTML(candidate).length>stripHTML(html).length){html=candidate;prepareImproved=true;await this.mf.call(`/v1/entries/${id}`,'PUT',{content:html});this.project({...upstream,content:html},channel,Date.now());row=this.db.get('SELECT * FROM entries WHERE id=?',id);}
        }catch{this.db.audit('fulltext',id,'Native article-page extraction unavailable; existing content retained');}
      }
    }catch{contentUnavailable=true;html=row.summary?`<p>${escapeHTML(row.summary)}</p>`:'';}
    const snapshot=meta.tagSnapshot(this.db,id),feedback=this.db.get('SELECT value FROM feedback WHERE entry_id=?',id)?.value||0,noteState=await this.articleNote(id);
    const githubDoneNow=githubTarget&&!!this.db.get("SELECT 1 ok FROM entry_enrichments WHERE entry_id=? AND kind=? AND state='DONE'",id,githubKind);
    const canFetchFullText=githubTarget?!githubDoneNow:canFetch;
    const safeOriginal=safeURL(row.url)||null,contentLimit=2*1024*1024,contentTruncated=html.length>contentLimit;
    const readerMode=row.bookmark_id||row.content_state!=='META'?'reader':canFetchFullText?'fetchable':'original';
    return {id:row.id,title:row.title,author:row.author||source.name,source:source.name,sourceId:source.id,sourceUrl:safeURL(source.url)||null,platform:source.platform,readerMode,
      url:safeOriginal,published_at:row.published_at,discovered_at:row.discovered_at,status:row.status,tags:snapshot?.tags||source.tags||[],feedback,
      contentState:row.content_state,contentOrigin:row.content_origin,archiveState:row.archive_state,bookmarkId:row.bookmark_id||null,
      content:html.slice(0,contentLimit),contentTextLength:stripHTML(html).length,contentTruncated,contentUnavailable,canFetchFullText,prepareAttempted,prepareImproved,
      canAnnotate:!!this.config.karakeepToken&&row.content_state!=='META',note:noteState.note,noteBookmarkId:noteState.bookmarkId,notesConfigured:noteState.configured,noteUnavailable:noteState.unavailable};
  }
  async readerStatus(id) {
    const row=this.db.get('SELECT * FROM entries WHERE id=?',id);
    if(!row)throw Object.assign(new Error('entry not found'),{status:404});
    const base={entryId:id,originalUrl:row.url,contentState:row.content_state,canHighlight:false};
    if(!row.bookmark_id){
      const state=row.archive_state==='ERROR'?'ERROR':['IMPORTING','QUEUED'].includes(row.archive_state)?row.archive_state:row.content_state==='META'?'ORIGINAL_ONLY':'NONE';
      return {...base,state,path:null,bookmarkId:null};
    }
    if(!this.config.karakeepToken)return {...base,state:'NOT_CONFIGURED',path:null,bookmarkId:row.bookmark_id};
    const saved=await this.kk.call('/api/v1/bookmarks/'+encodeURIComponent(row.bookmark_id));
    const crawl=saved.content?.crawlStatus;let state=row.archive_state;
    if(state==='METADATA_NOTE')state='METADATA_NOTE';
    else if(crawl==='success')state='READY';
    else if(crawl==='failure')state='ERROR';
    else state='QUEUED';
    this.db.run('UPDATE entries SET archive_state=? WHERE id=?',state,id);
    return {...base,state,bookmarkId:row.bookmark_id,path:`/desk/reader/${id}`,canHighlight:state==='READY'};
  }
  async archive(id) {
    if(this.archiving.has(id))return this.archiving.get(id);
    const p=this._archive(id);this.archiving.set(id,p);try{return await p;}finally{this.archiving.delete(id);}
  }
  async _archive(id) {
    let row=this.db.get('SELECT * FROM entries WHERE id=?',id);if(!row)throw new Error('entry not found');
    if(!this.config.karakeepToken)throw new Error('not configured: reader account');
    if(row.bookmark_id)return this.readerStatus(id);
    this.db.run("UPDATE entries SET archive_state='IMPORTING' WHERE id=?",id);
    try {
      const fetchedAt=Date.now();
      const entry=await this.mf.call(`/v1/entries/${id}`);let html=String(entry.content||'');
      const source=this.db.sources().find(s=>s.id===row.source_id);
      const channel=this.db.channels().find(c=>c.id===row.channel_id);
      if(channel?.transport==='public'&&['blog','github','csdn','juejin','wechat'].includes(source?.platform)&&source?.fullTextMode!=='feed'&&!['feed_full','metadata_only'].includes(source?.content_policy)&&stripHTML(html).length<1500){
        try{
          const fetched=await this.mf.call(`/v1/entries/${id}/fetch-content?update_content=false`,'GET',undefined,{timeout:20000});
          const candidate=String(fetched?.content||'');
          if(stripHTML(candidate).length>stripHTML(html).length){
            html=candidate;await this.mf.call(`/v1/entries/${id}`,'PUT',{content:html});
            this.project({...entry,content:html},channel,fetchedAt);
          }
        }catch{this.db.audit('fulltext',id,'Native extraction unavailable; existing content retained');}
      }
      if(!stripHTML(html)) {
        this.db.run("UPDATE entries SET archive_state='ORIGINAL_ONLY' WHERE id=?",id);
        return {entryId:id,bookmarkId:null,path:null,state:'ORIGINAL_ONLY',originalUrl:row.url,contentState:row.content_state,canHighlight:false};
      }
      // Recovery: do not upload duplicate archives on a retry after a timeout.
      const prior=await this.kk.call('/api/v1/bookmarks/check-url?url='+encodeURIComponent(row.url));
      let bookmark=prior?.bookmark || (prior?.id?prior:null);
      if(!bookmark) {
        const archive=buildArchive(row,html), boundary='qr'+hash(String(Date.now())).slice(0,24);
        const body=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="url"\r\n\r\n${row.url}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="article.html"\r\nContent-Type: text/html\r\n\r\n${archive}\r\n--${boundary}--\r\n`);
        const r=await request(this.config.karakeep+'/api/v1/bookmarks/singlefile?ifexists=skip',{trusted:true,method:'POST',headers:{Authorization:`Bearer ${this.config.karakeepToken}`,'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':body.length},body,timeout:60000});
        if(r.status<200||r.status>=300)throw new Error('reader archive import failed');bookmark=JSON.parse(r.body);
      }
      if(!bookmark?.id)throw new Error('reader missing bookmark ID');
      // Keep the imported version immutable once a reader can annotate it.
      this.db.run("UPDATE entries SET bookmark_id=?,archive_hash=?,archive_state='QUEUED' WHERE id=?",bookmark.id,hash(html),id);
      return {bookmarkId:bookmark.id,path:`/desk/reader/${id}`,state:'QUEUED'};
    }catch(e){this.db.run("UPDATE entries SET archive_state='ERROR' WHERE id=?",id);throw e;}
  }
  async articleHighlights(id) {
    const row=this.db.get('SELECT * FROM entries WHERE id=?',id);if(!row)throw Object.assign(new Error('entry not found'),{status:404});
    if(!this.config.karakeepToken)return {entryId:id,configured:false,bookmarkId:null,highlights:[],canCreate:false};
    if(!row.bookmark_id)return {entryId:id,configured:true,bookmarkId:null,highlights:[],canCreate:row.content_state!=='META'};
    let cursor='',all=[],guard=0;
    do{
      const page=await this.kk.call('/api/v1/highlights?bookmarkId='+encodeURIComponent(row.bookmark_id)+'&limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
      all.push(...(page.highlights||[]).filter(h=>h.bookmarkId===row.bookmark_id));cursor=page.nextCursor||'';
      if(++guard>10)throw new Error('highlight pagination limit exceeded');
    }while(cursor&&all.length<1000);
    return {entryId:id,configured:true,bookmarkId:row.bookmark_id,highlights:all.slice(0,1000),canCreate:row.content_state!=='META'};
  }
  async articleHighlightContext(id) {
    let row=this.db.get('SELECT * FROM entries WHERE id=?',id);if(!row)throw Object.assign(new Error('entry not found'),{status:404});
    if(!this.config.karakeepToken)throw Object.assign(new Error('not configured: highlights'),{status:503});
    if(row.content_state==='META')throw Object.assign(new Error('article has no local text to highlight'),{status:409});
    if(!row.bookmark_id){
      const archived=await this.archive(id);
      if(!archived?.bookmarkId)throw Object.assign(new Error('article archive unavailable'),{status:409});
      row=this.db.get('SELECT * FROM entries WHERE id=?',id);
    }
    let saved=null,html='';
    for(let i=0;i<16;i++){
      saved=await this.kk.call('/api/v1/bookmarks/'+encodeURIComponent(row.bookmark_id)+'?includeContent=true');
      html=typeof saved?.content?.htmlContent==='string'?saved.content.htmlContent:'';
      if(html)break;
      if(saved?.content?.crawlStatus==='failure')throw Object.assign(new Error('reader archive failed'),{status:409});
      await delay(500);
    }
    if(!html)throw Object.assign(new Error('reader archive is still preparing'),{status:409});
    if(Buffer.byteLength(html)>4*1024*1024)throw Object.assign(new Error('reader archive exceeds native highlight limit'),{status:413});
    return {entryId:id,bookmarkId:row.bookmark_id,htmlContent:html,contextHash:hash(html),canHighlight:true};
  }
  async createArticleHighlight(id,input={}) {
    const row=this.db.get('SELECT * FROM entries WHERE id=?',id);if(!row)throw Object.assign(new Error('entry not found'),{status:404});
    if(!this.config.karakeepToken)throw Object.assign(new Error('not configured: highlights'),{status:503});
    if(!row.bookmark_id)throw Object.assign(new Error('highlight context is required first'),{status:409});
    const start=Number(input.startOffset),end=Number(input.endOffset),text=String(input.text??''),note=input.note==null?null:String(input.note),color=String(input.color||'yellow'),contextHash=String(input.contextHash||'');
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end-start!==text.length||text.length<1||text.length>10000||note?.length>10000||!['yellow','red','green','blue'].includes(color)||!/^[a-f0-9]{64}$/.test(contextHash))throw Object.assign(new Error('invalid highlight'),{status:400});
    const saved=await this.kk.call('/api/v1/bookmarks/'+encodeURIComponent(row.bookmark_id)+'?includeContent=true');
    const html=typeof saved?.content?.htmlContent==='string'?saved.content.htmlContent:'';
    if(!html||hash(html)!==contextHash)throw Object.assign(new Error('highlight context changed; select the text again'),{status:409});
    if(end>html.length)throw Object.assign(new Error('highlight offset outside archive bounds'),{status:400});
    const created=await this.kk.call('/api/v1/highlights','POST',{bookmarkId:row.bookmark_id,startOffset:start,endOffset:end,color,text,note});
    if(created?.bookmarkId!==row.bookmark_id||created?.startOffset!==start||created?.endOffset!==end)throw new Error('highlight store returned inconsistent identity');
    this.db.audit('article-highlight',id,'created');
    return created;
  }
  async updateArticleHighlight(id,highlightId,input={}) {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(String(highlightId)))throw Object.assign(new Error('invalid highlight id'),{status:400});
    const current=await this.articleHighlights(id),existing=current.highlights.find(h=>h.id===highlightId);
    if(!existing)throw Object.assign(new Error('highlight not found for article'),{status:404});
    const patch={};
    if(input.color!==undefined){const color=String(input.color);if(!['yellow','red','green','blue'].includes(color))throw Object.assign(new Error('invalid highlight color'),{status:400});patch.color=color;}
    if(input.note!==undefined){if(input.note!==null&&typeof input.note!=='string'||typeof input.note==='string'&&input.note.length>10000)throw Object.assign(new Error('invalid highlight note'),{status:400});patch.note=input.note===null?null:String(input.note);}
    if(!Object.keys(patch).length)return existing;
    const updated=await this.kk.call('/api/v1/highlights/'+encodeURIComponent(highlightId),'PATCH',patch);this.db.audit('article-highlight',id,'updated');return updated;
  }
  async deleteArticleHighlight(id,highlightId) {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(String(highlightId)))throw Object.assign(new Error('invalid highlight id'),{status:400});
    const current=await this.articleHighlights(id),existing=current.highlights.find(h=>h.id===highlightId);
    if(!existing)throw Object.assign(new Error('highlight not found for article'),{status:404});
    await this.kk.call('/api/v1/highlights/'+encodeURIComponent(highlightId),'DELETE');this.db.audit('article-highlight',id,'deleted');return {ok:true};
  }
  async highlights(cursor='') {
    if(!this.config.karakeepToken)return {highlights:[],nextCursor:null,notConfigured:true};
    const page=await this.kk.call('/api/v1/highlights?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    return {...page,highlights:(page.highlights||[]).map(h=>({...h,article:this.db.get('SELECT title,url,author,source_id FROM entries WHERE bookmark_id=? LIMIT 1',h.bookmarkId)||null}))};
  }
  async notes(cursor='') {
    if(!this.config.karakeepToken)return {bookmarks:[],nextCursor:null,notConfigured:true};
    return this.kk.call('/api/v1/bookmarks?limit=50&includeContent=true'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  }
  makeDigest(day,regenerate=false) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('invalid day');
    const old=this.db.get('SELECT * FROM digests WHERE day=?',day);if(old&&!regenerate)return json(old.payload,{});
    const pref=this.db.setting('preferences',{}), now=Date.now();
    // The whole local candidate set is scored before top-N selection, never one upstream page.
    const all=this.list({mode:'recommend',unread:true,limit:Number.MAX_SAFE_INTEGER}).items.filter(e=>(e.published_at||e.discovered_at)>=now-7*86400000&&(e.published_at||e.discovered_at)<=now+300000);
    const items=all.slice(0,Math.max(1,Math.min(50,Number(pref.digestCount)||15)));
    const health=this.health();
    const issues=health.channels.filter(c=>c.state!=='PAUSED'&&!['SUCCEEDED_NEW','SUCCEEDED_NO_NEW'].includes(c.state));
    for(const s of health.unconfiguredSources)issues.push({sourceId:s.id,state:'NOT_CONFIGURED',error:'来源仍在台账中，但没有可执行的采集通道'});
    const digest={day,createdAt:now,revision:(old?.revision||0)+1,algorithm:'local-rules-v1',candidateCount:all.length,preferences:pref,items,issues};
    this.db.run('INSERT INTO digests VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET created_at=excluded.created_at,revision=excluded.revision,payload=excluded.payload',day,now,digest.revision,JSON.stringify(digest));
    if(!old)this.db.alert('digest:'+day,'Quiet River 日报',`${day}：优先阅读 ${items.length} 篇；另有 ${issues.length} 个通道需要关注。请在私人阅读器查看。`);
    return digest;
  }
  async acquisitionDoctor() {
    const doctor=await doctorBackends(this),sources=this.db.sources(),channels=this.db.channels(),collector=this.desktop?.status()||null;
    const report=capabilityReport(sources,channels,{collector,config:this.config,backendStatus:doctor.backends});
    return {...doctor,capabilities:report.capabilities,summary:report.summary};
  }
  health() {
    const sources=this.db.sources(), channels=this.db.channels(),collector=this.desktop?.status()||null,backendStatus=this.desktop?.backendStatus?.()||{};
    const capability=capabilityReport(sources,channels,{collector,config:this.config,backendStatus});
    return {collector,sources:sources.length,configuredSources:sources.filter(s=>s.enabled&&channels.some(c=>c.source_id===s.id&&c.enabled)).length,unconfiguredSources:sources.filter(s=>s.enabled&&!channels.some(c=>c.source_id===s.id)).map(s=>({id:s.id,name:s.name})),channels:channels.map(c=>({id:c.id,sourceId:c.source_id,state:c.state,enabled:c.enabled,lastCheck:c.last_check,lastSuccess:c.last_success,nextCheck:c.next_check,error:c.error,transport:c.transport,feedId:c.feed_id,windowNote:c.windowNote||null})),
      capabilities:capability.capabilities,capabilitySummary:capability.summary,
      groups:this.db.all('SELECT * FROM groups'),queue:this.db.get("SELECT count(*) n FROM jobs WHERE state IN ('QUEUED','RUNNING')").n,
      entries:this.db.get('SELECT count(*) n FROM entries').n,readerConfigured:!!this.config.karakeepToken,
      notifications:this.db.all('SELECT created_at,payload,state,attempts FROM outbox ORDER BY created_at DESC LIMIT 30').map(r=>({...r,payload:json(r.payload,{})}))};
  }
  monitor(now=Date.now()) {
    // Local-only liveness check: no platform request is made here.
    const since=this.db.setting('manifest_imported_at',now);
    const enabled=new Set(this.db.sources().filter(s=>s.enabled).map(s=>s.id));
    const stale=new Map();
    for(const c of this.db.channels()) {
      if(!c.enabled||!enabled.has(c.source_id))continue;
      const reference=c.last_success||since;
      if(now-reference>Math.max(c.interval_ms*3,6*3600000)){const old=stale.get(c.group_key);stale.set(c.group_key,{count:(old?.count||0)+1,reference:Math.min(old?.reference||reference,reference)});}
    }
    for(const [key,info] of stale){
      const group=this.db.get('SELECT state,last_success FROM groups WHERE id=?',key);
      if(group?.state==='AUTH_REQUIRED')continue;
      this.db.alert(`stale:${key}:${group?.last_success||info.reference}`,'订阅长时间未检查成功',`采集组 ${key} 的 ${info.count} 个通道超过预计检查周期；这不等于作者没有更新。`);
    }
  }
  async sendNotifications() {
    if(!this.config.ntfy)return;
    for(const item of this.db.all("SELECT * FROM outbox WHERE state='PENDING' AND next_attempt<=? ORDER BY created_at LIMIT 10",Date.now())) {
      try {
        const p=json(item.payload,{});const r=await request(this.config.ntfy,{trusted:true,method:'POST',headers:{'Content-Type':'text/plain; charset=utf-8'},body:Buffer.from(p.title+'\n'+p.message)});
        if(r.status<200||r.status>=300)throw new Error('notification rejected');this.db.run("UPDATE outbox SET state='SENT' WHERE id=?",item.id);
      }catch{this.db.run('UPDATE outbox SET attempts=attempts+1,next_attempt=? WHERE id=?',Date.now()+Math.min(3600000,30000*2**item.attempts),item.id);}
    }
  }
  tick() {
    const now=Date.now(),sources=this.db.sources(),sourceById=new Map(sources.map(s=>[s.id,s])),sourceIds=new Set(sources.filter(s=>s.enabled).map(s=>s.id));
    const due=this.config.schedulerEnabled===false?[]:this.db.channels().filter(c=>{const source=sourceById.get(c.source_id),workerOwned=c.transport!=='desktop'&&this.desktop?.ownsChannel?.(c,source,now);if(workerOwned)return c.enabled&&sourceIds.has(c.source_id)&&c.next_check<=now;const g=this.db.get('SELECT state,next_allowed FROM groups WHERE id=?',c.group_key);return c.enabled&&sourceIds.has(c.source_id)&&c.next_check<=now&&g?.state!=='AUTH_REQUIRED'&&(!g||g.next_allowed<=now);});
    if(due.length)this.db.createRun(due,'scheduled');this.pump().catch(e=>this.db.audit('scheduler','error',e.message));
    this.monitor();this.sendNotifications().catch(()=>{});
    const timezone=this.db.setting('preferences',{}).timezone||'Asia/Shanghai';
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now));
    const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
    if(Number(p.hour)>=8&&this.db.get('SELECT count(*) n FROM entries').n>0){
      const day=`${p.year}-${p.month}-${p.day}`,last=this.db.get('SELECT created_at FROM digests WHERE day=?',day);
      const pending=this.db.get("SELECT count(*) n FROM jobs WHERE state IN ('QUEUED','RUNNING')").n;
      const changed=this.db.get('SELECT MAX(changed_at) last FROM entries').last;
      if(!last)this.makeDigest(day);
      else if(!pending&&changed>last.created_at)this.makeDigest(day,true);
    }
  }
  start(){this.db.recover();this.timer=setInterval(()=>{if(!this.stopping)this.tick();},60000);this.timer.unref();}
  stop(){this.stopping=true;clearInterval(this.timer);}
}
module.exports={ReaderService};
