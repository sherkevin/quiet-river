'use strict';
function renderPager(page,total,onPage,pageSize=30){
  const p=document.getElementById('pager');p.replaceChildren();const pages=Math.max(1,Math.ceil(total/pageSize));
  if(total<=pageSize){p.hidden=true;return;}p.hidden=false;
  const button=(text,target,disabled=false,current=false)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.disabled=disabled;if(current)b.setAttribute('aria-current','page');b.onclick=()=>{if(!disabled&&target!==page)onPage(target);};p.append(b);};
  const dots=()=>{const span=document.createElement('span');span.className='pagination-dots';span.textContent='…';p.append(span);};
  button('上一页',page-1,page<=0);const start=Math.max(0,page-2),end=Math.min(pages-1,page+2);
  if(start>0){button('1',0);if(start>1)dots();}for(let i=start;i<=end;i++)button(String(i+1),i,false,i===page);
  if(end<pages-1){if(end<pages-2)dots();button(String(pages),pages-1);}
  const info=document.createElement('span');info.className='pagination-info';info.textContent='第 '+(page+1)+' / '+pages+' 页 · 共 '+total+' 条';p.append(info);button('下一页',page+1,page>=pages-1);
}
function hidePager(){const p=document.getElementById('pager');p.replaceChildren();p.hidden=true;}
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
function drawQuickAddTags(container,tags,onAdd,ariaLabel='添加标签'){
  drawArticleTags(container,tags);
  const plus=document.createElement('button');plus.type='button';plus.className='tag-add';plus.textContent='+';
  plus.setAttribute('aria-label',ariaLabel);plus.title=ariaLabel;
  plus.onclick=()=>{
    if(container.querySelector('.tag-quick-form'))return;
    plus.hidden=true;
    const form=document.createElement('form');form.className='tag-quick-form';
    form.innerHTML='<input name="tag" maxlength="80" autocomplete="off" placeholder="新 tag"><button type="submit">添加</button><button type="button" data-cancel aria-label="取消添加标签">×</button><span class="error" role="alert" hidden></span>';
    const input=form.elements.tag,warning=form.querySelector('[role=alert]');
    form.querySelector('[data-cancel]').onclick=()=>{form.remove();plus.hidden=false;};
    form.onsubmit=async e=>{e.preventDefault();const value=input.value.normalize('NFC').trim().replace(/\s+/gu,' ');
      if(!value||(tags||[]).includes(value)){form.remove();plus.hidden=false;return;}
      const submit=form.querySelector('[type=submit]');submit.disabled=true;
      try{await onAdd(value);}catch(error){warning.textContent=error.message;warning.hidden=false;submit.disabled=false;}};
    container.append(form);input.focus();
  };
  container.append(plus);
}
const SAFE_ARTICLE_TAGS=new Set(['p','br','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','pre','code','strong','b','em','i','del','s','u','sup','sub','table','thead','tbody','tfoot','tr','th','td','figure','figcaption','hr','a','img','details','summary','mark','kbd']);
const DROP_ARTICLE_TAGS=new Set(['script','style','iframe','object','embed','form','input','textarea','button','select','option','template','meta','link','base','noscript']);
function safeArticleURL(value,base,image=false){
  if(image&&/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i.test(String(value||'')))return String(value);
  try{const u=new URL(value,base);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}
}
function renderSafeArticleHTML(container,html,base){
  container.replaceChildren();const parsed=new DOMParser().parseFromString(String(html||''),'text/html'),budget={n:0,max:20000};
  const copy=node=>{
    if(++budget.n>budget.max)return null;if(node.nodeType===3)return document.createTextNode(node.nodeValue||'');if(node.nodeType!==1)return null;
    const tag=node.localName.toLowerCase();if(DROP_ARTICLE_TAGS.has(tag))return null;
    if(!SAFE_ARTICLE_TAGS.has(tag)){const frag=document.createDocumentFragment();for(const child of node.childNodes){const cloned=copy(child);if(cloned)frag.append(cloned);}return frag;}
    const el=document.createElement(tag);
    if(tag==='a'){const href=safeArticleURL(node.getAttribute('href'),base);if(href){el.href=href;el.target='_blank';el.rel='noopener noreferrer';el.referrerPolicy='no-referrer';}}
    if(tag==='img'){const src=safeArticleURL(node.getAttribute('src'),base,true);if(src){el.src=src;el.loading='lazy';el.decoding='async';el.referrerPolicy='no-referrer';}el.alt=String(node.getAttribute('alt')||'').slice(0,500);if(node.getAttribute('title'))el.title=String(node.getAttribute('title')).slice(0,500);}
    if(['td','th'].includes(tag))for(const name of ['colspan','rowspan']){const n=Math.max(1,Math.min(12,Number(node.getAttribute(name))||1));if(n>1)el.setAttribute(name,String(n));}
    if(tag==='ol'&&node.hasAttribute('start')){const n=Number(node.getAttribute('start'));if(Number.isInteger(n)&&Math.abs(n)<100000)el.setAttribute('start',String(n));}
    for(const child of node.childNodes){const cloned=copy(child);if(cloned)el.append(cloned);}return el;
  };
  for(const node of parsed.body.childNodes){const cloned=copy(node);if(cloned)container.append(cloned);}
  if(budget.n>budget.max){const note=document.createElement('p');note.className='muted';note.textContent='正文节点过多，已在安全上限处停止渲染。';container.append(note);}
}
function textNodeSequence(root){
  const walker=(root.ownerDocument||document).createTreeWalker(root,NodeFilter.SHOW_TEXT,null),nodes=[];let text='',node;
  while((node=walker.nextNode())){nodes.push({node,start:text.length,end:text.length+(node.textContent?.length||0)});text+=node.textContent||'';}
  return {text,nodes};
}
function canonicalReaderText(html){
  const inert=document.implementation.createHTMLDocument(''),holder=inert.createElement('div');holder.innerHTML=String(html||'');return textNodeSequence(holder).text;
}
function uniqueQuoteOffset(text,quote){
  if(!quote)return {count:0,start:-1,end:-1};let count=0,start=-1,from=0,at;
  while((at=text.indexOf(quote,from))!==-1){count++;if(start<0)start=at;if(count>1)break;from=at+1;}
  return {count,start,end:start<0?-1:start+quote.length};
}
function removeNativeHighlightMarks(root){
  for(const mark of [...root.querySelectorAll('mark[data-native-highlight]')]){const parent=mark.parentNode;if(!parent)continue;while(mark.firstChild)parent.insertBefore(mark.firstChild,mark);mark.remove();}
  root.normalize();
}
function wrapNativeTextRange(root,start,end,highlight){
  const segments=textNodeSequence(root).nodes.filter(x=>x.start<end&&x.end>start);
  for(const segment of segments){
    let node=segment.node,localStart=Math.max(0,start-segment.start),localEnd=Math.min(segment.end-segment.start,end-segment.start);
    if(localStart>0){node=node.splitText(localStart);localEnd-=localStart;}
    if(localEnd<node.length)node.splitText(localEnd);
    const mark=document.createElement('mark');mark.dataset.nativeHighlight='1';mark.dataset.highlightId=highlight.id;mark.dataset.color=highlight.color||'yellow';mark.title=highlight.note||'已高亮';
    node.parentNode?.insertBefore(mark,node);mark.append(node);
  }
}
function renderNativeHighlights(shell,body,detail){
  removeNativeHighlightMarks(body);const list=shell.querySelector('[data-native-highlight-list]'),count=shell.querySelector('[data-native-highlight-count]'),highlights=detail.highlights||[];list.replaceChildren();count.textContent=highlights.length?highlights.length+' 条':'暂无高亮';
  const nativeText=textNodeSequence(body).text;
  for(const h of highlights){
    const match=typeof h.text==='string'&&h.text?uniqueQuoteOffset(nativeText,h.text):{count:0,start:-1,end:-1};const mapped=match.count===1;
    if(mapped)wrapNativeTextRange(body,match.start,match.end,h);
    const card=document.createElement('article');card.className='native-highlight-item';card.dataset.highlightCard=h.id;
    const quote=document.createElement('blockquote');quote.textContent=h.text||'（高亮文本不可用）';card.append(quote);
    const state=document.createElement('p');state.className='muted';state.textContent=mapped?'已在当前站内正文中定位':'已保存在 Karakeep；当前站内正文无法唯一定位，因此未强行回画';card.append(state);
    const editor=document.createElement('div');editor.className='native-highlight-editor-grid';
    const colorLabel=document.createElement('label');colorLabel.textContent='颜色';const color=document.createElement('select');color.dataset.highlightColor=h.id;
    for(const [value,label] of [['yellow','黄色'],['green','绿色'],['blue','蓝色'],['red','红色']]){const option=document.createElement('option');option.value=value;option.textContent=label;option.selected=(h.color||'yellow')===value;color.append(option);}colorLabel.append(color);
    const noteLabel=document.createElement('label');noteLabel.textContent='段落批注';const note=document.createElement('textarea');note.rows=3;note.maxLength=10000;note.value=h.note||'';note.placeholder='给这段高亮添加批注';noteLabel.append(note);editor.append(colorLabel,noteLabel);card.append(editor);
    const actions=document.createElement('div');actions.className='actions';const save=document.createElement('button');save.textContent='保存批注';const del=document.createElement('button');del.textContent='删除高亮';actions.append(save,del);card.append(actions);
    save.onclick=async()=>{save.disabled=true;try{const updated=await api('/entries/'+detail.id+'/highlights/'+encodeURIComponent(h.id),{color:color.value,note:note.value||null});Object.assign(h,updated);renderNativeHighlights(shell,body,detail);toast('划线批注已保存');}catch(e){error(e);}finally{save.disabled=false;}};
    del.onclick=async()=>{if(!confirm('删除这条高亮及其段落批注？'))return;del.disabled=true;try{await api('/entries/'+detail.id+'/highlights/'+encodeURIComponent(h.id)+'/delete',{});detail.highlights=highlights.filter(x=>x.id!==h.id);renderNativeHighlights(shell,body,detail);toast('高亮已删除');}catch(e){error(e);}finally{del.disabled=false;}};
    list.append(card);
  }
  for(const mark of body.querySelectorAll('mark[data-native-highlight]'))mark.onclick=()=>shell.querySelector('[data-highlight-card="'+CSS.escape(mark.dataset.highlightId)+'"]')?.scrollIntoView({behavior:'smooth',block:'center'});
}
function setupNativeHighlightComposer(shell,body,detail){
  const panel=shell.querySelector('[data-native-highlight-composer]'),hint=shell.querySelector('[data-native-highlight-hint]'),quoteBox=shell.querySelector('[data-native-highlight-quote]'),note=shell.querySelector('[data-native-highlight-note]'),color=shell.querySelector('[data-native-highlight-color]'),save=shell.querySelector('[data-native-highlight-save]'),cancel=shell.querySelector('[data-native-highlight-cancel]'),status=shell.querySelector('[data-native-highlight-status]');let pendingQuote='';
  if(detail.highlightUnavailable){hint.textContent='暂时无法读取 Karakeep 高亮，为避免错写已关闭站内划线；可使用右上角 Karakeep 阅读器。';return;}
  if(!detail.highlightConfigured){hint.textContent='Karakeep 高亮服务尚未配置；可继续使用文章笔记。';return;}
  if(!detail.highlightCanCreate){hint.textContent=detail.contentState==='META'?'当前只有元信息，不能创建划线；不会为了批注从 ECS 绕过平台获取正文。':'当前文章暂不支持站内划线。';return;}
  const close=()=>{pendingQuote='';panel.hidden=true;quoteBox.textContent='';note.value='';status.textContent='';};
  cancel.onclick=()=>{close();window.getSelection()?.removeAllRanges();};
  const capture=()=>{const sel=window.getSelection();if(!sel||sel.isCollapsed||!sel.rangeCount)return;const range=sel.getRangeAt(0);if(!body.contains(range.commonAncestorContainer))return;const text=sel.toString();if(!text.trim())return;if(text.length>10000){toast('单条高亮最多 10000 个字符');return;}pendingQuote=text;quoteBox.textContent=text;status.textContent='保存前会与 Karakeep 归档正文做唯一精确对齐';panel.hidden=false;};
  body.addEventListener('pointerup',()=>setTimeout(capture,0));body.addEventListener('keyup',()=>setTimeout(capture,0));
  save.onclick=async()=>{if(!pendingQuote)return;save.disabled=true;status.textContent='正在准备归档并校验位置…';
    try{
      const ctx=await api('/entries/'+detail.id+'/highlights/context',{}),canonical=canonicalReaderText(ctx.htmlContent),match=uniqueQuoteOffset(canonical,pendingQuote);
      if(match.count!==1){status.textContent=match.count===0?'选中文字与归档正文不完全一致，未保存；可调整选区或使用 Karakeep 阅读器。':'选中文字在归档正文中出现多次，位置有歧义，未保存；请扩大选区。';return;}
      const created=await api('/entries/'+detail.id+'/highlights',{contextHash:ctx.contextHash,startOffset:match.start,endOffset:match.end,text:pendingQuote,note:note.value||null,color:color.value});
      detail.highlights=[...(detail.highlights||[]),created];close();window.getSelection()?.removeAllRanges();renderNativeHighlights(shell,body,detail);toast('高亮已保存到 Karakeep');
    }catch(e){status.textContent='高亮未保存';error(e);}finally{save.disabled=false;}
  };
}
function setupNativeEnrichment(shell,container,detail){
  const button=shell.querySelector('[data-native-enrich]'),initial=detail.bodyEnrichment;
  if(!initial?.eligible||detail.contentState==='TEXT'){button.remove();return;}
  let polling=false,stopped=false;
  const paint=state=>{
    detail.bodyEnrichment=state;const online=state.collector?.online;
    if(state.state==='RUNNING'){button.disabled=true;button.textContent='Shervin 正在读取正文…';}
    else if(state.state==='QUEUED'){const retry=Number(state.next_attempt)>Date.now()&&!!state.error;button.disabled=!retry;button.textContent=retry?'正文受限 · 点击立即重试':online?'正文已排队…':'正文已排队 · Shervin 离线';}
    else if(state.state==='AUTH_REQUIRED'){button.disabled=true;button.textContent='Shervin 需要重新登录';}
    else{button.disabled=false;button.textContent=online?'让 Shervin 补正文':'Shervin 离线 · 先排队补正文';}
    button.title=state.error||(!online?'任务会保留，Shervin 再次运行 collector 后继续':'正文凭证只在 Shervin 浏览器中使用');
  };
  const reload=async state=>{const next=await api('/entries/'+detail.id);let hs={highlights:detail.highlights||[],configured:detail.highlightConfigured,canCreate:false};try{hs=await api('/entries/'+detail.id+'/highlights');}catch{}next.highlights=hs.highlights||[];next.highlightConfigured=hs.configured!==false;next.highlightCanCreate=!!hs.canCreate;next.bodyEnrichment=state;drawNativeArticle(container,next);toast('Shervin 已补充站内正文');};
  const poll=async()=>{if(polling||stopped)return;polling=true;try{for(let i=0;i<60&&!stopped;i++){await wait(3000);const state=await api('/entries/'+detail.id+'/enrichment');paint(state);if(state.state==='DONE'){stopped=true;await reload(state);break;}if(['AUTH_REQUIRED','UNAVAILABLE','FAILED'].includes(state.state)){stopped=true;break;}}}catch(e){error(e);}finally{polling=false;}};
  paint(initial);if(['QUEUED','RUNNING'].includes(initial.state))void poll();
  button.onclick=async()=>{button.disabled=true;try{const state=await api('/entries/'+detail.id+'/enrichment',{});paint(state);void poll();toast(state.collector?.online?'正文任务已提交给 Shervin':'正文任务已排队；Shervin 上线后继续');}catch(e){paint(detail.bodyEnrichment);error(e);}};
}
function setupNativeTranscript(shell,container,detail){
  const button=shell.querySelector('[data-native-transcript]'),initial=detail.mediaTranscript||detail.youtubeTranscript,isYoutube=detail.platform==='youtube',isBilibili=detail.platform==='bilibili',isPodcast=detail.platform==='podcast';
  if((!isYoutube&&!isBilibili&&!isPodcast)||!initial?.eligible){button.remove();return;}
  let polling=false,stopped=false;
  const labels=isPodcast?{
    done:'已完成播客转录',running:'Shervin 本地转录中…',queued:'播客转录已排队…',offline:'播客已排队 · Shervin 离线',retry:'转录受限 · 点击立即重试',ready:'本地转录播客',readyOffline:'Shervin 离线 · 先排队转录',toast:'播客转录已加入站内正文',
    title:'使用 Shervin 本地 faster-whisper；音频不会上传第三方，临时音频完成后删除。'
  }:isBilibili?{
    done:'已补充 B站字幕',running:'Shervin 正在读取 B站字幕…',queued:'B站字幕已排队…',offline:'B站字幕已排队 · Shervin 离线',retry:'B站字幕受限 · 点击立即重试',ready:'补充 B站字幕',readyOffline:'Shervin 离线 · 先排队 B站字幕',toast:'B站字幕已加入站内正文',
    title:'使用 Shervin OpenCLI 读取当前已知 BV 视频的字幕；失败只影响这条字幕任务，不影响作者发现。'
  }:{
    done:'已补充视频字幕',running:'Shervin 正在读取字幕…',queued:'字幕已排队…',offline:'字幕已排队 · Shervin 离线',retry:'字幕受限 · 点击立即重试',ready:'补充视频字幕',readyOffline:'Shervin 离线 · 先排队字幕',toast:'视频字幕已加入站内正文',
    title:'优先使用 yt-dlp；失败后按既定链路回退到 OpenCLI。不会下载视频。'
  };
  const paint=state=>{
    detail.mediaTranscript=state;if(isYoutube)detail.youtubeTranscript=state;const online=state.collector?.online;
    if(state.state==='DONE'){button.disabled=true;button.textContent=labels.done;button.title='转录已经写入站内正文';}
    else if(state.state==='RUNNING'){button.disabled=true;button.textContent=labels.running;}
    else if(state.state==='QUEUED'){const retry=Number(state.next_attempt)>Date.now()&&!!state.error;button.disabled=!retry;button.textContent=retry?labels.retry:online?labels.queued:labels.offline;button.title=state.error||'任务会保留，Shervin 上线后继续';}
    else {button.disabled=false;button.textContent=online?labels.ready:labels.readyOffline;button.title=labels.title;}
  };
  const reload=async state=>{
    const next=await api('/entries/'+detail.id);let hs={highlights:detail.highlights||[],configured:detail.highlightConfigured,canCreate:false};
    try{hs=await api('/entries/'+detail.id+'/highlights');}catch{}
    next.highlights=hs.highlights||[];next.highlightConfigured=hs.configured!==false;next.highlightCanCreate=!!hs.canCreate;next.bodyEnrichment=detail.bodyEnrichment;next.mediaTranscript=state;if(isYoutube)next.youtubeTranscript=state;drawNativeArticle(container,next);toast(labels.toast);
  };
  const poll=async()=>{
    if(polling||stopped)return;polling=true;
    try{const maxPolls=isPodcast?1200:120;for(let i=0;i<maxPolls&&!stopped;i++){await wait(3000);const state=await api('/entries/'+detail.id+'/transcript');paint(state);if(state.state==='DONE'){stopped=true;await reload(state);break;}if(['UNAVAILABLE','FAILED'].includes(state.state)){stopped=true;break;}}}
    catch(e){error(e);}finally{polling=false;}
  };
  paint(initial);if(['QUEUED','RUNNING'].includes(initial.state))void poll();
  button.onclick=async()=>{button.disabled=true;try{const state=await api('/entries/'+detail.id+'/transcript',{});paint(state);void poll();toast(state.collector?.online?(isPodcast?'本地播客转录任务已提交给 Shervin':isBilibili?'B站字幕任务已提交给 Shervin':'字幕任务已提交给 Shervin'):'转录任务已排队；Shervin 上线后继续');}catch(e){paint(detail.mediaTranscript);error(e);}};
}
async function recordNativeArticleOpen(detail){
  const eventId=crypto.randomUUID().replaceAll('-','');await api('/entries/'+detail.id+'/open',{eventId,target:'reader'});detail.status='read';
  const mark=document.querySelector('[data-native-mark]');if(mark)mark.textContent='设为未读';
}
function drawNativeArticle(container,detail){
  $('title').textContent='阅读';$('subtitle').textContent='站内正文 · 原文仅作为明确的外部入口';
  container.innerHTML='<article class="native-article"><div class="native-article-top"><button data-native-back>← 返回</button><div class="native-article-actions"><a data-native-original target="_blank" rel="noopener noreferrer">查看原文 ↗</a><button data-native-prepare>尝试补全文</button><button data-native-enrich>让 Shervin 补正文</button><button data-native-transcript>补充媒体转录</button><button data-native-annotate>Karakeep 阅读器 ↗</button></div></div><div class="native-article-meta"><a data-native-author></a><span data-native-platform></span><span data-native-time></span><span class="badge" data-native-state></span></div><h1 data-native-title></h1><div class="native-article-tags tag-chips"></div><div class="native-article-controls"><button data-native-tags>编辑标签</button><button data-native-mark></button><button data-native-like></button><button data-native-dislike></button><a href="/desk/?view=notes">我的笔记</a></div><p class="native-article-warning" data-native-warning hidden></p><p class="native-highlight-hint muted" data-native-highlight-hint>选中正文即可添加站内高亮或段落批注；只有能与 Karakeep 归档正文唯一精确对齐时才会保存。</p><section class="native-highlight-composer" data-native-highlight-composer hidden><div class="native-highlight-head"><strong>新高亮</strong><button data-native-highlight-cancel>取消</button></div><blockquote data-native-highlight-quote></blockquote><div class="native-highlight-editor-grid"><label>颜色<select data-native-highlight-color><option value="yellow">黄色</option><option value="green">绿色</option><option value="blue">蓝色</option><option value="red">红色</option></select></label><label>段落批注<textarea data-native-highlight-note rows="3" maxlength="10000" placeholder="可选：给这段高亮添加批注"></textarea></label></div><div class="actions"><button class="primary" data-native-highlight-save>保存高亮</button><span class="muted" data-native-highlight-status></span></div></section><div class="native-article-body"></div><section class="native-highlights"><div class="native-highlight-head"><h2>划线批注</h2><span class="muted" data-native-highlight-count></span></div><div data-native-highlight-list></div></section><section class="native-article-note"><div class="native-article-note-head"><h2>我的笔记</h2><span class="muted" data-native-note-status></span></div><textarea data-native-note rows="8" maxlength="50000" placeholder="记录这篇文章的思考、结论或待办……"></textarea><div class="actions"><button class="primary" data-native-note-save>保存笔记</button></div></section></article>';
  const shell=container.querySelector('.native-article');shell.querySelector('[data-native-title]').textContent=detail.title;
  const author=shell.querySelector('[data-native-author]');author.textContent=detail.source||detail.author||'未知博主';author.href='/desk/?view=sources&source='+encodeURIComponent(detail.sourceId);
  shell.querySelector('[data-native-platform]').textContent=platforms[detail.platform]||detail.platform||'';shell.querySelector('[data-native-time]').textContent=detail.published_at?date(detail.published_at):'发布时间未知';
  shell.querySelector('[data-native-state]').textContent=detail.contentState==='TEXT'?'已有正文':detail.contentState==='PARTIAL'?'部分内容':'仅元信息';
  shell.querySelector('[data-native-back]').onclick=()=>{if(history.length>1)history.back();else location.assign('/desk/');};
  const original=shell.querySelector('[data-native-original]');if(detail.url){original.href=detail.url;original.onclick=()=>{const eventId=crypto.randomUUID().replaceAll('-','');void api('/entries/'+detail.id+'/open',{eventId,target:'original'});};}else original.remove();
  const tagBox=shell.querySelector('.native-article-tags'),drawTags=()=>drawQuickAddTags(tagBox,detail.tags||[],async value=>{const result=await api('/entries/'+detail.id+'/tags',{tags:[...(detail.tags||[]),value]});detail.tags=result.tags;drawTags();toast('已添加文章标签 '+value);},'给这篇文章添加标签');drawTags();
  shell.querySelector('[data-native-tags]').onclick=()=>editTags(shell,detail.tags||[],async tags=>{const result=await api('/entries/'+detail.id+'/tags',{tags});detail.tags=result.tags;drawTags();toast('文章标签已保存');},'编辑文章标签（只影响这篇文章）');
  const mark=shell.querySelector('[data-native-mark]');mark.textContent=detail.status==='read'?'设为未读':'标记已读';mark.onclick=async()=>{const status=detail.status==='read'?'unread':'read';mark.disabled=true;try{await api('/entries/'+detail.id+'/read',{status});detail.status=status;mark.textContent=status==='read'?'设为未读':'标记已读';}catch(e){error(e);}finally{mark.disabled=false;}};
  const drawFeedback=()=>{shell.querySelector('[data-native-like]').textContent=detail.feedback===1?'已感兴趣':'感兴趣';shell.querySelector('[data-native-dislike]').textContent=detail.feedback===-1?'已降权':'不感兴趣';};for(const [key,value] of [['like',1],['dislike',-1]])shell.querySelector('[data-native-'+key+']').onclick=async()=>{const next=detail.feedback===value?0:value;await api('/entries/'+detail.id+'/feedback',{value:next});detail.feedback=next;drawFeedback();};drawFeedback();
  const prepare=shell.querySelector('[data-native-prepare]');if(!detail.canFetchFullText)prepare.remove();else{const prepareLabel=detail.prepareKind==='github-detail'?'获取 GitHub 详情':detail.prepareKind==='bilibili-detail'?'获取视频详情':'尝试补全文';prepare.textContent=prepareLabel;prepare.onclick=async()=>{prepare.disabled=true;prepare.textContent=detail.prepareKind==='github-detail'?'正在获取 GitHub 详情…':detail.prepareKind==='bilibili-detail'?'正在获取视频详情…':'正在补全文…';try{const next=await api('/entries/'+detail.id+'/prepare',{});next.highlights=detail.highlights||[];next.highlightConfigured=detail.highlightConfigured;next.highlightCanCreate=next.contentState!=='META'&&detail.highlightConfigured;next.bodyEnrichment=detail.bodyEnrichment;next.mediaTranscript=detail.mediaTranscript;next.youtubeTranscript=detail.youtubeTranscript;drawNativeArticle(container,next);toast(next.prepareImproved?'已补充更完整内容':'没有取得比当前更完整的内容');}catch(e){error(e);prepare.disabled=false;prepare.textContent=prepareLabel;}};}
  setupNativeEnrichment(shell,container,detail);setupNativeTranscript(shell,container,detail);
  const annotate=shell.querySelector('[data-native-annotate]');if(detail.readerMode==='original'&&detail.contentState==='META'){annotate.disabled=true;annotate.textContent='暂无 Karakeep 正文';}else annotate.onclick=async()=>{const tab=window.open('about:blank','_blank');if(tab)tab.opener=null;annotate.disabled=true;try{await openReader({id:detail.id,url:detail.url,content_state:detail.contentState,archive_state:detail.archiveState,readerMode:detail.readerMode,status:detail.status},annotate,tab);}catch(e){if(tab)tab.close();error(e);}finally{annotate.disabled=false;annotate.textContent='Karakeep 阅读器 ↗';}};
  const warning=shell.querySelector('[data-native-warning]'),messages=[];if(detail.contentState==='PARTIAL')messages.push('当前保存的是部分内容，可继续阅读，也可以尝试补全文或查看原文。');if(detail.contentState==='META')messages.push('当前只有元信息；受限平台不会由 ECS 绕过平台获取正文。');if(detail.contentUnavailable)messages.push('正文主库暂不可用，当前仅展示本地摘要。');if(detail.contentTruncated)messages.push('正文超过站内单次渲染安全上限，当前展示前部内容。');if(messages.length){warning.hidden=false;warning.textContent=messages.join(' ');}
  const body=shell.querySelector('.native-article-body');if(detail.content&&detail.contentTextLength){renderSafeArticleHTML(body,detail.content,detail.url||detail.sourceUrl||location.href);}else body.innerHTML='<div class="empty"><h2>暂时没有站内正文</h2><p>文章仍保留在 Quiet River；可使用上方“查看原文”进入原平台。</p></div>';renderNativeHighlights(shell,body,detail);setupNativeHighlightComposer(shell,body,detail);
  const noteInput=shell.querySelector('[data-native-note]'),noteSave=shell.querySelector('[data-native-note-save]'),noteStatus=shell.querySelector('[data-native-note-status]');
  noteInput.value=detail.note||'';
  if(!detail.notesConfigured){noteInput.disabled=true;noteSave.disabled=true;noteStatus.textContent='笔记服务尚未配置';}
  else if(detail.noteUnavailable){noteInput.disabled=true;noteSave.disabled=true;noteStatus.textContent='暂时无法读取已有笔记，为避免覆盖已禁止编辑';}
  else{
    noteStatus.textContent=detail.noteBookmarkId?'已从 Karakeep 载入':'尚未创建笔记对象';
    noteInput.oninput=()=>{noteStatus.textContent='有未保存修改';};
    const saveNote=async()=>{noteSave.disabled=true;noteStatus.textContent='正在保存…';try{const saved=await api('/entries/'+detail.id+'/note',{note:noteInput.value});detail.note=saved.note;detail.noteBookmarkId=saved.bookmarkId;noteInput.value=saved.note;noteStatus.textContent='已保存到 Karakeep';toast('文章笔记已保存');}catch(e){noteStatus.textContent='保存失败';error(e);}finally{noteSave.disabled=false;}};
    noteSave.onclick=saveNote;noteInput.onkeydown=e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();void saveNote();}};
  }
}
async function renderArticleDetail(id){
  hidePager();const container=$('content');container.innerHTML='<div class="empty">正在读取站内正文…</div>';const detail=await api('/entries/'+id);let highlightState;
  try{highlightState=await api('/entries/'+id+'/highlights');detail.highlights=highlightState.highlights||[];detail.highlightConfigured=highlightState.configured!==false;detail.highlightCanCreate=!!highlightState.canCreate;}
  catch(e){detail.highlights=[];detail.highlightConfigured=!!detail.notesConfigured;detail.highlightCanCreate=false;detail.highlightUnavailable=true;}
  try{detail.bodyEnrichment=await api('/entries/'+id+'/enrichment');}catch{detail.bodyEnrichment={eligible:false,state:'UNAVAILABLE'};}
  if(['youtube','bilibili','podcast'].includes(detail.platform)){try{detail.mediaTranscript=await api('/entries/'+id+'/transcript');}catch{detail.mediaTranscript={eligible:false,state:'UNAVAILABLE'};}}else detail.mediaTranscript={eligible:false,state:'UNAVAILABLE'};detail.youtubeTranscript=detail.platform==='youtube'?detail.mediaTranscript:{eligible:false,state:'UNAVAILABLE'};
  if(view!=='article'||articleId!==id)return;drawNativeArticle(container,detail);recordNativeArticleOpen(detail).catch(e=>error(new Error('文章已打开，但阅读状态未保存：'+e.message)));
}
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
function annotationButtonState(entry,button){const enabled=readerButtonState(entry,button);button.textContent=enabled?'Karakeep 批注':'暂无可批注正文';return enabled;}
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
  a.innerHTML='<span class="unread-dot" role="img" aria-label="未读" title="未读"></span><div class="meta"><a data-author></a><span data-platform></span><span data-time></span><span class="badge" data-content></span></div><h2><a class="article-title" data-article></a></h2><div class="article-tags tag-chips"></div><p class="summary"></p><div class="reason"></div><div class="actions"><a class="primary" data-article>站内阅读</a><a data-original target="_blank" rel="noopener noreferrer">原文 ↗</a><button data-action="read">高亮 / 批注</button><button data-action="tags">编辑标签</button><button data-action="mark"></button><button data-action="like"></button><button data-action="dislike"></button></div>';
  const authorLink=a.querySelector('[data-author]');authorLink.textContent=entry.source||entry.author||'未知博主';
  if(entry.sourceId){authorLink.href='/desk/?view=sources&source='+encodeURIComponent(entry.sourceId);authorLink.onclick=e=>{if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();source=entry.sourceId;tag=[];platform='';void switchView('sources');};}
  else{authorLink.removeAttribute('href');authorLink.setAttribute('aria-disabled','true');authorLink.title='该条目缺少站内博主映射';}
  a.querySelector('[data-platform]').textContent=platforms[entry.platform]||entry.platform||'';
  a.querySelector('[data-time]').textContent=entry.published_at?date(entry.published_at):'发布时间未知';
  a.querySelector('[data-content]').textContent=contentLabel;
  a.querySelector('.article-title').textContent=entry.title;for(const link of a.querySelectorAll('[data-article]'))link.href='/desk/article/'+encodeURIComponent(entry.id);
  a.querySelector('.summary').textContent=(entry.summary||'').slice(0,230)+((entry.summary||'').length>230?'…':'');
  a.querySelector('.reason').textContent=(entry.reasons||[]).join('；');
  a.querySelector('.unread-dot').hidden=entry.status!=='unread';
  const tagBox=a.querySelector('.article-tags');
  const drawEntryTags=()=>drawQuickAddTags(tagBox,entry.tags||[],async value=>{
    const result=await api('/entries/'+entry.id+'/tags',{tags:[...(entry.tags||[]),value]});
    entry.tags=result.tags;drawEntryTags();await loadState();toast('已添加文章标签 '+value);
  },'给这篇文章添加标签');
  drawEntryTags();
  a.querySelector('[data-action=tags]').onclick=()=>editTags(a,entry.tags||[],async tags=>{
    const result=await api('/entries/'+entry.id+'/tags',{tags});entry.tags=result.tags;drawEntryTags();await loadState();if(['latest','unread','recommend'].includes(view))await renderList(false);toast('文章标签已保存');
  },'编辑文章标签（只影响这篇文章）');
  for(const link of a.querySelectorAll('[data-original]')){
    try{const url=new URL(entry.url);if(!['http:','https:'].includes(url.protocol))throw new Error();link.href=url.href;}
    catch{link.removeAttribute('href');link.removeAttribute('target');continue;}
    link.onclick=()=>{void trackArticleOpen(entry,'original');};
    link.onauxclick=e=>{if(e.button===1)void trackArticleOpen(entry,'original');};
  }
  a.addEventListener('click',e=>{
    if(e.target.closest('a,button,input,textarea,select,label,form,.tag-chips')||window.getSelection()?.toString())return;
    a.querySelector('.actions a[data-article][href]')?.click();
  });
  const read=a.querySelector('[data-action=read]');annotationButtonState(entry,read);read.onclick=async()=>{
    if(read.disabled)return;const tab=window.open('about:blank','_blank');if(tab)tab.opener=null;read.disabled=true;const before=read.textContent;
    try{await openReader(entry,read,tab);}
    catch(e){
      try{if(tab)tab.location.replace(entry.url);else window.location.assign(entry.url);await trackArticleOpen(entry,'original');toast('\u9605\u8bfb\u5668\u6682\u4e0d\u53ef\u7528\uff0c\u5df2\u6253\u5f00\u539f\u6587');}
      catch{if(tab)tab.close();error(e);}
    }
    finally{read.textContent=before;annotationButtonState(entry,read);}
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
