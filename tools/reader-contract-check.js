#!/usr/bin/env node
'use strict';
// Live contract check: creates only namespaced fixtures, deletes only their returned IDs.
// Run with the private Bridge env file. Never print response bodies or credential values.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {Database} = require('../reader-bridge/database');
const {ReaderService} = require('../reader-bridge/service');
const {loadConfig} = require('../reader-bridge/server');
const pause = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const config = loadConfig();
  assert(config.minifluxToken && config.karakeepToken, 'Configure both local API identities');
  const db = new Database(':memory:');
  const service = new ReaderService(db, config);
  const suffix = crypto.randomBytes(8).toString('hex');
  const source = {id:'contract-'+suffix, name:'Integration test '+suffix,
    platform:'blog', fullTextMode:'feed', tags:['contract'], url:'https://example.invalid/',
    feeds:['https://example.invalid/quiet-river-test/'+suffix]};
  let feedId, bookmarkId, highlightId;
  try {
    await service.importManifest({subscriptions:[source]});
    const channel = db.channels()[0]; feedId = channel.feed_id;
    assert(feedId, 'OPML creates disabled feed without external request');
    console.log('PASS source creation through native API');
    const text = '这是本地集成测试的正文，验证保存、划线、备注与阅读状态。';
    const html = '<h2>阅读验证</h2>' + '<p>'+text.repeat(30)+'</p>';
    const item = {guid:suffix,link:source.url+'article/'+suffix,
      title:'Quiet River contract test',author:'Test fixture',content:html,published:Date.now()};
    assert.equal(await service.importItem(channel,item),1);
    const entry = db.get('SELECT * FROM entries');
    assert.equal(entry.status,'unread');
    await service.markRead(entry.id,'read');
    await service.importItem(channel,{...item,content:html+'<p>更新正文</p>'});
    const changed = await service.mf.call('/v1/entries/'+entry.id);
    assert.equal(changed.status,'read');
    assert(changed.content.includes('更新正文'));
    console.log('PASS import, update and read-state preservation');
    const result = await service.archive(entry.id); bookmarkId=result.bookmarkId;
    assert(bookmarkId);
    let bookmark;
    for(let i=0;i<40;i++){
      bookmark=await service.kk.call('/api/v1/bookmarks/'+bookmarkId+'?includeContent=true');
      if(bookmark.content?.crawlStatus==='success' || bookmark.content?.crawlStatus==='failure')break;
      await pause(1000);
    }
    console.log('Reader processing status:',bookmark.content?.crawlStatus,bookmark.content?.readerViewStatus,'html length:',String(bookmark.content?.htmlContent||'').length);
    assert(bookmark.content?.htmlContent,'Archive processing must complete');
    const readable=String(bookmark.content?.htmlContent||bookmark.content?.textContent||'');
    assert(readable.includes('本地集成测试'),'The stored reader must contain our supplied text');
    console.log('PASS HTML archive parsed by actual reader worker');
    const highlighted=await service.kk.call('/api/v1/highlights','POST',{
      bookmarkId,text:'阅读验证',startOffset:0,endOffset:4,color:'yellow',note:'本地测试批注'});
    highlightId=highlighted.id;
    assert(highlightId);
    const page=await service.highlights();
    assert(page.highlights.some(h=>h.id===highlightId));
    console.log('PASS persistent highlight and cross-article list');
    assert.equal((await service.archive(entry.id)).bookmarkId,bookmarkId);
    console.log('PASS archive identity reused without replacing annotated content');
    console.log('ALL LIVE CONTRACT CHECKS PASSED');
  } finally {
    if(highlightId)await service.kk.call('/api/v1/highlights/'+highlightId,'DELETE');
    if(bookmarkId)await service.kk.call('/api/v1/bookmarks/'+bookmarkId,'DELETE');
    if(feedId)await service.mf.call('/v1/feeds/'+feedId,'DELETE');
    db.close();
    console.log('Isolated test fixtures removed');
  }
}
main().catch(error=>{
  console.error('Contract check failed:',error.message);
  process.exitCode=1;
});
