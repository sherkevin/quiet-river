# WeChat public-provider inclusion requests

Updated: 2026-09-21

## Goal

Try to recover the 16 unresolved Quiet River WeChat subscriptions through public provider inclusion before considering private Wechat2RSS.

Current coverage:
- 65 WeChat sources total
- 49 working public/relay feeds
  - 40 via wechat2rss.bestblogs.dev
  - 9 via wechat2rss.xlab.app
- 16 unresolved / metadata-only

## Public provider audit

BestBlogs public WeChat OPML: 0/16 exact matches; fuzzy/normalized-name review found no credible aliases.

xlab public complete list: 0/16 exact matches.

Therefore none of the 16 should be silently mapped to a similar-looking feed.

## Inclusion channels

### xlab / Wechat2RSS

The public service explicitly accepts公众号 recommendations for inclusion and links users to its repository/collection standard.

Recommended action:
1. Submit the unresolved accounts as recommended public subscriptions.
2. Prefer one request containing the full set with names and one known recent article URL per account.
3. After acceptance, consume only the returned public RSS feed; do not import xlab account/login internals into Quiet River.

### BestBlogs

BestBlogs publicly maintains 375 WeChat RSS sources via Wechat2RSS and says RSS-source recommendations are welcome.

Current GitHub issue creation is restricted, so do not depend on opening a new issue there.

Preferred contact order:
1. existing discussion/contact channel if source recommendations are accepted;
2. project contact email;
3. repository PR only if the maintainers document a source-list contribution workflow.

## Unresolved 16

- 深度学习炼丹
- 灵心通衢
- 智荐阁
- 淘天集团智能算法产品
- 高德技术
- 机器学习与推荐算法
- 摘星星的孩子
- algo邻家米铺
- 推广搜老油条
- 诗品算法
- 阿尘学习笔记
- 秋枫学习笔记
- RecRead
- 州懂学习笔记
- 王喆的AI笔记
- 稳扎稳打学AI

## Submission data required per source

For each account, collect:
- exact public account name
- one recent valid mp.weixin.qq.com article URL
- Quiet River source ID
- verified legacy MP_WXS identity as internal cross-check only
- optional category/tag

Do not submit Quiet River-internal IDs or MP_WXS values to a public provider unless the provider explicitly requests a platform ID. The known article URL is the preferred external identity because Wechat2RSS can derive the account identity from an article link.

## Acceptance gate

A provider result is accepted only after:
- feed URL is returned by the provider;
- feed title/account identity matches the intended source;
- at least one recent article permalink belongs to that account;
- feed can be fetched twice without auth;
- importing it does not duplicate an existing Quiet River source/feed.

## Private Wechat2RSS gate

Do not deploy private Wechat2RSS unless, after public-provider requests:
- several unresolved sources remain genuinely must-have;
- the user accepts maintaining one WeRead-authorized account;
- the software license cost is acceptable;
- the provider is deployed as a separate acquisition service and Quiet River consumes only RSS/JSON Feed outputs.
