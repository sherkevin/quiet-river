'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { adapterCacheKey } = require('./adapters');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'subscriptions.json');
const CACHE_PATH = path.join(DATA_DIR, 'cache.json');

const EMPTY_CONFIG = {
  version: 1,
  settings: { rsshubBase: '', refreshMinutes: 60 },
  subscriptions: [],
};

const EMPTY_CACHE = { version: 1, feeds: {} };

async function readJson(file, fallback) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : structuredClone(fallback);
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(fallback);
    throw new Error(`${file} 不是合法 JSON：${err.message}`);
  }
}

// Write to a sibling temp file then rename, so a crash mid-write cannot leave
// a truncated config behind.
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

function loadConfig() {
  return readJson(CONFIG_PATH, EMPTY_CONFIG);
}

function saveConfig(config) {
  return writeJson(CONFIG_PATH, config);
}

function loadCache() {
  return readJson(CACHE_PATH, EMPTY_CACHE);
}

function saveCache(cache) {
  return writeJson(CACHE_PATH, cache);
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function itemId(feedUrl, guid) {
  return crypto.createHash('sha1').update(`${feedUrl}\u0000${guid}`).digest('hex').slice(0, 16);
}

function normalizeTags(tags) {
  const source = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,\s]+/) : [];
  const seen = new Set();
  const out = [];
  for (const raw of source) {
    const tag = String(raw || '').trim().replace(/^#/, '');
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

function addSubscription(config, { name, url, platform, platformLabel, tier, tags, feeds, adapter = null }) {
  const subscription = {
    id: newId(),
    name: String(name || '').trim() || new URL(url).hostname,
    url: String(url || '').trim(),
    platform: platform || 'blog',
    platformLabel: platformLabel || platform || 'blog',
    tier: tier || 1,
    tags: normalizeTags(tags),
    feeds: (feeds || []).map((f) => (typeof f === 'string' ? f : f.url)),
    addedAt: new Date().toISOString(),
  };
  if (adapter) subscription.adapter = adapter;
  config.subscriptions.push(subscription);
  return subscription;
}

function setItemTags(config, itemId, tags) {
  const clean = normalizeTags(tags);
  config.itemTags = config.itemTags || {};
  if (clean.length) {
    config.itemTags[itemId] = clean;
  } else {
    delete config.itemTags[itemId];
  }
  return clean;
}

function allTags(config) {
  const counts = new Map();
  for (const sub of config.subscriptions) {
    if (sub.disabled) continue;
    for (const tag of sub.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
}

/**
 * Join subscriptions with cached feed items into one time-sorted river.
 * Items whose feed could not be fetched still surface, as an error entry, so a
 * silently broken subscription is visible instead of just absent.
 */
function buildRiver(config, cache) {
  const items = [];
  const problems = [];

  for (const sub of config.subscriptions) {
    // 关闭展示的博主不进河、不报错，但仍留在 config 里，博主页照旧列出（灰显）。
    if (sub.disabled) continue;
    const keys = sub.adapter
      ? [adapterCacheKey(sub.adapter.platform, sub.adapter.id)]
      : sub.feeds || [];
    if (keys.length === 0) {
      if (!sub.manual) problems.push({ id: sub.id, name: sub.name, url: sub.url, reason: '没有已解析的 feed 地址' });
      continue;
    }
    let gotAnything = false;
    for (const feedUrl of keys) {
      const entry = cache.feeds?.[feedUrl];
      if (!entry) {
        problems.push({ id: sub.id, name: sub.name, url: feedUrl, reason: '还没抓取过，点一次刷新' });
        continue;
      }
      gotAnything = true;
      if (entry.error) {
        problems.push({
          id: sub.id,
          name: sub.name,
          url: feedUrl,
          reason: entry.error,
          at: entry.fetchedAt,
          // 抓失败但上次的条目还在河里时，问题栏该说清楚，别让人以为这个源全废了。
          kept: (entry.items || []).length,
        });
      }
      // 报错只加一条问题，不把内容藏掉：mergeIntoCache 特意保住的上次条目仍然进河。
      for (const raw of entry.items || []) {
        items.push({
          id: itemId(feedUrl, raw.guid),
          subId: sub.id,
          subName: sub.name,
          platform: sub.platform,
          platformLabel: sub.platformLabel,
          tier: sub.tier,
          tags: sub.tags || [],
          feedUrl,
          guid: raw.guid,
          title: raw.title,
          link: raw.link,
          author: raw.author,
          published: raw.published,
          summary: raw.summary,
          image: raw.image,
          categories: raw.categories || [],
          manualTags: (config.itemTags || {})[itemId(feedUrl, raw.guid)] || [],
        });
      }
    }
    if (!gotAnything && !sub.manual) {
      problems.push({ id: sub.id, name: sub.name, url: sub.url, reason: '所有 feed 都没抓到' });
    }
  }

  // Undated items sort to the bottom rather than jumping to the top as "now".
  items.sort((a, b) => (b.published || 0) - (a.published || 0) || a.title.localeCompare(b.title, 'zh-Hans-CN'));

  return { items, problems };
}

function pruneCache(cache, config, keepFeeds = 60) {
  const live = new Set();
  for (const sub of config.subscriptions) {
    for (const f of sub.feeds || []) live.add(f);
    if (sub.adapter) live.add(adapterCacheKey(sub.adapter.platform, sub.adapter.id));
  }
  for (const key of Object.keys(cache.feeds)) {
    if (!live.has(key)) delete cache.feeds[key];
  }
  for (const key of Object.keys(cache.feeds)) {
    const entry = cache.feeds[key];
    if (Array.isArray(entry.items) && entry.items.length > keepFeeds) {
      entry.items = entry.items.slice(0, keepFeeds);
    }
  }
  return cache;
}

async function ensureSeed() {
  if (fs.existsSync(CONFIG_PATH)) return false;
  await saveConfig(structuredClone(EMPTY_CONFIG));
  return true;
}

module.exports = {
  DATA_DIR, CONFIG_PATH, CACHE_PATH, EMPTY_CONFIG,
  loadConfig, saveConfig, loadCache, saveCache,
  newId, itemId, normalizeTags, addSubscription, allTags, buildRiver, pruneCache, ensureSeed, setItemTags,
};
