'use strict';

const {escapeHTML}=require('./core');

const OWNER_RE=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE=/^[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE=/^[0-9a-f]{7,40}$/i;

function githubDetailTarget(value){
  let u;try{u=new URL(String(value||''));}catch{return null;}
  if(u.protocol!=='https:'||u.hostname!=='github.com'||u.username||u.password||u.port)return null;
  const parts=u.pathname.split('/').filter(Boolean);
  if(parts.length===4&&parts[2]==='commit'&&OWNER_RE.test(parts[0])&&REPO_RE.test(parts[1])&&SHA_RE.test(parts[3])){
    return {kind:'commit',owner:parts[0],repo:parts[1],sha:parts[3].toLowerCase()};
  }
  if(parts.length===4&&parts[2]==='compare'&&OWNER_RE.test(parts[0])&&REPO_RE.test(parts[1])){
    const m=/^([0-9a-f]{7,40})\.\.\.([0-9a-f]{7,40})$/i.exec(parts[3]);
    if(m)return {kind:'compare',owner:parts[0],repo:parts[1],base:m[1].toLowerCase(),head:m[2].toLowerCase()};
  }
  return null;
}
function apiUrl(t){
  const root='https://api.github.com/repos/'+encodeURIComponent(t.owner)+'/'+encodeURIComponent(t.repo);
  return t.kind==='commit'?root+'/commits/'+encodeURIComponent(t.sha):root+'/compare/'+encodeURIComponent(t.base+'...'+t.head);
}
function safeText(value,max=10000){return String(value??'').replace(/\u0000/g,'').slice(0,max);}
function validateRepoHtmlUrl(value,t){
  let u;try{u=new URL(String(value||''));}catch{return false;}
  return u.protocol==='https:'&&u.hostname==='github.com'&&u.pathname.toLowerCase().startsWith('/'+t.owner.toLowerCase()+'/'+t.repo.toLowerCase()+'/');
}
function fileList(files){
  return (Array.isArray(files)?files:[]).slice(0,100).map(f=>{
    const name=escapeHTML(safeText(f?.filename,500)),status=escapeHTML(safeText(f?.status,40));
    const plus=Number.isFinite(Number(f?.additions))?Number(f.additions):0,minus=Number.isFinite(Number(f?.deletions))?Number(f.deletions):0;
    return '<li><code>'+name+'</code> · '+status+' · +'+plus+' / -'+minus+'</li>';
  }).join('');
}
function renderCommit(data,t){
  const sha=String(data?.sha||'').toLowerCase();if(!sha.startsWith(t.sha)||!validateRepoHtmlUrl(data?.html_url,t))throw new Error('GitHub commit identity mismatch');
  const message=safeText(data?.commit?.message,20000),author=safeText(data?.commit?.author?.name||data?.author?.login||'',200),date=safeText(data?.commit?.author?.date||'',100);
  const stats=data?.stats||{},add=Number(stats.additions)||0,del=Number(stats.deletions)||0,total=Number(stats.total)||add+del;
  return '<section><h2>GitHub Commit 详情</h2><p><strong>'+escapeHTML(t.owner+'/'+t.repo)+'</strong> · <code>'+escapeHTML(sha.slice(0,12))+'</code></p>'+
    '<pre><code>'+escapeHTML(message)+'</code></pre>'+
    '<p>'+escapeHTML(author)+(date?' · '+escapeHTML(date):'')+' · '+total+' changes · +'+add+' / -'+del+'</p>'+
    ((data.files||[]).length?'<h3>Changed files</h3><ul>'+fileList(data.files)+'</ul>':'')+'</section>';
}
function renderCompare(data,t){
  const base=String(data?.base_commit?.sha||'').toLowerCase(),head=String(data?.head_commit?.sha||data?.commits?.at(-1)?.sha||'').toLowerCase();
  if(!base.startsWith(t.base)||!head.startsWith(t.head)||!validateRepoHtmlUrl(data?.html_url,t))throw new Error('GitHub compare identity mismatch');
  const commits=(Array.isArray(data?.commits)?data.commits:[]).slice(-20).map(c=>'<li><code>'+escapeHTML(String(c?.sha||'').slice(0,12))+'</code> '+escapeHTML(safeText(c?.commit?.message,1000).split('\n')[0])+'</li>').join('');
  const ahead=Number(data?.ahead_by)||0,behind=Number(data?.behind_by)||0,total=Number(data?.total_commits)||0,status=escapeHTML(safeText(data?.status,50));
  return '<section><h2>GitHub Compare 详情</h2><p><strong>'+escapeHTML(t.owner+'/'+t.repo)+'</strong> · <code>'+escapeHTML(t.base)+'</code> … <code>'+escapeHTML(t.head)+'</code></p>'+
    '<p>'+status+' · '+total+' commits · ahead '+ahead+' · behind '+behind+'</p>'+
    (commits?'<h3>Recent commits</h3><ol>'+commits+'</ol>':'')+
    ((data.files||[]).length?'<h3>Changed files</h3><ul>'+fileList(data.files)+'</ul>':'')+'</section>';
}
async function githubEnrichment(service,target){
  const response=await service.internalFetch(apiUrl(target),{trusted:false,timeout:10000,maxBytes:2*1024*1024,headers:{'User-Agent':'quiet-river/1.0','Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
  if(response.status!==200){const e=new Error(response.status===403?'GitHub public API unavailable or rate-limited':'GitHub API HTTP '+response.status);e.status=response.status;throw e;}
  let data;try{data=JSON.parse(response.body.toString('utf8'));}catch{throw new Error('GitHub API returned invalid JSON');}
  return {html:target.kind==='commit'?renderCommit(data,target):renderCompare(data,target),rateRemaining:response.headers?.['x-ratelimit-remaining']??response.headers?.get?.('x-ratelimit-remaining')??null};
}

module.exports={githubDetailTarget,apiUrl,renderCommit,renderCompare,githubEnrichment};
