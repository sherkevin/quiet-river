'use strict';

// Design adapted from Agent-Reach's Channel abstraction (MIT), pinned at
// a19a171fa980a0785849596492e0af4db800c82f. See third_party/agent-reach/.
//
// Agent-Reach separates a stable capability from an ordered list of concrete
// backends and reports which backend is actually active. Quiet River keeps its
// existing persisted channels intact and applies the same model as an overlay.

const SUCCESS_STATES = new Set(['SUCCEEDED_NEW','SUCCEEDED_NO_NEW']);
const DEGRADED_STATES = new Set(['SUCCEEDED_PARTIAL','RUNNING','NEVER_CHECKED','COOLDOWN']);
const HARD_FAILURES = new Set(['AUTH_REQUIRED','ACCESS_BLOCKED','TIMEOUT','UPSTREAM_ERROR','UNSAFE_URL']);

const BACKENDS = Object.freeze({
  public: {id:'direct-feed', name:'Direct Feed', kind:'network', description:'Quiet River direct public RSS/Atom fetch'},
  native: {id:'quiet-river-native', name:'Quiet River Native', kind:'native', description:'Quiet River built-in metadata adapter'},
  desktop: {id:'opencli-shervin', name:'OpenCLI @ Shervin', kind:'desktop', description:'Desktop browser-session acquisition; credentials stay on Shervin'},
  rsshub: {id:'rsshub-ecs', name:'RSSHub @ ECS', kind:'service', description:'Self-hosted RSSHub adapter'},
  werss: {id:'werss-ecs', name:'WeRSS @ ECS', kind:'service', description:'Pinned WeRSS runtime for WeChat official accounts'},
  xiaohongshu_mcp: {id:'xiaohongshu-mcp-ecs', name:'xiaohongshu-mcp @ ECS', kind:'service', description:'Agent-Reach-style server fallback for Xiaohongshu using an explicitly configured local MCP service'},
  twitter_cli: {id:'twitter-cli-shervin', name:'twitter-cli @ Shervin', kind:'desktop', description:'Agent-Reach preferred Twitter author-timeline backend; requires explicit TWITTER_AUTH_TOKEN + TWITTER_CT0'},
  opencli_twitter: {id:'opencli-twitter-shervin', name:'OpenCLI Twitter @ Shervin', kind:'desktop', description:'Twitter/X browser-session fallback using the user-controlled Shervin Chrome session'},
  xgo_twitter: {id:'xgo-twitter-feed', name:'api.xgo.ing Twitter Feed', kind:'network', description:'Existing third-party Twitter RSS feed retained as migration fallback'},
});

// Ordered backend policies are intentionally separate from persisted channels.
// This lets Quiet River describe a future fallback before enabling it, exactly
// like Agent-Reach keeps an ordered candidate list independent of one runtime.
const CAPABILITY_POLICIES=Object.freeze({
  'xiaohongshu.notes':['opencli-shervin','xiaohongshu-mcp-ecs'],
  'twitter.author.posts':['twitter-cli-shervin','opencli-twitter-shervin','xgo-twitter-feed'],
});

function backendForTransport(transport) {
  const raw=String(transport||'unknown'),safe=raw.replace(/[^A-Za-z0-9._-]+/g,'-');
  return BACKENDS[raw] || {id:`transport:${safe}`,name:raw||'Unknown',kind:'unknown',description:'Unregistered Quiet River transport'};
}

function capabilityId(source, channel) {
  if(source.platform==='twitter')return 'twitter.author.posts';
  const label=String(channel.label||'feed').replace(/[^A-Za-z0-9._-]+/g,'-');
  return `${source.platform || 'unknown'}.${label}`;
}
function backendForChannel(source,channel){
  if(source?.platform==='twitter'&&channel.transport==='public'){
    try{if(new URL(channel.url).hostname==='api.xgo.ing')return BACKENDS.xgo_twitter;}catch{}
  }
  return backendForTransport(channel.transport);
}

