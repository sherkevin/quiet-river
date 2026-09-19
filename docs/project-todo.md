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

- Production release: `15a738da087bfbd6d7d6f1d0b09381cb119d936e`.
- Production source count: 268; manifest/database parity is exact.
- Source acceptance: `without_channel=0`; 16 WeChat adapter channels exist and are currently `NOT_CONFIGURED` because the WeRSS runtime is not configured.
- Automated tests: `15a738d` exact-commit serial evidence: 263 passed, 0 failed, unchanged worktree.
- Live HTTP smoke: passed on `15a738d`; production checks confirmed the additive `note_bookmark_id` migration, native note editor assets, Karakeep note capability on article detail, and note write action gates without modifying a real note.
- Production source payload contains `推广搜老油条`; the obsolete `丁丁丁写字的地方` and `搜广推学习笔记` source names are absent.
- DataFunTalk, Semantic Scholar, and Ed H. Chi are absent from the current manifest/source catalog.

## Active task

- done — `93cf7c8` makes `/desk/article/<entryId>` the default Card destination, reads current bodies from Miniflux, rebuilds upstream HTML through an explicit DOM/tag/URL allowlist, keeps original links secondary, and preserves Karakeep as the highlight bridge. Public full-text preparation is explicit; restricted META sources cannot use ECS extraction. Production smoke and real public/restricted article checks passed; pre-release recovery point: `/var/backups/quiet-river/platform-20260919T044929Z`.
- done — `15a738d` adds whole-article note editing to the native article page while keeping Karakeep as the sole note store. Existing content bookmarks are reused; metadata-only articles get a separate Karakeep text-note bookmark referenced by `note_bookmark_id`, so note creation cannot consume the future content/highlight bookmark. Empty untouched notes create no bookmark. Pre-release recovery point: `/var/backups/quiet-river/platform-20260919T050229Z`.
- doing — Implement native text-selection highlights/segment notes only after proving Karakeep character-offset compatibility. Read Karakeep's own readable content for the archived bookmark, map a selected quote only when it has a unique exact position in that canonical text, and refuse ambiguous/zero-match writes rather than guessing. Existing Karakeep reader remains the safe fallback.

## Remaining follow-up

- open — WeRSS runtime is still not configured, so the 16 newly identified WeChat sources are registered but not yet automatically refreshed.
