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

- skipped — Per user decision, do not continue WeRSS. The 16 verified `MP_WXS_*` WeChat sources keep their adapter/identity metadata but are intentionally not automatically refreshed unless a non-WeRSS source becomes available later. The standalone WeRSS container was stopped/removed; port 8001 is closed; `/opt/quiet-river-platform/werss-data` and the recovery backup remain preserved for rollback/history. Repository WeRSS wiring commit `36f1f77` was explicitly reverted by `ce494d7`, so WeRSS is no longer a release gate and no further QR/login work should be requested.

- update — Agent-Reach acquisition work continues independently of WeRSS. Consolidated branch `chatgpt/acquisition-integration-v1` is pushed through `33508cc6fa9c4a48dd4ded41e44b4e05e23830ad` (`feat: add zero-account Reddit user sources`). It includes capability/router, Twitter fallback framework, Instagram fail-closed skip, V2EX prepared/network-blocked, GitHub detail, validated YouTube transcript chain, Shervin-local Podcast transcription, zero-account Reddit Community + User, Bilibili public detail, and Bilibili subtitle on the unified media-transcript queue. Exact final serial evidence: 388/388 passed, 0 failed/skipped/todo, `worktree_unchanged=true`, log SHA-256 `6fc2f0b1f9200bd7310d7cb085c9f971ac9dd6630cd9fbd90ffa22da8807cdb6`. This branch is not deployed yet.

- verification — After removing WeRSS from the main release line, code commit `640eced314cfdf7af849757b48040c3d14a5288a` passed exact serial regression 285/285 with 0 failed/skipped/todo and `worktree_unchanged=true`; log SHA-256 `d21c2e3bd7768632edfe31371afe51d4c7384878e53d8b2cb351512aa1641208`. Runtime check: no `quiet-river-werss` container, no listener on 127.0.0.1:8001; WeRSS data and recovery backup remain preserved but inactive.

- release candidate — `chatgpt/acquisition-release-v1` is the clean merge of the Agent-Reach acquisition stack onto main `8d88c14` after WeRSS removal. Current functional worktree regression: 386/386 passed, 0 failed/skipped/todo. WeRSS runtime deployment files/env wiring are absent; the 16 legacy MP identities remain metadata-only with disabled channels. This candidate is not deployed yet.
