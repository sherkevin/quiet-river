'use strict';
// Shared client/server validation of original article links; never log signed query values.
function originalLink(job,value){
  if(typeof value!=='string'||value.length>4096)throw new Error('Original link mismatch');
  let u;try{u=new URL(value);}catch{throw new Error('Original link mismatch');}
  if(u.protocol!=='https:'||u.username||u.password||u.port)throw new Error('Original link mismatch');
  const kind=job.kind||job.label;
  if(job.platform==='zhihu'){
    const valid=kind==='answers'&&u.hostname==='www.zhihu.com'&&/^\/question\/\d+\/answer\/\d+$/.test(u.pathname)
      ||kind==='articles'&&u.hostname==='zhuanlan.zhihu.com'&&/^\/p\/\d+$/.test(u.pathname);
    if(!valid)throw new Error('Original link mismatch');
    return {link:u.href,guid:u.origin+u.pathname,noteId:null};
  }
  if(job.platform==='twitter'){
    if(!['tweets','author-posts'].includes(kind)||!['x.com','twitter.com','www.twitter.com'].includes(u.hostname))throw new Error('Original link mismatch');
    const match=/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/.exec(u.pathname);
    if(!match)throw new Error('Original link mismatch');
    const expected=String(job.authorId||'').replace(/^@/,'');
    if(!expected||match[1].toLowerCase()!==expected.toLowerCase())throw new Error('Original link author mismatch');
    return {link:`https://x.com/${match[1]}/status/${match[2]}`,guid:match[2],tweetId:match[2],noteId:null};
  }
  if(job.platform==='bilibili'){
    if(kind!=='videos'||u.hostname!=='www.bilibili.com')throw new Error('Original link mismatch');
    const match=/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)\/?$/.exec(u.pathname);
    if(!match)throw new Error('Original link mismatch');
    return {link:u.href,guid:'https://www.bilibili.com/video/'+match[1],noteId:null};
  }
  if(job.platform!=='xiaohongshu'||u.hostname!=='www.xiaohongshu.com')throw new Error('Original link mismatch');
  const simple=/^\/(?:explore|discovery\/item)\/([a-f\d]{24})$/i.exec(u.pathname);
  const profile=/^\/user\/profile\/([a-f\d]{24})\/([a-f\d]{24})$/i.exec(u.pathname);
  if(!simple&&!profile)throw new Error('Original link mismatch');
  if(profile&&(!job.authorId||profile[1].toLowerCase()!==String(job.authorId).toLowerCase())){
    throw new Error('Original link author mismatch');
  }
  const noteId=(simple?simple[1]:profile[2]).toLowerCase();
  // Keep the supplied signed URL for opening; deduplicate independently of route or token.
  return {link:u.href,guid:'https://www.xiaohongshu.com/explore/'+noteId,noteId};
}
module.exports={originalLink};
