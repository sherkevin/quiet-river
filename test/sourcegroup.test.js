'use strict';

/**
 * 博主按来源分组的回归测试。
 *
 * 分组逻辑住在 public/source-group.js（浏览器 <script> + Node 双用）。这里钉住
 * 两件真在清单里发生过的事：微信同一个平台存过「微信公众号」与「公众号」两种
 * platformLabel，必须归成一组；组间按博主数降序，组内保持调用方给的顺序。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { groupBySource, sourceCounts, platformKey } = require('../public/source-group.js');

const sub = (id, platform, platformLabel) => ({ id, name: id, platform, platformLabel });

test('微信的两种 platformLabel 归成一组，显示名用规范写法', () => {
  const groups = groupBySource([
    sub('a', 'wechat', '微信公众号'),
    sub('b', 'wechat', '公众号'),
    sub('c', 'wechat', '公众号'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].platform, 'wechat');
  assert.equal(groups[0].label, '微信公众号');
  assert.deepEqual(groups[0].subs.map((s) => s.id), ['a', 'b', 'c']);
});

test('组间按博主数降序，同数按显示名排', () => {
  const groups = groupBySource([
    sub('z1', 'zhihu', '知乎'),
    sub('z2', 'zhihu', '知乎'),
    sub('z3', 'zhihu', '知乎'),
    sub('b1', 'blog', '博客'),
    sub('b2', 'blog', '博客'),
    sub('g1', 'github', 'GitHub'),
    sub('g2', 'github', 'GitHub'),
  ]);
  assert.deepEqual(groups.map((g) => g.platform), ['zhihu', 'blog', 'github']);
  assert.deepEqual(groups.map((g) => g.subs.length), [3, 2, 2]);
  // blog 与 github 同为 2 个，平票按显示名排。zh-Hans-CN collation 下中文按拼音
  // 排在拉丁字母前，所以「博客」在「GitHub」前——这里钉的是「顺序稳定可复现」，
  // 而不是某种主观的优先级。
  assert.equal(groups[1].label, '博客');
  assert.equal(groups[2].label, 'GitHub');
  // 换个输入顺序，结果不变：排序不依赖清单里的原始位置。
  const shuffled = groupBySource([
    sub('g1', 'github', 'GitHub'),
    sub('z1', 'zhihu', '知乎'),
    sub('b1', 'blog', '博客'),
    sub('g2', 'github', 'GitHub'),
    sub('z2', 'zhihu', '知乎'),
    sub('b2', 'blog', '博客'),
    sub('z3', 'zhihu', '知乎'),
  ]);
  assert.deepEqual(shuffled.map((g) => g.platform), groups.map((g) => g.platform));
});

test('组内顺序就是传入顺序：分组不重排调用方排好的时间序', () => {
  const groups = groupBySource([
    sub('new', 'zhihu', '知乎'),
    sub('old', 'zhihu', '知乎'),
    sub('mid', 'zhihu', '知乎'),
  ]);
  assert.deepEqual(groups[0].subs.map((s) => s.id), ['new', 'old', 'mid']);
});

test('缺 platform 的博主落进 unknown 组，不会因为分组而消失', () => {
  const groups = groupBySource([{ id: 'x', name: 'x' }, sub('y', 'zhihu', '知乎')]);
  const total = groups.reduce((n, g) => n + g.subs.length, 0);
  assert.equal(total, 2);
  assert.ok(groups.some((g) => g.platform === 'unknown'));
  assert.equal(platformKey({ id: 'x' }), 'unknown');
  assert.equal(platformKey(null), 'unknown');
});

test('没在 LABELS 里的新平台回落到清单里的实际写法', () => {
  const groups = groupBySource([
    sub('m1', 'medium', 'Medium'),
    sub('m2', 'medium', 'medium 博客'),
  ]);
  assert.equal(groups.length, 1);
  // 两个 label 各 1 票，平票取字典序小的那个，保证同一份清单渲染结果稳定
  assert.equal(groups[0].label, 'Medium');
});

test('空清单与非数组入参不抛', () => {
  assert.deepEqual(groupBySource([]), []);
  assert.deepEqual(groupBySource(undefined), []);
  assert.deepEqual(sourceCounts([]), []);
});

test('sourceCounts 与 groupBySource 同序，计数对得上', () => {
  const counts = sourceCounts([
    sub('z1', 'zhihu', '知乎'),
    sub('b1', 'blog', '博客'),
    sub('z2', 'zhihu', '知乎'),
  ]);
  assert.deepEqual(counts, [
    { platform: 'zhihu', label: '知乎', count: 2 },
    { platform: 'blog', label: '博客', count: 1 },
  ]);
});
