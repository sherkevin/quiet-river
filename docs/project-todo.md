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

- Production release: `2ff28f30970d618b77b0949d6414c894cfccf4be`.
- Production source count: 268; manifest/database parity is exact.
- Source acceptance: `without_channel=0`; 16 WeChat adapter channels exist and are currently `NOT_CONFIGURED` because the WeRSS runtime is not configured.
- Automated tests: 251 passed, 0 failed; exact-commit serial evidence is bound to `2ff28f3` and reports an unchanged worktree.
- Live HTTP smoke: passed; production pagination verification confirmed stable non-overlapping article pages, served pagination UI for article/blogger/profile views, and an individual blogger with 212 stored Cards paginating correctly.
- Production source payload contains `推广搜老油条`; the obsolete `丁丁丁写字的地方` and `搜广推学习笔记` source names are absent.
- DataFunTalk, Semantic Scholar, and Ed H. Chi are absent from the current manifest/source catalog.

## Active task

- doing — Make Quiet River's native article detail page the default Card destination. The page must read the current article body from the Miniflux content master, render it safely inside `/desk/article/<entryId>`, preserve in-site blogger/tag/read/feedback controls, expose the external original only as a secondary action, and retain the existing Karakeep reader as the current highlight/annotation bridge. Public fetchable entries may explicitly request a full-text refresh; restricted metadata-only entries must not trigger ECS-side platform bypasses.

## Remaining follow-up

- open — WeRSS runtime is still not configured, so the 16 newly identified WeChat sources are registered but not yet automatically refreshed.
