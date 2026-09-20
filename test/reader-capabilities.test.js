'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {backendForTransport,candidateStatus,sourceCapabilities,capabilityReport}=require('../reader-bridge/capabilities');

const source={id:'s1',name:'Author',platform:'xiaohongshu',enabled:true};
const baseChannel={id:'c1',source_id:'s1',label:'notes',transport:'desktop',url:'https://quiet-river.invalid/desktop/xiaohongshu/author/notes',group_key:'credential:xiaohongshu',interval_ms:21600000,min_gap_ms:8000,enabled:true,state:'SUCCEEDED_NO_NEW'};

test('transport registry exposes stable backend identities',()=>{
  assert.equal(backendForTransport('desktop').id,'opencli-shervin');
  assert.equal(backendForTransport('werss').id,'werss-ecs');
  assert.equal(backendForTransport('public').id,'direct-feed');
});

test('desktop capability reports OpenCLI active when Shervin is online',()=>{
  const caps=sourceCapabilities(source,[baseChannel],{collector:{online:true}});
  assert.equal(caps.length,1);
  assert.equal(caps[0].id,'xiaohongshu.notes');
  assert.equal(caps[0].activeBackend,'opencli-shervin');
  assert.equal(caps[0].status,'ok');
  assert.equal(caps[0].candidates[0].name,'OpenCLI @ Shervin');
});

test('offline desktop backend is degraded but remains the current routable backend',()=>{
  const candidate=candidateStatus(baseChannel,{collector:{online:false}});
  assert.equal(candidate.status,'warn');
  assert.match(candidate.reason,/offline/);
  const [cap]=sourceCapabilities(source,[baseChannel],{collector:{online:false}});
  assert.equal(cap.activeBackend,'opencli-shervin');
  assert.equal(cap.status,'warn');
});

test('credential failure does not pretend a backend is active',()=>{
  const channel={...baseChannel,state:'AUTH_REQUIRED',error:'reauth required'};
  const [cap]=sourceCapabilities(source,[channel],{collector:{online:true}});
  assert.equal(cap.activeBackend,null);
  assert.equal(cap.status,'error');
  assert.equal(cap.candidates[0].status,'error');
});

test('sources without physical channels remain explicit capabilities',()=>{
  const [cap]=sourceCapabilities({...source,id:'empty'},[],{});
  assert.equal(cap.activeBackend,null);
  assert.equal(cap.status,'off');
  assert.equal(cap.candidates.length,0);
  assert.match(cap.reason,/no executable/);
});

test('capability report summarizes active backends without dropping sources',()=>{
  const sources=[source,{id:'s2',name:'Feed',platform:'blog',enabled:true},{id:'s3',name:'Missing',platform:'wechat',enabled:true}];
  const channels=[
    baseChannel,
    {id:'c2',source_id:'s2',label:'rss',transport:'public',enabled:true,state:'SUCCEEDED_NO_NEW'}
  ];
  const report=capabilityReport(sources,channels,{collector:{online:true}});
  assert.equal(report.capabilities.length,3);
  assert.deepEqual(report.summary.activeBackends,['direct-feed','opencli-shervin']);
  assert.equal(report.summary.byStatus.ok,2);
  assert.equal(report.summary.byStatus.off,1);
});

test('configured but never-checked backend is visible as degraded rather than healthy',()=>{
  const [cap]=sourceCapabilities(source,[{...baseChannel,state:'NEVER_CHECKED'}],{collector:{online:true}});
  assert.equal(cap.status,'warn');
  assert.equal(cap.activeBackend,'opencli-shervin');
  assert.match(cap.reason,/not completed a check/);
});

test('paused source never reports an active backend even if its channel is healthy',()=>{
  const [cap]=sourceCapabilities({...source,enabled:false},[baseChannel],{collector:{online:true}});
  assert.equal(cap.status,'off');
  assert.equal(cap.activeBackend,null);
  assert.match(cap.reason,/paused/);
});

