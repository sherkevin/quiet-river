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
