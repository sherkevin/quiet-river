'use strict';
const {json,safeURL}=require('./core');
function eventRecord(store,eventId) {return store.setting('ui.open.event.'+eventId,null);}
function validateOpen(eventId,target) {
  if(typeof eventId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(eventId)||!['original','reader'].includes(target)) {
    throw Object.assign(new Error('invalid open event'),{status:400});
  }
}
function recordOpen(store,entry,eventId,target,now=Date.now()) {
  validateOpen(eventId,target);
  const existing=eventRecord(store,eventId);
  if(existing){
    if(existing.entryId!==entry.id)throw Object.assign(new Error('invalid duplicate event identity'),{status:409});
    return existing;
  }
  const data={eventId,entryId:entry.id,target,openedAt:now};
  store.db.exec('BEGIN IMMEDIATE');
  try{
    store.set('ui.open.event.'+eventId,data);
    store.run('INSERT INTO audit(created_at,action,target,result) VALUES(?,?,?,?)',now,'article_open',String(entry.id),JSON.stringify({eventId,target}));
    store.db.exec('COMMIT');
  }catch(error){store.db.exec('ROLLBACK');throw error;}
  return data;
}
function dateKey(ms,timezone) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
}
function historyPage(store,{before=Number.MAX_SAFE_INTEGER,limit=30}={}) {
  const rows=store.all("SELECT id,created_at,target,result FROM audit WHERE action='article_open' AND id<? ORDER BY id DESC LIMIT ?",before,limit+1);
  const sources=new Map(store.sources().map(s=>[s.id,s]));
  const items=rows.slice(0,limit).map(row=>{
    const entry=store.get('SELECT id,title,url,source_id,status FROM entries WHERE id=?',Number(row.target));
    const source=entry?sources.get(entry.source_id):null;
    return {id:row.id,openedAt:row.created_at,entryId:entry?.id||Number(row.target),
      title:entry?.title||'文章已移除',url:safeURL(entry?.url)||null,source:source?.name||'未知博主',
      platform:source?.platform||'',status:entry?.status||'read',target:json(row.result,{}).target||'original'};
  });
  return {items,nextCursor:rows.length>limit?items.at(-1).id:null};
}
function activity(store,timezone='Asia/Shanghai',now=Date.now()) {
  const today=dateKey(now,timezone),days=[];
  const base=Date.parse(today+'T00:00:00Z');
  for(let i=364;i>=0;i--)days.push({day:new Date(base-i*86400000).toISOString().slice(0,10),count:0,articles:0});
  const byDay=new Map(days.map(d=>[d.day,d])), unique=new Set(),sets=new Map();
  const records=store.all("SELECT created_at,target FROM audit WHERE action='article_open' AND created_at>=? AND created_at<=?",now-367*86400000,now);
  for(const row of records){const day=dateKey(row.created_at,timezone),point=byDay.get(day);if(!point)continue;
    point.count++;unique.add(row.target);if(!sets.has(day))sets.set(day,new Set());sets.get(day).add(row.target);point.articles=sets.get(day).size;}
  return {timezone,today,days,opens:days.reduce((n,d)=>n+d.count,0),uniqueArticles:unique.size,
    activeDays:days.filter(d=>d.count>0).length,trackedSince:store.get("SELECT MIN(created_at) first FROM audit WHERE action='article_open'")?.first||null};
}
module.exports={validateOpen,eventRecord,recordOpen,historyPage,activity,dateKey};