test('ReaderService health exposes the capability overlay without changing persisted channels',()=>{
  const {Database}=require('../reader-bridge/database');
  const {ReaderService}=require('../reader-bridge/service');
  const db=new Database(':memory:');
  try{
    db.putSource(source,[baseChannel]);
    db.run("UPDATE channels SET state='SUCCEEDED_NO_NEW',last_success=? WHERE id=?",Date.now(),baseChannel.id);
    const service=new ReaderService(db,{karakeep:'http://unused',adapters:{}},{mf:{call:async()=>[]}});
    service.desktop={status:()=>({online:true})};
    const health=service.health();
    assert.equal(health.channels.length,1);
    assert.equal(health.capabilities.length,1);
    assert.equal(health.capabilities[0].activeBackend,'opencli-shervin');
    assert.ok(health.capabilitySummary.activeBackends.includes('opencli-shervin'));
  }finally{db.close();}
});

test('Xiaohongshu capability declares Agent-Reach-style ordered fallback candidates',()=>{
  const [cap]=sourceCapabilities(source,[baseChannel],{collector:{online:true}});
  assert.deepEqual(cap.candidates.map(c=>c.id),['opencli-shervin','xiaohongshu-mcp-ecs']);
  assert.equal(cap.candidates[0].status,'ok');
  assert.equal(cap.candidates[1].status,'off');
  assert.match(cap.candidates[1].reason,/not configured/);
  assert.equal(cap.activeBackend,'opencli-shervin');
});

test('declared fallback is not treated as usable until its own probe says so',()=>{
  const failed={...baseChannel,state:'AUTH_REQUIRED'};
  const [withoutFallback]=sourceCapabilities(source,[failed],{collector:{online:true}});
  assert.equal(withoutFallback.activeBackend,null);
  assert.equal(withoutFallback.status,'error');

  const [withFallback]=sourceCapabilities(source,[failed],{
    collector:{online:true},
    backendStatus:{'xiaohongshu-mcp-ecs':{status:'ok',reason:'local MCP probe passed',state:'READY'}}
  });
  assert.equal(withFallback.activeBackend,'xiaohongshu-mcp-ecs');
  assert.equal(withFallback.status,'ok');
  assert.equal(withFallback.candidates[1].reason,'local MCP probe passed');
});

test('explicit doctor can promote a probed fallback without mutating persisted channel state',async()=>{
  const {Database}=require('../reader-bridge/database');
  const {ReaderService}=require('../reader-bridge/service');
  const db=new Database(':memory:');
  try{
    const authFailed={...baseChannel,state:'AUTH_REQUIRED',error:'reauth required'};
    db.putSource(source,[authFailed]);
    db.run("UPDATE channels SET state='AUTH_REQUIRED',error='reauth required' WHERE id=?",authFailed.id);
    const service=new ReaderService(db,{karakeep:'http://unused',adapters:{xiaohongshuMcp:'http://127.0.0.1:18060/mcp'}},{
      mf:{call:async()=>[]},
      internalFetch:async()=>({status:405,body:Buffer.alloc(0),headers:{}})
    });
    service.desktop={status:()=>({online:true})};
    const before=db.get('SELECT state,error FROM channels WHERE id=?',authFailed.id);
    const doctor=await service.acquisitionDoctor();
    const cap=doctor.capabilities.find(c=>c.id==='xiaohongshu.notes');
    assert.equal(cap.activeBackend,'xiaohongshu-mcp-ecs');
    assert.equal(cap.status,'ok');
    assert.equal(doctor.backends['xiaohongshu-mcp-ecs'].status,'ok');
    assert.deepEqual(db.get('SELECT state,error FROM channels WHERE id=?',authFailed.id),before);
  }finally{db.close();}
});


test('Twitter xgo feed is normalized into one stable author-posts capability',()=>{
  const source={id:'tw1',name:'Author',platform:'twitter',url:'https://x.com/karpathy',enabled:true};
  const channel={id:'twc',source_id:'tw1',label:'https://api.xgo.ing/rss/user/abc',transport:'public',url:'https://api.xgo.ing/rss/user/abc',enabled:true,state:'SUCCEEDED_NO_NEW'};
  const [cap]=sourceCapabilities(source,[channel],{});
  assert.equal(cap.id,'twitter.author.posts');
  assert.equal(cap.label,'author-posts');
  assert.deepEqual(cap.candidates.map(c=>c.id),['twitter-cli-shervin','opencli-twitter-shervin','xgo-twitter-feed']);
  assert.equal(cap.candidates[2].status,'ok');
  assert.equal(cap.activeBackend,'xgo-twitter-feed');
});

