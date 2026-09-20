'use strict';

// Backend runner registry inspired by Agent-Reach's ordered backend model
// (MIT, pinned reference a19a171fa980a0785849596492e0af4db800c82f).
// Quiet River keeps source/channel persistence stable while backend execution
// becomes replaceable behind a small registry contract.

const {ApiClient}=require('./network');
const {parseFullFeed,safeURL}=require('./core');
const {backendForTransport}=require('./capabilities');

const runners=new Map(),probes=new Map();

function registerBackend(id,runner){
  if(!/^[a-z0-9][a-z0-9._:-]*$/i.test(String(id))||typeof runner!=='function')throw new Error('invalid acquisition backend');
  runners.set(String(id),runner);
}

function registerProbe(id,probe){
  if(!/^[a-z0-9][a-z0-9._:-]*$/i.test(String(id))||typeof probe!=='function')throw new Error('invalid acquisition probe');
  probes.set(String(id),probe);
}

function backendIdForChannel(channel){
  return backendForTransport(channel.transport).id;
}

async function runBackend(service,channel){
  const id=backendIdForChannel(channel),runner=runners.get(id);
  if(!runner)throw new Error('not configured: acquisition backend '+id);
  return runner(service,channel);
}

function listBackends(){return [...new Set([...runners.keys(),...probes.keys()])].sort();}
async function probeBackend(service,id){
  const probe=probes.get(id);if(!probe)return {status:runners.has(id)?'ok':'off',reason:runners.has(id)?'built-in runner loaded':'no runtime probe registered'};
  try{return await probe(service);}catch(e){return {status:'error',reason:String(e.message||e).slice(0,240)};}
}
async function doctorBackends(service){
  const byId={};for(const id of listBackends())byId[id]=await probeBackend(service,id);
  return {observedAt:Date.now(),backends:byId};
}
async function probeLocalHttp(service,base){
  if(!base)return {status:'off',reason:'runtime URL is not configured'};
  let url;try{url=new URL(base);}catch{return {status:'error',reason:'runtime URL is invalid'};}
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','::1'].includes(url.hostname))return {status:'error',reason:'doctor only probes loopback runtimes'};
  const result=await service.internalFetch(url.origin,{trusted:true,timeout:3000,maxBytes:65536});
  return {status:result.status>=500?'warn':'ok',reason:`local runtime reachable (HTTP ${result.status})`,state:'READY'};
}

registerBackend('direct-feed',async(service,channel)=>service.refreshPublic(channel));

registerBackend('quiet-river-native',async(service,channel)=>{
  const result=await service.fetchNative(channel);let added=0;
  for(const item of result.items)added+=await service.importItem(channel,item);
  return {added,partial:result.moreAvailable};
});

async function adapterFeed(service,channel,{werss=false}={}){
  if(channel.browser&&!service.config.adapters?.browserEnabled)throw new Error('missing configuration: browser acceptance');
  const base=werss?service.config.adapters?.werss:service.config.adapters?.rsshub;
  if(!base||new URL(channel.url).origin!==new URL(base).origin)throw new Error('not configured: trusted adapter origin');
  if(werss){
    const a=service.config.adapters||{},auth=a.werssAK&&a.werssSK?`AK-SK ${a.werssAK}:${a.werssSK}`:a.werssToken?`Bearer ${a.werssToken}`:'';
    const wx=new ApiClient(base,auth?{Authorization:auth}:{});
    const result=await wx.call(`/api/v1/wx/mps/update/${encodeURIComponent(channel.mp_id)}?start_page=0&end_page=1`,'GET',undefined,{timeout:120000});
    if(result?.code&&![0,200].includes(result.code))throw new Error('WeRSS update did not confirm success');
  }
  const response=await service.internalFetch(channel.url,{trusted:true,timeout:channel.browser?120000:45000});
  if(response.status!==200){const error=new Error('adapter HTTP error');error.status=response.status;throw error;}
  const parsed=parseFullFeed(response.body.toString('utf8'),channel.url);let added=0;
  for(const item of parsed.items){if(!safeURL(item.link))continue;added+=await service.importItem(channel,item);}
  return added;
}

registerBackend('rsshub-ecs',(service,channel)=>adapterFeed(service,channel));
registerBackend('werss-ecs',(service,channel)=>adapterFeed(service,channel,{werss:true}));

// Desktop work is intentionally pull-owned by the Shervin collector. Keeping
// it in the registry makes the ownership boundary explicit and prevents the
// ECS scheduler from silently trying to execute browser-session work.
registerBackend('opencli-shervin',async()=>{throw new Error('desktop acquisition backend is worker-owned by Shervin');});

registerProbe('opencli-shervin',async service=>{const status=service.desktop?.status?.();return status?.online?{status:'ok',reason:'Shervin collector heartbeat is current',state:'READY'}:{status:'warn',reason:'Shervin collector is offline or has not checked in',state:'OFFLINE'};});
registerProbe('rsshub-ecs',service=>probeLocalHttp(service,service.config.adapters?.rsshub));
registerProbe('werss-ecs',service=>probeLocalHttp(service,service.config.adapters?.werss));
registerProbe('xiaohongshu-mcp-ecs',service=>probeLocalHttp(service,service.config.adapters?.xiaohongshuMcp));

module.exports={registerBackend,registerProbe,backendIdForChannel,runBackend,listBackends,probeBackend,doctorBackends};
