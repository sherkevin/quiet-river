# Agent-Reach acquisition integration roadmap

Updated: 2026-09-20

## Objective

Use Agent-Reach as the maintained platform acquisition knowledge base for Quiet River while keeping Quiet River responsible for subscriptions, scheduling, deduplication, persistence, native reading, notes/highlights and recommendation.

Pinned upstream reference:
- repository: Panniantong/Agent-Reach
- commit: a19a171fa980a0785849596492e0af4db800c82f
- license: MIT
- local reference clone: /home/qr-dev/work/vendor/Agent-Reach

The integration must not become a blind dependency on Agent-Reach runtime. Platform-specific backends are adopted only after their actual command/probe/identity contracts are verified against Quiet River requirements.

## Non-negotiable boundaries

1. Credentials stay where they already belong.
   - Existing Chrome-login platforms remain on Shervin.
   - ECS does not receive personal Chrome cookies merely to enable a fallback.
   - A server backend that requires explicit cookie material stays off unless a separately approved credential design exists.
2. Capability is stable; backend is replaceable.
   - Source IDs, Miniflux entry identity and read state cannot change because a backend changes.
3. Probe, do not assume.
   - Installed/configured is not healthy.
   - A candidate becomes active only after its own health contract passes.
4. One scheduler owner per capability.
   - Multiple candidates may exist, but only one backend owns a logical acquisition run at a time.
5. Fallback must preserve normalization.
   - A backend switch must produce the same logical author/item IDs before it is allowed to write.
6. Existing good feeds are not replaced for aesthetic consistency.
   - Native/official RSS remains the discovery path when it is simpler and more reliable.
7. Every platform change needs tests, canary and rollback.
   - No bulk migration before a real single-source canary.

## Baseline

Current source catalog:

| Platform | Sources | Current primary acquisition |
| --- | ---: | --- |
| Zhihu | 115 | OpenCLI @ Shervin |
| WeChat | 65 | 49 third-party feeds + 16 WeRSS |
| Blog | 31 | original RSS/Atom |
| Twitter/X | 28 | single third-party host api.xgo.ing |
| Xiaohongshu | 13 | OpenCLI @ Shervin |
| GitHub | 6 | official/public feeds |
| Bilibili | 4 | OpenCLI @ Shervin |
| arXiv | 2 | official feed |
| Juejin | 1 | Quiet River native adapter |
| CSDN | 1 | public feed |
| YouTube | 1 | official channel feed |
| Podcast | 1 | standard RSS |

## Workstreams

### A. Capability/router foundation — DONE on feature branch

Branch: chatgpt/capability-router-v1

- [x] capability -> ordered backend candidates -> activeBackend overlay
- [x] pluggable backend runner registry
- [x] explicit acquisition doctor
- [x] passive health remains zero-network
- [x] runtime doctor probes loopback only
- [x] backend shown in blogger/health UI
- [x] Agent-Reach MIT attribution
- [x] XHS ordered policy declared
- [x] full regression through doctor milestone: 309/309

Commits:
- b9b7a47 capability router
- 050b4df ordered fallback policy
- 304bc2d acquisition doctor

Deployment gate: wait until the current WeRSS QR canary/release is closed.

### B. P0 — Twitter/X: remove the api.xgo.ing single point of failure

Current problem:
- all 28 Twitter sources depend on one third-party feed host;
- backend failure is indistinguishable from author inactivity;
- no first-party identity-preserving fallback exists.

Target capability:

twitter.author.posts
1. twitter-cli @ Shervin
2. OpenCLI @ Shervin
3. api.xgo.ing feed
4. bird legacy only if already configured and safe

Tasks:
- [x] inventory all 28 Twitter source identities and prove canonical handle mapping
- [x] inspect/install Agent-Reach-selected twitter-cli on Shervin without importing browser cookies automatically
- [x] define fixed read-only author-timeline contracts for twitter-cli and OpenCLI
- [x] add a Windows normalizer that uploads only canonical tweet metadata/body
- [x] add Twitter capability/backend policy; runtime probes remain gated until direct-backend credentials/canary are available
- [x] keep existing xgo feed as fallback during migration
- [x] verify duplicate identity contract: xgo RSS guid is numeric tweet ID and direct normalizers emit the same tweet ID guid
- [ ] canary one author with both backends and compare IDs/timestamps/body
- [ ] canary backend failure: primary unavailable -> fallback without changing source identity
- [ ] migrate 28 sources only after parity threshold is met
- [x] implement reversible single-owner routing: the existing xgo channel/job is worker-owned only while a verified direct backend is healthy; direct failure requeues the same job to xgo
- [ ] update report with before/after failure-domain reduction

