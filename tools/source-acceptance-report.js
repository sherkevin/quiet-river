#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');

const SUCCESS_PREFIX='SUCCEEDED_';
function parsePayload(text){try{return JSON.parse(text||'{}');}catch{return {};}}
function iso(ms){return Number(ms)>0?new Date(Number(ms)).toISOString():null;}
function countBy(items,key){
  const out={};
  for(const item of items){const value=item[key]||'unknown';out[value]=(out[value]||0)+1;}
  return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)));
}
function acceptanceCounts(rows){
  const flags=['registered','channel_ready','check_ok','check_current_ok','has_entry','has_text_body','reader_ready','original_only'];
  const result={sources:rows.length};
  for(const flag of flags)result[flag]=rows.filter(row=>row[flag]).length;
  result.without_channel=rows.filter(row=>row.db_channel_count===0).length;
  result.never_checked=rows.filter(row=>row.db_channel_count>0&&row.successful_channel_count===0).length;
  return result;
}
function summarize(rows){
  const result={...acceptanceCounts(rows),platforms:countBy(rows,'platform'),by_platform:{}};
  for(const [platform,items] of [...Map.groupBy(rows,row=>row.platform)].sort(([a],[b])=>a.localeCompare(b)))
    result.by_platform[platform]=acceptanceCounts(items);
  return result;
}
function buildReport(manifestFile,dbFile,generatedAt=Date.now()){
  const raw=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  const manifest=Array.isArray(raw)?raw:(raw.subscriptions||[]);
  const manifestIds=manifest.map(source=>String(source.id||''));
  const duplicates=[...new Set(manifestIds.filter((id,i)=>manifestIds.indexOf(id)!==i))].sort();
  const db=new DatabaseSync(dbFile,{readOnly:true});
  try{
    const sourceRows=db.prepare('SELECT id,payload,visible,enabled FROM sources').all();
    const channels=db.prepare('SELECT id,source_id,payload,feed_id,state,last_check,last_success FROM channels').all();
    const entries=db.prepare(`SELECT source_id,
      count(*) entry_count,
      max(published_at) latest_published,
      max(discovered_at) latest_discovered,
      sum(case when content_state in ('TEXT','PARTIAL') then 1 else 0 end) text_count,
      sum(case when archive_state='READY' then 1 else 0 end) ready_count,
      sum(case when archive_state='ORIGINAL_ONLY' then 1 else 0 end) original_only_count
      FROM entries GROUP BY source_id`).all();
    const dbSources=new Map(sourceRows.map(row=>[String(row.id),row]));
    const channelsBySource=Map.groupBy(channels,row=>String(row.source_id));
    const entriesBySource=new Map(entries.map(row=>[String(row.source_id),row]));
    const rows=manifest.map(source=>{
      const id=String(source.id||'');
      const dbSource=dbSources.get(id);
      const sourceChannels=channelsBySource.get(id)||[];
      const configured=sourceChannels.filter(row=>{
        const payload=parsePayload(row.payload);
        return payload.enabled!==false&&payload.enabled!==0&&row.feed_id!==null;
      });
      const successful=sourceChannels.filter(row=>Number(row.last_success)>0);
      const currentSuccess=sourceChannels.filter(row=>String(row.state||'').startsWith(SUCCESS_PREFIX));
      const entry=entriesBySource.get(id)||{};
      const states=[...new Set(sourceChannels.map(row=>String(row.state||'UNKNOWN')))].sort();
      return {source_id:id,platform:String(source.platform||'unknown'),manifest_feed_count:Array.isArray(source.feeds)?source.feeds.length:0,
        registered:!!dbSource,source_enabled:dbSource?!!dbSource.enabled:null,source_visible:dbSource?!!dbSource.visible:null,
        db_channel_count:sourceChannels.length,configured_channel_count:configured.length,successful_channel_count:successful.length,
        current_successful_channel_count:currentSuccess.length,current_states:states,last_check:iso(Math.max(0,...sourceChannels.map(row=>Number(row.last_check)||0))),
        last_success:iso(Math.max(0,...sourceChannels.map(row=>Number(row.last_success)||0))),entry_count:Number(entry.entry_count)||0,
        latest_published:iso(entry.latest_published),latest_discovered:iso(entry.latest_discovered),text_body_count:Number(entry.text_count)||0,
        reader_ready_count:Number(entry.ready_count)||0,original_only_count:Number(entry.original_only_count)||0,
        registered:!!dbSource,channel_ready:configured.length>0,check_ok:successful.length>0,check_current_ok:currentSuccess.length>0,
        has_entry:(Number(entry.entry_count)||0)>0,has_text_body:(Number(entry.text_count)||0)>0,
        reader_ready:(Number(entry.ready_count)||0)>0,original_only:(Number(entry.original_only_count)||0)>0};
    });
    const dbIds=[...dbSources.keys()].sort();
    const wanted=new Set(manifestIds);
    const actual=new Set(dbIds);
    const parity={manifest_count:manifest.length,manifest_unique_ids:new Set(manifestIds).size,db_source_count:dbIds.length,
      duplicate_manifest_ids:duplicates,missing_in_db:[...wanted].filter(id=>!actual.has(id)).sort(),extra_in_db:[...actual].filter(id=>!wanted.has(id)).sort()};
    parity.exact=duplicates.length===0&&parity.missing_in_db.length===0&&parity.extra_in_db.length===0&&manifest.length===dbIds.length;
    return {schema:1,generated_at:new Date(generatedAt).toISOString(),semantics:{
      channel_ready:'at least one enabled channel has a local feed identity',check_ok:'at least one channel has ever completed successfully',
      check_current_ok:'at least one channel current state is SUCCEEDED_*',has_text_body:'Bridge has TEXT/PARTIAL content; this does not prove full-text completeness',
      reader_ready:'at least one entry has a successfully prepared Karakeep reader archive',original_only:'at least one entry explicitly requires original-site reading'},
      parity,summary:summarize(rows),rows};
  }finally{db.close();}
}
function main(){
  const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');return i<0?[arg,true]:[arg.slice(0,i),arg.slice(i+1)];}));
  const manifest=path.resolve(String(args['--manifest']||'data/subscriptions.json'));
  const db=path.resolve(String(args['--db']||'/var/lib/quiet-river-platform/bridge/bridge.sqlite'));
  const output=args['--output']?path.resolve(String(args['--output'])):null;
  const report=buildReport(manifest,db);
  if(output){fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});fs.chmodSync(output,0o600);}
  console.log(JSON.stringify({generated_at:report.generated_at,parity:report.parity,summary:report.summary,output:output||null},null,2));
  if(!report.parity.exact)process.exitCode=2;
}
if(require.main===module)main();
module.exports={buildReport,summarize};
