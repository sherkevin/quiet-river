#!/usr/bin/env node
'use strict';

/**
 * 批量把外部 feed 灌进 quiet-river。公众号走 wechat2rss / wewe-rss 输出的 RSS
 * 时，用它一次性导入，省得在添加页逐个贴。
 *
 * 用法：
 *   node tools/import-feeds.js <file> [--tags 生成式推荐,工业实践] [--base http://127.0.0.1:4321]
 *
 * 文件支持两种格式：
 *   1) OPML（.opml）：读 outline 的 xmlUrl，名字取 text 或 title，category 属性当 tag
 *   2) 纯文本：每行 `url` 或 `名字<TAB>url[<TAB>tag1,tag2]`，# 开头与空行跳过
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseXML, children, attr, textOf } = require('../lib/xml');

function parseArgs(argv) {
  const out = { file: null, tags: '', base: 'http://127.0.0.1:4321' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tags') out.tags = argv[++i] || '';
    else if (argv[i] === '--base') out.base = (argv[++i] || out.base).replace(/\/+$/, '');
    else if (!out.file) out.file = argv[i];
  }
  return out;
}

function readOpml(text, fallbackTags) {
  const doc = parseXML(text);
  const rows = [];
  (function walk(node) {
    for (const outline of children(node, 'outline')) {
      const url = attr(outline, 'xmlUrl');
      if (url) {
        rows.push({
          name: attr(outline, 'text') || attr(outline, 'title') || url,
          url,
          tags: attr(outline, 'category') || fallbackTags,
        });
      }
      walk(outline);
    }
  })(doc);
  return rows;
}

function readLines(text, fallbackTags) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const parts = l.split(/\t+/);
      if (parts.length === 1) return { name: '', url: parts[0], tags: fallbackTags };
      return { name: parts[0], url: parts[1], tags: parts[2] || fallbackTags };
    })
    .filter((r) => /^https?:\/\//i.test(r.url));
}

(async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    process.stderr.write('用法：node tools/import-feeds.js <file> [--tags a,b] [--base http://127.0.0.1:4321]\n');
    process.exit(1);
  }
  const text = fs.readFileSync(path.resolve(args.file), 'utf8');
  const rows = args.file.toLowerCase().endsWith('.opml') ? readOpml(text, args.tags) : readLines(text, args.tags);
  if (!rows.length) {
    process.stderr.write('文件里没读到任何 feed 地址\n');
    process.exit(1);
  }

  let ok = 0;
  let fail = 0;
  for (const row of rows) {
    try {
      const res = await fetch(`${args.base}/api/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: row.url, name: row.name, tags: row.tags }),
      });
      const body = await res.json();
      if (res.ok) {
        ok += 1;
        const sample = (body.fetched || []).flatMap((f) => f.sample || []).slice(0, 3);
        process.stdout.write(`✓ ${body.subscription.name}\n`);
        if (sample.length) process.stdout.write(`    最新三条：${sample.map((t) => `「${t}」`).join(' ')}\n`);
        if (body.warning) process.stdout.write(`    提示：${body.warning}\n`);
      } else if (res.status === 409) {
        ok += 1;
        process.stdout.write(`= 已存在，跳过：${row.url}\n`);
      } else {
        fail += 1;
        process.stdout.write(`✗ ${row.url} — ${body.error || res.status}\n`);
      }
    } catch (err) {
      fail += 1;
      process.stdout.write(`✗ ${row.url} — ${err.message}\n`);
    }
  }
  process.stdout.write(`\n导入完成：成功 ${ok}，失败 ${fail}\n`);
})();
