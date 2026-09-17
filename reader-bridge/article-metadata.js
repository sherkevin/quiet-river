'use strict';
const {normalizeTags}=require('./tags');
const {json}=require('./core');
const ARTICLE_PREFIX='ui.article.tags.';
const BLOGGER_PREFIX='ui.blogger.tags.';
const READ_PREFIX='ui.article.read.';
// Use the existing settings store: no schema change or rewrite of source/content tables.
function tagSnapshot(store,id) {return store.setting(ARTICLE_PREFIX+id,null);}
function saveArticleTags(store,id,tags,origin='manual') {
  const record={tags:normalizeTags(tags),origin,updatedAt:Date.now()};
  store.set(ARTICLE_PREFIX+id,record);return record;
}
function inheritArticleTags(store,id,tags,origin='inherited') {
  return tagSnapshot(store,id)||saveArticleTags(store,id,tags,origin);
}
function articleTagMap(store) {
  return new Map(store.all("SELECT key,value FROM settings WHERE key GLOB 'ui.article.tags.*'")
    .map(r=>[Number(r.key.slice(ARTICLE_PREFIX.length)),json(r.value,{tags:[]})]));
}
function applyBloggerTags(store,sources) {
  const overrides=new Map(store.all("SELECT key,value FROM settings WHERE key GLOB 'ui.blogger.tags.*'")
    .map(r=>[r.key.slice(BLOGGER_PREFIX.length),json(r.value,[])]));
  return sources.map(s=>overrides.has(s.id)?{...s,tags:overrides.get(s.id)}:s);
}
function ensureSnapshots(store) {
  const sources=new Map(store.sources().map(s=>[s.id,s]));
  const rows=store.all("SELECT e.id,e.source_id FROM entries e LEFT JOIN settings s ON s.key='ui.article.tags.'||e.id WHERE s.key IS NULL");
  if(!rows.length)return 0;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for(const row of rows)inheritArticleTags(store,row.id,sources.get(row.source_id)?.tags||[],'backfill');
    store.db.exec('COMMIT');
  }catch(error){store.db.exec('ROLLBACK');throw error;}
  return rows.length;
}
function saveBloggerTags(store,id,tags) {
  const normalized=normalizeTags(tags);
  store.set(BLOGGER_PREFIX+id,normalized);return normalized;
}
function localReadState(store,id) {return store.setting(READ_PREFIX+id,null);}
function saveReadState(store,id,status) {
  store.set(READ_PREFIX+id,{status,changedAt:Date.now()});
}
module.exports={tagSnapshot,saveArticleTags,inheritArticleTags,articleTagMap,
  applyBloggerTags,ensureSnapshots,saveBloggerTags,localReadState,saveReadState};
