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

- Confirmed `16f6224` is the active production release.
- Confirmed DataFunTalk, Semantic Scholar, and Ed H. Chi are absent from the active source catalog.
- Re-ran the full test suite, source-acceptance report, and live HTTP smoke successfully.

## Verification 2026-09-19

- Production release: `16f6224016a9d7873610f543638b2925c19900cf`.
- Production source count: 268; manifest/database parity is exact.
- Source acceptance: `without_channel=0`; 16 WeChat adapter channels exist and are currently `NOT_CONFIGURED` because the WeRSS runtime is not configured.
- Automated tests: 249 passed, 0 failed.
- Live HTTP smoke: passed.
- Production source payload contains `推广搜老油条`; the obsolete `丁丁丁写字的地方` and `搜广推学习笔记` source names are absent.
- DataFunTalk, Semantic Scholar, and Ed H. Chi are absent from the current manifest/source catalog.

## Remaining follow-up

- WeRSS runtime is still not configured, so the 16 newly identified WeChat sources are registered but not yet automatically refreshed.
