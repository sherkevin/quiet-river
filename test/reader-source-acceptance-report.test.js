'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {buildReport}=require('../tools/source-acceptance-report');

test('source acceptance separates registration, checks, text and reader evidence',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qr-accept-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const manifest=path.join(dir,'subscriptions.json'),dbFile=path.join(dir,'bridge.sqlite');
  fs.writeFileSync(manifest,JSON.stringify({subscriptions:[
    {id:'a',platform:'blog',feeds:['https://example.test/feed']},
    {id:'b',platform:'wechat',feeds:[]}
  ]}));
  const db=new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY,payload TEXT,visible INTEGER,enabled INTEGER);
    CREATE TABLE channels(id TEXT,source_id TEXT,payload TEXT,feed_id INTEGER,state TEXT,last_check INTEGER,last_success INTEGER);
    CREATE TABLE entries(source_id TEXT,published_at INTEGER,discovered_at INTEGER,content_state TEXT,archive_state TEXT);`);
  db.prepare('INSERT INTO sources VALUES(?,?,?,?)').run('a','{}',1,1);
  db.prepare('INSERT INTO sources VALUES(?,?,?,?)').run('b','{}',1,1);
  db.prepare('INSERT INTO channels VALUES(?,?,?,?,?,?,?)').run('ca','a',JSON.stringify({enabled:true}),7,'SUCCEEDED_NEW',1000,1000);
  db.prepare('INSERT INTO entries VALUES(?,?,?,?,?)').run('a',900,950,'PARTIAL','READY');
  db.close();
  const report=buildReport(manifest,dbFile,2000);
  assert.equal(report.parity.exact,true);
  assert.deepEqual(report.parity.missing_in_db,[]);
  assert.equal(report.summary.sources,2);
  assert.equal(report.summary.channel_ready,1);
  assert.equal(report.summary.check_ok,1);
  assert.equal(report.summary.has_text_body,1);
  assert.equal(report.summary.reader_ready,1);
  assert.equal(report.summary.by_platform.wechat.without_channel,1);
  assert.equal(report.rows.find(row=>row.source_id==='b').has_entry,false);
});

test('source acceptance reports manifest/database parity mismatch without inventing rows',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qr-accept-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const manifest=path.join(dir,'subscriptions.json'),dbFile=path.join(dir,'bridge.sqlite');
  fs.writeFileSync(manifest,JSON.stringify({subscriptions:[{id:'wanted',platform:'blog'}]}));
  const db=new DatabaseSync(dbFile);db.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY,payload TEXT,visible INTEGER,enabled INTEGER);CREATE TABLE channels(id TEXT,source_id TEXT,payload TEXT,feed_id INTEGER,state TEXT,last_check INTEGER,last_success INTEGER);CREATE TABLE entries(source_id TEXT,published_at INTEGER,discovered_at INTEGER,content_state TEXT,archive_state TEXT);`);
  db.prepare('INSERT INTO sources VALUES(?,?,?,?)').run('extra','{}',1,1);db.close();
  const report=buildReport(manifest,dbFile,2000);
  assert.equal(report.parity.exact,false);assert.deepEqual(report.parity.missing_in_db,['wanted']);assert.deepEqual(report.parity.extra_in_db,['extra']);
});
