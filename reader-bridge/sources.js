'use strict';
const { safeURL } = require('./core');
const PLATFORM_LABELS = { zhihu:'知乎', xiaohongshu:'小红书', wechat:'微信公众号',
  blog:'博客', twitter:'X', instagram:'Instagram', v2ex:'V2EX', reddit:'Reddit', bilibili:'B站', github:'GitHub', podcast:'播客',
  juejin:'掘金', csdn:'CSDN', arxiv:'arXiv', semanticscholar:'Semantic Scholar', youtube:'YouTube' };
const FAILURES = new Set(['AUTH_REQUIRED','ACCESS_BLOCKED','TIMEOUT','UPSTREAM_ERROR','UNSAFE_URL']);
const OK = new Set(['SUCCEEDED_NEW','SUCCEEDED_NO_NEW']);
function authorIdentity(value) {
  const normalized = safeURL(value); if (!normalized) return null;
  const u = new URL(normalized), host = u.hostname.toLowerCase(); let match;
  if ((host==='zhihu.com'||host.endsWith('.zhihu.com')) &&
      (match=/^\/people\/([\w-]+)\/?$/.exec(u.pathname))) return {platform:'zhihu',id:match[1]};
  if ((host==='xiaohongshu.com'||host.endsWith('.xiaohongshu.com')) &&
      (match=/^\/user\/profile\/([a-f\d]{24})\/?$/i.exec(u.pathname))) return {platform:'xiaohongshu',id:match[1]};
  if ((host==='instagram.com'||host==='www.instagram.com') &&
      (match=/^\/([A-Za-z0-9._]{1,30})\/?$/.exec(u.pathname)) && !['accounts','direct','explore','p','reel','reels','stories'].includes(match[1].toLowerCase())) return {platform:'instagram',id:match[1]};
  if (host==='juejin.cn' && (match=/^\/user\/(\d+)\/?$/.exec(u.pathname))) return {platform:'juejin',id:match[1]};
  return null;
}
function sourceIdentity(value) {
  const author=authorIdentity(value);if(author)return {...author,sourceType:'author'};
  const normalized=safeURL(value);if(!normalized)return null;
  const u=new URL(normalized),host=u.hostname.toLowerCase();let match;
  if((host==='v2ex.com'||host==='www.v2ex.com')&&(match=/^\/go\/([A-Za-z0-9_-]{1,64})\/?$/.exec(u.pathname)))return {platform:'v2ex',id:match[1],sourceType:'community'};
  if(['reddit.com','www.reddit.com','old.reddit.com'].includes(host)&&(match=/^\/r\/([A-Za-z0-9_]{2,32})\/?$/.exec(u.pathname)))return {platform:'reddit',id:match[1].toLowerCase(),sourceType:'community'};
  return null;
}
function blockers(source, channels, config={}) {
  if (!channels.length) return [source.platform==='wechat'
    ? '尚缺这个公众号的逐作者 Feed 或自建采集映射'
    : !source.url ? '缺少准确主页或订阅地址，需要确认作者身份' : '尚缺可执行的订阅通道'];
  const result = new Set();
  for (const c of channels) {
    if (c.transport==='rsshub'&&!config.rsshub) result.add('自建 RSSHub 未连接');
    if (c.credential_group==='zhihu'&&!config.zhihuReady) result.add('知乎授权尚未配置或验证');
    if (c.credential_group==='xiaohongshu'&&!config.xhsReady) result.add('小红书授权尚未配置或验证');
    if (c.credential_group==='instagram'&&!OK.has(c.state)) result.add('Instagram 登录态需要在 Shervin 明确验证');
    if (c.browser&&!config.browserEnabled) result.add('浏览器采集尚未通过验收');
    if (!c.enabled&&!result.size) result.add('通道尚未启用');
  }
  return [...result];
}

// No source-coverage endpoint is introduced in this change.
module.exports = { PLATFORM_LABELS, authorIdentity, sourceIdentity, blockers };
