'use strict';

const crypto = require('node:crypto');
const { parseFeed, stripHTML } = require('../lib/feeds');
const xml = require('../lib/xml');

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

function safeURL(value, base) {
  try {
    const u = new URL(value, base);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return '';
    return u.href;
  } catch { return ''; }
}

function articleKey(platform, externalId, url) {
  return `${platform}:${hash(externalId || url)}`;
}

function classifyError(error) {
  const status = Number(error.status || 0);
  const message = String(error.message || error);
  if (status === 401 || /ERR_TICKET_NOT_EXIST|AuthenticationInvalidRequest|Invalid Session/i.test(message)) return 'AUTH_REQUIRED';
  if (status === 429) return 'COOLDOWN';
  if (status === 403) return 'ACCESS_BLOCKED';
  if (/private|non.public|SSRF|forbidden address/i.test(message)) return 'UNSAFE_URL';
  if (/not configured|missing configuration/i.test(message)) return 'NOT_CONFIGURED';
  if (/timeout|timed out|abort/i.test(message)) return 'TIMEOUT';
  return 'UPSTREAM_ERROR';
}

function channelsFor(source, options = {}) {
  const channels = [];
  const desktopPlatforms = options.desktopPlatforms || [];
  const add = (suffix, transport, url, extra = {}) => channels.push({
    id: hash(source.id + '\0' + suffix).slice(0, 24), source_id: source.id,
    transport, url, label: suffix, group_key: extra.group_key || new URL(url).hostname,
    interval_ms: transport === 'public' ? 30 * 60000 : 6 * 3600000,
    min_gap_ms: transport === 'public' ? 2000 : 8000, ...extra,
  });
  for (const url of source.feeds || []) {
    if (!safeURL(url)) continue;
    const u = new URL(url);
    if (source.platform === 'bilibili' && desktopPlatforms.includes('bilibili')) {
      const match = /^\/bilibili\/user\/video\/(\d+)$/.exec(u.pathname.replace(/\/+$/, ''));
      if (match) {
        add(url, 'desktop', `https://quiet-river.invalid/desktop/bilibili/${match[1]}/videos`, {
          enabled:true,group_key:'desktop:bilibili',author_id:match[1],desktop_kind:'videos',
          windowNote:'Shervin浏览器读取B站投稿列表；登录态不上传ECS',min_gap_ms:8000,interval_ms:6*3600000
        });
        continue;
      }
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    const restricted = local || source.tier === 2;
    const target = local && options.rsshub ? url.replace(u.origin, options.rsshub.replace(/\/$/, '')) : url;
    add(url, restricted ? 'rsshub' : 'public', target,
      restricted ? {group_key: `rsshub:${source.platform}`, enabled: Boolean(options.rsshub), browser: source.platform === 'bilibili'} : {enabled: true});
  }
  if (channels.length) return channels;
  const adapter = source.adapter || {};
  const id = adapter.id || '';
  const base = options.rsshub || 'http://127.0.0.1:1200';
  if (source.platform==='reddit'&&desktopPlatforms.includes('reddit')&&/^[A-Za-z0-9_-]{2,32}$/.test(id)) {
    const userSource=source.sourceType==='author',kind=userSource?'user.posts':'community.posts',sourceType=userSource?'author':'community';
    add(kind,'desktop',`https://quiet-river.invalid/desktop/reddit/${encodeURIComponent(id)}/${kind}`,{
      enabled:true,group_key:'browser:reddit',author_id:id.toLowerCase(),desktop_kind:kind,source_type:sourceType,browser:true,
      windowNote:userSource?'Shervin OpenCLI 零账号读取 Reddit 用户公开投稿；单次最多20条，发布时间未知且评论不进入主 Feed':'Shervin 浏览器网络读取 Reddit 官方 RSS；Feed 请求 credentials=omit，不需要 Reddit 账号；单次最多20条，评论留给详情增强',
      min_gap_ms:5000,interval_ms:30*60000
    });
  } else if (desktopPlatforms.includes(source.platform) && ['zhihu','xiaohongshu','instagram'].includes(source.platform) && id) {
    const kinds=source.platform==='zhihu'?['answers','articles']:source.platform==='xiaohongshu'?['notes']:['posts'];
    for(const kind of kinds)add(kind,'desktop',`https://quiet-river.invalid/desktop/${source.platform}/${encodeURIComponent(id)}/${kind}`,{
      enabled:true,group_key:'credential:'+source.platform,credential_group:source.platform,
      author_id:id,desktop_kind:kind,windowNote:'Shervin浏览器采集，单次最多20条；电脑离线时等待连接',min_gap_ms:8000,interval_ms:6*3600000
    });
  } else if (source.platform === 'v2ex' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    add('community.posts','v2ex',`https://www.v2ex.com/api/topics/show.json?node_name=${encodeURIComponent(id)}&page=1`,{
      enabled:Boolean(options.v2exReady),group_key:'api.v2ex.com',v2ex_node:id,source_type:'community',interval_ms:30*60000,min_gap_ms:2000,
      windowNote:'V2EX 公开 API 节点首页；只导入主题，回复留给详情增强'
    });
  } else if (source.platform === 'juejin' && /^\d+$/.test(id)) {
    add('metadata', 'native', 'https://api.juejin.cn/content_api/v1/article/query_list', {
      native_adapter:'juejin',author_id:id,enabled:true,group_key:'api.juejin.cn',
      windowNote:'单页作者更新列表；未完成翻页时不宣称覆盖全部更新',interval_ms:6*3600000,min_gap_ms:8000
    });
  } else if (source.platform === 'zhihu' && id) {
    for (const type of ['answers', 'articles']) {
      const route = type === 'answers' ? `/zhihu/people/answers/${encodeURIComponent(id)}` : `/zhihu/posts/people/${encodeURIComponent(id)}`;
      add(type, 'rsshub', base + route, {group_key: 'credential:zhihu', credential_group: 'zhihu', enabled: Boolean(options.rsshub && options.zhihuReady)});
    }
  } else if (source.platform === 'xiaohongshu' && id) {
    add('notes', 'rsshub', base + `/xiaohongshu/user/${encodeURIComponent(id)}/notes`, {group_key: 'credential:xiaohongshu', credential_group: 'xiaohongshu', browser: true, enabled: Boolean(options.rsshub && options.xhsReady)});
  } else if (source.platform === 'wechat') {
    const declaredMpId=source.adapter?.platform==='wechat'&&/^MP_WXS_\d+$/.test(String(source.adapter?.mp_id||''))?String(source.adapter.mp_id):'';
    const mpId=declaredMpId||options.werssMapping?.[source.id];
    if(mpId)add('wechat', 'werss', (options.werss || 'http://127.0.0.1:8001') + '/feed/' + encodeURIComponent(mpId), {mp_id: mpId, group_key: 'credential:wechat', credential_group: 'wechat', browser: true, enabled: Boolean(options.werss)});
  } else if (source.platform === 'arxiv') {
    const category = id || safeURL(source.url)?.split('/').at(-2);
    if (/^[a-zA-Z0-9.-]+$/.test(category || '')) add('rss', 'public', `https://rss.arxiv.org/rss/${category}`, {enabled: true});
  }
  return channels;
}

function opmlFor(channels, sources) {
  const byId = new Map(sources.map(s => [s.id, s]));
  return `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0" xmlns:miniflux="https://miniflux.app/opml"><head><title>Quiet River managed channels</title></head><body><outline text="Quiet River">${channels.map(c => {
    const s = byId.get(c.source_id);
    // Synthetic public-looking identity, never fetched: all channels have the native scheduler disabled.
    const url = c.transport === 'public' ? c.url : `https://quiet-river.invalid/channel/${c.id}`;
    return `<outline type="rss" text="${escapeHTML(s.name + ' · ' + c.label)}" xmlUrl="${escapeHTML(url)}" htmlUrl="${escapeHTML(s.url || url)}" miniflux:disabled="true" miniflux:crawler="false"/>`;
  }).join('')}</outline></body></opml>`;
}

function parseFullFeed(body, base) {
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('feed exceeds 8 MiB');
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw new Error('DTD and XML entities are not permitted');
  const result = parseFeed(body, base);
  if (body.trimStart().startsWith('{')) {
    const raw = JSON.parse(body).items || [];
    result.items.forEach((item, i) => {
      item.content = raw[i]?.content_html || (raw[i]?.content_text ? `<p>${escapeHTML(raw[i].content_text)}</p>` : '');
      item.content_state = item.content ? 'TEXT' : item.summary ? 'PARTIAL' : 'META';
      const attachment=(raw[i]?.attachments||[]).find(a=>a&&/^audio\//i.test(String(a.mime_type||''))&&safeURL(a.url,base));
      item.enclosure=attachment?{url:safeURL(attachment.url,base),type:String(attachment.mime_type||''),length:Number(attachment.size_in_bytes)||null}:null;
    });
  } else {
    const doc = xml.parseXML(body);
    const raw = [];
    const walk = (n, depth = 0) => {
      if (depth > 80) throw new Error('XML nesting too deep');
      for (const child of n.children || []) {
        if (['item','entry'].includes(xml.localName(child.name))) raw.push(child); else walk(child, depth + 1);
      }
    };
    walk(doc);
    result.items.forEach((item, i) => {
      const n = raw[i];
      const full = xml.child(n, 'encoded') || xml.children(n, 'content').find(c => !xml.attr(c, 'url'));
      const partial = xml.child(n, 'description') || xml.child(n, 'summary');
      item.content = full?.text || partial?.text || '';
      item.content_state = full?.text ? 'TEXT' : item.content ? 'PARTIAL' : 'META';
      const enclosure=xml.child(n,'enclosure')||xml.children(n,'link').find(c=>xml.attr(c,'rel')==='enclosure');
      const enclosureURL=enclosure&&safeURL(xml.attr(enclosure,'url')||xml.attr(enclosure,'href'),base),enclosureType=String(enclosure?xml.attr(enclosure,'type')||'':'');
      item.enclosure=enclosureURL&&(!enclosureType||/^audio\//i.test(enclosureType))?{url:enclosureURL,type:enclosureType,length:Number(xml.attr(enclosure,'length'))||null}:null;
      // XHTML with mixed children cannot be reconstructed by the legacy lightweight parser.
      if (full?.children?.length) item.content_state = 'PARTIAL';
    });
  }
  return result;
}

function rankEntries(entries, sources, preferences = {}, feedback = {}, now = Date.now()) {
  const src = new Map(sources.map(s => [s.id, s]));
  const weights = preferences.tags || {};
  const words = String(preferences.keywords || '').toLowerCase().split(/[,，\n]+/).map(s => s.trim()).filter(Boolean);
  const scored = entries.map(entry => {
    const s = src.get(entry.source_id) || {};
    const tags = Array.isArray(entry.tags) ? entry.tags : (s.tags || []);
    const tagWeights = tags.map(t => Number(weights[t] || 0));
    const positive = Math.max(0, ...tagWeights);
    const negative = Math.min(0, ...tagWeights);
    const text = (entry.title + '\n' + entry.summary).toLowerCase();
    const matches = words.filter(word => text.includes(word));
    const interest = Math.max(-1, Math.min(1, (positive + negative) / 3 + Math.min(matches.length, 3) / 3));
    const author = Math.max(-1, Math.min(1, Number(preferences.authors?.[s.id] || 0) / 3));
    const age = Math.max(0, now - (entry.published_at || entry.discovered_at));
    const freshness = Math.exp(-age / (72 * 3600000));
    const f = Number(feedback[entry.id] || 0);
    const score = 0.55 * interest + 0.2 * author + 0.25 * freshness + 0.35 * f;
    const reasons = [];
    if (positive > 0) reasons.push('偏好主题：' + tags.filter(t => weights[t] > 0).join('、'));
    if (matches.length) reasons.push('关键词：' + matches.join('、'));
    if (author > 0) reasons.push('优先关注的作者');
    if (f) reasons.push(f > 0 ? '你标记了感兴趣' : '你标记了不感兴趣');
    if (!reasons.length) reasons.push('时效性排序；尚无显式兴趣信号');
    return {...entry, score, reasons};
  }).sort((a,b) => b.score - a.score || (b.published_at || 0) - (a.published_at || 0) || a.id - b.id);
  // Soft diversity: postpone rather than discard articles; all candidates remain retrievable.
  const result = [], authors = new Map(), titles = new Set();
  const remaining = scored.slice();
  while (remaining.length) {
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < Math.min(remaining.length, 100); i++) {
      const e = remaining[i], title = e.title.replace(/[\p{P}\p{Z}]/gu,'').toLowerCase();
      const adjusted = e.score - 0.12 * (authors.get(e.source_id) || 0) - (titles.has(title) ? 0.4 : 0);
      if (adjusted > bestScore) {best = i; bestScore = adjusted;}
    }
    const e = remaining.splice(best,1)[0]; result.push(e);
    authors.set(e.source_id, (authors.get(e.source_id) || 0) + 1);
    titles.add(e.title.replace(/[\p{P}\p{Z}]/gu,'').toLowerCase());
    if (result.length % 10 === 0) authors.clear();
  }
  return result;
}

function buildArchive(entry, html) {
  const original = safeURL(entry.url);
  if (!original) throw new Error('unsafe article URL');
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
    `<title>${escapeHTML(entry.title)}</title><meta name="author" content="${escapeHTML(entry.author)}">` +
    `<link rel="canonical" href="${escapeHTML(original)}"><link rel="icon" href="${escapeHTML(new URL("/favicon.ico", original).href)}"></head><body><article>` +
    `<h1>${escapeHTML(entry.title)}</h1><p>${escapeHTML(entry.author)} · <a href="${escapeHTML(original)}">原文</a></p>` +
    html + '</article></body></html>';
}

module.exports = {hash, json, escapeHTML, safeURL, articleKey, classifyError, channelsFor, opmlFor, parseFullFeed, rankEntries, buildArchive, stripHTML};
