'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseXML, child, children, descendant, textOf, attr } = require('../lib/xml');
const { parseFeed, looksLikeFeed, stripHTML } = require('../lib/feeds');
const { detectPlatform } = require('../lib/resolve');

test('XML: CDATA 内容按原样保留，不再解一次实体', () => {
  const doc = parseXML('<rss><channel><item><title><![CDATA[A &amp; B &lt;C&gt;]]></title></item></channel></rss>');
  assert.equal(textOf(descendant(doc, 'title')), 'A &amp; B &lt;C&gt;');
});

test('XML: 普通文本里的实体要解码', () => {
  const doc = parseXML('<t><a>Tom &amp; Jerry &#8212; &#x4e2d;</a></t>');
  assert.equal(textOf(child(doc.children[0], 'a')), 'Tom & Jerry — 中');
});

test('XML: 属性值里的 > 不会提前结束标签', () => {
  const doc = parseXML('<link rel="alternate" href="http://x/?a=1&gt;b" /><t>ok</t>');
  assert.equal(attr(child(doc, 'link'), 'href'), 'http://x/?a=1>b');
  assert.equal(textOf(child(doc, 't')), 'ok');
});

test('XML: 自闭合标签不进栈', () => {
  const doc = parseXML('<feed><entry><title>a</title><x /><title>b</title></entry></feed>');
  const titles = children(descendant(doc, 'entry'), 'title');
  assert.deepEqual(titles.map(textOf), ['a', 'b']);
});

test('XML: 命名空间前缀按 local name 匹配', () => {
  const doc = parseXML('<item><dc:creator>张三</dc:creator><media:content url="http://i/1.jpg" medium="image"/></item>');
  const item = doc.children[0];
  assert.equal(textOf(child(item, 'creator')), '张三');
  assert.equal(attr(child(item, 'content'), 'url'), 'http://i/1.jpg');
});

test('XML: 闭合标签不匹配时不炸，已读到的内容保留（已知取舍：后续同名标签会被嵌套）', () => {
  const doc = parseXML('<rss><channel><item><title>好的</title></wrong><item><title>第二条</title></item></channel></rss>');
  const channel = descendant(doc, 'channel');
  const items = children(channel, 'item');
  assert.equal(items.length, 1, '第二条 item 被嵌进了第一条里，这是降级行为不是崩溃');
  assert.equal(textOf(child(items[0], 'title')), '好的');
  const nested = children(items[0], 'item');
  assert.equal(nested.length, 1, '第二条 item 嵌在第一条里面');
  assert.equal(textOf(child(nested[0], 'title')), '第二条', '嵌套的那条内容没丢');
});

