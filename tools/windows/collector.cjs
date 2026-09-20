#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync,spawn}=require('node:child_process');
const {normalize,normalizeEnrichment,selectFreshXhsNoteUrl,statusFor}=require('./normalize.cjs');
const {originalLink}=require('./original-link.cjs');
const root=process.env.QR_COLLECTOR_HOME||path.join(process.env.LOCALAPPDATA||os.homedir(),'QuietRiverCollector');
const configPath=path.join(root,'config.json'),args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let config,locked=false,proxyTunnel=null,proxyRestart=null,exiting=false,opencliReady=false;
function log(message){console.log(new Date().toLocaleString()+' '+message);}
function proxyTunnelArgs(cfg=config,rootDir=root){
  const key=path.join(rootDir,'proxy_tunnel_ed25519');
  return {key,argv:['-NT','-p',String(cfg.port||22),'-i',key,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+cfg.knownHostsFile,'-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-R','127.0.0.1:17890:127.0.0.1:7890','qr-proxy-tunnel@'+cfg.host]};
}
function startProxyTunnel(){
  const spec=proxyTunnelArgs();if(!fs.existsSync(spec.key)){log('Proxy tunnel key not installed; international feed proxy remains unavailable.');return;}
  proxyTunnel=spawn(config.ssh||'ssh.exe',spec.argv,{windowsHide:true,stdio:'ignore'});
  proxyTunnel.on('spawn',()=>log('Restricted ECS proxy tunnel started; Clash credentials remain on Windows.'));
  proxyTunnel.on('exit',()=>{proxyTunnel=null;if(!exiting)proxyRestart=setTimeout(startProxyTunnel,5000);});
  proxyTunnel.on('error',()=>{if(!exiting&&!proxyRestart)proxyRestart=setTimeout(startProxyTunnel,5000);});
}
function stopProxyTunnel(){exiting=true;if(proxyRestart)clearTimeout(proxyRestart);proxyRestart=null;if(proxyTunnel)try{proxyTunnel.kill();}catch{}}
process.on('exit',stopProxyTunnel);process.on('SIGINT',()=>{stopProxyTunnel();process.exit(130);});process.on('SIGTERM',()=>{stopProxyTunnel();process.exit(143);});
function transport(message){
  const argv=['-T','-p',String(config.port||22),'-i',config.identityFile,
    '-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
    '-o','UserKnownHostsFile='+config.knownHostsFile,'-o','ConnectTimeout=10',
    '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',config.user+'@'+config.host,'collector'];
  const result=spawnSync(config.ssh||'ssh.exe',argv,{input:JSON.stringify(message),encoding:'utf8',
    timeout:150000,maxBuffer:4*1024*1024,windowsHide:true});
  let parsed;try{parsed=JSON.parse(result.stdout||'');}catch{}
  if(result.error||result.status!==0||parsed?.error){
    const error=new Error('ECS transport failed; pending results kept for retry');
    error.status=parsed?.status;throw error;
  }
  return parsed;
}
function persist(file,value){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);}
function acquire(){
  const file=path.join(root,'worker.lock');
  if(fs.existsSync(file)){
    let alive=false;try{process.kill(Number(fs.readFileSync(file,'utf8')),0);alive=true;}catch{}
    if(alive)throw new Error('A collector is already running; do not start duplicate browsers');fs.unlinkSync(file);
  }
  fs.writeFileSync(file,String(process.pid),{flag:'wx'});locked=true;
  process.on('exit',()=>{if(locked)try{fs.unlinkSync(file);}catch{}});
}
function preflight(){
  config=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
  if(!/^[a-zA-Z0-9.-]+$/.test(config.host)||config.user!=='qr-collector')throw new Error('Invalid destination configuration');
  for(const p of [config.identityFile,config.knownHostsFile,config.opencliMain])if(!p||!fs.existsSync(p))throw new Error('Setup is incomplete: missing local file');
  const version=spawnSync(process.execPath,[config.opencliMain,'--version'],{encoding:'utf8',timeout:15000});
  if(version.status!==0||!version.stdout.includes('1.8.7'))throw new Error('OpenCLI 1.8.7 contract required; revalidate before updating');
  const doctor=spawnSync(process.execPath,[config.opencliMain,'doctor'],{encoding:'utf8',timeout:20000});
  opencliReady=doctor.status===0&&/Extension: connected/.test(doctor.stdout);
  if(!opencliReady)log('OpenCLI Browser Bridge is not connected; OpenCLI-backed jobs remain unavailable, but independent backends may continue.');
  transport({op:'status'});log('Restricted ECS connection verified. Cookies stay in Windows.');
}
function discoverTwitterPython(){
  const candidates=[config.twitterPython,process.env.APPDATA&&path.join(process.env.APPDATA,'uv','tools','twitter-cli','Scripts','python.exe'),process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'uv','tools','twitter-cli','Scripts','python.exe')].filter(Boolean);
  return candidates.find(p=>fs.existsSync(p))||'';
}
function localBackendStatus(now=Date.now()){
  const script=path.join(__dirname,'twitter-explicit.py'),python=discoverTwitterPython(),hasExplicit=!!(process.env.TWITTER_AUTH_TOKEN&&process.env.TWITTER_CT0),verified=Number(config.twitterCliVerifiedAt)||0;
  const twitterCli=!python||!fs.existsSync(script)?{status:'off',reason:'twitter-cli explicit wrapper is not installed',state:'NOT_CONFIGURED'}:!hasExplicit?{status:'off',reason:'explicit TWITTER_AUTH_TOKEN + TWITTER_CT0 are not present; browser cookies will not be scanned',state:'NO_EXPLICIT_CREDENTIALS'}:verified&&now-verified<86400000?{status:'ok',reason:'explicit twitter-cli author-timeline canary passed within 24h',state:'READY'}:{status:'warn',reason:'explicit Twitter credentials exist but a current read-only canary has not passed',state:'UNVERIFIED'};
  const opencliTwitter=opencliReady&&Number(config.opencliTwitterVerifiedAt)&&now-Number(config.opencliTwitterVerifiedAt)<86400000?{status:'ok',reason:'OpenCLI Twitter author-timeline canary passed within 24h',state:'READY'}:opencliReady?{status:'warn',reason:'OpenCLI bridge is connected but the Twitter adapter has not passed a current canary',state:'UNVERIFIED'}:{status:'off',reason:'OpenCLI Browser Bridge is not connected',state:'OFFLINE'};
  const instagram=opencliReady&&Number(config.instagramVerifiedAt)&&now-Number(config.instagramVerifiedAt)<86400000?{status:'ok',reason:'OpenCLI Instagram author-post canary passed within 24h',state:'READY'}:opencliReady?{status:'off',reason:'Instagram login/runtime has not passed an explicit author canary',state:'UNVERIFIED'}:{status:'off',reason:'OpenCLI Browser Bridge is not connected',state:'OFFLINE'};
  return {'twitter-cli-shervin':twitterCli,'opencli-twitter-shervin':opencliTwitter,'opencli-instagram-shervin':instagram};
}
function saveConfig(){fs.writeFileSync(configPath,JSON.stringify(config,null,2),{encoding:'utf8'});}
function verifyTwitterCli(handle){
  if(!/^[A-Za-z0-9_]{1,15}$/.test(handle))throw new Error('Invalid Twitter handle');
  const python=discoverTwitterPython(),script=path.join(__dirname,'twitter-explicit.py');if(!python||!fs.existsSync(script))throw new Error('twitter-cli explicit wrapper is not installed');
  if(!process.env.TWITTER_AUTH_TOKEN||!process.env.TWITTER_CT0)throw new Error('Set explicit TWITTER_AUTH_TOKEN and TWITTER_CT0 before verification');
  const r=spawnSync(python,[script,handle,'1'],{encoding:'utf8',timeout:90000,maxBuffer:1024*1024,env:{...process.env,PYTHONUTF8:'1'}});if(r.error||r.status!==0)throw new Error('Twitter explicit canary failed');
  let rows;try{rows=JSON.parse(r.stdout||'[]');}catch{throw new Error('Twitter explicit canary returned invalid JSON');}
  const items=normalize({platform:'twitter',kind:'tweets',authorId:handle,name:handle},rows);if(!items.length)throw new Error('Twitter explicit canary returned no original posts');
  config.twitterCliVerifiedAt=Date.now();config.twitterCliVerifiedHandle=handle;saveConfig();return {backend:'twitter-cli-shervin',verifiedAt:config.twitterCliVerifiedAt,count:items.length};
}
function verifyOpencliTwitter(handle){
  if(!/^[A-Za-z0-9_]{1,15}$/.test(handle))throw new Error('Invalid Twitter handle');if(!opencliReady)throw new Error('OpenCLI Browser Bridge is not connected');
  const r=runOpencliRead(config,[config.opencliMain,'twitter','tweets',handle,'--limit','1','-f','json','--trace','off','--site-session','ephemeral']);if(r.error||r.status!==0)throw new Error('OpenCLI Twitter canary failed');
  let rows;try{rows=JSON.parse(r.stdout.replace(/^\uFEFF/,''));}catch{throw new Error('OpenCLI Twitter canary returned invalid JSON');}
  const items=normalize({platform:'twitter',kind:'tweets',authorId:handle,name:handle},rows);if(!items.length)throw new Error('OpenCLI Twitter canary returned no original posts');
  config.opencliTwitterVerifiedAt=Date.now();config.opencliTwitterVerifiedHandle=handle;saveConfig();return {backend:'opencli-twitter-shervin',verifiedAt:config.opencliTwitterVerifiedAt,count:items.length};
}
function verifyInstagram(handle){
  if(!/^[A-Za-z0-9._]{1,30}$/.test(handle))throw new Error('Invalid Instagram handle');if(!opencliReady)throw new Error('OpenCLI Browser Bridge is not connected');
  const script=path.join(__dirname,'instagram-user.cjs');if(!fs.existsSync(script))throw new Error('Instagram read-only wrapper is missing');
  const r=spawnSync(process.execPath,[script,handle,'1'],{encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024,env:{...process.env,OPENCLI_PROFILE:config.profile||process.env.OPENCLI_PROFILE||''}});if(r.error||r.status!==0)throw new Error('Instagram author canary failed');
  let rows;try{rows=JSON.parse(r.stdout.replace(/^\uFEFF/,''));}catch{throw new Error('Instagram author canary returned invalid JSON');}
  const items=normalize({platform:'instagram',kind:'posts',authorId:handle,name:handle},rows);if(!items.length)throw new Error('Instagram author canary returned no posts');
  config.instagramVerifiedAt=Date.now();config.instagramVerifiedHandle=handle;saveConfig();return {backend:'opencli-instagram-shervin',verifiedAt:config.instagramVerifiedAt,count:items.length};
}
function runOpencliRead(cfg,argv,spawnFn=spawnSync){
  const options={encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,env:{...process.env,OPENCLI_PROFILE:cfg.profile||process.env.OPENCLI_PROFILE||''}};
  let result=spawnFn(process.execPath,argv,options);
  if((result.error||result.status!==0)&&/Navigation rejected/i.test(result.stderr||'')){
    const retry=[...argv],i=retry.indexOf('--trace');if(i>=0&&retry[i+1]==='off')retry[i+1]='retain-on-failure';
    result=spawnFn(process.execPath,retry,options);result.qrNavigationRetried=true;
  }
  return result;
}
function collect(job,limitOverride){
  if(!['zhihu','xiaohongshu','bilibili','twitter','instagram'].includes(job.platform)||!/^[-.\w]+$/.test(job.authorId))throw new Error('Invalid job identity');
  const limit=Math.min(20,Math.max(1,Number(limitOverride??job.limit??20)||20));
  let r;
  if(job.platform==='instagram'){
    if(job.kind!=='posts'||job.backendId!=='opencli-instagram-shervin')throw new Error('Unsupported Instagram read-only backend');
    if(!job.authProbe&&localBackendStatus()['opencli-instagram-shervin'].status!=='ok')return {leaseId:job.leaseId,status:'AUTH_REQUIRED',items:[]};
    const script=path.join(__dirname,'instagram-user.cjs');if(!fs.existsSync(script))throw new Error('Instagram read-only wrapper is missing');
    r=spawnSync(process.execPath,[script,job.authorId,String(limit)],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,env:{...process.env,OPENCLI_PROFILE:config.profile||process.env.OPENCLI_PROFILE||''}});
  }else if(job.platform==='twitter'){
    if(job.kind!=='tweets'||!['twitter-cli-shervin','opencli-twitter-shervin'].includes(job.backendId))throw new Error('Unsupported Twitter read-only backend');
    if(job.backendId==='twitter-cli-shervin'){
      const status=localBackendStatus()['twitter-cli-shervin'];if(status.status!=='ok')return {leaseId:job.leaseId,status:'AUTH_REQUIRED',items:[]};
      const python=discoverTwitterPython(),script=path.join(__dirname,'twitter-explicit.py');r=spawnSync(python,[script,job.authorId,String(limit)],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,env:{...process.env,PYTHONUTF8:'1'}});
    }else{
      if(localBackendStatus()['opencli-twitter-shervin'].status!=='ok')return {leaseId:job.leaseId,status:'BROWSER_OFFLINE',items:[]};
      r=runOpencliRead(config,[config.opencliMain,'twitter','tweets',job.authorId,'--limit',String(limit),'-f','json','--trace','off','--site-session','ephemeral']);
    }
  }else{
    const command=job.platform==='xiaohongshu'?'user':job.platform==='bilibili'?'user-videos':job.kind==='answers'?'user-answers':job.kind==='articles'?'user-articles':null;
    if(!command)throw new Error('Unsupported read-only command');
    r=runOpencliRead(config,[config.opencliMain,job.platform,command,job.authorId,'--limit',String(limit),'-f','json','--trace','off','--site-session','ephemeral']);
  }
  if(r.error||r.status!==0){const diagnostic=/Navigation rejected/i.test(r.stderr||'')?'navigation_rejected':'upstream_rejected';log('Read-only backend check failed: '+diagnostic);return {leaseId:job.leaseId,status:r.error?.code==='ETIMEDOUT'?'TIMEOUT':statusFor(r.status,r.stderr||r.error?.message||''),items:[]};}
  try{return {leaseId:job.leaseId,status:'OK',items:normalize(job,JSON.parse(r.stdout.replace(/^\uFEFF/,'')))};}
  catch{return {leaseId:job.leaseId,status:'UPSTREAM_ERROR',items:[]};}
}
function collectEnrichment(job){
  const bodyTask=job.taskType==='entry_body_v1'&&['zhihu','xiaohongshu'].includes(job.platform)&&['answers','articles','notes'].includes(job.kind);
  const transcriptTask=job.taskType==='entry_transcript_v1'&&job.platform==='bilibili'&&job.kind==='videos';
  if(!bodyTask&&!transcriptTask)throw new Error('Invalid enrichment task');
  originalLink(job,job.url);let argv,payload;
  if(transcriptTask)argv=[config.opencliMain,'bilibili','subtitle',job.url,'-f','json','--trace','off','--site-session','ephemeral'];
  else if(job.platform==='zhihu'&&job.kind==='answers')argv=[config.opencliMain,'zhihu','answer-detail',job.url,'--max-content','0','-f','json','--trace','off','--site-session','ephemeral'];
  else if(job.platform==='xiaohongshu'&&job.kind==='notes'){
    const refresh=runOpencliRead(config,[config.opencliMain,'xiaohongshu','user',job.authorId,'--limit','50','-f','json','--trace','off','--site-session','ephemeral']);
    if(refresh.error||refresh.status!==0)return {leaseId:job.leaseId,entryId:job.entryId,status:refresh.error?.code==='ETIMEDOUT'?'TIMEOUT':statusFor(refresh.status,refresh.stderr||refresh.error?.message||'')};
    let fresh='';try{fresh=selectFreshXhsNoteUrl(job,JSON.parse(refresh.stdout.replace(/^\uFEFF/,'')));}catch{return {leaseId:job.leaseId,entryId:job.entryId,status:'UPSTREAM_ERROR'};}
    if(!fresh)return {leaseId:job.leaseId,entryId:job.entryId,status:'UPSTREAM_ERROR'};
    argv=[config.opencliMain,'xiaohongshu','note',fresh,'-f','json','--trace','off','--site-session','ephemeral'];
  }
  else if(job.platform==='zhihu'&&job.kind==='articles')argv=[config.opencliMain,'web','read','--url',job.url,'--download-images','false','--stdout','true','--frames','none','--wait','3','--trace','off','--site-session','ephemeral'];
  else throw new Error('Unsupported enrichment task');
  const r=runOpencliRead(config,argv);
  if(r.error||r.status!==0)return {leaseId:job.leaseId,entryId:job.entryId,status:r.error?.code==='ETIMEDOUT'?'TIMEOUT':statusFor(r.status,r.stderr||r.error?.message||'')};
  try{payload=job.platform==='zhihu'&&job.kind==='articles'?r.stdout:JSON.parse(r.stdout.replace(/^\uFEFF/,''));const normalized=normalizeEnrichment(job,payload);return {leaseId:job.leaseId,status:'OK',...normalized};}
  catch{return {leaseId:job.leaseId,entryId:job.entryId,status:'UPSTREAM_ERROR'};}
}
async function confirmedCollect(job,collectFn=collect,sleepFn=sleep){
  const first=collectFn(job);if(first.status!=='AUTH_REQUIRED')return first;
  await sleepFn(3000);return collectFn(job);
}
async function authRecovered(probe,collectFn=collect,sleepFn=sleep){
  const first=collectFn(probe,1);if(first.status!=='OK')return false;
  await sleepFn(2000);const recovered=collectFn(probe,1).status==='OK';
  if(recovered&&probe.platform==='instagram'){config.instagramVerifiedAt=Date.now();config.instagramVerifiedHandle=probe.authorId;saveConfig();}
  return recovered;
}
async function main(){
  if(args.includes('--help')){console.log('collector.cjs [--watch] [--max-jobs 20] [--platform zhihu|xiaohongshu|bilibili|twitter|instagram] [--doctor] [--verify-twitter HANDLE] [--verify-twitter-opencli HANDLE] [--verify-instagram HANDLE]');return;}
  preflight();if(args.includes('--verify-twitter')){const handle=option('--verify-twitter','');const result=verifyTwitterCli(handle);log('Verified '+result.backend+' with an explicit read-only author canary; no browser cookie discovery was used.');return;}if(args.includes('--verify-twitter-opencli')){const handle=option('--verify-twitter-opencli','');const result=verifyOpencliTwitter(handle);log('Verified '+result.backend+' with an explicit read-only author canary.');return;}if(args.includes('--verify-instagram')){const handle=option('--verify-instagram','');const result=verifyInstagram(handle);log('Verified '+result.backend+' with an explicit read-only author canary.');return;}if(args.includes('--doctor')){for(const [id,s] of Object.entries(localBackendStatus()))log(id+': '+s.status+' · '+s.reason);return;}acquire();if(args.includes('--watch'))startProxyTunnel();
  const platforms=option('--platform','zhihu,xiaohongshu,bilibili,twitter,instagram').split(',').filter(p=>['zhihu','xiaohongshu','bilibili','twitter','instagram'].includes(p));
  if(!platforms.length)throw new Error('Choose a supported platform');
  const max=Math.max(1,Math.min(1000,Number(option('--max-jobs',args.includes('--watch')?'1000':'20'))||20));
  const pending=path.join(root,'pending-result.json'),authProbeAt=new Map();let done=0,failures=0;
  while(done<max){
    try{
      if(fs.existsSync(pending)){
        const result=JSON.parse(fs.readFileSync(pending,'utf8'));
        try{const ack=transport({op:'submit',result});if(!ack.accepted)throw new Error('Missing acknowledgement');
          if(!['SUCCEEDED_PARTIAL','ENRICHED','FALLBACK_QUEUED'].includes(ack.state))failures++;
          fs.unlinkSync(pending);log(result.entryId?`ECS accepted entry enrichment result; ${ack.state}`:`ECS accepted ${ack.received} records; ${ack.state}`);done++;
        }catch(e){if(e.status===409){fs.renameSync(pending,pending+'.expired-'+Date.now());log('Expired result retained locally; new collection required');}else throw e;}
        if(done>=max)break;
      }
      const next=transport({op:'claim',platforms,capabilities:['entry_body_v1','entry_transcript_v1'],backends:localBackendStatus()});
      if(!next.job){
        let resumed=false;
        if(next.authProbe){
          const last=authProbeAt.get(next.authProbe.platform)||0;
          if(Date.now()-last>=600000){
            authProbeAt.set(next.authProbe.platform,Date.now());
            log('Checking whether local '+next.authProbe.platform+' authorization has recovered; no cookie leaves Windows.');
            if(await authRecovered(next.authProbe)){
              const ack=transport({op:'resume',platform:next.authProbe.platform});
              resumed=!!ack.resumed;log(resumed?'ECS credential group resumed after two local successful probes.':'ECS kept the credential group paused by recovery cooldown.');
            }else log('Local authorization recovery not confirmed twice; ECS remains paused.');
          }
        }
        if(resumed){await sleep(2000);continue;}
        if(!args.includes('--watch')&&!next.waitForCooldown){log('No currently eligible task. Cooling down or waiting for browser authorization is not a successful source check.');break;}
        await sleep(Math.max(8,Math.min(60,next.retryAfter||30))*1000);continue;
      }
      const enrichment=['entry_body_v1','entry_transcript_v1'].includes(next.job.taskType),transcript=next.job.taskType==='entry_transcript_v1';
      log(transcript?'Reading one known Bilibili subtitle track for Quiet River':enrichment?'Reading one known '+next.job.platform+' article body for Quiet River':'Checking '+next.job.platform+' / '+next.job.kind+' for a subscribed author');
      const result=await confirmedCollect(next.job,enrichment?collectEnrichment:collect);
      if(result.status==='AUTH_REQUIRED')log(transcript?'Subtitle authorization was not confirmed; only this subtitle task will pause.':'Authentication failure repeated on the same subscribed route; shared group will pause.');
      persist(pending,result);await sleep(8000);
    }catch(e){log(e.message);if(!args.includes('--watch'))throw e;await sleep(30000);}
  }
  log('Completed '+done+' tasks; '+failures+' blocked or failed. This is not an all-source coverage claim.');
  if(failures)process.exitCode=2;
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={normalize,normalizeEnrichment,statusFor,collectEnrichment,runOpencliRead,confirmedCollect,authRecovered,proxyTunnelArgs};
