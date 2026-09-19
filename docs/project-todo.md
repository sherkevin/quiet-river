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

## Verification 2026-09-19

- Production release: `1ac0849cbc90411e480f7ff148bd5ed55b081d6c`.
- Production source count: 268; manifest/database parity is exact.
- Source acceptance: `without_channel=0`; 16 WeChat adapter channels exist and are currently `NOT_CONFIGURED` because the WeRSS runtime is not configured.
- Automated tests: 249 passed, 0 failed.
- Live HTTP smoke: passed.
- Production source payload contains `推广搜老油条`; the obsolete `丁丁丁写字的地方` and `搜广推学习笔记` source names are absent.
- DataFunTalk, Semantic Scholar, and Ed H. Chi are absent from the current manifest/source catalog.

## Latest task

- done — Article-card blogger navigation now opens the matching in-site blogger profile first; the profile provides the bound external homepage as `原地址`. Exact-commit serial tests: 249/249; platform smoke passed; production static/API checks confirmed internal source routing, sourceId/catalog parity, `原地址` exposure, and a working profile deep link. The optional `workspace-dom-check.js` was not used because `jsdom` is not installed on ECS; no production dependency was added for that auxiliary check.

## Remaining follow-up

- open — WeRSS runtime is still not configured, so the 16 newly identified WeChat sources are registered but not yet automatically refreshed.
