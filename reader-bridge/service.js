'use strict';
const fs = require('node:fs');
const {hash,json,opmlFor,channelsFor,parseFullFeed,rankEntries,buildArchive,stripHTML,safeURL,classifyError,articleKey} = require('./core');
const {ApiClient,request} = require('./network');
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

class ReaderService {
  constructor(db,config,clients={}) {
    this.db=db;this.config=config;this.stopping=false;this.working=false;this.archiving=new Map();
    this.mf=clients.mf || new ApiClient(config.miniflux,{ 'X-Auth-Token':config.minifluxToken });
    this.kk=clients.kk || new ApiClient(config.karakeep,{Authorization:`Bearer ${config.karakeepToken || ''}`});
    this.internalFetch=clients.internalFetch || request;
  }
  async importManifest(manifest,options={}) {
    if(!Array.isArray(manifest.subscriptions))throw new Error('manifest missing subscriptions array');
    const ids=new Set();
    for(const s of manifest.subscriptions){
      if(!s.id||!s.name||ids.has(s.id))throw new Error('invalid or duplicate source ID');ids.add(s.id);
      this.db.putSource(s,channelsFor(s,{...this.config.adapters,...options}));
    }
    this.db.set('manifest_imported_at',Date.now());this.db.set('manifest_source_count',ids.size);
    await this.provisionChannels();
    return {sources:this.db.sources().length,channels:this.db.channels().length};
  }
  async provisionChannels() {
    const channels=this.db.channels();
    if(!channels.length)return;
    await this.mf.call('/v1/import','POST',opmlFor(channels,this.db.sources()),{headers:{'Content-Type':'application/xml'}});
    const feeds=await this.mf.call('/v1/feeds');
    for(const c of channels){
      const identity=c.transport==='public'?c.url:`https://quiet-river.invalid/channel/${c.id}`;
      const feed=feeds.find(f=>f.feed_url===identity);
      if(!feed)throw new Error('Miniflux did not create channel '+c.id);
      this.db.run('UPDATE channels SET feed_id=? WHERE id=?',feed.id,c.id);
      // All refresh requests go through our single scheduler. No interest-based ingestion filters.
      await this.mf.call(`/v1/feeds/${feed.id}`,'PUT',{disabled:true,crawler:false,blocklist_rules:'',keeplist_rules:'',block_filter_entry_rules:'',keep_filter_entry_rules:''});
    }
  }
  refresh({sourceId,tag,kind='manual'}={}) {
    const sources=this.db.sources().filter(s=>s.enabled&&(!sourceId||s.id===sourceId)&&(!tag||(s.tags||[]).includes(tag)));
    const ids=new Set(sources.map(s=>s.id));
    const run=this.db.createRun(this.db.channels().filter(c=>ids.has(c.source_id)),kind);
    this.pump().catch(e=>this.db.audit('pump','error',e.message));
    return {...run,sources:sources.length};
  }
  async pump() {
    if(this.working||this.stopping)return;this.working=true;
    try {
      while(!this.stopping) {
        const job=this.db.get("SELECT * FROM jobs WHERE state='QUEUED' ORDER BY created_at,id LIMIT 1");
        if(!job)break;
        this.db.run("UPDATE jobs SET state='RUNNING' WHERE id=?",job.id);
        let c=this.db.channels().find(c=>c.id===job.channel_id);
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
          let added=0;
          if(c.transport==='public')added=await this.refreshPublic(c);
          else added=await this.refreshAdapter(c);
          const success=Date.now();
          this.db.run("UPDATE channels SET last_success=?,next_check=?,state=?,error='',failures=0 WHERE id=?",success,success+c.interval_ms,added?'SUCCEEDED_NEW':'SUCCEEDED_NO_NEW',c.id);
          this.db.run("UPDATE groups SET state='OK',last_success=?,next_allowed=?,failures=0,alerted=0 WHERE id=?",success,success+c.min_gap_ms,c.group_key);
          this.finish(job,added?'SUCCEEDED_NEW':'SUCCEEDED_NO_NEW','');
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
      const page=await this.mf.call(`/v1/feeds/${c.feed_id}/entries?limit=100&offset=${offset}&order=id&direction=asc`);
      const entries=page.entries||[];
      for(const e of entries)added+=this.project(e,c);
      offset+=entries.length;
      if(entries.length<100||offset>=page.total)break;
    }
    return added;
  }
  project(e,c) {
    const old=this.db.get('SELECT * FROM entries WHERE id=?',e.id);
    const raw=String(e.content||'');const text=stripHTML(raw);
    const published=Date.parse(e.published_at)||null;
    const discovered=old?.discovered_at||Date.now();
    const state=text?'TEXT':'META';
    this.db.run(`INSERT INTO entries(id,channel_id,source_id,url,title,author,summary,published_at,discovered_at,changed_at,status,content_state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author,summary=excluded.summary,status=excluded.status,changed_at=excluded.changed_at,content_state=excluded.content_state`,e.id,c.id,c.source_id,safeURL(e.url)||'',e.title||'(无标题)',e.author||'',text.slice(0,1200),published,discovered,Date.now(),e.status||'unread',state);
    return old?0:1;
  }
  async refreshAdapter(c) {
    if(c.browser && !this.config.adapters?.browserEnabled)throw new Error('missing configuration: browser acceptance');
    const base=c.transport==='werss'?this.config.adapters?.werss:this.config.adapters?.rsshub;
    if(!base||new URL(c.url).origin!==new URL(base).origin)throw new Error('not configured: trusted adapter origin');
    if(c.transport==='werss') {
      const wx=new ApiClient(base,{Authorization:`Bearer ${this.config.adapters.werssToken||''}`});
      const result=await wx.call(`/api/v1/wx/mps/update/${encodeURIComponent(c.mp_id)}?start_page=0&end_page=1`,'GET',undefined,{timeout:120000});
      if(result?.code && ![0,200].includes(result.code))throw new Error('WeRSS update did not confirm success');
      // Merely returning HTTP 200 is not a full-content guarantee; each entry below retains its content state.
    }
    const r=await this.internalFetch(c.url,{trusted:true,timeout:c.browser?120000:45000});
    if(r.status!==200){const e=new Error('adapter HTTP error');e.status=r.status;throw e;}
    const parsed=parseFullFeed(r.body.toString('utf8'),c.url);let added=0;
    for(const item of parsed.items){if(!safeURL(item.link))continue;added+=await this.importItem(c,item);}
    return added;
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
    const payload={url:item.link,title:item.title,author:item.author||source.name,content:item.content||'',status:'unread',external_id:external};
    if(item.published)payload.published_at=Math.floor(item.published/1000);
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
    this.db.run("UPDATE imports SET entry_id=?,content_hash=?,state='COMPLETE',payload='{}' WHERE channel_id=? AND external_id=?",id,contentHash,c.id,external);
    this.project(await this.mf.call(`/v1/entries/${id}`),c);
    return created;
  }
  list({mode='latest',sourceId,tag,unread=false,limit=30,offset=0}={}) {
    const sources=this.db.sources(), byId=new Map(sources.map(s=>[s.id,s]));
    let entries=this.db.all('SELECT * FROM entries ORDER BY published_at DESC,id DESC').filter(e=>{
      const s=byId.get(e.source_id);return s?.visible&&s.enabled&&(!sourceId||s.id===sourceId)&&(!tag||s.tags.includes(tag))&&(!unread||e.status==='unread');
    });
    const fb=Object.fromEntries(this.db.all('SELECT * FROM feedback').map(f=>[f.entry_id,f.value]));
    if(mode==='recommend')entries=rankEntries(entries,sources,this.db.setting('preferences',{}),fb);
    return {total:entries.length,items:entries.slice(offset,offset+limit).map(e=>({...e,source:byId.get(e.source_id).name,platform:byId.get(e.source_id).platform,tags:byId.get(e.source_id).tags,feedback:fb[e.id]||0})),offset,limit};
  }
  async markRead(id,status){if(!['read','unread'].includes(status)||!this.db.get('SELECT id FROM entries WHERE id=?',id))throw new Error('invalid read state or entry');await this.mf.call('/v1/entries','PUT',{entry_ids:[id],status});this.db.run('UPDATE entries SET status=? WHERE id=?',status,id);}
  feedback(id,value){if(![-1,0,1].includes(value)||!this.db.get('SELECT id FROM entries WHERE id=?',id))throw new Error('invalid feedback');this.db.run('INSERT INTO feedback VALUES(?,?,?) ON CONFLICT(entry_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',id,value,Date.now());}
  async archive(id) {
    if(this.archiving.has(id))return this.archiving.get(id);
    const p=this._archive(id);this.archiving.set(id,p);try{return await p;}finally{this.archiving.delete(id);}
  }
  async _archive(id) {
    let row=this.db.get('SELECT * FROM entries WHERE id=?',id);if(!row)throw new Error('entry not found');
    if(!this.config.karakeepToken)throw new Error('not configured: reader account');
    if(row.bookmark_id)return {bookmarkId:row.bookmark_id,path:`/dashboard/preview/${row.bookmark_id}`,state:row.archive_state};
    this.db.run("UPDATE entries SET archive_state='IMPORTING' WHERE id=?",id);
    try {
      const entry=await this.mf.call(`/v1/entries/${id}`);const html=String(entry.content||'');
      if(!stripHTML(html)) {
        const bookmark=await this.kk.call('/api/v1/bookmarks','POST',{type:'text',text:`${row.title}\n\n作者：${row.author}\n原文：${row.url}\n\n本站尚未取得原文，以下可记录整篇笔记。`,sourceUrl:row.url});
        this.db.run("UPDATE entries SET bookmark_id=?,archive_state='METADATA_NOTE' WHERE id=?",bookmark.id,id);
        return {bookmarkId:bookmark.id,path:`/dashboard/preview/${bookmark.id}`,state:'METADATA_NOTE'};
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
      return {bookmarkId:bookmark.id,path:`/dashboard/preview/${bookmark.id}`,state:'QUEUED'};
    }catch(e){this.db.run("UPDATE entries SET archive_state='ERROR' WHERE id=?",id);throw e;}
  }
  async highlights(cursor='') {
    if(!this.config.karakeepToken)return {highlights:[],nextCursor:null,notConfigured:true};
    return this.kk.call('/api/v1/highlights?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  }
  async notes(cursor='') {
    if(!this.config.karakeepToken)return {bookmarks:[],nextCursor:null,notConfigured:true};
    return this.kk.call('/api/v1/bookmarks?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  }
  makeDigest(day,regenerate=false) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('invalid day');
    const old=this.db.get('SELECT * FROM digests WHERE day=?',day);if(old&&!regenerate)return json(old.payload,{});
    const pref=this.db.setting('preferences',{}), now=Date.now();
    // The whole local candidate set is scored before top-N selection, never one upstream page.
    const all=this.list({mode:'recommend',unread:true,limit:Number.MAX_SAFE_INTEGER}).items;
    const items=all.filter(e=>(e.published_at||e.discovered_at)>=now-7*86400000).slice(0,Math.max(1,Math.min(50,Number(pref.digestCount)||15)));
    const issues=this.health().channels.filter(c=>!['SUCCEEDED_NEW','SUCCEEDED_NO_NEW'].includes(c.state));
    const digest={day,createdAt:now,revision:(old?.revision||0)+1,algorithm:'local-rules-v1',candidateCount:all.length,preferences:pref,items,issues};
    this.db.run('INSERT INTO digests VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET created_at=excluded.created_at,revision=excluded.revision,payload=excluded.payload',day,now,digest.revision,JSON.stringify(digest));
    if(!old)this.db.alert('digest:'+day,'Quiet River 日报',`${day}：优先阅读 ${items.length} 篇；另有 ${issues.length} 个通道需要关注。请在私人阅读器查看。`);
    return digest;
  }
  health() {
    const sources=this.db.sources(), channels=this.db.channels();
    return {sources:sources.length,channels:channels.map(c=>({id:c.id,sourceId:c.source_id,state:c.state,enabled:c.enabled,lastCheck:c.last_check,lastSuccess:c.last_success,nextCheck:c.next_check,error:c.error,transport:c.transport,feedId:c.feed_id})),
      groups:this.db.all('SELECT * FROM groups'),queue:this.db.get("SELECT count(*) n FROM jobs WHERE state IN ('QUEUED','RUNNING')").n,
      entries:this.db.get('SELECT count(*) n FROM entries').n,readerConfigured:!!this.config.karakeepToken,
      notifications:this.db.all('SELECT created_at,payload,state,attempts FROM outbox ORDER BY created_at DESC LIMIT 30').map(r=>({...r,payload:json(r.payload,{})}))};
  }
  monitor(now=Date.now()) {
    // Local-only liveness check: no platform request is made here.
    for(const c of this.db.channels()) {
      if(!c.enabled||!c.last_success)continue;
      if(now-c.last_success>Math.max(c.interval_ms*3,6*3600000))this.db.alert(`stale:${c.id}:${c.last_success}`,'订阅长时间未检查成功',`通道 ${c.id} 已超过预计检查周期；这不等于作者没有更新。`);
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
    const now=Date.now(), sourceIds=new Set(this.db.sources().filter(s=>s.enabled).map(s=>s.id));
    const due=this.db.channels().filter(c=>c.enabled&&sourceIds.has(c.source_id)&&c.next_check<=now&&this.db.get('SELECT state FROM groups WHERE id=?',c.group_key)?.state!=='AUTH_REQUIRED');
    if(due.length)this.db.createRun(due,'scheduled');this.pump().catch(e=>this.db.audit('scheduler','error',e.message));
    this.monitor();this.sendNotifications().catch(()=>{});
    const timezone=this.db.setting('preferences',{}).timezone||'Asia/Shanghai';
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now));
    const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));if(Number(p.hour)>=8)this.makeDigest(`${p.year}-${p.month}-${p.day}`);
  }
  start(){this.db.recover();this.timer=setInterval(()=>{if(!this.stopping)this.tick();},60000);this.timer.unref();}
  stop(){this.stopping=true;clearInterval(this.timer);}
}
module.exports={ReaderService};
