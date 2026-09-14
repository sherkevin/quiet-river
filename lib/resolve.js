'use strict';

const { get } = require('./http');
const { parseFeed, looksLikeFeed } = require('./feeds');
const { matchAdapter } = require('./adapters');

/**
 * Tier 1 — the platform publishes a feed, or the site carries a standard
 *          autodiscovery link. Works with no setup.
 * Tier 2 — needs an RSSHub instance. Set `rsshubBase` in the config to enable.
 * Tier 3 — needs credentials (login cookie) or a hand-written adapter that is
 *          deliberately not shipped. See README for why.
 */
const TIER_LABEL = {
  1: '原生 feed，开箱即用',
  2: '需要 RSSHub 实例',
  3: '需要登录态凭证或自写适配器',
};

const PLATFORMS = {
  youtube: { label: 'YouTube', tier: 1 },
  github: { label: 'GitHub', tier: 1 },
  substack: { label: 'Substack', tier: 1 },
  medium: { label: 'Medium', tier: 1 },
  reddit: { label: 'Reddit', tier: 1 },
  mastodon: { label: 'Mastodon', tier: 1 },
  bluesky: { label: 'Bluesky', tier: 1 },
  arxiv: { label: 'arXiv', tier: 1 },
  podcast: { label: '播客', tier: 1 },
  blog: { label: '博客', tier: 1 },
  bilibili: { label: 'B站', tier: 2 },
  juejin: { label: '掘金', tier: 2 },
  csdn: { label: 'CSDN', tier: 1 },
  zhihu: { label: '知乎', tier: 3 },
  xiaohongshu: { label: '小红书', tier: 3 },
  wechat: { label: '微信公众号', tier: 3 },
  weibo: { label: '微博', tier: 3 },
  twitter: { label: 'X / Twitter', tier: 3 },
  unknown: { label: '未知', tier: 1 },
};

const WELL_KNOWN_FEED_PATHS = [
  '/feed', '/feed/', '/rss', '/rss/', '/rss.xml', '/feed.xml', '/atom.xml',
  '/index.xml', '/feed/rss', '/feed/atom', '/blog/feed', '/blog/atom.xml',
  '/blog/rss.xml', '/?feed=rss2',
];

/**
 * Third-party relays that turn a credential-walled platform into plain RSS.
 * The feed's *content* belongs to the platform; only the *host* is the service,
 * so these map back to the platform rather than to `blog`.
 *
 * wechat2rss runs two public instances with near-disjoint catalogs (23 shared
 * names out of ~390 each), so both count. Verified 2026-09-14.
 */
const RELAY_HOSTS = [
  { platform: 'wechat', host: 'wechat2rss.xlab.app' },
  { platform: 'wechat', host: 'wechat2rss.bestblogs.dev' },
  // X 的免费转发：handle → 32 位不可推导的哈希，只能贴它给的地址（见下方 twitter 分支）
  { platform: 'twitter', host: 'api.xgo.ing' },
];

// Dot-boundary match: `evil-wechat2rss.xlab.app` and `api.xgo.ing.evil.example`
// must not inherit the trusted platform.
function relayOf(host) {
  for (const r of RELAY_HOSTS) {
    if (host === r.host || host.endsWith(`.${r.host}`)) return r;
  }
  return null;
}

/**
 * Classify a feed URL that came from a relay service. Used by the POST route,
 * which accepts ready-made feed addresses and would otherwise file every one of
 * them as a generic custom blog.
 */
function relayPlatform(feedUrl) {
  const u = safeParse(String(feedUrl || ''));
  if (!u) return null;
  const relay = relayOf(u.hostname.replace(/^www\./, ''));
  if (!relay) return null;
  const meta = PLATFORMS[relay.platform] || PLATFORMS.unknown;
  return { platform: relay.platform, platformLabel: meta.label, tier: meta.tier };
}

