# WeChat RSS Provider Audit 2026-09-22

## Conclusion

Quiet River should not implement WeChat acquisition itself. The missing capability is provider coverage: some公众号 have no RSS URL from the providers currently connected.

## Track A: Public providers

Current public sources checked before this report:

- xlab Wechat2RSS public list
- BestBlogs Wechat2RSS OPML

The unresolved 16公众号 remain without matched public feed entries.

Next action is not Reader development; it is provider discovery or provider-side subscription.

## Track B: Self-host Wechat2RSS

Wechat2RSS provides the required acquisition boundary:

公众号ID/article URL -> Wechat2RSS -> RSS feed -> Quiet River

Verified capabilities from documentation:

- add subscription by公众号 ID
- add subscription by article URL
- RSS/XML/JSON feed output
- account login management
- automatic updates

A source checkout was inspected. The public repository is primarily documentation/list material; deployment is delivered through a Docker image rather than a complete crawler implementation in the repository.

Therefore a true zero-cost self-host decision still requires checking the published image/license path. The public deployment docs require license email/code configuration.

## Decision state

Do not change Quiet River architecture.

Preferred order:

1. exhaust public Wechat2RSS provider coverage;
2. evaluate official/self-host Wechat2RSS if private acquisition is justified;
3. keep Quiet River consuming only RSS.

## Further verification

- xlab public list page was reachable and contains the public feed catalogue. The six high-value unresolved sources (`王喆的AI笔记`, `机器学习与推荐算法`, `RecRead`, `淘天集团智能算法产品`, `智荐阁`, `高德技术`) were not found by direct name matching in the public catalogue HTML checked during this audit.
- xlab's public list is a generated catalogue rather than an open OPML file at `/opml`; the deployment/API documentation remains the source for add/feed behavior.
- The current evidence still supports the same decision: do not modify Quiet River to understand WeChat. The remaining work is provider acquisition.
