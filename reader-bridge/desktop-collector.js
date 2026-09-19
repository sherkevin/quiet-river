'use strict';
const crypto=require('node:crypto');
const {channelsFor,escapeHTML,hash,stripHTML}=require('./core');
const {originalLink}=require('../tools/windows/original-link.cjs');
const PLATFORMS=new Set(['zhihu','xiaohongshu','bilibili']);
const AUTH_PLATFORMS=new Set(['zhihu','xiaohongshu']);
const STATES=new Set(['AUTH_REQUIRED','ACCESS_BLOCKED','TIMEOUT','UPSTREAM_ERROR','BROWSER_OFFLINE']);
const ENRICH_CAP='entry_body_v1',MAX_BODY_BYTES=1024*1024;
const BLOCK_PAGE_RE=/登录后查看|请登录|登录已失效|验证码|安全限制|访问链接异常|页面不见了|笔记不存在|access denied|security block/i;
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function bodyToSafeHTML(text){
  const value=String(text||'').replace(/\r\n?/g,'\n').trim();
  if(!value||Buffer.byteLength(value)>MAX_BODY_BYTES||(value.length<4000&&BLOCK_PAGE_RE.test(value)))fail('invalid enrichment body');
  const result=value.split(/\n{2,}/).filter(Boolean).slice(0,20000).map(block=>'<p>'+escapeHTML(block.trim()).replace(/\n/g,'<br>')+'</p>').join('\n');
  if(!stripHTML(result))fail('empty enrichment body');return result;
}
function validateItems(channel,items){
  if(!Array.isArray(items)||items.length>50)fail('invalid collector item list');
  return items.map(item=>{
    let original;try{original=originalLink({platform:channel.platform,kind:channel.label,authorId:channel.authorId},item.link);}
    catch{fail('collector original URL does not match platform');}
    if(typeof item.title!=='string'||!item.title.trim()||item.title.length>1000)fail('invalid title');
    const published=item.published==null?null:Number(item.published);
    if(published!==null&&(!Number.isSafeInteger(published)||published<946684800000||published>Date.now()+300000))fail('invalid publication date');
    const summary=typeof item.summary==='string'?item.summary.slice(0,1500):'';
    return {guid:original.guid,link:original.link,title:item.title.trim(),published,
      content:summary?'<p>'+escapeHTML(summary)+'</p>':'',content_state:summary?'PARTIAL':'META'};
  });
}
class DesktopCollector {
  constructor(service){
    this.s=service;this.db=service.db;this.busy=false;
    this.db.db.exec(`CREATE TABLE IF NOT EXISTS collector_leases(
      id TEXT PRIMARY KEY,job_id TEXT NOT NULL,channel_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'OPEN',digest TEXT,ack TEXT);
      CREATE INDEX IF NOT EXISTS collector_lease_state ON collector_leases(state,expires_at);
      CREATE TABLE IF NOT EXISTS collector_enrichments(
      entry_id INTEGER PRIMARY KEY,channel_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'QUEUED',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,lease_id TEXT,expires_at INTEGER NOT NULL DEFAULT 0,digest TEXT,ack TEXT,error TEXT NOT NULL DEFAULT '');
      CREATE UNIQUE INDEX IF NOT EXISTS collector_enrichment_lease ON collector_enrichments(lease_id) WHERE lease_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS collector_enrichment_state ON collector_enrichments(state,next_attempt,created_at);`);
    for(const channel of this.db.channels()){
      if(channel.transport==='desktop'&&['SUCCEEDED_PARTIAL','SUCCEEDED_NEW','SUCCEEDED_NO_NEW'].includes(channel.state)&&channel.error){
        this.db.run("UPDATE channels SET error='' WHERE id=?",channel.id);
      }
    }
  }
  async register(){
    const configured=this.s.config.adapters?.desktopPlatforms||[];
    const sources=this.db.sources().filter(s=>configured.includes(s.platform)&&PLATFORMS.has(s.platform));
    for(const source of sources){
      const previous=this.db.channels().filter(c=>c.source_id===source.id);
      this.db.putSource(source,channelsFor(source,this.s.config.adapters));
      for(const c of previous)if(c.transport!=='desktop')this.db.run("UPDATE channels SET state='NEVER_CHECKED',next_check=0,error='' WHERE id=?",c.id);
    }
    const missing=new Set(this.db.channels().filter(c=>c.transport==='desktop'&&!c.feed_id).map(c=>c.source_id));
    if(missing.size)await this.s.provisionChannels(missing);
  }
  status(){
    const at=this.db.setting('collector_seen',0),now=Date.now();
    return {device:'Shervin',lastSeen:at,online:at>0&&now-at<120000,
      note:'Windows运行时接收更新任务；登录态留在本机，离线不代表博主无更新'};
  }
  enrichmentContext(entryId){
    const id=Number(entryId),entry=Number.isSafeInteger(id)?this.db.get('SELECT * FROM entries WHERE id=?',id):null;
    if(!entry)fail('article not found',404);
    const source=this.db.sources().find(s=>s.id===entry.source_id),channel=this.db.channels().find(c=>c.id===entry.channel_id);
    if(!source?.enabled||!channel?.enabled||channel.transport!=='desktop'||!AUTH_PLATFORMS.has(source.platform))fail('article does not support desktop enrichment',409);
    const authorId=channel.author_id||source.adapter?.id,kind=channel.desktop_kind||channel.label;
    if(!authorId||!['answers','articles','notes'].includes(kind))fail('article enrichment identity is incomplete',409);
    let original;try{original=originalLink({platform:source.platform,kind,authorId},entry.url);}catch{fail('article original URL no longer matches its source',409);}
    return {entry,source,channel,authorId,kind,original};
  }
  enrichmentStatus(entryId){
    let ctx;try{ctx=this.enrichmentContext(entryId);}catch(e){if(e.status===404)throw e;return {entryId:Number(entryId),eligible:false,state:'UNAVAILABLE',error:e.message,collector:this.status()};}
    if(ctx.entry.content_state==='TEXT')return {entryId:ctx.entry.id,eligible:true,state:'DONE',contentState:'TEXT',collector:this.status()};
    const row=this.db.get('SELECT state,created_at,updated_at,attempts,next_attempt,error FROM collector_enrichments WHERE entry_id=?',ctx.entry.id);
    return {entryId:ctx.entry.id,eligible:true,state:row?.state||'NONE',contentState:ctx.entry.content_state,...(row||{}),collector:this.status()};
  }
  queueEnrichment(entryId,now=Date.now()){
    const ctx=this.enrichmentContext(entryId);if(ctx.entry.content_state==='TEXT')return this.enrichmentStatus(ctx.entry.id);
    const old=this.db.get('SELECT state FROM collector_enrichments WHERE entry_id=?',ctx.entry.id);
    if(old?.state!=='RUNNING')this.db.run(`INSERT INTO collector_enrichments(entry_id,channel_id,state,created_at,updated_at,next_attempt,error)
      VALUES(?,?,'QUEUED',?,?,0,'') ON CONFLICT(entry_id) DO UPDATE SET channel_id=excluded.channel_id,state='QUEUED',updated_at=excluded.updated_at,next_attempt=0,lease_id=NULL,expires_at=0,digest=NULL,ack=NULL,error=''`,ctx.entry.id,ctx.channel.id,now,now);
    this.db.audit('collector_enrichment',ctx.entry.id,'queued');return this.enrichmentStatus(ctx.entry.id);
  }
  authProbe(platforms){
    const configured=this.s.config.adapters?.desktopPlatforms||[];
    const sources=this.db.sources();
    for(const platform of platforms){
      if(!AUTH_PLATFORMS.has(platform)||!configured.includes(platform))continue;
      const group=this.db.get('SELECT state FROM groups WHERE id=?','credential:'+platform);
      if(group?.state!=='AUTH_REQUIRED')continue;
      const candidates=this.db.channels().filter(c=>c.transport==='desktop'&&c.group_key==='credential:'+platform&&c.enabled);
      const c=candidates.find(c=>c.state==='AUTH_REQUIRED')||candidates[0];
      const source=c&&sources.find(s=>s.id===c.source_id&&s.enabled&&s.adapter?.id);
      if(source)return {platform,sourceId:source.id,authorId:source.adapter.id,kind:c.label,limit:1};
    }
    return null;
  }
  resume(platform,now=Date.now()){
    const configured=this.s.config.adapters?.desktopPlatforms||[];
    if(!AUTH_PLATFORMS.has(platform)||!configured.includes(platform))fail('unsupported recovery platform');
    const groupId='credential:'+platform,group=this.db.get('SELECT * FROM groups WHERE id=?',groupId);
    if(!group)fail('credential group not found',404);
    if(group.state!=='AUTH_REQUIRED')return {resumed:false,state:group.state};
    const key='collector_auth_resume:'+platform,last=Number(this.db.setting(key,0))||0,wait=600000-(now-last);
    if(wait>0)return {resumed:false,state:group.state,retryAfter:Math.ceil(wait/1000)};
    this.db.run("UPDATE groups SET state='UNKNOWN',next_allowed=0,failures=0 WHERE id=?",groupId);
    for(const c of this.db.channels().filter(c=>c.transport==='desktop'&&c.group_key===groupId&&c.state==='AUTH_REQUIRED'))
      this.db.run("UPDATE channels SET state='NEVER_CHECKED',next_check=0,error='',failures=0 WHERE id=?",c.id);
    for(const c of this.db.channels().filter(c=>c.transport==='desktop'&&c.group_key===groupId))
      this.db.run("UPDATE collector_enrichments SET state='QUEUED',next_attempt=0,lease_id=NULL,expires_at=0,error='',updated_at=? WHERE channel_id=? AND state='AUTH_REQUIRED'",now,c.id);
    this.db.set(key,now);this.db.audit('collector_auth_resume',platform,'local OpenCLI probe confirmed twice');
    return {resumed:true,state:'UNKNOWN'};
  }
  expire(now){
    for(const lease of this.db.all("SELECT * FROM collector_leases WHERE state IN ('OPEN','APPLYING') AND expires_at<?",now)){
      this.db.run("UPDATE collector_leases SET state='EXPIRED' WHERE id=?",lease.id);
      this.db.run("UPDATE jobs SET state='QUEUED' WHERE id=? AND state='RUNNING'",lease.job_id);
    }
    this.db.run("UPDATE collector_enrichments SET state='QUEUED',lease_id=NULL,expires_at=0,digest=NULL,ack=NULL,updated_at=? WHERE state='RUNNING' AND expires_at<?",now,now);
  }
  hasActiveLease(now=Date.now()){
    return !!this.db.get("SELECT id FROM collector_leases WHERE state IN ('OPEN','APPLYING') AND expires_at>? LIMIT 1",now)||!!this.db.get("SELECT entry_id FROM collector_enrichments WHERE state='RUNNING' AND expires_at>? LIMIT 1",now);
  }
  claimEnrichment(allowed,capabilities,now,bySource){
    if(!capabilities.includes(ENRICH_CAP)||this.hasActiveLease(now))return null;
    let nearCooldown=null;
    for(const task of this.db.all("SELECT * FROM collector_enrichments WHERE state='QUEUED' AND next_attempt<=? ORDER BY created_at,entry_id LIMIT 50",now)){
      let ctx;try{ctx=this.enrichmentContext(task.entry_id);}catch(e){this.db.run("UPDATE collector_enrichments SET state='FAILED',updated_at=?,error=? WHERE entry_id=?",now,String(e.message).slice(0,200),task.entry_id);continue;}
      if(ctx.entry.content_state==='TEXT'){this.db.run("UPDATE collector_enrichments SET state='DONE',updated_at=?,error='' WHERE entry_id=?",now,task.entry_id);continue;}
      if(!allowed.includes(ctx.source.platform))continue;
      const group=this.db.get('SELECT * FROM groups WHERE id=?',ctx.channel.group_key);
      if(group?.state==='AUTH_REQUIRED')continue;
      if(group?.next_allowed>now){const seconds=Math.ceil((group.next_allowed-now)/1000);nearCooldown=Math.min(nearCooldown??seconds,seconds);continue;}
      const leaseId=crypto.randomBytes(24).toString('hex');
      this.db.run("UPDATE collector_enrichments SET state='RUNNING',lease_id=?,expires_at=?,attempts=attempts+1,updated_at=?,digest=NULL,ack=NULL,error='' WHERE entry_id=?",leaseId,now+900000,now,ctx.entry.id);
      return {job:{taskType:ENRICH_CAP,leaseId,entryId:ctx.entry.id,sourceId:ctx.source.id,platform:ctx.source.platform,authorId:ctx.authorId,kind:ctx.kind,url:ctx.original.link,title:ctx.entry.title},retryAfter:8};
    }
    return nearCooldown===null?null:{job:null,retryAfter:Math.max(8,Math.min(60,nearCooldown)),waitForCooldown:true};
  }
  claim(platforms,capabilities=[]){
    const allowed=(this.s.config.adapters?.desktopPlatforms||[]).filter(p=>PLATFORMS.has(p)&&platforms.includes(p));
    const now=Date.now();this.expire(now);this.db.set('collector_seen',now);
    const bySource=new Map(this.db.sources().map(s=>[s.id,s]));
    const candidates=this.db.channels().filter(c=>c.transport==='desktop'&&c.enabled&&c.feed_id&&bySource.get(c.source_id)?.enabled&&allowed.includes(bySource.get(c.source_id).platform));
    // Create only missing due jobs; browser-page refresh and scheduled jobs share this queue.
    const due=candidates.filter(c=>{const g=this.db.get('SELECT state,next_allowed FROM groups WHERE id=?',c.group_key);return c.next_check<=now&&g?.state!=='AUTH_REQUIRED'&&(!g||g.next_allowed<=now)&&!this.db.get("SELECT id FROM jobs WHERE channel_id=? AND state IN ('QUEUED','RUNNING')",c.id);});
    if(due.length)this.db.createRun(due,'scheduled');
    const jobs=this.db.all("SELECT * FROM jobs WHERE state='QUEUED' ORDER BY priority DESC,created_at,id");
    let nearCooldown=null;
    if(!jobs.some(job=>job.priority>=2)){
      const early=this.claimEnrichment(allowed,capabilities,now,bySource);if(early?.job)return early;
      if(early?.waitForCooldown)nearCooldown=Math.min(nearCooldown??early.retryAfter,early.retryAfter);
    }
    for(const job of jobs){
      const c=candidates.find(x=>x.id===job.channel_id);if(!c)continue;
      const g=this.db.get('SELECT * FROM groups WHERE id=?',c.group_key);
      if(g?.state==='AUTH_REQUIRED'){this.s.finish(job,'AUTH_REQUIRED','Windows登录态需要重新授权');continue;}
      if(c.next_check>now){this.s.finish(job,'COOLDOWN','尚未到本来源允许的检查时间');continue;}
      if(g?.next_allowed>now){const seconds=Math.ceil((g.next_allowed-now)/1000);if(seconds<=60)nearCooldown=Math.min(nearCooldown??seconds,seconds);continue;}
      if(this.hasActiveLease(now))return {job:null,retryAfter:15};
      const id=crypto.randomBytes(24).toString('hex'),source=bySource.get(c.source_id);
      const authorId=c.author_id||source.adapter?.id,kind=c.desktop_kind||c.label;
      if(!authorId){this.finish(job,'NOT_CONFIGURED','桌面采集来源缺少作者标识');continue;}
      this.db.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.run('INSERT INTO collector_leases(id,job_id,channel_id,expires_at) VALUES(?,?,?,?)',id,job.id,c.id,now+900000);
        this.db.run("UPDATE jobs SET state='RUNNING' WHERE id=?",job.id);
        this.db.run("UPDATE channels SET last_check=?,state='RUNNING' WHERE id=?",now,c.id);
        this.db.db.exec('COMMIT');
      }catch(e){this.db.db.exec('ROLLBACK');throw e;}
      return {job:{leaseId:id,sourceId:source.id,platform:source.platform,authorId,
        name:source.name,kind,limit:20},retryAfter:8};
    }
    const enrichment=this.claimEnrichment(allowed,capabilities,now,bySource);if(enrichment?.job)return enrichment;
    if(enrichment?.waitForCooldown)nearCooldown=Math.min(nearCooldown??enrichment.retryAfter,enrichment.retryAfter);
    const authProbe=this.authProbe(allowed);
    return {job:null,retryAfter:authProbe?60:(nearCooldown||30),waitForCooldown:nearCooldown!==null,authProbe,status:this.status()};
  }
  async submitEnrichment(input,task){
    const digest=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if(task.state==='DONE'){if(task.digest!==digest)fail('changed enrichment replay',409);return JSON.parse(task.ack);}
    if(task.expires_at<Date.now()||task.state!=='RUNNING')fail('expired enrichment lease',409);
    if(task.digest&&task.digest!==digest)fail('changed enrichment payload on retry',409);
    const ctx=this.enrichmentContext(task.entry_id);if(Number(input.entryId)!==ctx.entry.id)fail('enrichment entry mismatch',409);
    if(!['OK',...STATES].includes(input.status))fail('invalid enrichment status');
    const now=Date.now();this.db.run('UPDATE collector_enrichments SET digest=?,updated_at=? WHERE entry_id=?',digest,now,ctx.entry.id);
    if(input.status==='OK'){
      const html=bodyToSafeHTML(input.content);let updated=false;
      if(ctx.entry.content_state!=='TEXT'){
        const upstream=await this.s.mf.call('/v1/entries/'+ctx.entry.id);
        await this.s.mf.call('/v1/entries/'+ctx.entry.id,'PUT',{title:upstream.title||ctx.entry.title,content:html});
        this.db.run("UPDATE imports SET content_hash=?,content_state='TEXT',content_origin='desktop_enrichment' WHERE entry_id=?",hash(html),ctx.entry.id);
        this.s.project({...upstream,content:html},ctx.channel,Date.now());
        this.db.run("UPDATE entries SET content_origin='desktop_enrichment' WHERE id=?",ctx.entry.id);updated=true;
      }
      const ack={accepted:true,entryId:ctx.entry.id,state:'ENRICHED',updated};
      this.db.run("UPDATE collector_enrichments SET state='DONE',updated_at=?,expires_at=0,ack=?,error='' WHERE entry_id=?",now,JSON.stringify(ack),ctx.entry.id);
      this.db.run("UPDATE groups SET state='OK',next_allowed=?,failures=0 WHERE id=?",now+Math.max(8000,ctx.channel.min_gap_ms),ctx.channel.group_key);
      this.db.audit('collector_enrichment',ctx.entry.id,updated?'content upgraded':'already text');return ack;
    }
    const message=input.status==='AUTH_REQUIRED'?'Shervin需要重新登录该平台':input.status==='BROWSER_OFFLINE'?'Shervin浏览器或OpenCLI扩展未连接':input.status==='ACCESS_BLOCKED'?'正文页面访问受限，未绕过限制':input.status==='TIMEOUT'?'正文读取超时':'正文读取失败，原有内容保留';
    if(input.status==='AUTH_REQUIRED'){
      this.db.run("UPDATE collector_enrichments SET state='AUTH_REQUIRED',updated_at=?,expires_at=0,error=? WHERE entry_id=?",now,message,ctx.entry.id);
      this.db.run("UPDATE groups SET state='AUTH_REQUIRED',next_allowed=?,failures=failures+1 WHERE id=?",now+86400000,ctx.channel.group_key);
      this.db.alert('desktop-enrichment:'+ctx.channel.group_key+':'+now,'Windows正文采集需要重新授权',message);
    }else{
      const retry=now+(input.status==='ACCESS_BLOCKED'?1800000:600000);
      this.db.run("UPDATE collector_enrichments SET state='QUEUED',updated_at=?,next_attempt=?,lease_id=NULL,expires_at=0,error=? WHERE entry_id=?",now,retry,message,ctx.entry.id);
      this.db.run('UPDATE groups SET next_allowed=? WHERE id=?',now+Math.max(8000,ctx.channel.min_gap_ms),ctx.channel.group_key);
    }
    return {accepted:true,entryId:ctx.entry.id,state:input.status,updated:false};
  }
  async submit(input){
    if(!input||typeof input!=='object')fail('invalid result');
    if(typeof input.leaseId!=='string'||!/^[a-f0-9]{48}$/.test(input.leaseId))fail('invalid lease');
    const lease=this.db.get('SELECT * FROM collector_leases WHERE id=?',input.leaseId);
    if(!lease){const task=this.db.get('SELECT * FROM collector_enrichments WHERE lease_id=?',input.leaseId);if(task)return this.submitEnrichment(input,task);fail('unknown lease',404);}
    const digest=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if(lease.state==='DONE'){if(lease.digest!==digest)fail('changed replay',409);return JSON.parse(lease.ack);}
    if(lease.expires_at<Date.now()||lease.state==='EXPIRED')fail('expired lease',409);
    if(lease.digest&&lease.digest!==digest)fail('changed payload on retry',409);
    const c=this.db.channels().find(c=>c.id===lease.channel_id);
    const source=this.db.sources().find(s=>s.id===c?.source_id);
    if(!source?.enabled||c?.transport!=='desktop'||!c.enabled)fail('source no longer enabled',409);
    if(!['OK',...STATES].includes(input.status))fail('invalid collector status');
    const reportedStatus=input.status==='AUTH_REQUIRED'&&!AUTH_PLATFORMS.has(source.platform)?'ACCESS_BLOCKED':input.status;
    const authorId=c.author_id||source.adapter?.id,kind=c.desktop_kind||c.label;
    const items=reportedStatus==='OK'?validateItems({...c,platform:source.platform,authorId,label:kind},input.items):[];
    this.db.run("UPDATE collector_leases SET state='APPLYING',digest=? WHERE id=?",digest,lease.id);
    let added=0;
    for(const item of items)added+=await this.s.importItem(c,item);
    const now=Date.now(),ok=reportedStatus==='OK';
    const state=ok?'SUCCEEDED_PARTIAL':reportedStatus;
    const message=ok?'Windows窗口列表已同步；不承诺窗口以外的历史或漏更覆盖':
      state==='AUTH_REQUIRED'?'Shervin需要重新登录该平台':
      state==='BROWSER_OFFLINE'?'Shervin浏览器或OpenCLI扩展未连接':
      state==='ACCESS_BLOCKED'?'浏览器导航被拒绝或平台访问受限，未绕过限制':'Windows采集失败，原有内容保留';
    if(ok){
      this.db.run("UPDATE channels SET last_success=?,next_check=?,state=?,error='',failures=0 WHERE id=?",now,now+c.interval_ms,state,c.id);
      this.db.run("UPDATE groups SET state='OK',last_success=?,next_allowed=?,failures=0 WHERE id=?",now,now+Math.max(8000,c.min_gap_ms),c.group_key);
    }else{
      const retry=now+(state==='AUTH_REQUIRED'?86400000:state==='ACCESS_BLOCKED'?1800000:600000);
      this.db.run('UPDATE channels SET state=?,error=?,next_check=?,failures=failures+1 WHERE id=?',state,message,retry,c.id);
      this.db.run('UPDATE groups SET state=?,next_allowed=?,failures=failures+1 WHERE id=?',state,retry,c.group_key);
      this.db.alert('desktop:'+c.group_key+':'+(this.db.get('SELECT last_success FROM groups WHERE id=?',c.group_key)?.last_success||0),'Windows采集需要处理',message);
    }
    const ack={accepted:true,sourceId:source.id,received:items.length,added,state};
    this.s.finish({id:lease.job_id},state,message);
    this.db.run("UPDATE collector_leases SET state='DONE',ack=? WHERE id=?",JSON.stringify(ack),lease.id);
    this.db.set('collector_seen',now);return ack;
  }
  async handle(input){
    if(this.busy)fail('collector operation in progress',503);this.busy=true;
    try{
      if(input.op==='claim')return this.claim(Array.isArray(input.platforms)?input.platforms:[],Array.isArray(input.capabilities)?input.capabilities:[]);
      if(input.op==='submit')return await this.submit(input.result);
      if(input.op==='resume')return this.resume(String(input.platform||''));
      if(input.op==='status'){this.db.set('collector_seen',Date.now());return this.status();}
      fail('invalid collector operation');
    }finally{this.busy=false;}
  }
}
module.exports={DesktopCollector,validateItems};
