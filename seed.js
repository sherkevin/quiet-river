#!/usr/bin/env node
'use strict';

/**
 * Add a starter set of subscriptions using the same resolver the web UI uses.
 * Safe to re-run: anything already in the list is skipped.
 */

const store = require('./lib/store');
const { resolve } = require('./lib/resolve');
const { refreshOne } = require('./lib/refresh');

const STARTERS = [
  { url: 'https://blog.recsys-frontier.com/', name: 'Recsys Frontier（九老师）', tags: ['生成式推荐'] },
  // 博客本身八个候选路径全 404，但它是 GitHub Pages 仓，commit 就是他的文章
  // （「新增 TM20K 论文笔记」这种），所以直连 commits.atom。
  { url: 'https://github.com/yaoyuanzhou/yaoyuanzhou.github.io/commits.atom', name: '袁耀 · 论文阅读笔记', tags: ['生成式推荐'] },
  { url: 'https://eugeneyan.com/', name: 'Eugene Yan', tags: ['推荐系统'] },
  { url: 'https://kexue.fm/', name: '科学空间（苏剑林）', tags: ['深度学习'] },
  { url: 'https://www.youtube.com/@acmrecsys', name: 'ACM RecSys 会议录像', tags: ['推荐系统'] },
  { url: 'https://www.reddit.com/r/recommendersystems/', name: 'r/recommendersystems', tags: ['推荐系统'] },
  { url: 'https://arxiv.org/list/cs.IR/recent', name: 'arXiv · cs.IR 信息检索每日新论文', tags: ['信息检索'] },
];

(async function main() {
  const config = await store.loadConfig();
  const cache = await store.loadCache();
  let added = 0;

  for (const starter of STARTERS) {
    if (config.subscriptions.some((s) => s.url === starter.url)) {
      process.stdout.write(`跳过（已在清单）  ${starter.name}\n`);
      continue;
    }
    process.stdout.write(`识别  ${starter.url}\n`);
    const result = await resolve(starter.url, { rsshubBase: config.settings?.rsshubBase || '' });
    const good = (result.feeds || []).filter((f) => f.ok).map((f) => f.url);

    if (!good.length) {
      process.stdout.write(`  ✗ ${result.blocked || result.note || '没拿到可用 feed'}\n`);
      continue;
    }

    const sub = store.addSubscription(config, {
      name: starter.name || result.name,
      url: starter.url,
      platform: result.platform,
      platformLabel: result.platformLabel,
      tier: result.tier,
      tags: starter.tags,
      feeds: good,
    });
    await store.saveConfig(config);

    for (const feedUrl of good) {
      const fetched = await refreshOne(feedUrl, cache);
      await store.saveCache(cache);
      process.stdout.write(
        `  ✓ ${sub.name} — ${fetched.error ? `抓取失败：${fetched.error}` : `${fetched.itemCount} 条`}\n`
      );
    }
    added += 1;
  }

  store.pruneCache(cache, config);
  await store.saveCache(cache);
  process.stdout.write(`\n新增 ${added} 个。启动：node server.js\n`);
})().catch((err) => {
  process.stderr.write(`seed 失败：${err.stack || err}\n`);
  process.exit(1);
});
