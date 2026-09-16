'use strict';
// 单链接中继：把任意请求原样转给 ECS 上的 quiet-river。
// FC 3.0 内置 Node 运行时的契约：handler(event, context) 返回
// {statusCode, headers, body, isBase64Encoded}；event 是含 rawPath/headers/
// body/queryParameters 的对象（或它的 JSON 串）。
const http = require('http');
const TARGET = process.env.QR_TARGET || 'http://182.92.11.100:4321';

function relay(event) {
  return new Promise((resolve) => {
    const headers = Object.assign({}, event.headers || {});
    delete headers.host;
    delete headers['content-length'];
    delete headers['transfer-encoding'];

    let body = null;
    if (event.body !== undefined && event.body !== null && event.body !== '') {
      body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body);
      headers['content-length'] = String(body.length);
    }

    let qs = '';
    const qp = event.queryParameters || {};
    const parts = [];
    for (const k of Object.keys(qp)) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(qp[k]));
    if (parts.length) qs = '?' + parts.join('&');
    const target = TARGET + (event.rawPath || '/') + qs;
    // method 不在事件顶层，在 requestContext.http.method
    const method = event.method
      || (event.requestContext && event.requestContext.http && event.requestContext.http.method)
      || 'GET';

    const proxy = http.request(target, { method, headers }, (up) => {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const out = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (k === 'transfer-encoding' || k === 'connection' || k === 'keep-alive') continue;
          // FC 网关自己会按请求的 Origin 注入一整套 CORS 头。后端也发了一套，
          // 两套叠在一起浏览器直接判定非法（Access-Control-Allow-Origin 出现
          // 两次即失败），所以这里丢掉后端那份，只留网关的。
          if (k.startsWith('access-control-')) continue;
          out[k] = v;
        }
        // FC 网关把数组值序列化成 JSON 串（Set-Cookie: ["..."]），浏览器不认；
        // 单值头一律转字符串（本项目只有一个 qr_token cookie）
        for (const k of Object.keys(out)) {
          if (Array.isArray(out[k])) out[k] = out[k].join(', ');
        }
        if (Array.isArray(out['set-cookie'])) out['set-cookie'] = out['set-cookie'][0];
        // FC 默认域名禁止任何 3xx 重定向（ExternalRedirectForbidden，连指向
        // 自己都拦）。把重定向降级成 200 + meta refresh：Set-Cookie 照旧下发，
        // 浏览器跟着 meta 走。Location 改写成中继自己的绝对地址。
        if (up.statusCode >= 300 && up.statusCode < 400 && out.location) {
          const relayHost = (event.requestContext && event.requestContext.domainName) || (event.headers && event.headers.host) || '';
          const relayOrigin = relayHost ? `https://${relayHost}` : TARGET;
          let loc = out.location;
          if (loc.startsWith('/')) loc = relayOrigin + loc;
          else if (loc.startsWith(TARGET)) loc = relayOrigin + loc.slice(TARGET.length);
          const esc = loc.replace(/"/g, '&quot;');
          delete out.location;
          delete out['content-length'];
          delete out['content-type'];
          out['content-type'] = 'text/html; charset=utf-8';
          const html = `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${esc}"><a href="${esc}">continue</a>`;
          resolve({ statusCode: 200, headers: out, body: Buffer.from(html, 'utf8').toString('base64'), isBase64Encoded: true });
          return;
        }
        const buf = Buffer.concat(chunks);
        // 空 body 不能标 isBase64Encoded（FC 网关会 400）；非空才 base64，
        // 保证字体等二进制内容不被 utf8 解码损坏
        resolve(buf.length
          ? { statusCode: up.statusCode, headers: out, body: buf.toString('base64'), isBase64Encoded: true }
          : { statusCode: up.statusCode, headers: out, body: '' });
      });
    });
    proxy.on('error', (e) => {
      resolve({ statusCode: 502, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'relay error: ' + e.message });
    });
    if (body) proxy.write(body);
    proxy.end();
  });
}

exports.handler = async function (event, context) {
  // FC 的 Node 运行时把 HTTP 事件以 Buffer 传进来（里面是 JSON 串）
  if (Buffer.isBuffer(event)) event = event.toString('utf8');
  if (typeof event === 'string') {
    try { event = JSON.parse(event); } catch { event = { rawPath: '/' }; }
  }
  if (event.rawPath === '/healthz') {
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, target: TARGET, keys: Object.keys(event), host: (event.headers || {}).host, rc: event.requestContext }) };
  }
  return relay(event);
};
