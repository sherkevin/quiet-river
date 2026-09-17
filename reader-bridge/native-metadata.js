'use strict';
const { request } = require('./network');
const { stripHTML, escapeHTML } = require('./core');

// Fixed anonymous author-list API from the project's existing adapter.
// No credentials, browser, article-body requests, or user-supplied API endpoints.
async function fetchNativeMetadata(channel, send=request) {
  if(channel.native_adapter!=='juejin'||!/^\d+$/.test(channel.author_id||'')) {
    throw new Error('not configured: supported native author identity required');
  }
  const payload=Buffer.from(JSON.stringify({user_id:channel.author_id,sort_type:2,cursor:'0',limit:20}));
  const r=await send('https://api.juejin.cn/content_api/v1/article/query_list',{
    method:'POST',headers:{'Content-Type':'application/json'},body:payload,
    timeout:25000,maxBytes:4*1024*1024
  });
  if(r.status!==200){const e=new Error('native metadata request failed');e.status=r.status;throw e;}
  const data=JSON.parse(r.body.toString('utf8'));
  if(data.err_no!==0||!Array.isArray(data.data))throw new Error('native metadata response not accepted');
  const items=data.data.map(row=>{
    const a=row.article_info||row;
    const owner=row.author_user_info?.user_id||a.user_id;
    if(owner&&String(owner)!==channel.author_id)throw new Error('native author mismatch');
    if(!/^\d+$/.test(String(a.article_id)))throw new Error('native article identity missing');
    const summary=stripHTML(a.brief_content||'').slice(0,1200);
    return {guid:String(a.article_id),link:'https://juejin.cn/post/'+a.article_id,
      title:stripHTML(a.title||'')||'(无标题)',published:Number(a.ctime)>0?Number(a.ctime)*1000:null,
      summary,content:summary?'<p>'+escapeHTML(summary)+'</p>':'',content_state:summary?'PARTIAL':'META'};
  });
  return {items,window:'latest20',moreAvailable:!!data.has_more};
}
module.exports={fetchNativeMetadata};
