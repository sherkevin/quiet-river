# Agent-Reach integration progress report

This is the append-only engineering report for the Agent-Reach acquisition workstream.

Pinned upstream: Panniantong/Agent-Reach at a19a171fa980a0785849596492e0af4db800c82f, MIT.

## 2026-09-20 — Foundation

### Goal

Adapt Agent-Reach's reliable platform-routing model without replacing Quiet River's subscription/storage/reader layers.

### Completed

- cloned pinned Agent-Reach reference to ECS at /home/qr-dev/work/vendor/Agent-Reach;
- created isolated Quiet River worktree /home/qr-dev/work/quiet-river-capabilities;
- created branch chatgpt/capability-router-v1;
- added MIT attribution under third_party/agent-reach/;
- ported stable capability / ordered backend / active backend / health-reason model to Node.js;
- added backend execution registry so ReaderService no longer owns transport-specific branching;
- exposed capability/backend status in blogger and acquisition-health UI;
- added explicit authenticated acquisition doctor while keeping passive health zero-network;
- doctor only probes Shervin heartbeat and loopback runtimes;
- declared first ordered policy: xiaohongshu.notes -> OpenCLI @ Shervin -> xiaohongshu-mcp @ ECS;
- unconfigured MCP remains off and cannot become active without its own probe.

### Commits

- b9b7a47 refactor: add acquisition capability router
- 050b4df feat: declare ordered acquisition fallback
- 304bc2d feat: add acquisition backend doctor

### Verification

- exact serial evidence for 304bc2d: 309/309, worktree unchanged;
- branch pushed to GitHub;
- not deployed to production because the main WeRSS QR canary/release gate is still open.

### Important conclusion

The main value to absorb from Agent-Reach is not only its architecture. It is the maintained platform-acquisition knowledge encoded in per-platform backend ordering, real probes, retired paths and repair instructions.

Current Quiet River gap discovered during comparison:
- all 28 Twitter sources depend on one third-party host: api.xgo.ing;
- Agent-Reach maintains Twitter as twitter-cli -> OpenCLI -> bird legacy.

Therefore Twitter is the first platform migration target.

### Next

P0 Twitter/X:
1. inventory all 28 source identities;
2. prove canonical handle mapping;
3. inspect Shervin for twitter-cli and its credential boundary;
4. define a read-only author timeline contract;
5. add backend policy while keeping xgo as fallback;
6. run one dual-backend identity canary.


## 2026-09-20 — P0 Twitter inventory and tool contract

### Inventory

- 28/28 Twitter sources use canonical source URLs of the form https://x.com/<handle>.
- 28/28 currently depend on the same third-party feed host: api.xgo.ing.
- The current xgo RSS guid is the numeric tweet ID itself.
- xgo item links are canonical https://x.com/<handle>/status/<tweet-id> URLs.

This means a direct Twitter backend can preserve historical Quiet River identity by using the numeric tweet ID as guid; no historical entry migration is required.

### Shervin runtime

- Agent-Reach preferred twitter-cli was not previously installed.
- Installed twitter-cli 0.8.5 on Shervin using uv tool install.
- Help/source inspection confirms user-posts provides structured id, text, author.screenName and createdAtISO fields.
- twitter-cli authentication code prefers explicit TWITTER_AUTH_TOKEN + TWITTER_CT0 but falls back to browser_cookie3 when they are missing.
- Quiet River will therefore hard-gate twitter-cli execution: if explicit credentials are absent, the process is not launched at all. Browser-cookie auto-discovery is not an allowed fallback.
- No browser cookies were read or exported during installation/inspection.

### OpenCLI fallback

- OpenCLI Twitter supports tweets <username> with id, author, text, created_at and canonical url.
- A Karpathy read-only canary currently fails in the Twitter Browser Bridge path; the failure is not AUTH_REQUIRED, 403, 429 or the known Chromium Navigation rejected case.
- Shervin collector doctor still confirms the OpenCLI extension and restricted ECS connection are healthy, so the failure is Twitter-adapter-specific rather than a general browser-runtime outage.

### Capability model update in progress

Target ordered policy:

twitter.author.posts
1. twitter-cli @ Shervin
2. OpenCLI Twitter @ Shervin
3. api.xgo.ing Twitter Feed

The existing xgo feed remains the active backend until a direct backend passes a real identity-parity canary.

