#!/usr/bin/env node
'use strict';

// Quiet River zero-account Reddit Community reader.
// The browser is used only as a network/TLS transport. The RSS request itself
// uses credentials:'omit', so Reddit cookies are never sent to the feed endpoint.

const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');

const root=path.join(process.env.LOCALAPPDATA||os.homedir(),'QuietRiverCollector');
const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8').replace(/^\uFEFF/,''));
const community=String(process.argv[2]||'');
const limit=Math.max(1,Math.min(20,Number(process.argv[3])||20));
if(!/^[A-Za-z0-9_]{2,32}$/.test(community))throw new Error('Invalid Reddit community');
if(!config.opencliMain||!fs.existsSync(config.opencliMain))throw new Error('OpenCLI runtime not found');

async function main(){
  const opencliRoot=path.resolve(path.dirname(config.opencliMain),'..','..');
  const {Page}=await import(pathToFileURL(path.join(opencliRoot,'dist','src','browser','page.js')).href);
  const page=new Page('site:quiet-river-reddit-'+Date.now(),60000,undefined,'background','browser','ephemeral');
  try{
    // Chromium 152+ can reject navigation if the debugger was just detached.
    // Keeping network capture attached avoids that upstream race. Quiet River
    // never reads or exports capture records; this is navigation stabilization only.
    await page.startNetworkCapture('/r/');
    const navigate=()=>page.goto('https://www.reddit.com',{settleMs:600});
    try{await navigate();}catch(error){
      if(!/Navigation rejected/i.test(String(error?.message||error)))throw error;
      await new Promise(r=>setTimeout(r,250));await navigate();
    }
    const rows=await page.evaluate(`(async()=>{
      const community=${JSON.stringify(community)},limit=${limit},target=community.toLowerCase();
      const response=await fetch('/r/'+encodeURIComponent(community)+'/.rss?limit='+limit,{
        credentials:'omit',
        headers:{Accept:'application/atom+xml,application/xml,text/xml'}
      });
      if(!response.ok)throw new Error('HTTP '+response.status+' - Reddit anonymous RSS unavailable');
      const text=await response.text(),doc=new DOMParser().parseFromString(text,'application/xml');
      if(doc.querySelector('parsererror'))throw new Error('Invalid Reddit RSS XML');
      const out=[];
      for(const entry of [...doc.querySelectorAll('entry')].slice(0,limit)){
        const id=String(entry.querySelector('id')?.textContent||''),href=String(entry.querySelector('link')?.getAttribute('href')||'');
        const match=/^t3_([a-z0-9]+)$/i.exec(id);if(!match)continue;
        let u;try{u=new URL(href);}catch{continue}
        const pathMatch=new RegExp('^/r/([^/]+)/comments/'+match[1]+'(?:/[^/?#]+)?/?$','i').exec(u.pathname);
        if(!pathMatch||pathMatch[1].toLowerCase()!==target)continue;
        const title=String(entry.querySelector('title')?.textContent||'').trim();if(!title)continue;
        const rawContent=String(entry.querySelector('content')?.textContent||'');
        const htmlDoc=new DOMParser().parseFromString(rawContent,'text/html');
        const summary=String(htmlDoc.body?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,5000);
        const authorRaw=String(entry.querySelector('author name')?.textContent||'').trim();
        out.push({
          id:'t3_'+match[1].toLowerCase(),
          subreddit:pathMatch[1],
          author:authorRaw.replace(/^\\/?u\\//i,'').slice(0,100),
          title:title.slice(0,1000),
          summary,
          updated:String(entry.querySelector('updated')?.textContent||''),
          url:'https://www.reddit.com/r/'+pathMatch[1]+'/comments/'+match[1].toLowerCase()+'/'
        });
      }
      return out;
    })()`);
    if(!Array.isArray(rows))throw new Error('Reddit wrapper returned invalid data');
    process.stdout.write(JSON.stringify(rows));
  }finally{
    try{await page.closeWindow();}catch{}
  }
}
main().catch(error=>{console.error('reddit read failed: '+String(error?.message||error).slice(0,240));process.exit(70);});
