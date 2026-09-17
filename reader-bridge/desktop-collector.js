'use strict';
const crypto=require('node:crypto');
const {channelsFor,escapeHTML}=require('./core');
const {originalLink}=require('../tools/windows/original-link.cjs');
const PLATFORMS=new Set(['zhihu','xiaohongshu']);
const STATES=new Set(['AUTH_REQUIRED','ACCESS_BLOCKED','TIMEOUT','UPSTREAM_ERROR','BROWSER_OFFLINE']);
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
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
      CREATE INDEX IF NOT EXISTS collector_lease_state ON collector_leases(state,expires_at);`);
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
  expire(now){
    for(const lease of this.db.all("SELECT * FROM collector_leases WHERE state IN ('OPEN','APPLYING') AND expires_at<?",now)){
      this.db.run("UPDATE collector_leases SET state='EXPIRED' WHERE id=?",lease.id);
      this.db.run("UPDATE jobs SET state='QUEUED' WHERE id=? AND state='RUNNING'",lease.job_id);
    }
  }
  claim(platforms){
    const allowed=(this.s.config.adapters?.desktopPlatforms||[]).filter(p=>PLATFORMS.has(p)&&platforms.includes(p));
    const now=Date.now();this.expire(now);this.db.set('collector_seen',now);
    const bySource=new Map(this.db.sources().map(s=>[s.id,s]));
    const candidates=this.db.channels().filter(c=>c.transport==='desktop'&&c.enabled&&c.feed_id&&bySource.get(c.source_id)?.enabled&&allowed.includes(bySource.get(c.source_id).platform));
    // Create only missing due jobs; browser-page refresh and scheduled jobs share this queue.
    const due=candidates.filter(c=>{const g=this.db.get('SELECT state,next_allowed FROM groups WHERE id=?',c.group_key);return c.next_check<=now&&g?.state!=='AUTH_REQUIRED'&&(!g||g.next_allowed<=now)&&!this.db.get("SELECT id FROM jobs WHERE channel_id=? AND state IN ('QUEUED','RUNNING')",c.id);});
    if(due.length)this.db.createRun(due,'scheduled');
    const jobs=this.db.all("SELECT * FROM jobs WHERE state='QUEUED' ORDER BY priority DESC,created_at,id");
    let nearCooldown=null;
    for(const job of jobs){
      const c=candidates.find(x=>x.id===job.channel_id);if(!c)continue;
      const g=this.db.get('SELECT * FROM groups WHERE id=?',c.group_key);
      if(g?.state==='AUTH_REQUIRED'){this.s.finish(job,'AUTH_REQUIRED','Windows登录态需要重新授权');continue;}
      if(c.next_check>now){this.s.finish(job,'COOLDOWN','尚未到本来源允许的检查时间');continue;}
      if(g?.next_allowed>now){const seconds=Math.ceil((g.next_allowed-now)/1000);if(seconds<=60)nearCooldown=Math.min(nearCooldown??seconds,seconds);continue;}
      if(this.db.get("SELECT id FROM collector_leases WHERE state IN ('OPEN','APPLYING') AND expires_at>?",now))return {job:null,retryAfter:15};
      const id=crypto.randomBytes(24).toString('hex'),source=bySource.get(c.source_id);
      this.db.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.run('INSERT INTO collector_leases(id,job_id,channel_id,expires_at) VALUES(?,?,?,?)',id,job.id,c.id,now+900000);
        this.db.run("UPDATE jobs SET state='RUNNING' WHERE id=?",job.id);
        this.db.run("UPDATE channels SET last_check=?,state='RUNNING' WHERE id=?",now,c.id);
        this.db.db.exec('COMMIT');
      }catch(e){this.db.db.exec('ROLLBACK');throw e;}
      return {job:{leaseId:id,sourceId:source.id,platform:source.platform,authorId:source.adapter.id,
        name:source.name,kind:c.label,limit:20},retryAfter:8};
    }
    return {job:null,retryAfter:nearCooldown||30,waitForCooldown:nearCooldown!==null,status:this.status()};
  }
  async submit(input){
    if(!input||typeof input!=='object')fail('invalid result');
    if(typeof input.leaseId!=='string'||!/^[a-f0-9]{48}$/.test(input.leaseId))fail('invalid lease');
    const lease=this.db.get('SELECT * FROM collector_leases WHERE id=?',input.leaseId);
    if(!lease)fail('unknown lease',404);
    const digest=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if(lease.state==='DONE'){if(lease.digest!==digest)fail('changed replay',409);return JSON.parse(lease.ack);}
    if(lease.expires_at<Date.now()||lease.state==='EXPIRED')fail('expired lease',409);
    if(lease.digest&&lease.digest!==digest)fail('changed payload on retry',409);
    const c=this.db.channels().find(c=>c.id===lease.channel_id);
    const source=this.db.sources().find(s=>s.id===c?.source_id);
    if(!source?.enabled||c?.transport!=='desktop'||!c.enabled)fail('source no longer enabled',409);
    if(!['OK',...STATES].includes(input.status))fail('invalid collector status');
    const items=input.status==='OK'?validateItems({...c,platform:source.platform,authorId:source.adapter.id},input.items):[];
    this.db.run("UPDATE collector_leases SET state='APPLYING',digest=? WHERE id=?",digest,lease.id);
    let added=0;
    for(const item of items)added+=await this.s.importItem(c,item);
    const now=Date.now(),ok=input.status==='OK';
    const state=ok?'SUCCEEDED_PARTIAL':input.status;
    const message=ok?'Windows窗口列表已同步；不承诺窗口以外的历史或漏更覆盖':
      input.status==='AUTH_REQUIRED'?'Shervin需要重新登录该平台':
      input.status==='BROWSER_OFFLINE'?'Shervin浏览器或OpenCLI扩展未连接':
      input.status==='ACCESS_BLOCKED'?'浏览器导航被拒绝或平台访问受限，未绕过限制':'Windows采集失败，原有内容保留';
    if(ok){
      this.db.run('UPDATE channels SET last_success=?,next_check=?,state=?,error=?,failures=0 WHERE id=?',now,now+c.interval_ms,state,message,c.id);
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
      if(input.op==='claim')return this.claim(Array.isArray(input.platforms)?input.platforms:[]);
      if(input.op==='submit')return await this.submit(input.result);
      if(input.op==='status'){this.db.set('collector_seen',Date.now());return this.status();}
      fail('invalid collector operation');
    }finally{this.busy=false;}
  }
}
module.exports={DesktopCollector,validateItems};