## 2026-09-20 — P0 Twitter canonical identity milestone

### Completed

- normalized all existing X feeds into one logical capability: `twitter.author.posts`;
- declared ordered candidates: `twitter-cli @ Shervin -> OpenCLI Twitter @ Shervin -> api.xgo.ing Twitter Feed`;
- verified a real xgo feed uses numeric tweet ID as RSS guid and canonical x.com status URL;
- added canonical Twitter original-link validation on Windows/ECS boundaries;
- added one normalizer supporting both twitter-cli 0.8.5 JSON and OpenCLI Twitter JSON;
- enforced source-handle equality and numeric tweet ID before upload/import;
- same tweet from twitter-cli/OpenCLI/xgo now maps to the same logical tweet ID contract;
- installed twitter-cli 0.8.5 on Shervin via uv without reading/exporting browser cookies;
- audited twitter-cli auth source: because it can auto-fallback to browser_cookie3, Quiet River will never launch it unless explicit TWITTER_AUTH_TOKEN + TWITTER_CT0 are already present;
- OpenCLI Twitter author-timeline canary currently fails in a Twitter-specific Browser Bridge path, while the general Shervin collector doctor remains healthy; it is therefore not promoted over xgo.

### Verification

- focused Twitter/capability/collector tests passed;
- full regression after canonicalizer changes: 314/314 passed;
- no production routing change; xgo remains active backend until a direct backend passes a real identity-parity canary.

### Next

Implement single scheduler-owner routing for `twitter.author.posts`: one persisted logical channel/job, with ECS/xgo ownership by default and Shervin ownership only when an explicit direct backend is proven usable. No duplicate simultaneous polling.

## 2026-09-20 — P0 Twitter single-owner failover milestone

### Design completed

Quiet River now keeps exactly one persisted Twitter channel/job per subscribed author. The existing xgo channel is not duplicated or migrated.

Routing semantics:

- when no verified direct backend exists, ECS/Miniflux continues to refresh the existing xgo feed;
- when Shervin reports a direct backend as verified and fresh, the same queued logical job is temporarily worker-owned by Shervin;
- direct success imports into the same channel/feed identity and leaves the xgo physical health group untouched;
- direct failure records backend-specific cooldown, requeues the same logical job and lets xgo take over immediately;
- Shervin backend readiness reports expire after 120 seconds, so stale worker state cannot permanently steal scheduler ownership;
- direct backend health and xgo feed health are separate failure domains.

### Credential boundary

Installed twitter-cli 0.8.5 is not invoked through its top-level authentication helper. A new read-only `tools/windows/twitter-explicit.py` wrapper imports `TwitterClient` directly and accepts credentials only from `TWITTER_AUTH_TOKEN` and `TWITTER_CT0`. It never imports `twitter_cli.auth`, `get_cookies`, or `browser_cookie3`.

The collector reports `twitter-cli-shervin=off` when explicit credentials are absent. Credentials being present is still insufficient: an explicit read-only author canary must pass, and only a verification timestamp less than 24 hours old may produce backend status `ok`.

OpenCLI Twitter follows the same rule: Browser Bridge connected is only `warn`; a successful explicit Twitter timeline canary is required for `ok`.

### Failure-domain evidence

A bounded diagnostic of the 28 existing xgo sources found only 4 sources returned within the test window; 24 did not complete within the bounded check. This is not treated as a permanent outage claim, but it reinforces that all 28 sources sharing one third-party host is a material reliability risk.

Across 77 items from the four responsive feeds, the item-link handle always matched the subscribed handle (0 mismatches).

### Verification

- direct-backend claim uses the existing public xgo channel, not a second channel;
- direct success does not mutate the xgo group;
- direct failure returns `FALLBACK_QUEUED`, requeues the same job and restores xgo as active fallback;
- ECS pump does not run xgo while Shervin owns the capability;
- scheduler may give direct ownership even when the xgo physical group itself is unhealthy;
- the explicit Python wrapper is tested with a fake twitter_cli package to prove explicit credential injection and retweet filtering;
- full regression: 320/320 passed.

### Remaining Twitter gate

No direct backend is enabled in production yet. twitter-cli requires explicit user-supplied Twitter credentials and OpenCLI Twitter has not passed its author-timeline canary. Until one direct backend passes a real parity canary, xgo remains the active production path.
