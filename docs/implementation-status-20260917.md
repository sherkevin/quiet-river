# Reader Platform — 2026-09-17 implementation checkpoint

## What was resumed

The remote device is reachable with administrator access. The earlier conversation interruption
could not be attributed to a server crash: no recent kernel OOM was found, and the original
service was initially active. The recovered branch already contained a Bridge implementation
and running Miniflux/Karakeep containers; Bridge itself had not yet been started.
Some tool requests were rejected before execution by the tool safety checker. Rejected requests
were not treated as successful operations. A subsequently accepted retry enabled scheduling.

## Actual implementation and integration evidence

- 271 source records imported without overwriting the legacy subscriptions or cache.
- 365 channel records, including separate Zhihu article/answer channels; channels are not authors.
- At initial provisioning, 118 channels could run without additional adapter setup.
- Sources without credentials or adapters remain explicitly not configured, not silently healthy.
- Miniflux 2.3.3 / c4d54f87: native OPML creation and article-import APIs tested against the running server.
- Karakeep 0.33.2: native account setup, scoped API access, HTML archive parsing and highlighter APIs tested.
- Live synthetic import -> mark read -> content update preserves the read state.
- An actual HTML archive was parsed into readable content, a highlight was created and retrieved
  through the cross-bookmark list, and repeated opening reused the annotated bookmark.
- Synthetic fixtures were deleted by their returned IDs; real user records were not used as fixtures.
- 133 isolated regression tests passed before the final checkpoint.
- Live local HTTP smoke: private state API rejects anonymous access; catalog and notes API are connected.
- Public HTTPS login shell returned 200 and anonymous private API returned 401 using curl.
- A Node-based external smoke request failed to connect; this was not counted as a passed browser test.
- ntfy 2.28.0 was installed from the signed official package repository after the GitHub release download timed out.
- ntfy health and a local message publish were verified. This is not proof of delivery to a phone.

## Runtime layout

- `/opt/quiet-river-platform/releases/<commit>`: immutable application releases.
- `/opt/quiet-river-platform/current`: active release link.
- `/var/lib/quiet-river-platform/bridge`: Bridge database and local task ledger.
- `/var/lib/quiet-river-platform/karakeep`: reading database and attachments.
- `/etc/quiet-river-platform`: administrator-only runtime credentials and image locks.
- `/desk/`: new private reading workspace; `/legacy/`: old read-only view.
- Reader account: `reader@quiet-river.local`, using the existing site access password.
  Password values are not recorded in this repository.
- PostgreSQL, Miniflux, Karakeep, Bridge and ntfy listen on local/private interfaces only.
- Caddy uses the pre-existing public ports; the existing HTTPS tunnel remains the public entry.
- The old service was repaired to use `/usr/local/bin/qr-node`, outside a private home directory.
  The pre-existing `/usr/local/bin/node` became inaccessible to its service user after restart.
- Legacy automatic refresh and writes are disabled so the new scheduler is the single owner.
- ntfy is a local delivery backend, not an unauthenticated public notification endpoint.

## Operator commands

```bash
# Local read-only/HTTP smoke, no credential output:
node --env-file=/etc/quiet-river-platform/bridge.env tools/platform-smoke.js
# Isolated fixtures against the real upstream services:
node --env-file=/etc/quiet-river-platform/bridge.env tools/reader-contract-check.js
# Consistent local recovery point (briefly drains/stops writers):
python3 deploy/backup-platform.py
# Install an exact tested release:
bash deploy/install-release.sh <commit>
```

## Explicitly incomplete acceptance items

1. Zhihu, Xiaohongshu and browser-based Bilibili channels still require validated adapters and,
   where applicable, the user's own platform authorization. Root access does not supply that authorization.
2. WeRSS is not yet installed or authorized. Existing per-author WeChat/X relay feeds remain eligible.
3. Phone/background push delivery is not tested. The private notification outbox and local ntfy delivery
   are implemented; a client subscription is a separate acceptance step.
4. No 72-hour resource result or off-host full restore result is claimed. A local recovery point was
   generated, SQLite quick_check passed and pg_restore could read the PostgreSQL archive.
5. Meilisearch, OCR, video transcription and a local large model are not installed.
6. The public HTTPS entry currently uses the existing temporary tunnel. A permanent domain is not configured.
7. HTML import does not guarantee every external image is archived or every formula perfectly rendered.
   Content state remains explicit, and the original article link is always retained.

## Fixes that must survive future merges

- Keep `FETCHER_ALLOW_PRIVATE_NETWORKS=false`; restricted entries use the inbound import API.
- A repeated import must not reset read status. Content upgrades use the native update endpoint.
- Do not replace a reading version once annotations may refer to it.
- Account failure is grouped; a local stale-state check does not issue platform requests.
- Manual single-source refresh has queue priority; already-running work is merged, not duplicated.
- Paused sources retain old readable content in Latest, but do not enter recommendations.
- New arrivals do not shift a paginated list's discovery cutoff.
- Daily selection uses the full local candidate set, keeps unselected articles, and includes source gaps.
- Gateway checks verify stable legacy access as well as the new login shell; a transient active state is insufficient.
- A failed or rejected tool call is not an executed change and must not be recorded as a successful deployment.

## Final observed runtime checks

The deployed application commit is `8b48fefa921a2f4948a597f983cfb24b2a6b45ed`.
The later repository documentation commit does not change this running application version.

- A manual refresh against a real existing blog completed successfully and returned 212 stored articles.
- At the subsequent observation the shared entry store contained 679 articles; initial source checks were still running.
- 3 notification outbox events were recorded SENT after the local ntfy service accepted them.
- Source results included 21 successful-new channels, 8 timeouts and 1 upstream error at that observation;
  failures remain visible, and queued/credential-blocked channels are not counted as successful.
- The old service's restart counter stopped increasing after its runtime path was repaired.
- Database recovery point validation succeeded and the stopped services were restored to their prior active state.

Counters above are point-in-time observations, not guaranteed feed coverage or fixed future counts.
