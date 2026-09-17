'use strict';
function editTags(container,initial,onSave,heading) {
  if(container.querySelector('.tag-editor'))return;
  const form=document.createElement('form');form.className='tag-editor';
  form.innerHTML='<strong></strong><p class="muted">添加或移除标签；保存后生效。多个筛选标签为“且”。</p><div class="tag-chips"></div><label>新标签<input name="newTag" maxlength="80" autocomplete="off" placeholder="输入标签后按添加"></label><div class="actions"><button type="button" data-add>添加标签</button><button type="submit" class="primary">保存</button><button type="button" data-cancel>取消</button></div><p class="error" role="alert" hidden></p>';
  form.querySelector('strong').textContent=heading;let values=[...(initial||[])];
  const input=form.elements.newTag,warning=form.querySelector('[role=alert]');
  function draw(){const chips=form.querySelector('.tag-chips');chips.replaceChildren();
    if(!values.length){const empty=document.createElement('span');empty.textContent='无标签';chips.append(empty);}
    for(const value of values){const b=document.createElement('button');b.type='button';b.textContent=value+' ×';b.setAttribute('aria-label','移除标签 '+value);b.onclick=()=>{values=values.filter(t=>t!==value);draw();};chips.append(b);}}
  function add(){const value=input.value.normalize('NFC').trim().replace(/\s+/gu,' ');if(!value)return;
    if([...value].length>80||values.length>=50){warning.textContent='最多50个标签，每个不超过80字';warning.hidden=false;return;}
    if(!values.includes(value))values.push(value);input.value='';warning.hidden=true;draw();}
  form.querySelector('[data-add]').onclick=add;
  input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();add();}};
  form.querySelector('[data-cancel]').onclick=()=>form.remove();
  form.onsubmit=async e=>{e.preventDefault();if(input.value.trim())add();
    const button=form.querySelector('[type=submit]');button.disabled=true;
    try{await onSave(values.slice());form.remove();}catch(error){warning.textContent=error.message;warning.hidden=false;button.disabled=false;}};
  container.append(form);draw();input.focus();
}
function drawArticleTags(container,tags){container.replaceChildren();
  for(const tag of tags||[]){const span=document.createElement('span');span.className='tag-chip';span.textContent=tag;container.append(span);}}