function backendById(id){return Object.values(BACKENDS).find(b=>b.id===id)||{id,name:id,kind:'unknown',description:'Policy backend'};}
function policyCandidate(id,context={}){
  const backend=backendById(id),runtime=context.backendStatus?.[id];
  if(runtime&&['ok','warn','error','off'].includes(runtime.status))return {...backend,status:runtime.status,reason:String(runtime.reason||runtime.status),transport:null,channelId:null,enabled:runtime.status!=='off',state:runtime.state||'VIRTUAL'};
  return {...backend,status:'off',reason:'backend candidate is declared but not configured',transport:null,channelId:null,enabled:false,state:'NOT_CONFIGURED'};
}
function applyPolicy(capability,context={}){
  const policy=CAPABILITY_POLICIES[capability.id];if(!policy)return capability;
  const physical=new Map(capability.candidates.map(c=>[c.id,c])),ordered=[];
  for(const id of policy)ordered.push(physical.get(id)||policyCandidate(id,context));
  for(const candidate of capability.candidates)if(!policy.includes(candidate.id))ordered.push(candidate);
  return {...capability,candidates:ordered};
}

function candidateStatus(channel, context={},source=null) {
  const backend=backendForChannel(source,channel),collector=context.collector||null,state=channel.state||'UNKNOWN';
  let status='warn',reason=channel.error||state||'health not yet established';
  if(!channel.enabled||state==='NOT_CONFIGURED'){status='off';reason='backend is not configured/enabled';}
  else if(state==='AUTH_REQUIRED'){status='error';reason=channel.error||'credential group requires user re-authentication';}
  else if(channel.transport==='desktop'&&!collector?.online){status='warn';reason='Shervin collector is offline; queued work is retained';}
  else if(HARD_FAILURES.has(state)){status='warn';reason=channel.error||state;}
  else if(SUCCESS_STATES.has(state)){status='ok';reason='last acquisition check completed successfully';}
  else if(DEGRADED_STATES.has(state)){status='warn';reason=state==='SUCCEEDED_PARTIAL'?'last check returned only a partial upstream window':state==='NEVER_CHECKED'?'backend is configured but has not completed a check yet':state==='RUNNING'?'backend is currently checking':'backend is waiting for its cooldown window';}
  return {...backend,status,reason,transport:channel.transport,channelId:channel.id,enabled:!!channel.enabled,state};
}

function sourceCapabilities(source, channels, context={}) {
  const mine=channels.filter(c=>c.source_id===source.id);
  const grouped=new Map();
  for(const channel of mine){
    const id=capabilityId(source,channel),candidate=candidateStatus(channel,context,source);
    const label=id==='twitter.author.posts'?'author-posts':channel.label||'feed';
    if(!grouped.has(id))grouped.set(id,{id,sourceId:source.id,platform:source.platform,label,candidates:[]});
    grouped.get(id).candidates.push(candidate);
  }
  if(!mine.length)return [{id:`${source.platform||'unknown'}.unconfigured`,sourceId:source.id,platform:source.platform,label:'unconfigured',activeBackend:null,status:'off',candidates:[],reason:'no executable acquisition channel'}];
  return [...grouped.values()].map(raw=>{
    const cap=applyPolicy(raw,context);
    if(source.enabled===false)return {...cap,activeBackend:null,status:'off',reason:'source is paused'};
    // Same semantics as Agent-Reach: candidate order is meaningful. The first
    // actually usable backend is active; warn is still a degraded backend that
    // can retain/queue work, while off/error never pretends to be active.
    const active=cap.candidates.find(c=>c.status==='ok')||cap.candidates.find(c=>c.status==='warn')||null;
    const status=active?.status || (cap.candidates.some(c=>c.status==='error')?'error':'off');
    return {...cap,activeBackend:active?.id||null,status,reason:active?.reason||cap.candidates[0]?.reason||'no usable backend'};
  });
}

function capabilityReport(sources, channels, context={}) {
  const capabilities=sources.flatMap(source=>sourceCapabilities(source,channels,context));
  const byStatus=capabilities.reduce((acc,c)=>{acc[c.status]=(acc[c.status]||0)+1;return acc;},{});
  const activeBackends=[...new Set(capabilities.map(c=>c.activeBackend).filter(Boolean))].sort();
  return {capabilities,summary:{total:capabilities.length,byStatus,activeBackends}};
}

module.exports={BACKENDS,backendForTransport,capabilityId,candidateStatus,sourceCapabilities,capabilityReport};
