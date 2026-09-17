#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {normalize,statusFor}=require('./normalize.cjs');
const root=process.env.QR_COLLECTOR_HOME||path.join(process.env.LOCALAPPDATA||os.homedir(),'QuietRiverCollector');
const configPath=path.join(root,'config.json'),args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let config,locked=false;
function log(message){console.log(new Date().toLocaleString()+' '+message);}
function transport(message){
  const argv=['-T','-p',String(config.port||22),'-i',config.identityFile,
    '-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
    '-o','UserKnownHostsFile='+config.knownHostsFile,'-o','ConnectTimeout=10',
    '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',config.user+'@'+config.host,'collector'];
  const result=spawnSync(config.ssh||'ssh.exe',argv,{input:JSON.stringify(message),encoding:'utf8',
    timeout:150000,maxBuffer:1048576,windowsHide:true});
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
function collect(job){
  if(!['zhihu','xiaohongshu'].includes(job.platform)||!/^[-\w]+$/.test(job.authorId))throw new Error('Invalid job identity');
  const command=job.platform==='xiaohongshu'?'user':job.kind==='answers'?'user-answers':job.kind==='articles'?'user-articles':null;
  if(!command)throw new Error('Unsupported read-only command');
  const argv=[config.opencliMain,job.platform,command,job.authorId,'--limit',String(Math.min(20,job.limit||20)),'-f','json','--trace','off'];
  const r=spawnSync(process.execPath,argv,{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,
    env:{...process.env,OPENCLI_PROFILE:config.profile||process.env.OPENCLI_PROFILE||''}});
  if(r.error||r.status!==0)return {leaseId:job.leaseId,status:r.error?.code==='ETIMEDOUT'?'TIMEOUT':statusFor(r.status,r.stderr||r.error?.message||''),items:[]};
  try{return {leaseId:job.leaseId,status:'OK',items:normalize(job,JSON.parse(r.stdout.replace(/^\uFEFF/,'')))};}
  catch{return {leaseId:job.leaseId,status:'UPSTREAM_ERROR',items:[]};}
}
async function main(){
  if(args.includes('--help')){console.log('collector.cjs [--watch] [--max-jobs 20] [--platform zhihu|xiaohongshu] [--doctor]');return;}
  preflight();if(args.includes('--doctor'))return;acquire();
  const platforms=option('--platform','zhihu,xiaohongshu').split(',').filter(p=>['zhihu','xiaohongshu'].includes(p));
  if(!platforms.length)throw new Error('Choose a supported platform');
  const max=Math.max(1,Math.min(1000,Number(option('--max-jobs',args.includes('--watch')?'1000':'20'))||20));
  const pending=path.join(root,'pending-result.json');let done=0;
  while(done<max){
    try{
      if(fs.existsSync(pending)){
        const result=JSON.parse(fs.readFileSync(pending,'utf8'));
        try{const ack=transport({op:'submit',result});if(!ack.accepted)throw new Error('Missing acknowledgement');
          fs.unlinkSync(pending);log(`ECS accepted ${ack.received} records; ${ack.state}`);done++;
        }catch(e){if(e.status===409){fs.renameSync(pending,pending+'.expired-'+Date.now());log('Expired result retained locally; new collection required');}else throw e;}
        if(done>=max)break;
      }
      const next=transport({op:'claim',platforms});
      if(!next.job){
        if(!args.includes('--watch')){log('No currently eligible task. Cooling down or waiting for browser authorization is not a successful source check.');break;}
        await sleep(Math.max(15,Math.min(60,next.retryAfter||30))*1000);continue;
      }
      log('Checking '+next.job.platform+' / '+next.job.kind+' for a subscribed author');
      persist(pending,collect(next.job));await sleep(8000);
    }catch(e){log(e.message);if(!args.includes('--watch'))throw e;await sleep(30000);}
  }
  log('Completed '+done+' tasks. This is not an all-source coverage claim.');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={normalize,statusFor};
