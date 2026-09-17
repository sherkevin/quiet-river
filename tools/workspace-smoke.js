#!/usr/bin/env node
'use strict';
// Read-only live smoke. No real user opens, tags, history or upstream refreshes are created.
const assert=require('node:assert/strict');
const {ApiClient,request}=require('../reader-bridge/network');
async function main(){
 if(!process.env.QR_ACCESS_TOKEN)throw new Error('Local authorization is required');
 const base='http://127.0.0.1:4380';
 const api=new ApiClient(base,{'X-Qr-Token':process.env.QR_ACCESS_TOKEN});
 for(const route of ['/desk/api/backend','/desk/api/history'])assert.equal((await request(base+route,{trusted:true})).status,401);
 const state=await api.call('/desk/api/state');assert.ok(Array.isArray(state.tags));
 const page=await api.call('/desk/api/entries?mode=latest&limit=10&order=desc');
 assert.ok(page.items.every(e=>Array.isArray(e.tags)));
 const required=page.items.find(e=>e.tags.length>=2)?.tags.slice(0,2)||[];
 if(required.length){const query=new URLSearchParams();for(const t of required)query.append('tag',t);
   const filtered=await api.call('/desk/api/entries?'+query.toString());
   assert.ok(filtered.items.every(e=>required.every(t=>e.tags.includes(t))));}
 const unread=await api.call('/desk/api/entries?unread=1&limit=10');assert.ok(unread.items.every(e=>e.status==='unread'));
 const backend=await api.call('/desk/api/backend');assert.equal(backend.activity.days.length,365);
 assert.ok(Array.isArray(backend.history.items));assert.ok(Array.isArray(backend.faults));
 const script=await request(base+'/desk/workspace-ui.js',{trusted:true});assert.equal(script.status,200);
 assert.ok(script.body.toString().includes('renderBackend'));
 console.log(JSON.stringify({sources:state.sources.length,articleCount:page.total,unread:unread.total,
   tagCount:state.tags.length,historyRows:backend.history.items.length,activityDays:backend.activity.days.length,
   updateIssues:backend.faults.length},null,2));
 console.log('PASS live read-only workspace, tag filters, unread, private history/activity and script delivery');
}
main().catch(e=>{console.error('Workspace smoke failed:',e.message);process.exitCode=1;});
