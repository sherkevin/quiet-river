'use strict';

const {escapeHTML}=require('./core');

const BVID_RE=/^BV[0-9A-Za-z]{10}$/;
const API_ROOT='https://api.bilibili.com/x/web-interface/view?bvid=';

function bilibiliVideoTarget(value){
  let u;try{u=new URL(String(value||''));}catch{return null;}
  if(u.protocol!=='https:'||u.hostname!=='www.bilibili.com'||u.username||u.password||u.port)return null;
  const m=/^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(u.pathname);if(!m)return null;
  return {kind:'bilibili-video',bvid:m[1],url:'https://www.bilibili.com/video/'+m[1]};
}

function compactNumber(value){
  const n=Number(value);return Number.isFinite(n)&&n>=0?Math.floor(n):0;
}
function durationLabel(seconds){
  const total=compactNumber(seconds),h=Math.floor(total/3600),m=Math.floor(total%3600/60),s=total%60;
  return h?String(h)+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'):String(m)+':'+String(s).padStart(2,'0');
}
function normalizeApiPayload(data){
  const owner=data?.owner&&typeof data.owner==='object'?data.owner:{},stat=data?.stat&&typeof data.stat==='object'?data.stat:{};
  return {video:{
    bvid:String(data?.bvid||''),url:data?.bvid?'https://www.bilibili.com/video/'+String(data.bvid):'',
    title:String(data?.title||''),description:String(data?.desc||''),duration:durationLabel(data?.duration),
    owner:{id:String(owner.mid||''),name:String(owner.name||'')},
    stats:{view:compactNumber(stat.view),danmaku:compactNumber(stat.danmaku),like:compactNumber(stat.like),coin:compactNumber(stat.coin),favorite:compactNumber(stat.favorite),share:compactNumber(stat.share)}
  }};
}

function validatePayload(payload,target,{expectedOwnerId=''}={}){
  const video=payload?.video;if(!video||typeof video!=='object')throw new Error('Bilibili detail API returned invalid video payload');
  if(String(video.bvid||'')!==target.bvid||String(video.url||'')!==target.url)throw new Error('Bilibili video identity mismatch');
  const owner=video.owner&&typeof video.owner==='object'?video.owner:{};
  if(expectedOwnerId&&String(owner.id||'')!==String(expectedOwnerId))throw new Error('Bilibili video owner mismatch');
  return video;
}

function renderVideo(video){
  const owner=video.owner||{},stats=video.stats||{},desc=String(video.description||'').trim().slice(0,20000);
  return '<section><h2>Bilibili Video 详情</h2>'+
    '<p><strong>'+escapeHTML(video.title||'')+'</strong> · <code>'+escapeHTML(video.bvid||'')+'</code></p>'+
    '<p>UP主：'+escapeHTML(owner.name||'')+(owner.id?' · UID '+escapeHTML(owner.id):'')+' · 时长 '+escapeHTML(video.duration||'')+'</p>'+
    '<p>播放 '+compactNumber(stats.view)+' · 弹幕 '+compactNumber(stats.danmaku)+' · 点赞 '+compactNumber(stats.like)+' · 投币 '+compactNumber(stats.coin)+' · 收藏 '+compactNumber(stats.favorite)+' · 分享 '+compactNumber(stats.share)+'</p>'+
    (desc?'<h3>简介</h3><p>'+escapeHTML(desc).replace(/\n/g,'<br>')+'</p>':'')+
    '</section>';
}

async function bilibiliDetail(service,target,{expectedOwnerId=''}={}){
  const response=await service.internalFetch(API_ROOT+encodeURIComponent(target.bvid),{trusted:false,timeout:10000,maxBytes:2*1024*1024,headers:{
    'User-Agent':'Mozilla/5.0 AppleWebKit/537.36 Chrome/133 Safari/537.36','Referer':'https://www.bilibili.com/','Accept':'application/json'
  }});
  if(response.status!==200){const e=new Error('Bilibili detail API HTTP '+response.status);e.status=response.status;throw e;}
  let body;try{body=JSON.parse(response.body.toString('utf8'));}catch{throw new Error('Bilibili detail API returned invalid JSON');}
  if(body?.code!==0||!body?.data)throw new Error('Bilibili detail API rejected request');
  const video=validatePayload(normalizeApiPayload(body.data),target,{expectedOwnerId});
  return {html:renderVideo(video),bvid:video.bvid,ownerId:String(video.owner?.id||''),title:String(video.title||'')};
}

module.exports={bilibiliVideoTarget,normalizeApiPayload,validatePayload,renderVideo,bilibiliDetail};
