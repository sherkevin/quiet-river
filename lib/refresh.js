'use strict';

const { get } = require('./http');
const { parseFeed, looksLikeFeed } = require('./feeds');
const { adapters, adapterCacheKey } = require('./adapters');

const KEEP_ITEMS = 60;
const CONCURRENCY = 8;
const MAX_CONSECUTIVE_FAILS = 3;

// 连坏 MAX_CONSECUTIVE_FAILS 次之后不是「永不重试」，而是指数退避。
// 旧代码在那里直接 return false，于是任何连坏 3 次的源都被永久放弃——
// 小红书的 13 个源就是这样静默坏了 4 天（9-13 到 9-17），期间登录态一直是好的，
// 直到手动强制刷新才恢复。退避既让恢复变成自动的，又限制对已死宿主的请求量：
// 拿一份失效凭证反复敲平台的门本身有加重风控的风险（见 ADR 0015）。
const BACKOFF_BASE_MS = 6 * 60 * 60 * 1000;   // 6 小时
const BACKOFF_MAX_MS = 72 * 60 * 60 * 1000;   // 封顶 3 天

/** failCount=3 等 6h，4 等 12h，5 等 24h，6 等 48h，7 及以上封顶 72h。 */
function backoffMs(failCount) {
  // 到阈值就开始退避，不是「到阈值再白试一次」。白试那一次没有信息量：
  // 同一个宿主上一轮刚连坏三次，下一轮立刻再试一遍，多半还是同样的错误。
  if (failCount < MAX_CONSECUTIVE_FAILS) return 0;
  const extra = failCount - MAX_CONSECUTIVE_FAILS;
  return Math.min(BACKOFF_BASE_MS * 2 ** extra, BACKOFF_MAX_MS);
}

// 同一宿主连续这么多次**同一个错误**，就认定本轮不必再试剩下的源。
// 判据是「错误完全相同」而不是「连续失败」：网络抖动每次的报错都不一样，
// 凭证失效/平台封禁才会 115 个源一字不差地报同一句。
// 为什么需要它：HOST_MIN_GAP_MS 的 sleep 在请求之前无条件执行，知乎 401
// 只要几十毫秒就返回，但下一个源照样先睡满 8 秒。115 个源就是 15.2 分钟
// 纯等待，结果全是已知的 401。手动刷新（force）忽略 failCount，所以最痛。
const CIRCUIT_BREAK_SAME_ERROR = 5;

// 同一宿主两次请求之间的最小间隔。同域串行只保证不并发，不保证不打得太密：
// 知乎 2026-09-11 实测约 17 次请求 / 15 秒就 403；Reddit 自 2026-06 起全局限流约 1 次/分钟。
const HOST_MIN_GAP_MS = {
  'adapter:zhihu': 8000,
  'reddit.com': 60000,
  'www.reddit.com': 60000,
  // 转发服务不是我们自己的机器：同宿主串行已经保证不并发，再加一个温和间隔，
  // 免得一轮刷新里几十个源连续砸同一个第三方（api.xgo.ing 一次进来三十多个）。
  'api.xgo.ing': 1500,
  'wechat2rss.bestblogs.dev': 1000,
};

// 同一宿主的最小重抓周期——和上面那把旋钮解决的是不同问题。
// 光调请求间隔治不了根：14 个知乎源每轮就是 28 个请求，间隔调到不触限流就慢得没法用。
// 但知乎的文章与回答不是按分钟变的，一天抓几次足够，所以自动刷新直接跳过还新鲜的源。
// 手动点「刷新」是「我现在就要」，force 会忽略这条。
const HOST_MIN_RECHECK_MS = {
  'adapter:zhihu': 6 * 60 * 60 * 1000,
  'reddit.com': 30 * 60 * 1000,
  'www.reddit.com': 30 * 60 * 1000,
  // 推文与公众号文章不按分钟变，转发服务自己也带缓存（bestblogs 那个 max-age=600）。
  // 半小时够勤；这条和知乎那条一样，force 也照样尊重（见上面那段注释），
  // 所以手动刷新在半小时内不会重复打第三方，要立刻重拉就先删源再加。
  'api.xgo.ing': 30 * 60 * 1000,
  'wechat2rss.bestblogs.dev': 30 * 60 * 1000,
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
  // failCount 是「它坏了」——点「刷新」本来就是要重试坏的，force 忽略退避；
  // 重抓周期是「这个平台没必要抓这么勤」——这跟谁触发无关，force 也照样尊重，
  // 否则每次手动刷新都要走 28 个知乎请求换来一串 403。
  const now = Date.now();
  const active = targets.filter((t) => {
    const entry = cache.feeds[t.key];
    if (!force && (entry?.failCount || 0) >= MAX_CONSECUTIVE_FAILS) {
      // 退避未到期就跳过。到期后它会重新被试，失败则 failCount 继续涨、
      // 退避继续拉长；成功则 mergeIntoCache 把 failCount 归零，立刻恢复正常节奏。
      if (now - (entry?.fetchedAt || 0) < backoffMs(entry.failCount)) return false;
    }
    const period = HOST_MIN_RECHECK_MS[t.host] || 0;
    if (period && entry && !entry.error && now - (entry.fetchedAt || 0) < period) return false;
    return true;
  });

  let cursor = 0;
  let done = 0;

  // 熔断状态：同一个宿主队列由一个 worker 独占，所以这两张表不需要加锁。
  const streak = new Map();   // host -> { count, error }
  const broken = new Map();   // host -> { error, skipped }

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
        // 已熔断的宿主：剩下的源直接标记同一个错误，不发请求也不 sleep。
        // 故意不写缓存——这些源没被试过，failCount 不该涨，fetchedAt 不该动，
        // 上次抓到的条目原样留着。
        const brk = broken.get(entry.host);
        if (brk) {
          brk.skipped += 1;
          entry.error = brk.error;
          entry.circuitSkipped = true;
          done += 1;
          if (onProgress) onProgress(done, active.length, entry.sub ? `adapter:${entry.sub.adapter.platform}` : entry.feedUrl, entry.error);
          continue;
        }

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

        // 成功就把连击清零：抖动过后的好结果说明这个宿主是通的。
        if (!entry.error) {
          streak.delete(entry.host);
        } else {
          const prev = streak.get(entry.host);
          if (prev && prev.error === entry.error) prev.count += 1;
          else streak.set(entry.host, { count: 1, error: entry.error });
          if (streak.get(entry.host).count >= CIRCUIT_BREAK_SAME_ERROR) {
            broken.set(entry.host, { error: entry.error, skipped: 0 });
          }
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
    // 熔断掉的源数与原因。前端可以据此说清「为什么这 110 个知乎源没试」，
    // 而不是让人以为刷新成功了却少了一大片内容。
    circuit: [...broken.entries()].map(([host, b]) => ({ host, error: b.error, skipped: b.skipped })),
  };
}

async function refreshOne(feedUrl, cache, headers) {
  const result = await fetchOne(feedUrl, headers);
  return mergeIntoCache(cache, feedUrl, result);
}

module.exports = {
  refreshAll, refreshOne, refreshAdapter, fetchOne,
  KEEP_ITEMS, MAX_CONSECUTIVE_FAILS, backoffMs,
};