test('XML: 注释与 XML 声明被跳过', () => {
  const doc = parseXML('<?xml version="1.0"?><!-- hi --><rss><channel><title>T</title></channel></rss>');
  assert.equal(textOf(descendant(doc, 'title')), 'T');
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>某博客</title>
    <link>https://example.com</link>
    <item>
      <title>第一条 &amp; 唯一</title>
      <link>https://example.com/p1</link>
      <guid>tag:example.com,2026:p1</guid>
      <pubDate>Wed, 09 Sep 2026 08:30:00 +0800</pubDate>
      <dc:creator>mail@example.com (王小明)</dc:creator>
      <description><![CDATA[<p>这是<b>摘要</b>，带标签。</p>]]></description>
      <media:content url="/img/cover.png" medium="image"/>
    </item>
    <item>
      <title>没有时间的一条</title>
      <link>https://example.com/p2</link>
      <description>纯文本摘要</description>
    </item>
  </channel>
</rss>`;

test('RSS 2.0: 字段齐全，相对图片地址被解析成绝对地址', () => {
  const { feedTitle, items } = parseFeed(RSS, 'https://example.com/feed.xml');
  assert.equal(feedTitle, '某博客');
  assert.equal(items.length, 2);

  const first = items[0];
  assert.equal(first.title, '第一条 & 唯一');
  assert.equal(first.link, 'https://example.com/p1');
  assert.equal(first.guid, 'tag:example.com,2026:p1');
  assert.equal(first.author, '王小明', 'RSS 的 "mail (Name)" 格式应取出括号里的显示名');
  assert.equal(first.summary, '这是摘要，带标签。');
  assert.equal(first.image, 'https://example.com/img/cover.png');
  assert.equal(new Date(first.published).toISOString(), '2026-09-09T00:30:00.000Z');

  assert.equal(items[1].published, null, '没有 pubDate 就该是 null，不能默认成现在');
});

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 站</title>
  <entry>
    <id>urn:uuid:1</id>
    <title type="html">Atom &lt;em&gt;标题&lt;/em&gt;</title>
    <link rel="enclosure" href="/a.mp3"/>
    <link rel="alternate" href="/post-1"/>
    <updated>2026-09-08T12:00:00Z</updated>
    <author><name>李四</name></author>
    <summary type="html">前 500 字摘要</summary>
    <content type="html">&lt;p&gt;正文&lt;/p&gt;</content>
  </entry>
</feed>`;

test('Atom: 取 rel=alternate 的链接，标题里的 HTML 标签被清掉', () => {
  const { feedTitle, items } = parseFeed(ATOM, 'https://atom.example/blog');
  assert.equal(feedTitle, 'Atom 站');
  assert.equal(items.length, 1);
  assert.equal(items[0].link, 'https://atom.example/post-1');
  assert.equal(items[0].title, 'Atom 标题', 'type="html" 的标题要解实体再清标签，中文旁不留空格');
  assert.equal(items[0].author, '李四');
  assert.equal(items[0].summary, '前 500 字摘要');
  assert.equal(items[0].guid, 'urn:uuid:1');
});

test('JSON Feed 也能进同一条河', () => {
  const body = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'JSON 站',
    items: [
      { id: '9', url: 'https://j.example/9', title: '第九条', content_text: '正文文字', date_published: '2026-09-07T00:00:00Z', image: '/cover.jpg' },
    ],
  });
  assert.ok(looksLikeFeed(body, 'application/feed+json'));
  const { feedTitle, items } = parseFeed(body, 'https://j.example/feed.json');
  assert.equal(feedTitle, 'JSON 站');
  assert.equal(items[0].title, '第九条');
  assert.equal(items[0].image, 'https://j.example/cover.jpg');
});

test('摘要会去掉 HTML、压空白、并按上限截断', () => {
  const long = 'a'.repeat(900);
  const html = `<rss><channel><item><title>t</title><description><![CDATA[<div>${long}</div>]]></description></item></channel></rss>`;
  const { items } = parseFeed(html, 'https://x/');
  assert.ok(items[0].summary.length <= 401, `摘要长度 ${items[0].summary.length} 应被截断`);
  assert.ok(items[0].summary.endsWith('…'));
  assert.equal(stripHTML('<p>a<br>b</p><script>evil()</script>c'), 'a\nb\nc');
});

test('不是 feed 的东西要报错，不能静默返回空', () => {
  assert.throws(() => parseFeed('<html><body>登录页</body></html>', 'https://x/'), /not a recognised feed format/);
  assert.equal(looksLikeFeed('<html><body>x</body></html>', 'text/html'), false);
  assert.equal(looksLikeFeed('', 'application/rss+xml'), true);
});

test('文章级分类：RSS <category> 与 Atom <category term> 都抽出来并去重', () => {
  const rss = `<rss><channel><item><title>t</title><category>推荐</category><category>推荐</category><category>工程</category></item></channel></rss>`;
  assert.deepEqual(parseFeed(rss, 'https://x/').items[0].categories, ['推荐', '工程']);
  const atom = `<feed><entry><title>t</title><category term="Machine Learning"/><category term="Machine Learning"/></entry></feed>`;
  assert.deepEqual(parseFeed(atom, 'https://x/').items[0].categories, ['Machine Learning']);
  const bare = `<rss><channel><item><title>t</title></item></channel></rss>`;
  assert.deepEqual(parseFeed(bare, 'https://x/').items[0].categories, []);
});