Success criteria:
- no Twitter source has a single acquisition backend;
- same tweet does not duplicate when switching backend;
- read state and historical cards stay unchanged;
- temporary Shervin/offline state does not fabricate no-new-tweets.

### C. P0 — Xiaohongshu: complete multi-backend policy without weakening credential isolation

Current primary is already strong:
- OpenCLI @ Shervin
- real author-list and native-body canaries passed
- bounded Chromium navigation workaround exists

Agent-Reach candidates:
1. OpenCLI @ Shervin
2. xiaohongshu-mcp
3. xhs-cli legacy

Tasks:
- [x] declare ordered candidates in capability layer
- [x] keep unconfigured MCP candidate off
- [ ] decide safe placement for MCP fallback; preferred Shervin/local runtime
- [ ] evaluate xiaohongshu-mcp output identity against existing OpenCLI note identity
- [ ] if safe, add runner + real probe
- [ ] never use xhs-cli user-posts as primary; upstream is stale
- [ ] prove failover on one author before enabling scheduler routing

Success criteria:
- fallback does not export Chrome cookies to ECS;
- note ID/xsec-token refresh semantics remain safe;
- one logical author timeline has one scheduler owner.

### D. P1 — Instagram Author source — SKIPPED

Decision (2026-09-20): do not require the user to create an Instagram account or provide Instagram Cookie/session material.

Evidence:
- Agent-Reach's pinned `InstagramChannel` explicitly uses OpenCLI with the user's logged-in Chrome session;
- Quiet River's NASA read-only canary returned 0 rows and the OpenCLI/Browser-Bridge route was unavailable without a usable Instagram session;
- no Instagram login was automated and no Instagram content was imported.

Status:
- preparation code exists in feature-branch history but is not a verified/approved acquisition backend;
- dormant code is fail-closed: opencli-instagram-shervin requires its own recent explicit canary before scheduler ownership, so generic Shervin heartbeat can never activate it;
- do not enable Instagram in production and do not spend further integration time unless a stable zero-account public path appears later;
- if that happens, restart from a fresh no-cookie canary instead of reviving the logged-in-session design.

### E. P1 — Reddit Community/User source

Agent-Reach finding:
- anonymous JSON path is no longer reliable;
- new official API registration is not a practical default;
- working paths are logged-in OpenCLI or explicit-cookie rdt-cli.

Target capabilities:
- reddit.community.posts
- reddit.user.posts
Backend order: OpenCLI @ Shervin, then rdt-cli only with separately approved explicit credential storage.

Tasks:
- [ ] generalize Source type beyond Author to Community
- [ ] add subreddit canonical identity
- [ ] normalize post + comments separately; subscription discovery imports posts only
- [ ] keep comments as article enrichment, not extra feed cards
- [ ] canary one public community under logged-in session

### F. P1 — Bilibili: keep author discovery, improve detail/search backends

Do not replace working author discovery merely because Agent-Reach prefers bili-cli for other capabilities.

Target split:
- bilibili.author.videos -> OpenCLI @ Shervin
- bilibili.video.detail -> bili-cli, then OpenCLI
- bilibili.video.subtitle -> OpenCLI
- bilibili.search -> bili-cli, OpenCLI, Bilibili search API

Tasks:
- [ ] add bili-cli runtime/probe
- [ ] use detail/subtitle as enrichment to existing video cards
- [ ] do not restore yt-dlp as Bilibili backend
- [ ] verify existing Bilibili source IDs remain stable

### G. P1 — GitHub enrichment, not feed replacement — COMMIT DETAIL DONE

Current GitHub discovery feeds remain the scheduler owner. Public commit/compare detail is enriched only on explicit article prepare; it never creates a second discovery stream.

Backend order for public commit detail:
1. GitHub public REST @ ECS — no credential required
2. gh CLI @ Shervin — retained as a future richer/private-repo fallback; its keyring token is not moved to ECS

