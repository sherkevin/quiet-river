#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const fsp = require('node:fs/promises');
const store = require('./lib/store');
const { resolve, verifyFeed, relayPlatform } = require('./lib/resolve');
const { refreshAll, refreshOne, refreshAdapter } = require('./lib/refresh');
const { adapterPlatforms } = require('./lib/adapters');
const { toOpml } = require('./lib/opml');
const access = require('./lib/access');

const PUBLIC_DIR = path.join(__dirname, 'public');
// PORT 可以是逗号分隔的多个端口：不同网络对端口的放行策略互相矛盾
// （办公网代理只放 80、运营商网对未备案 80 丢包但放非标准端口），
// 同时监听让每种网络各取能通的那个。单端口写法保持兼容。
const PORTS = String(process.env.PORT || '4321')
  .split(',')
  .map((p) => Number(p.trim()))
  .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

async function statePayload() {
  const config = await store.loadConfig();
  const cache = await store.loadCache();
  const { items, problems } = store.buildRiver(config, cache);
  const fetched = Object.values(cache.feeds || {}).map((f) => f.fetchedAt || 0);
  return {
    settings: config.settings || {},
    subscriptions: config.subscriptions,
    tags: store.allTags(config),
    items,
    problems,
    lastRefresh: fetched.length ? Math.max(...fetched) : null,
    counts: {
      subscriptions: config.subscriptions.length,
      items: items.length,
      undated: items.filter((i) => !i.published).length,
    },
    // 哪些平台真的有可用适配器。登录态适配器（知乎、小红书）住在不发布的
    // lib/adapters.private.js 里，公开版本这张表不含它们，添加页也就不显示
    // 那两张来源卡——不显示比显示了再报错诚实。
    capabilities: { adapterPlatforms: adapterPlatforms() },
  };
}

