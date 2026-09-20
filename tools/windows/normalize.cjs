'use strict';
const {originalLink}=require('./original-link.cjs');
function normalize(job,rows){
  if(!Array.isArray(rows)||rows.length>50)throw new Error('Invalid OpenCLI list');
  if(job.platform==='twitter')return rows.filter(row=>!row?.isRetweet&&!row?.is_retweet).map(row=>normalizeTwitterRow(job,row));
  if(job.platform==='instagram')return rows.map(row=>normalizeInstagramRow(job,row));
  if(job.platform==='reddit')return rows.map(row=>normalizeRedditRow(job,row));
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
function normalizeRedditRow(job,row){
  if(!row||typeof row!=='object')throw new Error('Invalid Reddit row');
  const id=String(row.id||''),subreddit=String(row.subreddit||''),title=String(row.title||'').trim();
  if(!/^t3_[a-z0-9]+$/i.test(id)||!subreddit||!title)throw new Error('Invalid Reddit identity');
  if(subreddit.toLowerCase()!==String(job.authorId||'').toLowerCase())throw new Error('Reddit community mismatch');
  const original=originalLink({...job,kind:'community.posts'},String(row.url||''));if(original.redditId.toLowerCase()!==id.toLowerCase())throw new Error('Reddit post identity mismatch');
  let published=null;if(row.updated){const n=Date.parse(String(row.updated));if(Number.isFinite(n))published=n;}
  return {title:title.slice(0,1000),link:original.link,published,summary:String(row.summary||'').trim().slice(0,1500),author:String(row.author||'').slice(0,100)};
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
function normalizeYtDlpJson3(job,payload){
  if(!payload||typeof payload!=='object'||!Array.isArray(payload.events))throw new Error('Invalid yt-dlp JSON3 subtitle');
  const rows=[];let last='';
  for(const event of payload.events){
    if(!event||!Array.isArray(event.segs))continue;
    const text=event.segs.map(s=>String(s?.utf8||'')).join('').replace(/\s+/g,' ').trim();
    if(!text||text===last)continue;last=text;
    const ms=Number(event.tStartMs)||0,total=Math.max(0,Math.floor(ms/1000)),h=Math.floor(total/3600),m=Math.floor((total%3600)/60),s=total%60;
    const timestamp=(h?String(h)+':':'')+String(m).padStart(h?2:1,'0')+':'+String(s).padStart(2,'0');
    rows.push({timestamp,text});
    if(rows.length>5000)throw new Error('YouTube transcript has too many segments');
  }
  if(!rows.length)throw new Error('yt-dlp subtitle contains no transcript text');
  return normalizeYoutubeTranscript(job,rows);
}
function normalizeYoutubeTranscript(job,rows){
  if(!job||job.taskType!=='youtube_transcript_v1'||job.platform!=='youtube'||!Array.isArray(rows)||rows.length<1||rows.length>5000)throw new Error('Invalid YouTube transcript');
  const original=originalLink({platform:'youtube',kind:'transcript'},String(job.url||''));
  const lines=[];let chars=0;
  for(const row of rows){
    if(!row||typeof row!=='object')throw new Error('Invalid YouTube transcript row');
    const timestamp=String(row.timestamp||'').trim(),speaker=String(row.speaker||'').trim(),text=String(row.text||'').replace(/\s+/g,' ').trim();
    if(!text||text.length>10000||timestamp.length>64||speaker.length>120)throw new Error('Invalid YouTube transcript row');
    const prefix=[timestamp,speaker].filter(Boolean).join(' · '),line=(prefix?'['+prefix+'] ':'')+text;chars+=line.length+1;if(chars>1024*1024)throw new Error('YouTube transcript too large');lines.push(line);
  }
  return {entryId:Number(job.entryId),videoId:original.youtubeId,segmentCount:lines.length,content:lines.join('\n')};
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
  if(!job||job.taskType!=='entry_body_v1'||!Number.isSafeInteger(Number(job.entryId))||!['zhihu','xiaohongshu'].includes(job.platform))throw new Error('Invalid enrichment job');
  const expected=originalLink(job,job.url),max=1024*1024;let content='';
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
module.exports={normalize,normalizeEnrichment,normalizeYtDlpJson3,normalizeYoutubeTranscript,selectFreshXhsNoteUrl,statusFor};
