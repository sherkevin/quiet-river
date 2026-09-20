'use strict';
const {originalLink}=require('./original-link.cjs');
function normalize(job,rows){
  if(!Array.isArray(rows)||rows.length>50)throw new Error('Invalid OpenCLI list');
  if(job.platform==='twitter')return rows.filter(row=>!row?.isRetweet&&!row?.is_retweet).map(row=>normalizeTwitterRow(job,row));
  if(job.platform==='instagram')return rows.map(row=>normalizeInstagramRow(job,row));
  return rows.map(row=>{
    const original=originalLink(job,row.url);
    if(job.platform==='xiaohongshu'&&row.id&&String(row.id).toLowerCase()!==original.noteId)throw new Error('Original link identity mismatch');
    const title=String(row.question||row.title||(job.platform==='xiaohongshu'?'小红书笔记':'')).trim();
    if(!title)throw new Error('Missing article title');
    // The installed Xiaohongshu list has no publication field. Do not decode IDs into dates.
    let published=null;
    if(job.platform==='zhihu'&&row.created){
      const n=Number(row.created);if(Number.isFinite(n))published=n>100000000000?Math.floor(n):Math.floor(n*1000);
    } else if(job.platform==='bilibili'&&typeof row.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.date)){
      const n=Date.parse(row.date+'T00:00:00Z');if(Number.isFinite(n))published=n;
    }
    return {title:title.slice(0,1000),link:original.link,published,summary:''};
  });
}
function normalizeInstagramRow(job,row){
  if(!row||typeof row!=='object')throw new Error('Invalid Instagram row');
  const id=String(row.id||''),code=String(row.code||''),author=String(row.author||'');
  if(!/^\d{1,30}$/.test(id)||!/^[A-Za-z0-9_-]{5,32}$/.test(code)||!author)throw new Error('Invalid Instagram identity');
  if(author.toLowerCase()!==String(job.authorId||'').toLowerCase())throw new Error('Instagram author mismatch');
  const original=originalLink({...job,kind:'posts'},String(row.url||''));
  if(original.instagramCode!==code)throw new Error('Instagram shortcode mismatch');
  const caption=String(row.caption||'').trim(),taken=Number(row.taken_at),published=Number.isFinite(taken)&&taken>0?Math.floor(taken*1000):null;
  const fallback=(job.name||('@'+author))+' 的 Instagram 帖子';
  return {title:(caption||fallback).slice(0,1000),link:original.link,published,summary:caption.slice(0,1500),author};
}
function normalizeTwitterRow(job,row){
  if(!row||typeof row!=='object')throw new Error('Invalid Twitter row');
  const id=String(row.id||'');if(!/^\d{1,25}$/.test(id))throw new Error('Invalid Twitter tweet id');
  const screen=String(typeof row.author==='object'?(row.author?.screenName||''):row.author||'').replace(/^@/,'');
  if(!screen)throw new Error('Missing Twitter author');
  const link=typeof row.url==='string'&&row.url?row.url:`https://x.com/${screen}/status/${id}`;
  const original=originalLink({...job,kind:job.kind||'tweets'},link);
  if(original.tweetId!==id)throw new Error('Twitter identity mismatch');
  const text=String(row.text||'').trim(),rawDate=row.createdAtISO||row.created_at||row.createdAt||null;
  let published=null;if(rawDate){const n=Date.parse(String(rawDate));if(Number.isFinite(n))published=n;}
  const fallback=(job.name||('@'+screen))+' 的 X 帖子';
  return {title:(text||fallback).slice(0,1000),link:original.link,published,summary:text.slice(0,1500)};
}
function selectFreshXhsNoteUrl(job,rows){
  if(job?.platform!=='xiaohongshu'||job?.kind!=='notes'||!Array.isArray(rows)||rows.length>100)throw new Error('Invalid Xiaohongshu refresh list');
  const expected=originalLink(job,job.url);
  for(const row of rows){
    if(!row||typeof row.url!=='string')continue;
    try{const actual=originalLink(job,row.url);if(actual.noteId===expected.noteId&&String(row.id||'').toLowerCase()===expected.noteId)return actual.link;}catch{}
  }
  return '';
}
function normalizeEnrichment(job,payload){
  if(!job||!Number.isSafeInteger(Number(job.entryId)))throw new Error('Invalid enrichment job');
  const max=1024*1024;
  if(job.taskType==='entry_transcript_v1'){
    if(job.platform!=='bilibili'||job.kind!=='videos'||!Array.isArray(payload)||payload.length>20000)throw new Error('Invalid Bilibili transcript job');
    originalLink(job,job.url);const lines=[];let last='';
    for(const row of payload){
      if(!row||typeof row!=='object')throw new Error('Invalid Bilibili subtitle row');
      const from=String(row.from||''),to=String(row.to||''),fm=/^(\d+(?:\.\d+)?)s$/.exec(from),tm=/^(\d+(?:\.\d+)?)s$/.exec(to);
      if(!fm||!tm||Number(tm[1])<Number(fm[1]))throw new Error('Invalid Bilibili subtitle timestamp');
      const text=String(row.content??'').replace(/\s+/g,' ').trim();if(!text||text===last)continue;
      lines.push('['+from+' - '+to+'] '+text);last=text;
    }
    const content=lines.join('\n').trim();
    if(!content||content.length<40||Buffer.byteLength(content,'utf8')>max)throw new Error('Bilibili transcript missing or too large');
    return {entryId:Number(job.entryId),content};
  }
  if(job.taskType!=='entry_body_v1'||!['zhihu','xiaohongshu'].includes(job.platform))throw new Error('Invalid enrichment job');
  const expected=originalLink(job,job.url);let content='';
  if(job.platform==='zhihu'&&job.kind==='answers'){
    const row=Array.isArray(payload)?payload[0]:payload;if(!row||typeof row!=='object'||typeof row.url!=='string')throw new Error('Invalid Zhihu answer detail');
    const actual=originalLink(job,row.url);if(actual.guid!==expected.guid)throw new Error('Enrichment identity mismatch');content=String(row.content||'');
  }else if(job.platform==='xiaohongshu'&&job.kind==='notes'){
    if(!Array.isArray(payload))throw new Error('Invalid Xiaohongshu note detail');const fields=Object.fromEntries(payload.filter(x=>x&&typeof x.field==='string').map(x=>[x.field,String(x.value??'')]));content=fields.content||'';
  }else if(job.platform==='zhihu'&&job.kind==='articles'&&typeof payload==='string')content=payload;
  else throw new Error('Unsupported enrichment kind');
  content=content.replace(/^\uFEFF/,'').trim();
  if(!content||Buffer.byteLength(content,'utf8')>max)throw new Error('Enrichment body missing or too large');
  if(content.length<4000&&/登录后查看|请登录|登录已失效|验证码|安全限制|访问链接异常|页面不见了|笔记不存在|access denied|security block/i.test(content))throw new Error('Enrichment returned a login or challenge page');
  return {entryId:Number(job.entryId),content};
}
function statusFor(code,text){
  if(code===77||/ERR_TICKET_NOT_EXIST|not logged in|login required|请先登录|登录已失效/i.test(text))return 'AUTH_REQUIRED';
  if(/Navigation rejected|403|access denied|访问受限|验证码/i.test(text))return 'ACCESS_BLOCKED';
  if(code===69||/extension.*not connected|browser.*not connected|bridge.*down/i.test(text))return 'BROWSER_OFFLINE';
  if(code===75||/timeout|timed out/i.test(text))return 'TIMEOUT';
  return 'UPSTREAM_ERROR';
}
module.exports={normalize,normalizeEnrichment,selectFreshXhsNoteUrl,statusFor};
