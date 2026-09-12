'use strict';

/**
 * Feedless adapters for platforms that expose an anonymous JSON API or an
 * embedded JSON blob instead of RSS. Every adapter here was live-verified on
 * 2026-09-10 to return real data *with a publish timestamp* — an adapter
 * without timestamps cannot participate in a time-sorted river, which is why
 * B站专栏 (opus feed returns empty pub_time for every item) is deliberately
 * absent.
 *
 * Adapters return the same item shape the feed parser produces:
 *   { guid, title, link, author, published, summary, image }
 */

const { get, postJson } = require('./http');
const { stripHTML, clamp, parseFeed } = require('./feeds');
const { parseXML, child, children, textOf, attr } = require('./xml');

function jsonOf(res) {
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

function parseNextData(html) {
  const m = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const adapters = [
  {
    platform: 'juejin',
    label: '掘金',
    match(url) {
      const m = /juejin\.cn\/user\/(\d+)/.exec(url);
      return m ? { id: m[1] } : null;
    },
    async fetchItems(id) {
      let name = `掘金 ${id}`;
      try {
        const info = await get(`https://api.juejin.cn/user_api/v1/user/get?user_id=${id}`);
        const nick = jsonOf(info)?.data?.user_name;
        if (nick) name = nick;
      } catch {
        /* name is cosmetic; keep the fallback */
      }
      const res = await postJson('https://api.juejin.cn/content_api/v1/article/query_list', {
        user_id: id,
        sort_type: 2,
        cursor: '0',
        limit: 20,
      });
      if (!res.ok || res.json?.err_no !== 0) {
        throw new Error(`掘金接口返回 ${res.json?.err_msg || `HTTP ${res.status}`}`);
      }
      const items = (res.json.data || []).map((row) => {
        // query_list nests everything under article_info.
        const a = row.article_info || row;
        return {
          guid: String(a.article_id),
          title: stripHTML(a.title || '') || '(无标题)',
          link: `https://juejin.cn/post/${a.article_id}`,
          author: name,
          published: Number(a.ctime) ? Number(a.ctime) * 1000 : null,
          summary: clamp(stripHTML(a.brief_content || '')),
          image: a.cover_image || null,
        };
      });
      return { name, items };
    },
  },

  {
    platform: 'sspai',
    label: '少数派',
    match(url) {
      const m = /sspai\.com\/u\/([\w-]+)/.exec(url);
      return m ? { id: m[1] } : null;
    },
    async fetchItems(id) {
      let authorId = id;
      let name = `少数派 ${id}`;
      if (!/^\d+$/.test(id)) {
        const info = await get(`https://sspai.com/api/v1/user/slug/info/get?slug=${encodeURIComponent(id)}`);
        authorId = String(jsonOf(info)?.data?.id || '');
        if (!authorId) {
          throw new Error('少数派找不到这个 slug 对应的用户 ID，请改贴 sspai.com/u/<数字 ID> 形式的链接');
        }
        const nick = jsonOf(info)?.data?.nickname;
        if (nick) name = nick;
      }
      const res = await get(`https://sspai.com/api/v1/articles?author_ids=${authorId}&limit=20&offset=0`);
      if (!res.ok) throw new Error(`少数派接口返回 HTTP ${res.status}`);
      const data = jsonOf(res);
      const list = data?.list || data?.data || [];
      const items = list.map((a) => ({
        guid: String(a.id),
        title: stripHTML(a.title || '') || '(无标题)',
        link: `https://sspai.com/post/${a.id}`,
        author: name,
        published: Number(a.released_at) ? Number(a.released_at) * 1000 : null,
        summary: clamp(stripHTML(a.summary || '')),
        image: a.banner ? `https://cdn.sspai.com/${a.banner}` : null,
        categories: (a.keywords || []).map(String).filter(Boolean),
      }));
      return { name, items };
    },
  },

  {
    platform: 'jike',
    label: '即刻',
    match(url) {
      const m = /(?:web|m)\.okjike\.com\/u\/([0-9a-fA-F-]{20,})/.exec(url);
      return m ? { id: m[1] } : null;
    },
    async fetchItems(id) {
      const res = await get(`https://m.okjike.com/users/${id}`);
      if (!res.ok) throw new Error(`即刻移动页返回 HTTP ${res.status}`);
      const page = parseNextData(res.body)?.props?.pageProps;
      const posts = page?.posts;
      if (!Array.isArray(posts)) throw new Error('即刻页面结构变了，读不到 __NEXT_DATA__ 里的 posts');
      const name = page?.user?.screenName || posts[0]?.user?.screenName || `即刻 ${id.slice(0, 8)}`;
      const items = posts.map((p) => {
        const text = stripHTML(p.rawContent || p.content || '');
        const firstLine = text.split('\n')[0] || '(无文字)';
        return {
          guid: String(p.id),
          title: clamp(firstLine, 80),
          link: p.type === 'REPOST' ? `https://web.okjike.com/repost/${p.id}` : `https://web.okjike.com/originalPost/${p.id}`,
          author: name,
          published: Date.parse(p.createdAt || p.actionTime) || null,
          summary: clamp(text),
          image: p.pictures?.[0]?.picUrl || p.pictures?.[0]?.thumbnailUrl || null,
          categories: [
            ...(p.targetType === 'TOPIC' && p.target?.content ? [p.target.content] : []),
            ...((p.topics || []).map((t) => t?.content).filter(Boolean) || []),
          ].filter((t, i, arr) => t && arr.indexOf(t) === i),
        };
      });
      return { name, items };
    },
  },

  {
    platform: 'hackernews',
    label: 'Hacker News',
    match(url) {
      const m = /news\.ycombinator\.com\/user\?id=([\w-]+)/.exec(url);
      return m ? { id: m[1] } : null;
    },
    async fetchItems(id) {
      const res = await get(`https://hn.algolia.com/api/v1/search_by_date?tags=author_${encodeURIComponent(id)}&hitsPerPage=20`);
      if (!res.ok) throw new Error(`HN Algolia 返回 HTTP ${res.status}`);
      const hits = jsonOf(res)?.hits || [];
      const items = hits.map((h) => ({
        guid: String(h.objectID),
        title: stripHTML(h.title || '') || (h.story_title ? `评论：${stripHTML(h.story_title)}` : '(无标题)'),
        link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        author: id,
        published: Date.parse(h.created_at) || null,
        summary: clamp(stripHTML(h.comment_text || h.story_text || '')),
        image: null,
      }));
      return { name: `HN ${id}`, items };
    },
  },

  {
    platform: 'semanticscholar',
    label: 'Semantic Scholar',
    match(url) {
      const m = /semanticscholar\.org\/author\/[^/]+\/(\d+)/.exec(url);
      return m ? { id: m[1] } : null;
    },
    async fetchItems(id) {
      // The anonymous pool 429s occasionally; one retry covers it.
      let papers = null;
      let name = `Semantic Scholar ${id}`;
      for (let attempt = 0; attempt < 2 && !papers; attempt++) {
        const meta = await get(`https://api.semanticscholar.org/graph/v1/author/${id}?fields=name`);
        const metaJson = jsonOf(meta);
        if (metaJson?.name) name = metaJson.name;
        const res = await get(
          `https://api.semanticscholar.org/graph/v1/author/${id}/papers?fields=title,publicationDate,externalIds,url,paperId,fieldsOfStudy&limit=20`
        );
        if (res.status === 429) continue;
        if (!res.ok) throw new Error(`Semantic Scholar 返回 HTTP ${res.status}`);
        papers = jsonOf(res)?.data || [];
      }
      if (!papers) throw new Error('Semantic Scholar 限流（429），稍后再试');
      const items = papers.map((p) => ({
        guid: String(p.paperId),
        title: stripHTML(p.title || '') || '(无标题)',
        link:
          (p.externalIds?.ArXiv && `https://arxiv.org/abs/${p.externalIds.ArXiv}`) ||
          p.url ||
          `https://www.semanticscholar.org/paper/${p.paperId}`,
        author: name,
        published: p.publicationDate ? Date.parse(p.publicationDate) || null : null,
        summary: '',
        image: null,
        categories: (p.fieldsOfStudy || []).map(String).filter(Boolean),
      }));
      return { name, items };
    },
  },

  {
    // The category RSS carries no per-paper categories; the API does
    // (<category term> for every listing plus arxiv:primary_category), so
    // article-level domain tags come from here.
    platform: 'arxiv',
    label: 'arXiv',
    match(url) {
      const m = /arxiv\.org\/list\/([\w.-]+)\/(recent|new)/.exec(String(url));
      return m ? { id: m[1] } : null;
    },
    async fetchItems(cat) {
      const res = await get(
        `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(cat)}&start=0&max_results=20&sortBy=submittedDate&sortOrder=descending`
      );
      if (!res.ok) throw new Error(`arXiv API 返回 HTTP ${res.status}`);
      const doc = parseXML(res.body);
      const feed = child(doc, 'feed') || doc;
      const items = children(feed, 'entry').map((e) => {
        const names = children(e, 'author').map((a) => textOf(child(a, 'name'))).filter(Boolean);
        const cats = children(e, 'category').map((c) => attr(c, 'term')).filter(Boolean);
        const primary = attr(child(e, 'primary_category'), 'term');
        const categories = primary ? [primary, ...cats.filter((c) => c !== primary)] : cats;
        return {
          guid: textOf(child(e, 'id')) || textOf(child(e, 'title')),
          title: stripHTML(textOf(child(e, 'title'))) || '(无标题)',
          link: attr(child(e, 'link'), 'href') || textOf(child(e, 'id')),
          author: names.length ? (names.length > 1 ? `${names[0]} 等 ${names.length} 人` : names[0]) : '',
          published: Date.parse(textOf(child(e, 'published')) || textOf(child(e, 'updated'))) || null,
          summary: clamp(stripHTML(textOf(child(e, 'summary')))),
          image: null,
          categories,
        };
      });
      return { name: `arXiv · ${cat}`, items };
    },
  },

  {
    // Apple Podcasts pages carry no feed; iTunes Lookup hands us the feedUrl.
    platform: 'podcast',
    label: '播客',
    match(url) {
      const m = /podcasts\.apple\.com\/(?:[\w-]+\/)?podcast\/(?:[^/]+\/)?id(\d+)/.exec(String(url));
      return m ? { id: m[1] } : null;
    },
    async fetchItems(appleId) {
      const lookup = await get(`https://itunes.apple.com/lookup?id=${appleId}&entity=podcast`);
      const feedUrl = jsonOf(lookup)?.results?.[0]?.feedUrl;
      if (!feedUrl) throw new Error('iTunes 没给出这个播客的 feed 地址');
      const res = await get(feedUrl);
      if (!res.ok) throw new Error(`播客 feed 返回 HTTP ${res.status}`);
      const parsed = parseFeed(res.body, res.finalUrl || feedUrl);
      return { name: parsed.feedTitle || `播客 ${appleId}`, items: parsed.items };
    },
  },
];

// 登录态适配器（知乎、小红书）住在 lib/adapters.private.js，那个文件被
// .gitignore 排除，所以公开仓库里没有它、也不会有人误传上去。本机有就自动
// 挂上，没有就静默跳过——平台会退回 resolve 里的「需要登录态凭证」说明。
function loadPrivateAdapters() {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const extra = require('./adapters.private');
    if (!Array.isArray(extra)) return [];
    return extra.filter((a) => a && typeof a.platform === 'string' && typeof a.match === 'function');
  } catch {
    return [];
  }
}

for (const adapter of loadPrivateAdapters()) {
  if (!adapters.some((a) => a.platform === adapter.platform)) adapters.push(adapter);
}

function matchAdapter(url) {
  for (const adapter of adapters) {
    const m = adapter.match(String(url || ''));
    if (m) return { adapter, id: m.id };
  }
  return null;
}

function adapterCacheKey(platform, id) {
  return `adapter:${platform}:${id}`;
}

/** 当前实际可用的适配器平台名（含本机私有适配器），前端据此决定显示哪些来源卡。 */
function adapterPlatforms() {
  return adapters.map((a) => a.platform);
}

module.exports = { adapters, matchAdapter, adapterCacheKey, parseNextData, adapterPlatforms };
