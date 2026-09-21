# WeChat acquisition options after skipping WeRSS

Updated: 2026-09-21

## Current Quiet River inventory

- 65 WeChat sources total.
- 49 already have working public/relay RSS feeds:
  - 40 via wechat2rss.bestblogs.dev
  - 9 via wechat2rss.xlab.app
- 16 have verified MP_WXS identity metadata but no working feed.
- WeRSS runtime is intentionally skipped and is no longer a release dependency.

The unresolved 16 are:
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

## Public provider audit

### BestBlogs

BestBlogs publicly states that its 375 maintained WeChat RSS sources are converted through Wechat2RSS and publishes them as OPML under wechat2rss.bestblogs.dev.

Audit result:
- exact name match across the 16 unresolved sources: 0/16
- fuzzy/normalized-name audit: no credible alias match
- low-similarity matches such as “高德技术” -> other unrelated “XX技术” feeds were rejected as false positives

### xlab public Wechat2RSS

The current public complete list was checked directly.

Audit result:
- exact name match: 0/16

Therefore the current public-provider coverage for the 16 unresolved Quiet River sources is 0/16.

## BestBlogs architecture

BestBlogs does not appear to implement a bespoke WeChat crawler in the public BestBlogs codebase. Its public documentation says:
- WeChat sources are converted through Wechat2RSS;
- users can paste a WeChat article link and have the source automatically recognized and connected to RSS;
- its public OPML contains feeds hosted at wechat2rss.bestblogs.dev.

Wechat2RSS exposes the matching provider APIs:
- /addurl?url=<mp.weixin.qq.com article> parses the account identity from an article URL and registers it;
- /add/:id registers a known account ID;
- /feed/:id.xml and JSON Feed expose normalized feeds;
- /list, /opml, /api/query provide management/query surfaces.

The exact BestBlogs private-backend call sequence is not public, so the statement “BestBlogs calls /addurl” should be treated as a strong interface-level inference, not a directly observed private implementation detail.

## Wechat2RSS vs WeRSS for Quiet River

| Dimension | Wechat2RSS | WeRSS / we-mp-rss | Quiet River implication |
| --- | --- | --- | --- |
| Product boundary | Dedicated WeChat acquisition service | Broader WeChat RSS application with multiple acquisition modes | Wechat2RSS maps more cleanly to an external acquisition-provider boundary |
| Login dependency | Requires WeRead-authorized WeChat account(s) | The weread_mp path also requires WeRead QR/session authorization | Neither is a zero-account solution |
| Multi-account / risk state | Explicit account list, available/needCheck/waitTime, backoff after risk control | Supports auth expiry notification and several acquisition modes; our pinned integration needed direct QR/session handling | Wechat2RSS exposes more purpose-built operational state for an account pool |
| Risk-control behavior | Automatic retry/backoff; wait grows from 15m up to 6h; recovery resets backoff | Depends on selected mode; our runtime work required more custom orchestration/gating | Wechat2RSS is more provider-like operationally |
| Update model | Dedicated background subscription updates; public service reports ~6h average and targets <=24h | Has scheduled updates but our Quiet River integration disabled upstream schedulers to preserve one scheduler owner | Wechat2RSS can remain an autonomous provider while Quiet River consumes RSS |
| Onboarding new account | /addurl can derive account identity from one known article URL | Our WeRSS path relied on pre-resolved MP_WXS identity | Wechat2RSS is better for “paste article -> subscribe author” UX |
| Migration handling | Current release supports automatic following when a public account migrates | Not a capability we validated in the pinned WeRSS integration | Useful for long-lived subscriptions |
| Feed output | RSS + JSON Feed; optional static files; opaque HMAC feed IDs | RSS output | Wechat2RSS gives a cleaner provider contract |
| Resource footprint | Official deployment recommends >=512 MiB; Docker image | Our pinned WeRSS runtime needed additional hardening and 2 GiB swap on ECS | Wechat2RSS appears lighter operationally |
| License/cost | Private deployment is subscription-licensed software; LIC_EMAIL + LIC_CODE | Open source MIT | WeRSS is cheaper; Wechat2RSS trades money for a maintained provider product |
| Maintenance cadence | Current official changelog active through 2026-07-31 | Open source project also active, but Quiet River required pinned overrides and runtime hardening | For a small personal system, maintained provider behavior is valuable |
| Historical crawl | Fetches latest 20 per crawl; does not promise full history | Different modes may expose different history | Neither should be treated as a complete archival crawler |
| Scope of WeChat messages | Official docs state RSS records mass-send messages; non-mass-published articles may not appear | Depends on acquisition mode | Important semantic limitation for both provider designs |

## Decision for Quiet River

Do not reintroduce WeRSS.

Do not deploy private Wechat2RSS yet solely because the public pools miss 16 sources.

Current preferred policy:

wechat.author.posts
1. existing BestBlogs public Wechat2RSS feed
2. existing xlab public Wechat2RSS feed
3. other verified public provider if discovered
4. disabled / metadata-only

wechat.article.read
1. direct known-link reader
2. Shervin/browser fallback if needed

Private Wechat2RSS becomes justified only if:
- several of the unresolved 16 are must-have long-term sources;
- public-provider inclusion remains unavailable;
- the user accepts maintaining one WeRead-authorized WeChat account and the software license.

If that gate is crossed, private Wechat2RSS should run as a separate acquisition service. Quiet River should consume only its RSS/JSON Feed outputs and should not import its account/login/risk-control internals into the Reader scheduler.

## Next low-cost action

Monitor/request public-provider inclusion for the unresolved 16 before paying the operational cost of a private provider. Keep all 16 disabled rather than fabricating coverage or mapping them to fuzzy-name feeds.
