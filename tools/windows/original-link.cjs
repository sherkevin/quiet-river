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
  if(job.platform==='instagram'){
    if(kind!=='posts'||u.hostname!=='www.instagram.com')throw new Error('Original link mismatch');
    const match=/^\/(p|reel)\/([A-Za-z0-9_-]{5,32})\/?$/.exec(u.pathname);
    if(!match)throw new Error('Original link mismatch');
    return {link:`https://www.instagram.com/${match[1]}/${match[2]}/`,guid:'instagram:'+match[2],instagramCode:match[2],noteId:null};
  }
  if(job.platform==='youtube'){
    if(kind!=='transcript'||!['youtube.com','www.youtube.com','youtu.be'].includes(u.hostname))throw new Error('Original link mismatch');
    let videoId='';
    if(u.hostname==='youtu.be'){const m=/^\/([A-Za-z0-9_-]{11})\/?$/.exec(u.pathname);if(m)videoId=m[1];}
    else if(u.pathname==='/watch'&&/^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v')||''))videoId=u.searchParams.get('v');
    if(!videoId)throw new Error('Original link mismatch');
    return {link:`https://www.youtube.com/watch?v=${videoId}`,guid:'youtube:'+videoId,youtubeId:videoId,noteId:null};
  }
  if(job.platform==='reddit'){
    if(!['community.posts','user.posts'].includes(kind)||!['reddit.com','www.reddit.com','old.reddit.com'].includes(u.hostname))throw new Error('Original link mismatch');
    const match=/^\/r\/([A-Za-z0-9_]{2,32})\/comments\/([a-z0-9]+)(?:\/[^/?#]+)?\/?$/i.exec(u.pathname);
    if(!match)throw new Error('Original link mismatch');
    if(kind==='community.posts'){const expected=String(job.authorId||'').toLowerCase();if(!expected||match[1].toLowerCase()!==expected)throw new Error('Original link community mismatch');}
    const id='t3_'+match[2].toLowerCase();
    return {link:`https://www.reddit.com/r/${match[1]}/comments/${match[2].toLowerCase()}/`,guid:id,redditId:id,subreddit:match[1]};
  }
  if(job.platform==='bilibili'){
    if(kind!=='videos'||u.hostname!=='www.bilibili.com')throw new Error('Original link mismatch');
    const match=/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)\/?$/.exec(u.pathname);
    if(!match)throw new Error('Original link mismatch');
    return {link:u.href,guid:'https://www.bilibili.com/video/'+match[1],bilibiliId:match[1],noteId:null};
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
