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
