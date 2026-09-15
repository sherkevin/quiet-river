'use strict';

/**
 * OPML 导出。server.js 的 /api/export 与 tools/make-pages.js 的静态导出共用，
 * 免得静态快照那份和在线那份写出两种 OPML。
 */

function escapeXml(value) {
  return String(value ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function toOpml(config) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head><title>quiet-river subscriptions</title></head>',
    '  <body>',
  ];
  for (const sub of config.subscriptions) {
    for (const feed of sub.feeds || []) {
      lines.push(
        `    <outline type="rss" text="${escapeXml(sub.name)}" title="${escapeXml(sub.name)}" xmlUrl="${escapeXml(feed)}" htmlUrl="${escapeXml(sub.url)}" category="${escapeXml((sub.tags || []).join(','))}" />`
      );
    }
  }
  lines.push('  </body>', '</opml>', '');
  return lines.join('\n');
}

module.exports = { toOpml, escapeXml };
