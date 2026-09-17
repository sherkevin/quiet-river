#!/usr/bin/env bash
# Install an immutable, already-tested commit; no legacy data is copied or replaced.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Administrator required' >&2; exit 1; }
exec 9>/run/lock/quiet-river-release.lock
flock -n 9 || { echo 'Another release operation is active' >&2; exit 1; }
REPO=/home/qr-dev/work/quiet-river
COMMIT="${1:?Pass the exact tested commit}"
EVIDENCE="${2:?Pass the commit-bound tests.json evidence file}"
[[ "$COMMIT" =~ ^[a-f0-9]{7,40}$ ]] || { echo 'Invalid commit' >&2; exit 1; }
REV=$(runuser -u qr-dev -- git -C "$REPO" rev-parse "${COMMIT}^{commit}")
DEST="/opt/quiet-river-platform/releases/$REV"
install -d -m 755 /opt/quiet-river-platform/releases
if [ ! -e "$DEST" ]; then
  install -d -m 755 "$DEST"
  runuser -u qr-dev -- git -C "$REPO" archive "$REV" | tar -x -C "$DEST"
  chmod -R go-w "$DEST"
fi
# Refuse drifted archives and test results that do not belong to this commit.
install -d -m 700 /var/backups/quiet-river/release-evidence
MANIFEST="/var/backups/quiet-river/release-evidence/${REV}-$(date +%Y%m%dT%H%M%S%N).json"
runuser -u qr-dev -- python3 "$DEST/tools/release-manifest.py" --repo "$REPO" --root "$DEST" --commit "$REV" --test-evidence "$EVIDENCE" > "$MANIFEST"
if [ ! -e "$DEST/.release-manifest.json" ]; then install -m 644 "$MANIFEST" "$DEST/.release-manifest.json"; fi
if [ ! -x /usr/local/bin/qr-node ]; then
  install -m 755 /home/qr-dev/.nvm/versions/node/v22.23.2/bin/node /usr/local/bin/qr-node
fi
install -d -o qr -g qr -m 700 /var/lib/quiet-river-platform/bridge
OLD=$(readlink -f /opt/quiet-river-platform/current || true)
rollback() {
  code=$?; trap - ERR
  if [ -n "$OLD" ] && [ -f "$OLD/deploy/quiet-river-bridge.service" ]; then
    ln -sfn "$OLD" /opt/quiet-river-platform/current.rollback
    mv -Tf /opt/quiet-river-platform/current.rollback /opt/quiet-river-platform/current
    install -m 644 "$OLD/deploy/quiet-river-bridge.service" /etc/systemd/system/quiet-river-bridge.service
    systemctl daemon-reload; systemctl restart quiet-river-bridge || true
  fi
  echo 'Release failed; previous application link restored. Check service state.' >&2
  exit "$code"
}
trap rollback ERR
install -m 644 "$DEST/deploy/quiet-river-bridge.service" /etc/systemd/system/quiet-river-bridge.service
if [ -L /opt/quiet-river-platform/current ]; then
  readlink /opt/quiet-river-platform/current > /var/backups/quiet-river/previous-platform-release
fi
ln -s "$DEST" /opt/quiet-river-platform/current.next.$$
mv -Tf /opt/quiet-river-platform/current.next.$$ /opt/quiet-river-platform/current
systemctl daemon-reload
systemctl enable quiet-river-bridge
systemctl restart quiet-river-bridge
ready=false
for attempt in {1..15}; do
  if curl --noproxy '*' --fail --silent --max-time 3 http://127.0.0.1:4380/healthz >/dev/null; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ]
[ "$(curl --noproxy '*' --silent --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:4380/desk/api/state)" = 401 ]
systemctl is-active --quiet quiet-river-bridge
trap - ERR
printf 'Installed reader commit %s. Legacy application unchanged.\n' "$REV"
