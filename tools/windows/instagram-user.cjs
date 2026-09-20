#!/usr/bin/env node
'use strict';

// Quiet River read-only Instagram author wrapper.
// Reuses the installed OpenCLI Browser Bridge and the same read-only endpoint
// used by OpenCLI's instagram user adapter, but retains stable media identity
// fields required by a persistent subscription system.

const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');

const root=path.join(process.env.LOCALAPPDATA||os.homedir(),'QuietRiverCollector');
const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8').replace(/^\uFEFF/,''));
const username=String(process.argv[2]||'');
const limit=Math.max(1,Math.min(20,Number(process.argv[3])||12));
if(!/^[A-Za-z0-9._]{1,30}$/.test(username))throw new Error('Invalid Instagram username');
if(!config.opencliMain||!fs.existsSync(config.opencliMain))throw new Error('OpenCLI runtime not found');

async function main(){
  const opencliRoot=path.resolve(path.dirname(config.opencliMain),'..','..');
  const pageModule=path.join(opencliRoot,'dist','src','browser','page.js');
  const {Page}=await import(pathToFileURL(pageModule).href);
  const page=new Page('site:quiet-river-instagram-'+Date.now(),60000,undefined,'background','browser','ephemeral');
  try{
    const navigate=()=>page.goto('https://www.instagram.com',{settleMs:1000});
    try{await navigate();}catch(error){
      if(!/Navigation rejected/i.test(String(error?.message||error)))throw error;
      await new Promise(r=>setTimeout(r,250));await navigate();
    }
    const rows=await page.evaluate(`(async () => {
      const username=${JSON.stringify(username)},limit=${limit};
      const response=await fetch(
        'https://www.instagram.com/api/v1/feed/user/'+encodeURIComponent(username)+'/username/?count='+limit,
        {credentials:'include',headers:{'X-IG-App-ID':'936619743392459'}}
      );
      if(!response.ok)throw new Error('HTTP '+response.status+' - Instagram login required');
      const data=await response.json(),target=username.toLowerCase(),out=[];
      for(const media of (data?.items||[]).slice(0,limit)){
        const author=String(media?.user?.username||'');
        if(!author||author.toLowerCase()!==target)continue;
        const id=String(media?.pk||''),code=String(media?.code||'');
        if(!/^\\d{1,30}$/.test(id)||!/^[A-Za-z0-9_-]{5,32}$/.test(code))continue;
        const kind=media.media_type===2?'reel':'p';
        out.push({
          id,code,author,
          caption:String(media?.caption?.text||'').slice(0,5000),
          taken_at:Number(media?.taken_at)||0,
          media_type:Number(media?.media_type)||0,
          url:'https://www.instagram.com/'+kind+'/'+code+'/'
        });
      }
      return out;
    })()`);
    if(!Array.isArray(rows))throw new Error('Instagram wrapper returned invalid data');
    process.stdout.write(JSON.stringify(rows));
  }finally{
    try{await page.closeWindow();}catch{}
  }
}
main().catch(error=>{console.error('instagram read failed: '+String(error?.message||error).slice(0,240));process.exit(70);});
