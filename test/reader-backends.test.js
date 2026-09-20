'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {backendIdForChannel,runBackend,listBackends,registerBackend}=require('../reader-bridge/acquisition-backends');

test('registry contains every persisted Quiet River transport backend',()=>{
  assert.deepEqual(listBackends(),['direct-feed','opencli-shervin','quiet-river-native','rsshub-ecs','werss-ecs']);
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
