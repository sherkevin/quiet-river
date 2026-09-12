'use strict';

const { get } = require('./http');
const { parseFeed, looksLikeFeed } = require('./feeds');
const { adapters, adapterCacheKey } = require('./adapters');

const KEEP_ITEMS = 60;
const CONCURRENCY = 4;
const MAX_CONSECUTIVE_FAILS = 3;

// 同一宿主两次请求之间的最小间隔。同域串行只保证不并发，不保证不打得太密：
// 知乎 2026-09-11 实测约 17 次请求 / 15 秒就 403；Reddit 自 2026-06 起全局限流约 1 次/分钟。
const HOST_MIN_GAP_MS = {
  'adapter:zhihu': 8000,
  'reddit.com': 60000,
  'www.reddit.com': 60000,
};

// 同一宿主的最小重抓周期——和上面那把旋钮解决的是不同问题。
// 光调请求间隔治不了根：14 个知乎源每轮就是 28 个请求，间隔调到不触限流就慢得没法用。
// 但知乎的文章与回答不是按分钟变的，一天抓几次足够，所以自动刷新直接跳过还新鲜的源。
// 手动点「刷新」是「我现在就要」，force 会忽略这条。
const HOST_MIN_RECHECK_MS = {
  'adapter:zhihu': 6 * 60 * 60 * 1000,
  'reddit.com': 30 * 60 * 1000,
  'www.reddit.com': 30 * 60 * 1000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function refreshAdapter(sub, cache) {
  const adapter = adapters.find((a) => a.platform === sub.adapter.platform);
  const key = adapterCacheKey(sub.adapter.platform, sub.adapter.id);
  const startedAt = Date.now();
  if (!adapter) {
    return mergeIntoCache(cache, key, { fetchedAt: startedAt, error: `未知适配器 ${sub.adapter.platform}`, items: [] });
  }
  try {
    const fetched = await adapter.fetchItems(sub.adapter.id);
    return mergeIntoCache(cache, key, {
      fetchedAt: startedAt,
      error: null,
      feedTitle: fetched.name,
      itemCount: fetched.items.length,
      items: fetched.items.slice(0, KEEP_ITEMS),
    });
  } catch (err) {
    return mergeIntoCache(cache, key, {
      fetchedAt: startedAt,
      error: err.name === 'AbortError' ? '请求超时（40 秒）' : String(err.message || err),
      items: [],
    });
  }
}

async function fetchOne(feedUrl, extraHeaders) {
  const startedAt = Date.now();
  try {
    const res = await get(feedUrl, {
      timeoutMs: 40000,
      accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
      headers: extraHeaders,
    });
    if (!res.ok) return { fetchedAt: startedAt, error: `HTTP ${res.status}`, items: [] };
    if (!looksLikeFeed(res.body, res.contentType)) {
      return { fetchedAt: startedAt, error: '返回的不是 feed（可能是登录页、风控页或 404 软页）', items: [] };
    }
    const parsed = parseFeed(res.body, res.finalUrl || feedUrl);
    const items = parsed.items
      .slice(0, KEEP_ITEMS)
      .map((i) => ({
        guid: i.guid,
        title: i.title,
        link: i.link,
        author: i.author,
        published: i.published,
        summary: i.summary,
        image: i.image,
      }));
    return {
      fetchedAt: startedAt,
      error: null,
      feedTitle: parsed.feedTitle,
      itemCount: items.length,
      items,
    };
  } catch (err) {
    const reason = err.name === 'AbortError' ? '请求超时（40 秒）' : String(err.message || err);
    return { fetchedAt: startedAt, error: reason, items: [] };
  }
}

// A failed fetch must not wipe the last good items: a flaky network should
// show up as a problem banner, not as a hole in the river.
function mergeIntoCache(cache, feedUrl, result) {
  const previous = cache.feeds[feedUrl];
  const failCount = result.error ? (previous?.failCount || 0) + 1 : 0;
  if (result.error && previous && Array.isArray(previous.items) && previous.items.length) {
    cache.feeds[feedUrl] = {
      ...previous,
      fetchedAt: result.fetchedAt,
      error: result.error,
      failCount,
    };
  } else {
    cache.feeds[feedUrl] = { ...result, failCount };
  }
  return cache.feeds[feedUrl];
}

/** Refresh every feed referenced by the config, bounded concurrency. */
async function refreshAll(config, cache, { credentials = {}, onProgress, force = false } = {}) {
  const targets = [];
  for (const sub of config.subscriptions) {
    // 关闭展示的博主不抓：省下的请求都花在真要看的源上。缓存条目保留，
    // 重新开启时上次的内容立刻回来；要立即拉新走单订阅刷新接口。
    if (sub.disabled) continue;
    if (sub.adapter) {
      targets.push({
        sub,
        key: adapterCacheKey(sub.adapter.platform, sub.adapter.id),
        host: `adapter:${sub.adapter.platform}`,
      });
      continue;
    }
    for (const feedUrl of sub.feeds || []) {
      if (targets.some((t) => t.key === feedUrl)) continue;
      let host;
      try { host = new URL(feedUrl).hostname; } catch { host = feedUrl; }
      targets.push({ feedUrl, key: feedUrl, headers: credentials[sub.platform] || credentials[feedUrl], host });
    }
  }

  // 两条跳过规则的含义不同，所以对 force 的态度也不同：
  // failCount 是「它坏了」——点「刷新」本来就是要重试坏的，force 忽略它；
  // 重抓周期是「这个平台没必要抓这么勤」——这跟谁触发无关，force 也照样尊重，
  // 否则每次手动刷新都要走 28 个知乎请求换来一串 403。
  const now = Date.now();
  const active = targets.filter((t) => {
    const entry = cache.feeds[t.key];
    if (!force && (entry?.failCount || 0) >= MAX_CONSECUTIVE_FAILS) return false;
    const period = HOST_MIN_RECHECK_MS[t.host] || 0;
    if (period && entry && !entry.error && now - (entry.fetchedAt || 0) < period) return false;
    return true;
  });

  let cursor = 0;
  let done = 0;

  // Same host serial, different hosts parallel: Reddit rate-limits all RSS to
  // ~1 request/min per IP since 2026-06, so blasting one host concurrently
  // fails the whole batch.
  const byHost = new Map();
  for (const t of active) {
    if (!byHost.has(t.host)) byHost.set(t.host, []);
    byHost.get(t.host).push(t);
  }
  const hostQueues = [...byHost.values()];
  const workerCount = Math.min(CONCURRENCY, hostQueues.length);

  // 每个宿主队列只由一个 worker 独占，所以这张时间表不需要加锁。
  const lastRequestAt = new Map();

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= hostQueues.length) return;
      for (const entry of hostQueues[index]) {
        const gap = HOST_MIN_GAP_MS[entry.host] || 0;
        if (gap) {
          const wait = (lastRequestAt.get(entry.host) || 0) + gap - Date.now();
          if (wait > 0) await sleep(wait);
        }
        lastRequestAt.set(entry.host, Date.now());
        if (entry.sub) {
          const merged = await refreshAdapter(entry.sub, cache);
          entry.error = merged.error;
        } else {
          const result = await fetchOne(entry.feedUrl, entry.headers);
          mergeIntoCache(cache, entry.feedUrl, result);
          entry.error = result.error;
        }
        done += 1;
        if (onProgress) onProgress(done, active.length, entry.sub ? `adapter:${entry.sub.adapter.platform}` : entry.feedUrl, entry.error);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return {
    total: active.length,
    ok: active.filter((t) => !t.error).length,
    skipped: targets.length - active.length,
  };
}

async function refreshOne(feedUrl, cache, headers) {
  const result = await fetchOne(feedUrl, headers);
  return mergeIntoCache(cache, feedUrl, result);
}

module.exports = { refreshAll, refreshOne, refreshAdapter, fetchOne, KEEP_ITEMS };