function safeParse(input) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function detectPlatform(url) {
  const input = /^https?:\/\//i.test(String(url || '').trim()) ? String(url).trim() : `https://${String(url || '').trim()}`;
  const u = safeParse(input);
  if (!u || !u.hostname.includes('.')) return 'unknown';
  const host = u.hostname.replace(/^www\./, '');

  if (/(^|\.)youtube\.com$/.test(host) || host === 'youtu.be') return 'youtube';
  if (host === 'github.com') return 'github';
  if (host.endsWith('.substack.com')) return 'substack';
  if (host === 'medium.com' || host.endsWith('.medium.com')) return 'medium';
  if (host === 'reddit.com' || host.endsWith('.reddit.com')) return 'reddit';
  if (host === 'bsky.app') return 'bluesky';
  if (host === 'arxiv.org' || host === 'rss.arxiv.org') return 'arxiv';
  if (host === 'space.bilibili.com' || host === 'bilibili.com' || host === 'www.bilibili.com') return 'bilibili';
  if (host === 'juejin.cn') return 'juejin';
  if (host.endsWith('blog.csdn.net') || host === 'csdn.net') return 'csdn';
  if (host === 'zhihu.com' || host.endsWith('.zhihu.com')) return 'zhihu';
  if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com') || host === 'xhslink.com') return 'xiaohongshu';
  if (host === 'mp.weixin.qq.com') return 'wechat';
  // wechat2rss / xgo.ing 这类第三方转发服务，内容源仍是原平台，按原平台归类。
  const relay = relayOf(host);
  if (relay) return relay.platform;
  if (host === 'weibo.com' || host.endsWith('.weibo.com') || host === 'weibo.cn') return 'weibo';
  if (host === 'x.com' || host === 'twitter.com') return 'twitter';
  if (u.pathname.startsWith('/@')) return 'mastodon';
  return 'blog';
}

