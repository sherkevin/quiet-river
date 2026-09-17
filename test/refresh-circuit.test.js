'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { refreshAll } = require('../lib/refresh');

/**
 * 起一个只回固定状态码的本地服务器。用 127.0.0.1 是因为它不在
 * HOST_MIN_GAP_MS 里，没有 sleep，测试才跑得动。
 */
function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function configWithFeeds(port, n) {
  const subs = [];
  for (let i = 0; i < n; i++) {
    subs.push({ name: `s${i}`, url: `http://127.0.0.1:${port}/x${i}`, platform: 'blog', feeds: [`http://127.0.0.1:${port}/x${i}`] });
  }
  return { subscriptions: subs };
}

test('熔断：同一宿主连续同样报错，剩下的源不再发请求', async () => {
  let hits = 0;
  const { srv, port } = await startServer((req, res) => {
    hits += 1;
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
  });
  try {
    const total = 20;
    const cache = { feeds: {} };
    const summary = await refreshAll(configWithFeeds(port, total), cache, { force: true });
    // 核心断言：20 个源只发了 5 个请求。没有熔断的话这里是 20。
    assert.equal(hits, 5);
    assert.equal(summary.total, total);
    assert.equal(summary.circuit.length, 1);
    assert.equal(summary.circuit[0].host, '127.0.0.1');
    // 试过的 5 个 + 跳过的 15 个 = 20，一个都不少，只是没发请求。
    assert.equal(summary.circuit[0].skipped, total - 5);
    assert.equal(summary.ok, 0);
  } finally {
    srv.close();
  }
});

test('熔断：被跳过的源不写缓存，failCount 不涨、旧条目还在', async () => {
  let hits = 0;
  const { srv, port } = await startServer((req, res) => {
    hits += 1;
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
  });
  try {
    const total = 12;
    const cache = { feeds: {} };
    for (let i = 0; i < total; i++) {
      const url = `http://127.0.0.1:${port}/x${i}`;
      cache.feeds[url] = { fetchedAt: 1, error: null, items: [{ guid: `g${i}`, title: '旧条目' }], failCount: 0 };
    }
    await refreshAll(configWithFeeds(port, total), cache, { force: true });

    // 前 5 个真试过：写进了错误，failCount 涨了
    const tried = Object.entries(cache.feeds).filter(([, fd]) => fd.error === 'HTTP 500');
    assert.equal(tried.length, 5);
    for (const [, fd] of tried) {
      assert.equal(fd.failCount, 1);
      assert.equal(fd.items.length, 1, '失败不能抹掉上次的好条目');
    }
    // 剩下的被熔断跳过：fetchedAt 原封不动，failCount 还是 0
    const skipped = Object.entries(cache.feeds).filter(([, fd]) => fd.fetchedAt === 1);
    assert.equal(skipped.length, total - 5);
    for (const [, fd] of skipped) {
      assert.equal(fd.failCount, 0, '没试过的源不该记为失败');
      assert.equal(fd.items.length, 1);
    }
  } finally {
    srv.close();
  }
});

test('熔断：错误各不相同就不熔断（网络抖动每个源报的不一样）', async () => {
  let hits = 0;
  const { srv, port } = await startServer((req, res) => {
    hits += 1;
    const code = 400 + (hits % 20);
    res.writeHead(code, { 'Content-Type': 'text/plain' });
    res.end('x');
  });
  try {
    const total = 12;
    const cache = { feeds: {} };
    const summary = await refreshAll(configWithFeeds(port, total), cache, { force: true });
    assert.equal(hits, total, '每个源都该被试到');
    assert.equal(summary.circuit.length, 0);
  } finally {
    srv.close();
  }
});

test('熔断：中途恢复正常会清零连击，不会把好的源也掐掉', async () => {
  let hits = 0;
  const feed = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>ok</title><link>http://127.0.0.1/a</link></item></channel></rss>';
  const { srv, port } = await startServer((req, res) => {
    hits += 1;
    if (hits <= 4) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(feed);
  });
  try {
    const total = 12;
    const cache = { feeds: {} };
    const summary = await refreshAll(configWithFeeds(port, total), cache, { force: true });
    assert.equal(hits, total, '恢复后剩下的源都要继续抓');
    assert.equal(summary.circuit.length, 0);
    assert.equal(summary.ok, total - 4);
  } finally {
    srv.close();
  }
});

test('退避：非 force 时 failCount 到阈值但还没到期，一个都不抓', async () => {
  let hits = 0;
  const { srv, port } = await startServer((req, res) => {
    hits += 1;
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
  });
  try {
    const total = 8;
    const config = configWithFeeds(port, total);
    const cache = { feeds: {} };
    for (const sub of config.subscriptions) {
      // fetchedAt 是「刚刚」，failCount=3 对应 6 小时退避，远未到期
      cache.feeds[sub.feeds[0]] = { fetchedAt: Date.now(), error: 'HTTP 500', items: [], failCount: 3 };
    }
    const summary = await refreshAll(config, cache, { force: false });
    assert.equal(hits, 0);
    assert.equal(summary.total, 0);
    assert.equal(summary.skipped, total);
  } finally {
    srv.close();
  }
});

test('退避：到期后自动重试，不需要人工强制刷新', async () => {
  let hits = 0;
  const feed = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>ok</title><link>http://127.0.0.1/a</link></item></channel></rss>';
  const { srv, port } = await startServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(feed);
  });
  try {
    const total = 3;
    const config = configWithFeeds(port, total);
    const cache = { feeds: {} };
    // 8 小时前坏的，failCount=3 的退避是 6 小时 —— 已到期，该重试
    const longAgo = Date.now() - 8 * 60 * 60 * 1000;
    for (const sub of config.subscriptions) {
      cache.feeds[sub.feeds[0]] = { fetchedAt: longAgo, error: 'HTTP 500', items: [], failCount: 3 };
    }
    const summary = await refreshAll(config, cache, { force: false });
    assert.equal(hits, total, '退避到期就该重新试');
    assert.equal(summary.total, total);
    assert.equal(summary.ok, total);
    // 成功后 failCount 归零，恢复正常节奏
    for (const sub of config.subscriptions) {
      assert.equal(cache.feeds[sub.feeds[0]].failCount, 0);
      assert.equal(cache.feeds[sub.feeds[0]].error, null);
    }
  } finally {
    srv.close();
  }
});

test('退避：failCount 越大等得越久，且封顶在 3 天', () => {
  const { backoffMs, MAX_CONSECUTIVE_FAILS } = require('../lib/refresh');
  const h = (ms) => ms / 3600000;
  // 阈值以下不退避：还归 failCount 之外的那条重抓周期管
  assert.equal(backoffMs(0), 0);
  assert.equal(backoffMs(MAX_CONSECUTIVE_FAILS - 1), 0);
  // 到阈值就开始退避，不白试那一次：同一宿主上一轮刚连坏三次，
  // 下一轮立刻再试多半还是同样的错误。
  assert.equal(h(backoffMs(MAX_CONSECUTIVE_FAILS)), 6);
  // 之后翻倍，48h 之后封顶 72h
  assert.deepEqual(
    [4, 5, 6, 7, 8, 20].map((fc) => h(backoffMs(fc))),
    [12, 24, 48, 72, 72, 72],
  );
});