Completed:
- [x] preserve official Atom discovery
- [x] accept only canonical github.com/<owner>/<repo>/commit/<sha> and compare/<sha>...<sha> targets
- [x] public REST detail uses bounded unauthenticated request and validates returned repo/SHA identity
- [x] render commit message/stats/changed files through HTML escaping
- [x] cache successful enrichment in generic entry_enrichments table so repeated article opens do not consume API quota
- [x] persist content provenance as github_rest_enrichment without changing URL/publication/read state
- [x] REST failure retains the existing Atom body and falls back to existing Miniflux full-text behavior
- [x] real Doragd commit canary passed (HTTP 200, stable SHA, changed files, anonymous rate limit remained healthy)

Remaining:
- [ ] add issue/release/repository detail capabilities when a concrete Quiet River use case needs them
- [ ] consider gh @ Shervin only for private/richer cases; do not replace public REST/Atom merely for uniformity

### H. P1 — YouTube enrichment, not feed replacement — SUBTITLE DONE ON FEATURE BRANCH

Current official YouTube channel feed stays discovery path and remains the only scheduler owner.

Subtitle backend order:
1. yt-dlp @ Shervin — preferred zero-account backend, subtitle-only, never downloads video
2. OpenCLI YouTube transcript @ Shervin — fallback when yt-dlp does not return usable subtitles
3. audio/Whisper transcription — intentionally deferred behind a separate privacy/API gate

Completed:
- [x] stable YouTube video identity across watch and youtu.be URLs
- [x] explicit per-entry transcript queue; opening an article does not silently start extraction
- [x] yt-dlp JSON3 subtitle normalization with segment/size bounds
- [x] yt-dlp command uses --skip-download, an isolated temporary directory and unconditional cleanup
- [x] OpenCLI transcript fallback with bounded Caption-URL retry
- [x] transcript appended to the existing native article body rather than creating a second card
- [x] preserve official channel feed as discovery/scheduler owner
- [x] preserve entry URL, publication time, read state and source-channel health
- [x] record actual backend provenance in entry_enrichments
- [x] article UI exposes explicit queue/status control only for YouTube
- [x] transcript GET is authenticated and POST is action-gated

Real canary:
- existing Quiet River video: TlR7douxQRM
- yt-dlp 2026.08.19: HTTP/rate-limit path, exit 1, 0 subtitle files
- OpenCLI fallback: exit 0 on first attempt, 153 segments, about 48,802 text characters
- canary did not mutate production Quiet River data and downloaded no video

Remaining:
- [ ] optional video detail enrichment if a concrete UI use case needs more than the official feed metadata
- [ ] Whisper/audio fallback only after an explicit external-provider/audio-retention privacy decision

### I. P2 — V2EX Community source

Agent-Reach has a public API implementation with no login requirement.

Tasks:
- [x] add Community source type and V2EX /go/<node> identity
- [x] implement node timeline through the bounded public API backend with stable numeric topic identity
- [x] reject cross-node rows and escape topic content before import
- [x] test HTTP/JSON failures as acquisition failures rather than no-new-posts
- [ ] article detail + replies as enrichment
- [ ] real network canary — BLOCKED: V2EX TCP 443 is unreachable from both ECS and Shervin; ECS direct curl, existing loopback Mihomo, and Jina Reader routes also fail. The channel therefore stays disabled unless V2EX_READY=true is explicitly set after a future successful canary.

### J. P2 — LinkedIn Company source

Potential value: AI-company/research-company updates and jobs.

Tasks:
- [ ] keep login/browser profile isolated
- [ ] define Company source identity
- [ ] decide whether company posts are reliable enough for scheduled discovery
- [ ] jobs remain a separate capability unless explicitly subscribed

### K. P2 — Xueqiu Topic/Stock source

Tasks:
- [ ] add Topic/Stock source type
- [ ] public quote/hot data is enrichment, not article feed
- [ ] community posts may become a feed only with stable item identity
- [ ] explicit credential boundary if logged-in cookie is needed

### L. P2 — Podcast local transcription — DONE ON FEATURE BRANCH

Current podcast RSS remains the only discovery/scheduler owner.

Privacy decision:
- use Shervin-local faster-whisper;
- do not send podcast audio to Groq/OpenAI or another cloud ASR provider;
- temporary PCM audio exists only inside a TemporaryDirectory and is deleted when the task exits;
- cloud ASR remains disabled unless explicitly approved as a separate future backend.

