'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {originalLink}=require('../tools/windows/original-link.cjs');
const author='0123456789abcdef01234567',note='abcdef0123456789abcdef01';
const job={platform:'xiaohongshu',authorId:author,kind:'notes'};
const profile=`https://www.xiaohongshu.com/user/profile/${author}/${note}`;
test('profile-note link preserves supplied query and creates stable article identity',()=>{
 const url=profile+'?xsec_token=fixture-only&xsec_source=pc_user';
 const r=originalLink(job,url);assert.equal(r.link,url);
 assert.equal(r.guid,'https://www.xiaohongshu.com/explore/'+note);
});
test('supported note routes and refreshed signed queries share one identity',()=>{
 const urls=[profile+'?xsec_token=first',profile+'?xsec_token=second',
  'https://www.xiaohongshu.com/explore/'+note,
  'https://www.xiaohongshu.com/discovery/item/'+note];
 assert.equal(new Set(urls.map(u=>originalLink(job,u).guid)).size,1);
});
test('profile-note path must name the assigned author',()=>{
 assert.throws(()=>originalLink({...job,authorId:'ffffffffffffffffffffffff'},profile),/author mismatch/);
 assert.throws(()=>originalLink({platform:'xiaohongshu'},profile),/author mismatch/);
});
test('profile homepage is not an article link',()=>{
 assert.throws(()=>originalLink(job,'https://www.xiaohongshu.com/user/profile/'+author));
});
test('non-platform hosts, embedded credentials, cleartext and nonstandard ports are rejected',()=>{
 const urls=[profile.replace('www.xiaohongshu.com','www.xiaohongshu.com.evil.example'),
  profile.replace('https://','http://'),profile.replace('https://','https://name:password@'),
  profile.replace('www.xiaohongshu.com','www.xiaohongshu.com:8443')];
 for(const url of urls)assert.throws(()=>originalLink(job,url));
});
test('Zhihu answer and article channels cannot exchange link types',()=>{
 const answer='https://www.zhihu.com/question/123/answer/456';
 const article='https://zhuanlan.zhihu.com/p/123';
 assert.equal(originalLink({platform:'zhihu',kind:'answers'},answer).guid,answer);
 assert.equal(originalLink({platform:'zhihu',kind:'articles'},article).guid,article);
 assert.throws(()=>originalLink({platform:'zhihu',kind:'answers'},article));
 assert.throws(()=>originalLink({platform:'zhihu',kind:'articles'},answer));
});
test('validation error does not repeat signed URL contents',()=>{
 const url=profile.replace(author,'ffffffffffffffffffffffff')+'?xsec_token=never-log-this';
 let message='';try{originalLink(job,url);}catch(e){message=e.message;}
 assert.ok(message);assert.ok(!message.includes('never-log-this'));
});
test('production collector requests isolated sessions without enabling network traces',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const script=fs.readFileSync(path.join(__dirname,'../tools/windows/collector.cjs'),'utf8');
 assert.match(script,/'--trace','off','--site-session','ephemeral'/);
});
test('Zhihu-only launcher keeps bounded work and does not start the other platform',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const script=fs.readFileSync(path.join(__dirname,'../tools/windows/Sync-Zhihu.cmd'),'utf8');
 assert.match(script,/--platform zhihu --max-jobs 20/);
 assert.ok(!script.includes('--watch'));assert.ok(!script.includes('xiaohongshu'));
});
test('Windows normalizer accepts installed OpenCLI profile-note rows and preserves the opening URL',()=>{
 const {normalize}=require('../tools/windows/normalize.cjs');
 const opening=profile+'?xsec_source=pc_user&fixture=one';
 const rows=normalize(job,[{id:note,title:'Fixture note',url:opening,unrelated:'discard'}]);
 assert.equal(rows[0].link,opening);assert.equal(rows[0].published,null);
 assert.equal(rows[0].unrelated,undefined);
});
test('Windows normalizer rejects note identity mismatch and supports blank note titles',()=>{
 const {normalize}=require('../tools/windows/normalize.cjs');
 assert.throws(()=>normalize(job,[{id:'ffffffffffffffffffffffff',title:'Wrong',url:profile}]),/identity mismatch/);
 const row=normalize(job,[{id:note,title:'',url:profile}])[0];
 assert.equal(row.title,'小红书笔记');
});
test('ECS validator accepts profile-note links only for the assigned author and keeps stable identity',()=>{
 const {validateItems}=require('../reader-bridge/desktop-collector');
 const channel={platform:'xiaohongshu',label:'notes',authorId:author};
 const a=validateItems(channel,[{title:'A',link:profile+'?fixture=one',published:null,summary:''}])[0];
 const b=validateItems(channel,[{title:'A',link:profile+'?fixture=two',published:null,summary:''}])[0];
 assert.equal(a.guid,b.guid);assert.notEqual(a.link,b.link);
 assert.throws(()=>validateItems({...channel,authorId:'ffffffffffffffffffffffff'},[{title:'A',link:profile}]),/does not match/);
});
test('Xiaohongshu-only launcher is bounded and does not start another platform or watch loop',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const script=fs.readFileSync(path.join(__dirname,'../tools/windows/Sync-Xiaohongshu.cmd'),'utf8');
 assert.match(script,/--platform xiaohongshu --max-jobs 20/);
 assert.ok(!script.includes('--watch'));assert.ok(!script.includes('--platform zhihu'));
});


test('Bilibili video links are canonicalized without accepting lookalike hosts',()=>{
 const biliJob={platform:'bilibili',kind:'videos',authorId:'503316308'};
 const url='https://www.bilibili.com/video/BV1XAew6mEhw?spm_id_from=fixture';
 const r=originalLink(biliJob,url);assert.equal(r.link,url);
 assert.equal(r.guid,'https://www.bilibili.com/video/BV1XAew6mEhw');
 assert.throws(()=>originalLink(biliJob,'https://www.bilibili.com.evil.example/video/BV1XAew6mEhw'));
 assert.throws(()=>originalLink({...biliJob,kind:'answers'},'https://www.bilibili.com/video/BV1XAew6mEhw'));
});

test('Windows normalizer keeps explicit Bilibili day precision and does not invent a date',()=>{
 const {normalize}=require('../tools/windows/normalize.cjs');
 const job={platform:'bilibili',kind:'videos',authorId:'503316308'};
 const a=normalize(job,[{title:'Video',date:'2026-09-17',url:'https://www.bilibili.com/video/BV1XAew6mEhw'}])[0];
 const b=normalize(job,[{title:'Video',date:'17 Sep 2026',url:'https://www.bilibili.com/video/BV1vwtJ6DE5Y'}])[0];
 assert.equal(a.published,Date.parse('2026-09-17T00:00:00Z'));assert.equal(b.published,null);
});

test('production Windows collector maps Bilibili only to the installed read-only user-videos command',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const script=fs.readFileSync(path.join(__dirname,'../tools/windows/collector.cjs'),'utf8');
 assert.match(script,/job\.platform==='bilibili'\?'user-videos'/);
 assert.match(script,/zhihu,xiaohongshu,bilibili/);
});

test('Bilibili-only launcher is bounded and does not start another platform or watch loop',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const script=fs.readFileSync(path.join(__dirname,'../tools/windows/Sync-Bilibili.cmd'),'utf8');
 assert.match(script,/--platform bilibili --max-jobs 20/);
 assert.ok(!script.includes('--watch'));assert.ok(!script.includes('--platform zhihu'));assert.ok(!script.includes('--platform xiaohongshu'));
});