function syncReadCards(entryId,status){
  for(const card of document.querySelectorAll('[data-entry-id="'+entryId+'"]')){
    card.dataset.status=status;const dot=card.querySelector('.unread-dot');if(dot)dot.hidden=status!=='unread';
    const mark=card.querySelector('[data-action=mark]');if(mark)mark.textContent=status==='read'?'设为未读':'标记已读';
  }
}
async function trackArticleOpen(entry,target='original') {
  const current=document.querySelector('[data-entry-id="'+entry.id+'"]');
  const previous=current?.dataset.status||entry.status||'unread';
  syncReadCards(entry.id,'read');
  try{
    const eventId=crypto.randomUUID().replaceAll('-','');
    await api('/entries/'+entry.id+'/open',{eventId,target});entry.status='read';
    if(view==='unread')for(const card of document.querySelectorAll('[data-entry-id="'+entry.id+'"]')){card.remove();offset=Math.max(0,offset-1);total=Math.max(0,total-1);}
    await loadState();
  }catch(e){syncReadCards(entry.id,previous);error(new Error('文章已打开，但阅读状态未保存：'+e.message));}
}
async function renderBackend(){
  const data=await api('/backend');if(view!=='backend')return;
  const container=$('content');container.innerHTML='<div class="toolbar"><button data-backend="activity">活跃度</button><button data-backend="history">观看历史</button><button data-backend="faults">无法更新</button></div><section id="backend-body"></section>';
  const body=$('backend-body');
  function showActivity(){const a=data.activity;
    body.innerHTML='<article class="card"><h2>阅读活跃度 · 过去一年</h2><p class="muted"></p><div class="activity-scroll"><div class="activity-grid" role="group" aria-label="每日阅读活跃度"></div></div><div class="activity-legend">少 <span data-level="0"></span><span data-level="1"></span><span data-level="2"></span><span data-level="3"></span><span data-level="4"></span> 多</div><p class="activity-total"></p><p class="muted">按实际点开文章次数统计，不推断读完或停留时长；同一次请求重试不重复计数。历史从本功能启用后开始记录。</p></article>';
    body.querySelector('.muted').textContent='统计时区：'+a.timezone+'；点选日期可查看当天次数。';
    const grid=body.querySelector('.activity-grid');const offsetDay=(new Date(a.days[0].day+'T12:00:00Z').getUTCDay()+6)%7;
    for(let i=0;i<offsetDay;i++){const spacer=document.createElement('span');spacer.className='activity-spacer';grid.append(spacer);}
    for(const d of a.days){const b=document.createElement('button');b.className='activity-day';b.dataset.level=d.count===0?0:d.count<3?1:d.count<6?2:d.count<10?3:4;
      b.title=d.day+'：打开'+d.count+'次，'+d.articles+'篇文章';b.setAttribute('aria-label',b.title);b.onclick=()=>toast(b.title);grid.append(b);}
    body.querySelector('.activity-total').textContent=`共打开 ${a.opens} 次 · ${a.uniqueArticles} 篇文章 · 活跃 ${a.activeDays} 天`;
  }
  function showHistory(){body.innerHTML='<h2>观看历史</h2><p class="muted">只记录在本站点开的文章；同一文章再次打开会留下一条新记录。</p><div class="history-list"></div><button data-history-more hidden>加载更早记录</button>';
    const list=body.querySelector('.history-list'),more=body.querySelector('[data-history-more]');let cursor;
    function append(page){for(const item of page.items){const row=document.createElement('article');row.className='card history-row';row.dataset.entryId=item.entryId;row.dataset.status=item.status;
      row.innerHTML='<span class="unread-dot" role="img" aria-label="未读" title="未读"></span><div class="meta"></div><h3></h3><a target="_blank" rel="noopener noreferrer">再次打开</a>';
      row.querySelector('.unread-dot').hidden=item.status!=='unread';row.querySelector('.meta').textContent=date(item.openedAt)+' · '+item.source+' · '+(platforms[item.platform]||item.platform);
      row.querySelector('h3').textContent=item.title;const link=row.querySelector('a');
      if(item.url){link.href=item.url;link.onclick=()=>trackArticleOpen({id:item.entryId,status:item.status},'original');}else link.remove();list.append(row);}
      if(!page.items.length&&!list.children.length)list.textContent='还没有观看记录。点开一篇文章后，这里会开始记录。';cursor=page.nextCursor;more.hidden=!cursor;}
    append(data.history);more.onclick=async()=>{try{more.disabled=true;append(await api('/history?before='+cursor));}catch(e){error(e);}finally{more.disabled=false;}};
  }
  function showFaults(){body.innerHTML='<h2>无法更新的订阅</h2><p class="muted">根据现有更新检查结果整理，不额外扫描原网站。超时、缺授权与永久删除不是同一回事。</p>';
    if(!data.faults.length){body.insertAdjacentHTML('beforeend','<p>当前没有已记录的异常；这不代表尚未检查的来源已经通过。</p>');return;}
    for(const f of data.faults){const row=document.createElement('article');row.className='card';
      row.innerHTML='<h3></h3><p data-fault-status></p><p class="muted" data-fault-time></p><p data-fault-detail></p><div class="actions"><a target="_blank" rel="noopener noreferrer">博主主页</a><button>检查更新</button></div>';
      row.querySelector('h3').textContent=f.source+' · '+(platforms[f.platform]||f.platform||'');
      row.querySelector('[data-fault-status]').textContent=f.stale?'超过预期周期未成功更新':label(f.state);
      row.querySelector('[data-fault-time]').textContent='最近检查：'+date(f.lastCheck)+' · 最近成功：'+date(f.lastSuccess);
      row.querySelector('[data-fault-detail]').textContent=f.error||(!f.enabled?'尚缺通道配置或授权':'等待重新检查');
      const link=row.querySelector('a');if(f.homepage)link.href=f.homepage;else link.remove();
      row.querySelector('button').onclick=async()=>{source=f.sourceId;tag=[];platform='';await refresh();};body.append(row);}
  }
  container.querySelectorAll('[data-backend]').forEach(b=>b.onclick=()=>({activity:showActivity,history:showHistory,faults:showFaults}[b.dataset.backend])());
  showActivity();
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function readerButtonState(entry,button){
  const state=entry.archive_state||'NONE';
  if(entry.readerMode==='original'&&!['READY','QUEUED','IMPORTING','METADATA_NOTE'].includes(state)){
    button.textContent='\u6682\u65e0\u7ad9\u5185\u6b63\u6587';button.disabled=true;button.title='\u8be5\u6761\u76ee\u76ee\u524d\u53ea\u6709\u5143\u4fe1\u606f\uff0c\u8bf7\u76f4\u63a5\u6253\u5f00\u539f\u6587';return false;
  }
  button.disabled=false;
  button.textContent=entry.readerMode==='fetchable'?'\u5c1d\u8bd5\u7ad9\u5185\u9605\u8bfb':state==='READY'?'\u7ad9\u5185\u9605\u8bfb':state==='METADATA_NOTE'?'\u6574\u7bc7\u5907\u6ce8':state==='ERROR'?'\u9605\u8bfb\u5668\u5931\u8d25\uff0c\u6253\u5f00\u539f\u6587':entry.content_state==='PARTIAL'?'\u7ad9\u5185\u9605\u8bfb\uff08\u90e8\u5206\uff09':'\u7ad9\u5185\u9605\u8bfb';
  button.title=entry.content_state==='PARTIAL'?'\u5f53\u524d\u4fdd\u5b58\u7684\u662f\u90e8\u5206\u5185\u5bb9\uff1b\u9605\u8bfb\u5668\u4f1a\u4f18\u5148\u5c1d\u8bd5\u8865\u6b63\u6587':'';return true;
}
async function openReader(entry,button,tab){
  let result=await api('/entries/'+entry.id+'/archive',{});
  if(result.state==='ORIGINAL_ONLY'){
    if(tab)tab.location.replace(result.originalUrl||entry.url);else window.location.assign(result.originalUrl||entry.url);
    await trackArticleOpen(entry,'original');toast('\u7ad9\u5185\u9605\u8bfb\u51c6\u5907\u5931\u8d25\uff0c\u5df2\u6253\u5f00\u539f\u6587');return;
  }
  for(let i=0;i<15&&['IMPORTING','QUEUED'].includes(result.state);i++){
    button.textContent='\u51c6\u5907\u9605\u8bfb\u5668\u2026';await wait(800);result=await api('/entries/'+entry.id+'/archive');
  }
  if(result.state==='ERROR'||result.state==='NOT_CONFIGURED'||!result.path){
    if(tab)tab.location.replace(result.originalUrl||entry.url);else window.location.assign(result.originalUrl||entry.url);
    await trackArticleOpen(entry,'original');toast('\u7ad9\u5185\u9605\u8bfb\u51c6\u5907\u5931\u8d25\uff0c\u5df2\u6253\u5f00\u539f\u6587');return;
  }
  if(['IMPORTING','QUEUED'].includes(result.state))toast('\u5f52\u6863\u4ecd\u5728\u5904\u7406\uff0c\u5df2\u6253\u5f00\u9605\u8bfb\u5668\u7b49\u5f85\u9875\u9762');
  if(tab)tab.location.replace(result.path);else window.location.assign(result.path);
  await trackArticleOpen(entry,'reader');entry.archive_state=result.state;
}
function renderArticleCard(entry){
  const a=document.createElement('article');a.className='card article-card';a.dataset.entryId=entry.id;a.dataset.status=entry.status||'unread';
  const contentLabel=entry.content_state==='META'?'仅元信息':entry.content_state==='PARTIAL'?'部分内容':'已有内容';
  a.innerHTML='<span class="unread-dot" role="img" aria-label="未读" title="未读"></span><div class="meta"><span data-author></span><span data-platform></span><span data-time></span><span class="badge" data-content></span></div><h2><a class="article-title" data-original target="_blank" rel="noopener noreferrer"></a></h2><div class="article-tags tag-chips"></div><p class="summary"></p><div class="reason"></div><div class="actions"><a class="primary" data-original target="_blank" rel="noopener noreferrer">打开原文</a><button data-action="read">阅读器</button><button data-action="tags">编辑标签</button><button data-action="mark"></button><button data-action="like"></button><button data-action="dislike"></button></div>';
  a.querySelector('[data-author]').textContent=entry.source||entry.author||'未知博主';
  a.querySelector('[data-platform]').textContent=platforms[entry.platform]||entry.platform||'';
  a.querySelector('[data-time]').textContent=entry.published_at?date(entry.published_at):'发布时间未知';
  a.querySelector('[data-content]').textContent=contentLabel;
  a.querySelector('.article-title').textContent=entry.title;
  a.querySelector('.summary').textContent=(entry.summary||'').slice(0,230)+((entry.summary||'').length>230?'…':'');
  a.querySelector('.reason').textContent=(entry.reasons||[]).join('；');
  a.querySelector('.unread-dot').hidden=entry.status!=='unread';
  const tagBox=a.querySelector('.article-tags');drawArticleTags(tagBox,entry.tags||[]);
  a.querySelector('[data-action=tags]').onclick=()=>editTags(a,entry.tags||[],async tags=>{
    const result=await api('/entries/'+entry.id+'/tags',{tags});entry.tags=result.tags;drawArticleTags(tagBox,result.tags);await loadState();if(['latest','unread','recommend'].includes(view))await renderList(false);toast('文章标签已保存');
  },'编辑文章标签（只影响这篇文章）');
  for(const link of a.querySelectorAll('[data-original]')){
    try{const url=new URL(entry.url);if(!['http:','https:'].includes(url.protocol))throw new Error();link.href=url.href;}
    catch{link.removeAttribute('href');link.removeAttribute('target');continue;}
    link.onclick=()=>{void trackArticleOpen(entry,'original');};
    link.onauxclick=e=>{if(e.button===1)void trackArticleOpen(entry,'original');};
  }
  a.addEventListener('click',e=>{
    if(e.target.closest('a,button,input,textarea,select,label,form,.tag-chips')||window.getSelection()?.toString())return;
    a.querySelector('.actions a[data-original][href]')?.click();
  });
  const read=a.querySelector('[data-action=read]');readerButtonState(entry,read);read.onclick=async()=>{
    if(read.disabled)return;const tab=window.open('about:blank','_blank');if(tab)tab.opener=null;read.disabled=true;const before=read.textContent;
    try{await openReader(entry,read,tab);}
    catch(e){
      try{if(tab)tab.location.replace(entry.url);else window.location.assign(entry.url);await trackArticleOpen(entry,'original');toast('\u9605\u8bfb\u5668\u6682\u4e0d\u53ef\u7528\uff0c\u5df2\u6253\u5f00\u539f\u6587');}
      catch{if(tab)tab.close();error(e);}
    }
    finally{read.textContent=before;readerButtonState(entry,read);}
  };
  const mark=a.querySelector('[data-action=mark]');
  mark.textContent=entry.status==='read'?'设为未读':'标记已读';
  mark.onclick=async()=>{mark.disabled=true;const status=a.dataset.status==='read'?'unread':'read';
    try{await api('/entries/'+entry.id+'/read',{status});entry.status=status;syncReadCards(entry.id,status);
      if(view==='unread'&&status==='read'){a.remove();offset=Math.max(0,offset-1);total=Math.max(0,total-1);}
    }catch(e){error(e);}finally{mark.disabled=false;}
  };
  const drawFeedback=()=>{a.querySelector('[data-action=like]').textContent=entry.feedback===1?'已感兴趣':'感兴趣';a.querySelector('[data-action=dislike]').textContent=entry.feedback===-1?'已降权':'不感兴趣';};
  for(const [action,value] of [['like',1],['dislike',-1]])a.querySelector('[data-action='+action+']').onclick=async()=>{
    try{const next=entry.feedback===value?0:value;await api('/entries/'+entry.id+'/feedback',{value:next});entry.feedback=next;drawFeedback();}catch(e){error(e);}
  };
  drawFeedback();return a;
}
