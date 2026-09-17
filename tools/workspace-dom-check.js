#!/usr/bin/env node
'use strict';
// Isolated DOM integration, using only fixture APIs. Not a real browser/network test.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {JSDOM,VirtualConsole}=require(require.resolve('jsdom',{paths:['/app/apps/workers',process.cwd()]}));
const root=path.resolve(__dirname,'../reader-bridge/public');
const sources=[{id:'a',name:'Fixture blogger',platform:'blog',tags:['Agent','数学'],enabled:true,visible:true},
 {id:'b',name:'Other blogger',platform:'wechat',tags:['数学'],enabled:true,visible:true}];
const entries=[1,2,3].map((id,i)=>({id,source_id:id===2?'b':'a',source:id===2?'Other blogger':'Fixture blogger',
 platform:id===2?'wechat':'blog',title:'Fixture article '+id,url:'https://example.org/article/'+id,
 published_at:Date.parse('2026-09-17T00:00:00Z')+i*1000,discovered_at:1,summary:'Fixture metadata',
 tags:id===1?['Agent','数学']:id===2?['数学']:['Agent'],status:'unread',content_state:'PARTIAL',feedback:0}));
const events=[],requests=[];let errorLogs=[];
const console=new VirtualConsole();console.on('jsdomError',e=>{if(!e.message.includes('navigation'))errorLogs.push(e.message);});
const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://reader.example.test/desk/',runScripts:'dangerously',virtualConsole:console});
const w=dom.window;w.scrollTo=()=>{};w.open=()=>({opener:null,location:{replace(){}},close(){}});
if(!w.crypto.randomUUID)w.crypto.randomUUID=require('node:crypto').randomUUID;
const health=()=>({sources:2,entries:entries.length,queue:0,groups:[],notifications:[],channels:sources.map(s=>({sourceId:s.id,id:s.id,enabled:true,state:'SUCCEEDED_NEW',lastCheck:100,lastSuccess:100})),unconfiguredSources:[]});
function backend(){const days=Array.from({length:365},(_,i)=>({day:new Date(Date.UTC(2025,8,18)+i*86400000).toISOString().slice(0,10),count:0,articles:0}));days.at(-1).count=events.length;
 return {activity:{days,timezone:'Asia/Shanghai',today:'2026-09-17',opens:events.length,uniqueArticles:new Set(events.map(e=>e.entryId)).size,activeDays:events.length?1:0},
 history:{items:events.slice().reverse(),nextCursor:null},faults:[{source:'Failure fixture',sourceId:'b',platform:'wechat',state:'TIMEOUT',error:'检查超时',lastSuccess:0,lastCheck:100}]};}
