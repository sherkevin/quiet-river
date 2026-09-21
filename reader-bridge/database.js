'use strict';
const {DatabaseSync} = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const {json, hash} = require('./core');

class Database {
  constructor(file) {
    if(file!==':memory:')fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,payload TEXT NOT NULL,visible INTEGER NOT NULL DEFAULT 1,enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),payload TEXT NOT NULL,feed_id INTEGER,state TEXT NOT NULL DEFAULT 'NEVER_CHECKED',last_check INTEGER NOT NULL DEFAULT 0,last_success INTEGER NOT NULL DEFAULT 0,next_check INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',failures INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY,channel_id TEXT,source_id TEXT,url TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL DEFAULT '',summary TEXT NOT NULL DEFAULT '',published_at INTEGER,discovered_at INTEGER NOT NULL,changed_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'unread',content_state TEXT NOT NULL DEFAULT 'META',bookmark_id TEXT,note_bookmark_id TEXT,archive_hash TEXT,archive_state TEXT NOT NULL DEFAULT 'NONE');
      CREATE INDEX IF NOT EXISTS entries_date ON entries(published_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS entries_source ON entries(source_id,status);
      CREATE TABLE IF NOT EXISTS imports(channel_id TEXT NOT NULL,external_id TEXT NOT NULL,entry_id INTEGER,content_hash TEXT,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'PENDING',PRIMARY KEY(channel_id,external_id));
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'UNKNOWN',last_success INTEGER NOT NULL DEFAULT 0,next_allowed INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,alerted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,finished_at INTEGER,kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER,error TEXT NOT NULL DEFAULT '');
      CREATE UNIQUE INDEX IF NOT EXISTS active_channel ON jobs(channel_id) WHERE state IN ('QUEUED','RUNNING');
      CREATE TABLE IF NOT EXISTS run_jobs(run_id TEXT REFERENCES runs(id),job_id TEXT REFERENCES jobs(id),PRIMARY KEY(run_id,job_id));
      CREATE TABLE IF NOT EXISTS feedback(entry_id INTEGER PRIMARY KEY,value INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entry_enrichments(entry_id INTEGER NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL,detail TEXT NOT NULL DEFAULT '',PRIMARY KEY(entry_id,kind));
      CREATE TABLE IF NOT EXISTS digests(day TEXT PRIMARY KEY,created_at INTEGER NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'PENDING',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,created_at INTEGER NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,result TEXT NOT NULL);
    `);
    // Additive, idempotent provenance migration; preserve existing article/annotation IDs.
    const additions={
      entries:{content_hash:'TEXT',synced_at:'INTEGER NOT NULL DEFAULT 0',content_origin:"TEXT NOT NULL DEFAULT 'legacy_unknown'",published_at_source:"TEXT NOT NULL DEFAULT 'unverified'",note_bookmark_id:'TEXT'},
      imports:{original_published_at:'INTEGER',published_at_source:'TEXT',content_state:'TEXT',content_origin:'TEXT'}
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const [table,columns] of Object.entries(additions)){
        const existing=new Set(this.all(`PRAGMA table_info(${table})`).map(c=>c.name));
        for(const [name,type] of Object.entries(columns))if(!existing.has(name))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS imports_entry ON imports(entry_id)');
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    if(!this.all('PRAGMA table_info(jobs)').some(c=>c.name==='priority'))this.db.exec('ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  }
  all(sql,...args){return this.db.prepare(sql).all(...args);}
  get(sql,...args){return this.db.prepare(sql).get(...args);}
  run(sql,...args){return this.db.prepare(sql).run(...args);}
  setting(key,fallback){const r=this.get('SELECT value FROM settings WHERE key=?',key);return r?json(r.value,fallback):fallback;}
  set(key,value){this.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(value));}
  sources(){return require('./article-metadata').applyBloggerTags(this,this.all('SELECT * FROM sources').map(s=>({...json(s.payload,{}),visible:!!s.visible,enabled:!!s.enabled})));}
  channels(){return this.all('SELECT * FROM channels').map(c=>({...json(c.payload,{}),...c,payload:undefined}));}
  audit(action,target,result){this.run('INSERT INTO audit(created_at,action,target,result) VALUES(?,?,?,?)',Date.now(),action,String(target),String(result).slice(0,500));}
  alert(key,title,message){this.run('INSERT OR IGNORE INTO outbox(id,created_at,payload) VALUES(?,?,?)',key,Date.now(),JSON.stringify({title,message}));}
  putSource(source,channels){
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.run('INSERT INTO sources(id,payload,visible,enabled) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',source.id,JSON.stringify(source),source.disabled||source.visible===false?0:1,source.enabled===false?0:1);
      for(const c of channels){this.run('INSERT INTO channels(id,source_id,payload,state) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',c.id,source.id,JSON.stringify(c),c.enabled?'NEVER_CHECKED':'NOT_CONFIGURED');this.run('INSERT OR IGNORE INTO groups(id) VALUES(?)',c.group_key);}
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  createRun(channels,kind='manual',now=Date.now()){
    const id=cryptoRandom();this.db.exec('BEGIN IMMEDIATE');
    try {
      this.run('INSERT INTO runs(id,created_at,kind) VALUES(?,?,?)',id,now,kind);
      for(const c of channels){
        let job=this.get("SELECT id FROM jobs WHERE channel_id=? AND state IN ('QUEUED','RUNNING')",c.id);
        if(!job){job={id:cryptoRandom()};this.run('INSERT INTO jobs(id,channel_id,state,created_at) VALUES(?,?,?,?)',job.id,c.id,'QUEUED',now);}
        const priority=kind==='scheduled'?0:channels.length<=4?2:1;
        this.run("UPDATE jobs SET priority=MAX(priority,?) WHERE id=? AND state='QUEUED'",priority,job.id);
        this.run('INSERT OR IGNORE INTO run_jobs VALUES(?,?)',id,job.id);
      }
      if(!channels.length)this.run('UPDATE runs SET finished_at=? WHERE id=?',now,id);
      this.db.exec('COMMIT');return this.runStatus(id);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  runStatus(id){const r=this.get('SELECT * FROM runs WHERE id=?',id);if(!r)return null;const jobs=this.all('SELECT j.id,j.channel_id,j.state,j.error,j.finished_at FROM jobs j JOIN run_jobs r ON r.job_id=j.id WHERE r.run_id=?',id);return {...r,jobs,pending:jobs.filter(j=>['QUEUED','RUNNING'].includes(j.state)).length};}
  recover(){this.run("UPDATE jobs SET state='QUEUED',error='服务重启后恢复未完成任务' WHERE state='RUNNING'");}
  close(){this.db.close();}
}
function cryptoRandom(){return hash(require('node:crypto').randomBytes(24)).slice(0,24);}
module.exports={Database};
