'use strict';

/**
 * 博主 tag 继承的回归测试。
 *
 * 数据模型：博主级 tag 存 subscription.tags，文章级人工 tag 存 config.itemTags，
 * 平台自带分类存条目的 categories。store.buildRiver 把博主 tag 并进每个条目的
 * tags 字段——这就是「文章继承博主 tag」的实现点，前端 itemTags() 再把三者
 * 并成卡片上显示的 tag 列表。这里钉住存储层这一半。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store.js');

function configWith(subTags) {
  return {
    version: 1,
    settings: {},
    subscriptions: [
      {
        id: 'sub1',
        name: '某博主',
        url: 'https://a.example/',
        platform: 'blog',
        platformLabel: '博客',
        tier: 1,
        tags: subTags,
        feeds: ['https://a.example/feed'],
        addedAt: '2026-09-15T00:00:00.000Z',
      },
    ],
    itemTags: {},
  };
}

const cache = {
  feeds: {
    'https://a.example/feed': {
      fetchedAt: Date.now(),
      items: [
        { guid: 'g1', title: '一篇', link: 'https://a.example/1', published: 1000, summary: '', categories: ['微积分'] },
      ],
    },
  },
};

test('博主 tag 继承到名下每个条目', () => {
  const { items } = store.buildRiver(configWith(['数学']), cache);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].tags, ['数学']);
  assert.deepEqual(items[0].manualTags, []);
});

test('博主 tag 与文章级人工 tag 各存各的，互不覆盖', () => {
  const config = configWith(['数学']);
  const first = store.buildRiver(config, cache);
  store.setItemTags(config, first.items[0].id, ['人工补的']);
  const { items } = store.buildRiver(config, cache);
  assert.deepEqual(items[0].tags, ['数学']);
  assert.deepEqual(items[0].manualTags, ['人工补的']);
  assert.deepEqual(items[0].categories, ['微积分']);
});

test('博主没有 tag 时条目 tags 为空数组而不是 undefined', () => {
  const { items } = store.buildRiver(configWith(undefined), cache);
  assert.deepEqual(items[0].tags, []);
});

test('normalizeTags：去 # 前缀、去重、逗号空格都切', () => {
  assert.deepEqual(store.normalizeTags('数学, #数学  物理'), ['数学', '物理']);
  assert.deepEqual(store.normalizeTags(undefined), []);
});

test('关闭展示的博主不进河，但 tag 仍在清单里', () => {
  const config = configWith(['数学']);
  config.subscriptions[0].disabled = true;
  const { items } = store.buildRiver(config, cache);
  assert.deepEqual(items, []);
  assert.deepEqual(config.subscriptions[0].tags, ['数学']);
});
