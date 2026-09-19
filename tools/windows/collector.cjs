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
let config,locked=false,proxyTunnel=null,proxyRestart=null,exiting=false;
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
  if(doctor.status!==0||!/Extension: connected/.test(doctor.stdout))throw new Error('Open Chrome and connect the OpenCLI Browser Bridge extension');
  transport({op:'status'});log('OpenCLI extension and restricted ECS connection verified. Cookies stay in Windows.');
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
  if(!['zhihu','xiaohongshu','bilibili'].includes(job.platform)||!/^[-\w]+$/.test(job.authorId))throw new Error('Invalid job identity');
  const command=job.platform==='xiaohongshu'?'user':job.platform==='bilibili'?'user-videos':job.kind==='answers'?'user-answers':job.kind==='articles'?'user-articles':null;
  if(!command)throw new Error('Unsupported read-only command');
  const limit=Math.min(20,Math.max(1,Number(limitOverride??job.limit??20)||20));
  const argv=[config.opencliMain,job.platform,command,job.authorId,'--limit',String(limit),'-f','json','--trace','off','--site-session','ephemeral'];
  const r=runOpencliRead(config,argv);
  if(r.error||r.status!==0){const diagnostic=/Navigation rejected/i.test(r.stderr||'')?'navigation_rejected':'upstream_rejected';log('OpenCLI check failed: '+diagnostic);return {leaseId:job.leaseId,status:r.error?.code==='ETIMEDOUT'?'TIMEOUT':statusFor(r.status,r.stderr||r.error?.message||''),items:[]};}
  try{return {leaseId:job.leaseId,status:'OK',items:normalize(job,JSON.parse(r.stdout.replace(/^\uFEFF/,'')))};}
  catch{return {leaseId:job.leaseId,status:'UPSTREAM_ERROR',items:[]};}
}
function collectEnrichment(job){
  if(job.taskType!=='entry_body_v1'||!['zhihu','xiaohongshu'].includes(job.platform)||!['answers','articles','notes'].includes(job.kind))throw new Error('Invalid enrichment task');
  originalLink(job,job.url);let argv,payload;
  if(job.platform==='zhihu'&&job.kind==='answers')argv=[config.opencliMain,'zhihu','answer-detail',job.url,'--max-content','0','-f','json','--trace','off','--site-session','ephemeral'];
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
  try{payload=job.kind==='articles'?r.stdout:JSON.parse(r.stdout.replace(/^\uFEFF/,''));const normalized=normalizeEnrichment(job,payload);return {leaseId:job.leaseId,status:'OK',...normalized};}
  catch{return {leaseId:job.leaseId,entryId:job.entryId,status:'UPSTREAM_ERROR'};}
}
async function confirmedCollect(job,collectFn=collect,sleepFn=sleep){
  const first=collectFn(job);if(first.status!=='AUTH_REQUIRED')return first;
  await sleepFn(3000);return collectFn(job);
}
async function authRecovered(probe,collectFn=collect,sleepFn=sleep){
  const first=collectFn(probe,1);if(first.status!=='OK')return false;
  await sleepFn(2000);return collectFn(probe,1).status==='OK';
}
async function main(){
  if(args.includes('--help')){console.log('collector.cjs [--watch] [--max-jobs 20] [--platform zhihu|xiaohongshu|bilibili] [--doctor]');return;}
  preflight();if(args.includes('--doctor'))return;acquire();if(args.includes('--watch'))startProxyTunnel();
  const platforms=option('--platform','zhihu,xiaohongshu,bilibili').split(',').filter(p=>['zhihu','xiaohongshu','bilibili'].includes(p));
  if(!platforms.length)throw new Error('Choose a supported platform');
  const max=Math.max(1,Math.min(1000,Number(option('--max-jobs',args.includes('--watch')?'1000':'20'))||20));
  const pending=path.join(root,'pending-result.json'),authProbeAt=new Map();let done=0,failures=0;
  while(done<max){
    try{
      if(fs.existsSync(pending)){
        const result=JSON.parse(fs.readFileSync(pending,'utf8'));
        try{const ack=transport({op:'submit',result});if(!ack.accepted)throw new Error('Missing acknowledgement');
          if(!['SUCCEEDED_PARTIAL','ENRICHED'].includes(ack.state))failures++;
          fs.unlinkSync(pending);log(result.entryId?`ECS accepted article-body result; ${ack.state}`:`ECS accepted ${ack.received} records; ${ack.state}`);done++;
        }catch(e){if(e.status===409){fs.renameSync(pending,pending+'.expired-'+Date.now());log('Expired result retained locally; new collection required');}else throw e;}
        if(done>=max)break;
      }
      const next=transport({op:'claim',platforms,capabilities:['entry_body_v1']});
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
      const enrichment=next.job.taskType==='entry_body_v1';
      log(enrichment?'Reading one known '+next.job.platform+' article body for Quiet River':'Checking '+next.job.platform+' / '+next.job.kind+' for a subscribed author');
      const result=await confirmedCollect(next.job,enrichment?collectEnrichment:collect);
      if(result.status==='AUTH_REQUIRED')log('Authentication failure repeated on the same subscribed route; shared group will pause.');
      persist(pending,result);await sleep(8000);
    }catch(e){log(e.message);if(!args.includes('--watch'))throw e;await sleep(30000);}
  }
  log('Completed '+done+' tasks; '+failures+' blocked or failed. This is not an all-source coverage claim.');
  if(failures)process.exitCode=2;
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={normalize,normalizeEnrichment,statusFor,collectEnrichment,runOpencliRead,confirmedCollect,authRecovered,proxyTunnelArgs};