Pipeline:

registered Podcast RSS
-> exact entry URL match
-> validated public audio enclosure
-> Shervin ffmpeg (mono 16 kHz, max 4h)
-> faster-whisper base / CPU int8
-> normalized timestamped text only
-> existing Quiet River article body

Completed:
- [x] RSS/Atom/JSON Feed expose bounded audio enclosure metadata
- [x] enclosure must come from the entry's already-registered Podcast feed
- [x] enclosure URL is SSRF-checked on ECS and revalidated on Shervin, including redirects
- [x] audio larger than 512 MiB is rejected before queueing when feed length is known
- [x] local worker capability is advertised only when ffmpeg + isolated faster-whisper venv + wrapper exist
- [x] Podcast gets a 60-minute worker lease; YouTube transcript behavior remains separate
- [x] local wrapper uses fixed ffmpeg argv with shell disabled and deletes temporary audio
- [x] no cloud-ASR SDK/API call exists in the wrapper
- [x] worker returns only normalized transcript metadata/text; audio is never uploaded to ECS
- [x] ECS verifies SHA-256 of the queued audio URL before accepting the result
- [x] transcript appends to the existing article rather than creating a second card
- [x] URL/publication/read/source-health state is preserved
- [x] entry_enrichments records backend/model/language/segments and only a media URL hash
- [x] native article UI explicitly says processing is local and audio is not uploaded

Local feasibility evidence:
- Shervin has no CUDA GPU; PyTorch is CPU-only
- isolated runtime: faster-whisper 1.2.1 + CTranslate2 4.8.2
- 30-second benchmark with base.en / CPU int8: 3.41 s transcription, RTF 0.114
- full real Recsperts episode: 5076.15 s (84.6 min) audio
- multilingual base / CPU int8 full canary: 756.9 s (12.6 min), RTF about 0.149
- output: 409 segments / 75,605 characters, detected language en
- working memory stayed around 500 MiB
- after completion: 0 Quiet River Podcast temp directories and 0 temp WAV files
- no production Quiet River data was mutated during the canary

Verification:
- focused media/collector/platform/workspace suite: 152/152
- full regression on final worktree bytes before documentation-only updates: 358/358

Remaining:
- [ ] optional Xiaoyuzhou-specific discovery only if a concrete subscription source is added later; standard Podcast RSS already solves the current source
- [ ] cloud Whisper/Groq backend stays explicitly disabled unless privacy/provider policy changes

### M. Existing integrations that should remain primary

Do not replace:
- Zhihu OpenCLI subscription/enrichment
- WeChat public feeds + WeRSS
- original Blog RSS/Atom
- arXiv official feeds
- Juejin native adapter
- YouTube official discovery feed
- GitHub official discovery feeds
- standard podcast RSS

Agent-Reach may add enrichment or fallback to these, not replace a simpler reliable discovery path.

## Platform onboarding checklist

Every new platform/backend must pass:
1. Identity: canonical source ID and item ID, same item maps across backends.
2. Read-only contract: exact allowed command/API; no arbitrary command/argv from ECS to desktop worker.
3. Credential boundary: explicit location; doctor never silently harvests credentials.
4. Normalization: minimal fields uploaded; raw browser/cookie payload discarded.
5. Scheduling: one owner and explicit cooldown/rate-limit behavior.
6. Failure semantics: auth, block, timeout, partial, no-content vs no-new-content.
7. Canary: real source, identity before/after, no read-state reset.
8. Rollback: backend override/fallback without data migration.
9. Evidence: focused tests, full serial tests, exact commit evidence, live canary.
10. Documentation: roadmap, report and shared TODO.

## Release strategy

- Platform work happens on chatgpt/capability-router-v1 until the current WeRSS gate is resolved.
- Do not deploy architecture and unrelated runtime changes together.
- Merge/release in platform-sized batches with separate recovery points.
- For migration, keep the old backend until the new backend has a successful canary and identity parity.

## Reporting protocol

After every meaningful work session append to docs/agent-reach-integration-report.md:
- date/time
- task/workstream
- decision
- files/commit
- tests
- canary/live verification
- what changed in production
- rollback point
- open risks
- next action

The shared docs/project-todo.md contains the compact handoff; this roadmap/report contains the detailed history.