async function handleApi(req, res, pathname) {
  const method = req.method.toUpperCase();
  if (process.env.QR_READ_ONLY === 'true' && method !== 'GET' && method !== 'HEAD') {
    return sendJson(res, 409, { error: '旧站已切换为只读档案，请到 /desk/ 刷新和管理订阅' });
  }

  if (pathname === '/api/state' && method === 'GET') {
    return sendJson(res, 200, await statePayload());
  }

  if (pathname === '/api/resolve' && method === 'POST') {
    const body = await readBody(req);
    const config = await store.loadConfig();
    const result = await resolve(body.url, { rsshubBase: config.settings?.rsshubBase || body.rsshubBase || '' });
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/subscriptions' && method === 'POST') {
    const body = await readBody(req);
    const config = await store.loadConfig();
    const cache = await store.loadCache();
    // Trailing slash / www / scheme differences must not create duplicates.
    const normUrl = (u) => String(u || '').replace(/\/+$/, '').replace(/^https?:\/\//, '').replace(/^www\./, '');

    let feeds = Array.isArray(body.feeds) ? body.feeds.filter((f) => typeof f === 'string' && f.trim()) : [];
    let meta = { platform: 'blog', platformLabel: '自定义', tier: 1 };
    let name = String(body.name || '').trim();
    let adapter = null;
    // 转发服务地址解析出来的作者主页（api.xgo.ing/rss/user/<hash> → x.com/<handle>）
    let homepage = '';

    // 直接贴 feed 地址时默认标「自定义」，但两类地址能认出真实平台，别让它们显示成
    // 「自定义」：RSSHub 路由的第一段就是平台名（…/bilibili/user/video/123 → bilibili），
    // 以及转发服务给的地址（api.xgo.ing/rss/user/<hash> → X / Twitter）。
    const rsshubBase = String(config.settings?.rsshubBase || '').replace(/\/+$/, '');
    if (feeds.length && rsshubBase && feeds[0].startsWith(rsshubBase)) {
      const seg = feeds[0].slice(rsshubBase.length).replace(/^\/+/, '').split('/')[0];
      const LABELS = { bilibili: 'B站', weibo: '微博', zhihu: '知乎', twitter: 'X / Twitter', xiaohongshu: '小红书' };
      if (seg) meta = { platform: seg, platformLabel: LABELS[seg] || seg, tier: 2 };
    }
    if (feeds.length) {
      const relay = relayPlatform(feeds[0]);
      if (relay) meta = relay;
    }

    if (body.url && body.url.trim()) {
      const trimmed = body.url.trim();
      // 重复判定要比到 feeds：转发服务地址解析出来之后，url 存的是作者主页
      // （x.com/<handle>），只比 url 的话，把同一条 api.xgo.ing 地址再贴一次
      // 就会被当成新源。
      const dupe = config.subscriptions.find(
        (s) => normUrl(s.url) === normUrl(trimmed) || (s.feeds || []).some((f) => normUrl(f) === normUrl(trimmed)),
      );
      if (dupe) return sendJson(res, 409, { error: `这个链接已经在清单里了：${dupe.name}` });

      if (!feeds.length) {
        const result = await resolve(trimmed, { rsshubBase: config.settings?.rsshubBase || '' });
        meta = { platform: result.platform, platformLabel: result.platformLabel, tier: result.tier };
        if (!name) name = result.name || '';
        homepage = result.homepage || '';
        if (result.adapter && result.ok) {
          adapter = result.adapter;
        } else {
          feeds = result.feeds.filter((f) => f.ok).map((f) => f.url);
          if (!feeds.length && !body.manual) {
            return sendJson(res, 422, {
              error: result.blocked || result.note || '没拿到可用 feed',
              platform: result.platform,
              platformLabel: result.platformLabel,
              tier: result.tier,
              tierLabel: result.tierLabel,
              attempts: result.feeds.map((f) => ({ url: f.url, error: f.error })),
            });
          }
        }
      }
    } else if (!feeds.length && !body.manual) {
      return sendJson(res, 400, { error: '至少给一个 url 或一个 feeds 地址' });
    }

    if (body.manual && !body.url && !feeds.length) {
      meta = { platform: body.platform || 'wechat', platformLabel: '公众号', tier: 3 };
    }

    if (!name) {
      return sendJson(res, 400, { error: body.manual ? '手动登记需要填名字' : '没能自动取到名字，请自己填一个' });
    }

    const sub = store.addSubscription(config, {
      name,
      url: homepage || String(body.url || '').trim() || feeds[0] || '',
      platform: meta.platform,
      platformLabel: meta.platformLabel,
      tier: meta.tier,
      tags: body.tags,
      feeds,
      adapter,
    });
    if (body.manual) sub.manual = true;
    await store.saveConfig(config);

    const results = [];
    if (sub.adapter) {
      const merged = await refreshAdapter(sub, cache);
      results.push({ feedUrl: `adapter:${sub.adapter.platform}`, ...merged });
    } else {
      for (const feedUrl of sub.feeds) {
        results.push({ feedUrl, ...(await refreshOne(feedUrl, cache)) });
      }
    }
    await store.saveCache(store.pruneCache(cache, config));

    return sendJson(res, 201, {
      subscription: sub,
      warning: body.manual && !sub.feeds.length ? '已登记，但暂时没有可抓的内容；以后拿到 RSS 地址可在编辑里补上' : undefined,
      fetched: results.map((r) => ({
        url: r.feedUrl,
        ok: !r.error,
        itemCount: r.itemCount || 0,
        sample: (r.items || []).slice(0, 3).map((i) => i.title),
        error: r.error,
      })),
    });
  }

  const subMatch = /^\/api\/subscriptions\/([\w-]+)$/.exec(pathname);
  if (subMatch) {
    const id = subMatch[1];
    const config = await store.loadConfig();
    const index = config.subscriptions.findIndex((s) => s.id === id);
    if (index === -1) return sendJson(res, 404, { error: '找不到这个订阅' });

    if (method === 'DELETE') {
      const [removed] = config.subscriptions.splice(index, 1);
      await store.saveConfig(config);
      const cache = await store.loadCache();
      store.pruneCache(cache, config);
      await store.saveCache(cache);
      return sendJson(res, 200, { removed: removed.name });
    }

    if (method === 'PATCH') {
      const body = await readBody(req);
      const sub = config.subscriptions[index];
      if (body.name !== undefined) sub.name = String(body.name).trim() || sub.name;
      if (body.tags !== undefined) sub.tags = store.normalizeTags(body.tags);
      if (body.disabled !== undefined) {
        if (body.disabled) sub.disabled = true;
        else delete sub.disabled;
      }
      if (body.feedUrl !== undefined) {
        const raw = String(body.feedUrl).trim();
        if (!raw) {
          sub.feeds = [];
          sub.manual = true;
        } else {
          const result = await resolve(raw, { rsshubBase: config.settings?.rsshubBase || '' });
          const okFeeds = result.feeds.filter((f) => f.ok).map((f) => f.url);
          if (!okFeeds.length && !result.adapter) {
            return sendJson(res, 422, { error: result.blocked || result.note || '这个地址抓不到 feed' });
          }
          store.applyResolvedFeed(sub, result, raw);
        }
      }
      await store.saveConfig(config);
      return sendJson(res, 200, { subscription: sub });
    }

    if (method === 'POST') {
      // POST on a single subscription = refresh just that one.
      const cache = await store.loadCache();
      const sub = config.subscriptions[index];
      const results = [];
      if (sub.adapter) {
        const merged = await refreshAdapter(sub, cache);
        results.push({ url: `adapter:${sub.adapter.platform}`, ok: !merged.error, itemCount: merged.itemCount || 0, error: merged.error });
      } else {
        for (const feedUrl of sub.feeds || []) {
          const r = await refreshOne(feedUrl, cache);
          results.push({ url: feedUrl, ok: !r.error, itemCount: r.itemCount || 0, error: r.error });
        }
      }
      await store.saveCache(store.pruneCache(cache, config));
      return sendJson(res, 200, { fetched: results });
    }
  }

  const itemMatch = /^\/api\/items\/([\w-]+)\/tags$/.exec(pathname);
  if (itemMatch && method === 'PATCH') {
    const body = await readBody(req);
    if (!Array.isArray(body.tags)) return sendJson(res, 400, { error: 'tags 必须是数组' });
    const config = await store.loadConfig();
    const clean = store.setItemTags(config, itemMatch[1], body.tags);
    await store.saveConfig(config);
    return sendJson(res, 200, { tags: clean });
  }

  if (pathname === '/api/refresh' && method === 'POST') {
    const body = await readBody(req);
    const summary = await guardedRefresh(body.force === true);
    return sendJson(res, 200, { ...summary, at: Date.now() });
  }

  if (pathname === '/api/verify' && method === 'POST') {
    const body = await readBody(req);
    if (!body.url) return sendJson(res, 400, { error: '缺 url' });
    return sendJson(res, 200, await verifyFeed(String(body.url).trim()));
  }

  if (pathname === '/api/settings' && method === 'PATCH') {
    const body = await readBody(req);
    const config = await store.loadConfig();
    config.settings = config.settings || {};
    if (body.rsshubBase !== undefined) {
      config.settings.rsshubBase = String(body.rsshubBase).trim().replace(/\/+$/, '');
    }
    if (body.refreshMinutes !== undefined) {
      const minutes = Number(body.refreshMinutes);
      config.settings.refreshMinutes = Number.isFinite(minutes) && minutes >= 1 ? Math.round(minutes) : 60;
    }
    if (body.githubUrl !== undefined) {
      const raw = String(body.githubUrl).trim();
      if (raw === '') {
        config.settings.githubUrl = '';
      } else if (/^https?:\/\//i.test(raw)) {
        config.settings.githubUrl = raw;
      } else {
        return sendJson(res, 400, { error: 'GitHub 链接要以 http(s):// 开头，或留空' });
      }
    }
    await store.saveConfig(config);
    // 间隔改了要重排服务端定时器，否则设置页保存了但定时器还是旧间隔。
    await scheduleServerAuto();
    return sendJson(res, 200, { settings: config.settings });
  }

  if (pathname === '/api/export' && method === 'GET') {
    const config = await store.loadConfig();
    const opml = toOpml(config);
    res.writeHead(200, {
      'Content-Type': 'text/x-opml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="quiet-river.opml"',
    });
    return res.end(opml);
  }

  return sendJson(res, 404, { error: `没有这个接口：${method} ${pathname}` });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  // 跨域支持：网页可以托管在别处（例如 GitHub Pages），数据走这里。
  // 自定义头 x-qr-token 会触发预检，OPTIONS 要在口令闸之前应答。
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Qr-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === '/login') {
      await access.handleLogin(req, res, url);
      return;
    }
    if (!access.guard(req, res, url, sendJson)) return;
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    if (req.method.toUpperCase() !== 'GET' && req.method.toUpperCase() !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
}

/* ---------- 服务端自动刷新 ----------
 * 自动刷新定时器原先住在网页里（app.js 的 setInterval）：关掉页面河就停流，
 * 「每天自动拉最新」只在页面开着时成立。挪到服务端后，进程活着就按设置里的
 * 间隔抓，与页面开不开无关；页面开着时它自己的定时器照旧负责「边看边新」。
 * 两路可能撞在同一分钟，所以共用一把在飞锁：后到的直接复用前一次的结果。 */
let refreshing = null;
function guardedRefresh(force) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const config = await store.loadConfig();
    const cache = await store.loadCache();
    const summary = await refreshAll(config, cache, { force });
    await store.saveCache(store.pruneCache(cache, config));
    return summary;
  })();
  return refreshing.finally(() => {
    refreshing = null;
  });
}

