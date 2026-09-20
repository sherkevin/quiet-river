# WeRSS runtime for Quiet River

This document records the pinned WeRSS runtime used for verified WeChat sources.

## Version and trust boundary

- Upstream: `rachelos/we-mp-rss`.
- Pinned source revision: `d8feb6a42c6773d7374e03c487d3ae3426084af8`.
- Reused dependency image digest: `ghcr.io/rachelos/we-mp-rss@sha256:af771f21b3f7958a5dea16911fba050a6d7b92eac2fb2499c467c1b11f07ef34`.
- Quiet River derived image: `quiet-river/werss:d8feb6a4-sec1`.
- The dependency image is only a Python/Playwright/browser layer. The full application tree is replaced by the pinned source revision.
- `deploy/prepare-werss-overrides.py` generates byte-exact overrides from that pinned tree. It removes the upstream all-environment startup dump and exempts only the loopback update/QR endpoints from application authentication; every replacement must match exactly once or the script aborts.

WeRSS is bound only to `127.0.0.1:8001`. Do not publish port 8001 through Caddy, Docker, a cloud security group, or another reverse proxy while the loopback patch is active.

## Scheduling

Quiet River owns collection scheduling. Keep:

- `ENABLE_JOB=False`
- `GATHER.CONTENT_AUTO_CHECK=False`
- `GATHER.MODEL=weread_mp`
- `GATHER.CONTENT=True`
- `MAX_PAGE=1`

The Bridge explicitly calls `GET /api/v1/wx/mps/update/<mp_id>?start_page=0&end_page=1`, waits for the pinned synchronous implementation to finish, and only then reads `/feed/<mp_id>.xml`.
## Persistent state

- WeRSS data: `/opt/quiet-river-platform/werss-data`
- Private environment: `/etc/quiet-river-platform/werss.env`
- Operational compose: `/opt/quiet-river-platform/werss.compose.yml`
- Runtime overrides: `/opt/quiet-river-platform/werss-overrides`
- The WeRead login is stored by WeRSS in its data directory (not in the repository and not in Bridge configuration).

`deploy/backup-platform.py` stops WeRSS inside the same consistency window as Bridge/Karakeep, copies the WeRSS data directory, and runs SQLite `PRAGMA quick_check` when `we_mp_rss.db` is present.

## Resource boundary

The ECS has a 2 GiB swapfile because the WeRSS full-content path can start a Playwright browser. The container is limited to 1 GiB RAM and 2 GiB RAM+swap with a 256 MiB shared-memory segment. Revalidate those limits if the ECS size changes.

## Feed registration

Quiet River's verified `MP_WXS_*` identities are registered with the pinned upstream `_ensure_weread_mp_feed()` helper. Do not insert Feed rows directly into the WeRSS SQLite database.

The current migration target is 16 verified `MP_WXS_*` feeds. Identity comes from the Quiet River source manifest; WeRSS does not discover or invent公众号 subscriptions.

## WeRead authorization

Authorization is performed with the pinned WeRSS QR flow. A successful scan writes the credential directly into the WeRSS data directory. Do not paste the Cookie into chat, Git, Bridge environment files, or project documentation.

The QR endpoints are unauthenticated only because the entire service is loopback-only. If WeRSS is ever exposed beyond loopback, remove the QR/update exemptions and configure normal WeRSS JWT or AK/SK authentication first.
## Bridge configuration

For the loopback runtime, Bridge needs:

```dotenv
WERSS_URL=http://127.0.0.1:8001
BROWSER_ACCEPTED=true
```

`WERSS_AK`/`WERSS_SK` or `WERSS_TOKEN` remain supported for an authenticated deployment, but are optional for the loopback-only runtime.

## Release gates

Before enabling production WeRSS channels:

1. Derived image source revision and security patch are verified.
2. Port 8001 listens only on `127.0.0.1`.
3. Startup logs contain neither private environment values nor the upstream environment-dump banner.
4. WeRSS scheduler and automatic content fixer are disabled.
5. All verified `MP_WXS_*` feeds are registered.
6. WeRead QR login is valid.
7. A real single-source update completes and its XML feed contains a valid article.
8. Quiet River imports that result without changing unrelated read state.
9. Full project tests and exact-commit release evidence pass.
10. A recovery point containing WeRSS data passes SQLite integrity validation.

Do not report WeRSS as complete merely because the container is running or an update endpoint returned HTTP 200.
