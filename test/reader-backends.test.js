'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {backendIdForChannel,runBackend,listBackends,registerBackend,probeBackend,doctorBackends}=require('../reader-bridge/acquisition-backends');

test('registry contains every persisted Quiet River transport backend',()=>{
  assert.deepEqual(listBackends(),['bilibili-public-detail-api','direct-feed','opencli-instagram-shervin','opencli-reddit-user-shervin','opencli-shervin','opencli-twitter-shervin','quiet-river-native','reddit-rss-shervin','rsshub-ecs','twitter-cli-shervin','v2ex-public-api','werss-ecs','xiaohongshu-mcp-ecs']);
  assert.equal(backendIdForChannel({transport:'public'}),'direct-feed');
  assert.equal(backendIdForChannel({transport:'desktop'}),'opencli-shervin');
});

test('direct-feed runner delegates to the existing public refresh contract',async()=>{
  const channel={id:'c',transport:'public'},seen=[];
  const service={refreshPublic:async c=>{seen.push(c);return 3;}};
  assert.equal(await runBackend(service,channel),3);
  assert.deepEqual(seen,[channel]);
});

test('native runner preserves partial-window semantics and imports each item',async()=>{
  const channel={id:'c',transport:'native'},imported=[];
  const service={
    fetchNative:async()=>({items:[{id:1},{id:2}],moreAvailable:true}),
    importItem:async(c,item)=>{imported.push([c.id,item.id]);return 1;}
  };
  assert.deepEqual(await runBackend(service,channel),{added:2,partial:true});
  assert.deepEqual(imported,[['c',1],['c',2]]);
});

test('desktop backend is explicitly worker-owned instead of silently executing on ECS',async()=>{
  await assert.rejects(runBackend({}, {transport:'desktop'}),/worker-owned by Shervin/);
});

test('registry supports later pluggable backend additions without editing ReaderService',async()=>{
  registerBackend('fixture-backend',async(_service,channel)=>channel.value);
  assert.ok(listBackends().includes('fixture-backend'));
  // Unknown transports map to transport:<name>; registration makes them runnable.
  registerBackend('transport:fixture',async(_service,channel)=>channel.value);
  assert.equal(await runBackend({}, {transport:'fixture',value:42}),42);
});

test('doctor reports unconfigured optional fallback without making a network request',async()=>{
  let calls=0;
  const service={config:{adapters:{}},internalFetch:async()=>{calls++;throw new Error('must not call');},desktop:{status:()=>({online:false})}};
  const result=await probeBackend(service,'xiaohongshu-mcp-ecs');
  assert.equal(result.status,'off');
  assert.equal(calls,0);
});

test('doctor only probes loopback runtime URLs',async()=>{
  let calls=0;
  const service={config:{adapters:{xiaohongshuMcp:'https://example.com/mcp'}},internalFetch:async()=>{calls++;return {status:200};}};
  const result=await probeBackend(service,'xiaohongshu-mcp-ecs');
  assert.equal(result.status,'error');
  assert.match(result.reason,/loopback/);
  assert.equal(calls,0);
});

test('doctor marks a loopback MCP runtime usable on any non-5xx HTTP response',async()=>{
  const seen=[];
  const service={config:{adapters:{xiaohongshuMcp:'http://127.0.0.1:18060/mcp'}},internalFetch:async(url,opts)=>{seen.push([url,opts]);return {status:405};}};
  const result=await probeBackend(service,'xiaohongshu-mcp-ecs');
  assert.equal(result.status,'ok');
  assert.equal(result.state,'READY');
  assert.deepEqual(seen[0][0],'http://127.0.0.1:18060');
  assert.equal(seen[0][1].trusted,true);
});

test('doctor combines built-in and runtime backend probes',async()=>{
  const service={config:{adapters:{}},internalFetch:async()=>{throw new Error('offline');},desktop:{status:()=>({online:true})}};
  const doctor=await doctorBackends(service);
  assert.equal(doctor.backends['opencli-shervin'].status,'ok');
  assert.equal(doctor.backends['direct-feed'].status,'ok');
  assert.equal(doctor.backends['xiaohongshu-mcp-ecs'].status,'off');
});

test('V2EX public API backend imports only the subscribed node with stable topic identity',async()=>{
 const channel={id:'v2',transport:'v2ex',v2ex_node:'python'},seen=[];
 const rows=[
  {id:101,title:'Python topic',url:'https://www.v2ex.com/t/101',content:'hello <script>x</script>',created:1700000000,node:{name:'python'},member:{username:'alice'}},
  {id:102,title:'Other node',url:'https://www.v2ex.com/t/102',content:'wrong node',created:1700000001,node:{name:'go'},member:{username:'bob'}}
 ];
 const service={
  internalFetch:async(url,opts)=>{assert.match(url,/node_name=python/);assert.equal(opts.trusted,false);return {status:200,body:Buffer.from(JSON.stringify(rows))};},
  importItem:async(c,item)=>{seen.push([c,item]);return 1;}
 };
 assert.equal(await runBackend(service,channel),1);
 assert.equal(seen.length,1);
 assert.equal(seen[0][1].guid,'v2ex:101');
 assert.equal(seen[0][1].link,'https://www.v2ex.com/t/101');
 assert.equal(seen[0][1].author,'alice');
 assert.equal(seen[0][1].published,1700000000000);
 assert.match(seen[0][1].content,/&lt;script&gt;/);
 assert.doesNotMatch(seen[0][1].content,/<script>/);
});
test('V2EX backend treats HTTP/JSON failures as acquisition failures rather than an empty timeline',async()=>{
 await assert.rejects(runBackend({internalFetch:async()=>({status:503,body:Buffer.from('')})},{transport:'v2ex',v2ex_node:'python'}),e=>e.status===503);
 await assert.rejects(runBackend({internalFetch:async()=>({status:200,body:Buffer.from('<html>bad</html>')})},{transport:'v2ex',v2ex_node:'python'}),/invalid JSON/);
});
