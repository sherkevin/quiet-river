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

## 2026-09-20 — Instagram explicitly skipped by credential policy

The user has no Instagram account and does not want an Instagram integration that requires account creation, cookies or a logged-in browser session. Agent-Reach's pinned Instagram channel explicitly depends on OpenCLI using the user's logged-in Chrome session. Quiet River's no-account NASA canary returned no rows and did not establish a zero-account path.

Decision: mark Instagram **SKIPPED**, not merely blocked. Do not request Instagram credentials, do not automate login, and do not enable the prepared feature-branch code in production. Revisit only if a stable no-account public acquisition path is independently verified.


## 2026-09-20 — Instagram fail-closed hardening after skip decision

Instagram remains SKIPPED by product/credential policy; this work does not reopen the integration.

Hardening completed so dormant feature-branch code cannot accidentally become active merely because Shervin is online:

- introduced explicit backend identity opencli-instagram-shervin;
- capability health now consumes the platform-specific Shervin backend report instead of generic desktop heartbeat;
- unverified Instagram reports off, not healthy;
- scheduler ownership requires backend status ok from a recent explicit author canary;
- added --verify-instagram HANDLE for a bounded read-only canary, but no login is automated;
- AUTH_REQUIRED recovery uses two successful read-only probes before refreshing Instagram verification state;
- acquisition doctor reports the platform backend separately;
- a successful channel check is still required before capability status becomes fully healthy.

Real environment remains unchanged: Shervin has no usable Instagram login state, OpenCLI profile/user canaries return AUTH_OR_LOGIN, and no Instagram content was imported.

Verification after hardening: focused 112/112; full regression 337/337.


## 2026-09-20 — P1 GitHub public commit enrichment

### Decision

Do not replace official GitHub Atom feeds. Five active Quiet River GitHub sources are repository commit feeds and already provide stable discovery/text. Agent-Reach's gh CLI is useful, but public GitHub REST is a better first enrichment backend for public commits because it needs no new ECS credential.

### Implemented

- added a generic entry_enrichments cache table for future cross-platform enrichment state;
- added canonical commit/compare target parser limited to github.com owner/repo commit SHA or SHA-to-SHA compare paths;
- added public GitHub REST adapter with trusted=false, 10s timeout and 2 MiB response bound;
- commit responses must match requested repository and SHA prefix before rendering;
- compare responses must match requested base/head and repository before rendering;
- commit messages, filenames and statuses are HTML-escaped;
- explicit article prepare enriches GitHub commit/compare entries with commit message, stats and changed files;
- success is cached so repeated prepare does not repeat the REST request;
- Miniflux receives title/content only; read state is not sent;
- imports/entries provenance is marked github_rest_enrichment;
- REST/rate-limit/JSON/identity failure keeps the existing Atom body and may fall through to the prior generic full-text path.

### Verification

- focused GitHub enrichment tests: 6/6 passed;
- full regression: 343/343 passed;
- real read-only public REST canary:
  - repository Doragd/Algorithm-Practice-in-Industry;
  - requested commit prefix 7b734408e365;
  - generated structured detail length 564 characters;
  - changed-files section present;
  - anonymous x-ratelimit-remaining: 58 after canary;
  - no production database mutation.

### Credential boundary

Shervin already has gh 2.92.0 authenticated through Windows keyring. That credential was not copied to ECS and is not required for public commit enrichment. gh remains a potential second backend for private/richer detail only.


## 2026-09-20 — P1 YouTube subtitle enrichment

### Decision

Keep the official YouTube channel Atom feed as discovery. Add yt-dlp only as an explicit article enrichment backend for public subtitles; do not download video/audio and do not create a second scheduler path.

### Runtime

- upstream latest stable verified from official release metadata: yt-dlp 2026.08.19;
- official yt-dlp asset SHA-256: 1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6;
- installed at /opt/quiet-river-tools/yt-dlp/2026.08.19/yt-dlp;
- repository installer deploy/install-ytdlp.sh pins both version and SHA and rejects version mismatch;
- direct ECS YouTube extraction exceeded the bounded canary window;
- existing loopback Mihomo proxy http://127.0.0.1:7890 succeeded and is the default bounded network path.

### Implemented

- canonical YouTube watch/youtu.be video identity parser;
- pinned yt-dlp invocation with --ignore-config, --no-playlist, --skip-download, en-orig/en JSON3 automatic captions;
- no cookies or browser-profile options;
- socket timeout 10s, retries 1, extractor retries 1, process timeout 45s;
- loopback-only proxy validation;
- temporary subtitle directory always removed;
- subtitle file maximum 4 MiB and rendered transcript maximum 500,000 characters;
- JSON3 segments are normalized, consecutive duplicates removed and grouped into timestamped escaped paragraphs;
- successful transcript is appended to the existing Atom body and cached via entry_enrichments/youtube_transcript_v1;
- imports/entries provenance becomes youtube_subtitle_enrichment without changing article URL/publication/read state;
- UI uses explicit 获取字幕 / 正在获取字幕 labels;
- failure records enrichment failure while retaining the original Atom content.

### Verification

