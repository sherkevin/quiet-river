'use strict';

const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {escapeHTML}=require('./core');

const VIDEO_RE=/^[A-Za-z0-9_-]{11}$/;

function youtubeVideoTarget(value){
  let u;try{u=new URL(String(value||''));}catch{return null;}
  if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
  let id='';
  if(['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname)&&u.pathname==='/watch')id=u.searchParams.get('v')||'';
  else if(u.hostname==='youtu.be'&&/^\/[A-Za-z0-9_-]{11}\/?$/.test(u.pathname))id=u.pathname.split('/').filter(Boolean)[0]||'';
  if(!VIDEO_RE.test(id))return null;
  return {kind:'youtube-video',videoId:id,url:'https://www.youtube.com/watch?v='+id};
}

function timestamp(ms){
  const total=Math.max(0,Math.floor(Number(ms||0)/1000)),m=Math.floor(total/60),s=total%60;
  return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}

function transcriptFromJson3(payload,{maxChars=500000}={}){
  if(!payload||!Array.isArray(payload.events))throw new Error('YouTube subtitle JSON is invalid');
  const paragraphs=[];let current='',start=0,lastEnd=0,total=0,lastText='';
  const flush=()=>{const text=current.trim();if(text){paragraphs.push({start,text});total+=text.length;}current='';};
  for(const event of payload.events){
    if(total>=maxChars)break;
    const text=(Array.isArray(event?.segs)?event.segs.map(s=>String(s?.utf8||'')).join(''):'').replace(/\s+/g,' ').trim();
    if(!text||text===lastText)continue;
    const at=Number(event?.tStartMs)||0,duration=Number(event?.dDurationMs)||0,gap=at-lastEnd;
    if(!current){start=at;current=text;}
    else if(gap>5000||current.length+text.length+1>1200){flush();start=at;current=text;}
    else current+=' '+text;
    lastEnd=Math.max(lastEnd,at+duration);lastText=text;
  }
  flush();
  if(!paragraphs.length||total<40)throw new Error('YouTube subtitle transcript is empty');
  return {paragraphs,totalChars:total,truncated:total>=maxChars};
}

function renderTranscript(parsed,{language='en-orig',automatic=true}={}){
  const body=parsed.paragraphs.map(p=>'<p><time>'+escapeHTML(timestamp(p.start))+'</time> '+escapeHTML(p.text)+'</p>').join('');
  return '<section><h2>YouTube Transcript</h2><p class="muted">'+escapeHTML(automatic?'Automatic captions':'Captions')+' · '+escapeHTML(language)+(parsed.truncated?' · truncated at safety limit':'')+'</p>'+body+'</section>';
}

function selectSubtitleFile(dir,videoId){
  const names=fs.readdirSync(dir).filter(n=>n.startsWith(videoId+'.')&&n.endsWith('.json3'));
  for(const lang of ['en-orig','en']){
    const hit=names.find(n=>n===videoId+'.'+lang+'.json3');if(hit)return {path:path.join(dir,hit),language:lang,automatic:true};
  }
  return null;
}

function youtubeTranscript(service,target,{spawnFn=spawnSync}={}){
  const bin=service.config.tools?.ytDlp||'',proxy=service.config.tools?.youtubeProxy||'';
  if(!bin||!fs.existsSync(bin))throw new Error('yt-dlp runtime is not configured');
  if(proxy){
    let p;try{p=new URL(proxy);}catch{throw new Error('YouTube proxy URL is invalid');}
    if(!['http:','https:','socks5:','socks5h:'].includes(p.protocol)||!['127.0.0.1','localhost','::1'].includes(p.hostname))throw new Error('YouTube proxy must be loopback-only');
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qr-youtube-'));
  try{
    const output=path.join(dir,'%(id)s.%(ext)s');
    const args=['--ignore-config','--no-playlist','--skip-download','--write-auto-subs','--sub-langs','en-orig,en','--sub-format','json3',
      '--socket-timeout','10','--retries','1','--extractor-retries','1','--js-runtimes','node','-o',output];
    if(proxy)args.push('--proxy',proxy);
    args.push(target.url);
    const result=spawnFn(bin,args,{encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024,env:{...process.env,NO_COLOR:'1'}});
    if(result.error)throw new Error(result.error.code==='ETIMEDOUT'?'YouTube subtitle extraction timed out':result.error.message||'yt-dlp failed');
    if(result.status!==0)throw new Error('YouTube subtitle extraction failed');
    const subtitle=selectSubtitleFile(dir,target.videoId);if(!subtitle)throw new Error('YouTube English captions are unavailable');
    const stat=fs.statSync(subtitle.path);if(stat.size<=0||stat.size>4*1024*1024)throw new Error('YouTube subtitle file exceeds safety limit');
    let payload;try{payload=JSON.parse(fs.readFileSync(subtitle.path,'utf8'));}catch{throw new Error('YouTube subtitle JSON is invalid');}
    const parsed=transcriptFromJson3(payload);
    return {html:renderTranscript(parsed,{language:subtitle.language,automatic:subtitle.automatic}),language:subtitle.language,chars:parsed.totalChars,truncated:parsed.truncated};
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}

module.exports={youtubeVideoTarget,transcriptFromJson3,renderTranscript,youtubeTranscript};
