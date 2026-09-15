'use strict';

/**
 * 博主按来源（平台）分组的纯函数。浏览器 <script> + Node 双用，单测在
 * test/sourcegroup.test.js。
 *
 * 为什么不直接拿 sub.platformLabel 当分组键：清单里同一个平台存过两种写法。
 * 微信既有「微信公众号」（走 resolve 识别进来的 49 个）也有「公众号」（手动登记的
 * 18 个，server.js 里写死的那个 label）。按 label 分组微信会裂成两组，所以分组
 * 一律按规范键 sub.platform 归并，显示名再单独定。
 */

// 规范显示名。列出来的平台用这里的写法，保证「微信公众号」不会显示成「公众号」。
// 没列到的平台（以后新加的）回落到清单里实际出现最多的那个 platformLabel，
// 再没有就用 platform 原值兜底。
const LABELS = {
  zhihu: '知乎',
  wechat: '微信公众号',
  twitter: 'X / Twitter',
  blog: '博客',
  github: 'GitHub',
  arxiv: 'arXiv',
  bilibili: 'B站',
  xiaohongshu: '小红书',
  juejin: '掘金',
  csdn: 'CSDN',
  youtube: 'YouTube',
  podcast: '播客',
  semanticscholar: 'Semantic Scholar',
  weibo: '微博',
};

function platformKey(sub) {
  const p = sub && sub.platform;
  return typeof p === 'string' && p ? p : 'unknown';
}

// 同一 platform 下票数最多的那个 platformLabel。手动登记与自动识别会给同一个
// 平台写出不同 label，取多数派让显示名跟着清单的实际写法走，而不是凭空造一个。
function observedLabel(subs) {
  const tally = new Map();
  for (const s of subs) {
    const label = typeof s.platformLabel === 'string' ? s.platformLabel.trim() : '';
    if (!label) continue;
    tally.set(label, (tally.get(label) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [label, n] of tally) {
    if (n > bestN || (n === bestN && label < best)) { best = label; bestN = n; }
  }
  return best;
}

/**
 * 把博主按来源分组。
 *
 * 组内顺序 = 传入顺序（调用方已经按时间/标题/作者排好了，分组不重排组内）。
 * 组间顺序 = 博主数降序，同数按显示名排，保证同一份清单每次渲染顺序一致。
 *
 * @param {Array<object>} subs
 * @returns {Array<{platform: string, label: string, subs: Array<object>}>}
 */
function groupBySource(subs) {
  const list = Array.isArray(subs) ? subs : [];
  const byPlatform = new Map();
  for (const sub of list) {
    const key = platformKey(sub);
    if (!byPlatform.has(key)) byPlatform.set(key, []);
    byPlatform.get(key).push(sub);
  }
  return [...byPlatform.entries()]
    .map(([platform, group]) => ({
      platform,
      label: LABELS[platform] || observedLabel(group) || platform,
      subs: group,
    }))
    .sort((a, b) => b.subs.length - a.subs.length || a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

/**
 * 来源计数，给筛选条上的 chip 用。
 * 返回按 groupBySource 同样的顺序排好的 [{platform, label, count}]。
 */
function sourceCounts(subs) {
  return groupBySource(subs).map((g) => ({ platform: g.platform, label: g.label, count: g.subs.length }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { platformKey, groupBySource, sourceCounts, LABELS };
}