test('即刻 __NEXT_DATA__ 提取：属性顺序无关，坏 JSON 降级为 null', () => {
  const { parseNextData } = require('../lib/adapters');
  const ok = '<html><script type="application/json" id="__NEXT_DATA__">{"props":{"pageProps":{"posts":[{"id":"a"}]}}}</script></html>';
  assert.deepEqual(parseNextData(ok).props.pageProps.posts, [{ id: 'a' }]);
  const reordered = '<script id="__NEXT_DATA__" type="application/json">{"x":1}</script>';
  assert.equal(parseNextData(reordered).x, 1);
  assert.equal(parseNextData('<script id="__NEXT_DATA__">{broken</script>'), null);
  assert.equal(parseNextData('<html>no script</html>'), null);
});

test('免凭证适配器的 URL 匹配规则', () => {
  const { matchAdapter } = require('../lib/adapters');
  const cases = [
    ['https://juejin.cn/user/3051900006845944', 'juejin', '3051900006845944'],
    ['https://sspai.com/u/796518', 'sspai', '796518'],
    ['https://sspai.com/u/some-slug', 'sspai', 'some-slug'],
    // nil UUID，不是真实用户：公开仓库的测试夹具不该带别人的标识符
    ['https://web.okjike.com/u/00000000-0000-4000-8000-000000000000', 'jike', '00000000-0000-4000-8000-000000000000'],
    ['https://news.ycombinator.com/user?id=pg', 'hackernews', 'pg'],
    ['https://www.semanticscholar.org/author/Yann-LeCun/1688882', 'semanticscholar', '1688882'],
  ];
  for (const [url, platform, id] of cases) {
    const hit = matchAdapter(url);
    assert.ok(hit, url);
    assert.equal(hit.adapter.platform, platform, url);
    assert.equal(hit.id, id, url);
  }
  for (const url of ['https://github.com/torvalds', 'https://space.bilibili.com/2267573', 'https://blog.csdn.net/v_JULY_v', 'https://example.com/']) {
    assert.equal(matchAdapter(url), null, url);
  }
});

test('平台识别：hostname 与路径决定归属', () => {
  const cases = {
    'https://www.youtube.com/@acmrecsys': 'youtube',
    'https://www.youtube.com/channel/UC123': 'youtube',
    'https://github.com/wzhe06': 'github',
    'https://github.com/Doragd/Algorithm-Practice-in-Industry': 'github',
    'https://someone.substack.com': 'substack',
    'https://medium.com/@user': 'medium',
    'https://www.reddit.com/r/recommendersystems/': 'reddit',
    'https://space.bilibili.com/1369507485': 'bilibili',
    'https://juejin.cn/user/123': 'juejin',
    'https://blog.csdn.net/abc': 'csdn',
    'https://www.zhihu.com/people/si-ta-xi': 'zhihu',
    'https://zhuanlan.zhihu.com/p/123': 'zhihu',
    'https://www.xiaohongshu.com/user/profile/abc': 'xiaohongshu',
    'https://mp.weixin.qq.com/s?__biz=x': 'wechat',
    'https://weibo.com/u/123': 'weibo',
    'https://x.com/edchi': 'twitter',
    'https://bsky.app/profile/handle.bsky.social': 'bluesky',
    'https://arxiv.org/list/cs.IR/recent': 'arxiv',
    'https://mastodon.social/@someone': 'mastodon',
    'https://yaoyuanzhou.github.io/': 'blog',
    'https://eugeneyan.com/': 'blog',
    'space.bilibili.com/123': 'bilibili',
    '不是链接': 'unknown',
  };
  for (const [url, expected] of Object.entries(cases)) {
    assert.equal(detectPlatform(url), expected, url);
  }
});
