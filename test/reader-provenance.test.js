'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Database } = require('../reader-bridge/database');
const { ReaderService } = require('../reader-bridge/service');
const { channelsFor } = require('../reader-bridge/core');
const source = { id: 'provenance-source', name: 'Fixture', platform: 'blog',
  url: 'https://example.org/', feeds: ['https://example.org/feed'], tags: ['math'] };
function setup(t, mf = { call: async () => [] }) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const channel = channelsFor(source)[0];
  db.putSource(source, [channel]);
  db.run('UPDATE channels SET feed_id=7');
  return { db, channel, service: new ReaderService(db, { adapters: {}, karakeep: 'http://unused.invalid' }, { mf }) };
}
function article(extra = {}) {
  return { id: 7, title: 'Fixture article', author: 'Fixture author',
    url: 'https://example.org/article', published_at: '2026-09-16T00:00:00Z',
    content: '<p>Original content</p>', status: 'unread', ...extra };
}
test('identical sync preserves content timestamp and advances sync timestamp', t => {
  const { db, service, channel } = setup(t);
  service.project(article(), channel);
  db.run('UPDATE entries SET changed_at=11,synced_at=12');
  service.project(article(), channel);
  assert.equal(db.get('SELECT changed_at FROM entries').changed_at, 11);
  assert.ok(db.get('SELECT synced_at FROM entries').synced_at > 12);
});
test('read state changes do not masquerade as content changes', t => {
  const { db, service, channel } = setup(t);
  service.project(article(), channel);
  db.run('UPDATE entries SET changed_at=11');
  service.project(article({ status: 'read' }), channel);
  const saved = db.get('SELECT * FROM entries');
  assert.equal(saved.changed_at, 11); assert.equal(saved.status, 'read');
});
test('content changes beyond the summary still change the content version', t => {
  const { db, service, channel } = setup(t);
  const prefix = '<p>' + '正文'.repeat(800);
  service.project(article({ content: prefix + 'before</p>' }), channel);
  const before = db.get('SELECT * FROM entries');
  db.run('UPDATE entries SET changed_at=11');
  service.project(article({ content: prefix + 'after</p>' }), channel);
  const after = db.get('SELECT * FROM entries');
  assert.equal(after.summary, before.summary);
  assert.notEqual(after.content_hash, before.content_hash); assert.ok(after.changed_at > 11);
});
test('URL and publication corrections retain discovery and annotation identity', t => {
  const { db, service, channel } = setup(t);
  service.project(article(), channel);
  db.run("UPDATE entries SET discovered_at=10,bookmark_id='existing-note'");
  service.project(article({ url: 'https://example.org/corrected', published_at: '2026-09-15T00:00:00Z' }), channel);
  const saved = db.get('SELECT * FROM entries');
  assert.equal(saved.url, 'https://example.org/corrected');
  assert.equal(saved.published_at, Date.parse('2026-09-15T00:00:00Z'));
  assert.equal(saved.discovered_at, 10); assert.equal(saved.bookmark_id, 'existing-note');
});
test('first hash baseline preserves an old unchanged timestamp', t => {
  const { db, service, channel } = setup(t);
  service.project(article(), channel);
  db.run('UPDATE entries SET content_hash=NULL,changed_at=11');
  service.project(article(), channel);
  assert.equal(db.get('SELECT changed_at FROM entries').changed_at, 11);
  assert.ok(db.get('SELECT content_hash FROM entries').content_hash);
});
function importApi() {
  let stored; const writes = [];
  return { writes, call: async (path, method, body) => {
    if (path.endsWith('/import')) {
      stored = article({ content: body.content, status: body.status });
      writes.push({ method, body }); return { id: 7 };
    }
    if (method === 'PUT') { Object.assign(stored, body); writes.push({ method, body }); return stored; }
    return stored;
  } };
}
test('missing upstream date remains unknown despite Miniflux fallback date', async t => {
  const api = importApi(); const { db, service, channel } = setup(t, api);
  await service.importItem(channel, { guid: 'g1', link: 'https://example.org/article',
    title: 'Partial', content: '<p>Only an excerpt</p>', content_state: 'PARTIAL' });
  const saved = db.get('SELECT * FROM entries');
  assert.equal(saved.published_at, null); assert.equal(saved.published_at_source, 'unknown');
  assert.equal(saved.content_state, 'PARTIAL'); assert.equal(saved.content_origin, 'adapter_feed');
  assert.equal(api.writes[0].body.published_at, undefined);
});
test('later full content and date are corrected without a second import', async t => {
  const api = importApi(); const { db, service, channel } = setup(t, api);
  const item = { guid: 'g1', link: 'https://example.org/article', title: 'Article',
    content: '<p>Partial</p>', content_state: 'PARTIAL' };
  await service.importItem(channel, item);
  await service.importItem(channel, { ...item, content: '<p>Complete available text</p>',
    content_state: 'TEXT', published: 1789516800000 });
  const saved = db.get('SELECT * FROM entries');
  assert.equal(saved.published_at, 1789516800000); assert.equal(saved.published_at_source, 'upstream');
  assert.equal(saved.content_state, 'TEXT');
  assert.equal(api.writes.filter(w => w.method === 'POST').length, 1);
  assert.equal(api.writes.find(w => w.method === 'PUT').body.status, undefined);
});
test('empty later payload does not downgrade saved text or original date', async t => {
  const api = importApi(); const { db, service, channel } = setup(t, api);
  const item = { guid: 'g1', link: 'https://example.org/article', title: 'Article',
    content: '<p>Known text</p>', content_state: 'PARTIAL', published: 1789516800000 };
  await service.importItem(channel, item);
  await service.importItem(channel, { ...item, content: '', content_state: 'META', published: null });
  const saved = db.get('SELECT * FROM entries');
  assert.equal(saved.content_state, 'PARTIAL'); assert.equal(saved.published_at, 1789516800000);
  assert.equal(api.writes.length, 1);
});
test('invalid batch fails before writing the first source', async t => {
  const { db, service } = setup(t); const before = db.sources().length;
  await assert.rejects(service.importManifest({ subscriptions: [{ ...source, id: 'new' }, { id: 'invalid' }] }));
  assert.equal(db.sources().length, before);
});
test('adding a source preserves unrelated feed extraction settings', async t => {
  const calls = [];
  const next = { ...source, id: 'second', feeds: ['https://other.example/feed'] };
  const client = { call: async (path, method, body) => {
    calls.push({ path, method, body });
    if (path === '/v1/feeds') return [
      { id: 7, feed_url: source.feeds[0], crawler: true },
      { id: 8, feed_url: next.feeds[0], crawler: true, scraper_rules: 'article' }
    ];
    return null;
  } };
  const { service } = setup(t, client);
  await service.importManifest({ subscriptions: [next] });
  const writes = calls.filter(c => c.method === 'PUT');
  assert.deepEqual(writes.map(c => c.path), ['/v1/feeds/8']);
  assert.equal(writes[0].body.crawler, undefined);
  assert.equal(writes[0].body.scraper_rules, undefined);
  assert.ok(!calls.find(c => c.path === '/v1/import').body.includes(source.feeds[0]));
});
test('invalid content policy is rejected before writing', async t => {
  const { db, service } = setup(t);
  await assert.rejects(service.importManifest({ subscriptions: [
    { ...source, id: 'new', content_policy: 'guess' }
  ] }), /content policy/);
  assert.equal(db.sources().length, 1);
});
test('cross-origin redirects strip authentication headers regardless of case', () => {
  const { redirectHeaders } = require('../reader-bridge/network');
  const headers = { authorization: 'fixture', CoOkIe: 'fixture',
    'X-AUTH-TOKEN': 'fixture', 'Proxy-Authorization': 'fixture', Accept: 'text/html' };
  const result = redirectHeaders(headers, 'https://one.example/a', 'https://two.example/b');
  assert.deepEqual(result, { Accept: 'text/html' });
  assert.equal(headers.authorization, 'fixture');
});
test('same-origin redirects retain authentication without mutating caller headers', () => {
  const { redirectHeaders } = require('../reader-bridge/network');
  const headers = { authorization: 'fixture' };
  const result = redirectHeaders(headers, 'https://one.example/a', 'https://one.example/b');
  assert.deepEqual(result, headers); assert.notEqual(result, headers);
});
test('public feed proxy policy survives channel reprovisioning without proxying unrelated feeds', async t => {
  const db=new Database(':memory:');t.after(()=>db.close());
  const sources=[
    {id:'x',name:'X relay',platform:'twitter',url:'https://x.com/example',feeds:['https://relay.example/x'],tags:[]},
    {id:'yt',name:'YouTube',platform:'youtube',url:'https://youtube.com/@x',feeds:['https://www.youtube.com/feeds/videos.xml?channel_id=test'],tags:[]},
    {id:'gr',name:'Google Research Blog',platform:'blog',url:'https://research.google/blog/',feeds:['https://research.google/blog/rss/'],tags:[]},
    {id:'blog',name:'Direct blog',platform:'blog',url:'https://example.org/',feeds:['https://example.org/feed'],tags:[]}
  ];
  const channels=[];for(const s of sources){const cs=channelsFor(s);db.putSource(s,cs);channels.push(...cs);}
  const feeds=channels.map((c,i)=>({id:100+i,feed_url:c.url}));
  const writes=[];
  const mf={call:async(path,method,body)=>{if(path==='/v1/feeds')return feeds;if(method==='PUT')writes.push({path,body});return null;}};
  const service=new ReaderService(db,{adapters:{},karakeep:'http://unused.invalid',proxyFeedsEnabled:true},{mf});
  await service.provisionChannels(new Set(sources.map(s=>s.id)));
  const patches=new Map(writes.map(w=>[Number(w.path.split('/').at(-1)),w.body]));
  assert.equal(patches.get(100).fetch_via_proxy,true);
  assert.equal(patches.get(101).fetch_via_proxy,true);
  assert.equal(patches.get(102).fetch_via_proxy,true);
  assert.equal(patches.get(103).fetch_via_proxy,false);
});
