'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 凭证目录指向空临时目录：本机的 secrets/access-token.txt 不能渗进测试，
// 否则「没设口令」的用例永远不成立。
const EMPTY_SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-access-test-'));
process.env.QR_SECRETS_DIR = EMPTY_SECRETS;

const { parseCookies, guard, handleLogin } = require('../lib/access');

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
    },
    end(body) {
      if (body) this.body = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    },
  };
}

function sendJsonStub(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test('parseCookies 解析多值与 URL 编码', () => {
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies('qr_token=abc%3D%3D'), { qr_token: 'abc==' });
  assert.deepEqual(parseCookies('nope'), {});
});

test('没设口令时 guard 放行且不写响应', (t) => {
  t.after(() => {
    delete process.env.QR_ACCESS_TOKEN;
  });
  delete process.env.QR_ACCESS_TOKEN;
  const res = makeRes();
  const url = new URL('http://x/api/state');
  assert.equal(guard({ headers: {} }, res, url, sendJsonStub), true);
  assert.equal(res.statusCode, 0);
});

test('设了口令：无凭证时 API 给 401，浏览器路径给登录页', (t) => {
  t.after(() => {
    delete process.env.QR_ACCESS_TOKEN;
  });
  process.env.QR_ACCESS_TOKEN = 'sekret';

  const api = makeRes();
  assert.equal(guard({ headers: {} }, api, new URL('http://x/api/state'), sendJsonStub), false);
  assert.equal(api.statusCode, 401);

  const page = makeRes();
  assert.equal(guard({ headers: {} }, page, new URL('http://x/'), sendJsonStub), false);
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['Content-Type'], /text\/html/);
  assert.match(page.body, /<form/);
  assert.match(page.body, /action="\/login"/);
  // 没带过口令时不该先喊「不对」
  assert.doesNotMatch(page.body, /口令不对/);
});

test('错误口令被拒，且拒绝原因区分「没带」与「带错」', (t) => {
  t.after(() => {
    delete process.env.QR_ACCESS_TOKEN;
  });
  process.env.QR_ACCESS_TOKEN = 'sekret';
  const res = makeRes();
  const ok = guard({ headers: { cookie: 'qr_token=wrong' } }, res, new URL('http://x/'), sendJsonStub);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /口令不对/); // 登录页上给出可见的错误提示
});

test('口令相等但长度不同的前缀不被误判通过', (t) => {
  t.after(() => {
    delete process.env.QR_ACCESS_TOKEN;
  });
  process.env.QR_ACCESS_TOKEN = 'abcd';
  for (const attempt of ['abc', 'abcde', 'ABC']) {
    const res = makeRes();
    const ok = guard({ headers: { cookie: `qr_token=${attempt}` } }, res, new URL('http://x/'), sendJsonStub);
    assert.equal(ok, false, `不该放行：${attempt}`);
    assert.equal(res.statusCode, 403);
  }
  // 空 cookie 值等同于没带凭证：给登录页而不是喊「口令不对」
  const empty = makeRes();
  assert.equal(guard({ headers: { cookie: 'qr_token=' } }, empty, new URL('http://x/'), sendJsonStub), false);
  assert.equal(empty.statusCode, 200);
  assert.doesNotMatch(empty.body, /口令不对/);
});

test('正确 cookie 放行', (t) => {
  t.after(() => {
    delete process.env.QR_ACCESS_TOKEN;
  });
  process.env.QR_ACCESS_TOKEN = 'sekret';
  const res = makeRes();
  const ok = guard({ headers: { cookie: 'a=1; qr_token=sekret' } }, res, new URL('http://x/api/state'), sendJsonStub);
  assert.equal(ok, true);
  assert.equal(res.statusCode, 0);
});

test('?token= 正确时 302 到干净地址并落 cookie（用完即焚）', (t) => {
  t.after(() => {
    delete process.env.QR_ACCESS_TOKEN;
  });
  process.env.QR_ACCESS_TOKEN = 'sekret';
  const res = makeRes();
  const url = new URL('http://x/river/?token=sekret&page=2');
  assert.equal(guard({ headers: {} }, res, url, sendJsonStub), false);
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, /^\/river\/\?page=2$/);
  assert.match(res.headers['Set-Cookie'], /^qr_token=sekret; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
  // 地址栏里不该再留 token
  assert.equal(url.searchParams.has('token'), false);
});

test('?token= 错误时不发 cookie，直接拒', (t) => {
  t.after(() => {
    delete process.env.QR_ACCESS_TOKEN;
  });
  process.env.QR_ACCESS_TOKEN = 'sekret';
  const res = makeRes();
  assert.equal(guard({ headers: {} }, res, new URL('http://x/?token=nope'), sendJsonStub), false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers['Set-Cookie'], undefined);
});

