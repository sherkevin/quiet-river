#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { readSecret } = require('./secrets');

/* 一道可选的访问口令，只在把河暴露到本机回环之外时才需要。
 *
 * 背景：这个应用没有账号体系，任何能连上端口的人都能读也能改（添加、删除、
 * 打 tag 都是写操作）。只听 127.0.0.1 时这不是问题；一旦挂上公网隧道，
 * 它就是一个任何人都能改的匿名留言板。所以在隧道之前先补这一道。
 *
 * 用法：设 QR_ACCESS_TOKEN（或写进 secrets/access-token.txt），然后手机浏览器
 * 打开一次 http://<host>:<port>/?token=<口令> ——服务端把它落成 cookie 并 302
 * 回干净地址，之后同一浏览器不再需要带 token。不设口令时本模块完全放行，
 * 行为与从前一致（本机自用不受影响）。 */

const COOKIE_NAME = 'qr_token';
// 口令 cookie 的有效期：一年。手机上的河要长期能开，不想每周重贴一次 token。
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function readAccessToken() {
  return readSecret('access-token.txt', 'QR_ACCESS_TOKEN');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// 定长比较，避免按字节提前返回泄露口令长度与前缀。
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* 浏览器直接打开站点而没有 cookie 时，给一张能输入的登录页而不是一坨 JSON。
 * 表单 POST 到 /login，服务端校验后种 cookie 再跳回首页——这样手机上不用手动
 * 拼 ?token=，也避免把口令留在地址栏和浏览历史里。
 * 配色变量直接抄 public/style.css 的 :root / [data-theme=dark]，跟着系统主题走。 */
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>quiet river · 访问口令</title>
<style>
  :root { color-scheme: light dark; --bg:#faf9f5; --surface:#fffdf9; --ink:#191919;
    --muted:#6f6c64; --line:#e7e4dc; --accent:#c15f3c; --danger:#b03a2e;
    --font:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    --serif:"Tiempos Text",Georgia,"Times New Roman","Songti SC",serif; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#191919; --surface:#201f1e; --ink:#f0eee6; --muted:#9d988e;
      --line:#333130; --accent:#d97757; --danger:#e0887c; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:1.5rem;
    background:var(--bg); color:var(--ink); font-family:var(--font); line-height:1.6; }
  .card { width:100%; max-width:26rem; background:var(--surface); border:1px solid var(--line);
    border-radius:8px; padding:1.75rem 1.5rem; }
  .mark { display:block; width:.5rem; height:.5rem; border-radius:50%; background:var(--accent); margin:0 0 1rem; }
  h1 { font-family:var(--serif); font-size:1.4rem; font-weight:600; margin:0 0 .25rem; letter-spacing:0; }
  p.sub { margin:0 0 1.25rem; color:var(--muted); font-size:.875rem; }
  label { display:block; font-size:.8125rem; color:var(--muted); margin-bottom:.375rem; }
  input { width:100%; padding:.625rem .75rem; font:inherit; font-size:.9375rem; color:var(--ink);
    background:var(--bg); border:1px solid var(--line); border-radius:6px; }
  input:focus { outline:2px solid var(--accent); outline-offset:-1px; border-color:var(--accent); }
  button { width:100%; margin-top:1rem; padding:.625rem; font:inherit; font-size:.9375rem;
    font-weight:500; color:#fff; background:var(--accent); border:0; border-radius:6px; cursor:pointer; }
  button:hover { filter:brightness(1.06); }
  .err { margin:1rem 0 0; padding:.625rem .75rem; font-size:.8125rem; color:var(--danger);
    background:color-mix(in srgb, var(--danger) 9%, transparent); border-radius:6px; }
  .hint { margin:1.25rem 0 0; padding-top:1rem; border-top:1px solid var(--line);
    font-size:.75rem; color:var(--muted); }
</style>
</head>
<body>
<form class="card" method="POST" action="/login">
  <span class="mark"></span>
  <h1>quiet river</h1>
  <p class="sub">这条河设了访问口令，输入后在本浏览器记住一年。</p>
  <label for="t">访问口令</label>
  <input id="t" name="token" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">进入</button>
  __ERR__
  <p class="hint">口令来自服务端的 <code>QR_ACCESS_TOKEN</code> 或 <code>secrets/access-token.txt</code>。</p>
</form>
</body>
</html>`;

const ERR_BLOCK = (msg) => `<p class="err">${msg}</p>`;

function sendLogin(res, status, message) {
  const html = LOGIN_HTML.replace('__ERR__', message ? ERR_BLOCK(message) : '');
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function cookieHeader(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`;
}

/**
 * 校验一次请求。返回 true 表示放行，false 表示响应已经写完、调用方直接 return。
 * 需要拿到已解析好的 url（URL 实例）来读 query 里的 token。
 */
function guard(req, res, url, sendJson) {
  const token = readAccessToken();
  if (!token) return true; // 没设口令 = 不启用这道闸

  // trim：从聊天窗口/密码管理器复制口令极易带上看不见的换行或空格，
  // 而口令是 hex，不含合法空白，trim 不会误伤。
  const fromQuery = (url.searchParams.get('token') || '').trim();
  const fromCookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const presented = fromQuery || fromCookie || '';
  if (!sameSecret(presented, token)) {
    const isApi = url.pathname.startsWith('/api/');
    if (isApi) {
      sendJson(res, 401, {
        error: fromQuery || fromCookie
          ? '访问口令不对。检查 QR_ACCESS_TOKEN 的值，或清掉这个站点的 cookie 重来。'
          : '这条河设了访问口令。浏览器打开首页输入口令，或用 ?token=<口令> 登录。',
      });
      return false;
    }
    // 浏览器路径：给一张能输入的页面，而不是一坨 JSON。
    sendLogin(res, fromQuery || fromCookie ? 403 : 200,
      fromQuery || fromCookie ? '口令不对，再试一次。' : '');
    return false;
  }

  // query 里带的 token 用完即焚：落成 cookie，然后 302 回不带 token 的地址，
  // 免得口令留在地址栏、浏览器历史与服务端访问日志里。
  if (fromQuery && sameSecret(fromQuery, token)) {
    url.searchParams.delete('token');
    const qs = url.searchParams.toString();
    const target = url.pathname + (qs ? `?${qs}` : '');
    res.writeHead(302, {
      'Set-Cookie': cookieHeader(token),
      Location: target,
      'Cache-Control': 'no-store',
    });
    res.end();
    return false;
  }

  return true;
}

/** 处理 /login：表单口令换 cookie。调用方要在 access.guard 之前分派到这里。 */
async function handleLogin(req, res, url) {
  const token = readAccessToken();
  if (!token) {
    // 没启用口令时 /login 不该被访问；直接回首页。
    res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }
  if (req.method.toUpperCase() !== 'POST') {
    sendLogin(res, 200, '');
    return true;
  }
  // HTML 表单默认发 urlencoded，也兼容 JSON 客户端。
  const raw = await new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { req.destroy(); resolve(''); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
  let submitted = '';
  const ctype = String(req.headers['content-type'] || '');
  if (ctype.includes('application/json')) {
    try { submitted = String(JSON.parse(raw || '{}').token || ''); } catch { submitted = ''; }
  } else {
    submitted = new URLSearchParams(raw).get('token') || '';
  }
  submitted = submitted.trim();
  if (!sameSecret(submitted, token)) {
    sendLogin(res, 403, '口令不对，再试一次。');
    return true;
  }
  // 跳回来源页（只接受站内相对路径，挡掉开放重定向）。
  const back = String(url.searchParams.get('back') || '/');
  const target = back.startsWith('/') && !back.startsWith('//') ? back : '/';
  res.writeHead(302, {
    'Set-Cookie': cookieHeader(token),
    Location: target,
    'Cache-Control': 'no-store',
  });
  res.end();
  return true;
}

module.exports = { guard, handleLogin, readAccessToken, parseCookies, COOKIE_NAME, sameSecret };
