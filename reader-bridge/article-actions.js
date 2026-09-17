'use strict';
const {normalizeTags,containsAllTags,requestedTags}=require('./tags');
const {rankEntries,safeURL}=require('./core');
const meta=require('./article-metadata');
const history=require('./reading-history');
const problem=(message,status=400)=>Object.assign(new Error(message),{status});
function list(service,{mode='latest',sourceId,platform,tag,tags,unread=false,order='desc',limit=30,offset=0,asOf=Date.now()}={}) {
  if(!['asc','desc'].includes(order))throw problem('invalid time order');
  const selected=requestedTags(tags,tag),sources=service.db.sources();
  const byId=new Map(sources.map(s=>[s.id,s])),snapshots=meta.articleTagMap(service.db);
  let entries=service.db.all('SELECT * FROM entries').map(e=>{
    const snapshot=snapshots.get(e.id);
    return {...e,tags:snapshot?snapshot.tags:(byId.get(e.source_id)?.tags||[]),tagOrigin:snapshot?.origin||'inherited'};
  }).filter(e=>{const s=byId.get(e.source_id);
    return e.discovered_at<=asOf&&s?.visible&&(mode!=='recommend'||s.enabled)&&
      (!sourceId||s.id===sourceId)&&(!platform||s.platform===platform)&&
      containsAllTags(e.tags,selected)&&(!(unread||mode==='unread')||e.status==='unread');
  });
  entries.sort((a,b)=>{
    if(!a.published_at&&b.published_at)return 1;if(a.published_at&&!b.published_at)return -1;
    const delta=(a.published_at||a.discovered_at)-(b.published_at||b.discovered_at)||a.id-b.id;
    return order==='asc'?delta:-delta;
  });
  const feedback=Object.fromEntries(service.db.all('SELECT * FROM feedback').map(f=>[f.entry_id,f.value]));
  if(mode==='recommend')entries=rankEntries(entries,sources,service.db.setting('preferences',{}),feedback,asOf);
  return {asOf,total:entries.length,offset,limit,order,tags:selected,items:entries.slice(offset,offset+limit)
    .map(e=>({...e,source:byId.get(e.source_id).name,platform:byId.get(e.source_id).platform,
      sourceTags:byId.get(e.source_id).tags||[],feedback:feedback[e.id]||0}))};
}
function tagCatalog(service) {
  const all=new Set(service.db.sources().flatMap(s=>s.tags||[]));
  for(const value of meta.articleTagMap(service.db).values())for(const tag of value.tags)all.add(tag);
  return [...all].sort((a,b)=>a.localeCompare(b,'zh-CN'));
}
function setBloggerTags(service,id,tags) {
  if(!service.db.get('SELECT id FROM sources WHERE id=?',id))throw problem('blogger not found',404);
  const clean=normalizeTags(tags);meta.ensureSnapshots(service.db);
  return {id,tags:meta.saveBloggerTags(service.db,id,clean)};
}
function setArticleTags(service,id,tags) {
  if(!service.db.get('SELECT id FROM entries WHERE id=?',id))throw problem('article not found',404);
  return {id,...meta.saveArticleTags(service.db,id,tags)};
}
function enqueueRead(service,id,operation) {
  const previous=service.readWrites.get(id)||Promise.resolve();
  const task=previous.catch(()=>{}).then(operation);service.readWrites.set(id,task);
  return task.finally(()=>{if(service.readWrites.get(id)===task)service.readWrites.delete(id);});
}
async function saveRead(service,id,status) {
  const entry=service.db.get('SELECT * FROM entries WHERE id=?',id);
  if(!entry)throw problem('article not found',404);
  if(!['read','unread'].includes(status))throw problem('invalid read state');
  await service.mf.call('/v1/entries','PUT',{entry_ids:[id],status});
  service.db.run('UPDATE entries SET status=? WHERE id=?',status,id);
  meta.saveReadState(service.db,id,status);return {...entry,status};
}
function markRead(service,id,status) {
  return enqueueRead(service,id,async()=>({id,status:(await saveRead(service,id,status)).status}));
}
function openArticle(service,id,eventId,target) {
  history.validateOpen(eventId,target);
  return enqueueRead(service,id,async()=>{
    const existing=history.eventRecord(service.db,eventId);
    if(existing){
      if(existing.entryId!==id)throw problem('invalid duplicate event identity',409);
      return {...existing,status:service.db.get('SELECT status FROM entries WHERE id=?',id)?.status||'read',duplicate:true};
    }
    const entry=service.db.get('SELECT * FROM entries WHERE id=?',id);
    if(!entry)throw problem('article not found',404);
    if(target==='original'&&!safeURL(entry.url))throw problem('invalid original article URL');
    await saveRead(service,id,'read');
    return {...history.recordOpen(service.db,entry,eventId,target),status:'read',duplicate:false};
  });
}
function backend(service) {
  const sources=service.db.sources(),health=service.health(),byId=new Map(sources.map(s=>[s.id,s]));
  const now=Date.now(),raw=new Map(service.db.channels().map(c=>[c.id,c]));
  const faults=health.channels.filter(c=>{
    if(!byId.get(c.sourceId)?.enabled)return false;
    const interval=raw.get(c.id)?.interval_ms||1800000;
    return !c.enabled||['AUTH_REQUIRED','ACCESS_BLOCKED','TIMEOUT','UPSTREAM_ERROR','UNSAFE_URL','SUCCEEDED_PARTIAL'].includes(c.state)||
      (c.lastSuccess>0&&now-c.lastSuccess>Math.max(6*3600000,interval*3));
  }).map(c=>{const s=byId.get(c.sourceId);return {...c,source:s?.name||c.sourceId,
    platform:s?.platform,homepage:safeURL(s?.url)||null,stale:c.lastSuccess>0&&now-c.lastSuccess>Math.max(6*3600000,(raw.get(c.id)?.interval_ms||1800000)*3)};});
  for(const s of health.unconfiguredSources)faults.push({sourceId:s.id,source:s.name,platform:byId.get(s.id)?.platform,
    homepage:safeURL(byId.get(s.id)?.url)||null,state:'NOT_CONFIGURED',error:'尚无可执行通道',lastCheck:0,lastSuccess:0});
  const timezone=service.db.setting('preferences',{}).timezone||'Asia/Shanghai';
  return {activity:history.activity(service.db,timezone,now),history:history.historyPage(service.db),faults,observedAt:now};
}
module.exports={list,tagCatalog,setBloggerTags,setArticleTags,markRead,openArticle,backend};
