#!/usr/bin/env node
'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {Database}=require('./database');
const {DesktopCollector}=require('./desktop-collector');
const {ReaderService}=require('./service');
const {safeURL,hash,json}=require('./core');
const {authorIdentity}=require('./sources');
const {normalizeTags}=require('./tags');
const {historyPage}=require('./reading-history');
const {request,ApiClient}=require('./network');
const {createReaderWebSession}=require('./reader-web-session');

function secureEqual(a,b){return typeof a==='string'&&typeof b==='string'&&crypto.timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));}
function cookies(header){const out={};for(const s of String(header||'').split(';')){const i=s.indexOf('=');if(i<0)continue;try{out[s.slice(0,i).trim()]=decodeURIComponent(s.slice(i+1).trim());}catch{}}return out;}
async function bodyJSON(req,maxBytes=262144){let n=0;const parts=[];for await(const c of req){n+=c.length;if(n>maxBytes)throw new Error('request too large');parts.push(c);}return parts.length?JSON.parse(Buffer.concat(parts)):{};}
function reply(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function validPreferences(p){
  const clean={tags:{},authors:{},keywords:String(p.keywords||'').slice(0,2000),digestCount:Math.max(1,Math.min(50,Number(p.digestCount)||15)),timezone:p.timezone||'Asia/Shanghai'};
  new Intl.DateTimeFormat('en',{timeZone:clean.timezone});
  for(const key of ['tags','authors'])for(const [k,v] of Object.entries(p[key]||{})){if(k.length>150||!Number.isFinite(Number(v)))throw new Error('invalid preference');clean[key][k]=Math.max(-3,Math.min(3,Number(v)));}
  return clean;
}
function createApp(service,config,clients={}){
  const readerWebSession=clients.createReaderWebSession||createReaderWebSession;
  if(!config.accessToken)throw new Error('QR_ACCESS_TOKEN is required; anonymous mode is not supported');
  const loginAttempts=new Map();
  return http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow');
    let u;
    try{
      u=new URL(req.url,'http://localhost');
      if(u.pathname==='/healthz'){return reply(res,200,{service:'quiet-river-bridge',status:'ok'});}
      if(u.pathname==='/desk/collector/v1'){
        if(req.method!=='POST')return reply(res,405,{error:'POST required'});
        if(req.headers.origin||!config.collectorToken||!secureEqual(String(req.headers['x-qr-collector-token']||''),config.collectorToken))return reply(res,401,{error:'Collector authorization required'});
        if(!service.desktop)return reply(res,503,{error:'Collector not configured'});
        return reply(res,200,await service.desktop.handle(await bodyJSON(req,2*1024*1024)));
      }

      const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim();
      if(req.method!=='GET'&&req.method!=='HEAD'){
        let originHost='';try{originHost=new URL(req.headers.origin).host;}catch{}
        if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&originHost!==host))return reply(res,403,{error:'跨站写入已拒绝'});
      }
      if(u.pathname==='/desk/api/login'&&req.method==='POST'){
        const address=req.socket.remoteAddress||'local',attempt=loginAttempts.get(address)||{n:0,at:Date.now()};
        if(Date.now()-attempt.at>60000){attempt.n=0;attempt.at=Date.now();}
        if(++attempt.n>20)return reply(res,429,{error:'登录尝试过多，请稍后再试'});loginAttempts.set(address,attempt);
        const body=await bodyJSON(req);if(!secureEqual(String(body.token||''),config.accessToken))return reply(res,401,{error:'访问口令不正确'});
        const localHost=/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
        const secure=localHost?'':'; Secure';
        res.setHeader('Set-Cookie',`qr_token=${encodeURIComponent(config.accessToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
        return reply(res,200,{ok:true});
      }
      const articleShell=/^\/desk\/article\/\d+\/?$/.test(u.pathname);
      const isStatic=articleShell||['/desk','/desk/','/desk/app.js','/desk/workspace-ui.js','/desk/style.css'].includes(u.pathname);
      const token=String(req.headers['x-qr-token']||cookies(req.headers.cookie).qr_token||'');
      const authorized=secureEqual(token,config.accessToken);
      if(isStatic&&req.method==='GET'){
        const name=u.pathname.endsWith('/workspace-ui.js')?'workspace-ui.js':u.pathname.endsWith('.js')?'app.js':u.pathname.endsWith('.css')?'style.css':'index.html';
        const content=fs.readFileSync(path.join(__dirname,'public',name));
        res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});return res.end(content);
      }
      if(!authorized)return reply(res,401,{error:'请先输入现有 Quiet River 访问口令'});
      if(req.method==='POST'&&req.headers['x-qr-action']!=='1')return reply(res,403,{error:'缺少写入请求标识'});
      const p=u.pathname;
      const readerLaunch=/^\/desk\/reader\/(\d+)$/.exec(p);
      if(readerLaunch&&req.method==='GET'){
        const state=await service.readerStatus(Number(readerLaunch[1]));
        if(state.state==='ORIGINAL_ONLY'||state.state==='ERROR'||!state.bookmarkId){
          const original=safeURL(state.originalUrl);if(!original)return reply(res,409,{error:'该文章暂无可用阅读入口'});
          res.writeHead(302,{Location:original,'Cache-Control':'no-store'});return res.end();
        }
        res.setHeader('Set-Cookie',await readerWebSession(config));
        res.writeHead(302,{Location:'/reader/'+encodeURIComponent(state.bookmarkId),'Cache-Control':'no-store'});return res.end();
      }
      const bookmarkLaunch=/^\/desk\/bookmark\/([A-Za-z0-9_-]{1,128})$/.exec(p);
      if(bookmarkLaunch&&req.method==='GET'){
        res.setHeader('Set-Cookie',await readerWebSession(config));
        res.writeHead(302,{Location:'/reader/'+encodeURIComponent(bookmarkLaunch[1]),'Cache-Control':'no-store'});return res.end();
      }
      if(p==='/desk/reader-home'&&req.method==='GET'){
        const target=u.searchParams.get('target')==='highlights'?'highlights':'bookmarks';
        res.setHeader('Set-Cookie',await readerWebSession(config));
        res.writeHead(302,{Location:'/dashboard/'+target,'Cache-Control':'no-store'});return res.end();
      }
      if(p==='/desk/api/state'&&req.method==='GET')return reply(res,200,{sources:service.db.sources().map(s=>({id:s.id,name:s.name,platform:s.platform,tags:s.tags,url:s.url,visible:s.visible,enabled:s.enabled})),health:service.health(),tags:service.tagCatalog(),preferences:service.db.setting('preferences',{}),version:'1.0.0'});
      if(p==='/desk/api/acquisition/doctor'&&req.method==='GET')return reply(res,200,await service.acquisitionDoctor());
      if(p==='/desk/api/entries'&&req.method==='GET'){
        const offset=Math.max(0,Number(u.searchParams.get('offset'))||0), limit=Math.max(1,Math.min(100,Number(u.searchParams.get('limit'))||30));
        return reply(res,200,service.list({mode:u.searchParams.get('mode')||'latest',sourceId:u.searchParams.get('source')||undefined,platform:u.searchParams.get('platform')||undefined,tags:u.searchParams.has('tag')?u.searchParams.getAll('tag'):[],order:u.searchParams.get('order')||'desc',unread:u.searchParams.get('unread')==='1',offset,limit,asOf:Math.min(Date.now(),Number(u.searchParams.get('asOf'))||Date.now())}));
      }
      const articleDetail=/^\/desk\/api\/entries\/(\d+)$/.exec(p);
      if(articleDetail&&req.method==='GET')return reply(res,200,await service.articleDetail(Number(articleDetail[1])));
      const bodyEnrichment=/^\/desk\/api\/entries\/(\d+)\/enrichment$/.exec(p);
      if(bodyEnrichment&&req.method==='GET')return reply(res,200,service.bodyEnrichment(Number(bodyEnrichment[1])));
      if(bodyEnrichment&&req.method==='POST')return reply(res,202,service.requestBodyEnrichment(Number(bodyEnrichment[1])));
      const articlePrepare=/^\/desk\/api\/entries\/(\d+)\/prepare$/.exec(p);
      if(articlePrepare&&req.method==='POST')return reply(res,200,await service.articleDetail(Number(articlePrepare[1]),{prepare:true}));
      const articleNote=/^\/desk\/api\/entries\/(\d+)\/note$/.exec(p);
      if(articleNote&&req.method==='POST'){const b=await bodyJSON(req);return reply(res,200,await service.saveArticleNote(Number(articleNote[1]),b.note));}
      const articleHighlights=/^\/desk\/api\/entries\/(\d+)\/highlights$/.exec(p);
      if(articleHighlights&&req.method==='GET')return reply(res,200,await service.articleHighlights(Number(articleHighlights[1])));
      if(articleHighlights&&req.method==='POST')return reply(res,201,await service.createArticleHighlight(Number(articleHighlights[1]),await bodyJSON(req)));
      const highlightContext=/^\/desk\/api\/entries\/(\d+)\/highlights\/context$/.exec(p);
      if(highlightContext&&req.method==='POST')return reply(res,200,await service.articleHighlightContext(Number(highlightContext[1])));
      const articleHighlight=/^\/desk\/api\/entries\/(\d+)\/highlights\/([A-Za-z0-9_-]{1,128})(\/delete)?$/.exec(p);
      if(articleHighlight&&req.method==='POST')return reply(res,200,articleHighlight[3]?await service.deleteArticleHighlight(Number(articleHighlight[1]),articleHighlight[2]):await service.updateArticleHighlight(Number(articleHighlight[1]),articleHighlight[2],await bodyJSON(req)));
      if(p==='/desk/api/refresh'&&req.method==='POST')return reply(res,202,service.refresh(await bodyJSON(req)));
      const run=/^\/desk\/api\/runs\/([a-f0-9]+)$/.exec(p);
      if(run&&req.method==='GET'){const result=service.db.runStatus(run[1]);return reply(res,result?200:404,result||{error:'任务不存在'});}
      const archiveStatus=/^\/desk\/api\/entries\/(\d+)\/archive$/.exec(p);
      if(archiveStatus&&req.method==='GET')return reply(res,200,await service.readerStatus(Number(archiveStatus[1])));
      const entry=/^\/desk\/api\/entries\/(\d+)\/(read|open|tags|feedback|archive)$/.exec(p);
      if(entry&&req.method==='POST'){
        const data=await bodyJSON(req),id=Number(entry[1]);
        if(entry[2]==='open')return reply(res,200,await service.openArticle(id,data.eventId,data.target));
        if(entry[2]==='tags')return reply(res,200,service.setArticleTags(id,data.tags));
        if(entry[2]==='read')await service.markRead(id,data.status);
        if(entry[2]==='feedback')service.feedback(id,Number(data.value));
        if(entry[2]==='archive')return reply(res,200,await service.archive(id));
        return reply(res,200,{ok:true});
      }
      if(p==='/desk/api/backend'&&req.method==='GET')return reply(res,200,service.backend());
      if(p==='/desk/api/history'&&req.method==='GET'){
        const before=Number(u.searchParams.get('before'))||Number.MAX_SAFE_INTEGER;
        return reply(res,200,historyPage(service.db,{before,limit:Math.min(100,Math.max(1,Number(u.searchParams.get('limit'))||30))}));
      }
      if(p==='/desk/api/notes'&&req.method==='GET')return reply(res,200,await service.highlights(u.searchParams.get('cursor')||''));
      if(p==='/desk/api/bookmarks'&&req.method==='GET')return reply(res,200,await service.notes(u.searchParams.get('cursor')||''));
      if(p==='/desk/api/notes/export'&&req.method==='GET'){
        let cursor='',more=true,count=0;const lines=['# Quiet River 高亮导出','',`导出时间：${new Date().toISOString()}`,''];
        while(more&&count<10000){const page=await service.highlights(cursor);const records=page.highlights||[];for(const h of records){lines.push(`## ${h.article?.title||h.bookmark?.title||h.bookmarkId||'高亮'}`,'',`作者：${h.article?.author||'未知'} · 原文：${h.article?.url||'见阅读器'}`,`阅读器对象：${h.bookmarkId}`,'',String(h.text||'').split('\n').map(s=>'> '+s).join('\n'),'',h.note||'','');count++;}cursor=page.nextCursor||'';more=!!cursor;}
        if(more)lines.push('导出达到安全上限，尚有未导出记录。');
        res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="quiet-river-highlights.md"','Cache-Control':'no-store'});return res.end(lines.join('\n'));
      }
      if(p==='/desk/api/preferences'&&req.method==='POST'){const pref=validPreferences(await bodyJSON(req));service.db.set('preferences',pref);return reply(res,200,pref);}
      if(p==='/desk/api/sources'&&req.method==='POST'){
        const b=await bodyJSON(req), url=safeURL(b.url),feed=safeURL(b.feedUrl);
        if(!String(b.name||'').trim()||(!url&&!feed))return reply(res,400,{error:'需要来源名称以及主页或 Feed 地址'});
        const source={id:crypto.randomBytes(8).toString('hex'),name:String(b.name).slice(0,150),url:url||feed,platform:String(b.platform||'blog').slice(0,40),tags:normalizeTags(b.tags===undefined?[]:b.tags),feeds:feed?[feed]:[],manual:!feed};
        const identity=authorIdentity(source.url);
        if(identity){source.platform=identity.platform;source.adapter=identity;source.manual=false;}
        await service.importManifest({subscriptions:[source]});return reply(res,201,{source});
      }
      const configureMatch=/^\/desk\/api\/sources\/([\w-]+)\/configure$/.exec(p);
      if(configureMatch&&req.method==='POST'){
        const source=service.db.sources().find(s=>s.id===configureMatch[1]);
        if(!source)return reply(res,404,{error:'来源不存在'});
        await service.importManifest({subscriptions:[source]});
        return reply(res,200,{ok:true,message:'已按服务器配置重新登记通道；尚未宣称采集成功'});
      }
      const feedMatch=/^\/desk\/api\/sources\/([\w-]+)\/feed$/.exec(p);
      if(feedMatch&&req.method==='POST'){
        const b=await bodyJSON(req),source=service.db.sources().find(s=>s.id===feedMatch[1]);
        if(!source)return reply(res,404,{error:'来源不存在'});
        const url=safeURL(b.feedUrl);
        if(!url||url.length>4096)return reply(res,400,{error:'请输入有效的 HTTP/HTTPS 订阅地址'});
        if((source.feeds||[]).includes(url))return reply(res,200,{ok:true,added:false});
        await service.importManifest({subscriptions:[{...source,feeds:[...(source.feeds||[]),url]}]});
        return reply(res,200,{ok:true,added:true,message:'通道已登记，尚需一次成功更新检查'});
      }
      const sourceMatch=/^\/desk\/api\/sources\/([\w-]+)$/.exec(p);
      if(sourceMatch&&req.method==='POST'){
        const b=await bodyJSON(req),s=service.db.sources().find(s=>s.id===sourceMatch[1]);if(!s)return reply(res,404,{error:'来源不存在'});
        if(b.visible!==undefined)service.db.run('UPDATE sources SET visible=? WHERE id=?',b.visible?1:0,s.id);
        if(b.enabled!==undefined)service.db.run('UPDATE sources SET enabled=? WHERE id=?',b.enabled?1:0,s.id);
        if(b.tags!==undefined)service.setBloggerTags(s.id,b.tags);
        return reply(res,200,{ok:true});
      }
      if(p==='/desk/api/sources/export'&&req.method==='GET'){
        // Source URLs may be private subscription addresses. Download is authenticated, never published automatically.
        res.setHeader('Content-Disposition','attachment; filename="quiet-river-sources.json"');return reply(res,200,{version:1,subscriptions:service.db.sources()});
      }
      if(p==='/desk/api/groups/resume'&&req.method==='POST'){
        const b=await bodyJSON(req);if(!service.db.get('SELECT id FROM groups WHERE id=?',b.id))return reply(res,404,{error:'凭证组不存在'});
        service.db.run("UPDATE groups SET state='UNKNOWN',next_allowed=0,failures=0 WHERE id=?",b.id);
        for(const channel of service.db.channels())if(channel.transport==='desktop'&&channel.group_key===b.id)service.db.run("UPDATE channels SET next_check=0,state='NEVER_CHECKED',error='' WHERE id=?",channel.id);
        return reply(res,200,{ok:true,message:'已允许下一次正常采集验证，尚未宣称凭证有效'});
      }
      if(p==='/desk/api/digest'&&req.method==='POST'){
        const b=await bodyJSON(req);return reply(res,200,service.makeDigest(String(b.day),!!b.regenerate));
      }
      if(p==='/desk/api/digests'&&req.method==='GET')return reply(res,200,service.db.all('SELECT day,created_at,revision FROM digests ORDER BY day DESC LIMIT 100'));
      const day=/^\/desk\/api\/digests\/(\d{4}-\d{2}-\d{2})$/.exec(p);
      if(day&&req.method==='GET'){const d=service.db.get('SELECT payload FROM digests WHERE day=?',day[1]);if(!d)return reply(res,404,{error:'日报尚未生成'});const digest=json(d.payload,{});
        digest.items=(digest.items||[]).map(item=>{const entry=service.db.get('SELECT status FROM entries WHERE id=?',item.id);const snapshot=require('./article-metadata').tagSnapshot(service.db,item.id);return {...item,status:entry?.status||item.status,tags:snapshot?.tags||item.tags};});
        return reply(res,200,digest);}
      return reply(res,404,{error:'接口不存在'});
    }catch(e){service.db.audit('request',u?.pathname||'invalid',classifyErrorSafe(e));return reply(res,[400,404,409,503].includes(e.status)?e.status:502,{error:'操作未完成：'+classifyErrorSafe(e)});}
  });
}
function classifyErrorSafe(e){return /not configured/.test(e.message)?'阅读服务或采集通道尚未完成配置':/invalid|missing|must|too large/.test(e.message)?'请求参数不符合接口要求':'后端调用失败或超时；原有数据已保留';}
function loadConfig(){
  return {collectorToken:process.env.QR_COLLECTOR_TOKEN,schedulerEnabled:process.env.BRIDGE_SCHEDULER_ENABLED!=='false',accessToken:process.env.QR_ACCESS_TOKEN,port:Number(process.env.BRIDGE_PORT||4380),host:process.env.BRIDGE_HOST||'127.0.0.1',dataDir:process.env.BRIDGE_DATA_DIR||'/var/lib/quiet-river-platform/bridge',manifest:process.env.BRIDGE_MANIFEST,
    proxyFeedsEnabled:process.env.QR_PUBLIC_FEED_PROXY==='true',
    miniflux:process.env.MINIFLUX_URL||'http://127.0.0.1:3061',minifluxToken:process.env.MINIFLUX_TOKEN,
    karakeep:process.env.KARAKEEP_URL||'http://127.0.0.1:3062',karakeepToken:process.env.KARAKEEP_TOKEN,
    ntfy:process.env.NTFY_URL||'',adapters:{desktopPlatforms:String(process.env.QR_DESKTOP_PLATFORMS||'').split(',').filter(p=>['zhihu','xiaohongshu','bilibili'].includes(p)),rsshub:process.env.RSSHUB_URL||'',werss:process.env.WERSS_URL||'',xiaohongshuMcp:process.env.XHS_MCP_URL||'',werssAK:process.env.WERSS_AK||'',werssSK:process.env.WERSS_SK||'',werssToken:process.env.WERSS_TOKEN||'',zhihuReady:process.env.ZHIHU_READY==='true',xhsReady:process.env.XHS_READY==='true',browserEnabled:process.env.BROWSER_ACCEPTED==='true'}};
}
async function main(){
  const config=loadConfig();if(!config.minifluxToken)throw new Error('MINIFLUX_TOKEN required');
  const db=new Database(path.join(config.dataDir,'bridge.sqlite'));const service=new ReaderService(db,config);
  if(!db.sources().length&&config.manifest)await service.importManifest(JSON.parse(fs.readFileSync(config.manifest,'utf8')));
  if(config.collectorToken){service.desktop=new DesktopCollector(service);await service.desktop.register();}
  const app=createApp(service,config);service.start();
  app.listen(config.port,config.host,()=>console.log('Quiet River Bridge ready on loopback; production credentials are never logged'));
  let closing=false;
  for(const event of ['SIGTERM','SIGINT'])process.on(event,async()=>{
    if(closing)return;closing=true;service.stop();app.close();
    const deadline=Date.now()+125000;
    while((service.working||service.archiving.size||service.readWrites.size||service.desktop?.busy)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
    app.closeAllConnections();db.close();process.exit(0);
  });
}
if(require.main===module)main().catch(e=>{console.error('Bridge startup failed:',e.message);process.exit(1);});
module.exports={createApp,validPreferences,secureEqual,cookies,loadConfig};
