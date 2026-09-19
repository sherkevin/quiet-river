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

- Production release: `4e026030740a9f703cda365e66274e18237d36d2`.
- Production source count: 268; manifest/database parity is exact.
- Source acceptance: `without_channel=0`; 16 WeChat adapter channels exist and are currently `NOT_CONFIGURED` because the WeRSS runtime is not configured.
- Automated tests: `4e02603` exact-commit serial evidence: 271 passed, 0 failed, unchanged worktree.
- Live HTTP smoke: passed on `4e02603`; a real archived article exposed its existing highlight list and exact Karakeep `htmlContent` context without mutation. A deployed `ReaderService` using an in-memory Bridge DB completed a real Karakeep highlight create/list/update/delete round-trip on a synthetic SingleFile bookmark and then removed the fixture.
- Production source payload contains `推广搜老油条`; the obsolete `丁丁丁写字的地方` and `搜广推学习笔记` source names are absent.
- DataFunTalk, Semantic Scholar, and Ed H. Chi are absent from the current manifest/source catalog.

## Active task

- done — `93cf7c8` makes `/desk/article/<entryId>` the default Card destination, reads current bodies from Miniflux, rebuilds upstream HTML through an explicit DOM/tag/URL allowlist, keeps original links secondary, and preserves Karakeep as the highlight bridge. Public full-text preparation is explicit; restricted META sources cannot use ECS extraction. Production smoke and real public/restricted article checks passed; pre-release recovery point: `/var/backups/quiet-river/platform-20260919T044929Z`.
- done — `15a738d` adds whole-article note editing to the native article page while keeping Karakeep as the sole note store. Existing content bookmarks are reused; metadata-only articles get a separate Karakeep text-note bookmark referenced by `note_bookmark_id`, so note creation cannot consume the future content/highlight bookmark. Empty untouched notes create no bookmark. Pre-release recovery point: `/var/backups/quiet-river/platform-20260919T050229Z`.
- done — `4e02603` adds native text-selection highlights and segment notes. The implementation deliberately rejects Karakeep `/content?format=text` as an offset source after 0/6 real archives matched the Reader coordinate system; it instead uses the exact `bookmark.content.htmlContent` consumed by Karakeep 0.33.2 and mirrors its `TreeWalker(SHOW_TEXT)` offset algorithm in an inert document. New writes require an exact unique quote match plus an unchanged server-side context hash; ambiguous/zero-match selections are refused. Existing highlights are only painted on the Quiet River body when their quote is uniquely locatable there, otherwise they remain visible in the annotation list. Pre-release recovery point: `/var/backups/quiet-river/platform-20260919T060654Z`.
- doing — Raise native-body coverage for restricted sources without moving credentials to ECS. Extend the existing Shervin desktop-collector protocol so a known Zhihu/Xiaohongshu article can be enriched with bounded full/partial body HTML under the user's logged-in browser session; validate article identity before upload, preserve the original URL/date/read state, and never let an empty/login/challenge page downgrade previously stored text.

## Remaining follow-up

- open — WeRSS runtime is still not configured, so the 16 newly identified WeChat sources are registered but not yet automatically refreshed.
