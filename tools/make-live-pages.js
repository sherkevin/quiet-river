#!/usr/bin/env node
'use strict';

/**
 * 生成 GitHub Pages 用的「活中继」站：网页是静态的，数据在运行时经中继回源。
 *
 * 与 tools/make-pages.js（快照站）的区别：快照站把某一刻的河冻进 state.json，
 * 所以生成时要过脱敏闸；活中继站**不含任何数据**，只是把 public/ 原样搬过去再
 * 注入一行中继地址（live.js），没有内容可脱敏，也就不依赖 make-seed/scan-leaks
 * 那套本机工具。这正是它能进公开仓、别人 clone 后能自己生成的原因。
 *
 * 拓扑：浏览器打开 Pages 上的 index.html → app.js 看到 window.QR_LIVE_BASE →
 * 所有 /api/* 请求发往中继 origin，口令放请求头 x-qr-token（跨域带不了 cookie，
 * 口令存浏览器 localStorage）。中继把请求转给跑着 node server.js 的后端。
 *
 * 用法：
 *   node tools/make-live-pages.js --live https://<你的中继地址> --out pages-out
 *
 * 生成后把 pages-out/ 推到仓库的 gh-pages 分支即可（仓库设置里 Pages 源指向该
 * 分支）。中继怎么建见 tools/relay-fc/index.js 与 tools/deploy-relay.sh 的注释。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const OUT = path.resolve(flag('out', path.join(ROOT, 'pages-out')));
const LIVE = String(flag('live', '')).replace(/\/+$/, '');

if (!/^https?:\/\//.test(LIVE)) {
  process.stderr.write('需要 --live <中继 origin>，例如 --live https://xxx.fcapp.run\n');
  process.exit(2);
}

const COPY = [
  'public/index.html',
  'public/app.js',
  'public/style.css',
  'public/math-seg.js',
  'public/source-group.js',
  'public/vendor',
];

fs.mkdirSync(OUT, { recursive: true });
for (const rel of COPY) {
  const src = path.join(ROOT, rel);
  const dst = path.join(OUT, rel.replace(/^public\//, ''));
  if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
  else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

// live.js 只有一行：中继 origin。口令不在这里，永远只在浏览器 localStorage。
fs.writeFileSync(path.join(OUT, 'live.js'), `window.QR_LIVE_BASE = ${JSON.stringify(LIVE)};\n`, 'utf8');

const htmlPath = path.join(OUT, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
html = html.replace('<script src="/app.js"></script>', '<script src="/live.js"></script>\n<script src="/app.js"></script>');
// Pages 是子路径托管（/<repo>/），绝对路径 /app.js 会指到站点根。改成相对。
html = html.replace(/(src|href)="\/(?!\/)/g, '$1="./');
fs.writeFileSync(htmlPath, html, 'utf8');

process.stdout.write(`活中继站 -> ${OUT}（数据经 ${LIVE}）\n`);
