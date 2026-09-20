# quiet-river project handoff

Updated: 2026-09-19

## Current repository

- Path: `/home/qr-dev/work/quiet-river`
- Branch: `chatgpt/reader-platform-v1`

## Completed

- `0a85b54`: removed Semantic Scholar and Ed H. Chi; tests passed and this revision was deployed previously.
- `2d071db`: bound verified WeRSS account identifiers to the unresolved WeChat sources.
- `16f6224`: finished identity cleanup; 16 real WeChat sources now have adapter metadata, and the unverified placeholder `搜广推学习笔记` was removed.
- Current manifest: 268 sources, 65 WeChat sources, and no WeChat source lacking both feed and adapter metadata.

## Resolved in this session

- Confirmed DataFunTalk, Semantic Scholar, and Ed H. Chi are absent from the active source catalog.
- Re-ran the full test suite, source-acceptance report, and live HTTP smoke successfully.
- `1ac0849`: article-card blogger links now route by stable `sourceId` to an in-site blogger profile; that profile exposes the source catalog `url` only through an explicit `原地址` link and also offers article filtering, refresh, and tag editing.
- Released and verified `1ac0849`; pre-release recovery point: `/var/backups/quiet-river/platform-20260919T024256Z`.
- `2ff28f3`: replaced article “load more” with 30-item numbered pagination, paginated the blogger catalog, and made each in-site blogger profile render every stored article Card for that blogger across numbered pages.
- Released and verified `2ff28f3`; pre-release recovery point: `/var/backups/quiet-river/platform-20260919T033934Z`.

## Verification 2026-09-19

- Production release: `c23f838fda212351f787c67917279dccdb096150`.
- Production source count: 268; manifest/database parity is exact.
- Source acceptance: `without_channel=0`; 16 WeChat adapter channels exist and are currently `NOT_CONFIGURED` because the WeRSS runtime is not configured.
- Automated tests: `c23f838` exact-commit serial evidence: 285 passed, 0 failed, unchanged worktree.
- Live HTTP smoke: passed on `c23f838`. Real restricted-source canaries also passed: Zhihu entry 8682 upgraded `META -> TEXT` with 171 text characters; Xiaohongshu entry 8932 upgraded `META -> TEXT` with 997 text characters after refreshing its signed note URL and applying the bounded Chromium `Navigation rejected` retry. In both cases URL/title identity, publication time, read state, and source-channel health remained unchanged.
- Production source payload contains `推广搜老油条`; the obsolete `丁丁丁写字的地方` and `搜广推学习笔记` source names are absent.
- DataFunTalk, Semantic Scholar, and Ed H. Chi are absent from the current manifest/source catalog.

## Active task

- done — `93cf7c8` makes `/desk/article/<entryId>` the default Card destination, reads current bodies from Miniflux, rebuilds upstream HTML through an explicit DOM/tag/URL allowlist, keeps original links secondary, and preserves Karakeep as the highlight bridge. Public full-text preparation is explicit; restricted META sources cannot use ECS extraction. Production smoke and real public/restricted article checks passed; pre-release recovery point: `/var/backups/quiet-river/platform-20260919T044929Z`.
- done — `15a738d` adds whole-article note editing to the native article page while keeping Karakeep as the sole note store. Existing content bookmarks are reused; metadata-only articles get a separate Karakeep text-note bookmark referenced by `note_bookmark_id`, so note creation cannot consume the future content/highlight bookmark. Empty untouched notes create no bookmark. Pre-release recovery point: `/var/backups/quiet-river/platform-20260919T050229Z`.
- done — `4e02603` adds native text-selection highlights and segment notes. The implementation deliberately rejects Karakeep `/content?format=text` as an offset source after 0/6 real archives matched the Reader coordinate system; it instead uses the exact `bookmark.content.htmlContent` consumed by Karakeep 0.33.2 and mirrors its `TreeWalker(SHOW_TEXT)` offset algorithm in an inert document. New writes require an exact unique quote match plus an unchanged server-side context hash; ambiguous/zero-match selections are refused. Existing highlights are only painted on the Quiet River body when their quote is uniquely locatable there, otherwise they remain visible in the annotation list. Pre-release recovery point: `/var/backups/quiet-river/platform-20260919T060654Z`.
- done — `c23f838` completes explicit on-demand native-body enrichment for registered Zhihu/Xiaohongshu entries without moving credentials to ECS. `entry_body_v1` is capability-gated and uses a separate per-entry queue; Shervin only executes fixed read-only commands, uploads at most 1 MiB of normalized text, and ECS HTML-escapes it before Miniflux storage. Xiaohongshu refreshes the registered author's current list and requires exact author/note identity before using a fresh signed URL locally. Chrome 153 / OpenCLI's Chromium-152+ `Navigation rejected` bug is handled only by one exact-error read-only retry with `--trace retain-on-failure`; unrelated failures are not retried. Real Zhihu and Xiaohongshu canaries passed with source health/read metadata preserved. Pre-release recovery point: `/var/backups/quiet-river/platform-20260919T083622Z`.