test('Twitter direct backend can outrank xgo only after its own probe passes',()=>{
  const source={id:'tw1',name:'Author',platform:'twitter',url:'https://x.com/karpathy',enabled:true};
  const channel={id:'twc',source_id:'tw1',label:'https://api.xgo.ing/rss/user/abc',transport:'public',url:'https://api.xgo.ing/rss/user/abc',enabled:true,state:'SUCCEEDED_NO_NEW'};
  const [before]=sourceCapabilities(source,[channel],{});
  assert.equal(before.activeBackend,'xgo-twitter-feed');
  const [after]=sourceCapabilities(source,[channel],{backendStatus:{
    'twitter-cli-shervin':{status:'ok',reason:'explicit credentials + user-posts canary passed',state:'READY'}
  }});
  assert.equal(after.activeBackend,'twitter-cli-shervin');
  assert.equal(after.candidates[1].status,'off');
  assert.equal(after.candidates[2].status,'ok');
});

test('V2EX community capability maps to its dedicated public API backend',()=>{
 const community={id:'v2',name:'V2EX Python',platform:'v2ex',sourceType:'community',enabled:true};
 const channel={id:'v2c',source_id:'v2',label:'community.posts',transport:'v2ex',enabled:true,state:'SUCCEEDED_NO_NEW',v2ex_node:'python'};
 const [cap]=sourceCapabilities(community,[channel],{});
 assert.equal(cap.id,'v2ex.community.posts');
 assert.equal(cap.activeBackend,'v2ex-public-api');
 assert.equal(cap.status,'ok');
 assert.equal(cap.candidates[0].name,'V2EX Public API');
});

test('Instagram capability is platform-gated instead of inheriting generic Shervin health',()=>{
  const ig={id:'ig',name:'NASA',platform:'instagram',enabled:true};
  const channel={...baseChannel,id:'ig-c',source_id:'ig',label:'posts',group_key:'credential:instagram',state:'NEVER_CHECKED'};
  const [blocked]=sourceCapabilities(ig,[channel],{collector:{online:true},backendStatus:{'opencli-instagram-shervin':{status:'off',reason:'login canary missing',state:'UNVERIFIED'}}});
  assert.equal(blocked.id,'instagram.posts');assert.equal(blocked.activeBackend,null);assert.equal(blocked.status,'off');assert.equal(blocked.candidates[0].id,'opencli-instagram-shervin');
  const [ready]=sourceCapabilities(ig,[channel],{collector:{online:true},backendStatus:{'opencli-instagram-shervin':{status:'ok',reason:'read-only canary passed',state:'READY'}}});
  assert.equal(ready.activeBackend,'opencli-instagram-shervin');assert.equal(ready.status,'warn');assert.match(ready.reason,/not completed a check/);
});

test('Instagram becomes healthy only after both backend canary and a real channel success',()=>{
  const ig={id:'ig',name:'NASA',platform:'instagram',enabled:true};
  const channel={...baseChannel,id:'ig-c',source_id:'ig',label:'posts',group_key:'credential:instagram',state:'SUCCEEDED_NO_NEW'};
  const [cap]=sourceCapabilities(ig,[channel],{collector:{online:true},backendStatus:{'opencli-instagram-shervin':{status:'ok',reason:'read-only canary passed',state:'READY'}}});
  assert.equal(cap.activeBackend,'opencli-instagram-shervin');assert.equal(cap.status,'ok');
});

test('Reddit community capability uses the dedicated zero-account RSS backend',()=>{
 const community={id:'rd1',name:'r/LocalLLaMA',platform:'reddit',sourceType:'community',enabled:true};
 const channel={id:'rdc',source_id:'rd1',label:'community.posts',transport:'desktop',enabled:true,state:'SUCCEEDED_NO_NEW'};
 const [cap]=sourceCapabilities(community,[channel],{collector:{online:true}});
 assert.equal(cap.id,'reddit.community.posts');
 assert.deepEqual(cap.candidates.map(c=>c.id),['reddit-rss-shervin']);
 assert.equal(cap.activeBackend,'reddit-rss-shervin');assert.equal(cap.status,'ok');
 assert.equal(cap.candidates[0].name,'Reddit RSS @ Shervin');
});
