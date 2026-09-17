'use strict';
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

function isPublicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}

function publicLookup(hostname, options, cb) {
  dns.lookup(hostname, {all:true, family:4}, (err, records) => {
    if (err) return cb(err);
    if (!records.length || records.some(r => !isPublicIPv4(r.address))) return cb(new Error('SSRF: non-public address'));
    const address = records[0];
    if (options?.all) cb(null, records); else cb(null, address.address, 4);
  });
}

function redirectHeaders(headers, previous, next) {
  const result = {...headers};
  if (new URL(previous).origin !== new URL(next).origin) {
    for (const name of Object.keys(result)) {
      if (['authorization','proxy-authorization','cookie','x-auth-token'].includes(name.toLowerCase())) delete result[name];
    }
  }
  return result;
}

function request(url, {method='GET', headers={}, body, trusted=false, timeout=30000, maxBytes=8*1024*1024, redirects=3} = {}) {
  return new Promise((resolve,reject) => {
    let u;
    try {
      u = new URL(url);
      if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw new Error('unsupported or credential-bearing URL');
      const host = u.hostname.replace(/^\[|\]$/g,'');
      if (!trusted && net.isIP(host) && !isPublicIPv4(host)) throw new Error('SSRF: non-public or IPv6 address');
    } catch (e) {reject(e);return;}
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(u, {method,headers:{'Accept-Encoding':'identity',...headers},lookup:trusted?undefined:publicLookup, agent:false}, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (trusted || redirects <= 0) return reject(new Error('redirect not allowed for trusted API or limit exceeded'));
        const target = new URL(res.headers.location,u);
        const nextHeaders = redirectHeaders(headers,u.href,target.href);
        request(target.href,{method,headers:nextHeaders,body,timeout,maxBytes,redirects:redirects-1}).then(resolve,reject);
        return;
      }
      const chunks = []; let bytes=0;
      res.on('data', chunk => {bytes+=chunk.length;if(bytes>maxBytes) {res.destroy(new Error('response size exceeded'));return;}chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks),url:u.href}));
    });
    const timer = setTimeout(()=>req.destroy(new Error('request timeout')),timeout);timer.unref();
    req.on('close',()=>clearTimeout(timer));req.on('error',reject);
    if(body)req.write(body);req.end();
  });
}

class ApiClient {
  constructor(base, headers = {}) {this.base = base.replace(/\/$/,'');this.headers=headers;}
  async call(path, method='GET', payload, options={}) {
    const headers = {...this.headers,...options.headers};
    let body;
    if(payload !== undefined) {body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)); headers['Content-Type'] ||= 'application/json';headers['Content-Length']=body.length;}
    const result = await request(this.base+path,{trusted:true,method,headers,body,timeout:options.timeout||45000,maxBytes:options.maxBytes||16*1024*1024});
    if(result.status<200||result.status>=300) {const e=new Error(`upstream API ${method} ${path.split('?')[0]} returned ${result.status}`);e.status=result.status;throw e;}
    if(!result.body.length)return null;
    try{return JSON.parse(result.body.toString('utf8'));}catch{return result.body.toString('utf8');}
  }
}

module.exports = {redirectHeaders, request, isPublicIPv4, publicLookup, ApiClient};