- focused YouTube/backend tests: 18/18 passed;
- full regression: 350/350 passed;
- real ACM RecSys public video canary:
  - video ID TlR7douxQRM;
  - yt-dlp doctor status READY;
  - language en-orig;
  - transcript 48,934 characters;
  - 42 timestamped paragraphs;
  - rendered HTML 51,515 characters;
  - not truncated;
  - no production database mutation and no media download.

### Remaining

No additional YouTube discovery work is needed. Optional future work is richer video metadata only if a concrete reader use case appears.


## 2026-09-20 — P1 Bilibili public video-detail enrichment

### Agent-Reach input and local decision

Agent-Reach's pinned Bilibili channel records a valuable reliability finding: yt-dlp should not be used for Bilibili because live tests hit 412 risk control, while bili-cli/OpenCLI are the maintained Bilibili-specific paths.

Quiet River tested the narrower need actually required by the reader: public video detail for already-discovered BV items. The unauthenticated Bilibili x/web-interface/view endpoint was simpler than installing the full bili-cli dependency graph and passed every current author canary. Therefore the production-oriented order is now:

1. Bilibili Public Detail API @ ECS
2. bili-cli fallback only if the public detail API later fails real canaries
3. OpenCLI remains responsible for author discovery and future subtitle enrichment

### Runtime/dependency decision

- audited PyPI bilibili-cli 0.6.2 and its source before attempting installation;
- confirmed its pure video command calls public get_video_info with credential=None, while optional subtitle/comments/etc paths may load credentials;
- an isolated pip --target install was started only for evaluation, but dependencies were unnecessarily heavy for the narrow detail use case;
- after the public API passed all four real source canaries, the unfinished bili-cli install and orphan pip process were terminated and its target directory removed;
- no new Bilibili credential, browser cookie or system Python package is required.

### Implemented

- canonical https://www.bilibili.com/video/BV... target parser;
- bounded public detail API request with browser-like User-Agent/Referer but no Cookie/Authorization;
- response must be HTTP 200, JSON, code=0 and contain data;
- returned BV must equal the stored item BV;
- returned owner UID must equal the subscribed channel author_id before any write;
- escaped structured HTML with title, UP owner, duration, interaction stats and description;
- explicit article prepare uses prepareKind=bilibili-detail and UI label 获取视频详情;
- successful enrichment caches bilibili_detail_v1 in entry_enrichments and marks provenance bilibili_public_detail_enrichment;
- failure caches FAILED but leaves the original META card and read/url/publication metadata unchanged;
- acquisition doctor exposes the backend observationally without contacting Bilibili.

### Verification

- focused Bilibili/backend tests: 19/19 passed;
- full regression: 358/358 passed;
- first raw API canary on AITIME: HTTP 200, code 0, owner UID 503316308 matched;
- four-source formal module canary: 4/4 current Bilibili subscriptions passed exact BV + owner UID validation;
- generated structured detail HTML sizes across the four samples: 333, 526, 339, 497 characters;
- no production database mutation during canaries.

### Remaining

Bilibili subtitle enrichment remains a separate OpenCLI-backed task. Author discovery stays unchanged on Shervin and is not replaced by the public detail API.


## 2026-09-20 — P1 Bilibili subtitle enrichment

### Real backend canary

OpenCLI 1.8.7 on Shervin was tested against the already-known AITIME video BV1AaJP6iEch using the read-only bilibili subtitle command.

Result:
- first navigation hit the known Chromium Navigation rejected condition;
- the existing one-time retain-on-failure retry succeeded;
- 2,635 subtitle rows returned;
- all from/to timestamp fields validated;
- 38,436 transcript characters;
- no subtitle text, Cookie or browser payload was printed into the engineering report.

### Architecture

Subtitle completion is intentionally independent from article content_state.

A Bilibili card may already be TEXT after public video-detail enrichment while its subtitle is still absent. The desktop enrichment queue therefore gained a backward-compatible kind column:
- body -> entry_body_v1 for Zhihu/Xiaohongshu;
- bilibili_subtitle -> entry_transcript_v1 for Bilibili.

Existing rows migrate with kind=body.

### Safety and failure semantics

- ECS only queues a known stored Bilibili entry after validating its canonical original URL and subscribed UID/channel;
- Shervin runs only the fixed OpenCLI bilibili subtitle command;
- Windows normalizer accepts at most 20,000 subtitle rows, validates monotonic from/to timestamps, removes consecutive duplicate text and uploads at most 1 MiB of timestamped plain text;
- ECS escapes the transcript before appending it under a Bilibili Transcript section;
- combined article content is capped at 2 MiB;
- successful transcript is cached as entry_enrichments/bilibili_subtitle_v1 with provenance bilibili_subtitle_enrichment;
- subtitle AUTH_REQUIRED is isolated to the single transcript task; it does not set desktop:bilibili or the author channel to AUTH_REQUIRED;
- explicit retry can requeue that subtitle task after the user later logs in;
- discovery/source health is untouched by transcript success or failure.

### Verification

- focused collector/workspace regression: 85/85 passed;
- full regression: 362/362 passed;
- all prior body enrichment tests remain green;
- no feature-branch code was deployed to production during this canary.
