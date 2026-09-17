'use strict';
const {originalLink}=require('./original-link.cjs');
function normalize(job,rows){
  if(!Array.isArray(rows)||rows.length>50)throw new Error('Invalid OpenCLI list');
  return rows.map(row=>{
    const original=originalLink(job,row.url);
    if(job.platform==='xiaohongshu'&&row.id&&String(row.id).toLowerCase()!==original.noteId)throw new Error('Original link identity mismatch');
    const title=String(row.question||row.title||(job.platform==='xiaohongshu'?'小红书笔记':'')).trim();
    if(!title)throw new Error('Missing article title');
    // The installed Xiaohongshu list has no publication field. Do not decode IDs into dates.
    let published=null;
    if(job.platform==='zhihu'&&row.created){
      const n=Number(row.created);if(Number.isFinite(n))published=n>100000000000?Math.floor(n):Math.floor(n*1000);
    }
    return {title:title.slice(0,1000),link:original.link,published,summary:''};
  });
}
function statusFor(code,text){
  if(code===77||/ERR_TICKET_NOT_EXIST|not logged in|login required|请先登录|登录已失效/i.test(text))return 'AUTH_REQUIRED';
  if(/Navigation rejected|403|access denied|访问受限|验证码/i.test(text))return 'ACCESS_BLOCKED';
  if(code===69||/extension.*not connected|browser.*not connected|bridge.*down/i.test(text))return 'BROWSER_OFFLINE';
  if(code===75||/timeout|timed out/i.test(text))return 'TIMEOUT';
  return 'UPSTREAM_ERROR';
}
module.exports={normalize,statusFor};