## Remaining follow-up

- doing — WeRSS runtime is now installed on ECS from pinned upstream revision `d8feb6a42c6773d7374e03c487d3ae3426084af8` using derived image `quiet-river/werss:d8feb6a4-sec1`, loopback-only `127.0.0.1:8001`, upstream schedulers disabled, 2 GiB host swap, and startup environment-dump removal. All 16 verified `MP_WXS_*` feeds are registered inside WeRSS. The runtime exposes only the explicit update and QR-login endpoints without app authentication because the whole service is loopback-only; other management APIs remain authenticated. Repository contracts now use `/feed/<mp_id>.xml` and synchronous update-before-feed. Static/focused/full tests pass (55/55 focused, 287/287 full). Final gate still open: complete WeRead QR login, run a real single-source update/feed/import canary, validate WeRSS-inclusive recovery backup, then release the Bridge commit and mark this done.
- done on feature branch, not deployed — Agent-Reach-inspired acquisition capability layer lives on `chatgpt/capability-router-v1`, pinned to upstream `Panniantong/Agent-Reach@a19a171fa980a0785849596492e0af4db800c82f` (MIT). Phase 1 adds a non-destructive `capability -> ordered backend candidates -> activeBackend -> health reason` overlay, a pluggable backend runner registry, explicit Shervin ownership for desktop acquisition, and backend visibility in blogger/health UI without migrating source/channel IDs or Miniflux feed identities. Phase 2 now also declares the first ordered fallback policy `xiaohongshu.notes: OpenCLI @ Shervin -> xiaohongshu-mcp @ ECS`; the MCP candidate stays `off` unless its own probe says it is usable, so declaration never fabricates health. Current full regression: 328/328. Twitter P0 has canonical tweet identity, a single-scheduler-owner direct-backend handoff over the existing xgo channel, backend-specific cooldown/fallback, and an explicit-credentials-only twitter-cli wrapper; direct routing remains disabled until a real Twitter canary passes. Instagram P1 is code-complete on the branch with stable profile/shortcode identity, a bounded read-only Shervin wrapper and UI/source support, but remains explicitly unverified because OpenCLI 1.8.7 + Browser Bridge extension 1.0.21 returns BROWSER_CONNECT for both official Instagram profile/user commands and the Quiet River wrapper. No Instagram production routing is enabled. V2EX Community support is also prepared with stable node/topic identity and a bounded public-API runner, but remains disabled because real canaries show V2EX is unreachable from ECS, Shervin, existing Mihomo, and Jina; V2EX_READY stays false until a future successful network canary. The branch also includes an explicit authenticated acquisition doctor: passive health remains zero-network, while user-triggered doctor probes only Shervin heartbeat and configured loopback runtimes; probe results can change the temporary active-backend view but never mutate persisted channel health. This branch intentionally waits behind the WeRSS QR canary/release gate before any production merge/deploy.

- doing — Agent-Reach acquisition integration is now managed by `docs/agent-reach-acquisition-roadmap.md` and append-only `docs/agent-reach-integration-report.md` on branch `chatgpt/capability-router-v1`. Foundation commits `b9b7a47`, `050b4df`, `304bc2d` are pushed; exact serial regression is 309/309. The next active workstream is P0 Twitter/X: replace the 28-source `api.xgo.ing` single point with `twitter-cli @ Shervin -> OpenCLI @ Shervin -> xgo feed fallback`, preserving source/item identity and keeping the old feed until dual-backend canary parity passes.

- skipped — Instagram acquisition requires a logged-in Instagram Chrome session in the pinned Agent-Reach/OpenCLI design. The user has no Instagram account and does not want account/Cookie-dependent Instagram integration. Do not request credentials or enable the prepared Instagram code; revisit only after a stable zero-account public path is verified. Next independent workstream: Reddit Community/User, prioritizing no-account official/RSS paths before any logged-in backend.

- done on feature branch, not deployed — YouTube transcript enrichment on `chatgpt/youtube-enrichment-v1` keeps the official channel feed as discovery owner and uses `yt-dlp @ Shervin -> OpenCLI transcript @ Shervin` for explicit per-entry enrichment. Real video canary: yt-dlp 2026.08.19 hit 429 with 0 subtitle files; OpenCLI fallback succeeded first try with 153 segments / ~48.8k characters, with no video download or production DB mutation. Final worktree regression: 351/351. Whisper/audio fallback remains deferred behind a separate privacy/provider gate.