test('POST /login：urlencoded 表单口令换 cookie，并跳回 back', async (t) => {
  t.after(() => {
    delete process.env.QR_ACCESS_TOKEN;
  });
  process.env.QR_ACCESS_TOKEN = 'sekret';

  const req = (body, ctype) => {
    const { Readable } = require('node:stream');
    const r = Readable.from([Buffer.from(body, 'utf8')]);
    r.headers = { 'content-type': ctype };
    r.method = 'POST';
    return r;
  };

  // 正确口令
  const ok = makeRes();
  await handleLogin(req('token=sekret&x=1', 'application/x-www-form-urlencoded'), ok, new URL('http://x/login?back=/sources'));
  assert.equal(ok.statusCode, 302);
  assert.equal(ok.headers.Location, '/sources');
  assert.match(ok.headers['Set-Cookie'], /^qr_token=sekret;/);

  // 错误口令：留在登录页并提示
  const bad = makeRes();
  await handleLogin(req('token=nope', 'application/x-www-form-urlencoded'), bad, new URL('http://x/login'));
  assert.equal(bad.statusCode, 403);
  assert.match(bad.body, /口令不对/);
  assert.equal(bad.headers['Set-Cookie'], undefined);

  // JSON 客户端也吃
  const js = makeRes();
  await handleLogin(req(JSON.stringify({ token: 'sekret' }), 'application/json'), js, new URL('http://x/login'));
  assert.equal(js.statusCode, 302);

  // back 只接受站内相对路径，挡开放重定向
  const evil = makeRes();
  await handleLogin(req('token=sekret', 'application/x-www-form-urlencoded'), evil, new URL('http://x/login?back=https://evil.example'));
  assert.equal(evil.headers.Location, '/');
  const evil2 = makeRes();
  await handleLogin(req('token=sekret', 'application/x-www-form-urlencoded'), evil2, new URL('http://x/login?back=//evil.example'));
  assert.equal(evil2.headers.Location, '/');
});

test('口令首尾的换行与空格被容忍（复制粘贴的常见污染）', async (t) => {
  t.after(() => {
    delete process.env.QR_ACCESS_TOKEN;
  });
  process.env.QR_ACCESS_TOKEN = 'sekret';
  const { Readable } = require('node:stream');
  const req = (body, ctype) => {
    const r = Readable.from([Buffer.from(body, 'utf8')]);
    r.headers = { 'content-type': ctype };
    r.method = 'POST';
    return r;
  };
  for (const dirty of ['token=sekret%0A', 'token=%20sekret%20%0A', 'token=sekret%0D%0A']) {
    const res = makeRes();
    await handleLogin(req(dirty, 'application/x-www-form-urlencoded'), res, new URL('http://x/login'));
    assert.equal(res.statusCode, 302, `该放行：${dirty}`);
  }
  // ?token= 路径同样容忍
  const q = makeRes();
  assert.equal(guard({ headers: {} }, q, new URL('http://x/?token=sekret%0A'), sendJsonStub), false);
  assert.equal(q.statusCode, 302);
});

test('GET /login 直接给登录页；未启用口令时 /login 回首页', async (t) => {
  t.after(() => {
    delete process.env.QR_ACCESS_TOKEN;
  });
  process.env.QR_ACCESS_TOKEN = 'sekret';
  const page = makeRes();
  const { Readable } = require('node:stream');
  const empty = Readable.from([]);
  empty.headers = {};
  empty.method = 'GET';
  await handleLogin(empty, page, new URL('http://x/login'));
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<form/);

  delete process.env.QR_ACCESS_TOKEN;
  const off = makeRes();
  await handleLogin(empty, off, new URL('http://x/login'));
  assert.equal(off.statusCode, 302);
  assert.equal(off.headers.Location, '/');
});

test('端到端：真实 http 服务上 token 换 cookie，之后裸访问也通', async (t) => {
  t.after(() => {
    delete process.env.QR_ACCESS_TOKEN;
  });
  process.env.QR_ACCESS_TOKEN = 'e2e-token';

  const hits = [];
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!guard(req, res, url, sendJsonStub)) return;
    hits.push(url.pathname);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('river');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => srv.close());

  // 1. 裸访问被拒
  const denied = await fetch(`${base}/api/state`);
  assert.equal(denied.status, 401);
  assert.equal(hits.length, 0);

  // 2. 带 token 访问 -> 302 + Set-Cookie，token 不进业务逻辑
  const login = await fetch(`${base}/?token=e2e-token`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /qr_token=e2e-token/);
  assert.equal(hits.length, 0);

  // 3. 拿 cookie 再访问，正常放行
  const cookie = setCookie.split(';')[0];
  const ok = await fetch(`${base}/api/state`, { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'river');
  assert.deepEqual(hits, ['/api/state']);
});