let autoTimer = null;
async function scheduleServerAuto() {
  if (autoTimer) clearInterval(autoTimer);
  if (process.env.QR_READ_ONLY === 'true') return;
  const config = await store.loadConfig();
  const minutes = Number(config.settings?.refreshMinutes || 0);
  if (!minutes || minutes < 1) return;
  autoTimer = setInterval(() => {
    guardedRefresh(false).catch((err) => {
      process.stderr.write(`自动刷新失败：${err.message}\n`);
    });
  }, minutes * 60000);
}

(async function main() {
  const seeded = await store.ensureSeed();
  await scheduleServerAuto();
  const bootConfig = await store.loadConfig();
  const bootMinutes = Number(bootConfig.settings?.refreshMinutes || 0);
  // 每个端口一个 server 实例，共用同一个 handler；某个端口被占用只警告
  // 不致命，其余端口照常服务（systemd 的 Restart 不会因此反复拉起）。
  let booted = 0;
  for (const port of PORTS) {
    const s = http.createServer(handleRequest);
    s.on('error', (err) => {
      process.stderr.write(`监听 ${HOST}:${port} 失败：${err.message}\n`);
    });
    s.listen(port, HOST, () => {
      booted += 1;
      if (booted === 1) printBanner();
      else process.stdout.write(`  追加监听  http://${HOST}:${port}\n`);
    });
  }

  function printBanner() {
    const lines = [
      '',
      `  quiet-river  →  ${PORTS.map((p) => `http://${HOST}:${p}`).join('  ')}`,
      `  配置文件  ${store.CONFIG_PATH}`,
      `  抓取缓存  ${store.CACHE_PATH}`,
    ];
    if (seeded) lines.push('  首次运行，已生成空的 subscriptions.json');
    lines.push(
      bootMinutes
        ? `  自动刷新  每 ${bootMinutes} 分钟（服务端，页面关着也抓）`
        : '  自动刷新  已关闭（设置里填分钟数开启）',
    );
    lines.push(
      access.readAccessToken()
        ? '  访问口令  已启用（打开 /?token=<口令> 登录后存成 cookie）'
        : '  访问口令  未设（暴露到回环之外前务必设 QR_ACCESS_TOKEN）',
    );
    lines.push('');
    process.stdout.write(`${lines.join('\n')}\n`);
  }
})().catch((err) => {
  process.stderr.write(`启动失败：${err.stack || err}\n`);
  process.exit(1);
});