w.fetch=async(input,options={})=>{
 const u=new URL(input,w.location.href),p=u.pathname.replace('/desk/api',''),body=options.body?JSON.parse(options.body):null;
 requests.push({p,query:u.searchParams.toString(),body});let data;
 if(p==='/state')data={sources,health:health(),preferences:{},tags:[...new Set([...sources.flatMap(s=>s.tags),...entries.flatMap(e=>e.tags)])]};
 else if(p==='/refresh'||p.startsWith('/runs/'))data={id:'fixture',jobs:[],pending:0};
 else if(p==='/entries'){
  let items=entries.filter(e=>u.searchParams.getAll('tag').every(t=>e.tags.includes(t))&&(!u.searchParams.get('platform')||e.platform===u.searchParams.get('platform'))&&(!u.searchParams.get('source')||e.source_id===u.searchParams.get('source'))&&(u.searchParams.get('unread')!=='1'||e.status==='unread'));
  items=items.slice().sort((a,b)=>u.searchParams.get('order')==='asc'?a.published_at-b.published_at:b.published_at-a.published_at);
  data={items,total:items.length,asOf:Date.now(),offset:0,limit:30};
 }else if(/^\/entries\/\d+\//.test(p)){
  const [, ,id,action]=p.split('/'),e=entries.find(e=>e.id===Number(id));
  if(action==='tags'){e.tags=body.tags;data={id:e.id,tags:e.tags};}
  if(action==='read'){e.status=body.status;data={ok:true};}
  if(action==='open'){e.status='read';if(!events.some(x=>x.eventId===body.eventId))events.push({id:events.length+1,eventId:body.eventId,entryId:e.id,title:e.title,source:e.source,platform:e.platform,url:e.url,status:'read',openedAt:Date.now()});data={status:'read'};}
  if(action==='archive')data={path:'/dashboard/preview/fixture',state:'READY'};
 }else if(p.startsWith('/sources/')){const s=sources.find(s=>s.id===p.split('/')[2]);if(body?.tags)s.tags=body.tags;data={ok:true};}
 else if(p==='/backend')data=backend();else if(p==='/history')data=backend().history;
 else if(p==='/digests')data=[];
 else throw new Error('Unexpected fixture API '+p);
 return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(data))};
};
for(const name of ['workspace-ui.js','app.js']){const script=w.document.createElement('script');script.textContent=fs.readFileSync(path.join(root,name),'utf8');w.document.body.append(script);}
const delay=()=>new Promise(r=>setTimeout(r,15));
async function wait(predicate,message){for(let i=0;i<150;i++){if(predicate())return;await delay();}throw new Error('DOM timeout: '+message);}
const tagButton=label=>[...w.document.querySelectorAll('#tags button')].find(b=>b.textContent===label);
async function main(){
 await wait(()=>w.document.querySelectorAll('.article-card').length===3,'initial cards');
 assert.equal(w.document.querySelector('#title').textContent,'文章');
 assert.equal(w.document.querySelectorAll('.unread-dot:not([hidden])').length,3);
 tagButton('Agent').click();await wait(()=>w.document.querySelectorAll('.article-card').length===2,'first tag');
 tagButton('数学').click();await wait(()=>w.document.querySelectorAll('.article-card').length===1,'AND tags');
 assert.equal(w.document.querySelector('.article-card').dataset.entryId,'1');
 assert.ok(requests.some(r=>r.p==='/entries'&&new URLSearchParams(r.query).getAll('tag').length===2));
 w.document.querySelector('#clear-tags').click();await wait(()=>w.document.querySelectorAll('.article-card').length===3,'clear tags');
 const order=w.document.querySelector('#time-order');order.value='asc';order.dispatchEvent(new w.Event('change'));
 await wait(()=>w.document.querySelector('.article-card')?.dataset.entryId==='1','ascending order');
 const card=w.document.querySelector('.article-card');card.querySelector('[data-action=tags]').click();
 const form=card.querySelector('form');form.querySelector('[aria-label="移除标签 Agent"]').click();
 form.elements.newTag.value='阅读测试';form.querySelector('[data-add]').click();form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 await wait(()=>entries[0].tags.includes('阅读测试'),'article edit saved');assert.equal(events.length,0);
 w.document.querySelector('[data-view=sources]').click();await wait(()=>w.document.querySelector('[data-tags]'),'bloggers');
 const bloggerRow=w.document.querySelector('#source-list .source');bloggerRow.querySelector('[data-tags]').click();
 const sf=bloggerRow.querySelector('form');sf.elements.newTag.value='后续新文章';sf.querySelector('[data-add]').click();sf.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 await wait(()=>sources[0].tags.includes('后续新文章'),'blogger tags saved');assert.ok(!entries[0].tags.includes('后续新文章'));
 w.document.querySelector('[data-view=unread]').click();await wait(()=>w.document.querySelectorAll('.article-card').length===3,'unread view');
 const opened=w.document.querySelector('.article-card');const openedId=Number(opened.dataset.entryId);opened.querySelector('a[data-original]').click();
 await wait(()=>events.length===1&&w.document.querySelectorAll('.article-card').length===2,'open marks read and removes card');
 assert.equal(entries.find(e=>e.id===openedId).status,'read');
 w.document.querySelector('[data-view=latest]').click();await wait(()=>w.document.querySelectorAll('.article-card').length===3,'article view');
 const readCard=w.document.querySelector('[data-entry-id="'+openedId+'"]');assert.equal(readCard.querySelector('.unread-dot').hidden,true);
 readCard.querySelector('a[data-original]').click();await wait(()=>events.length===2,'repeat open recorded');
 w.document.querySelector('[data-view=backend]').click();await wait(()=>w.document.querySelectorAll('.activity-day').length===365,'activity heatmap');
 assert.ok(w.document.querySelector('.activity-total').textContent.includes('2'));
 w.document.querySelector('[data-backend=history]').click();assert.equal(w.document.querySelectorAll('.history-row').length,2);
 w.document.querySelector('[data-backend=faults]').click();assert.ok(w.document.querySelector('#backend-body').textContent.includes('检查超时'));
 assert.deepEqual(errorLogs,[]);
 process.stdout.write('PASS DOM: labels, unread dots, AND tags, time order, both tag editors, open/read history, heatmap and failure list\n');
 process.stdout.write('Fixture-only JSDOM test: no platform fetch, browser process, real account or production reading-history mutation\n');
}
main().catch(e=>{process.stderr.write(e.stack+'\n'+String(w.document.querySelector('#error')?.textContent||'')+'\n'+JSON.stringify(errorLogs)+'\n');process.exitCode=1;}).finally(()=>w.close());
