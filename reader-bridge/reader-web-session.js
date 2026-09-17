'use strict';
function setCookieLines(headers){
  if(typeof headers?.getSetCookie==='function')return headers.getSetCookie();
  const value=headers?.get?.('set-cookie');return value?[value]:[];
}
function absorb(jar,lines){
  for(const raw of lines){const pair=String(raw).split(';',1)[0],i=pair.indexOf('=');
    if(i>0)jar.set(pair.slice(0,i),pair.slice(i+1));}
}
function cookieHeader(jar){return [...jar].map(([k,v])=>k+'='+v).join('; ');}
function safeBase(value){
  const u=new URL(value);const loopback=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  if(!loopback||!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('reader web origin must be loopback');
  return u.origin;
}
function sessionCookies(lines){
  return lines.filter(line=>/^__Secure-next-auth\.session-token(?:\.\d+)?=/i.test(line)||/^next-auth\.session-token(?:\.\d+)?=/i.test(line))
    .map(line=>String(line).replace(/;\s*Domain=[^;]*/ig,''));
}
async function createReaderWebSession(config,fetchImpl=fetch){
  if(!config?.accessToken)throw new Error('reader web session requires site credential');
  const base=safeBase(config.karakeep),jar=new Map();
  let response=await fetchImpl(base+'/api/auth/csrf',{redirect:'manual'});
  if(!response.ok)throw new Error('reader web csrf unavailable');
  absorb(jar,setCookieLines(response.headers));const csrf=(await response.json()).csrfToken;
  if(!csrf)throw new Error('reader web csrf missing');
  const body=new URLSearchParams({csrfToken:csrf,email:'reader@quiet-river.local',password:config.accessToken,callbackUrl:base+'/',json:'true'});
  response=await fetchImpl(base+'/api/auth/callback/credentials',{method:'POST',redirect:'manual',
    headers:{'content-type':'application/x-www-form-urlencoded','cookie':cookieHeader(jar)},body});
  const returned=setCookieLines(response.headers);absorb(jar,returned);
  if(response.status<200||response.status>=400)throw new Error('reader web login rejected');
  const cookies=sessionCookies(returned);
  if(!cookies.length)throw new Error('reader web session cookie missing');
  const check=await fetchImpl(base+'/api/auth/session',{headers:{cookie:cookieHeader(jar)},redirect:'manual'});
  if(!check.ok)throw new Error('reader web session check failed');
  const session=await check.json();if(!session?.user)throw new Error('reader web session not authenticated');
  return cookies;
}
module.exports={createReaderWebSession,safeBase,sessionCookies};
