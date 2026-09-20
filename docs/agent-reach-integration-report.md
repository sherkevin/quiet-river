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

## 2026-09-20 — P1 Instagram author-source preparation

### Implemented

- added canonical Instagram profile identity for author sources;
- reserved/system/content routes are rejected as author identities;
- added one Shervin-owned `instagram.posts` desktop channel;
- added stable post identity `instagram:<shortcode>` for both /p/ and /reel/ URLs;
- Windows normalizer requires the returned media author to equal the registered source username;
- ECS repeats the author/URL identity validation before import;
- added a bounded read-only wrapper that uses the same Instagram feed-by-username endpoint as OpenCLI, serializes only media ID/shortcode/author/caption/time/type/canonical URL, and performs no write action;
- UI/platform filters and add-source flow now understand Instagram.

### Verification

- focused collector/original-link/source tests: 90/90 passed;
- full regression with Instagram preparation: 327/327 passed;
- read-only NASA canary through the Quiet River wrapper: exit 70, 0 rows, Browser Bridge failure;
- independent OpenCLI `instagram profile nasa` and `instagram user nasa` probes: both exit 69 (EX_UNAVAILABLE / BROWSER_CONNECT), 0 JSON rows;
- failure is therefore upstream Browser Bridge/runtime, not Quiet River normalization;
- no login was automated and no Instagram content was imported.

### Gate

Shervin runs OpenCLI 1.8.7 with Browser Bridge extension 1.0.21. OpenCLI reports newer extension 1.0.24 is available. The current extension installation path could not be identified as a safe unpacked directory, so Quiet River does not mutate the daily Chrome extension installation automatically.

Instagram remains **prepared but not verified**. Do not enable scheduled Instagram acquisition until a supported extension/runtime upgrade succeeds and the same NASA-style read-only canary returns stable author/post identities.

## 2026-09-20 — P2 V2EX Community source preparation

### Implemented

- introduced the first non-Author Quiet River source identity: `sourceType=community`;
- `https://www.v2ex.com/go/<node>` is a canonical V2EX Community source; topic/member pages are not accepted as source identities;
- added `v2ex.community.posts -> v2ex-public-api` backend;
- topic numeric ID is the stable item identity and canonical card URL is `https://www.v2ex.com/t/<id>`;
- backend accepts only rows whose node exactly equals the subscribed node;
- topic content is HTML-escaped before import;
- replies are intentionally not fetched during discovery and remain a future article-detail enrichment;
- HTTP and invalid-JSON failures throw acquisition errors rather than returning an empty timeline;
- UI/state expose Community separately while preserving the existing Blogger semantics for Author sources;
- channel defaults to disabled and requires `V2EX_READY=true` after a real connectivity canary.

### Verification

- focused V2EX/capability/source tests: 48/48 passed;
- full regression: 334/334 passed;
- ECS direct Node request: timeout;
- ECS system curl direct: TCP 443 timeout;
- ECS existing Mihomo loopback proxy: SSL connection timeout;
- ECS Jina Reader route: connection timeout;
- Shervin direct curl: connection timeout.

### Gate

The implementation is prepared but **not connected**. Current runtime networks cannot reach V2EX. No scheduler traffic is enabled and no V2EX source is claimed working. A future network-path change must first pass the same read-only node canary, then explicitly set `V2EX_READY=true`.