function ogTitle(html) {
  const m =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(html) ||
    /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function autodiscoverLinks(html, baseUrl) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const type = /type\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || '';
    if (!/(rss|atom|\+xml|json)/i.test(type)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try {
      out.push({ url: new URL(href, baseUrl).toString(), type });
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

async function verifyFeed(feedUrl) {
  try {
    const res = await get(feedUrl, { timeoutMs: 20000, accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8' });
    if (!res.ok) return { url: feedUrl, ok: false, error: `HTTP ${res.status}` };
    if (!looksLikeFeed(res.body, res.contentType)) {
      return { url: feedUrl, ok: false, error: '返回的不是 feed 格式（可能是登录页或风控页）' };
    }
    const parsed = parseFeed(res.body, res.finalUrl || feedUrl);
    if (!parsed.items.length) return { url: feedUrl, ok: false, error: 'feed 能解析但没有条目' };
    const dated = parsed.items.filter((i) => i.published).length;
    return {
      url: feedUrl,
      ok: true,
      feedTitle: parsed.feedTitle,
      itemCount: parsed.items.length,
      datedCount: dated,
      latest: parsed.items.map((i) => i.published).filter(Boolean).sort((a, b) => b - a)[0] || null,
      // 光看条数分不清「文章」和「changelog」，把最新三条标题带回去让调用方展示。
      sample: parsed.items.slice(0, 3).map((i) => i.title),
      error: dated === 0 ? '所有条目都没有发布时间，无法参与时间排序' : null,
    };
  } catch (err) {
    return { url: feedUrl, ok: false, error: err.name === 'AbortError' ? '请求超时' : String(err.message || err) };
  }
}

async function resolveYouTube(u) {
  let channelId = null;
  let pageUrl = u.toString();

  const channelMatch = /^\/channel\/(UC[\w-]+)/.exec(u.pathname);
  if (channelMatch) {
    channelId = channelMatch[1];
  } else {
    // @handle, /c/name, /user/name — the RSS endpoint only accepts channel_id,
    // so the page has to be fetched to read the id out of it.
    const res = await get(pageUrl, { timeoutMs: 20000 });
    if (!res.ok) throw new Error(`YouTube 页面返回 HTTP ${res.status}`);
    const html = res.body;
    channelId =
      /"channelId"\s*:\s*"(UC[\w-]{6,})"/.exec(html)?.[1] ||
      /"externalId"\s*:\s*"(UC[\w-]{6,})"/.exec(html)?.[1] ||
      /<link[^>]+rel=["']canonical["'][^>]+href=["'][^"']*\/channel\/(UC[\w-]{6,})/.exec(html)?.[1] ||
      /itemprop=["']identifier["'][^>]+content=["'](UC[\w-]{6,})/.exec(html)?.[1] ||
      /<meta[^>]+property=["']og:url["'][^>]+content=["'][^"']*\/channel\/(UC[\w-]{6,})/.exec(html)?.[1];
    if (!channelId) throw new Error('在 YouTube 页面里找不到 channel_id（UC 开头）');
    const name = ogTitle(html).replace(/\s*[-–]\s*YouTube$/, '');
    return { channelId, name, finalUrl: res.finalUrl || pageUrl };
  }
  return { channelId, name: '', finalUrl: pageUrl };
}

async function resolveGeneric(u) {
  const candidates = [];
  const path = u.pathname.replace(/\/+$/, '');
  if (/\.(xml|rss|atom)$/i.test(path)) candidates.push(u.toString());

  // A site can 403 its homepage while still serving /feed — kexue.fm does.
  // So a failed page fetch only costs us autodiscovery, not the whole resolve.
  let pageError = null;
  let html = '';
  let finalUrl = u.toString();
  try {
    const res = await get(u.toString(), { timeoutMs: 20000 });
    finalUrl = res.finalUrl || u.toString();
    if (res.ok) {
      html = res.body;
      if (looksLikeFeed(html, res.contentType)) {
        return { name: '', feeds: [finalUrl], verifiedHint: 'direct' };
      }
    } else {
      pageError = `首页 HTTP ${res.status}`;
    }
  } catch (err) {
    pageError = err.name === 'AbortError' ? '首页请求超时' : String(err.message || err);
  }

  if (html) {
    for (const link of autodiscoverLinks(html, finalUrl)) candidates.push(link.url);
  }
  // A blog under a path keeps its feed under that same path often enough to
  // matter (developer.nvidia.com/blog → /blog/feed), and only the first eight
  // candidates ever get fetched, so the specific guess goes before the root ones.
  let basePath = '';
  try {
    basePath = new URL(finalUrl).pathname.replace(/\/+$/, '');
  } catch {
    /* ignore */
  }
  if (basePath && basePath !== '/') {
    for (const p of WELL_KNOWN_FEED_PATHS) {
      try {
        candidates.push(new URL(basePath + p, finalUrl).toString());
      } catch {
        /* ignore */
      }
    }
  }
  for (const p of WELL_KNOWN_FEED_PATHS) {
    try {
      candidates.push(new URL(p, finalUrl).toString());
    } catch {
      /* ignore */
    }
  }
  const deduped = [...new Set(candidates)];
  if (!deduped.length) {
    throw new Error(pageError || '页面里既不是 feed，也没有 <link rel="alternate"> 或常见 feed 路径');
  }
  return { name: html ? ogTitle(html) : '', feeds: deduped.slice(0, 8), pageError };
}

function rsshub(base, path) {
  return base.replace(/\/+$/, '') + path;
}

/**
 * Turn one pasted profile URL into verified feed URLs.
 *
 * Returns `{ ok, platform, tier, name, feeds, note, blocked }`. `feeds` only
 * ever contains URLs that were actually fetched and parsed, so a success result
 * means "this works right now", not "this should work".
 */
async function resolve(inputUrl, options = {}) {
  const rsshubBase = options.rsshubBase || '';
  const raw = String(inputUrl || '').trim();
  if (!raw) return { ok: false, error: '空的链接' };
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = safeParse(withScheme);
  if (!u) return { ok: false, error: `无法解析的链接：${raw}` };

  const adapterHit = matchAdapter(withScheme);
  if (adapterHit) {
    const tier = adapterHit.adapter.tier || 1;
    const out = {
      ok: false,
      platform: adapterHit.adapter.platform,
      platformLabel: adapterHit.adapter.label,
      tier,
      tierLabel: TIER_LABEL[tier],
      name: '',
      feeds: [],
      note: '',
      adapter: null,
    };
    try {
      const fetched = await adapterHit.adapter.fetchItems(adapterHit.id);
      const latest = fetched.items.map((i) => i.published).filter(Boolean).sort((a, b) => b - a)[0] || null;
      out.name = fetched.name;
      out.adapter = {
        platform: adapterHit.adapter.platform,
        id: adapterHit.id,
        itemCount: fetched.items.length,
        latest,
      };
      out.ok = fetched.items.length > 0;
      if (!out.ok) out.note = '适配器连通但没返回条目';
    } catch (err) {
      out.note = `${adapterHit.adapter.label} 适配器失败：${err.message || err}`;
    }
    return out;
  }

  const platform = detectPlatform(withScheme);
  const meta = PLATFORMS[platform] || PLATFORMS.unknown;
  const result = {
    ok: false,
    platform,
    platformLabel: meta.label,
    tier: meta.tier,
    tierLabel: TIER_LABEL[meta.tier],
    name: '',
    feeds: [],
    note: '',
    candidates: [],
  };

  const finish = () => {
    const good = result.feeds.filter((f) => f.ok);
    result.ok = good.length > 0;
    if (!result.ok && !result.note) {
      const firstError = result.feeds[0]?.error;
      result.note = firstError ? `没拿到可用 feed：${firstError}` : '没找到任何 feed 候选';
    }
    if (good.length && !result.name) result.name = good[0].feedTitle || u.hostname;
    return result;
  };

  // 地址本身就是一个 feed 文件（…/commits.atom、…/feed.xml）时按直连验证，
  // 不让平台规则覆盖用户明确给出的地址：GitHub 仓库默认只订 release，但用户
  // 显式贴 commit 流是他的选择。
  if (/\.(atom|rss|xml)$/i.test(u.pathname)) {
    result.feeds.push(await verifyFeed(u.toString()));
    return finish();
  }

  // 转发服务给的地址（api.xgo.ing/rss/user/<hash>）没有扩展名，但本身就是 feed，
  // 所以走验证而不是走平台分支——平台分支对 twitter 只会返回一段「抓不到」。
  const relay = relayOf(u.hostname.replace(/^www\./, ''));
  if (relay) {
    const verified = await verifyFeed(u.toString());
    result.feeds.push(verified);
    // xgo 的频道标题形如 `Sam Altman(@sama)`，直接拿来当源名太脏：
    // 拆成「显示名（X @handle）」，跟库里既有的「王树森 ShusenWang（B站）」同构。
    const m = /^(.*?)\(@([^)]+)\)\s*$/.exec(verified.feedTitle || '');
    if (relay.platform === 'twitter' && m) {
      result.name = `${m[1].trim()}（X @${m[2]}）`;
      // 主页链接指回 x.com 而不是转发服务：UI 上的「去主页」该跳作者，
      // 跳转地址也不该随服务方改域名而失效。
      result.homepage = `https://x.com/${m[2]}`;
    }
    // 档位保留平台原本的（第 3 档）：平台本身仍是登录态墙，这里能抓只是因为
    // 有个第三方在转发。把 note 写清楚，免得读成「本项目原生支持 X」。
    // wewe-rss 就是这么死的（决议 0010）——转发服务是闭源单点，随时会没。
    if (verified.ok) {
      result.note =
        `通过第三方转发服务 ${u.hostname} 抓取，不是本平台原生能力；` +
        '服务方下线或改地址，这个源就跟着断，届时只能换目录里的新地址或回退到手动登记。';
    }
    return finish();
  }

  try {
    switch (platform) {
      case 'youtube': {
        if (/^\/playlist/.test(u.pathname)) {
          result.note = '这是播放列表链接，不是频道。请贴频道主页（@handle 或 /channel/UC…）';
          return finish();
        }
        const info = await resolveYouTube(u);
        result.name = info.name || decodeURIComponent(u.pathname.replace(/^\/(@|channel\/|c\/|user\/)/, ''));
        const feed = `https://www.youtube.com/feeds/videos.xml?channel_id=${info.channelId}`;
        result.feeds.push(await verifyFeed(feed));
        return finish();
      }

      case 'github': {
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length === 0) {
          result.note = '请贴一个 GitHub 用户或仓库链接';
          return finish();
        }
        if (parts.length === 1) {
          result.name = parts[0];
          result.feeds.push(await verifyFeed(`https://github.com/${parts[0]}.atom`));
          result.note = result.feeds[0].ok ? '' : 'GitHub 用户动态 feed 拿不到，确认用户名是否正确';
        } else {
          result.name = `${parts[0]}/${parts[1]}`;
          result.feeds.push(await verifyFeed(`https://github.com/${parts[0]}/${parts[1]}/releases.atom`));
          if (!result.feeds[0].ok) {
            // commit 流是开发记录不是文章：会出现「Merge pull request #5」「Update README.md」
            // 这类卡片。默认不订，要订就自己把 commits.atom 整条贴进来（走直连 feed 分支）。
            result.feeds[0].error = '这个仓库没有 release';
            result.note = `这个仓库没有 release，所以没东西可订。commit 流是开发记录不是文章（会出现「Merge pull request #5」「Update README.md」这类卡片），默认不订。确实要跟踪它的提交，就把 https://github.com/${parts[0]}/${parts[1]}/commits.atom 整条贴进来。`;
          }
        }
        return finish();
      }

      case 'substack': {
        result.name = u.hostname.split('.')[0];
        result.feeds.push(await verifyFeed(`${u.origin}/feed`));
        return finish();
      }

      case 'medium': {
        const isUser = u.pathname.startsWith('/@');
        result.name = isUser ? u.pathname.slice(2).split('/')[0] : u.pathname.split('/').filter(Boolean)[0] || u.hostname;
        result.feeds.push(await verifyFeed(`https://medium.com/feed/${isUser ? '@' + result.name : result.name}`));
        if (result.feeds[0].ok) result.note = 'Medium 的 feed 只返回最近 10 篇';
        return finish();
      }

      case 'reddit': {
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length < 2) {
          result.note = '请贴 r/版块 或 user/用户 链接';
          return finish();
        }
        result.name = `${parts[0]}/${parts[1]}`;
        result.feeds.push(await verifyFeed(`https://www.reddit.com/${parts[0]}/${parts[1]}/.rss`));
        return finish();
      }

      case 'bluesky': {
        const handle = u.pathname.split('/').filter(Boolean)[1];
        if (!handle) {
          result.note = '请贴 bsky.app/profile/<handle> 链接';
          return finish();
        }
        result.name = handle;
        result.feeds.push(await verifyFeed(`https://bsky.app/profile/${handle}/rss`));
        return finish();
      }

      case 'mastodon': {
        const handle = u.pathname.split('/').filter(Boolean)[0];
        result.name = `${handle}@${u.hostname}`;
        result.feeds.push(await verifyFeed(`${u.origin}/${handle}.rss`));
        return finish();
      }

      case 'arxiv': {
        const listMatch = /^\/list\/([^/]+)/.exec(u.pathname);
        const cat = listMatch ? listMatch[1] : u.pathname.split('/').filter(Boolean).pop();
        if (!cat) {
          result.note = '请贴 arxiv.org/list/<分类>/recent，例如 arxiv.org/list/cs.IR/recent';
          return finish();
        }
        result.name = `arXiv ${cat}`;
        result.feeds.push(await verifyFeed(`https://rss.arxiv.org/rss/${cat}`));
        return finish();
      }

      case 'bilibili': {
        const uid = /space\.bilibili\.com\/(\d+)/.exec(u.toString())?.[1] || u.pathname.split('/').filter(Boolean)[0];
        if (!uid || !/^\d+$/.test(uid)) {
          result.note = '请贴 space.bilibili.com/<数字 UID> 链接';
          return finish();
        }
        result.name = `B站 UID ${uid}`;
        if (!rsshubBase) {
          result.blocked = 'B站没有公开的 RSS。需要在配置里填一个 RSSHub 实例地址（rsshubBase），路由是 /bilibili/user/video/<uid>';
          return finish();
        }
        result.feeds.push(await verifyFeed(rsshub(rsshubBase, `/bilibili/user/video/${uid}`)));
        return finish();
      }

      case 'juejin': {
        const uid = /juejin\.cn\/user\/(\d+)/.exec(u.toString())?.[1];
        if (!uid) {
          result.note = '请贴 juejin.cn/user/<数字 ID> 链接';
          return finish();
        }
        result.name = `掘金 ${uid}`;
        if (!rsshubBase) {
          result.blocked = '掘金需要 RSSHub，路由是 /juejin/posts/<userid>。在配置里填 rsshubBase';
          return finish();
        }
        result.feeds.push(await verifyFeed(rsshub(rsshubBase, `/juejin/posts/${uid}`)));
        return finish();
      }

      case 'csdn': {
        const name = /blog\.csdn\.net\/([^/?#]+)/.exec(u.toString())?.[1];
        if (!name) {
          result.note = '请贴 blog.csdn.net/<用户名> 链接';
          return finish();
        }
        result.name = `CSDN ${name}`;
        result.feeds.push(await verifyFeed(`https://blog.csdn.net/${name}/rss/list`));
        return finish();
      }

      case 'zhihu': {
        result.blocked =
          '知乎对匿名请求全程拦截（zse-ck JS 挑战、x-zse-96 签名、40362 风控），RSSHub 的知乎路由也必须在 RSSHub 侧配置登录 cookie。' +
          '本项目刻意不内置知乎适配器：那等于把反爬绕过代码发布到公开仓库。' +
          '要做的话，在你自己的 RSSHub 实例里配好 ZHIHU cookies，然后填 rsshubBase，路由是 /zhihu/people/activities/<url_token>。';
        return finish();
      }

      case 'xiaohongshu': {
        result.blocked = '小红书需要登录态，且没有公开 feed。同知乎，本项目不内置适配器。';
        return finish();
      }

      case 'wechat': {
        result.blocked =
          '微信公众号没有公开的文章列表 feed，本项目也不内置公众号抓取。' +
          '可行的免费路径是查 wechat2rss 的两个公开目录：https://wechat2rss.xlab.app/list/all/（395 个号）' +
          '和 https://github.com/ginobefun/BestBlogs 的 opml/bestblogs_wechat2rss_opml_all.opml（375 个号，' +
          '两个目录只重叠 23 个名字，快手技术、大淘宝技术这类大厂号在后者）。' +
          '收录的号直接给标准 RSS 地址，贴回来就能抓；两边都没收录的只能手动登记名字，或自行部署付费服务。' +
          '注意 WeWe RSS 已于 2026-07 失效（详见 docs/wechat.md），别再照旧教程部署。';
        return finish();
      }

      case 'weibo': {
        result.blocked = '微博需要登录态。可在自建 RSSHub 里配置 WEIBO cookies，路由是 /weibo/user/<uid>。';
        return finish();
      }

      case 'twitter': {
        result.blocked =
          'X / Twitter 官方 API 收费，Nitter 公共实例在 2026-08-24 收到停止函后系统性死亡，' +
          '所以这里没有「贴 x.com 主页就能抓」的路径。' +
          '但 X 账号仍有免费可读的 feed：api.xgo.ing（BestBlogs 在用，2026-09-14 实测 22/22 通）' +
          '把账号转成标准 RSS，地址形如 https://api.xgo.ing/rss/user/<32位哈希>。' +
          '哈希不可由 handle 推导，只能从现成目录里取，例如 BestBlogs 的 ' +
          'opml/BestBlogs_RSS_Twitters.opml（160 个账号）。拿到地址后用「自定义 feed」贴进来，' +
          '本项目认这个域名，会归到 X / Twitter 而不是博客。';
        return finish();
      }

      default: {
        const info = await resolveGeneric(u);
        result.name = info.name || u.hostname;
        for (const candidate of info.feeds) {
          const verified = await verifyFeed(candidate);
          result.feeds.push(verified);
          if (verified.ok) break; // one working feed is enough; spare the site the rest
        }
        if (!result.feeds.some((f) => f.ok)) {
          const attempts = result.feeds.map((f) => `${f.url} (${f.error})`).join('；');
          const page = info.pageError ? `${info.pageError}；` : '';
          result.note = `试了 ${result.feeds.length} 个候选地址都不行：${page}${attempts}`;
        }
        return finish();
      }
    }
  } catch (err) {
    result.note = `解析失败：${err.name === 'AbortError' ? '请求超时' : err.message || err}`;
    return finish();
  }
}

module.exports = { resolve, detectPlatform, relayPlatform, PLATFORMS, TIER_LABEL, verifyFeed };
